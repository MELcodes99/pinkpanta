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
    
    // Create users table
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

    // Create markets table
    await client.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id SERIAL PRIMARY KEY,
        market_id TEXT UNIQUE NOT NULL,
        creator_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        group_chat_id BIGINT,
        status TEXT DEFAULT 'open',
        volume_usdc TEXT DEFAULT '0.00',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id)
      );
    `);

    // Create positions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        shares TEXT NOT NULL,
        value_usdc TEXT DEFAULT '0.00',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (market_id) REFERENCES markets(market_id),
        UNIQUE(user_id, market_id, outcome)
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
