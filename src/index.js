require('dotenv').config();
const http = require('http');
const { Telegraf, session } = require('telegraf');
const bs58 = require('bs58');

const { initializeDb } = require('./db/schema');
const { runMigrations } = require('./db/migrations');
const {
  generateUserKeypair, encryptKeypair, decryptKeypair,
  getSolBalance, getUsdcBalance,
} = require('./solana/wallet');
const {
  signAndSendBase64Tx, signAndSendInstructions,
} = require('./solana/transactions');
const {
  getOrCreateUser, getUser, updateUserWallet, deleteUserWallet,
  createMarket, getUserMarkets, getMarketsByGroup, getMarketByTitleAndGroup,
  getMarketById, updateMarketVolume,
  createBet, getUserBetForMarket, getUserBets,
} = require('./db/queries');
const { sendSolWithdrawal, sendUsdcWithdrawal } = require('./solana/withdrawal');
const {
  quoteMarket, buildCreateTransaction, registerMarket,
  quotePrimaryBuy, buildPrimaryBuy, submitPrimaryBuy, verifyPrimaryBuy,
} = require('./panta/services');

const token = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const BOT_USERNAME = process.env.BOT_USERNAME || 'pinkpanta_bot';
const DEFAULT_MARKET_IMAGE = process.env.DEFAULT_MARKET_IMAGE || 'https://raw.githubusercontent.com/MELcodes99/pinkpanta/main/assets/pinkpanta.jpeg';

if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Telegraf(token);
const userState = {};

bot.use(session());
bot.use((ctx, next) => { ctx.session = ctx.session || {}; return next(); });

// ============================================================
// HELPERS
// ============================================================

async function getLiveBalances(walletAddress) {
  const [sol, usdc] = await Promise.all([
    getSolBalance(walletAddress).catch(() => 0),
    getUsdcBalance(walletAddress).catch(() => 0),
  ]);
  return { sol, usdc };
}

async function getWalletCardMessage(userId) {
  const user = await getUser(userId);
  if (!user || !user.wallet_address) return null;
  const { sol, usdc } = await getLiveBalances(user.wallet_address);
  const message =
    `💰 Your Wallet\n\n` +
    `📍 Address: \`${user.wallet_address}\`\n\n` +
    `---\n` +
    `💵 SOL Balance: ${sol} SOL\n` +
    `💵 USDC Balance: $${usdc.toFixed(2)}\n\n` +
    `💸 Available to Withdraw: ${sol} SOL + $${usdc.toFixed(2)} USDC`;
  return { message, walletAddress: user.wallet_address, encryptedKeypair: user.encrypted_keypair, sol, usdc };
}

