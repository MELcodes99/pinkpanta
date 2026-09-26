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

// ---- 60s cache for the bettable-markets list ----
let _cache = { at: 0, markets: [] };
const CACHE_MS = 60 * 1000;

// small helper: run promises with limited concurrency (avoid rate limits)
async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx]); }
      catch (_) { results[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetch open (primary) markets, enrich in parallel (limited concurrency) with
// detail to get the real question/price, keep only ones with a question + price.
// Cached for 60s so repeat opens are instant.
async function getBettableMarkets(category = null, want = 12) {
  const now = Date.now();
  if (now - _cache.at < CACHE_MS && _cache.markets.length) {
    return category ? _cache.markets.filter(m => m.category === category).slice(0, want)
                    : _cache.markets.slice(0, want);
  }

  const primary = await listMarketsByStatus('primary', 50);
  // enrich the first ~20 in parallel, 5 at a time
  const candidates = primary.slice(0, 20);
  const details = await mapLimit(candidates, 5, (m) => getMarket(m.marketId));

  const out = [];
  for (let k = 0; k < candidates.length; k++) {
    const m = candidates[k];
    const detail = details[k];
    if (!detail) continue;
    const question = (detail.question || detail.title || '').trim();
    if (!question) continue;
    const yes = detail.primaryYesPrice ?? m.primaryYesPrice;
    if (yes == null) continue;
    out.push({
      marketId: m.marketId,
      category: detail.category || m.category,
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

  _cache = { at: now, markets: out };
  return category ? out.filter(m => m.category === category).slice(0, want) : out.slice(0, want);
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
