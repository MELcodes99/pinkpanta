const { pantaClient } = require('./client');

async function getAccountInfo() {
  const response = await pantaClient.get('/account/');
  return response.data;
}

// List markets by status. Valid status: primary | secondary | resolved | cancelled.
async function listMarketsByStatus(status = 'primary', limit = 50) {
  const response = await pantaClient.get('/markets/', { params: { status, limit } });
  return response.data.items || [];
}

async function getCategories() {
  const response = await pantaClient.get('/categories/');
  return response.data.categories || [];
}

async function getMarket(marketId) {
  const response = await pantaClient.get(`/markets/${marketId}/`);
  return response.data;
}

// Fetch open (primary) markets, enrich each with detail (list returns empty
// titles; detail has the real question + rule + category), keep only ones with
// a real question and a live price.
async function getBettableMarkets(category = null, want = 12) {
  const primary = await listMarketsByStatus('primary', 50);
  const out = [];
  for (const m of primary) {
    if (out.length >= want) break;
    let detail;
    try { detail = await getMarket(m.marketId); } catch (_) { continue; }
    const question = (detail.question || detail.title || '').trim();
    if (!question) continue;
    const yes = detail.primaryYesPrice ?? m.primaryYesPrice;
    if (yes == null) continue;
    const cat = detail.category || m.category;
    if (category && cat !== category) continue;
    out.push({
      marketId: m.marketId,
      category: cat,
      question,
      description: (detail.description || '').trim(),
      resolutionRule: (detail.resolutionRule || '').trim(),
      yesPrice: yes,
      noPrice: detail.primaryNoPrice ?? m.primaryNoPrice,
      volumeUsdc: detail.totalVolumeUsdc || detail.volumeUsdc || m.volumeUsdc || '0',
      endTime: detail.endTime || m.endTime,
      phase: detail.phase || m.phase,
      status: detail.status || m.status,
    });
  }
  return out;
}

async function countBettableByCategory() {
  const primary = await listMarketsByStatus('primary', 50);
  const counts = {};
  for (const m of primary) {
    let detail;
    try { detail = await getMarket(m.marketId); } catch (_) { continue; }
    const question = (detail.question || detail.title || '').trim();
    const yes = detail.primaryYesPrice ?? m.primaryYesPrice;
    if (!question || yes == null) continue;
    const cat = detail.category || m.category;
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

async function getPositions(wallet) {
  const response = await pantaClient.get('/positions/', { params: { wallet } });
  return response.data.items || response.data;
}

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
  listMarketsByStatus,
  getBettableMarkets,
  countBettableByCategory,
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
