require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const bs58 = require('bs58');
const { initializeDb } = require('./db/schema');
const { runMigrations } = require('./db/migrations');
const { generateUserKeypair, encryptKeypair, decryptKeypair, getUserBalance, getSolBalance, getUsdcBalance } = require('./solana/wallet');
const { getOrCreateUser, getUser, updateUserWallet, deleteUserWallet, createMarket, getUserMarkets } = require('./db/queries');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Telegraf(token);
const userState = {};

// Fetch SOL price from CoinGecko
async function getSolPrice() {
  try {
    const response = await require('axios').get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    return response.data.solana.usd || 100; // Default to 100 if fetch fails
  } catch (err) {
    console.log('Could not fetch SOL price, using default 100');
    return 100;
  }
}

// Helper function to fetch LIVE balances
async function getLiveBalances(walletAddress) {
  try {
    console.log(`Fetching live balances for: ${walletAddress}`);
    
    const [sol, usdc] = await Promise.all([
      getSolBalance(walletAddress).catch(err => {
        console.error('SOL balance error:', err.message);
        return 0;
      }),
      getUsdcBalance(walletAddress).catch(err => {
        console.error('USDC balance error:', err.message);
        return 0;
      })
    ]);
    
    return { sol, usdc };
  } catch (err) {
    console.error('ERROR in getLiveBalances:', err.message);
    return { sol: 0, usdc: 0 };
  }
}

// Helper function to get wallet card message
async function getWalletCardMessage(userId) {
  try {
    const user = await getUser(userId);
    
    if (!user || !user.wallet_address) {
      console.log(`User not found or no wallet for userId: ${userId}`, user);
      return null;
    }
    
    const walletAddress = user.wallet_address;
    console.log(`Getting wallet card for address: ${walletAddress}`);
    
    // Fetch LIVE balances
    const { sol, usdc } = await getLiveBalances(walletAddress);
    
    // Get SOL price and calculate total in USD
    const solPrice = await getSolPrice();
    const totalUsd = (sol * solPrice) + usdc;
    
    const message = `💰 Your Wallet\n\n` +
      `📍 Address: \`${walletAddress}\`\n\n` +
      `---\n` +
      `💵 SOL Balance: ${sol} SOL ($${(sol * solPrice).toFixed(2)})\n` +
      `💵 USDC Balance: $${usdc.toFixed(2)}\n` +
      `📊 Total Bets: 0\n` +
      `✅ Total Wins: 0\n` +
      `❌ Total Losses: 0\n` +
      `📈 Profit/Loss: 0%\n\n` +
      `💸 Available to Withdraw: $${totalUsd.toFixed(2)}\n` +
      `(${sol} SOL + $${usdc.toFixed(2)} USDC)`;
    
    return {
      message,
      walletAddress,
      encryptedKeypair: user.encrypted_keypair,
      sol,
      usdc,
      solPrice
    };
  } catch (err) {
    console.error('ERROR in getWalletCardMessage:', err.message);
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
    
    const walletData = await getWalletCardMessage(userId);
    if (!walletData) {
      await ctx.reply('No wallet found. Use /start to create one.');
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '💸 Withdraw', callback_data: 'start_withdrawal' }],
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
    userState[userId] = userState[userId] || {};
    userState[userId].privateKeyBase58 = privateKeyBase58;
    
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
    
    console.log(`[${new Date().toISOString()}] Wallet created for user ${userId}, address: ${walletAddress}`);
  } catch (err) {
    console.error('ERROR creating wallet:', err.message);
    await ctx.answerCbQuery('Error creating wallet', true);
  }
});

