const { pool } = require('./schema');

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS encrypted_keypair TEXT;`);

    const marketCols = [
      `ADD COLUMN IF NOT EXISTS creator_telegram_id BIGINT`,
      `ADD COLUMN IF NOT EXISTS creator_username TEXT`,
      `ADD COLUMN IF NOT EXISTS resolution_rules TEXT`,
      `ADD COLUMN IF NOT EXISTS yes_condition TEXT`,
      `ADD COLUMN IF NOT EXISTS no_condition TEXT`,
      `ADD COLUMN IF NOT EXISTS group_name TEXT`,
      `ADD COLUMN IF NOT EXISTS yes_percentage TEXT DEFAULT '50.00'`,
      `ADD COLUMN IF NOT EXISTS no_percentage TEXT DEFAULT '50.00'`,
      `ADD COLUMN IF NOT EXISTS image_url TEXT`,
      `ADD COLUMN IF NOT EXISTS start_time BIGINT`,
      `ADD COLUMN IF NOT EXISTS end_time BIGINT`,
      `ADD COLUMN IF NOT EXISTS resolution_time BIGINT`,
    ];
    for (const col of marketCols) {
      await client.query(`ALTER TABLE markets ${col};`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        telegram_id BIGINT NOT NULL,
        market_id TEXT NOT NULL,
        side TEXT NOT NULL,
        amount_usdc TEXT NOT NULL,
        shares TEXT,
        avg_price TEXT,
        fee_usdc TEXT,
        order_id TEXT,
        signature TEXT,
        status TEXT DEFAULT 'submitted',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✓ Migrations applied');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
