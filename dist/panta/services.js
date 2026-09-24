"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccountInfo = getAccountInfo;
exports.listMarkets = listMarkets;
exports.getMarket = getMarket;
exports.getPositions = getPositions;
exports.createMarketQuote = createMarketQuote;
exports.orderQuote = orderQuote;
const client_1 = require("./client");
// Account & Auth
async function getAccountInfo() {
    const response = await client_1.pantaClient.get('/account/');
    return response.data;
}
// Markets
async function listMarkets(limit = 20) {
    const response = await client_1.pantaClient.get('/markets/', {
        params: { limit },
    });
    return response.data.data;
}
async function getMarket(marketId) {
    const response = await client_1.pantaClient.get(`/markets/${marketId}/`);
    return response.data;
}
// Positions
async function getPositions(wallet) {
    const response = await client_1.pantaClient.get('/positions/', {
        params: { wallet },
    });
    return response.data.data;
}
// Market Creation (Quote Phase)
async function createMarketQuote(title, description, expiresAt, feeUSDC // e.g., "50000000" for 50 USDC
) {
    const response = await client_1.pantaClient.post('/markets/create/quote/', {
        title,
        description,
        expiresAt,
        feeUSDC,
    });
    return response.data; // { createId, paymentUsdc, ... }
}
// Order Quote (for buying YES/NO)
async function orderQuote(marketId, outcome, amount // e.g., "20.00"
) {
    const response = await client_1.pantaClient.post('/orders/quote/', {
        marketId,
        outcome,
        amount,
    });
    return response.data; // { orderId, price, total, ... }
}
exports.default = {
    getAccountInfo,
    listMarkets,
    getMarket,
    getPositions,
    createMarketQuote,
    orderQuote,
};
//# sourceMappingURL=services.js.map