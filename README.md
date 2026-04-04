# Vault for Actual

[![TestFlight](https://img.shields.io/badge/TestFlight-Join%20Beta-blue)](https://testflight.apple.com/join/Dv5ueXqt) [![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B)](https://ko-fi.com/cesarmartinez70180)

**[Download on TestFlight](https://testflight.apple.com/join/Dv5ueXqt)** · **[Support on Ko-fi](https://ko-fi.com/cesarmartinez70180)**

A native iOS app for [Actual Budget](https://actualbudget.org) that lets you check your spending, get AI financial advice, track debt, and more — all from your iPhone.

---

## What it does

- See your income, spending, and top categories at a glance
- Ask the AI things like "when will I be debt free?" or "set my grocery budget to $500"
- Track all your debts and get a payoff date estimate
- See recurring charges and subscriptions mapped to a calendar
- Export a monthly PDF summary
- Lock categories the AI should never suggest cutting (car payments, tuition, etc.)
- Works with your own self-hosted Actual Budget — your data never leaves your server

---

## What you need before starting

1. **An iPhone** running iOS 16 or later
2. **Actual Budget** already running on a home server, NAS, or VPS
3. **Docker** installed on that same server
4. An **OpenRouter API key** if you want AI features (free tier available at openrouter.ai — optional)

> Don't have Actual Budget yet? Start here: [actualbudget.org](https://actualbudget.org)

---

## How it works

The app talks to a small backend server you run yourself. That backend talks to Actual Budget on your behalf.

```
Your iPhone → Vault Backend → actual-http-api → Actual Budget
```

You need to run two things alongside your existing Actual Budget:
- **actual-http-api** — a free Docker container that wraps Actual Budget with a REST API
- **Vault backend** — a small Node.js server that powers all the AI features, analysis, and user preferences

> **Why not call actual-http-api directly?** The Vault backend is where all the intelligence lives — AI context building, 3 months of spending history, locked categories, debt tracking, recurring charge detection, smart prompts, and user preferences. It's not just a middleman, it's the brain of the app.

---

## Setup — Easy Way (Docker Compose) ⭐ Recommended

This is the easiest way to get started. If you have Docker installed you can be up and running in about 5 minutes.

**Before you start:** You need to be able to connect to your server via SSH (Terminal on Mac, PuTTY on Windows). If you're not sure how to do that, check your server's documentation.

---

**Step 1 — Connect to your server**

Open Terminal on your Mac (or PuTTY on Windows) and SSH into your server:

```bash
ssh username@your-server-ip
```

For example: `ssh admin@10.0.0.50`

---

**Step 2 — Create a folder on your server**

Once you're connected to your server, run:

```bash
mkdir vault-backend
cd vault-backend
```

---

**Step 3 — Download the files onto your server**

Run these two commands to download the files directly to your server:

```bash
curl -O https://raw.githubusercontent.com/cesardmartinezz/vault-for-actual/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/cesardmartinezz/vault-for-actual/main/server.js
```

---

**Step 4 — Edit the settings file**

Open the docker-compose.yml file in a text editor:

```bash
nano docker-compose.yml
```

You'll see the file open in your terminal. Find these 3 lines and replace the ALL CAPS values with your own:

| Find this | Replace with |
|-----------|-------------|
| `YOUR_ACTUAL_BUDGET_PASSWORD` | The password you use to log into Actual Budget in your browser |
| `YOUR_SECRET_KEY` | Make up any password — write it down, you'll need it later (e.g. `mysecretkey123`) |
| `YOUR_SYNC_ID` | Open Actual Budget in your browser → Settings → scroll down → copy the Sync ID |

Also find `26.3.0` and change it to match your Actual Budget version (check in Actual Budget → Settings).

When done press **Ctrl+X** then **Y** then **Enter** to save.

---

**Step 5 — Start everything**

Run this one command:

```bash
docker compose up -d
```

Wait about 30 seconds for everything to start up.

---

**Step 6 — Check it's working**

Run this:

```bash
curl http://localhost:3000/health
```

If you see `"backend":"ok"` — your backend is running! 🎉

> ⚠️ **Important:** `localhost` only works when testing ON the server itself. When you open the Vault app on your iPhone you need to enter your server's real IP address — not localhost. For example:
> - Home network: `http://10.0.0.50:3000`
> - Tailscale: `http://100.64.0.1:3000`
> - VPS: `http://203.0.113.10:3000`
>
> Not sure what your server's IP is? On your server run `hostname -I` and it will show you.

If you see an error — check the troubleshooting section below.

---

> **Umbrel users:** Docker Compose may not work with Umbrel's network setup. Use the manual setup below instead and add `--network umbrel_main_network` to the actual-http-api command.

---

## Setup — Manual Way (pm2)

Use this if you're on Umbrel, a NAS, or prefer more control.

### Step 1 — Run actual-http-api

This is a Docker container that sits between the app and Actual Budget.

Open a terminal on your server and run this command. **Replace the 3 values in ALL CAPS with your own:**

```bash
docker run -d \
  --name actualhttpapi \
  --restart unless-stopped \
  -p 5008:5007 \
  -e ACTUAL_SERVER_URL="http://YOUR_SERVER_IP:5006/" \
  -e ACTUAL_SERVER_PASSWORD="YOUR_ACTUAL_BUDGET_PASSWORD" \
  -e API_KEY="make-up-any-secret-key" \
  jhonderson/actual-http-api:26.3.0
```

**What to replace:**
- `YOUR_SERVER_IP` → the IP address of your server (e.g. `192.168.1.100`)
- `YOUR_ACTUAL_BUDGET_PASSWORD` → the password you use to log into Actual Budget
- `make-up-any-secret-key` → invent any password (e.g. `mysecretkey123`) — you'll use this again in Step 3
- `26.3.0` → match this to your Actual Budget version (check in Actual Budget → Settings)

> **Umbrel users:** Add `--network umbrel_main_network` to the command and use `sudo docker run ...`

---

### Step 2 — Download the Vault backend

Create a folder on your server:

```bash
mkdir vault-backend
cd vault-backend
```

Download `server.js` from this page (click the file, then click the download button) and put it in that folder.

Then install the dependencies:

```bash
npm init -y
npm install express cors dotenv node-fetch@2
```

> Don't have Node.js? Install it from [nodejs.org](https://nodejs.org) — any version 18 or higher works.

---

### Step 3 — Create a settings file

In your `vault-backend` folder create a file called `.env`:

```bash
nano .env
```

Paste this in and fill in your own values:

```
PORT=3000
ACTUAL_HTTP_API_URL=http://localhost:5008
ACTUAL_HTTP_API_KEY=the-secret-key-you-made-up-in-step-1
ACTUAL_SYNC_ID=your-budget-sync-id
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

**How to find your Sync ID:**
Open Actual Budget in your browser → Settings → scroll down → you'll see "Sync ID" — copy that value.

Save the file with **Ctrl+X → Y → Enter**

---

### Step 4 — Start the backend

```bash
sudo npm install -g pm2
pm2 start server.js --name vault-backend
pm2 save
pm2 startup
```

Run whatever command `pm2 startup` tells you to run (it'll start with `sudo env PATH=...`).

---

### Step 5 — Check it's working

```bash
curl http://localhost:3000/health
```

You should see something like:
```json
{"backend":"ok","hasSyncId":true,"hasApiKey":true}
```

If you see that — you're done with the server setup! 🎉

---

## Connect the App

1. Download from TestFlight
2. Open the app — you'll see a setup screen
3. Enter your Vault backend URL:
   - On your home network: `http://192.168.1.x:3000`
   - Using Tailscale: `http://100.x.x.x:3000`
4. Tap **Test & Connect**
5. Follow the setup wizard — it'll detect your income and fixed expenses automatically

> ⚠️ Enter the Vault backend URL (port 3000) — NOT your Actual Budget URL (port 5006)

---

## Set up AI features (optional)

1. Get a free API key at [openrouter.ai](https://openrouter.ai)
2. In the app go to **Settings → AI Coach**
3. Paste your API key
4. Pick a model (free ones work great)

Then try asking:
- "Set my grocery budget to $500"
- "When will I be debt free?"
- "What should I cut this month?"

---

## Access from outside your home (optional)

To use the app away from home you need a way to reach your server remotely:

- **Tailscale** (easiest) — free VPN, install on your server and iPhone, done
- **Cloudflare Tunnel** — free, no port forwarding needed
- **Port forwarding** — open port 3000 on your router (less secure)

---

## Something not working?

**"Could not connect" in the app**
- Make sure the URL ends in `:3000`
- Make sure it's pointing to the Vault backend, not Actual Budget
- Try the URL in your phone's browser — you should see a response

**actual-http-api can't reach Actual Budget**
- Make sure both are on the same network/Docker network
- Umbrel users: add `--network umbrel_main_network` to the docker run command
- Try using your server's actual IP instead of `localhost`

**Wrong Actual Budget password**
- The password is what you use to log into the Actual Budget web interface
- If you forgot it: `docker exec -it actual-budget /bin/sh` then `node /app/src/scripts/reset-password.js`

**Version mismatch error**
- Match the `actual-http-api` version tag to your Actual Budget version
- Example: if Actual Budget is `25.12.0` use `jhonderson/actual-http-api:25.12.0`

**App crashes after entering wrong URL**
- Go to Settings → Reset Server → enter the correct URL

---

## Updating from v1.0 to v1.1

The backend changed significantly in v1.1. Follow these steps in order — don't skip any!

---

**Step 1 — Stop your current backend**
```bash
pm2 stop vault-backend
```

---

**Step 2 — Download the new server.js**
```bash
cd ~/vault-backend
curl -O https://raw.githubusercontent.com/cesardmartinezz/vault-for-actual/main/server.js
```

---

**Step 3 — Update your .env file**
```bash
nano .env
```
Delete everything and replace with:
```
PORT=3000
ACTUAL_HTTP_API_URL=http://localhost:5008
ACTUAL_HTTP_API_KEY=make-up-any-secret-key
ACTUAL_SYNC_ID=your-sync-id-here
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```
Save with **Ctrl+X → Y → Enter**

> Replace `make-up-any-secret-key` with any password you invent and `your-sync-id-here` with your Sync ID from Actual Budget → Settings.

---

**Step 4 — Run actual-http-api** (new requirement in v1.1)

This is new — you need this Docker container running before starting the backend. Run this command replacing the 3 values with your own:

```bash
docker run -d \
  --name actualhttpapi \
  --restart unless-stopped \
  -p 5008:5007 \
  -e ACTUAL_SERVER_URL="http://YOUR_SERVER_IP:5006/" \
  -e ACTUAL_SERVER_PASSWORD="YOUR_ACTUAL_BUDGET_PASSWORD" \
  -e API_KEY="make-up-any-secret-key" \
  jhonderson/actual-http-api:26.3.0
```

> Use the same secret key you put in your .env file. Match `26.3.0` to your Actual Budget version.
> Umbrel users: add `--network umbrel_main_network` and use `sudo docker run ...`

---

**Step 5 — Restart the backend**
```bash
pm2 restart vault-backend --update-env
pm2 save
```

---

**Step 6 — Test it**
```bash
curl http://localhost:3000/health
```

You should see `"backend":"ok"` — you're done! ✅

If you see an error check the troubleshooting section above.


---

## Privacy

Your financial data goes directly between your iPhone and your own server. Nothing passes through any third-party servers. No ads, no tracking, no analytics.

[Privacy Policy](https://cesardmartinezz.github.io/vault-for-actual/privacy-policy.html)

---

## Credits

- [actual-http-api](https://github.com/jhonderson/actual-http-api) by jhonderson — makes this whole thing possible. Give it a ⭐ on GitHub!

---

## Questions or feedback?

Open an issue on GitHub or email filet.eidola.8x@icloud.com
