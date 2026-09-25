const { Keypair, Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const crypto = require('crypto');
const bs58 = require('bs58');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  console.error('ERROR: ENCRYPTION_KEY must be at least 32 characters');
  process.exit(1);
}

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

// ============= LIVE BALANCE FETCHING =============
async function getSolBalance(walletAddress) {
  try {
    console.log(`Fetching SOL balance for: ${walletAddress}`);
    const publicKey = new PublicKey(walletAddress);
    const balanceLamports = await connection.getBalance(publicKey);
    const solBalance = balanceLamports / 1e9;
    console.log(`SOL Balance: ${solBalance}`);
    return parseFloat(solBalance.toFixed(4));
  } catch (err) {
    console.error('ERROR fetching SOL balance:', err.message);
    return 0;
  }
}

async function getUsdcBalance(walletAddress) {
  try {
    console.log(`Fetching USDC balance for: ${walletAddress}`);
    const publicKey = new PublicKey(walletAddress);
    const usdcMint = new PublicKey(USDC_MINT);
    
    // Get all token accounts for this wallet
    const accounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      { programId: TOKEN_PROGRAM_ID }
    );
    
    // Filter for USDC accounts
    const usdcAccounts = accounts.value.filter(account => {
      return account.account.data.parsed.info.mint === USDC_MINT;
    });
    
    if (usdcAccounts.length === 0) {
      console.log(`No USDC accounts found for ${walletAddress}`);
      return 0;
    }
    
    // Get balance from USDC account
    const balance = usdcAccounts[0].account.data.parsed.info.tokenAmount.uiAmount;
    console.log(`USDC Balance: ${balance}`);
    return parseFloat((balance || 0).toFixed(2));
  } catch (err) {
    console.error('ERROR fetching USDC balance:', err.message);
    return 0;
  }
}

async function getUserBalance(walletAddress) {
  try {
    console.log(`Fetching all balances for: ${walletAddress}`);
    
    const [sol, usdc] = await Promise.all([
      getSolBalance(walletAddress).catch(err => {
        console.error('SOL fetch failed:', err.message);
        return 0;
      }),
      getUsdcBalance(walletAddress).catch(err => {
        console.error('USDC fetch failed:', err.message);
        return 0;
      })
    ]);
    
    console.log(`Final balances - SOL: ${sol}, USDC: ${usdc}`);
    return { sol, usdc };
  } catch (err) {
    console.error('ERROR in getUserBalance:', err.message);
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
