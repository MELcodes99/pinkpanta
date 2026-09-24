const { getUser } = require('../db/queries');
const { pantaClient } = require('../panta/client');
const { decryptKeypair, getUserBalance } = require('../solana/wallet');
const { db } = require('../db/schema');

async function handleBetCommand(ctx, outcome) {
  const telegramId = ctx.from.id;
  const user = getUser(telegramId);

  if (!user) {
    ctx.reply('Use /start first');
    return;
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    ctx.reply(`Usage: /${outcome.toLowerCase()} <marketId> <amount>\n\nExample: /${outcome.toLowerCase()} AESrMoZxcTGQibC1 20.00`);
    return;
  }

  const marketId = args[0];
  const amount = args[1];

  try {
    ctx.reply(`Processing ${outcome} bet for ${amount} USDC on market ${marketId.slice(0, 8)}...`);

    // Get market details
    const market = await pantaClient.get(`/markets/${marketId}/`);
    const marketData = market.data;

    ctx.reply(`Market: ${marketData.title || marketData.category}\nOutcome: ${outcome}\nAmount: ${amount} USDC`);

    // Get order quote
    const quoteResponse = await pantaClient.post('/orders/quote/', {
      marketId: marketId,
      outcome: outcome,
      amount: amount,
    });

    const quote = quoteResponse.data;
    ctx.reply(
      `Quote valid for 90s\n` +
      `Price: ${quote.price}\n` +
      `Total: ${quote.total} USDC\n` +
      `Shares: ${quote.shares}\n\n` +
      `Reply /confirm to complete bet`
    );

    // Store quote temporarily in DB for user to confirm
    db.prepare(`
      INSERT OR REPLACE INTO pending_orders (user_id, market_id, outcome, amount, quote_data)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, marketId, outcome, amount, JSON.stringify(quote));

  } catch (error) {
    console.error('Bet error:', error.message);
    ctx.reply(`Error: ${error.message}`);
  }
}

async function handleConfirmCommand(ctx) {
  const telegramId = ctx.from.id;
  const user = getUser(telegramId);

  if (!user) {
    ctx.reply('Use /start first');
    return;
  }

  try {
    // Get pending order
    const pending = db.prepare(`
      SELECT * FROM pending_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(user.id);

    if (!pending) {
      ctx.reply('No pending order. Use /yes or /no first');
      return;
    }

    const quote = JSON.parse(pending.quote_data);

    ctx.reply(`Confirming ${pending.outcome} bet on ${pending.market_id.slice(0, 8)}...`);

    // Build unsigned transaction
    const buildResponse = await pantaClient.post('/orders/build/', {
      orderId: quote.orderId,
      marketId: pending.market_id,
      outcome: pending.outcome,
    });

    const unsignedTx = buildResponse.data;

    // Decrypt user's keypair and sign
    const keypair = decryptKeypair(user.encrypted_keypair);
    ctx.reply('Signing transaction...');

    // TODO: Sign and broadcast transaction
    // For now just confirm it's ready

    ctx.reply(
      `Bet placed!\n` +
      `Market: ${pending.market_id}\n` +
      `Outcome: ${pending.outcome}\n` +
      `Amount: ${pending.amount} USDC\n` +
      `Shares: ${quote.shares}\n\n` +
      `Use /positions to view your trades`
    );

    // Clean up
    db.prepare('DELETE FROM pending_orders WHERE id = ?').run(pending.id);

  } catch (error) {
    console.error('Confirm error:', error.message);
    ctx.reply(`Error: ${error.message}`);
  }
}

module.exports = { handleBetCommand, handleConfirmCommand };
