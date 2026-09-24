require('dotenv').config();
const { Telegraf } = require('telegraf');
const { initializeDb } = require('./db/schema');
const { getOrCreateUser } = require('./db/queries');
const { db } = require('./db/schema');
const { generateUserKeypair, encryptKeypair, getUserBalance } = require('./solana/wallet');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new Telegraf(token);

initializeDb();

bot.command('start', async (ctx) => {
  try {
    console.log('START command');
    const telegramId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    let user = getOrCreateUser(telegramId, username);

    if (!user.wallet_address) {
      const keypair = generateUserKeypair();
      const encrypted = encryptKeypair(keypair);
      const walletAddress = keypair.publicKey.toString();

      db.prepare(`UPDATE users SET wallet_address = ?, encrypted_keypair = ? WHERE id = ?`).run(walletAddress, encrypted, user.id);

      await ctx.reply(`Wallet: ${walletAddress}`);
      return;
    }

    const balance = await getUserBalance(user.wallet_address);
    await ctx.reply(`Balance: ${balance.toFixed(4)} SOL`);
  } catch (error) {
    console.error('ERROR:', error);
    await ctx.reply('Error: ' + error.message);
  }
});

bot.catch((err) => console.error('BOT ERROR:', err));

console.log('Starting bot...');
bot.startPolling();
console.log('Bot running!');

process.once('SIGINT', () => bot.stop('SIGINT'));
