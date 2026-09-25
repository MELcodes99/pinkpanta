const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

async function initializeDb() {
  try {
    const client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        wallet_address TEXT,
        encrypted_keypair TEXT,
        usdc_balance TEXT DEFAULT '0',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        market_id TEXT UNIQUE NOT NULL,
        creator_id INTEGER NOT NULL,
        creator_telegram_id BIGINT,
        creator_username TEXT,
        title TEXT NOT NULL,
        description TEXT,
        resolution_rules TEXT,
        yes_condition TEXT,
        no_condition TEXT,
        group_chat_id BIGINT,
        group_name TEXT,
        status TEXT DEFAULT 'open',
        volume_usdc TEXT DEFAULT '0.00',
        yes_percentage TEXT DEFAULT '50.00',
        no_percentage TEXT DEFAULT '50.00',
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        start_time BIGINT,
        end_time BIGINT,
        resolution_time BIGINT,
        expires_at TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id)
      );
    `);

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    console.log('✓ Database initialized');
    client.release();
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

module.exports = { pool, initializeDb };