function walletKeyboard() {
  return { inline_keyboard: [
    [{ text: '📋 Copy Address', callback_data: 'copy_address' }],
    [{ text: '🔐 View Private Key', callback_data: 'view_pk' }],
    [{ text: '💸 Withdraw', callback_data: 'start_withdrawal' }],
    [{ text: '🗑️ Delete Wallet', callback_data: 'delete_wallet_confirm' }],
    [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
  ]};
}

function startKeyboard(hasWallet) {
  return { inline_keyboard: [
    [{ text: hasWallet ? '💰 View Wallet' : '💰 Create Wallet', callback_data: hasWallet ? 'view_wallet' : 'create_wallet' }],
    [{ text: '📊 My Markets', callback_data: 'my_markets' }],
    [{ text: '📈 My Bets', callback_data: 'my_bets' }],
  ]};
}

function greetingText(username) {
  return `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Community Prediction Markets, powered by Panta, live on Solana.`;
}

// SECURITY GUARD: wallet/key/transaction actions must never run in a group.
// Returns true only in private chat; otherwise redirects the user to DM.
async function requirePrivate(ctx) {
  if (ctx.chat && ctx.chat.type === 'private') return true;
  try {
    await ctx.reply(`🔒 For your security, wallet and transaction actions only work in private chat.\n\nOpen a private chat with @${BOT_USERNAME} and press Start.`);
  } catch (_) {}
  return false;
}

// Same guard for button taps (answers the callback so the spinner stops).
async function requirePrivateCb(ctx) {
  if (ctx.chat && ctx.chat.type === 'private') return true;
  try {
    await ctx.answerCbQuery('🔒 Open a private chat with the bot for wallet actions.', true);
  } catch (_) {}
  return false;
}

async function displayMarket(ctx, market) {
  const now = Math.floor(Date.now() / 1000);
  const ended = market.end_time && now >= Number(market.end_time);
  const resolved = ['resolved', 'resolved_yes', 'resolved_no'].includes(market.status);

  let msg =
    `📊 ${market.title}\n\n` +
    `${market.description || ''}\n\n` +
    `---\n` +
    `💰 Volume: $${market.volume_usdc}\n` +
    `📈 YES: ${market.yes_percentage}%  |  NO: ${market.no_percentage}%\n` +
    `👤 Creator: @${market.creator_username || 'unknown'}\n\n` +
    `📋 Resolution Rules:\n${market.resolution_rules || '—'}\n\n` +
    `⏰ Ends: ${market.end_time ? new Date(Number(market.end_time) * 1000).toUTCString() : 'N/A'}\n`;

  const keyboard = { inline_keyboard: [] };

  if (resolved) {
    const outcome = market.status === 'resolved_yes' ? 'YES ✅' : market.status === 'resolved_no' ? 'NO ❌' : 'Resolved';
    msg += `\n🏁 Status: RESOLVED — ${outcome}`;
    keyboard.inline_keyboard.push([{ text: '👁️ View My Bet', callback_data: `viewbet_${market.market_id}` }]);
  } else if (ended) {
    msg += `\n⏳ Status: Awaiting resolution from Panta`;
    keyboard.inline_keyboard.push([{ text: '👁️ View My Bet', callback_data: `viewbet_${market.market_id}` }]);
  } else {
    msg += `\n🟢 Status: Open`;
    keyboard.inline_keyboard.push([
      { text: '✅ YES', callback_data: `bet_yes_${market.market_id}` },
      { text: '❌ NO', callback_data: `bet_no_${market.market_id}` },
    ]);
  }

  await ctx.reply(msg, { reply_markup: keyboard });
}

function initMarketCreation(userId, groupId, groupName) {
  return { userId, groupId, groupName, step: 'title',
    title: null, description: null, yesCondition: null, noCondition: null,
    timezone: null, endTime: null };
}

// ============================================================
// COMMANDS
// ============================================================

// /start — PRIVATE ONLY (shows wallet buttons)
bot.command('start', async (ctx) => {
  try {
    if (!(await requirePrivate(ctx))) return;
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'User';
    await getOrCreateUser(userId, username);
    const user = await getUser(userId);
    await ctx.reply(greetingText(username), { reply_markup: startKeyboard(user && user.wallet_address) });
  } catch (err) {
    console.error('ERROR /start:', err.message);
    await ctx.reply('Error starting bot. Please try again.');
  }
});

// /wallet — PRIVATE ONLY
bot.command('wallet', async (ctx) => {
  try {
    if (!(await requirePrivate(ctx))) return;
    const walletData = await getWalletCardMessage(ctx.from.id);
    if (!walletData) { await ctx.reply('No wallet found. Use /start to create one.'); return; }
    await ctx.reply(walletData.message, { parse_mode: 'Markdown', reply_markup: walletKeyboard() });
  } catch (err) {
    console.error('ERROR /wallet:', err.message);
    await ctx.reply('Error loading wallet');
  }
});

// /createmarket — GROUP ONLY (flow runs in private chat)
bot.command('createmarket', async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('Use /createmarket inside a group to create a prediction market for that group.');
      return;
    }
    const userId = ctx.from.id;
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.reply(`You need a wallet first. Open a private chat with @${BOT_USERNAME} and use /start to create one.`);
      return;
    }
    ctx.session.marketCreation = initMarketCreation(userId, ctx.chat.id, ctx.chat.title || 'Group');
    try {
      await ctx.telegram.sendMessage(userId,
        '📊 Create Prediction Market\n\nStep 1 of 5: Send the market TITLE\n\n(Short, e.g. "ETH above $5k by Jan 2027")',
        { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_market_creation' }]] } });
      await ctx.reply('📨 I sent you a private message to set up the market. Continue there.');
    } catch (e) {
      await ctx.reply(`⚠️ I could not DM you. Open a private chat with @${BOT_USERNAME} first (tap the name → Start), then run /createmarket again.`);
    }
  } catch (err) {
    console.error('ERROR /createmarket:', err.message);
    await ctx.reply('Error starting market creation');
  }
});

