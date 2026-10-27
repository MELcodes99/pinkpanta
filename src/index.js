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
  createBet, getUserBets, updateBetStatus, getWonBets, createMarket, getUserMarkets,
} = require('./db/queries');
const { sendSolWithdrawal, sendUsdcWithdrawal } = require('./solana/withdrawal');
const {
  quoteMarket, buildCreateTransaction, registerMarket,
  quotePrimaryBuy, buildPrimaryBuy, submitPrimaryBuy, verifyPrimaryBuy,
  getLiveMarkets, getCachedMarket, checkMarketResult, uploadMarketImage, buildWinClaim, buildCreatorFeeClaim, getAccountCreates, getPositions, SITE_BASE,
  getOrderBook, buildListShares, buildRestBid, buildFillOrder, buildCancelOrder,
  buildDispute, submitDispute, getDisputeStatus,
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
    [{ text: '📊 Browse Markets', callback_data: 'browse_markets' }],
    [{ text: '📈 My Bets', callback_data: 'my_bets' }],
  ]};
}

function greetingText(username) {
  return `Hello @${username}, welcome to PinkPanta!\n\nCreate and Participate in Panta Prediction Markets, powered by Panta, live on Solana.`;
}

async function requirePrivate(ctx) {
  if (ctx.chat && ctx.chat.type === 'private') return true;
  try {
    await ctx.reply(`🔒 For your security, wallet and transaction actions only work in private chat.\n\nOpen a private chat with @${BOT_USERNAME} and press Start.`);
  } catch (_) {}
  return false;
}

async function requirePrivateCb(ctx) {
  if (ctx.chat && ctx.chat.type === 'private') return true;
  try {
    await ctx.answerCbQuery('🔒 Open a private chat with the bot for wallet actions.', true);
  } catch (_) {}
  return false;
}

function initMarketCreation(userId, groupId, groupName) {
  return { userId, groupId, groupName, step: 'title',
    title: null, description: null, category: null, imageUrl: null, yesCondition: null, noCondition: null,
    timezone: null, endTime: null, endTimeText: null, marketType: null };
}

// ============================================================
// COMMANDS
// ============================================================

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

bot.command('markets', async (ctx) => {
  try { await showMarkets(ctx); }
  catch (err) { console.error('ERROR /markets:', err.message); await ctx.reply('Error loading markets'); }
});

bot.command('viewmarket', async (ctx) => {
  try { await showMarkets(ctx); }
  catch (err) { console.error('ERROR /viewmarket:', err.message); await ctx.reply('Error loading markets'); }
});

