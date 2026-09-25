const { Keypair, Connection, PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');
const bs58 = require('bs58');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');
const USDC_MINT = 'EPjFWaLb3oqH4w8g5D6XaDMsKkynP41yDyhBP6SHo6K'; // Mainnet USDC

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  console.error('ERROR: ENCRYPTION_KEY must be at least 32 characters');
  process.exit(1);
}

// Derive a 32-byte key from the encryption key
const encryptionKeyBuffer = Buffer.from(ENCRYPTION_KEY.slice(0, 32), 'utf8');

// ============= KEY GENERATION & ENCRYPTION =============
function generateUserKeypair() {
  return Keypair.generate();
}

function encryptKeypair(keypair) {
  try {
    const secretKeyArray = Array.from(keypair.secretKey);
    const plaintext = JSON.stringify(secretKeyArray);
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKeyBuffer, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Return: iv + encrypted (both hex)
    return iv.toString('hex') + ':' + encrypted;
  } catch (err) {
    console.error('ERROR encrypting keypair:', err.message);
    throw err;
  }
}

function decryptKeypair(encryptedData) {
  try {
    if (!encryptedData || typeof encryptedData !== 'string') {
      throw new Error('Invalid encrypted data format');
    }
    
    const parts = encryptedData.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encryption format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKeyBuffer, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    const secretKeyArray = JSON.parse(decrypted);
    const secretKey = new Uint8Array(secretKeyArray);
    
    return Keypair.fromSecretKey(secretKey);
  } catch (err) {
    console.error('ERROR decrypting keypair:', err.message);
    throw err;
  }
}

// ============= BALANCE FETCHING =============
async function getSolBalance(walletAddress) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const balanceLamports = await connection.getBalance(publicKey);
    return balanceLamports / 1e9; // Convert to SOL
  } catch (err) {
    console.error('ERROR fetching SOL balance:', err.message);
    return 0;
  }
}

async function getUsdcBalance(walletAddress) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const usdcMint = new PublicKey(USDC_MINT);
    
    // Get all token accounts for this wallet
    const accounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { mint: usdcMint }
    );
    
    if (accounts.value.length === 0) {
      return 0;
    }
    
    // Get balance from first USDC account
    const balance = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    return balance || 0;
  } catch (err) {
    console.error('ERROR fetching USDC balance:', err.message);
    return 0;
  }
}

async function getUserBalance(walletAddress) {
  try {
    const solBalance = await getSolBalance(walletAddress);
    const usdcBalance = await getUsdcBalance(walletAddress);
    
    return {
      sol: parseFloat(solBalance.toFixed(4)),
      usdc: parseFloat(usdcBalance.toFixed(2))
    };
  } catch (err) {
    console.error('ERROR getting user balance:', err.message);
    return { sol: 0, usdc: 0 };
  }
}

module.exports = {
  generateUserKeypair,
  encryptKeypair,
  decryptKeypair,
  getUserBalance,
  getSolBalance,
  getUsdcBalance
};
