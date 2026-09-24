const { pantaClient } = require('./client');

async function getAccountInfo() {
  const response = await pantaClient.get('/account/');
  return response.data;
}

async function listMarkets(limit = 20) {
  const response = await pantaClient.get('/markets/', {
    params: { limit },
  });
  // Panta returns { items: [...], nextCursor: ... }
  return response.data.items || [];
}

async function getMarket(marketId) {
  const response = await pantaClient.get(`/markets/${marketId}/`);
  return response.data;
}

async function getPositions(wallet) {
  const response = await pantaClient.get('/positions/', {
    params: { wallet },
  });
  return response.data.items || response.data;
}

module.exports = {
  getAccountInfo,
  listMarkets,
  getMarket,
  getPositions,
};
