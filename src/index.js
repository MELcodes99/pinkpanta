require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const bot = new Telegraf(token);

// Catch ANY message
bot.on('message', (ctx) => {
  console.log('MESSAGE RECEIVED:', ctx.message.text);
  ctx.reply('Got message: ' + ctx.message.text).catch(e => console.error('REPLY FAILED:', e));
});

bot.catch((err) => console.error('BOT ERROR:', err));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Running');
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));

console.log('Starting polling...');
bot.startPolling();
console.log('Bot polling!');

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
  process.exit(0);
});
