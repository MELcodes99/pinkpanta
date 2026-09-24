const axios = require('axios');
require('dotenv').config();

async function test() {
  try {
    const response = await axios.get(
      'https://live-api.panta.market/api/v1/account/',
      {
        headers: {
          'X-Api-Key': process.env.PANTA_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✓ Connection successful! Account info:');
    console.log(response.data);
  } catch (error) {
    console.error('✗ Failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

test();
