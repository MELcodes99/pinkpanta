require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

let messageCount = 0;

bot.on('message', (ctx) => {
  messageCount++;
  console.log(`[${new Date().toISOString()}] Message ${messageCount}:`, ctx.message.text);
});

bot.command('start', (ctx) => {
  console.log('START command received!');
  ctx.reply('Hello! Bot is working.');
});

console.log('Starting polling...');
bot.startPolling();
console.log('Polling started. Sending yourself a message in @pinkpanta_bot now...');

// Keep running
setInterval(() => {
  if (messageCount === 0) {
    console.log('Still waiting for messages...');
  }
}, 5000);
