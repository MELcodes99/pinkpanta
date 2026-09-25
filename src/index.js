require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const bs58 = require('bs58');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance } = require('./solana/wallet');
const { getOrCreateUser, getUser, updateUserWallet, createMarket, getUserMarkets } = require('./db/queries');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Telegraf(token);
const userState = {};

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
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'btn_view_wallet' : 'btn_create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'btn_markets' }],
        [{ text: '📈 My Positions', callback_data: 'btn_positions' }],
      ]
    };
    
    await ctx.reply(greeting, { reply_markup: keyboard });
    console.log(`[${new Date().toISOString()}] /start from @${username} (${userId})`);
  } catch (err) {
    console.error('ERROR in /start:', err.message);
    await ctx.reply('Error starting bot. Please try again.');
  }
});

// ============= CREATE WALLET BUTTON =============
bot.action('btn_create_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    const keypair = generateUserKeypair();
    const walletAddress = keypair.publicKey.toString();
    
    const encryptedKey = encryptKeypair(keypair);
    await updateUserWallet(userId, walletAddress, encryptedKey);
    
    const privateKeyBase58 = bs58.encode(keypair.secretKey);
    
    userState[userId] = {
      wallet: walletAddress,
      privateKeyBase58: privateKeyBase58,
      privateKeyArray: keypair.secretKey
    };
    
    const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    
    const message = `🎉 Wallet Created!\n\n` +
      `💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key: \`${privateKeyHidden}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Tap to Reveal Private Key', callback_data: `btn_reveal_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    console.log(`[${new Date().toISOString()}] Wallet created for @${username} (${userId})`);
  } catch (err) {
    console.error('ERROR creating wallet:', err.message);
    await ctx.answerCbQuery('Error creating wallet', true);
  }
});

