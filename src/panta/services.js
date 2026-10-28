const axios = require('axios');

const PANTA_API_BASE = process.env.PANTA_API_BASE || 'https://live-api.panta.market/api/v1';
const PANTA_API_KEY = process.env.PANTA_API_KEY;
const SITE_BASE = 'https://panta.market/markets/';

const pantaClient = axios.create({
  baseURL: PANTA_API_BASE,
  headers: {
    'X-Api-Key': PANTA_API_KEY,
    'Content-Type': 'application/json',
  },
});

async function getAccountInfo(wallet) {
  const response = await pantaClient.get('/accounts/', { params: { wallet } });
  return response.data;
}

async function listMarketsByStatus(status = 'live') {
  const response = await pantaClient.get('/markets/', { params: { status } });
  return response.data;
}

async function getCategories() {
  const response = await pantaClient.get('/categories/');
  return response.data;
}

async function getMarket(marketId) {
  const response = await pantaClient.get(`/markets/${marketId}/`);
  return response.data;
}

const marketCache = {};
const CACHE_TTL = 60 * 1000;

async function getCachedMarket(marketId) {
  const now = Date.now();
  if (marketCache[marketId] && (now - marketCache[marketId].ts) < CACHE_TTL) {
    return marketCache[marketId].data;
  }
  const data = await getMarket(marketId);
  marketCache[marketId] = { data, ts: now };
  return data;
}

async function getPrimaryMarkets() {
  const response = await pantaClient.get('/markets/', { params: { status: 'primary' } });
  return response.data;
}

async function getSecondaryMarkets() {
  const response = await pantaClient.get('/markets/', { params: { status: 'secondary' } });
  return response.data;
}

async function getLiveMarkets(limit = 20) {
  try {
    const response = await pantaClient.get('/markets/?limit=200');
    const items = response.data.items || [];
    const active = items.filter(m =>
      m.status !== 'resolved' &&
      m.phase !== 'resolved' &&
      m.phase !== 'post_resolution'
    );
    const detailed = await Promise.all(
      active.map(m => getMarket(m.marketId).catch(() => m))
    );
    return detailed
      .filter(m => m.status !== 'resolved' && m.phase !== 'resolved' && m.phase !== 'post_resolution')
      .map(m => ({ ...m, bettable: m.phase === 'primary' || m.status === 'primary' }))
      .slice(0, limit);
  } catch (e) {
    return [];
  }
}

async function getLiveMarkets_DISABLED(limit = 20) {
  try {
    const [primary, secondary] = await Promise.all([
      getPrimaryMarkets().catch(() => ({ items: [] })),
      getSecondaryMarkets().catch(() => ({ items: [] })),
    ]);
    const primaryItems = (primary.items || []).map(m => ({ ...m, bettable: true }));
    const secondaryItems = (secondary.items || []).map(m => ({ ...m, bettable: false }));
    return [...primaryItems, ...secondaryItems].slice(0, limit);
  } catch (e) {
    return [];
  }
}

async function checkMarketResult(marketId) {
  try {
    const m = await getCachedMarket(marketId);
    if (m.status === 'resolved' || m.phase === 'resolved') {
      return { resolved: true, yesWins: m.outcome === 'yes' || m.result === 'yes' };
    }
    return { resolved: false };
  } catch (_) {
    return { resolved: false };
  }
}

async function uploadMarketImage(imageBuffer, filename = 'market.jpg') {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', imageBuffer, { filename, contentType: 'image/jpeg' });
  const response = await pantaClient.post('/markets/upload-image/', form, {
    headers: { ...form.getHeaders() },
  });
  return response.data.url || response.data.imageUrl;
}

async function quoteMarket(params) {
  const response = await pantaClient.post('/markets/quote/', params);
  return response.data;
}

async function buildCreateTransaction({ createId, wallet }) {
  const response = await pantaClient.post('/markets/build/', { createId, wallet });
  return response.data;
}

async function registerMarket({ createId, signature }) {
  const response = await pantaClient.post('/markets/register/', { createId, signature });
  return response.data;
}

async function quotePrimaryBuy({ wallet, marketId, side, amountUsdc, userId }) {
  const response = await pantaClient.post('/primary/quote/', { wallet, marketId, side, amountUsdc, userId });
  return response.data;
}