// /viewmarket — GROUP ONLY
bot.command('viewmarket', async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('Use /viewmarket inside a group to view that group\'s markets.');
      return;
    }
    userState[ctx.from.id] = userState[ctx.from.id] || {};
    userState[ctx.from.id].viewMarketGroup = ctx.chat.id;
    await ctx.reply('🔎 Send the exact market TITLE you want to view.');
  } catch (err) {
    console.error('ERROR /viewmarket:', err.message);
    await ctx.reply('Error');
  }
});

// ============================================================
// WALLET ACTIONS — ALL PRIVATE ONLY
// ============================================================

bot.action('create_wallet', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const userId = ctx.from.id;
    const keypair = generateUserKeypair();
    const walletAddress = keypair.publicKey.toString();
    await updateUserWallet(userId, walletAddress, encryptKeypair(keypair));
    userState[userId] = userState[userId] || {};
    userState[userId].privateKeyBase58 = bs58.encode(keypair.secretKey);
    const hidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    const message =
      `🎉 Wallet Created!\n\n💳 Solana Wallet: \`${walletAddress}\`\n\n` +
      `⚠️ Only send SPL tokens (SOL, USDC) here.\n\n🔐 Private Key: \`${hidden}\`\n\n` +
      `⚠️ Save it securely. Never share it in chat.`;
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '👁️ Tap to Reveal Private Key', callback_data: 'reveal_pk' }],
      [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
    ]}});
  } catch (err) {
    console.error('ERROR create_wallet:', err.message);
    await ctx.answerCbQuery('Error creating wallet', true);
  }
});

bot.action('view_wallet', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const walletData = await getWalletCardMessage(ctx.from.id);
    if (!walletData) { await ctx.answerCbQuery('Wallet not found', true); return; }
    await ctx.editMessageText(walletData.message, { parse_mode: 'Markdown', reply_markup: walletKeyboard() });
  } catch (err) {
    console.error('ERROR view_wallet:', err.message);
    await ctx.answerCbQuery('Error viewing wallet', true);
  }
});

