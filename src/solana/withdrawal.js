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
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Fetch token prices from CoinGecko with retries
async function getTokenPrices() {
  let retries = 3;
  
  while (retries > 0) {
    try {
      const url = COINGECKO_API_KEY
        ? `https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd&x_cg_pro_api_key=${COINGECKO_API_KEY}`
        : 'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd';
      
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data.solana && response.data['usd-coin']) {
        console.log(`Prices fetched: SOL=$${response.data.solana.usd}, USDC=$${response.data['usd-coin'].usd}`);
        return {
          sol: response.data.solana.usd,
          usdc: response.data['usd-coin'].usd
        };
      }
    } catch (err) {
      retries--;
      console.error(`Price fetch failed (retries left: ${retries})`, err.message);
      
      if (retries === 0) {
        throw new Error('Failed to fetch live prices from CoinGecko after 3 retries');
      }
      
      // Wait 1 second before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
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
