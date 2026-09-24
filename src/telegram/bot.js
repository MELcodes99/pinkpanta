const { Telegraf } = require('telegraf');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Log every update
bot.on('message', (ctx) => {
  console.log('MESSAGE RECEIVED:', {
    text: ctx.message.text,
    from: ctx.from.username,
    chat: ctx.chat.id,
  });
});

// Catch all errors
bot.catch((err) => {
  console.error('Bot error:', err);
});

module.exports = { bot };
