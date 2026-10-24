const {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} = require('@solana/web3.js');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Sign + broadcast a ready-made base64 VersionedTransaction (market creation)
async function signAndSendBase64Tx(base64Tx, keypair) {
  const txBuffer = Buffer.from(base64Tx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([keypair]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await confirm(signature);
  return signature;
}

// Compile instruction list -> v0 tx, sign + broadcast (primary buy)
async function signAndSendInstructions(instructions, recentBlockhash, keypair) {
  const ixs = instructions.map(decodeInstruction);
  // Always fetch a fresh blockhash, the one from the API may have expired
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair]);
  const raw = transaction.serialize();

  // Simulate first so program errors surface before we broadcast
  const sim = await connection.simulateTransaction(transaction, { sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-3).join(' | ');
    throw new Error('Simulation failed: ' + JSON.stringify(sim.value.err) + ' ' + logs);
  }

  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  console.log('Tx sent:', signature);

  // Rebroadcast until confirmed, failed, or the blockhash expires
  while (true) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st && st.err) throw new Error('Tx failed on-chain: ' + JSON.stringify(st.err) + ' sig: ' + signature);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    const height = await connection.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) throw new Error('Tx expired without landing, sig: ' + signature);
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }
}

function decodeInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: !!a.isSigner,
      isWritable: !!a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

async function confirm(signature) {
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed'
  );
}

module.exports = {
  connection,
  signAndSendBase64Tx,
  signAndSendInstructions,
};
