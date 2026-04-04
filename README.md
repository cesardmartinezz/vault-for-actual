# Vault for Actual

[![TestFlight](https://img.shields.io/badge/TestFlight-Join%20Beta-blue)](https://testflight.apple.com/join/Dv5ueXqt) [![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B)](https://ko-fi.com/cesarmartinez70180)

**[Download on TestFlight](https://testflight.apple.com/join/Dv5ueXqt)** · **[Support on Ko-fi](https://ko-fi.com/cesarmartinez70180)**

A native iOS app for [Actual Budget](https://actualbudget.org) users. View your spending, trends, debt payoff, bill calendar, and get AI financial coaching — all from your iPhone, connected to your own self-hosted server.

Built with Claude. Made for myself, sharing with the community.

---

## What it does

- **Spending Insights** — income, spending, net balance, top categories at a glance
- **AI Financial Coach** — asks questions about your real data, updates budgets via chat, gives debt payoff timelines
- **Debt Tracker** — snowball or avalanche payoff strategy with payoff date estimates
- **Bill Calendar** — recurring charges mapped to a calendar
- **Merchant Insights** — top merchants by spend and frequency
- **6-Month Trends** — income vs spending over time
- **Financial Health Score** — priorities and alerts based on your data
- **PDF Export** — monthly summary you can save or share
- **Locked Categories** — tell the AI which expenses are fixed so it never suggests cutting them

---

## Requirements

- iPhone running iOS 16 or later
- A self-hosted [Actual Budget](https://actualbudget.org) instance
- Docker installed on your server
- An [OpenRouter](https://openrouter.ai) API key for AI features (optional, free tier available)

---

## How it works

```
iPhone App → Vault Backend (:3000) → actual-http-api (:5008) → Actual Budget (:5006)
```

You run two small services alongside your existing Actual Budget:
1. **actual-http-api** — a Docker container that wraps Actual Budget with a REST API
2. **Vault backend** — a small Node.js server that powers the app's features

---

## Backend Setup

### Step 1 — Run actual-http-api

Run this Docker command on the same server as your Actual Budget. Replace the values with your own:

```bash
docker run -d \
  --name actualhttpapi \
  --restart unless-stopped \
  -p 5008:5007 \
  -e ACTUAL_SERVER_URL="http://YOUR_ACTUAL_BUDGET_IP:5006/" \
  -e ACTUAL_SERVER_PASSWORD="your-actual-budget-password" \
  -e API_KEY="any-strong-secret-you-make-up" \
  jhonderson/actual-http-api:26.3.0
```

> **Replace `26.3.0`** with your Actual Budget version number. Check it in Actual Budget → Settings.

> **Umbrel users:** Add `--network umbrel_main_network` and use `sudo docker run ...` so the container can reach Actual Budget.

> **The `API_KEY`** is a secret you invent — any strong string works. You'll use it in your `.env` file.

Test it worked:
```bash
curl -H "x-api-key: your-api-key" \
  "http://localhost:5008/v1/budgets/YOUR_SYNC_ID/accounts"
```
You should see a list of your accounts.

---

### Step 2 — Set up the Vault backend

Create a folder and download `server.js` from this repository:

```bash
mkdir vault-backend
cd vault-backend
# Download server.js from this repo and place it here
```

Install dependencies:
```bash
npm init -y
npm install express cors dotenv node-fetch@2
```

---

### Step 3 — Create your .env file

```bash
nano .env
```

Add the following — replace with your own values:

```
PORT=3000
ACTUAL_HTTP_API_URL=http://localhost:5008
ACTUAL_HTTP_API_KEY=your-api-key-from-step-1
ACTUAL_SYNC_ID=your-budget-sync-id
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

**Where to find your Sync ID:**
Open Actual Budget in your browser → Settings → Show advanced settings → Sync ID

---

### Step 4 — Start the backend

```bash
sudo npm install -g pm2
pm2 start server.js --name vault-backend
pm2 save
pm2 startup
```

---

### Step 5 — Test it

```bash
curl http://localhost:3000/health
```

You should see `"backend":"ok"` with `"hasSyncId":true` and `"hasApiKey":true`.

---

## Connecting the App

1. Download from TestFlight
2. Open the app — you'll see the setup screen
3. Enter your **Vault backend URL** (not your Actual Budget URL):
   - Local network: `http://192.168.1.x:3000`
   - Tailscale: `http://100.x.x.x:3000`
4. Tap **Test & Connect**
5. Follow the setup wizard — it detects your income sources and fixed expenses automatically

> The URL must end in `:3000` and point to the Vault backend — not your Actual Budget URL.

---

## AI Features

1. Get a free API key at [openrouter.ai](https://openrouter.ai)
2. Open the app → Settings → AI Coach → paste your key
3. Choose a model (free models available)

Try asking:
- "Set my grocery budget to $500"
- "When will I be debt free?"
- "What should I cut this month?"
- "Based on my last 3 months, set reasonable budgets"

---

## Remote Access

- **Tailscale** (recommended) — free, secure VPN. Install on server and iPhone, use Tailscale IP.
- **Cloudflare Tunnel** — free, no port forwarding needed
- **Port forwarding** — open port 3000 on your router

---

## Common Issues

**"Authentication failed: network-failure"**
The `actualhttpapi` container can't reach Actual Budget. Make sure both are on the same Docker network (`--network umbrel_main_network` for Umbrel).

**actual-http-api version mismatch**
Use the same version tag as your Actual Budget Docker image (e.g. `26.3.0`).

**Port already in use**
Change the host port (e.g. `-p 5009:5007`) and update `ACTUAL_HTTP_API_URL` in `.env` to match.

**App shows "Could not connect" after entering URL**
Make sure the URL ends in `:3000` and points to your Vault backend — not your Actual Budget URL (which ends in `:5006` or similar).

**App crashes or gets stuck after wrong URL**
Go to Settings → Reset Server, then re-enter the correct URL.

---

## Upgrading from v1.0

The backend has changed significantly in v1.1. You need to:

1. Run the `actual-http-api` Docker container (Step 1 above)
2. Replace your old `server.js` with the new one from this repo
3. Update your `.env` — remove `ACTUAL_BASE_URL` and `ACTUAL_PASSWORD`, add `ACTUAL_HTTP_API_URL` and `ACTUAL_HTTP_API_KEY`
4. Restart: `pm2 restart vault-backend --update-env`

---

## Privacy

- Your financial data flows directly between your iPhone and your own server
- No data passes through any servers operated by this app
- No analytics, no tracking, no ads

Full privacy policy: [https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html](https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html)

---

## Credits

- [actual-http-api](https://github.com/jhonderson/actual-http-api) by jhonderson — the REST wrapper that makes this app possible. Huge thanks for building and maintaining it.

---

## Feedback

Built for personal use and shared with the Actual Budget community. Open an issue or reach out at filet.eidola.8x@icloud.com.