bot.command('createmarket', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const isPrivate = ctx.chat.type === 'private';
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.reply(`You need a wallet first. Open a private chat with @${BOT_USERNAME} and use /start to create one.`);
      return;
    }
    const groupId = isPrivate ? null : ctx.chat.id;
    const groupName = isPrivate ? null : (ctx.chat.title || 'Group');
    ctx.session.marketCreation = initMarketCreation(userId, groupId, groupName);

    if (isPrivate) {
      await ctx.reply(
        '📊 Create Prediction Market\n\nStep 1 of 5: Send the market TITLE\n\n(Short, e.g. "ETH above $5k by Jan 2027")',
        { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_market_creation' }]] } });
    } else {
      try {
        await ctx.telegram.sendMessage(userId,
          '📊 Create Prediction Market\n\nStep 1 of 5: Send the market TITLE\n\n(Short, e.g. "ETH above $5k by Jan 2027")',
          { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_market_creation' }]] } });
        await ctx.reply('📨 I sent you a private message to set up the market. Continue there.');
      } catch (e) {
        await ctx.reply(`⚠️ I could not DM you. Open a private chat with @${BOT_USERNAME} first (tap the name → Start), then run /createmarket again.`);
      }
    }
  } catch (err) {
    console.error('ERROR /createmarket:', err.message);
    await ctx.reply('Error starting market creation');
  }
});

// ============================================================
// MARKETS BROWSING
// ============================================================

async function showMarkets(ctx, edit = false) {
  let markets;
  try {
    markets = await getLiveMarkets(15);
  } catch (e) {
    const msg = 'Could not load markets right now. Try again shortly.';
    if (edit) { await ctx.editMessageText(msg); } else { await ctx.reply(msg); }
    return;
  }

  if (!markets.length) {
    const msg = 'No live markets available right now. Check back soon.';
    if (edit) { await ctx.editMessageText(msg); } else { await ctx.reply(msg); }
    return;
  }

  const rows = markets.map((m) => {
    const q = (m.question || m.title || m.description || m.marketId || "").slice(0, 42);
    const tag = m.bettable
      ? (m.yesPrice != null ? ` — YES ${Math.round(parseFloat(m.yesPrice) * 100)}%` : '')
      : ' 🔗';
    return [{ text: `${q}${tag}`, callback_data: `mkt_${m.marketId}` }];
  });

  const header = '📊 Live Markets

Tap a market to bet:';
  if (edit) { await ctx.editMessageText(header, { reply_markup: { inline_keyboard: rows } }); }
  else { await ctx.reply(header, { reply_markup: { inline_keyboard: rows } }); }
}

bot.action('browse_markets', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await showMarkets(ctx, true);
  } catch (err) {
    console.error('ERROR browse_markets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action(/^mkt_(.+)$/, async (ctx) => {
  try {
    const marketId = ctx.match[1];
    await ctx.answerCbQuery('Loading market...');

    let m;
    try { m = await getCachedMarket(marketId); }
    catch (e) { await ctx.reply('Could not load that market. Try again in a moment.'); return; }

    const question = (m.question || m.title || '').trim();
    if (false) {
      await ctx.reply('This market has no data available right now. Try another one.',
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Markets', callback_data: 'browse_markets' }]] } });
      return;
    }
    const isPrimary = m.phase === 'primary' && m.status === 'primary';
    const isSecondary = m.phase === 'secondary';
    const y = parseFloat(m.primaryYesPrice);
    const n = parseFloat(m.primaryNoPrice);
    const pct = (isPrimary && !isNaN(y) && !isNaN(n) && (y + n) > 0)
      ? { yes: Math.round(y * 100), no: Math.round(n * 100) } : null;
    const endStr = m.endTime ? new Date(Number(m.endTime) * 1000).toUTCString() : 'N/A';
    const vol = m.totalVolumeUsdc || m.volumeUsdc || '0';
    const rule = (m.resolutionRule || '').trim() || '—';
    const url = SITE_BASE + marketId;

    let msg = `📊 ${question}\n\n`;
    if (m.description && m.description.trim()) msg += `${m.description}\n\n`;
    msg += `---\n`;
    msg += `💰 Volume: $${vol}\n`;
    if (pct) msg += `📈 YES: ${pct.yes}%  |  NO: ${pct.no}%\n`;
    msg += `📋 Resolution:\n${rule}\n\n`;
    msg += `⏰ Ends: ${endStr}`;

    const keyboard = { inline_keyboard: [] };
    if (isPrimary && question) {
      keyboard.inline_keyboard.push([
        { text: '✅ Bet YES', callback_data: `pbet_yes_${marketId}` },
        { text: '❌ Bet NO', callback_data: `pbet_no_${marketId}` },
      ]);
    } else if (isSecondary) {
      msg += `\n\n📊 This market is in secondary (P2P) trading.`;
      keyboard.inline_keyboard.push([
        { text: '📖 Order Book', callback_data: `ob_${marketId}` },
        { text: '💰 Sell Shares', callback_data: `sell_shares_${marketId}` },
      ]);
      keyboard.inline_keyboard.push([
        { text: '🤝 Place Bid', callback_data: `place_bid_${marketId}` },
        { text: '🔗 Trade on Panta', url },
      ]);
    } else {
      msg += `\n\n⚠️ This market is not open for betting.`;
    }
    keyboard.inline_keyboard.push([
        { text: '🧠 Intelligence', callback_data: `intel_${marketId}` },
        { text: '⚖️ Dispute', callback_data: `dispute_${marketId}` },
      ]);
      keyboard.inline_keyboard.push([{ text: '⬅️ Back to Markets', callback_data: 'browse_markets' }]);

    await ctx.editMessageText(msg, { reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR mkt detail:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action(/^pbet_(yes|no)_(.+)$/, async (ctx) => {
  try {
    const side = ctx.match[1];
    const marketId = ctx.match[2];

    const userId = ctx.from.id;
    const user = await getUser(userId);
    if (!user || !user.wallet_address) {
      await ctx.answerCbQuery(`Create a wallet first — DM @${BOT_USERNAME} and /start`, true);
      return;
    }

    let m;
    try { m = await getCachedMarket(marketId); } catch (_) { m = {}; }
    const question = (m.question || m.title || 'this market').trim();

    userState[userId] = userState[userId] || {};
    userState[userId].bet = { marketId, side, step: 'amount', title: question, endTime: m.endTime || null };

    try {
      await ctx.telegram.sendMessage(userId,
        `💸 Bet ${side === 'yes' ? '✅ YES' : '❌ NO'} on:\n\n📊 ${question}\n\nEnter the amount in USDC you want to bet:`);
      if (ctx.chat.type !== 'private') await ctx.reply('📨 Check your private chat to approve the bet.');
    } catch (e) {
      await ctx.reply(`⚠️ Open a private chat with @${BOT_USERNAME} first (tap the name → Start), then tap Bet again.`);
    }
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('ERROR pbet:', err.message);
    await ctx.answerCbQuery('Error', true);
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
// MARKET CREATION FLOW
// ============================================================

bot.action('mc_skip_image', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  const mc = ctx.session.marketCreation;
  mc.imageUrl = null;
  mc.step = 'category';
  await ctx.editMessageText('Step 4 of 7: Choose a category:', { reply_markup: { inline_keyboard: [
    [{ text: '⚽ Sports', callback_data: 'mcat_sports' }, { text: '₿ Crypto', callback_data: 'mcat_crypto' }],
    [{ text: '💰 Finance', callback_data: 'mcat_finance' }, { text: '🔬 Science', callback_data: 'mcat_science' }],
    [{ text: '🌍 World', callback_data: 'mcat_world' }],
    [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
  ]}});
  await ctx.answerCbQuery();
});

bot.action(/^mcat_(sports|crypto|finance|science|world)$/, async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  const mc = ctx.session.marketCreation;
  mc.category = ctx.match[1];
  mc.step = 'yesCondition';
  await ctx.reply('Step 5 of 7: Complete this line —\n\n"This market will resolve YES if: ..."');
  await ctx.answerCbQuery(`Category: ${mc.category}`);
});

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

async function showCreateVerify(ctx) {
  const mc = ctx.session.marketCreation;
  if (!mc) { await ctx.answerCbQuery('Session expired', true); return; }
  const user = await getUser(ctx.from.id);
  const fee = mc.marketType === 'standard' ? '$50' : '$20';
  const typeName = mc.marketType === 'standard' ? 'Standard' : 'Breaking';
  const preview =
    `📋 Verify Market\n\n` +
    `Title: ${mc.title}\n` +
    `Description: ${mc.description}\n\n` +
    `This market will resolve YES if: ${mc.yesCondition}\n` +
    `This market will resolve NO if: ${mc.noCondition}\n\n` +
    `⏰ Ends: ${mc.endTimeText} ${mc.timezone}\n` +
    `🏷️ Type: ${typeName} (${fee} USDC fee)\n` +
    `👤 Created by: @${user.username || 'you'}`;
  await ctx.editMessageText(preview, { reply_markup: { inline_keyboard: [
    [{ text: `✅ Create (${fee})`, callback_data: 'confirm_market_creation' }],
    [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
  ]}});
  await ctx.answerCbQuery();
}

bot.action('mtype_breaking', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  ctx.session.marketCreation.marketType = 'breaking';
  await showCreateVerify(ctx);
});

bot.action('mtype_standard', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  ctx.session.marketCreation.marketType = 'standard';
  await showCreateVerify(ctx);
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
    const startTime = Math.floor(Date.now() / 1000) + 2 * 3600;
    const resolutionTime = endTime + 3600;

    const resolutionRule = `Resolves YES if: ${mc.yesCondition}. Resolves NO if: ${mc.noCondition}.`;
    const category = mc.category || 'crypto';
    const sourceByCategory = {
      crypto: 'https://www.coingecko.com',
      sports: 'https://www.espn.com',
      finance: 'https://www.bloomberg.com',
      science: 'https://www.nature.com',
      world: 'https://www.reuters.com',
    };
    const sourcesOfTruth = [sourceByCategory[category] || 'https://www.coingecko.com'];

    let quote, built, signature;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ctx.editMessageText(`⏳ Creating market on Panta...\n\n1/4 Requesting quote... (attempt ${attempt})`);
        quote = await quoteMarket({
          wallet, question: mc.title, resolutionRule, sourcesOfTruth, category,
          startTime, endTime, resolutionTime, title: mc.title, description: mc.description,
          imageUrl: mc.imageUrl || DEFAULT_MARKET_IMAGE, region: 'Global',
          marketType: mc.marketType || 'breaking',
        });
        await ctx.editMessageText('⏳ Creating market on Panta...\n\n2/4 Building transaction...');
        built = await buildCreateTransaction({ createId: quote.createId, wallet });
        await ctx.editMessageText('⏳ Creating market on Panta...\n\n3/4 Signing & broadcasting...');
        signature = await signAndSendBase64Tx(built.transaction, keypair);
        await ctx.editMessageText('⏳ Creating market on Panta...\n\n4/4 Registering market...');
        break;
      } catch (pipeErr) {
        const code = pipeErr.response?.data?.code;
        if (attempt < 3 && (code === 'INVALID_MARKET_PARAMS' || code === 'INVALID_CREATE_PARAMS')) {
          await new Promise(r => setTimeout(r, 500)); continue;
        }
        throw pipeErr;
      }
    }
    let marketId;
    try {
      const registered = await registerMarket({ createId: quote.createId, signature });
      marketId = registered.marketId;
    } catch (regErr) {
      console.warn('registerMarket failed (non-fatal):', regErr.message);
      marketId = built.expectedEventPda || null;
    }
    if (!marketId) throw new Error('Could not determine market ID after creation');

    try {
      await createMarket({
        marketId, creatorId: user.id, creatorTelegramId: userId,
        creatorUsername: user.username || '', title: mc.title, description: mc.description,
        resolutionRules: `Resolves YES if: ${mc.yesCondition}. Resolves NO if: ${mc.noCondition}.`,
        yesCondition: mc.yesCondition, noCondition: mc.noCondition,
        groupChatId: mc.groupId || null, groupName: mc.groupName || null,
        imageUrl: mc.imageUrl || DEFAULT_MARKET_IMAGE,
        startTime: new Date(startTime * 1000).toISOString(),
        endTime: new Date(endTime * 1000).toISOString(),
        resolutionTime: new Date(resolutionTime * 1000).toISOString(),
        expiresAt: new Date(endTime * 1000).toISOString(),
      });
    } catch (dbErr) { console.error('DB save market failed (non-fatal):', dbErr.message); }

    const url = SITE_BASE + marketId;
    await ctx.editMessageText(`✅ Market Created & Live!\n\n📊 ${mc.title}\n\nMarket ID: \`${marketId}\`\nTX: \`${signature}\``, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Bet YES', callback_data: `pbet_yes_${marketId}` }, { text: '❌ Bet NO', callback_data: `pbet_no_${marketId}` }],
        [{ text: '🔗 View on Panta', url }],
      ]},
    });

    if (mc.groupId) {
      await ctx.telegram.sendMessage(mc.groupId,
        `🎉 New Market is LIVE!\n\n📊 ${mc.title}\n\n${mc.description}\n\nCreated by @${user.username || 'someone'}\n\nUse /markets to find and bet!`);
    }

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
// BETTING CONFIRMATION (primary buy)
// ============================================================

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

    const built = await buildPrimaryBuy({ quoteId: quote.quoteId, wallet, userId: String(userId), maxSlippageBps: 100 });
    await ctx.editMessageText('⏳ Placing bet...\n\n2/4 Signing & broadcasting...');
    const signature = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
    await ctx.editMessageText('⏳ Placing bet...\n\n3/4 Submitting to Panta...');
    await submitPrimaryBuy({ orderId: built.orderId, signature, wallet });

    let finalStatus = 'submitted';
    try { const v = await verifyPrimaryBuy({ orderId: built.orderId }); finalStatus = v.status || 'submitted'; } catch (_) {}

    await createBet({
      userId: user.id, telegramId: userId, marketId, side,
      amountUsdc: String(amount), shares: quote.shares, avgPrice: quote.avgPrice,
      feeUsdc: quote.feeUsdc, orderId: built.orderId, signature, status: finalStatus,
      marketTitle: st.bet.title || null, marketEndTime: st.bet.endTime || null,
    });

    await ctx.editMessageText(
      `✅ Bet Placed!\n\n📊 ${st.bet.title || 'market'}\nSide: ${side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nShares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nStatus: ${finalStatus}\nTX: \`${signature}\``,
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

// ============================================================
// MENU ACTIONS — PRIVATE ONLY
// ============================================================

bot.action('my_bets', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    await ctx.editMessageText('📊 My Activity', { reply_markup: { inline_keyboard: [
      [{ text: '📈 Participated', callback_data: 'my_bets_participated' }, { text: '🏛️ Created', callback_data: 'my_bets_created' }],
      [{ text: '⬅️ Back', callback_data: 'start_menu' }],
    ]}});
  } catch (err) {
    console.error('ERROR my_bets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('my_bets_participated', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const user = await getUser(userId);
    const activeWallet = user?.wallet_address;

    const dbBets = await getUserBets(userId);

    await Promise.all(dbBets.map(async (b) => {
      if (b.status !== 'submitted' && b.status !== 'confirmed') return;
      try {
        const result = await checkMarketResult(b.market_id);
        if (result.resolved) {
          const won = (b.side === 'yes' && result.yesWins) || (b.side === 'no' && !result.yesWins);
          await updateBetStatus(b.order_id, won ? 'won' : 'lost');
          b.status = won ? 'won' : 'lost';
        }
      } catch (_) {}
    }));

    let onChainPositions = [];
    if (activeWallet) {
      try { onChainPositions = await getPositions(activeWallet) || []; } catch (_) {}
    }

    const dbMarketSideKeys = new Set(dbBets.map(b => `${b.market_id}:${b.side}`));
    const onChainRows = onChainPositions
      .filter(p => {
        const side = p.side?.toLowerCase();
        return !dbMarketSideKeys.has(`${p.marketId || p.market_id}:${side}`);
      })
      .map(p => ({
        _onChain: true,
        market_id: p.marketId || p.market_id,
        market_title: p.marketTitle || p.market_name || p.question || p.marketId || p.market_id,
        side: p.side?.toLowerCase(),
        amount_usdc: p.amountUsdc || p.cost || p.amount || 0,
        shares: p.shares || p.numShares || p.quantity || '?',
        status: p.resolved
          ? ((p.side?.toLowerCase() === 'yes' && p.yesWins) || (p.side?.toLowerCase() === 'no' && !p.yesWins) ? 'won' : 'lost')
          : 'on-chain',
        market_end_time: p.endTime || p.resolutionTime || null,
      }));

    const allBets = [...dbBets, ...onChainRows];

    const total = allBets.length;
    const volume = allBets.reduce((sum, b) => sum + parseFloat(b.amount_usdc || 0), 0);
    const wonCount = allBets.filter(b => b.status === 'won' || b.status === 'claimed').length;
    const lostCount = allBets.filter(b => b.status === 'lost').length;
    const settled = wonCount + lostCount;
    const winPct = settled > 0 ? Math.round((wonCount / settled) * 100) : null;
    const pnl = allBets.reduce((sum, b) => {
      if (b.status === 'won' || b.status === 'claimed') return sum + (parseFloat(b.shares || 0) - parseFloat(b.amount_usdc || 0));
      else if (b.status === 'lost') return sum - parseFloat(b.amount_usdc || 0);
      return sum;
    }, 0);
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : `-${Math.abs(pnl).toFixed(2)}`;

    let msg = '📈 Your Bets\n';
    if (onChainRows.length) msg += `_(includes ${onChainRows.length} on-chain position${onChainRows.length > 1 ? 's' : ''} from active wallet)_\n`;
    msg += '\n━━━━━━━━━━━━━━━\n';
    msg += `🎯 Total Bets: ${total}\n`;
    msg += `💰 Volume: ${volume.toFixed(2)} USDC\n`;
    msg += `✅ Won: ${wonCount}  |  ❌ Lost: ${lostCount}\n`;
    msg += winPct !== null ? `📊 Win Rate: ${winPct}%\n` : `📊 Win Rate: — (no resolved bets yet)\n`;
    msg += `💹 PNL: ${pnlStr} USDC\n`;
    msg += '━━━━━━━━━━━━━━━\n\n';

    if (!allBets.length) {
      msg += 'No bets yet. Use Browse Markets to place one.';
    } else {
      for (const b of allBets.slice(0, 10)) {
        const title = b.market_title || b.market_id;
        const side = b.side === 'yes' ? 'YES ✅' : 'NO ❌';
        const statusEmoji = (b.status === 'won' || b.status === 'claimed') ? '🏆' : b.status === 'lost' ? '❌' : '⏳';
        const dateStr = b.market_end_time ? new Date(Number(b.market_end_time) * 1000).toUTCString().replace(' GMT', '') : null;
        msg += `${statusEmoji} ${title}\n`;
        msg += `   ${side} • ${parseFloat(b.amount_usdc || 0).toFixed(2)} USDC • ${b.shares || '?'} shares\n`;
        if (dateStr) msg += `   ⏰ Ends: ${dateStr}\n`;
        if (b._onChain) {
          msg += `   Status: ${b.status === 'on-chain' ? 'active ⛓️' : b.status}\n`;
        } else {
          msg += `   Status: ${b.status === 'claimed' ? 'claimed ✅' : b.status}\n`;
          if (b.status === 'claimed' && (b.claim_signature || b.signature)) {
            msg += `   [View on Solscan](https://solscan.io/tx/${b.claim_signature || b.signature})\n`;
          }
        }
        msg += '\n';
      }
    }

    const wonBets = dbBets.filter(b => b.status === 'won');
    const keyboard = { inline_keyboard: [] };
    if (wonBets.length) {
      keyboard.inline_keyboard.push([{ text: `🏆 Claim Winnings (${wonBets.length} bet${wonBets.length > 1 ? 's' : ''})`, callback_data: 'claim_winnings' }]);
    }
    keyboard.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'my_bets' }]);

    await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR my_bets:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('claim_winnings', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const wonBets = await getWonBets(userId);

    if (!wonBets.length) {
      await ctx.editMessageText('🏆 No wins to claim right now.\n\nWins appear here when a market you bet on resolves in your favour.',
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to My Bets', callback_data: 'my_bets' }]] } });
      return;
    }

    await ctx.editMessageText(`⏳ Claiming your winnings...\n\n0 of ${wonBets.length} processed`);

    const user = await getUser(userId);
    const keypair = decryptKeypair(user.encrypted_keypair);
    const wallet = user.wallet_address;

    let claimed = 0, failed = 0, totalMsg = '';

    for (const b of wonBets) {
      try {
        const outcome = b.side === 'yes' ? 'YES' : 'NO';
        const built = await buildWinClaim({ wallet, marketId: b.market_id, outcome });
        const claimSig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
        await updateBetStatus(b.order_id, 'claimed', claimSig);
        claimed++;
        totalMsg += `✅ ${(b.market_title || b.market_id).slice(0, 40)}\n   TX: \`${claimSig.slice(0,20)}...\`\n\n`;
      } catch (err) {
        failed++;
        console.error('Claim failed for bet', b.order_id, err.message);
      }
    }

    let resultMsg = `🏆 Claims Complete!\n\n✅ Claimed: ${claimed}\n`;
    if (failed) resultMsg += `❌ Failed: ${failed}\n`;
    resultMsg += `\n${totalMsg}💰 Winnings are now in your wallet.`;

    await ctx.editMessageText(resultMsg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '💰 View Wallet', callback_data: 'view_wallet' }],
        [{ text: '⬅️ Back to My Bets', callback_data: 'my_bets_participated' }],
      ]}
    });
  } catch (err) {
    console.error('ERROR claim_winnings:', err.message);
    await ctx.reply('❌ Something went wrong claiming your winnings. Please try again.');
  }
});

