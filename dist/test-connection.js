"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function test() {
    try {
        const response = await axios_1.default.get('https://live-api.panta.market/api/v1/account/', {
            headers: {
                'X-Api-Key': process.env.PANTA_API_KEY,
                'Content-Type': 'application/json',
            },
        });
        console.log('Success! Account info:');
        console.log(response.data);
    }
    catch (error) {
        console.error('Failed:', error.response?.data || error.message);
    }
}
test();
//# sourceMappingURL=test-connection.js.map