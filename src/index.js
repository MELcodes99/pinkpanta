require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const bs58 = require('bs58');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance } = require('./solana/wallet');
const { getOrCreateUser, getUser, updateUserWallet, deleteUserWallet, createMarket, getUserMarkets } = require('./db/queries');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Telegraf(token);
const userState = {};

// Helper function to show wallet details
async function getWalletMessage(userId) {
  try {
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      return null;
    }
    
    let sol = 0;
    let usdc = 0;
    
    try {
      const balances = await Promise.race([
        getUserBalance(user.wallet_address),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      sol = balances.sol;
      usdc = balances.usdc;
    } catch (err) {
      console.error('Balance fetch error:', err.message);
    }
    
    const message = `💰 Your Wallet\n\n` +
      `📍 Address: \`${user.wallet_address}\`\n\n` +
      `---\n` +
      `💵 SOL Balance: ${sol} SOL\n` +
      `💵 USDC Balance: $${usdc.toFixed(2)}\n` +
      `📊 Total Bets: 0\n` +
      `✅ Total Wins: 0\n` +
      `❌ Total Losses: 0\n` +
      `📈 Profit/Loss: 0%\n\n` +
      `💸 In Active Bets: 0 USDC\n` +
      `🏦 Available to Withdraw: $${usdc.toFixed(2)}`;
    
    return {
      message,
      walletAddress: user.wallet_address,
      encryptedKeypair: user.encrypted_keypair
    };
  } catch (err) {
    console.error('ERROR getting wallet message:', err.message);
    return null;
  }
}

// ============= /START COMMAND =============
bot.command('start', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'User';
    
    await getOrCreateUser(userId, username);
    
    const user = await getUser(userId);
    const hasWallet = user && user.wallet_address;
    
    const greeting = `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Community Prediction Markets, powered by Panta, live on Solana.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'view_wallet' : 'create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'markets' }],
        [{ text: '📈 My Positions', callback_data: 'positions' }],
      ]
    };
    
    await ctx.reply(greeting, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in /start:', err.message);
    await ctx.reply('Error starting bot. Please try again.');
  }
});

// ============= /WALLET COMMAND =============
bot.command('wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const walletData = await getWalletMessage(userId);
    if (!walletData) {
      await ctx.reply('No wallet found. Use /start to create one.');
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '🗑️ Delete Wallet', callback_data: 'delete_wallet_confirm' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.reply(walletData.message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (err) {
    console.error('ERROR in /wallet:', err.message);
    await ctx.reply('Error loading wallet');
  }
});

// ============= CREATE WALLET =============
bot.action('create_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const keypair = generateUserKeypair();
    const walletAddress = keypair.publicKey.toString();
    const encryptedKey = encryptKeypair(keypair);
    
    await updateUserWallet(userId, walletAddress, encryptedKey);
    
    const privateKeyBase58 = bs58.encode(keypair.secretKey);
    userState[userId] = {
      privateKeyBase58: privateKeyBase58
    };
    
    const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    
    const message = `🎉 Wallet Created!\n\n` +
      `💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key: \`${privateKeyHidden}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Tap to Reveal Private Key', callback_data: 'reveal_pk' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    console.log(`[${new Date().toISOString()}] Wallet created for user ${userId}`);
  } catch (err) {
    console.error('ERROR creating wallet:', err.message);
    await ctx.answerCbQuery('Error creating wallet', true);
  }
});

// ============= VIEW WALLET =============
bot.action('view_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const walletData = await getWalletMessage(userId);
    if (!walletData) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '🗑️ Delete Wallet', callback_data: 'delete_wallet_confirm' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.editMessageText(walletData.message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (err) {
    console.error('ERROR viewing wallet:', err.message);
    await ctx.answerCbQuery('Error viewing wallet', true);
  }
});

// ============= COPY ADDRESS =============
bot.action('copy_address', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await getUser(userId);
    
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    await ctx.answerCbQuery(`✅ Copied: ${user.wallet_address}`, false);
  } catch (err) {
    console.error('ERROR copying address:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= VIEW PRIVATE KEY =============
bot.action('view_pk', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await getUser(userId);
    
    if (!user || !user.wallet_address || !user.encrypted_keypair) {
      console.log('User data:', user);
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    try {
      const keypair = decryptKeypair(user.encrypted_keypair);
      const privateKeyBase58 = bs58.encode(keypair.secretKey);
      
      userState[userId] = {
        privateKeyBase58: privateKeyBase58
      };
      
      const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
      
      const message = `🔐 Your Private Key\n\n` +
        `💳 Solana Wallet: \`${user.wallet_address}\`\n\n` +
        `🔑 Private Key: \`${privateKeyHidden}\`\n\n` +
        `⚠️ Do not share in chat or screenshots.`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '👁️ Tap to Reveal', callback_data: 'reveal_pk' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'view_wallet' }],
        ]
      };
      
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (decryptErr) {
      console.error('Decryption error:', decryptErr.message);
      await ctx.answerCbQuery('Error accessing private key', true);
    }
  } catch (err) {
    console.error('ERROR viewing pk:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= REVEAL PRIVATE KEY =============
bot.action('reveal_pk', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    if (!userState[userId] || !userState[userId].privateKeyBase58) {
      await ctx.answerCbQuery('Private key not loaded', true);
      return;
    }
    
    const user = await getUser(userId);
    const privateKeyBase58 = userState[userId].privateKeyBase58;
    
    const message = `🎉 Wallet Details\n\n` +
      `💳 Solana Wallet:\n\`${user.wallet_address}\`\n\n` +
      `🔐 Private Key (REVEALED):\n\`${privateKeyBase58}\`\n\n` +
      `⚠️ Do not share in chat or screenshots.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔒 Hide Private Key', callback_data: 'hide_pk' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'view_wallet' }],
      ]
    };
    
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCbQuery('Private key revealed');
  } catch (err) {
    console.error('ERROR revealing pk:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= HIDE PRIVATE KEY =============
bot.action('hide_pk', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const walletData = await getWalletMessage(userId);
    if (!walletData) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '🗑️ Delete Wallet', callback_data: 'delete_wallet_confirm' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.editMessageText(walletData.message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCbQuery('Private key hidden');
  } catch (err) {
    console.error('ERROR hiding pk:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= DELETE WALLET CONFIRMATION =============
bot.action('delete_wallet_confirm', async (ctx) => {
  try {
    const message = `⚠️ Delete Wallet?\n\nDeleting your wallet is irreversible. Make sure you have saved your seedphrase somewhere safe!`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Yes, delete it', callback_data: 'delete_wallet_ask_type' }],
        [{ text: '❌ No, keep it', callback_data: 'view_wallet' }],
      ]
    };
    
    await ctx.editMessageText(message, {
      reply_markup: keyboard
    });
  } catch (err) {
    console.error('ERROR in delete confirm:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= DELETE WALLET - ASK TO TYPE "Delete" =============
bot.action('delete_wallet_ask_type', async (ctx) => {
  try {
    const userId = ctx.from.id;
    userState[userId].deleteInProgress = true;
    
    const message = `Type the word "Delete" to confirm wallet deletion:`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Cancel', callback_data: 'view_wallet' }],
      ]
    };
    
    await ctx.editMessageText(message, {
      reply_markup: keyboard
    });
    
    await ctx.answerCbQuery('Type "Delete" in the chat to confirm');
  } catch (err) {
    console.error('ERROR in delete ask:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= CATCH MESSAGE FOR DELETE CONFIRMATION =============
bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    
    if (userState[userId] && userState[userId].deleteInProgress && text === 'Delete') {
      // Delete the wallet
      await deleteUserWallet(userId);
      delete userState[userId].deleteInProgress;
      
      const message = `🗑️ Wallet Deleted!\n\nYour wallet has been permanently deleted. You can create a new one anytime.`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '💰 Create New Wallet', callback_data: 'create_wallet' }],
          [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
        ]
      };
      
      await ctx.reply(message, {
        reply_markup: keyboard
      });
      
      console.log(`[${new Date().toISOString()}] Wallet deleted for user ${userId}`);
    } else if (userState[userId] && userState[userId].deleteInProgress && text !== 'Delete') {
      await ctx.reply('❌ Incorrect. Type "Delete" to confirm deletion.');
    }
  } catch (err) {
    console.error('ERROR in text handler:', err.message);
  }
});

// ============= MARKETS =============
bot.action('markets', async (ctx) => {
  try {
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 My Markets', callback_data: 'my_markets' }],
        [{ text: '🎯 Joined Markets', callback_data: 'joined_markets' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.editMessageText('Choose an option:', { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= MY MARKETS =============
bot.action('my_markets', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const markets = await getUserMarkets(userId);
    
    let message = '📊 Your Created Markets:\n\n';
    
    if (markets.length === 0) {
      message += 'No markets created yet!';
    } else {
      markets.forEach((m, i) => {
        message += `${i + 1}. ${m.title || m.category}\n`;
      });
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in my_markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= JOINED MARKETS =============
bot.action('joined_markets', async (ctx) => {
  try {
    const message = '🎯 Joined Markets:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in joined_markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= POSITIONS =============
bot.action('positions', async (ctx) => {
  try {
    const message = '📈 Your Positions:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in positions:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= BACK TO START MENU =============
bot.action('start_menu', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    const user = await getUser(userId);
    const hasWallet = user && user.wallet_address;
    
    const greeting = `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Community Prediction Markets, powered by Panta, live on Solana.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'view_wallet' : 'create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'markets' }],
        [{ text: '📈 My Positions', callback_data: 'positions' }],
      ]
    };
    
    await ctx.editMessageText(greeting, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in start_menu:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= ERROR HANDLERS =============
bot.catch((err, ctx) => {
  console.error('BOT ERROR:', err);
});

// ============= HTTP SERVER =============
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('PinkPanta bot running');
});

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Listening on port ${PORT}`);
});

// ============= BOT POLLING =============
console.log(`[${new Date().toISOString()}] Starting polling...`);
bot.startPolling().catch(err => {
  console.error('POLLING ERROR:', err);
  process.exit(1);
});

console.log(`[${new Date().toISOString()}] Bot polling started!`);

// ============= GRACEFUL SHUTDOWN =============
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
