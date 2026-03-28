# Vault for Actual

[![TestFlight](https://img.shields.io/badge/TestFlight-Join%20Beta-blue)](https://testflight.apple.com/join/yw3heBpF)

**[Download on TestFlight](https://testflight.apple.com/join/yw3heBpF)**

A personal finance iOS app for [Actual Budget](https://actualbudget.org) users. View your spending, trends, debt payoff, bill calendar, and AI financial coaching — all from your iPhone, connected to your own self-hosted server.

Built with Claude. Made for myself, sharing with the community.

---

## What it does

- **Spending Insights** — income, spending, net balance, top categories at a glance
- **AI Financial Coach** — asks questions about your real spending data, powered by OpenRouter
- **Debt Tracker** — snowball or avalanche payoff strategy with payoff date estimates
- **Bill Calendar** — recurring charges mapped to a calendar
- **Merchant Insights** — top merchants by spend and frequency
- **6-Month Trends** — income vs spending over time
- **Financial Health Score** — priorities and alerts based on your data

---

## Requirements

- iPhone running iOS 16 or later
- A self-hosted [Actual Budget](https://actualbudget.org) instance
- A server to run the Vault backend (same machine as Actual Budget works fine)
- Node.js 18 or later
- An [OpenRouter](https://openrouter.ai) API key for AI features (optional, free tier available)

---

## Backend Setup

The app connects to a small Node.js backend that talks to your Actual Budget instance. You need to run this on your own server.

### 1. Clone or download the backend

```bash
mkdir vault-backend
cd vault-backend
```

Download `server.js` from this repository and place it in the folder.

### 2. Install dependencies

```bash
npm init -y
npm install express cors dotenv @actual-app/api node-fetch@2
```

### 3. Create your .env file

```bash
nano .env
```

Add the following — replace with your own values:

```
PORT=3000
ACTUAL_BASE_URL=http://your-actual-budget-url:5006
ACTUAL_PASSWORD=your-actual-budget-password
ACTUAL_SYNC_ID=your-budget-sync-id
OPENROUTER_API_KEY=sk-or-your-key-here
```

> **Note:** The AI model is selected inside the app under Settings → AI Coach. You do not need to set it here.

**Where to find your Sync ID:**
- Open Actual Budget in your browser
- Go to Settings → Show advanced settings
- Copy the Sync ID

### 4. Start the server

```bash
node server.js
```

Or with pm2 to keep it running:

```bash
npm install -g pm2
pm2 start server.js --name vault-backend
pm2 save
pm2 startup
```

### 5. Test it

```bash
curl http://localhost:3000/health
```

You should see a JSON response confirming the backend is running.

---

## Connecting the App

1. Download Vault for Actual from TestFlight (link in README or Reddit post)
2. Open the app
3. On the setup screen enter your server URL:
   - Local network: `http://192.168.1.x:3000`
   - Remote access via Tailscale: `http://100.x.x.x:3000`
   - Any publicly accessible URL works
4. Tap **Test & Connect**
5. Done — your data loads automatically

---

## AI Features

The AI coach is optional. To enable it:

1. Get a free API key at [openrouter.ai](https://openrouter.ai)
2. Open the app → Settings → AI Coach
3. Paste your API key
4. Choose a model (free models available)

Your spending data is sent to OpenRouter to generate responses. Nothing is stored by Vault. See the [privacy policy](https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html) for details.

---

## Remote Access

To use the app outside your home network you have a few options:

- **Tailscale** (recommended) — free, easy, secure VPN. Install on your server and iPhone and use the Tailscale IP as your server URL.
- **Cloudflare Tunnel** — free, no port forwarding needed
- **Port forwarding** — open port 3000 on your router (less secure)

---

## Privacy

- Your financial data never passes through any servers operated by this app
- All data flows directly between your iPhone and your own server
- No analytics, no tracking, no ads
- The developer cannot see your data

Full privacy policy: [https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html](https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html)

---

## Feedback

This was built for personal use and shared with the Actual Budget community. If you find bugs or have ideas for improvements open an issue or reach out at filet.eidola.8x@icloud.com.

Currently working on automatic transaction syncing so you don't have to manually sync in Actual Budget.
