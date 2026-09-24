const { db } = require('./schema');

function addBettingTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        market_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        amount TEXT NOT NULL,
        quote_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    console.log('✓ Betting tables created');
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('✓ Betting tables already exist');
    } else {
      throw error;
    }
  }
}

addBettingTables();
