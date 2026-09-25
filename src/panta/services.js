const { pantaClient } = require('./client');

// ========== READ ENDPOINTS ==========

async function getAccountInfo() {
  const response = await pantaClient.get('/account/');
  return response.data;
}

async function listMarkets(limit = 20) {
  const response = await pantaClient.get('/markets/', { params: { limit } });
  return response.data.items || [];
}

async function getMarket(marketId) {
  const response = await pantaClient.get(`/markets/${marketId}/`);
  return response.data;
}

async function getPositions(wallet) {
  const response = await pantaClient.get('/positions/', { params: { wallet } });
  return response.data.items || response.data;
}

// ========== MARKET CREATION (quote -> build -> register) ==========

// Step 1: Quote a market. Times are unix SECONDS.
async function quoteMarket({ wallet, question, resolutionRule, sourcesOfTruth, category, startTime, endTime, resolutionTime, title, description, imageUrl, region }) {
  const payload = {
    wallet,
    question,
    resolutionRule,
    sourcesOfTruth,
    category,
    startTime,
    endTime,
    resolutionTime,
    marketType: 'standard',
    title,
    description,
    imageUrl,
    region: region || 'Global',
  };
  const response = await pantaClient.post('/markets/create/quote/', payload);
  return response.data;
}

// Step 2: Build the unsigned create transaction (returns base64 VersionedTransaction).
async function buildCreateTransaction({ createId, wallet }) {
  const payload = { createId, wallet };
  const response = await pantaClient.post('/markets/create/build/', payload);
  return response.data;
}

// Step 3: Register the market after broadcast (signature = base58 tx sig).
async function registerMarket({ createId, signature }) {
  const payload = { createId, signature };
  const response = await pantaClient.post('/markets/create/register/', payload);
  return response.data;
}

// ========== PRIMARY BUY / BETTING (quote -> build -> submit -> verify) ==========

// Step 1: Quote a primary buy. amountUsdc human-readable ("20.00"). side = 'yes' | 'no'.
async function quotePrimaryBuy({ wallet, marketId, side, amountUsdc, userId }) {
  const payload = { wallet, marketId, side, amountUsdc, userId };
  const response = await pantaClient.post('/primaryorder/quote/', payload);
  return response.data;
}

// Step 2: Build the unsigned primary buy (returns instruction list + blockhash).
async function buildPrimaryBuy({ quoteId, wallet, userId, maxSlippageBps }) {
  const payload = { quoteId, wallet, userId, maxSlippageBps: maxSlippageBps || 100 };
  const response = await pantaClient.post('/primaryorder/build/', payload);
  return response.data;
}

// Step 3: Submit the broadcast signature.
async function submitPrimaryBuy({ orderId, signature, wallet }) {
  const payload = { orderId, signature, wallet };
  const response = await pantaClient.post('/primaryorder/submit/', payload);
  return response.data;
}

// Step 4: Verify order status (built | submitted | confirmed | failed | expired).
async function verifyPrimaryBuy({ orderId, signature, wallet }) {
  const payload = { orderId };
  if (signature) payload.signature = signature;
  if (wallet) payload.wallet = wallet;
  const response = await pantaClient.post('/primaryorder/verify/', payload);
  return response.data;
}

module.exports = {
  getAccountInfo,
  listMarkets,
  getMarket,
  getPositions,
  quoteMarket,
  buildCreateTransaction,
  registerMarket,
  quotePrimaryBuy,
  buildPrimaryBuy,
  submitPrimaryBuy,
  verifyPrimaryBuy,
};
