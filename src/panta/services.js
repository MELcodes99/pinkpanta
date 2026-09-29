const { pantaClient } = require('./client');

const SITE_BASE = 'https://panta.market/market/';

async function getAccountInfo() {
  const response = await pantaClient.get('/account/');
  return response.data;
}

async function listMarketsByStatus(status, limit = 50) {
  const params = { limit };
  if (status) params.status = status;
  const response = await pantaClient.get('/markets/', { params });
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

function shape(detail, listItem) {
  const m = detail || {};
  const question = (m.question || m.title || '').trim();
  const isPrimary = m.phase === 'primary' && m.status === 'primary';
  const isSecondary = m.phase === 'secondary';
  const yes = isPrimary ? m.primaryYesPrice : null;
  const no = isPrimary ? m.primaryNoPrice : null;
  return {
    marketId: m.marketId || (listItem && listItem.marketId),
    category: m.category || (listItem && listItem.category),
    question,
    description: (m.description || '').trim(),
    resolutionRule: (m.resolutionRule || '').trim(),
    yesPrice: yes,
    noPrice: no,
    volumeUsdc: m.totalVolumeUsdc || m.volumeUsdc || '0',
    endTime: m.endTime,
    phase: m.phase,
    status: m.status,
    resolved: !!m.resolved,
    bettable: isPrimary && !!question,
    tradeable: isSecondary,
    url: SITE_BASE + (m.marketId || (listItem && listItem.marketId)),
  };
}

let _cache = { at: 0, markets: [] };
const CACHE_MS = 60 * 1000;

async function getLiveMarkets(want = 15) {
  const now = Date.now();
  if (now - _cache.at < CACHE_MS && _cache.markets.length) return _cache.markets.slice(0, want);

  const [primary, secondary] = await Promise.all([
    listMarketsByStatus('primary', 50).catch(() => []),
    listMarketsByStatus('secondary', 50).catch(() => []),
  ]);

  const primDetails = await mapLimit(primary.slice(0, 15), 5, (m) => getMarket(m.marketId));
  const secDetails = await mapLimit(secondary.slice(0, 15), 5, (m) => getMarket(m.marketId));

  const out = [];
  primary.slice(0, 15).forEach((m, i) => {
    const s = shape(primDetails[i], m);
    if (s.question && s.bettable && s.yesPrice != null) out.push(s);
  });
  secondary.slice(0, 15).forEach((m, i) => {
    const s = shape(secDetails[i], m);
    if (s.question && s.tradeable) out.push(s);
  });

  _cache = { at: now, markets: out };
  return out.slice(0, want);
}

async function getPositions(wallet) {
  const response = await pantaClient.get('/positions/', { params: { wallet } });
  return response.data.items || response.data;
}

async function quoteMarket({ wallet, question, resolutionRule, sourcesOfTruth, category, startTime, endTime, resolutionTime, title, description, imageUrl, region, marketType }) {
  const payload = {
    wallet, question, resolutionRule, sourcesOfTruth, category,
    startTime, endTime, resolutionTime,
    marketType: marketType || 'standard',
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
  SITE_BASE,
  getAccountInfo,
  listMarketsByStatus,
  getCategories,
  getMarket,
  getLiveMarkets,
  getPositions,
  quoteMarket,
  buildCreateTransaction,
  registerMarket,
  quotePrimaryBuy,
  buildPrimaryBuy,
  submitPrimaryBuy,
  verifyPrimaryBuy,
};
