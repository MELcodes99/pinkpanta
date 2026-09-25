const { pool } = require('./schema');

async function runMigrations() {
  try {
    // Check if encrypted_keypair column exists
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'users' AND column_name = 'encrypted_keypair'`
    );

    if (result.rows.length === 0) {
      console.log('Adding encrypted_keypair column...');
      await pool.query('ALTER TABLE users ADD COLUMN encrypted_keypair TEXT');
      console.log('✓ Migration complete: encrypted_keypair column added');
    } else {
      console.log('✓ Database schema up to date');
    }
  } catch (err) {
    console.error('Error running migrations:', err);
    throw err;
  }
}

module.exports = { runMigrations };
