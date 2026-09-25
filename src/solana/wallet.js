const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const crypto = require('crypto');

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Generate keypair for new user
function generateUserKeypair() {
  return Keypair.generate();
}

// Encrypt keypair for storage
function encryptKeypair(keypair, encryptionKey = process.env.ENCRYPTION_KEY) {
  const key = crypto.scryptSync(encryptionKey || 'default-key', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  
  const secretKey = JSON.stringify(Array.from(keypair.secretKey));
  let encrypted = cipher.update(secretKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

// Decrypt keypair from storage
function decryptKeypair(data, encryptionKey = process.env.ENCRYPTION_KEY) {
  const [ivHex, encrypted] = data.split(':');
  const key = crypto.scryptSync(encryptionKey || 'default-key', 'salt', 32);
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  const secretKeyArray = JSON.parse(decrypted);
  return Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
}

// Get user's balance
async function getUserBalance(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error('Error fetching balance:', error.message);
    return 0;
  }
}

module.exports = {
  connection,
  generateUserKeypair,
  encryptKeypair,
  decryptKeypair,
  getUserBalance,
};
