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
  createBet, getUserBets, updateBetStatus, getWonBets,
} = require('./db/queries');
const { sendSolWithdrawal, sendUsdcWithdrawal } = require('./solana/withdrawal');
const {
  quoteMarket, buildCreateTransaction, registerMarket,
  quotePrimaryBuy, buildPrimaryBuy, submitPrimaryBuy, verifyPrimaryBuy,
  getLiveMarkets, getCachedMarket, checkMarketResult, uploadMarketImage, buildWinClaim, SITE_BASE,
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
    const q = m.question.length > 42 ? m.question.slice(0, 41) + '…' : m.question;
    const tag = m.bettable
      ? (m.yesPrice != null ? ` — YES ${Math.round(parseFloat(m.yesPrice) * 100)}%` : '')
      : ' 🔗';
    return [{ text: `${q}${tag}`, callback_data: `mkt_${m.marketId}` }];
  });

  const header = '📊 Live markets\n🟢 = bet here  |  🔗 = trade on Panta\n\nTap one:';
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
    if (!question) {
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
      msg += `\n\n🔗 This market is in secondary (P2P) trading. Trade it on Panta:`;
      keyboard.inline_keyboard.push([{ text: '🔗 Trade on Panta', url }]);
    } else {
      msg += `\n\n⚠️ This market is not open for betting.`;
    }
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

