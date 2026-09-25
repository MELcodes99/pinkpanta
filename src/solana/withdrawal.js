const { 
  SystemProgram, 
  Transaction, 
  PublicKey, 
  Connection 
} = require('@solana/web3.js');
const {
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const axios = require('axios');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Fetch token prices from CoinGecko
async function getTokenPrices() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd'
    );
    return {
      sol: response.data.solana.usd || 100,
      usdc: response.data['usd-coin'].usd || 1
    };
  } catch (err) {
    console.error('Error fetching prices:', err.message);
    return { sol: 100, usdc: 1 };
  }
}

// Send SOL transfer
async function sendSolWithdrawal(fromKeypair, toAddress, amountSol) {
  try {
    console.log(`Sending ${amountSol} SOL to ${toAddress}`);
    
    const toPublicKey = new PublicKey(toAddress);
    const amountLamports = Math.floor(amountSol * 1e9);
    
    // Create transfer instruction
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: amountLamports
    });
    
    // Create transaction
    const transaction = new Transaction().add(transferInstruction);
    
    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromKeypair.publicKey;
    
    // Sign transaction
    transaction.sign(fromKeypair);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log(`Transaction sent: ${signature}`);
    
    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`Transaction confirmed: ${signature}`);
    
    return {
      success: true,
      signature,
      amount: amountSol,
      token: 'SOL',
      to: toAddress
    };
  } catch (err) {
    console.error('ERROR sending SOL:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

// Send USDC transfer
async function sendUsdcWithdrawal(fromKeypair, toAddress, amountUsdc) {
  try {
    console.log(`Sending ${amountUsdc} USDC to ${toAddress}`);
    
    const toPublicKey = new PublicKey(toAddress);
    const usdcMint = new PublicKey(USDC_MINT);
    const amountTokens = Math.floor(amountUsdc * 1e6); // USDC has 6 decimals
    
    // Get token accounts
    const fromTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      fromKeypair.publicKey
    );
    
    const toTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      toPublicKey
    );
    
    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      fromTokenAccount,
      toTokenAccount,
      fromKeypair.publicKey,
      amountTokens,
      [],
      TOKEN_PROGRAM_ID
    );
    
    // Create transaction
    const transaction = new Transaction().add(transferInstruction);
    
    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromKeypair.publicKey;
    
    // Sign transaction
    transaction.sign(fromKeypair);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize());
    console.log(`Transaction sent: ${signature}`);
    
    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`Transaction confirmed: ${signature}`);
    
    return {
      success: true,
      signature,
      amount: amountUsdc,
      token: 'USDC',
      to: toAddress
    };
  } catch (err) {
    console.error('ERROR sending USDC:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  getTokenPrices,
  sendSolWithdrawal,
  sendUsdcWithdrawal
};
