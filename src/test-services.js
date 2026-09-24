const { getAccountInfo, listMarkets } = require('./panta/services');

async function test() {
  try {
    console.log('Fetching account info...');
    const account = await getAccountInfo();
    console.log('✓ Account:', account.name);

    console.log('\nFetching markets...');
    const markets = await listMarkets(5);
    console.log(`✓ Found ${markets.length} markets\n`);
    markets.forEach((m, i) => {
      console.log(`${i + 1}. ${m.title || m.category} (${m.marketId})`);
      console.log(`   Status: ${m.status} | Volume: ${m.volumeUsdc} USDC`);
    });
  } catch (error) {
    console.error('✗ Error:', error.message);
  }
}

test();
