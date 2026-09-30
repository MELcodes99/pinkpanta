# PinkPanta

> Telegram prediction market bot powered by Panta, live on Solana mainnet.

PinkPanta lets anyone create and bet on prediction markets directly inside Telegram — no wallets to set up, no browser extensions, no leaving the chat. The bot handles everything: custodial Solana wallets, on-chain transactions, and real-time market data from Panta's API.

Built for the [Colosseum Crypto World's Fair Hackathon](https://arena.colosseum.org) and the Panta Sidetrack ($5k USDG).

**Live bot:** [@pinkpanta_bot](https://t.me/pinkpanta_bot)

---

## What it does

### Browse live markets
`/markets` — shows all open prediction markets on Panta in real time. Primary-phase markets (the ones the API can bet on) appear with their current YES% price. Secondary/P2P markets appear with a direct link to trade on panta.market.

### Bet on primary markets
Tap any primary market, choose YES or NO, enter an amount in USDC, and the bot signs and broadcasts a real Solana transaction on your behalf. The full primary-buy pipeline runs inside Telegram:

Quote → Build → Sign → Broadcast → Submit → Verify


No approval popups, no wallet extensions — the bot holds an encrypted keypair for each user and signs transparently.

### Create prediction markets
`/createmarket` — works in private chat or inside a group. A 6-step guided flow:

1. Title
2. Description
3. Category (Sports / Crypto / Finance / Science / World)
4. YES resolution condition
5. NO resolution condition
6. End date and time (UTC or WAT)

Choose Breaking ($20 USDC fee) or Standard ($50 USDC fee). After creation, the bot shows Bet YES / Bet NO buttons immediately so you can take the first position on your own market.

### Custodial wallets
Each Telegram user gets a dedicated Solana wallet generated and encrypted by the bot. Users can:
- View their SOL and USDC balances (live, from chain)
- Copy their wallet address to deposit
- Withdraw SOL or USDC to any external address
- View and export their private key
- Delete the wallet entirely

All wallet actions are restricted to private chat for security.

### Trader stats
My Bets shows:
- Total bets placed
- Total volume (USDC)
- Won / Lost counts
- Win rate %
- Full detail per bet: market title, side, amount, shares, avg price, end date, status

The bot checks each unresolved bet against Panta on demand and automatically updates statuses to Won or Lost when markets resolve.

---

## How it works

User (Telegram)
│
▼
PinkPanta Bot (Node.js + Telegraf)
│
├── Panta API (market data, order flow)
│ POST /primaryorderquote/
│ POST /primaryorderbuild/
│ POST /primaryordersubmit/
│ POST /primaryorderverify/
│
├── Solana RPC (Helius mainnet)
│ signAndSendInstructions
│ SOL + USDC balance checks
│
└── PostgreSQL (Render)
users, wallets (AES-256 encrypted), bets


### Betting flow (on-chain, confirmed)
Real confirmed transaction: `4VJTQYpktYj3ri5UzYzPC7jAoSqn419xi5y9t4zQJhPJjBGGY1veRvebvaD4wXE9QyYj23BhFdyrsVFaowBnuNVC`

Market: *Will a female housemate win Big Brother Naija Season 11?*
Side: YES | Amount: 1 USDC | Shares: 1.933151 | Avg Price: 0.517

---

## Tech stack

| Layer | Technology |
|---|---|
| Bot framework | Node.js + Telegraf |
| Prediction markets | Panta API (live-api.panta.market) |
| Blockchain | Solana mainnet via Helius RPC |
| Wallet security | AES-256-CBC encryption per user |
| Database | PostgreSQL (Render) |
| Hosting | Render |

---

## Commands

| Command | Works in | Description |
|---|---|---|
| `/start` | Private | Open wallet and main menu |
| `/wallet` | Private | View balances, deposit, withdraw |
| `/markets` | Anywhere | Browse live markets and bet |
| `/createmarket` | Anywhere | Create a new prediction market |

---

## Security

- Wallet actions (view balance, withdraw, reveal key) only work in private chat. Any attempt in a group is blocked.
- Private keys are encrypted with AES-256-CBC before storage. The encryption key is an environment variable never committed to code.
- Users can delete their wallet and all associated data at any time.
- Bet quotes are always fetched live from Panta at the moment of confirmation — never from cache. Only display data (market lists) uses a 90-second cache.

---

## Running locally

```bash
git clone https://github.com/MELcodes99/pinkpanta.git
cd pinkpanta
npm install
```

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_token
PANTA_API_KEY=pk_live_...
PANTA_API_BASE_URL=https://live-api.panta.market/api/v1
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
ENCRYPTION_KEY=32_char_hex_key
DATABASE_URL=postgres://...
BOT_USERNAME=pinkpanta_bot
DEFAULT_MARKET_IMAGE=https://raw.githubusercontent.com/MELcodes99/pinkpanta/main/assets/pinkpanta.jpeg
```

```bash
node src/index.js
```

---

## Built by

**Mel** ([@0xJedi](https://github.com/MELcodes99)) — smart contract security auditor, agent developer, Web3 builder based in Lagos, Nigeria.

---

*PinkPanta is built on Panta's public API v1. Secondary/P2P markets are displayed with a redirect to panta.market since the v1 API only supports primary-phase betting. Market creation requires USDC on Solana mainnet for the protocol fee.*
