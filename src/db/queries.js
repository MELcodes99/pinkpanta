const { db } = require('./schema');

// Users
function getOrCreateUser(telegramId, username) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, username)
    VALUES (?, ?)
  `);
  stmt.run(telegramId, username);

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  return user;
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

function updateUserWallet(telegramId, walletAddress) {
  db.prepare(`
    UPDATE users SET wallet_address = ?, updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).run(walletAddress, telegramId);
}

// Markets
function createMarket(marketId, creatorId, title, description, groupChatId, expiresAt) {
  db.prepare(`
    INSERT INTO markets (market_id, creator_id, title, description, group_chat_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(marketId, creatorId, title, description, groupChatId, expiresAt);
}

function getMarket(marketId) {
  return db.prepare('SELECT * FROM markets WHERE market_id = ?').get(marketId);
}

function getUserMarkets(userId) {
  return db.prepare(`
    SELECT * FROM markets WHERE creator_id = ? ORDER BY created_at DESC
  `).all(userId);
}

// Positions
function createPosition(userId, marketId, outcome, shares, valueUsdc) {
  db.prepare(`
    INSERT OR REPLACE INTO positions (user_id, market_id, outcome, shares, value_usdc)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, marketId, outcome, shares, valueUsdc);
}

function getUserPositions(userId) {
  return db.prepare(`
    SELECT p.*, m.title, m.status FROM positions p
    JOIN markets m ON p.market_id = m.market_id
    WHERE p.user_id = ? ORDER BY p.updated_at DESC
  `).all(userId);
}

function getUserPositionInMarket(userId, marketId, outcome) {
  return db.prepare(`
    SELECT * FROM positions
    WHERE user_id = ? AND market_id = ? AND outcome = ?
  `).get(userId, marketId, outcome);
}

module.exports = {
  getOrCreateUser,
  getUser,
  updateUserWallet,
  createMarket,
  getMarket,
  getUserMarkets,
  createPosition,
  getUserPositions,
  getUserPositionInMarket,
};
