require('dotenv').config();
const { Telegraf } = require('telegraf');
const { initializeDb } = require('./db/schema');

const token = process.env.TELEGRAM_BOT_TOKEN;
console.log('Token exists:', !!token);

const bot = new Telegraf(token);

initializeDb();

// Simple test
bot.start((ctx) => {
  console.log('START HANDLER FIRED');
  ctx.reply('Hello! Bot working!');
});

bot.on('text', (ctx) => {
  console.log('TEXT received:', ctx.message.text);
});

bot.catch((err) => console.error('ERROR:', err));

console.log('Starting polling...');
bot.startPolling();
console.log('Bot is running!');

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit(0);
});