bot.action('my_bets_created', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const user = await getUser(userId);

    let creates = [];
    try {
      const all = await getAccountCreates();
      creates = all.filter(m => m.wallet === user.wallet_address);
    } catch (_) {}
    const dbMarkets = await getUserMarkets(userId);
    const dbTitleMap = {};
    dbMarkets.forEach(m => { dbTitleMap[m.market_id] = m.title; });
    const markets = creates.length ? creates : dbMarkets.map(m => ({ eventPda: m.market_id, title: m.title }));

    let msg = '🏛️ Markets You Created\n\n';
    if (!markets.length) {
      msg += 'No markets created yet.\n\nUse /createmarket to create your first prediction market.';
      await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'my_bets' }]] }});
      return;
    }

    msg += `Total Created: ${markets.length}\n\n━━━━━━━━━━━━━━━\n\n`;
    let hasClaimableFees = false;

    for (const m of markets.slice(0, 10)) {
      const marketId = m.eventPda || m.market_id;
      let liveData = null;
      try { liveData = await getCachedMarket(marketId); } catch (_) {}
      const phase = liveData?.phase || 'unknown';
      const vol = liveData?.volumeUsdc || '0';
      const title = dbTitleMap[marketId] || liveData?.question || liveData?.title || marketId.slice(0, 12) + '...';
      const statusEmoji = phase === 'secondary' ? '🟢' : phase === 'resolved' ? '✅' : phase === 'cancelled' ? '❌' : '⏳';
      msg += `${statusEmoji} ${title}\n   Phase: ${phase} | Vol: $${vol}\n   [View on Panta](${SITE_BASE}${marketId})\n`;
      if (phase === 'secondary' || phase === 'secondary_active') {
        try {
          const feeCheck = await buildCreatorFeeClaim({ wallet: user.wallet_address, marketId });
          const feesUsdc = feeCheck.claimableFeesUsdc;
          if (feesUsdc && feesUsdc !== '0') {
            msg += `   💰 Claimable Fees: $${(parseInt(feesUsdc) / 1e6).toFixed(2)} USDC\n`;
            hasClaimableFees = true;
          }
        } catch (_) {}
      }
      msg += '\n';
    }

    const keyboard = { inline_keyboard: [] };
    if (hasClaimableFees) keyboard.inline_keyboard.push([{ text: '💰 Claim Creator Fees', callback_data: 'claim_creator_fees' }]);
    keyboard.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'my_bets' }]);
    await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR my_bets_created:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action('claim_creator_fees', async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const user = await getUser(userId);
    const keypair = decryptKeypair(user.encrypted_keypair);
    const wallet = user.wallet_address;
    const markets = await getUserMarkets(userId);
    await ctx.editMessageText('⏳ Claiming creator fees...');

    let claimed = 0, failed = 0, totalMsg = '';
    for (const m of markets) {
      try {
        const built = await buildCreatorFeeClaim({ wallet, marketId: m.market_id });
        if (!built.claimableFeesUsdc || built.claimableFeesUsdc === '0') continue;
        const signature = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
        claimed++;
        totalMsg += `✅ ${m.title.slice(0, 40)}\n   $${(parseInt(built.claimableFeesUsdc) / 1e6).toFixed(2)} USDC | [Solscan](https://solscan.io/tx/${signature})\n\n`;
      } catch (err) {
        const msg = err.response?.data?.code;
        if (msg === 'NO_CREATOR_FEES' || msg === 'MARKET_NOT_GRADUATED') continue;
        failed++;
      }
    }

    if (!claimed) {
      await ctx.editMessageText('💰 No creator fees to claim right now.',
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'my_bets_created' }]] } });
      return;
    }

    let resultMsg = `💰 Creator Fees Claimed!\n\n✅ Claimed from ${claimed} market${claimed > 1 ? 's' : ''}\n`;
    if (failed) resultMsg += `❌ Failed: ${failed}\n`;
    resultMsg += `\n${totalMsg}Money is now in your wallet.`;
    await ctx.editMessageText(resultMsg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '💰 View Wallet', callback_data: 'view_wallet' }],
        [{ text: '⬅️ Back', callback_data: 'my_bets_created' }],
      ]}
    });
  } catch (err) {
    console.error('ERROR claim_creator_fees:', err.message);
    await ctx.reply('❌ Something went wrong. Please try again.');
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
// SINGLE TEXT HANDLER (private only)
// ============================================================

bot.on('photo', async (ctx) => {
  const mc = ctx.session && ctx.session.marketCreation;
  if (!mc || mc.step !== 'image') return;
  try {
    await ctx.reply('⏳ Uploading your image...');
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imgRes = await require('axios').get(fileLink.href, { responseType: 'arraybuffer' });
    const imageUrl = await uploadMarketImage(Buffer.from(imgRes.data), 'market.jpg');
    mc.imageUrl = imageUrl;
    mc.step = 'category';
    await ctx.reply('✅ Image uploaded! Now Step 4 of 7: Choose a category:', {
      reply_markup: { inline_keyboard: [
        [{ text: '⚽ Sports', callback_data: 'mcat_sports' }, { text: '₿ Crypto', callback_data: 'mcat_crypto' }],
        [{ text: '💰 Finance', callback_data: 'mcat_finance' }, { text: '🔬 Science', callback_data: 'mcat_science' }],
        [{ text: '🌍 World', callback_data: 'mcat_world' }],
        [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
      ]}
    });
  } catch (err) {
    console.error('ERROR photo upload:', err.message);
    await ctx.reply('❌ Image upload failed. Tap Skip to use the default image instead.', {
      reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip (use default)', callback_data: 'mc_skip_image' }]] }
    });
  }
});

bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const st = userState[userId] || (userState[userId] = {});
    const isPrivate = ctx.chat.type === 'private';

    if (text.startsWith('/')) return;
    if (!isPrivate) return;

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

    // Dispute flow: reason step
    if (st.dispute) {
      const d = st.dispute;
      if (d.step === 'reason') {
        d.reason = text;
        d.step = 'evidence';
        await ctx.reply(
          `📝 Dispute reason noted.\n\nNow provide evidence URLs (comma-separated, up to 5):\n_e.g. https://source1.com, https://source2.com_`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `mkt_${d.marketId}` }]] }}
        );
        return;
      }
      if (d.step === 'evidence') {
        const evidence = text.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
        const { marketId, side, reason } = d;
        delete st.dispute;
        try {
          const user = await getUser(userId);
          if (!user?.wallet_address || !user?.encrypted_keypair) { await ctx.reply('No wallet.'); return; }
          const keypair = decryptKeypair(user.encrypted_keypair);
          await ctx.reply('⏳ Filing dispute...');
          const built = await buildDispute({ wallet: user.wallet_address, marketId, reason, evidence, side });
          const sig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
          const submitted = await submitDispute({ marketId, disputeId: built.disputeId, wallet: user.wallet_address, signature: sig });
          await ctx.reply(
            `✅ Dispute Filed!\n\nMarket: ${marketId.slice(0, 16)}...\nSide: ${side.toUpperCase()}\nStatus: ${submitted.status}\n\n[View on Solscan](https://solscan.io/tx/${sig})`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
              [{ text: '📊 Check Status', callback_data: `dispute_status_${marketId}` }],
            ]}}
          );
        } catch (err) {
          const code = err.response?.data?.code || err.message;
          await ctx.reply(`❌ Dispute failed: ${code}`);
        }
        return;
      }
    }

    // Secondary market: sell shares flow
    if (st.sellShares) {
      const ss = st.sellShares;
      if (ss.step === 'price') {
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0 || price >= 1) {
          await ctx.reply('❌ Invalid price. Enter a number between 0 and 1 (e.g. 0.42).');
          return;
        }
        ss.price = text;
        ss.step = 'shares';
        await ctx.reply(
          `💰 Selling ${ss.side.toUpperCase()} @ $${price}\n\nHow many shares do you want to list?\n_e.g. 5.00_`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ob_${ss.marketId}` }]] }}
        );
        return;
      }
      if (ss.step === 'shares') {
        const shares = parseFloat(text);
        if (isNaN(shares) || shares <= 0) { await ctx.reply('❌ Invalid amount.'); return; }
        const { marketId, side, price } = ss;
        delete st.sellShares;
        try {
          const user = await getUser(userId);
          if (!user?.wallet_address || !user?.encrypted_keypair) { await ctx.reply('No wallet.'); return; }
          const keypair = decryptKeypair(user.encrypted_keypair);
          await ctx.reply('⏳ Listing shares...');
          const built = await buildListShares({ wallet: user.wallet_address, marketId, side, price, shares: String(shares), userId: String(userId) });
          const sig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
          await ctx.reply(
            `✅ Shares Listed!\n\n${side.toUpperCase()} x${shares} @ $${price}\nListing ID: ${built.listingId}\n\n[View on Solscan](https://solscan.io/tx/${sig})`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
              [{ text: '📖 Order Book', callback_data: `ob_${marketId}` }],
              [{ text: '❌ Cancel Listing', callback_data: `cancel_order_${marketId}_${built.listingId}` }],
            ]}}
          );
        } catch (err) {
          await ctx.reply(`❌ List failed: ${err.response?.data?.code || err.message}`);
        }
        return;
      }
    }

    // Secondary market: place bid flow
    if (st.placeBid) {
      const pb = st.placeBid;
      if (pb.step === 'price') {
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0 || price >= 1) {
          await ctx.reply('❌ Invalid price. Enter a number between 0 and 1 (e.g. 0.35).');
          return;
        }
        pb.price = text;
        pb.step = 'shares';
        await ctx.reply(
          `🤝 Bidding ${pb.side.toUpperCase()} @ $${price}\n\nHow many shares do you want to bid for?\n_Cost will be shares × price USDC_`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ob_${pb.marketId}` }]] }}
        );
        return;
      }
      if (pb.step === 'shares') {
        const shares = parseFloat(text);
        if (isNaN(shares) || shares <= 0) { await ctx.reply('❌ Invalid amount.'); return; }
        const { marketId, side, price } = pb;
        delete st.placeBid;
        try {
          const user = await getUser(userId);
          if (!user?.wallet_address || !user?.encrypted_keypair) { await ctx.reply('No wallet.'); return; }
          const keypair = decryptKeypair(user.encrypted_keypair);
          await ctx.reply('⏳ Placing bid...');
          const built = await buildRestBid({ wallet: user.wallet_address, marketId, side, price, shares: String(shares), userId: String(userId) });
          const sig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
          await ctx.reply(
            `✅ Bid Placed!\n\n${side.toUpperCase()} x${shares} @ $${price}\nMax Cost: $${built.maxCostUsdc} USDC\nListing ID: ${built.listingId}\n\n[View on Solscan](https://solscan.io/tx/${sig})`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
              [{ text: '📖 Order Book', callback_data: `ob_${marketId}` }],
              [{ text: '❌ Cancel Bid', callback_data: `cancel_order_${marketId}_${built.listingId}` }],
            ]}}
          );
        } catch (err) {
          await ctx.reply(`❌ Bid failed: ${err.response?.data?.code || err.message}`);
        }
        return;
      }
    }

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

    if (st.bet && st.bet.step === 'amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount. Enter a number.'); return; }
      const user = await getUser(userId);
      await ctx.reply('⏳ Getting quote from Panta...');
      try {
        const quote = await quotePrimaryBuy({
          wallet: user.wallet_address, marketId: st.bet.marketId,
          side: st.bet.side, amountUsdc: String(amount), userId: String(userId),
        });
        st.bet.quote = quote;
        st.bet.amount = amount;
        st.bet.step = 'confirm';
        await ctx.reply(
          `✅ Confirm Bet\n\n📊 ${st.bet.title || 'this market'}\nSide: ${st.bet.side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nEst. Shares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nFee: ${quote.feeUsdc} USDC\n\nApprove to place your bet on-chain.`,
          { reply_markup: { inline_keyboard: [
            [{ text: '✅ Confirm & Sign', callback_data: 'confirm_bet' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_bet' }],
          ]}});
      } catch (err) {
        await ctx.reply(`❌ Could not get quote:\n${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        delete st.bet;
      }
      return;
    }

    if (ctx.session && ctx.session.marketCreation) {
      const mc = ctx.session.marketCreation;
      if (mc.step === 'title') { mc.title = text; mc.step = 'description'; await ctx.reply('Step 2 of 5: Send the market DESCRIPTION'); return; }
      if (mc.step === 'description') {
        mc.description = text; mc.step = 'image';
        await ctx.reply('Step 3 of 7: Send a photo for your market, or skip to use the default image.', {
          reply_markup: { inline_keyboard: [
            [{ text: '⏭️ Skip (use default)', callback_data: 'mc_skip_image' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
          ]}
        });
        return;
      }
      if (mc.step === 'yesCondition') { mc.yesCondition = text.replace(/^this market will resolve yes if:?\s*/i, ''); mc.step = 'noCondition'; await ctx.reply('Step 6 of 7: Complete this line —\n\n"This market will resolve NO if: ..."'); return; }
      if (mc.step === 'noCondition') {
        mc.noCondition = text.replace(/^this market will resolve no if:?\s*/i, ''); mc.step = 'timezone';
        await ctx.reply('Step 7 of 7: Choose the timezone for the market END time:', { reply_markup: { inline_keyboard: [
          [{ text: 'UTC', callback_data: 'tz_utc' }, { text: 'WAT (Lagos)', callback_data: 'tz_wat' }],
          [{ text: 'Cancel', callback_data: 'cancel_market_creation' }],
        ]}});
        return;
      }
      if (mc.step === 'time') {
        const m = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
        if (!m) { await ctx.reply('❌ Invalid format. Use YYYY-MM-DD HH:MM'); return; }
        const [, Y, Mo, D, H, Mi] = m;
        let utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, 0);
        if (mc.timezone === 'WAT') utcMs -= 3600 * 1000;
        const endTime = Math.floor(utcMs / 1000);
        if (endTime <= Math.floor(Date.now() / 1000)) { await ctx.reply('❌ End time must be in the future.'); return; }
        mc.endTime = endTime; mc.endTimeText = text; mc.step = 'markettype';
        await ctx.reply('Choose the market type:\n\n⚡ Breaking — $20 USDC fee\n📊 Standard — $50 USDC fee', { reply_markup: { inline_keyboard: [
          [{ text: '⚡ Breaking ($20)', callback_data: 'mtype_breaking' }],
          [{ text: '📊 Standard ($50)', callback_data: 'mtype_standard' }],
          [{ text: '❌ Cancel', callback_data: 'cancel_market_creation' }],
        ]}});
        return;
      }
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

// ─── Secondary Market Handlers ───────────────────────────────────────────────

bot.action(/^ob_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const marketId = ctx.match[1];
    const ob = await getOrderBook(marketId);
    const items = ob.items || [];
    const market = await getCachedMarket(marketId);
    const question = market?.question || marketId;

    let msg = `📖 Order Book\n${question.slice(0, 60)}\n\n━━━━━━━━━━━━━━━\n`;
    const asks = items.filter(i => i.intent === 'sell');
    const bids = items.filter(i => i.intent === 'buy');

    if (!asks.length && !bids.length) {
      msg += 'No open orders on this market.';
    } else {
      if (asks.length) {
        msg += `📤 *Asks (Sell)* — ${asks.length} open\n`;
        for (const a of asks.slice(0, 5)) {
          msg += `   ${a.side === 'yes' ? 'YES' : 'NO'} @ ${parseFloat(a.price).toFixed(3)} — ${(parseFloat(a.shares) - parseFloat(a.filledShares || 0)).toFixed(2)} shares\n`;
        }
        msg += '\n';
      }
      if (bids.length) {
        msg += `📥 *Bids (Buy)* — ${bids.length} open\n`;
        for (const b of bids.slice(0, 5)) {
          msg += `   ${b.side === 'yes' ? 'YES' : 'NO'} @ ${parseFloat(b.price).toFixed(3)} — ${(parseFloat(b.shares) - parseFloat(b.filledShares || 0)).toFixed(2)} shares\n`;
        }
      }
    }

    const keyboard = { inline_keyboard: [
      [{ text: '💰 Sell Shares', callback_data: `sell_shares_${marketId}` }, { text: '🤝 Place Bid', callback_data: `place_bid_${marketId}` }],
      [{ text: '⚖️ Dispute Resolution', callback_data: `dispute_${marketId}` }],
    ]};
    if (asks.length) {
      keyboard.inline_keyboard.splice(1, 0, [{ text: `⚡ Fill Best Ask (${asks[0].side?.toUpperCase()} @ ${parseFloat(asks[0].price).toFixed(3)})`, callback_data: `fill_${marketId}_${asks[0].listingId}` }]);
    }
    keyboard.inline_keyboard.push([{ text: '⬅️ Back to Market', callback_data: `mkt_${marketId}` }]);

    await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('ERROR ob:', err.message);
    await ctx.answerCbQuery('Error loading order book', true);
  }
});

bot.action(/^sell_shares_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const marketId = ctx.match[1];
    const st = userState[ctx.from.id] || (userState[ctx.from.id] = {});
    st.sellShares = { marketId, step: 'side' };
    const market = await getCachedMarket(marketId);
    await ctx.editMessageText(
      `💰 Sell Shares\n${(market?.question || marketId).slice(0, 60)}\n\nWhich side do you want to sell?`,
      { reply_markup: { inline_keyboard: [
        [{ text: 'YES shares', callback_data: `ss_side_yes_${marketId}` }, { text: 'NO shares', callback_data: `ss_side_no_${marketId}` }],
        [{ text: '❌ Cancel', callback_data: `ob_${marketId}` }],
      ]}}
    );
  } catch (err) { await ctx.answerCbQuery('Error', true); }
});

bot.action(/^ss_side_(yes|no)_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const side = ctx.match[1]; const marketId = ctx.match[2];
    const st = userState[ctx.from.id] || (userState[ctx.from.id] = {});
    st.sellShares = { marketId, side, step: 'price' };
    await ctx.editMessageText(
      `💰 Sell ${side.toUpperCase()} Shares\n\nEnter the price per share (0 < price < 1 USDC):\n_e.g. 0.42_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ob_${marketId}` }]] }}
    );
  } catch (err) { await ctx.answerCbQuery('Error', true); }
});

bot.action(/^place_bid_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const marketId = ctx.match[1];
    const st = userState[ctx.from.id] || (userState[ctx.from.id] = {});
    st.placeBid = { marketId, step: 'side' };
    const market = await getCachedMarket(marketId);
    await ctx.editMessageText(
      `🤝 Place Bid\n${(market?.question || marketId).slice(0, 60)}\n\nWhich side do you want to bid on?`,
      { reply_markup: { inline_keyboard: [
        [{ text: 'YES', callback_data: `pb_side_yes_${marketId}` }, { text: 'NO', callback_data: `pb_side_no_${marketId}` }],
        [{ text: '❌ Cancel', callback_data: `ob_${marketId}` }],
      ]}}
    );
  } catch (err) { await ctx.answerCbQuery('Error', true); }
});

bot.action(/^pb_side_(yes|no)_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const side = ctx.match[1]; const marketId = ctx.match[2];
    const st = userState[ctx.from.id] || (userState[ctx.from.id] = {});
    st.placeBid = { marketId, side, step: 'price' };
    await ctx.editMessageText(
      `🤝 Bid ${side.toUpperCase()}\n\nEnter your bid price per share (0 < price < 1 USDC):\n_e.g. 0.35_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ob_${marketId}` }]] }}
    );
  } catch (err) { await ctx.answerCbQuery('Error', true); }
});

bot.action(/^fill_(.+?)_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery('Building transaction...');
    const marketId = ctx.match[1]; const listingId = ctx.match[2];
    const user = await getUser(ctx.from.id);
    if (!user?.wallet_address || !user?.encrypted_keypair) { await ctx.reply('No wallet found.'); return; }
    const keypair = decryptKeypair(user.encrypted_keypair);
    await ctx.reply('⏳ Filling order...');
    const built = await buildFillOrder({ wallet: user.wallet_address, marketId, listingId, userId: String(ctx.from.id) });
    const sig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
    await ctx.reply(
      `✅ Order Filled!\n\n${built.intent === 'buy' ? 'Bought' : 'Sold'} ${built.shares} shares @ ${built.price}\n\n[View on Solscan](https://solscan.io/tx/${sig})`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📖 Order Book', callback_data: `ob_${marketId}` }]] }}
    );
  } catch (err) {
    await ctx.reply(`❌ Fill failed: ${err.response?.data?.code || err.message}`);
  }
});

bot.action(/^cancel_order_(.+?)_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery('Cancelling...');
    const marketId = ctx.match[1]; const listingId = ctx.match[2];
    const user = await getUser(ctx.from.id);
    if (!user?.wallet_address || !user?.encrypted_keypair) { await ctx.reply('No wallet found.'); return; }
    const keypair = decryptKeypair(user.encrypted_keypair);
    await ctx.reply('⏳ Cancelling order...');
    const built = await buildCancelOrder({ wallet: user.wallet_address, marketId, listingId });
    const sig = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
    await ctx.reply(
      `✅ Order Cancelled!\n\n[View on Solscan](https://solscan.io/tx/${sig})`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📖 Order Book', callback_data: `ob_${marketId}` }]] }}
    );
  } catch (err) {
    await ctx.reply(`❌ Cancel failed: ${err.response?.data?.code || err.message}`);
  }
});

