const axios = require('axios');
require('dotenv').config();

const PANTA_BASE_URL = process.env.PANTA_API_BASE_URL || 'https://live-api.panta.market/api/v1';
const PANTA_API_KEY = process.env.PANTA_API_KEY;

if (!PANTA_API_KEY) {
  throw new Error('PANTA_API_KEY not found in .env');
}

const pantaClient = axios.create({
  baseURL: PANTA_BASE_URL,
  headers: {
    'X-Api-Key': PANTA_API_KEY,
    'Content-Type': 'application/json',
  },
});

pantaClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      console.error(`Panta API Error: ${error.response.status}`, error.response.data);
    }
    return Promise.reject(error);
  }
);

module.exports = { pantaClient };
