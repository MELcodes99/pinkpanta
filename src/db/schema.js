const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../pinkpanta.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

function initializeDb() {
  // Users table: track Telegram users and their wallets
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      wallet_address TEXT,
      encrypted_keypair TEXT,
      usdc_balance TEXT DEFAULT '0',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Markets table: track markets created in groups
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT UNIQUE NOT NULL,
      creator_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      group_chat_id INTEGER,
      status TEXT DEFAULT 'open',
      volume_usdc TEXT DEFAULT '0.00',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );
  `);

  // Positions table: track user positions in markets
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      shares TEXT NOT NULL,
      value_usdc TEXT DEFAULT '0.00',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES markets(market_id),
      UNIQUE(user_id, market_id, outcome)
    );
  `);

  console.log('✓ Database initialized');
}

module.exports = { db, initializeDb };