bot.action('copy_address', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const user = await getUser(ctx.from.id);
    if (!user || !user.wallet_address) { await ctx.answerCbQuery('Wallet not found', true); return; }
    await ctx.reply(`📋 Your Wallet Address:\n\n\`${user.wallet_address}\`\n\nTap and hold to copy.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Wallet', callback_data: 'view_wallet' }]] } });
    await ctx.answerCbQuery('Address sent');
  } catch (err) {
    console.error('ERROR copy_address:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('view_pk', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const user = await getUser(ctx.from.id);
    if (!user || !user.encrypted_keypair) { await ctx.answerCbQuery('No keypair found', true); return; }
    const keypair = decryptKeypair(user.encrypted_keypair);
    userState[ctx.from.id] = userState[ctx.from.id] || {};
    userState[ctx.from.id].privateKeyBase58 = bs58.encode(keypair.secretKey);
    const hidden = '••••••••••••••••••••••••••••••••••••••••••••••••••••';
    await ctx.editMessageText(
      `🔐 Your Private Key\n\n💳 Wallet: \`${user.wallet_address}\`\n\n🔑 Key: \`${hidden}\`\n\n⚠️ Never share it.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '👁️ Tap to Reveal', callback_data: 'reveal_pk' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'view_wallet' }],
      ]}});
  } catch (err) {
    console.error('ERROR view_pk:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('reveal_pk', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const st = userState[ctx.from.id];
    if (!st || !st.privateKeyBase58) { await ctx.answerCbQuery('Key not loaded', true); return; }
    const user = await getUser(ctx.from.id);
    await ctx.editMessageText(
      `🔐 Private Key (REVEALED)\n\n💳 Wallet:\n\`${user.wallet_address}\`\n\n🔑 Key:\n\`${st.privateKeyBase58}\`\n\n⚠️ Never share it.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔒 Hide', callback_data: 'view_wallet' }],
      ]}});
    await ctx.answerCbQuery('Revealed');
  } catch (err) {
    console.error('ERROR reveal_pk:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('start_withdrawal', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const walletData = await getWalletCardMessage(ctx.from.id);
    if (!walletData) { await ctx.answerCbQuery('Wallet not found', true); return; }
    userState[ctx.from.id] = userState[ctx.from.id] || {};
    userState[ctx.from.id].withdrawalInProgress = true;
    await ctx.editMessageText(
      `💸 Select Token to Withdraw\n\nSOL: ${walletData.sol}\nUSDC: $${walletData.usdc.toFixed(2)}`,
      { reply_markup: { inline_keyboard: [
        [{ text: `SOL (${walletData.sol})`, callback_data: 'withdraw_sol' }],
        [{ text: `USDC ($${walletData.usdc.toFixed(2)})`, callback_data: 'withdraw_usdc' }],
        [{ text: '⬅️ Cancel', callback_data: 'view_wallet' }],
      ]}});
  } catch (err) {
    console.error('ERROR start_withdrawal:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('withdraw_sol', async (ctx) => {
  if (!(await requirePrivateCb(ctx))) return;
  userState[ctx.from.id] = userState[ctx.from.id] || {};
  userState[ctx.from.id].selectedToken = 'SOL';
  await ctx.reply('📨 Enter the amount of SOL to withdraw:');
  await ctx.answerCbQuery();
});

bot.action('withdraw_usdc', async (ctx) => {
  if (!(await requirePrivateCb(ctx))) return;
  userState[ctx.from.id] = userState[ctx.from.id] || {};
  userState[ctx.from.id].selectedToken = 'USDC';
  await ctx.reply('📨 Enter the amount of USDC to withdraw:');
  await ctx.answerCbQuery();
});

bot.action('delete_wallet_confirm', async (ctx) => {
  if (!(await requirePrivateCb(ctx))) return;
  await ctx.editMessageText('⚠️ Delete Wallet?\n\nThis is irreversible. Make sure you saved your private key!',
    { reply_markup: { inline_keyboard: [
      [{ text: '✅ Yes, delete it', callback_data: 'delete_wallet_ask_type' }],
      [{ text: '❌ No, keep it', callback_data: 'view_wallet' }],
    ]}});
});

bot.action('delete_wallet_ask_type', async (ctx) => {
  if (!(await requirePrivateCb(ctx))) return;
  userState[ctx.from.id] = userState[ctx.from.id] || {};
  userState[ctx.from.id].deleteInProgress = true;
  await ctx.editMessageText('Type the word "Delete" to confirm wallet deletion:',
    { reply_markup: { inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'view_wallet' }]] } });
  await ctx.answerCbQuery('Type "Delete" to confirm');
});

bot.action('confirm_withdrawal', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const userId = ctx.from.id;
    const st = userState[userId];
    if (!st || !st.selectedToken) { await ctx.answerCbQuery('No withdrawal in progress', true); return; }
    await ctx.reply('⏳ Processing withdrawal...');
    const user = await getUser(userId);
    const keypair = decryptKeypair(user.encrypted_keypair);
    const result = st.selectedToken === 'SOL'
      ? await sendSolWithdrawal(keypair, st.destinationAddress, st.withdrawalAmount)
      : await sendUsdcWithdrawal(keypair, st.destinationAddress, st.withdrawalAmount);
    if (result.success) {
      await ctx.reply(`✅ Withdrawal Successful!\n\nToken: ${result.token}\nAmount: ${result.amount}\nTo: ${result.to}\nTX: \`${result.signature}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`❌ Withdrawal Failed!\n\nError: ${result.error}`);
    }
    delete st.selectedToken; delete st.withdrawalAmount; delete st.destinationAddress; delete st.withdrawalInProgress;
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR confirm_withdrawal:', err.message);
    await ctx.reply(`❌ Error: ${err.message}`);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('decline_withdrawal', async (ctx) => {
  if (!(await requirePrivateCb(ctx))) return;
  const st = userState[ctx.from.id] || {};
  delete st.selectedToken; delete st.withdrawalAmount; delete st.destinationAddress; delete st.withdrawalInProgress;
  await ctx.reply('❌ Withdrawal cancelled.');
  await ctx.answerCbQuery();
});

// ============================================================
// MARKET CREATION FLOW (runs in private chat)
// ============================================================

bot.action('tz_utc', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  ctx.session.marketCreation.timezone = 'UTC';
  ctx.session.marketCreation.step = 'time';
  await ctx.reply('Enter the market END date & time in UTC.\n\nFormat: YYYY-MM-DD HH:MM\nExample: 2027-01-01 15:00');
  await ctx.answerCbQuery();
});

bot.action('tz_wat', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  ctx.session.marketCreation.timezone = 'WAT';
  ctx.session.marketCreation.step = 'time';
  await ctx.reply('Enter the market END date & time in WAT (Lagos).\n\nFormat: YYYY-MM-DD HH:MM\nExample: 2027-01-01 16:00');
  await ctx.answerCbQuery();
});

bot.action('cancel_market_creation', async (ctx) => {
  delete ctx.session.marketCreation;
  await ctx.reply('❌ Market creation cancelled.');
  await ctx.answerCbQuery();
});

bot.action('confirm_market_creation', async (ctx) => {
  const mc = ctx.session.marketCreation;
  if (!mc || !mc.title) { await ctx.answerCbQuery('Session expired', true); return; }
  const userId = ctx.from.id;

  try {
    await ctx.editMessageText('⏳ Creating market on Panta...\n\n1/4 Requesting quote...');
    const user = await getUser(userId);
    const keypair = decryptKeypair(user.encrypted_keypair);
    const wallet = user.wallet_address;

    const endTime = mc.endTime;
    const startTime = Math.floor(Date.now() / 1000);
    const resolutionTime = endTime + 3600;

    const resolutionRule = `Resolves YES if: ${mc.yesCondition}. Resolves NO if: ${mc.noCondition}.`;

    const quote = await quoteMarket({
      wallet,
      question: mc.title,
      resolutionRule,
      sourcesOfTruth: ['https://www.google.com'],
      category: 'other',
      startTime,
      endTime,
      resolutionTime,
      title: mc.title,
      description: mc.description,
      imageUrl: DEFAULT_MARKET_IMAGE,
      region: 'Global',
    });

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n2/4 Building transaction...');
    const built = await buildCreateTransaction({ createId: quote.createId, wallet });

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n3/4 Signing & broadcasting...');
    const signature = await signAndSendBase64Tx(built.transaction, keypair);

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n4/4 Registering market...');
    const registered = await registerMarket({ createId: quote.createId, signature });
    const marketId = registered.marketId;

    await createMarket({
      marketId,
      creatorId: user.id,
      creatorTelegramId: userId,
      creatorUsername: user.username,
      title: mc.title,
      description: mc.description,
      resolutionRules: `This market will resolve YES if: ${mc.yesCondition}\nThis market will resolve NO if: ${mc.noCondition}`,
      yesCondition: mc.yesCondition,
      noCondition: mc.noCondition,
      groupChatId: mc.groupId,
      groupName: mc.groupName,
      imageUrl: DEFAULT_MARKET_IMAGE,
      startTime,
      endTime,
      resolutionTime,
      expiresAt: new Date(endTime * 1000),
    });

    await ctx.editMessageText(`✅ Market Created & Live!\n\n📊 ${mc.title}\n\nMarket ID: \`${marketId}\`\nTX: \`${signature}\``, { parse_mode: 'Markdown' });

    await ctx.telegram.sendMessage(mc.groupId,
      `🎉 New Market is LIVE!\n\n📊 ${mc.title}\n\n${mc.description}\n\nCreated by @${user.username || 'someone'}\n\nUse /viewmarket and enter the title to bet YES or NO!`);

    delete ctx.session.marketCreation;
    await ctx.answerCbQuery('Market created');
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('ERROR confirm_market_creation:', detail);
    await ctx.reply(`❌ Market creation failed:\n${detail}`);
    await ctx.answerCbQuery('Failed', true);
  }
});

