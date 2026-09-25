const { pool } = require('./schema');

// ========== USERS ==========

async function getOrCreateUser(userId, username) {
  const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
  if (result.rows.length > 0) return result.rows[0];
  const insertResult = await pool.query(
    'INSERT INTO users (telegram_id, username) VALUES ($1, $2) RETURNING *',
    [userId, username]
  );
  return insertResult.rows[0];
}

async function getUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
  return result.rows[0] || null;
}

async function updateUserWallet(userId, walletAddress, encryptedKeypair) {
  const result = await pool.query(
    'UPDATE users SET wallet_address = $1, encrypted_keypair = $2, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $3 RETURNING *',
    [walletAddress, encryptedKeypair, userId]
  );
  return result.rows[0];
}

async function deleteUserWallet(userId) {
  await pool.query(
    'UPDATE users SET wallet_address = NULL, encrypted_keypair = NULL, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $1',
    [userId]
  );
}

// ========== MARKETS ==========

async function createMarket(m) {
  const result = await pool.query(
    `INSERT INTO markets
      (market_id, creator_id, creator_telegram_id, creator_username, title, description,
       resolution_rules, yes_condition, no_condition, group_chat_id, group_name,
       image_url, start_time, end_time, resolution_time, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'open')
     RETURNING *`,
    [
      m.marketId, m.creatorId, m.creatorTelegramId, m.creatorUsername, m.title, m.description,
      m.resolutionRules, m.yesCondition, m.noCondition, m.groupChatId, m.groupName,
      m.imageUrl, m.startTime, m.endTime, m.resolutionTime, m.expiresAt,
    ]
  );
  return result.rows[0];
}

async function getUserMarkets(userId) {
  const result = await pool.query(
    'SELECT * FROM markets WHERE creator_telegram_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows || [];
}

async function getMarketsByGroup(groupChatId) {
  const result = await pool.query(
    'SELECT * FROM markets WHERE group_chat_id = $1 ORDER BY created_at DESC',
    [groupChatId]
  );
  return result.rows || [];
}

async function getMarketByTitleAndGroup(title, groupChatId) {
  const result = await pool.query(
    'SELECT * FROM markets WHERE LOWER(title) = LOWER($1) AND group_chat_id = $2',
    [title, groupChatId]
  );
  return result.rows[0] || null;
}

async function getMarketById(marketId) {
  const result = await pool.query('SELECT * FROM markets WHERE market_id = $1', [marketId]);
  return result.rows[0] || null;
}

async function updateMarketStatus(marketId, status) {
  const result = await pool.query(
    'UPDATE markets SET status = $1 WHERE market_id = $2 RETURNING *',
    [status, marketId]
  );
  return result.rows[0];
}

async function updateMarketPercentages(marketId, yesPercentage, noPercentage) {
  const result = await pool.query(
    'UPDATE markets SET yes_percentage = $1, no_percentage = $2 WHERE market_id = $3 RETURNING *',
    [yesPercentage, noPercentage, marketId]
  );
  return result.rows[0];
}

async function updateMarketVolume(marketId, volumeUsdc) {
  const result = await pool.query(
    'UPDATE markets SET volume_usdc = $1 WHERE market_id = $2 RETURNING *',
    [volumeUsdc, marketId]
  );
  return result.rows[0];
}

// ========== BETS ==========

async function createBet(b) {
  const result = await pool.query(
    `INSERT INTO bets
      (user_id, telegram_id, market_id, side, amount_usdc, shares, avg_price, fee_usdc, order_id, signature, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      b.userId, b.telegramId, b.marketId, b.side, b.amountUsdc,
      b.shares, b.avgPrice, b.feeUsdc, b.orderId, b.signature, b.status || 'submitted',
    ]
  );
  return result.rows[0];
}

async function getUserBetForMarket(telegramId, marketId) {
  const result = await pool.query(
    'SELECT * FROM bets WHERE telegram_id = $1 AND market_id = $2 ORDER BY created_at DESC LIMIT 1',
    [telegramId, marketId]
  );
  return result.rows[0] || null;
}

async function getUserBets(telegramId) {
  const result = await pool.query(
    'SELECT * FROM bets WHERE telegram_id = $1 ORDER BY created_at DESC',
    [telegramId]
  );
  return result.rows || [];
}

async function updateBetStatus(orderId, status) {
  const result = await pool.query(
    'UPDATE bets SET status = $1 WHERE order_id = $2 RETURNING *',
    [status, orderId]
  );
  return result.rows[0];
}

module.exports = {
  getOrCreateUser,
  getUser,
  updateUserWallet,
  deleteUserWallet,
  createMarket,
  getUserMarkets,
  getMarketsByGroup,
  getMarketByTitleAndGroup,
  getMarketById,
  updateMarketStatus,
  updateMarketPercentages,
  updateMarketVolume,
  createBet,
  getUserBetForMarket,
  getUserBets,
  updateBetStatus,
};
