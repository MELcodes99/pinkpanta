"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pantaClient = void 0;
const axios_1 = __importDefault(require("axios"));
const PANTA_BASE_URL = process.env.PANTA_API_BASE_URL || 'https://live-api.panta.market/api/v1';
const PANTA_API_KEY = process.env.PANTA_API_KEY;
if (!PANTA_API_KEY) {
    throw new Error('PANTA_API_KEY not found in .env');
}
exports.pantaClient = axios_1.default.create({
    baseURL: PANTA_BASE_URL,
    headers: {
        'X-Api-Key': PANTA_API_KEY,
        'Content-Type': 'application/json',
    },
});
// Add error handler
exports.pantaClient.interceptors.response.use((response) => response, (error) => {
    if (error.response) {
        console.error(`Panta API Error: ${error.response.status}`, error.response.data);
    }
    return Promise.reject(error);
});
exports.default = exports.pantaClient;
//# sourceMappingURL=client.js.map