// ============================================================
// BETTING (Primary buy) — approval happens in private chat
// ============================================================

bot.action(/^bet_(yes|no)_(.+)$/, async (ctx) => {
  try {
    const side = ctx.match[1];
    const marketId = ctx.match[2];
    const market = await getMarketById(marketId);
    if (!market) { await ctx.answerCbQuery('Market not found', true); return; }

    const userId = ctx.from.id;
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery(`Create a wallet first — DM @${BOT_USERNAME} and /start`, true);
      return;
    }

    userState[userId] = userState[userId] || {};
    userState[userId].bet = { marketId, side, step: 'amount' };

    try {
      await ctx.telegram.sendMessage(userId,
        `💸 Bet ${side === 'yes' ? '✅ YES' : '❌ NO'} on:\n\n📊 ${market.title}\n\nEnter the amount in USDC you want to bet:`);
      if (ctx.chat.type !== 'private') await ctx.reply('📨 Check your private chat to approve the bet.');
    } catch (e) {
      await ctx.reply(`⚠️ Open a private chat with @${BOT_USERNAME} first (tap the name → Start), then tap YES/NO again.`);
    }
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR bet action:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('confirm_bet', async (ctx) => {
  const userId = ctx.from.id;
  const st = userState[userId];
  if (!st || !st.bet || !st.bet.quote) { await ctx.answerCbQuery('No bet in progress', true); return; }

  try {
    await ctx.editMessageText('⏳ Placing bet...\n\n1/4 Building order...');
    const user = await getUser(userId);
    const keypair = decryptKeypair(user.encrypted_keypair);
    const wallet = user.wallet_address;
    const { marketId, side, quote, amount } = st.bet;

    const built = await buildPrimaryBuy({
      quoteId: quote.quoteId, wallet, userId: String(userId), maxSlippageBps: 100,
    });

    await ctx.editMessageText('⏳ Placing bet...\n\n2/4 Signing & broadcasting...');
    const signature = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);

    await ctx.editMessageText('⏳ Placing bet...\n\n3/4 Submitting to Panta...');
    await submitPrimaryBuy({ orderId: built.orderId, signature, wallet });

    let finalStatus = 'submitted';
    try {
      const v = await verifyPrimaryBuy({ orderId: built.orderId });
      finalStatus = v.status || 'submitted';
    } catch (_) {}

    await createBet({
      userId: user.id, telegramId: userId, marketId, side,
      amountUsdc: String(amount), shares: quote.shares, avgPrice: quote.avgPrice,
      feeUsdc: quote.feeUsdc, orderId: built.orderId, signature, status: finalStatus,
    });

    const market = await getMarketById(marketId);
    const newVol = (parseFloat(market.volume_usdc || '0') + parseFloat(amount)).toFixed(2);
    await updateMarketVolume(marketId, newVol);

    await ctx.editMessageText(
      `✅ Bet Placed!\n\n📊 ${market.title}\nSide: ${side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nShares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nStatus: ${finalStatus}\nTX: \`${signature}\``,
      { parse_mode: 'Markdown' });

    delete st.bet;
    await ctx.answerCbQuery('Bet placed');
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('ERROR confirm_bet:', detail);
    await ctx.reply(`❌ Bet failed:\n${detail}`);
    await ctx.answerCbQuery('Failed', true);
  }
});

bot.action('cancel_bet', async (ctx) => {
  const st = userState[ctx.from.id] || {};
  delete st.bet;
  await ctx.reply('❌ Bet cancelled.');
  await ctx.answerCbQuery();
});

bot.action(/^viewbet_(.+)$/, async (ctx) => {
  try {
    const marketId = ctx.match[1];
    const market = await getMarketById(marketId);
    const bet = await getUserBetForMarket(ctx.from.id, marketId);

    if (!bet) {
      await ctx.answerCbQuery();
      await ctx.reply('You did not participate in this market.');
      return;
    }

    let outcomeLine = '';
    if (['resolved_yes', 'resolved_no'].includes(market.status)) {
      const won = (market.status === 'resolved_yes' && bet.side === 'yes') ||
                  (market.status === 'resolved_no' && bet.side === 'no');
      outcomeLine = won
        ? `\n🏆 Result: WON\nPayout shares: ${bet.shares}`
        : `\n💔 Result: LOST\nStaked: ${bet.amount_usdc} USDC`;
    } else {
      outcomeLine = `\n⏳ Market not resolved yet.`;
    }

    await ctx.reply(
      `👁️ Your Bet\n\n📊 ${market.title}\nSide: ${bet.side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${bet.amount_usdc} USDC\nShares: ${bet.shares}\nAvg Price: ${bet.avg_price}${outcomeLine}`);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR viewbet:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============================================================
// MENU ACTIONS — PRIVATE ONLY
// ============================================================

bot.action('my_markets', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const markets = await getUserMarkets(ctx.from.id);
    let msg = '📊 Your Created Markets:\n\n';
    if (!markets.length) msg += 'None yet. Use /createmarket in a group.';
    else markets.forEach((m, i) => {
      const s = m.status === 'open' ? '🟢' : '🔴';
      msg += `${i + 1}. ${s} ${m.title}\n`;
    });
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'start_menu' }]] } });
  } catch (err) {
    console.error('ERROR my_markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('my_bets', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const bets = await getUserBets(ctx.from.id);
    let msg = '📈 Your Bets:\n\n';
    if (!bets.length) msg += 'No bets yet.';
    else {
      for (const b of bets.slice(0, 15)) {
        const m = await getMarketById(b.market_id);
        msg += `• ${m ? m.title : b.market_id} — ${b.side.toUpperCase()} ${b.amount_usdc} USDC (${b.status})\n`;
      }
    }
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'start_menu' }]] } });
  } catch (err) {
    console.error('ERROR my_bets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('start_menu', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    const user = await getUser(ctx.from.id);
    const username = ctx.from.username || ctx.from.first_name;
    await ctx.editMessageText(greetingText(username), { reply_markup: startKeyboard(user && user.wallet_address) });
  } catch (err) {
    console.error('ERROR start_menu:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

// ============================================================
// SINGLE TEXT HANDLER (all multi-step flows)
// ============================================================

bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const st = userState[userId] || (userState[userId] = {});
    const isPrivate = ctx.chat.type === 'private';

    if (text.startsWith('/')) return;

    // ---- PRIVATE-ONLY multi-step flows ----
    if (isPrivate) {
      // Wallet deletion
      if (st.deleteInProgress) {
        if (text === 'Delete') {
          await deleteUserWallet(userId);
          delete st.deleteInProgress;
          await ctx.reply('🗑️ Wallet Deleted!', { reply_markup: { inline_keyboard: [
            [{ text: '💰 Create New Wallet', callback_data: 'create_wallet' }],
            [{ text: '⬅️ Back to Menu', callback_data: 'start_menu' }],
          ]}});
        } else {
          await ctx.reply('❌ Incorrect. Type "Delete" to confirm.');
        }
        return;
      }

      // Withdrawal: amount
      if (st.selectedToken && !st.withdrawalAmount) {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount.'); return; }
        const walletData = await getWalletCardMessage(userId);
        const balance = st.selectedToken === 'SOL' ? walletData.sol : walletData.usdc;
        if (amount > balance) { await ctx.reply(`❌ Insufficient funds. You have ${balance} ${st.selectedToken}.`); return; }
        st.withdrawalAmount = amount;
        await ctx.reply('📍 Enter the destination wallet address:');
        return;
      }

      // Withdrawal: address
      if (st.selectedToken && st.withdrawalAmount && !st.destinationAddress) {
        if (text.length < 32) { await ctx.reply('❌ Invalid Solana address.'); return; }
        st.destinationAddress = text;
        await ctx.reply(
          `✅ Confirm Withdrawal\n\nToken: ${st.selectedToken}\nAmount: ${st.withdrawalAmount} ${st.selectedToken}\nTo: \`${text}\``,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '✅ Confirm', callback_data: 'confirm_withdrawal' }],
            [{ text: '❌ Decline', callback_data: 'decline_withdrawal' }],
          ]}});
        return;
      }

      // Betting: amount -> quote -> confirmation
      if (st.bet && st.bet.step === 'amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount. Enter a number.'); return; }

        const user = await getUser(userId);
        const market = await getMarketById(st.bet.marketId);
        if (!market) { await ctx.reply('Market not found.'); delete st.bet; return; }

        await ctx.reply('⏳ Getting quote from Panta...');
        try {
          const quote = await quotePrimaryBuy({
            wallet: user.wallet_address,
            marketId: st.bet.marketId,
            side: st.bet.side,
            amountUsdc: String(amount),
            userId: String(userId),
          });
          st.bet.quote = quote;
          st.bet.amount = amount;
          st.bet.step = 'confirm';

          await ctx.reply(
            `✅ Confirm Bet\n\n📊 ${market.title}\nSide: ${st.bet.side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nEst. Shares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nFee: ${quote.feeUsdc} USDC\n\nApprove to place your bet on-chain.`,
            { reply_markup: { inline_keyboard: [
              [{ text: '✅ Confirm & Sign', callback_data: 'confirm_bet' }],
              [{ text: '❌ Cancel', callback_data: 'cancel_bet' }],
            ]}});
        } catch (err) {
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          await ctx.reply(`❌ Could not get quote:\n${detail}`);
          delete st.bet;
        }
        return;
      }

      // Market creation steps
      if (ctx.session && ctx.session.marketCreation) {
        const mc = ctx.session.marketCreation;
        if (mc.step === 'title') {
          mc.title = text; mc.step = 'description';
          await ctx.reply('Step 2 of 5: Send the market DESCRIPTION');
          return;
        }
        if (mc.step === 'description') {
          mc.description = text; mc.step = 'yesCondition';
          await ctx.reply('Step 3 of 5: Complete this line —\n\n"This market will resolve YES if: ..."');
          return;
        }
        if (mc.step === 'yesCondition') {
          mc.yesCondition = text.replace(/^this market will resolve yes if:?\s*/i, ''); mc.step = 'noCondition';
          await ctx.reply('Step 4 of 5: Complete this line —\n\n"This market will resolve NO if: ..."');
          return;
        }
        if (mc.step === 'noCondition') {
          mc.noCondition = text.replace(/^this market will resolve no if:?\s*/i, ''); mc.step = 'timezone';
          await ctx.reply('Step 5 of 5: Choose the timezone for the market END time:',
            { reply_markup: { inline_keyboard: [
              [{ text: 'UTC', callback_data: 'tz_utc' }, { text: 'WAT (Lagos)', callback_data: 'tz_wat' }],
              [{ text: 'Cancel', callback_data: 'cancel_market_creation' }],
            ]}});
          return;
        }
        if (mc.step === 'time') {
          const m = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
          if (!m) { await ctx.reply('❌ Invalid format. Use YYYY-MM-DD HH:MM (e.g. 2027-01-01 15:00)'); return; }
          const [, Y, Mo, D, H, Mi] = m;
          let utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, 0);
          if (mc.timezone === 'WAT') utcMs -= 3600 * 1000;
          const endTime = Math.floor(utcMs / 1000);
          if (endTime <= Math.floor(Date.now() / 1000)) { await ctx.reply('❌ End time must be in the future.'); return; }
          mc.endTime = endTime;

          const user = await getUser(userId);
          const preview =
            `📋 Verify Market\n\n` +
            `Title: ${mc.title}\n` +
            `Description: ${mc.description}\n\n` +
            `This market will resolve YES if: ${mc.yesCondition}\n` +
            `This market will resolve NO if: ${mc.noCondition}\n\n` +
            `⏰ Ends: ${text} ${mc.timezone}\n` +
            `👤 Created by: @${user.username || 'you'}\n` +
            `📍 Group: ${mc.groupName}`;
          await ctx.reply(preview, { reply_markup: { inline_keyboard: [
            [{ text: '✅ Create', callback_data: 'confirm_market_creation' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
          ]}});
          return;
        }
      }
      return; // private chat, nothing matched
    }

    // ---- GROUP: only the /viewmarket title lookup ----
    if (st.viewMarketGroup && st.viewMarketGroup === ctx.chat.id) {
      const market = await getMarketByTitleAndGroup(text, ctx.chat.id);
      delete st.viewMarketGroup;
      if (!market) { await ctx.reply('Invalid market title'); return; }
      await displayMarket(ctx, market);
      return;
    }
  } catch (err) {
    console.error('ERROR text handler:', err.message);
  }
});

// ============================================================
// INFRA
// ============================================================

bot.catch((err) => console.error('BOT ERROR:', err));

const server = http.createServer((req, res) => { res.writeHead(200); res.end('PinkPanta bot running'); });
server.listen(PORT, () => console.log(`[${new Date().toISOString()}] Listening on ${PORT}`));

async function startup() {
  try {
    console.log('Initializing database...');
    await initializeDb();
    console.log('Running migrations...');
    await runMigrations();
    console.log('Clearing any stale connection...');
    try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch (e) { console.log('deleteWebhook skipped:', e.message); }
    console.log('Starting polling...');
    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot polling started!');
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}
startup();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
