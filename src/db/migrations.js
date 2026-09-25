const { db } = require('./schema');

function runMigrations() {
  return new Promise((resolve, reject) => {
    // Check if encrypted_keypair column exists
    db.all("PRAGMA table_info(users)", (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const hasColumn = rows.some(row => row.name === 'encrypted_keypair');
      
      if (!hasColumn) {
        console.log('Adding encrypted_keypair column...');
        db.run('ALTER TABLE users ADD COLUMN encrypted_keypair TEXT', (err) => {
          if (err) {
            reject(err);
          } else {
            console.log('✓ Migration complete: encrypted_keypair column added');
            resolve();
          }
        });
      } else {
        console.log('✓ Database schema up to date');
        resolve();
      }
    });
  });
}

module.exports = { runMigrations };
