const { pool } = require('./schema');

// Get or create user
async function getOrCreateUser(userId, username) {
  try {
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    const insertResult = await pool.query(
      'INSERT INTO users (telegram_id, username) VALUES ($1, $2) RETURNING *',
      [userId, username]
    );
    
    return insertResult.rows[0];
  } catch (err) {
    console.error('Error in getOrCreateUser:', err);
    throw err;
  }
}

// Get user
async function getUser(userId) {
  try {
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error in getUser:', err);
    throw err;
  }
}

// Update user wallet
async function updateUserWallet(userId, walletAddress, encryptedKeypair) {
  try {
    const result = await pool.query(
      'UPDATE users SET wallet_address = $1, encrypted_keypair = $2, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $3 RETURNING *',
      [walletAddress, encryptedKeypair, userId]
    );
    
    return result.rows[0];
  } catch (err) {
    console.error('Error in updateUserWallet:', err);
    throw err;
  }
}

// Delete user wallet
async function deleteUserWallet(userId) {
  try {
    await pool.query(
      'UPDATE users SET wallet_address = NULL, encrypted_keypair = NULL, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $1',
      [userId]
    );
  } catch (err) {
    console.error('Error in deleteUserWallet:', err);
    throw err;
  }
}

// Create market
async function createMarket(marketId, creatorId, title, description, groupChatId) {
  try {
    const result = await pool.query(
      'INSERT INTO markets (market_id, creator_id, title, description, group_chat_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [marketId, creatorId, title, description, groupChatId]
    );
    
    return result.rows[0];
  } catch (err) {
    console.error('Error in createMarket:', err);
    throw err;
  }
}

// Get user markets
async function getUserMarkets(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM markets WHERE creator_id = (SELECT id FROM users WHERE telegram_id = $1)',
      [userId]
    );
    
    return result.rows || [];
  } catch (err) {
    console.error('Error in getUserMarkets:', err);
    throw err;
  }
}

// Get user positions
async function getUserPositions(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM positions WHERE user_id = (SELECT id FROM users WHERE telegram_id = $1)',
      [userId]
    );
    
    return result.rows || [];
  } catch (err) {
    console.error('Error in getUserPositions:', err);
    throw err;
  }
}

module.exports = {
  getOrCreateUser,
  getUser,
  updateUserWallet,
  deleteUserWallet,
  createMarket,
  getUserMarkets,
  getUserPositions
};