async function buildPrimaryBuy({ quoteId, wallet, userId, maxSlippageBps }) {
  const response = await pantaClient.post('/primary/build/', { quoteId, wallet, userId, maxSlippageBps });
  return response.data;
}

async function submitPrimaryBuy({ orderId, signature, wallet }) {
  const response = await pantaClient.post('/primary/submit/', { orderId, signature, wallet });
  return response.data;
}

async function verifyPrimaryBuy({ orderId }) {
  const response = await pantaClient.get('/primary/verify/', { params: { orderId } });
  return response.data;
}

async function buildWinClaim({ wallet, marketId, outcome }) {
  const response = await pantaClient.post('/claims/build/', { wallet, marketId, outcome });
  return response.data;
}

async function buildCreatorFeeClaim({ wallet, marketId }) {
  const response = await pantaClient.post('/claims/creator/', { wallet, marketId });
  return response.data;
}

async function getAccountCreates(wallet) {
  const response = await pantaClient.get('/accounts/creates/', { params: { wallet } });
  return response.data?.items || response.data || [];
}

async function getPositions(wallet) {
  const response = await pantaClient.get('/positions/', { params: { wallet } });
  return response.data?.items || response.data || [];
}

// ── Secondary market ──────────────────────────────────────────────────────────

async function getOrderBook(marketId, { side, intent, limit, cursor } = {}) {
  const params = { marketId };
  if (side) params.side = side;
  if (intent) params.intent = intent;
  if (limit) params.limit = limit;
  if (cursor) params.cursor = cursor;
  const response = await pantaClient.get('/secondary/listings/', { params });
  return response.data;
}

async function buildListShares({ wallet, marketId, side, price, shares, userId }) {
  const response = await pantaClient.post('/secondary/list/', { wallet, marketId, side, price, shares, userId });
  return response.data;
}

async function buildRestBid({ wallet, marketId, side, price, shares, userId }) {
  const response = await pantaClient.post('/secondary/bid/', { wallet, marketId, side, price, shares, userId });
  return response.data;
}

async function buildFillOrder({ wallet, marketId, listingId, shares, userId }) {
  const response = await pantaClient.post('/secondary/fill/', { wallet, marketId, listingId, shares, userId });
  return response.data;
}

async function buildCancelOrder({ wallet, marketId, listingId }) {
  const response = await pantaClient.post('/secondary/cancel/', { wallet, marketId, listingId });
  return response.data;
}

// ── Disputes ──────────────────────────────────────────────────────────────────

async function buildDispute({ wallet, marketId, reason, evidence, side }) {
  const response = await pantaClient.post(`/markets/${marketId}/dispute/build/`, {
    wallet, reason, evidence, side,
  });
  return response.data;
}

async function submitDispute({ marketId, disputeId, wallet, signature }) {
  const response = await pantaClient.post(`/markets/${marketId}/dispute/submit/`, {
    disputeId, wallet, signature,
  });
  return response.data;
}

async function getDisputeStatus({ marketId, wallet }) {
  const response = await pantaClient.get(`/markets/${marketId}/dispute/`, { params: { wallet } });
  return response.data;
}

// ── Panta Intelligence ────────────────────────────────────────────────────────

async function getMarketIntelligence(marketId) {
  const response = await pantaClient.get(`/markets/${marketId}/intelligence/`);
  return response.data;
}

module.exports = {
  SITE_BASE, getAccountInfo, listMarketsByStatus, getCategories, getMarket,
  getPrimaryMarkets, getSecondaryMarkets, getLiveMarkets, getCachedMarket,
  checkMarketResult, uploadMarketImage, buildWinClaim, buildCreatorFeeClaim,
  getAccountCreates, getPositions, quoteMarket, buildCreateTransaction,
  registerMarket, quotePrimaryBuy, buildPrimaryBuy, submitPrimaryBuy, verifyPrimaryBuy,
  getOrderBook, buildListShares, buildRestBid, buildFillOrder, buildCancelOrder,
  buildDispute, submitDispute, getDisputeStatus,
  getMarketIntelligence,
};