// Skip image — use default PinkPanta image
bot.action('mc_skip_image', async (ctx) => {
  if (!ctx.session.marketCreation) { await ctx.answerCbQuery('Session expired', true); return; }
  const mc = ctx.session.marketCreation;
  mc.imageUrl = null; // will fall back to DEFAULT_MARKET_IMAGE in quote
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
    const startTime = Math.floor(Date.now() / 1000);
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

    const quote = await quoteMarket({
      wallet,
      question: mc.title,
      resolutionRule,
      sourcesOfTruth,
      category,
      startTime,
      endTime,
      resolutionTime,
      title: mc.title,
      description: mc.description,
      imageUrl: mc.imageUrl || DEFAULT_MARKET_IMAGE,
      region: 'Global',
      marketType: mc.marketType || 'breaking',
    });

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n2/4 Building transaction...');
    const built = await buildCreateTransaction({ createId: quote.createId, wallet });

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n3/4 Signing & broadcasting...');
    const signature = await signAndSendBase64Tx(built.transaction, keypair);

    await ctx.editMessageText('⏳ Creating market on Panta...\n\n4/4 Registering market...');
    const registered = await registerMarket({ createId: quote.createId, signature });
    const marketId = registered.marketId;

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
      marketTitle: st.bet.title || null, marketEndTime: st.bet.endTime || null,
    });

    const betTitle = st.bet.title || 'market';

    await ctx.editMessageText(
      `✅ Bet Placed!\n\n📊 ${betTitle}\nSide: ${side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nShares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nStatus: ${finalStatus}\nTX: \`${signature}\``,
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

    const bets = await getUserBets(ctx.from.id);

    // Check unresolved bets against Panta and update their status.
    // Run in parallel so it doesn't block the display.
    await Promise.all(bets.map(async (b) => {
      if (b.status !== 'submitted') return;
      try {
        const result = await checkMarketResult(b.market_id);
        if (result.resolved) {
          const won = (b.side === 'yes' && result.yesWins) || (b.side === 'no' && !result.yesWins);
          await updateBetStatus(b.order_id, won ? 'won' : 'lost');
          b.status = won ? 'won' : 'lost';
        }
      } catch (_) {}
    }));

    // Compute stats
    const total = bets.length;
    const volume = bets.reduce((sum, b) => sum + parseFloat(b.amount_usdc || 0), 0);
    const won = bets.filter(b => b.status === 'won' || b.status === 'claimed').length;
    const lost = bets.filter(b => b.status === 'lost').length;
    const settled = won + lost;
    const winPct = settled > 0 ? Math.round((won / settled) * 100) : null;
    // PNL: rough estimate — winners get ~2x shares * avg_price back, losers lose stake
    const pnl = bets.reduce((sum, b) => {
      if (b.status === 'won' || b.status === 'claimed') {
        const profit = parseFloat(b.shares || 0) * parseFloat(b.avg_price || 0) - parseFloat(b.amount_usdc || 0);
        return sum + profit;
      } else if (b.status === 'lost') {
        return sum - parseFloat(b.amount_usdc || 0);
      }
      return sum;
    }, 0);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

    let msg = '📈 Your Bets\n\n';
    msg += '━━━━━━━━━━━━━━━\n';
    msg += `🎯 Total Bets: ${total}\n`;
    msg += `💰 Volume: $${volume.toFixed(2)} USDC\n`;
    msg += `✅ Won: ${won}  |  ❌ Lost: ${lost}\n`;
    msg += winPct !== null ? `📊 Win Rate: ${winPct}%\n` : `📊 Win Rate: — (no resolved bets yet)\n`;
    msg += `💹 PNL: ${pnlStr} USDC\n`;
    msg += '━━━━━━━━━━━━━━━\n\n';

    if (!bets.length) {
      msg += 'No bets yet. Use Browse Markets to place one.';
    } else {
      for (const b of bets.slice(0, 10)) {
        const title = b.market_title || b.market_id;
        const side = b.side === 'yes' ? 'YES ✅' : 'NO ❌';
        const statusEmoji = (b.status === 'won' || b.status === 'claimed') ? '🏆' : b.status === 'lost' ? '❌' : '⏳';
        const dateStr = b.market_end_time
          ? new Date(Number(b.market_end_time) * 1000).toUTCString().replace(' GMT', '')
          : null;
        msg += `${statusEmoji} ${title}\n`;
        msg += `   ${side} • $${b.amount_usdc} USDC • ${b.shares || '?'} shares\n`;
        if (dateStr) msg += `   ⏰ Ends: ${dateStr}\n`;
        const statusLabel = b.status === 'claimed' && b.signature
          ? `claimed ✅ | TX: ${b.signature.slice(0,20)}...`
          : b.status;
        msg += `   Status: ${statusLabel}\n\n`;
      }
    }

    const wonBets = bets.filter(b => b.status === 'won'); // 'claimed' already processed
    const keyboard = { inline_keyboard: [] };
    if (wonBets.length) {
      keyboard.inline_keyboard.push([{ text: `🏆 Claim Winnings (${wonBets.length} bet${wonBets.length > 1 ? 's' : ''})`, callback_data: 'claim_winnings' }]);
    }
    keyboard.inline_keyboard.push([{ text: '⬅️ Back', callback_data: 'start_menu' }]);

    await ctx.editMessageText(msg, { reply_markup: keyboard });
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

    let claimed = 0;
    let failed = 0;
    let totalMsg = '';

    for (const b of wonBets) {
      try {
        const outcome = b.side === 'yes' ? 'YES' : 'NO';
        const built = await buildWinClaim({ wallet, marketId: b.market_id, outcome });
        const signature = await signAndSendInstructions(built.instructions, built.recentBlockhash, keypair);
        await updateBetStatus(b.order_id, 'claimed');
        claimed++;
        const title = (b.market_title || b.market_id).slice(0, 40);
        totalMsg += `✅ ${title}\n   TX: \`${signature.slice(0,20)}...\`\n\n`;
      } catch (err) {
        failed++;
        console.error('Claim failed for bet', b.order_id, err.message);
      }
    }

    let resultMsg = `🏆 Claims Complete!\n\n`;
    resultMsg += `✅ Claimed: ${claimed}\n`;
    if (failed) resultMsg += `❌ Failed: ${failed}\n`;
    resultMsg += `\n${totalMsg}`;
    resultMsg += `💰 Winnings are now in your wallet.`;

    await ctx.editMessageText(resultMsg, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '💰 View Wallet', callback_data: 'view_wallet' }],
        [{ text: '⬅️ Back to My Bets', callback_data: 'my_bets' }],
      ]}
    });
  } catch (err) {
    console.error('ERROR claim_winnings:', err.message);
    await ctx.reply('❌ Something went wrong claiming your winnings. Please try again.');
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

// Handle photo uploads during market creation image step
bot.on('photo', async (ctx) => {
  const mc = ctx.session && ctx.session.marketCreation;
  if (!mc || mc.step !== 'image') return;
  try {
    await ctx.reply('⏳ Uploading your image...');
    // Get the largest photo size Telegram provides
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    // Download the image as a buffer
    const imgRes = await require('axios').get(fileLink.href, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imgRes.data);
    // Upload to Cloudinary via Panta
    const imageUrl = await uploadMarketImage(imageBuffer, 'market.jpg');
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
      reply_markup: { inline_keyboard: [
        [{ text: '⏭️ Skip (use default)', callback_data: 'mc_skip_image' }],
      ]}
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
      const betTitle = st.bet.title || 'this market';

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
          `✅ Confirm Bet\n\n📊 ${betTitle}\nSide: ${st.bet.side === 'yes' ? 'YES ✅' : 'NO ❌'}\nAmount: ${amount} USDC\nEst. Shares: ${quote.shares}\nAvg Price: ${quote.avgPrice}\nFee: ${quote.feeUsdc} USDC\n\nApprove to place your bet on-chain.`,
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

    if (ctx.session && ctx.session.marketCreation) {
      const mc = ctx.session.marketCreation;
      if (mc.step === 'title') {
        mc.title = text; mc.step = 'description';
        await ctx.reply('Step 2 of 5: Send the market DESCRIPTION');
        return;
      }
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
      if (mc.step === 'yesCondition') {
        mc.yesCondition = text.replace(/^this market will resolve yes if:?\s*/i, ''); mc.step = 'noCondition';
        await ctx.reply('Step 6 of 7: Complete this line —\n\n"This market will resolve NO if: ..."');
        return;
      }
      if (mc.step === 'noCondition') {
        mc.noCondition = text.replace(/^this market will resolve no if:?\s*/i, ''); mc.step = 'timezone';
        await ctx.reply('Step 7 of 7: Choose the timezone for the market END time:',
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
        mc.endTimeText = text;
        mc.step = 'markettype';

        await ctx.reply(
          'Choose the market type:\n\n⚡ Breaking — $20 USDC fee\n📊 Standard — $50 USDC fee\n\n(Both need a little SOL for gas)',
          { reply_markup: { inline_keyboard: [
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
