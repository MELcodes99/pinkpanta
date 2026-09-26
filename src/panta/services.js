const { pantaClient } = require('./client');

// ========== READ ENDPOINTS ==========

async function getAccountInfo() {
  const response = await pantaClient.get('/account/');
  return response.data;
}

async function listMarkets({ category = null, limit = 50, cursor = null } = {}) {
  const params = { limit };
  if (category) params.category = category;
  if (cursor) params.cursor = cursor;
  const response = await pantaClient.get('/markets/', { params });
  return {
    items: response.data.items || [],
    nextCursor: response.data.nextCursor || null,
  };
}

async function listOpenMarkets(category, want = 10) {
  const open = [];
  let cursor = null;
  let pages = 0;
  while (open.length < want && pages < 5) {
    const { items, nextCursor } = await listMarkets({ category, limit: 50, cursor });
    for (const m of items) {
      if (m.phase === 'primary' && m.status === 'open') open.push(m);
      if (open.length >= want) break;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
    pages++;
  }
  return open;
}

async function getCategories() {
  const response = await pantaClient.get('/categories/');
  return response.data.categories || [];
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

async function quoteMarket({ wallet, question, resolutionRule, sourcesOfTruth, category, startTime, endTime, resolutionTime, title, description, imageUrl, region }) {
  const payload = {
    wallet, question, resolutionRule, sourcesOfTruth, category,
    startTime, endTime, resolutionTime, marketType: 'standard',
    title, description, imageUrl, region: region || 'Global',
  };
  const response = await pantaClient.post('/markets/create/quote/', payload);
  return response.data;
}

async function buildCreateTransaction({ createId, wallet }) {
  const response = await pantaClient.post('/markets/create/build/', { createId, wallet });
  return response.data;
}

async function registerMarket({ createId, signature }) {
  const response = await pantaClient.post('/markets/create/register/', { createId, signature });
  return response.data;
}

// ========== PRIMARY BUY / BETTING (quote -> build -> submit -> verify) ==========

async function quotePrimaryBuy({ wallet, marketId, side, amountUsdc, userId }) {
  const response = await pantaClient.post('/primaryorder/quote/', { wallet, marketId, side, amountUsdc, userId });
  return response.data;
}

async function buildPrimaryBuy({ quoteId, wallet, userId, maxSlippageBps }) {
  const response = await pantaClient.post('/primaryorder/build/', { quoteId, wallet, userId, maxSlippageBps: maxSlippageBps || 100 });
  return response.data;
}

async function submitPrimaryBuy({ orderId, signature, wallet }) {
  const response = await pantaClient.post('/primaryorder/submit/', { orderId, signature, wallet });
  return response.data;
}

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
  listOpenMarkets,
  getCategories,
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
