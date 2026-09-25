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
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash,
    instructions: ixs,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
  });
  await confirm(signature);
  return signature;
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
