const { pantaClient } = require('./panta/client');

async function debug() {
  try {
    console.log('Raw markets response:');
    const response = await pantaClient.get('/markets/', {
      params: { limit: 5 },
    });
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

debug();
