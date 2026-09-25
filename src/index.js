require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const bot = new Telegraf(token);

bot.command('start', async (ctx) => {
  await ctx.reply('Hello! Your wallet: ABC123XYZ');
});

bot.catch((err) => console.error('ERROR:', err));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Running');
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));

bot.startPolling();
console.log('Bot started');

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
  process.exit(0);
});
