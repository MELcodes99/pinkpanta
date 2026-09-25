const { db } = require('./schema');

// Get or create user
function getOrCreateUser(userId, username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      if (row) {
        resolve(row);
      } else {
        db.run('INSERT INTO users (telegram_id, username) VALUES (?, ?)', [userId, username], function(err) {
          if (err) reject(err);
          resolve({ id: this.lastID, telegram_id: userId, username });
        });
      }
    });
  });
}

// Get user
function getUser(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      resolve(row);
    });
  });
}

// Update user wallet
function updateUserWallet(userId, walletAddress, encryptedKeypair) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET wallet_address = ?, encrypted_keypair = ? WHERE telegram_id = ?',
      [walletAddress, encryptedKeypair, userId],
      function(err) {
        if (err) reject(err);
        resolve({ wallet_address: walletAddress });
      }
    );
  });
}

// Delete user wallet
function deleteUserWallet(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET wallet_address = NULL, encrypted_keypair = NULL WHERE telegram_id = ?',
      [userId],
      function(err) {
        if (err) reject(err);
        resolve();
      }
    );
  });
}

// Create market
function createMarket(marketId, creatorId, title, description, groupChatId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO markets (market_id, creator_id, title, description, group_chat_id) VALUES (?, ?, ?, ?, ?)',
      [marketId, creatorId, title, description, groupChatId],
      function(err) {
        if (err) reject(err);
        resolve({ market_id: marketId, creator_id: creatorId });
      }
    );
  });
}

// Get user markets
function getUserMarkets(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM markets WHERE creator_id = (SELECT id FROM users WHERE telegram_id = ?)',
      [userId],
      (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      }
    );
  });
}

// Get user positions
function getUserPositions(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM positions WHERE user_id = (SELECT id FROM users WHERE telegram_id = ?)',
      [userId],
      (err, rows) => {
        if (err) reject(err);
        resolve(rows || []);
      }
    );
  });
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