// ============= VIEW WALLET BUTTON =============
bot.action('btn_view_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery('No wallet found. Create one first.', true);
      return;
    }
    
    const walletAddress = user.wallet_address;
    
    // Fetch live balances
    const { sol, usdc } = await getUserBalance(walletAddress);
    
    // TODO: Get these from Panta API or database
    const totalBets = 0;
    const totalWins = 0;
    const totalLosses = 0;
    const profitPercentage = 0;
    const moneyInBets = 0;
    const availableToWithdraw = usdc;
    
    const message = `💰 Your Wallet\n\n` +
      `📍 Address: \`${walletAddress}\`\n` +
      `(tap copy button below)\n\n` +
      `---\n` +
      `💵 SOL Balance: ${sol} SOL\n` +
      `💵 USDC Balance: $${usdc.toFixed(2)}\n` +
      `📊 Total Bets: ${totalBets}\n` +
      `✅ Total Wins: ${totalWins}\n` +
      `❌ Total Losses: ${totalLosses}\n` +
      `📈 Profit/Loss: ${profitPercentage}%\n\n` +
      `💸 In Active Bets: ${moneyInBets} USDC\n` +
      `🏦 Available to Withdraw: $${availableToWithdraw.toFixed(2)}`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: `btn_copy_wallet_${userId}` }],
        [{ text: '🔐 View Private Key', callback_data: `btn_view_existing_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    console.log(`[${new Date().toISOString()}] Viewed wallet for user ${userId}`);
  } catch (err) {
    console.error('ERROR viewing wallet:', err.message);
    await ctx.answerCbQuery('Error viewing wallet', true);
  }
});

// ============= COPY WALLET ADDRESS =============
bot.action(/btn_copy_wallet_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    await ctx.answerCbQuery(`Copied: ${user.wallet_address}`, false);
    console.log(`[${new Date().toISOString()}] Wallet address copied for user ${userId}`);
  } catch (err) {
    console.error('ERROR copying wallet:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= VIEW EXISTING PRIVATE KEY =============
bot.action(/btn_view_existing_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address || !user.encrypted_keypair) {
      console.log(`User data:`, user);
      await ctx.answerCbQuery('Wallet not found. Refresh and try again.', true);
      return;
    }
    
    try {
      const keypair = decryptKeypair(user.encrypted_keypair);
      const privateKeyBase58 = bs58.encode(keypair.secretKey);
      
      userState[userId] = {
        wallet: user.wallet_address,
        privateKeyBase58: privateKeyBase58,
        privateKeyArray: keypair.secretKey
      };
      
      const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
      
      const message = `🔐 Your Private Key\n\n` +
        `💳 Solana Wallet: \`${user.wallet_address}\`\n\n` +
        `🔑 Private Key: \`${privateKeyHidden}\`\n\n` +
        `⚠️ Do not share in chat or screenshots.`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '👁️ Tap to Reveal', callback_data: `btn_reveal_pk_${userId}` }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'btn_view_wallet' }],
        ]
      };
      
      await ctx.editMessageText(message, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
      });
      
      console.log(`[${new Date().toISOString()}] User ${userId} accessing private key`);
    } catch (decryptErr) {
      console.error('ERROR decrypting keypair:', decryptErr.message);
      await ctx.answerCbQuery('Error accessing private key. Try creating a new wallet.', true);
    }
  } catch (err) {
    console.error('ERROR viewing existing private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= REVEAL PRIVATE KEY BUTTON =============
bot.action(/btn_reveal_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    if (!userState[userId]) {
      await ctx.answerCbQuery('Wallet not found. Refresh and try again.', true);
      return;
    }
    
    const walletAddress = userState[userId].wallet;
    const privateKeyBase58 = userState[userId].privateKeyBase58;
    
    const message = `🎉 Wallet Details\n\n` +
      `💳 Solana Wallet:\n\`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key (REVEALED):\n\`${privateKeyBase58}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat or screenshots.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔒 Hide Private Key', callback_data: `btn_hide_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    await ctx.answerCbQuery('Private key revealed');
    console.log(`[${new Date().toISOString()}] Private key revealed for user ${userId}`);
  } catch (err) {
    console.error('ERROR revealing private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= HIDE PRIVATE KEY BUTTON =============
bot.action(/btn_hide_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    if (!userState[userId]) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const walletAddress = userState[userId].wallet;
    const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    
    const message = `🎉 Wallet Created!\n\n` +
      `💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key: \`${privateKeyHidden}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Tap to Reveal Private Key', callback_data: `btn_reveal_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    await ctx.answerCbQuery('Private key hidden');
  } catch (err) {
    console.error('ERROR hiding private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= MARKETS BUTTON =============
bot.action('btn_markets', async (ctx) => {
  try {
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 My Markets', callback_data: 'btn_my_markets' }],
        [{ text: '🎯 Joined Markets', callback_data: 'btn_joined_markets' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText('Choose an option:', { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in markets menu:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= MY MARKETS =============
bot.action('btn_my_markets', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const markets = await getUserMarkets(userId);
    
    let message = '📊 Your Created Markets:\n\n';
    
    if (markets.length === 0) {
      message += 'No markets created yet. Use /create to start one!';
    } else {
      markets.forEach((m, i) => {
        message += `${i + 1}. ${m.title || m.category}\n   ID: ${m.market_id}\n   Status: ${m.status}\n\n`;
      });
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'btn_markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching my markets:', err.message);
    await ctx.answerCbQuery('Error fetching markets', true);
  }
});

// ============= JOINED MARKETS =============
bot.action('btn_joined_markets', async (ctx) => {
  try {
    const message = '🎯 Joined Markets:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'btn_markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching joined markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= POSITIONS BUTTON =============
bot.action('btn_positions', async (ctx) => {
  try {
    const message = '📈 Your Positions:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching positions:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= BACK TO START MENU =============
bot.action('btn_start_menu', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    const user = await getUser(userId);
    const hasWallet = user && user.wallet_address;
    
    const greeting = `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Community Prediction Markets, powered by Panta, live on Solana.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'btn_view_wallet' : 'btn_create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'btn_markets' }],
        [{ text: '📈 My Positions', callback_data: 'btn_positions' }],
      ]
    };
    
    await ctx.editMessageText(greeting, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR going back to menu:', err.message);
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
EOFcat > ~/pinkpanta/src/index.js << 'EOF'
require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const bs58 = require('bs58');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance } = require('./solana/wallet');
const { getOrCreateUser, getUser, updateUserWallet, createMarket, getUserMarkets } = require('./db/queries');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Telegraf(token);
const userState = {};

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
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'btn_view_wallet' : 'btn_create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'btn_markets' }],
        [{ text: '📈 My Positions', callback_data: 'btn_positions' }],
      ]
    };
    
    await ctx.reply(greeting, { reply_markup: keyboard });
    console.log(`[${new Date().toISOString()}] /start from @${username} (${userId})`);
  } catch (err) {
    console.error('ERROR in /start:', err.message);
    await ctx.reply('Error starting bot. Please try again.');
  }
});

// ============= CREATE WALLET BUTTON =============
bot.action('btn_create_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    const keypair = generateUserKeypair();
    const walletAddress = keypair.publicKey.toString();
    
    const encryptedKey = encryptKeypair(keypair);
    await updateUserWallet(userId, walletAddress, encryptedKey);
    
    const privateKeyBase58 = bs58.encode(keypair.secretKey);
    
    userState[userId] = {
      wallet: walletAddress,
      privateKeyBase58: privateKeyBase58,
      privateKeyArray: keypair.secretKey
    };
    
    const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    
    const message = `🎉 Wallet Created!\n\n` +
      `💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key: \`${privateKeyHidden}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Tap to Reveal Private Key', callback_data: `btn_reveal_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    console.log(`[${new Date().toISOString()}] Wallet created for @${username} (${userId})`);
  } catch (err) {
    console.error('ERROR creating wallet:', err.message);
    await ctx.answerCbQuery('Error creating wallet', true);
  }
});

// ============= VIEW WALLET BUTTON =============
bot.action('btn_view_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery('No wallet found. Create one first.', true);
      return;
    }
    
    const walletAddress = user.wallet_address;
    
    // Fetch live balances
    const { sol, usdc } = await getUserBalance(walletAddress);
    
    // TODO: Get these from Panta API or database
    const totalBets = 0;
    const totalWins = 0;
    const totalLosses = 0;
    const profitPercentage = 0;
    const moneyInBets = 0;
    const availableToWithdraw = usdc;
    
    const message = `💰 Your Wallet\n\n` +
      `📍 Address: \`${walletAddress}\`\n` +
      `(tap copy button below)\n\n` +
      `---\n` +
      `💵 SOL Balance: ${sol} SOL\n` +
      `💵 USDC Balance: $${usdc.toFixed(2)}\n` +
      `📊 Total Bets: ${totalBets}\n` +
      `✅ Total Wins: ${totalWins}\n` +
      `❌ Total Losses: ${totalLosses}\n` +
      `📈 Profit/Loss: ${profitPercentage}%\n\n` +
      `💸 In Active Bets: ${moneyInBets} USDC\n` +
      `🏦 Available to Withdraw: $${availableToWithdraw.toFixed(2)}`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: `btn_copy_wallet_${userId}` }],
        [{ text: '🔐 View Private Key', callback_data: `btn_view_existing_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    console.log(`[${new Date().toISOString()}] Viewed wallet for user ${userId}`);
  } catch (err) {
    console.error('ERROR viewing wallet:', err.message);
    await ctx.answerCbQuery('Error viewing wallet', true);
  }
});

// ============= COPY WALLET ADDRESS =============
bot.action(/btn_copy_wallet_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    await ctx.answerCbQuery(`Copied: ${user.wallet_address}`, false);
    console.log(`[${new Date().toISOString()}] Wallet address copied for user ${userId}`);
  } catch (err) {
    console.error('ERROR copying wallet:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= VIEW EXISTING PRIVATE KEY =============
bot.action(/btn_view_existing_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    const user = await getUser(userId);
    if (!user || !user.wallet_address || !user.encrypted_keypair) {
      console.log(`User data:`, user);
      await ctx.answerCbQuery('Wallet not found. Refresh and try again.', true);
      return;
    }
    
    try {
      const keypair = decryptKeypair(user.encrypted_keypair);
      const privateKeyBase58 = bs58.encode(keypair.secretKey);
      
      userState[userId] = {
        wallet: user.wallet_address,
        privateKeyBase58: privateKeyBase58,
        privateKeyArray: keypair.secretKey
      };
      
      const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
      
      const message = `🔐 Your Private Key\n\n` +
        `💳 Solana Wallet: \`${user.wallet_address}\`\n\n` +
        `🔑 Private Key: \`${privateKeyHidden}\`\n\n` +
        `⚠️ Do not share in chat or screenshots.`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '👁️ Tap to Reveal', callback_data: `btn_reveal_pk_${userId}` }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'btn_view_wallet' }],
        ]
      };
      
      await ctx.editMessageText(message, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
      });
      
      console.log(`[${new Date().toISOString()}] User ${userId} accessing private key`);
    } catch (decryptErr) {
      console.error('ERROR decrypting keypair:', decryptErr.message);
      await ctx.answerCbQuery('Error accessing private key. Try creating a new wallet.', true);
    }
  } catch (err) {
    console.error('ERROR viewing existing private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= REVEAL PRIVATE KEY BUTTON =============
bot.action(/btn_reveal_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    if (!userState[userId]) {
      await ctx.answerCbQuery('Wallet not found. Refresh and try again.', true);
      return;
    }
    
    const walletAddress = userState[userId].wallet;
    const privateKeyBase58 = userState[userId].privateKeyBase58;
    
    const message = `🎉 Wallet Details\n\n` +
      `💳 Solana Wallet:\n\`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key (REVEALED):\n\`${privateKeyBase58}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat or screenshots.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔒 Hide Private Key', callback_data: `btn_hide_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    await ctx.answerCbQuery('Private key revealed');
    console.log(`[${new Date().toISOString()}] Private key revealed for user ${userId}`);
  } catch (err) {
    console.error('ERROR revealing private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= HIDE PRIVATE KEY BUTTON =============
bot.action(/btn_hide_pk_(\d+)/, async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1]);
    const currentUserId = ctx.from.id;
    
    if (userId !== currentUserId) {
      await ctx.answerCbQuery('Unauthorized', true);
      return;
    }
    
    if (!userState[userId]) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const walletAddress = userState[userId].wallet;
    const privateKeyHidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    
    const message = `🎉 Wallet Created!\n\n` +
      `💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens here.\n\n` +
      `🔐 Private Key: \`${privateKeyHidden}\`\n\n` +
      `⚠️ Import to your cold wallet and save securely. Do not share in chat.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Tap to Reveal Private Key', callback_data: `btn_reveal_pk_${userId}` }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
    
    await ctx.answerCbQuery('Private key hidden');
  } catch (err) {
    console.error('ERROR hiding private key:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= MARKETS BUTTON =============
bot.action('btn_markets', async (ctx) => {
  try {
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 My Markets', callback_data: 'btn_my_markets' }],
        [{ text: '🎯 Joined Markets', callback_data: 'btn_joined_markets' }],
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText('Choose an option:', { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in markets menu:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= MY MARKETS =============
bot.action('btn_my_markets', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const markets = await getUserMarkets(userId);
    
    let message = '📊 Your Created Markets:\n\n';
    
    if (markets.length === 0) {
      message += 'No markets created yet. Use /create to start one!';
    } else {
      markets.forEach((m, i) => {
        message += `${i + 1}. ${m.title || m.category}\n   ID: ${m.market_id}\n   Status: ${m.status}\n\n`;
      });
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'btn_markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching my markets:', err.message);
    await ctx.answerCbQuery('Error fetching markets', true);
  }
});

// ============= JOINED MARKETS =============
bot.action('btn_joined_markets', async (ctx) => {
  try {
    const message = '🎯 Joined Markets:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Markets', callback_data: 'btn_markets' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching joined markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= POSITIONS BUTTON =============
bot.action('btn_positions', async (ctx) => {
  try {
    const message = '📈 Your Positions:\n\nFeature coming soon!';
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Menu', callback_data: 'btn_start_menu' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR fetching positions:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= BACK TO START MENU =============
bot.action('btn_start_menu', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    
    const user = await getUser(userId);
    const hasWallet = user && user.wallet_address;
    
    const greeting = `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Community Prediction Markets, powered by Panta, live on Solana.`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'btn_view_wallet' : 'btn_create_wallet' }],
        [{ text: '📊 Markets', callback_data: 'btn_markets' }],
        [{ text: '📈 My Positions', callback_data: 'btn_positions' }],
      ]
    };
    
    await ctx.editMessageText(greeting, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR going back to menu:', err.message);
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
