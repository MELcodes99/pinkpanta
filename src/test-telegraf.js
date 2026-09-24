require('dotenv').config();
const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
console.log('Token exists:', !!token);
console.log('Token length:', token?.length);

const bot = new Telegraf(token);

console.log('Bot created, attempting getMe...');

bot.telegram.getMe().then((me) => {
  console.log('Bot info:', me);
  process.exit(0);
}).catch((err) => {
  console.error('getMe failed:', err.message);
  process.exit(1);
});

// Timeout after 5 seconds
setTimeout(() => {
  console.error('Timeout waiting for getMe');
  process.exit(1);
}, 5000);
