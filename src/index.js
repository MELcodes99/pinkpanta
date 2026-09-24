require('dotenv').config();
const { initializeDb } = require('./db/schema');
const { bot } = require('./telegram/bot');
const { registerCommands } = require('./telegram/commands');

console.log('Starting PinkPanta bot...');

initializeDb();
console.log('✓ Database initialized');

registerCommands(bot);
console.log('✓ Commands registered');

console.log('Starting polling...');

bot.startPolling();
console.log('✓ Bot is polling for messages!');
console.log('Send /start to your bot now');

// Catch any errors
bot.catch((err) => {
  console.error('Bot error:', err);
});

process.once('SIGINT', () => {
  console.log('\nShutting down...');
  bot.stop('SIGINT');
  process.exit(0);
});
