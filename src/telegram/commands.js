const { getOrCreateUser, getUser, getUserMarkets, getUserPositions } = require('../db/queries');
const { handleCreateCommand } = require('./markets');
const { handleBetCommand, handleConfirmCommand } = require('./betting');
const { db } = require('../db/schema');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance } = require('../solana/wallet');

function registerCommands(bot) {
  // /start command
  bot.command('start', async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    try {
      console.log('START command - User:', telegramId);
      let user = getOrCreateUser(telegramId, username);
      console.log('User:', user);

      if (!user.wallet_address) {
        console.log('Generating new wallet...');
        const keypair = generateUserKeypair();
        const encrypted = encryptKeypair(keypair);
        const walletAddress = keypair.publicKey.toString();

        db.prepare(`
          UPDATE users SET wallet_address = ?, encrypted_keypair = ? WHERE id = ?
        `).run(walletAddress, encrypted, user.id);

        user = getUser(telegramId);
        
        const msg = `Wallet Created!\n\nAddress: ${walletAddress}\n\nNext steps:\n1. Fund this wallet\n2. Use /balance\n3. Use /export`;
        console.log('Sending reply...');
        await ctx.reply(msg);
        return;
      }

      const markets = getUserMarkets(user.id);
      const positions = getUserPositions(user.id);
      const balance = await getUserBalance(user.wallet_address);

      let dashboard = `Welcome back!\n\nWallet: ${user.wallet_address.slice(0, 8)}...\nBalance: ${balance.toFixed(4)} SOL`;
      await ctx.reply(dashboard);
    } catch (error) {
      console.error('START ERROR:', error);
      await ctx.reply('Error: ' + error.message);
    }
  });

  // /balance command
  bot.command('balance', async (ctx) => {
    const telegramId = ctx.from.id;
    const user = getUser(telegramId);

    if (!user) {
      await ctx.reply('Use /start first');
      return;
    }

    try {
      const balance = await getUserBalance(user.wallet_address);
      await ctx.reply(`Wallet: ${user.wallet_address}\n\nBalance: ${balance.toFixed(4)} SOL`);
    } catch (error) {
      console.error('BALANCE ERROR:', error);
      await ctx.reply('Error: ' + error.message);
    }
  });

  // /export command
  bot.command('export', (ctx) => {
    const telegramId = ctx.from.id;
    const user = getUser(telegramId);

    if (!user) {
      ctx.reply('Use /start first');
      return;
    }

    try {
      const keypair = decryptKeypair(user.encrypted_keypair);
      const secretKeyArray = Array.from(keypair.secretKey);
      const secretKeyJson = JSON.stringify(secretKeyArray);

      ctx.reply(
        `WARNING: Save this securely!\n\nPrivate Key:\n${secretKeyJson}\n\nDo NOT share!`
      );
    } catch (error) {
      console.error('EXPORT ERROR:', error);
      ctx.reply('Error: ' + error.message);
    }
  });
}

module.exports = { registerCommands };