// ─── Dispute Handlers ─────────────────────────────────────────────────────────

// Show dispute menu for a market
bot.action(/^dispute_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const marketId = ctx.match[1];
    const userId = ctx.from.id;
    const user = await getUser(userId);

    // Check existing dispute status first
    let existingDispute = null;
    if (user?.wallet_address) {
      try { existingDispute = await getDisputeStatus({ marketId, wallet: user.wallet_address }); } catch (_) {}
    }

    const market = await getCachedMarket(marketId);
    const question = (market?.question || marketId).slice(0, 60);

    let msg = `⚖️ Dispute Resolution\n${question}\n\n`;

    if (existingDispute && existingDispute.status) {
      const statusEmoji = { pending: '⏳', accepted: '✅', rejected: '❌', expired: '💨' }[existingDispute.status] || '❓';
      msg += `Your dispute: ${statusEmoji} ${existingDispute.status.toUpperCase()}\n`;
      if (existingDispute.submittedAt) msg += `Filed: ${new Date(existingDispute.submittedAt).toUTCString()}\n`;
      if (existingDispute.outcome) msg += `Outcome: ${existingDispute.outcome.toUpperCase()}\n`;
      msg += '\n_Disputes are reviewed on-chain. Reason and evidence are stored off-chain._';
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '⬅️ Back', callback_data: `ob_${marketId}` }],
      ]}});
    } else {
      msg += `You can dispute the oracle's proposed resolution during the 1-hour window after the market ends.\n\n`;
      msg += `⚠️ Filing a dispute locks a USDC bond (refunded if your side wins).\n\nWhich side do you believe should win?`;
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ YES should win', callback_data: `dispute_side_yes_${marketId}` }, { text: '❌ NO should win', callback_data: `dispute_side_no_${marketId}` }],
        [{ text: '⬅️ Back', callback_data: `ob_${marketId}` }],
      ]}});
    }
  } catch (err) {
    console.error('ERROR dispute menu:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action(/^dispute_side_(yes|no)_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const side = ctx.match[1];
    const marketId = ctx.match[2];
    const userId = ctx.from.id;
    const st = userState[userId] || (userState[userId] = {});
    st.dispute = { marketId, side, step: 'reason' };

    await ctx.editMessageText(
      `⚖️ Disputing — ${side.toUpperCase()} should win\n\nProvide your reason (1-2000 characters):\n_Explain why the oracle resolution is incorrect_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `dispute_${marketId}` }]] }}
    );
  } catch (err) {
    console.error('ERROR dispute_side:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});

bot.action(/^dispute_status_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery();
    const marketId = ctx.match[1];
    const user = await getUser(ctx.from.id);
    if (!user?.wallet_address) { await ctx.reply('No wallet found.'); return; }
    const status = await getDisputeStatus({ marketId, wallet: user.wallet_address });
    const statusEmoji = { pending: '⏳', accepted: '✅', rejected: '❌', expired: '💨' }[status.status] || '❓';
    let msg = `⚖️ Dispute Status\n\n${statusEmoji} ${(status.status || 'unknown').toUpperCase()}\n`;
    if (status.submittedAt) msg += `Filed: ${new Date(status.submittedAt).toUTCString()}\n`;
    if (status.resolvedAt) msg += `Resolved: ${new Date(status.resolvedAt).toUTCString()}\n`;
    if (status.outcome) msg += `Outcome: ${status.outcome.toUpperCase()}\n`;
    await ctx.reply(msg, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `ob_${marketId}` }]] }});
  } catch (err) {
    const code = err.response?.data?.code || err.message;
    await ctx.reply(`❌ Could not fetch dispute status: ${code}`);
  }
});

async function startup() {
  try {
    console.log('Initializing database...');
    await initializeDb();
    console.log('Running migrations...');
    await runMigrations();
    console.log('Clearing any stale connection...');
    try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch (e) { console.log('deleteWebhook skipped:', e.message); }
    console.log('Registering command menu...');
    try {
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Open your wallet & main menu' },
        { command: 'wallet', description: 'View your wallet, deposit or withdraw' },
        { command: 'markets', description: 'Browse live markets & place bets' },
        { command: 'createmarket', description: 'Create a new prediction market (in a group)' },
      ]);
    } catch (e) { console.log('setMyCommands skipped:', e.message); }
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

bot.action(/^intel_(.+)$/, async (ctx) => {
  try {
    if (!(await requirePrivateCb(ctx))) return;
    await ctx.answerCbQuery('Loading intelligence...');
    const marketId = ctx.match[1];

    let intel;
    try {
      intel = await getMarketIntelligence(marketId);
    } catch (err) {
      const code = err.response?.data?.code || err.message;
      await ctx.editMessageText(`❌ Could not load intelligence: ${code}`, {
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `mkt_${marketId}` }]] },
      });
      return;
    }

    const market = await getCachedMarket(marketId).catch(() => ({}));
    const question = (market?.question || marketId).slice(0, 60);

    const phaseEmoji = { created: '🕐', mid_market: '📊', post_resolution: '✅' }[intel.phase] || '📋';
    const statusLabel = intel.status === 'ready' ? '✅ Ready' : '⏳ Pending';

    let msg = `🧠 Panta Intelligence\n${question}\n\n`;
    msg += `${phaseEmoji} Phase: ${intel.phase || '—'}  |  ${statusLabel}\n`;

    if (intel.phase === 'post_resolution' && intel.outcome) {
      const outcomeEmoji = intel.outcome === 'yes' ? '✅' : '❌';
      msg += `\n📌 *Resolution Summary*\n`;
      msg += `Outcome: ${outcomeEmoji} ${intel.outcome.toUpperCase()}\n`;
      if (intel.resolvedAt) msg += `Settled: ${new Date(intel.resolvedAt).toUTCString()}\n`;
      if (intel.headline) msg += `\n*${intel.headline}*\n`;
      if (intel.summary) msg += `\n${intel.summary}\n`;
    }

    if (intel.insights && intel.insights.length) {
      msg += `\n💡 *Insights*\n`;
      intel.insights.slice(0, 3).forEach(i => { msg += `• ${i}\n`; });
    }

    if (intel.bullishFactors && intel.bullishFactors.length) {
      msg += `\n📈 *Bullish Factors*\n`;
      intel.bullishFactors.slice(0, 3).forEach(f => { msg += `• ${f}\n`; });
    }

    if (intel.bearishFactors && intel.bearishFactors.length) {
      msg += `\n📉 *Bearish Factors*\n`;
      intel.bearishFactors.slice(0, 3).forEach(f => { msg += `• ${f}\n`; });
    }

    if (intel.risks && intel.risks.length) {
      msg += `\n⚠️ *Risks*\n`;
      intel.risks.slice(0, 2).forEach(r => { msg += `• ${r}\n`; });
    }

    if (intel.historicalContext) {
      msg += `\n📚 *Context*\n${intel.historicalContext}\n`;
    }

    if (intel.sources && intel.sources.length) {
      msg += `\n🔗 *Sources*\n`;
      intel.sources.slice(0, 3).forEach(s => {
        msg += `• [${s.title || s.publisher}](${s.url})\n`;
      });
    }

    if (intel.analysisDisclaimer) {
      msg += `\n_${intel.analysisDisclaimer}_`;
    }

    if (intel.updatedAt) {
      msg += `\n\n_Updated: ${new Date(intel.updatedAt).toUTCString()}_`;
    }

    await ctx.editMessageText(msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: `intel_${marketId}` }],
        [{ text: '⬅️ Back to Market', callback_data: `mkt_${marketId}` }],
      ]},
    });
  } catch (err) {
    console.error('ERROR intel:', err.message);
    await ctx.answerCbQuery('Error', true);
  }
});
