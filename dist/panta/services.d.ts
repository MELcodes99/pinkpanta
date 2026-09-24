export interface AccountInfo {
    userId: string;
    email: string;
    name: string;
    status: string;
    canCreateMarkets: boolean;
    createdAt: string;
}
export interface Market {
    id: string;
    title: string;
    description?: string;
    creator: string;
    status: string;
    expiresAt: string;
    prices: {
        YES: string;
        NO: string;
    };
    volume: string;
}
export interface Position {
    marketId: string;
    outcome: 'YES' | 'NO';
    shares: string;
    value: string;
}
export declare function getAccountInfo(): Promise<AccountInfo>;
export declare function listMarkets(limit?: number): Promise<Market[]>;
export declare function getMarket(marketId: string): Promise<Market>;
export declare function getPositions(wallet: string): Promise<Position[]>;
export declare function createMarketQuote(title: string, description: string, expiresAt: string, feeUSDC: string): Promise<any>;
export declare function orderQuote(marketId: string, outcome: 'YES' | 'NO', amount: string): Promise<any>;
declare const _default: {
    getAccountInfo: typeof getAccountInfo;
    listMarkets: typeof listMarkets;
    getMarket: typeof getMarket;
    getPositions: typeof getPositions;
    createMarketQuote: typeof createMarketQuote;
    orderQuote: typeof orderQuote;
};
export default _default;
//# sourceMappingURL=services.d.ts.map