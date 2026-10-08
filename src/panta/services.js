const { pantaClient } = require('./client');
const FormData = require('form-data');
const axios = require('axios');

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

async function getMarket(marketId, retries = 1) {
  try {
    const response = await pantaClient.get(`/markets/${marketId}/`);
    return response.data;
  } catch (e) {
    if (retries > 0) return getMarket(marketId, retries - 1);
    throw e;
  }
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

let _primCache = { at: 0, markets: [] };
let _secCache = { at: 0, markets: [] };
const CACHE_MS = 90 * 1000;

async function getPrimaryMarkets() {
  const now = Date.now();
  if (now - _primCache.at < CACHE_MS && _primCache.markets.length) return _primCache.markets;

  const list = await listMarketsByStatus('primary', 50).catch(() => []);
  const details = await mapLimit(list, 8, (m) => getMarket(m.marketId, 2));
  const out = [];
  list.forEach((m, i) => {
    const s = shape(details[i], m);
    if (s.question && s.bettable && s.yesPrice != null) out.push(s);
  });
  if (out.length) _primCache = { at: now, markets: out };
  return out;
}

async function getSecondaryMarkets(need = 12) {
  const now = Date.now();
  if (now - _secCache.at < CACHE_MS && _secCache.markets.length) return _secCache.markets;

  const list = await listMarketsByStatus('secondary', 50).catch(() => []);
  const out = [];
  for (let i = 0; i < list.length && out.length < need; i += 10) {
    const batch = list.slice(i, i + 10);
    const details = await mapLimit(batch, 10, (m) => getMarket(m.marketId, 1));
    for (let k = 0; k < batch.length; k++) {
      const s = shape(details[k], batch[k]);
      if (s.question && s.tradeable) out.push(s);
      if (out.length >= need) break;
    }
  }
  if (out.length) _secCache = { at: now, markets: out };
  return out;
}

async function getLiveMarkets(want = 20) {
  const [prim, sec] = await Promise.all([
    getPrimaryMarkets().catch(() => []),
    getSecondaryMarkets(12).catch(() => []),
  ]);
  return [...prim, ...sec].slice(0, want);
}

// DISPLAY ONLY — used when a user taps a market card. Prefers the data we
// already fetched for the list (Panta's detail endpoint is inconsistent and
// can return an empty record moments later for the same market). Never used
// for the bet itself — quotePrimaryBuy below always calls Panta fresh.
async function getCachedMarket(marketId) {
  const cached = [..._primCache.markets, ..._secCache.markets].find(m => m.marketId === marketId);
  if (cached && cached.question) return cached;
  try {
    const d = await getMarket(marketId, 2);
    const s = shape(d, { marketId });
    return s.question ? s : (cached || s);
  } catch (_) {
    return cached || null;
  }
}

// Upload an image to Cloudinary via Panta's signed upload endpoint.
// imageBuffer: a Buffer of the image bytes.
// Returns the Cloudinary secure_url to use as imageUrl in the market quote.
async function uploadMarketImage(imageBuffer, filename) {
  // Step 1: get signed upload fields from Panta
  const sigRes = await pantaClient.post('/markets/create/image-upload/', {});
  const { uploadUrl, fields } = sigRes.data;

  // Step 2: build multipart form with signed fields + image file
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
  form.append('file', imageBuffer, { filename: filename || 'market.jpg', contentType: 'image/jpeg' });

  // Step 3: POST directly to Cloudinary (image bytes never go through Panta)
  const uploadRes = await axios.post(uploadUrl, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return uploadRes.data.secure_url;
}

// Check whether a market has resolved and which side won.
// Returns { resolved: boolean, yesWins: boolean|null }.
async function checkMarketResult(marketId) {
  try {
    const m = await getMarket(marketId, 2);
    if (m && m.resolved && m.status === 'resolved') {
      return { resolved: true, yesWins: !!m.yesWins };
    }
    return { resolved: false, yesWins: null };
  } catch (_) {
    return { resolved: false, yesWins: null };
  }
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

// LIVE — always called fresh at bet time. Never cached. This is what
// determines the real price and shares the user actually gets.
async function quotePrimaryBuy({ wallet, marketId, side, amountUsdc, userId }, retries = 2) {
  try {
    const response = await pantaClient.post('/primaryorderquote/', { wallet, marketId, side, amountUsdc, userId });
    return response.data;
  } catch (e) {
    const code = e.response?.data?.code;
    if (retries > 0 && code === 'INVALID_MARKET_PARAMS') {
      await new Promise(r => setTimeout(r, 800));
      return quotePrimaryBuy({ wallet, marketId, side, amountUsdc, userId }, retries - 1);
    }
    throw e;
  }
}

async function buildPrimaryBuy({ quoteId, wallet, userId, maxSlippageBps }) {
  const response = await pantaClient.post('/primaryorderbuild/', { quoteId, wallet, userId, maxSlippageBps: maxSlippageBps || 100 });
  return response.data;
}

async function submitPrimaryBuy({ orderId, signature, wallet }) {
  const response = await pantaClient.post('/primaryordersubmit/', { orderId, signature, wallet });
  return response.data;
}

async function verifyPrimaryBuy({ orderId, signature, wallet }) {
  const payload = { orderId };
  if (signature) payload.signature = signature;
  if (wallet) payload.wallet = wallet;
  const response = await pantaClient.post('/primaryorderverify/', payload);
  return response.data;
}

// Fetch markets created by this API account.
// Returns only 'registered' ones — those are real live markets.
async function getAccountCreates() {
  const response = await pantaClient.get('/account/creates/');
  const items = response.data.items || [];
  return items.filter(m => m.status === 'registered');
}

// Build a creator fee claim for a graduated market.
// wallet: creator address, marketId: the market PDA
async function buildCreatorFeeClaim({ wallet, marketId }) {
  const response = await pantaClient.post('/claim/creator-fees/', { wallet, marketId });
  return response.data;
}

// Build a win claim transaction for a resolved market.
// wallet: claimant address, marketId: the market's PDA, outcome: 'YES' or 'NO'
async function buildWinClaim({ wallet, marketId, outcome }) {
  const response = await pantaClient.post('/claim/build/', { wallet, marketId, outcome });
  return response.data;
}

module.exports = {
  SITE_BASE,
  getAccountInfo,
  listMarketsByStatus,
  getCategories,
  getMarket,
  getPrimaryMarkets,
  getSecondaryMarkets,
  getLiveMarkets,
  getCachedMarket,
  checkMarketResult,
  uploadMarketImage,
  buildWinClaim,
  buildCreatorFeeClaim,
  getAccountCreates,
  getPositions,
  quoteMarket,
  buildCreateTransaction,
  registerMarket,
  quotePrimaryBuy,
  buildPrimaryBuy,
  submitPrimaryBuy,
  verifyPrimaryBuy,
};
