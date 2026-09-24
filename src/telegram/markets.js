const { createMarketQuote } = require('../panta/services');
const { createMarket, getOrCreateUser } = require('../db/queries');

async function handleCreateCommand(ctx) {
  const args = ctx.message.text.split(' ').slice(1).join(' ');

  if (!args) {
    ctx.reply(
      'Usage: /create "Market Title" "Description"\n\n' +
      'Example: /create "Will Bitcoin hit $100k by Dec 2026?" "Resolve YES if BTC price reaches $100k"'
    );
    return;
  }

  // Parse quoted arguments
  const matches = args.match(/"([^"]*)"/g);
  if (!matches || matches.length < 2) {
    ctx.reply('Please provide title and description in quotes: /create "title" "description"');
    return;
  }

  const title = matches[0].slice(1, -1);
  const description = matches[1].slice(1, -1);

  try {
    const user = getOrCreateUser(ctx.from.id, ctx.from.username || ctx.from.first_name);

    // Set market expiration to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    ctx.reply(
      `Creating market...\n\nTitle: ${title}\n` +
      `Description: ${description}\n` +
      `Expires: ${expiresAt.toDateString()}\n\n` +
      `Fee: 50 USDC\n\n` +
      `Processing...`
    );

    // Call Panta to create market (50 USDC fee)
    const quote = await createMarketQuote(
      title,
      description,
      expiresAt.toISOString(),
      '50000000' // 50 USDC in base units
    );

    // Save to database
    createMarket(
      quote.marketId,
      user.id,
      title,
      description,
      ctx.chat?.id || null,
      expiresAt.toISOString()
    );

    ctx.reply(
      `Market created!\n\n` +
      `Market ID: ${quote.marketId}\n` +
      `Title: ${title}\n` +
      `Status: Ready for trading\n\n` +
      `Share this market with your group!`
    );
  } catch (error) {
    console.error('Market creation error:', error.message);
    ctx.reply(`Failed to create market: ${error.message}`);
  }
}

module.exports = { handleCreateCommand };