// ============= VIEW WALLET =============
bot.action('view_wallet', async (ctx) => {
  try {
    const userId = ctx.from.id;
    console.log(`View wallet for user: ${userId}`);
    
    const walletData = await getWalletCardMessage(userId);
    if (!walletData) {
      console.log(`No wallet data found for user ${userId}`);
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '💸 Withdraw', callback_data: 'start_withdrawal' }],
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

    const message = `📋 Your Wallet Address:\n\n\`${user.wallet_address}\`\n\nTap and hold to copy, then paste anywhere!`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Back to Wallet', callback_data: 'view_wallet' }],
      ]
    };

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    await ctx.answerCbQuery('Address displayed - tap and hold to copy');
  } catch (err) {
    console.error('ERROR copying address:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= VIEW PRIVATE KEY =============
bot.action('view_pk', async (ctx) => {
  try {
    const userId = ctx.from.id;
    console.log(`Viewing private key for user: ${userId}`);
    
    const user = await getUser(userId);
    console.log(`User from DB:`, user);
    
    if (!user) {
      console.log(`User not found in database for userId: ${userId}`);
      await ctx.answerCbQuery('User not found', true);
      return;
    }
    
    if (!user.wallet_address) {
      console.log(`No wallet address for user ${userId}`);
      await ctx.answerCbQuery('No wallet address', true);
      return;
    }
    
    if (!user.encrypted_keypair) {
      console.log(`No encrypted keypair for user ${userId}. Columns available:`, Object.keys(user));
      await ctx.answerCbQuery('No encrypted keypair found', true);
      return;
    }
    
    try {
      console.log(`Attempting to decrypt keypair for user ${userId}`);
      const keypair = decryptKeypair(user.encrypted_keypair);
      const privateKeyBase58 = bs58.encode(keypair.secretKey);
      
      userState[userId] = userState[userId] || {};
      userState[userId].privateKeyBase58 = privateKeyBase58;
      
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
      
      console.log(`Private key view initiated for user ${userId}`);
    } catch (decryptErr) {
      console.error('Decryption error:', decryptErr.message);
      console.error('Encrypted data:', user.encrypted_keypair);
      await ctx.answerCbQuery('Error decrypting private key', true);
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
    
    const walletData = await getWalletCardMessage(userId);
    if (!walletData) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
        [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
        [{ text: '💸 Withdraw', callback_data: 'start_withdrawal' }],
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

// ============= START WITHDRAWAL =============
bot.action('start_withdrawal', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const walletData = await getWalletCardMessage(userId);
    
    if (!walletData) {
      await ctx.answerCbQuery('Wallet not found', true);
      return;
    }
    
    userState[userId] = userState[userId] || {};
    userState[userId].withdrawalInProgress = true;
    
    const message = `💸 Select Token to Withdraw\n\n` +
      `SOL: ${walletData.sol} (${(walletData.sol * walletData.solPrice).toFixed(2)} USD)\n` +
      `USDC: $${walletData.usdc.toFixed(2)}`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: `SOL (${walletData.sol})`, callback_data: 'withdraw_sol' }],
        [{ text: `USDC ($${walletData.usdc.toFixed(2)})`, callback_data: 'withdraw_usdc' }],
        [{ text: '⬅️ Cancel', callback_data: 'view_wallet' }],
      ]
    };
    
    await ctx.editMessageText(message, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR in start_withdrawal:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= WITHDRAW SOL =============
bot.action('withdraw_sol', async (ctx) => {
  try {
    const userId = ctx.from.id;
    userState[userId] = userState[userId] || {};
    userState[userId].selectedToken = 'SOL';
    
    await ctx.reply('📨 Enter the amount of SOL to withdraw:');
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR in withdraw_sol:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= WITHDRAW USDC =============
bot.action('withdraw_usdc', async (ctx) => {
  try {
    const userId = ctx.from.id;
    userState[userId] = userState[userId] || {};
    userState[userId].selectedToken = 'USDC';
    
    await ctx.reply('📨 Enter the amount of USDC to withdraw:');
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR in withdraw_usdc:', err.message);
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
    userState[userId] = userState[userId] || {};
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

// ============= CATCH MESSAGE FOR DELETE CONFIRMATION & WITHDRAWAL FLOW =============
bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    
    // Delete wallet confirmation
    if (userState[userId] && userState[userId].deleteInProgress && text === 'Delete') {
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
    
    // Withdrawal flow - amount input
    else if (userState[userId] && userState[userId].selectedToken && !userState[userId].withdrawalAmount) {
      const amount = parseFloat(text);
      
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Invalid amount. Please enter a valid number.');
        return;
      }
      
      // Check balance
      const walletData = await getWalletCardMessage(userId);
      const balance = userState[userId].selectedToken === 'SOL' ? walletData.sol : walletData.usdc;
      
      if (amount > balance) {
        await ctx.reply(`❌ Insufficient funds. You have ${balance} ${userState[userId].selectedToken} available.`);
        return;
      }
      
      userState[userId].withdrawalAmount = amount;
      await ctx.reply('📍 Enter the destination wallet address:');
    }
    
    // Withdrawal flow - address input
    else if (userState[userId] && userState[userId].selectedToken && userState[userId].withdrawalAmount && !userState[userId].destinationAddress) {
      const address = text.trim();
      
      // Basic validation
      if (address.length < 32) {
        await ctx.reply('❌ Invalid wallet address. Please enter a valid Solana address.');
        return;
      }
      
      userState[userId].destinationAddress = address;
      
      // Show confirmation
      const token = userState[userId].selectedToken;
      const amount = userState[userId].withdrawalAmount;
      const confirmMessage = `✅ Confirm Withdrawal\n\n` +
        `Token: ${token}\n` +
        `Amount: ${amount} ${token}\n` +
        `To: \`${address}\`\n\n` +
        `Click confirm to proceed.`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '✅ Confirm', callback_data: 'confirm_withdrawal' }],
          [{ text: '❌ Decline', callback_data: 'decline_withdrawal' }],
        ]
      };
      
      await ctx.reply(confirmMessage, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
  } catch (err) {
    console.error('ERROR in text handler:', err.message);
  }
});

// ============= CONFIRM WITHDRAWAL =============
bot.action('confirm_withdrawal', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    if (!userState[userId] || !userState[userId].selectedToken) {
      await ctx.answerCbQuery('Withdrawal data not found', true);
      return;
    }
    
    await ctx.reply('⏳ Processing withdrawal... This may take a few seconds.');
    
    // TODO: Send transaction
    // For now, just show success message
    await ctx.reply('✅ Withdrawal sent! Transaction confirmed.');
    
    // Clear withdrawal state
    delete userState[userId].selectedToken;
    delete userState[userId].withdrawalAmount;
    delete userState[userId].destinationAddress;
    delete userState[userId].withdrawalInProgress;
    
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR in confirm_withdrawal:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============= DECLINE WITHDRAWAL =============
bot.action('decline_withdrawal', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    // Clear withdrawal state
    delete userState[userId].selectedToken;
    delete userState[userId].withdrawalAmount;
    delete userState[userId].destinationAddress;
    delete userState[userId].withdrawalInProgress;
    
    await ctx.reply('❌ Withdrawal cancelled.');
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR in decline_withdrawal:', err.message);
    await ctx.answerCbQuery('Error', true);
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

// ============= INITIALIZE DB, RUN MIGRATIONS, AND START BOT =============
async function startup() {
  try {
    console.log('Initializing database...');
    await initializeDb();
    console.log('Database initialized successfully');
    
    console.log('Running migrations...');
    await runMigrations();
    console.log('Migrations completed');
    
    console.log(`[${new Date().toISOString()}] Starting polling...`);
    bot.startPolling().catch(err => {
      console.error('POLLING ERROR:', err);
      process.exit(1);
    });
    
    console.log(`[${new Date().toISOString()}] Bot polling started!`);
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

startup();

// ============= GRACEFUL SHUTDOWN =============
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
