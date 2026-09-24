const { getOrCreateUser, getUser } = require('../db/queries');
const { db } = require('../db/schema');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance } = require('../solana/wallet');

function registerCommands(bot) {
  // /start command only
  bot.command('start', async (ctx) => {
    try {
      console.log('START received');
      const telegramId = ctx.from.id;
      const username = ctx.from.username || ctx.from.first_name;

      let user = getOrCreateUser(telegramId, username);

      if (!user.wallet_address) {
        const keypair = generateUserKeypair();
        const encrypted = encryptKeypair(keypair);
        const walletAddress = keypair.publicKey.toString();

        db.prepare(`
          UPDATE users SET wallet_address = ?, encrypted_keypair = ? WHERE id = ?
        `).run(walletAddress, encrypted, user.id);

        await ctx.reply(`Wallet: ${walletAddress}`);
        console.log('Wallet created and reply sent');
        return;
      }

      const balance = await getUserBalance(user.wallet_address);
      await ctx.reply(`Balance: ${balance.toFixed(4)} SOL`);
      console.log('Reply sent');
    } catch (error) {
      console.error('ERROR:', error);
      await ctx.reply('Error: ' + error.message);
    }
  });
}

module.exports = { registerCommands };
