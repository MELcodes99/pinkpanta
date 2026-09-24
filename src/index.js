require('dotenv').config();
const { initializeDb } = require('./db/schema');
const { bot } = require('./telegram/bot');
const { registerCommands } = require('./telegram/commands');

console.log('Starting PinkPanta bot...');

// Initialize database
try {
  initializeDb();
  console.log('✓ Database initialized');
} catch (error) {
  console.error('Database init failed:', error.message);
  process.exit(1);
}

// Register Telegram commands
registerCommands(bot);
console.log('✓ Commands registered');

// Start polling explicitly
console.log('Starting polling...');

bot.startPolling();
console.log('✓ Bot is polling for messages!');
console.log('Send /start to your bot now');

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\nShutting down...');
  bot.stop('SIGINT');
  process.exit(0);
});
