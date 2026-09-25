const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../pinkpanta.db');
const db = new Database(dbPath);

function addEncryptedKeypairColumn() {
  try {
    // Check if column already exists
    const tableInfo = db.pragma('table_info(users)');
    const hasColumn = tableInfo.some(col => col.name === 'encrypted_keypair');
    
    if (hasColumn) {
      console.log('✓ encrypted_keypair column already exists');
      return;
    }
    
    // Add the column
    db.exec(`ALTER TABLE users ADD COLUMN encrypted_keypair TEXT;`);
    console.log('✓ Added encrypted_keypair column to users table');
  } catch (err) {
    console.error('ERROR adding column:', err.message);
    throw err;
  } finally {
    db.close();
  }
}

addEncryptedKeypairColumn();
