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
      let user = getOrCreateUser(telegramId, username);

      if (!user.wallet_address) {
        const keypair = generateUserKeypair();
        const encrypted = encryptKeypair(keypair);
        const walletAddress = keypair.publicKey.toString();

        db.prepare(`
          UPDATE users SET wallet_address = ?, encrypted_keypair = ? WHERE id = ?
        `).run(walletAddress, encrypted, user.id);

        user = getUser(telegramId);
        
        ctx.reply(
          `Wallet Created!\n\n` +
          `Address: ${walletAddress}\n\n` +
          `Next steps:\n` +
          `1. Fund this wallet with SOL\n` +
          `2. Use /balance to check balance\n` +
          `3. Use /export to get private key\n` +
          `4. Use /create to make markets`
        );
        return;
      }

      const markets = getUserMarkets(user.id);
      const positions = getUserPositions(user.id);
      const balance = await getUserBalance(user.wallet_address);

      let dashboard = `Welcome back!\n\n`;
      dashboard += `Wallet: ${user.wallet_address.slice(0, 8)}...\n`;
      dashboard += `Balance: ${balance.toFixed(4)} SOL\n\n`;
      dashboard += `Markets: ${markets.length} | Positions: ${positions.length}\n\n`;
      dashboard += `Commands:\n`;
      dashboard += `/create - Create market\n`;
      dashboard += `/yes <id> <amount> - Bet YES\n`;
      dashboard += `/no <id> <amount> - Bet NO\n`;
      dashboard += `/balance - Check balance\n`;
      dashboard += `/export - Export private key\n`;
      dashboard += `/markets - Your markets\n`;
      dashboard += `/positions - Your positions\n`;

      ctx.reply(dashboard);
    } catch (error) {
      console.error('Error in /start:', error.message);
      ctx.reply('Error setting up account');
    }
  });

  // /balance command
  bot.command('balance', async (ctx) => {
    const telegramId = ctx.from.id;
    const user = getUser(telegramId);

    if (!user) {
      ctx.reply('Use /start first');
      return;
    }

    try {
      const balance = await getUserBalance(user.wallet_address);
      ctx.reply(
        `Wallet Address:\n${user.wallet_address}\n\n` +
        `Balance: ${balance.toFixed(4)} SOL`
      );
    } catch (error) {
      console.error('Error fetching balance:', error.message);
      ctx.reply('Error fetching balance');
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

    if (!user.encrypted_keypair) {
      ctx.reply('No keypair found');
      return;
    }

    try {
      const keypair = decryptKeypair(user.encrypted_keypair);
      const secretKeyArray = Array.from(keypair.secretKey);
      const secretKeyJson = JSON.stringify(secretKeyArray);

      ctx.reply(
        `WARNING: Save this securely!\n\n` +
        `Private Key:\n` +
        `${secretKeyJson}\n\n` +
        `Do NOT share this with anyone!`
      );
    } catch (error) {
      console.error('Error exporting key:', error.message);
      ctx.reply('Error exporting private key');
    }
  });

  // /yes command
  bot.command('yes', (ctx) => handleBetCommand(ctx, 'YES'));

  // /no command
  bot.command('no', (ctx) => handleBetCommand(ctx, 'NO'));

  // /confirm command
  bot.command('confirm', (ctx) => handleConfirmCommand(ctx));

  // /create command
  bot.command('create', handleCreateCommand);

  // /markets command
  bot.command('markets', (ctx) => {
    const telegramId = ctx.from.id;
    const user = getUser(telegramId);

    if (!user) {
      ctx.reply('Use /start first');
      return;
    }

    try {
      const markets = getUserMarkets(user.id);

      if (markets.length === 0) {
        ctx.reply('No markets created yet.\nUse /create to start.');
        return;
      }

      let response = `Your Markets:\n\n`;
      markets.forEach((m, i) => {
        response += `${i + 1}. ${m.title}\n`;
        response += `   Status: ${m.status}\n\n`;
      });

      ctx.reply(response);
    } catch (error) {
      console.error('Error in /markets:', error.message);
      ctx.reply('Error fetching markets');
    }
  });

  // /positions command
  bot.command('positions', (ctx) => {
    const telegramId = ctx.from.id;
    const user = getUser(telegramId);

    if (!user) {
      ctx.reply('Use /start first');
      return;
    }

    try {
      const positions = getUserPositions(user.id);

      if (positions.length === 0) {
        ctx.reply('No open positions');
        return;
      }

      let response = `Your Positions:\n\n`;
      positions.forEach((p, i) => {
        response += `${i + 1}. ${p.title}\n`;
        response += `   ${p.outcome} | ${p.shares} shares\n\n`;
      });

      ctx.reply(response);
    } catch (error) {
      console.error('Error in /positions:', error.message);
      ctx.reply('Error fetching positions');
    }
  });
}

module.exports = { registerCommands };
