const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ACTUAL_HTTP_API_URL = process.env.ACTUAL_HTTP_API_URL || "http://localhost:5007";
const ACTUAL_HTTP_API_KEY = process.env.ACTUAL_HTTP_API_KEY;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";

// ─────────────────────────────────────────────────────────────
// ACTUAL HTTP API HELPERS
// ─────────────────────────────────────────────────────────────

async function actualGet(endpoint) {
  const url = `${ACTUAL_HTTP_API_URL}/v1/budgets/${ACTUAL_SYNC_ID}${endpoint}`;
  const res = await fetch(url, {
    headers: { "x-api-key": ACTUAL_HTTP_API_KEY, "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error(`actual-http-api error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // actual-http-api wraps all responses in { data: ... }
  return json.data !== undefined ? json.data : json;
}

async function actualPost(endpoint, body) {
  const url = `${ACTUAL_HTTP_API_URL}/v1/budgets/${ACTUAL_SYNC_ID}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": ACTUAL_HTTP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`actual-http-api error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function actualPut(endpoint, body) {
  const url = `${ACTUAL_HTTP_API_URL}/v1/budgets/${ACTUAL_SYNC_ID}${endpoint}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "x-api-key": ACTUAL_HTTP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`actual-http-api error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function actualPatch(endpoint, body) {
  const url = `${ACTUAL_HTTP_API_URL}/v1/budgets/${ACTUAL_SYNC_ID}${endpoint}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "x-api-key": ACTUAL_HTTP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`actual-http-api error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Get all transactions across all accounts for a date range
async function getAllTransactions(startDate, endDate) {
  const accounts = await actualGet("/accounts");
  const allTransactions = [];
  for (const account of accounts) {
    try {
      const txs = await actualGet(`/accounts/${account.id}/transactions?since_date=${startDate}&until_date=${endDate}`);
      for (const tx of txs) {
        allTransactions.push({ ...tx, accountName: account.name, accountId: account.id });
      }
    } catch (e) {
      // skip accounts with no transactions
    }
  }
  return allTransactions;
}

// Get month date range
function getMonthRange(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
  return { start, end };
}

function getRequestedMonth(req) {
  const m = req.query.month;
  if (m && /^\d{4}-\d{2}$/.test(m)) return m;
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function getPreviousMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────
// CATEGORY DETECTION — fully dynamic
// ─────────────────────────────────────────────────────────────

function buildCategoryContext(categories) {
  const categoryMap = {};
  const incomeCategoryIds = new Set();
  const transferCategoryIds = new Set();

  // Flatten all categories
  function collect(items, groupName) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item.id && item.name) {
        categoryMap[item.id] = item.name.trim();
        // If parent group is income-like, mark as income
        if (groupName && /income|revenue|earnings|salary|wages|ingresos/i.test(groupName)) {
          incomeCategoryIds.add(item.id);
        }
        // Mark income category itself
        if (/^income$/i.test(item.name.trim())) {
          incomeCategoryIds.add(item.id);
        }
      }
      // Check if this is a group with categories
      if (item.categories) {
        const gName = (item.name || "").trim();
        collect(item.categories, gName);
      }
    }
  }
  collect(categories, null);

  // Detect transfer categories by name
  const transferPatterns = [
    /credit.?card.?pay/i, /cc.?pay/i, /^transfers?$/i,
    /payment.*transfer/i, /internal.*transfer/i,
  ];
  for (const [id, name] of Object.entries(categoryMap)) {
    if (transferPatterns.some(p => p.test(name))) {
      transferCategoryIds.add(id);
    }
  }

  return { categoryMap, incomeCategoryIds, transferCategoryIds };
}

function isExcludedSpending(categoryId, categoryName, incomeCategoryIds, transferCategoryIds) {
  if (incomeCategoryIds.has(categoryId)) return true;
  if (transferCategoryIds.has(categoryId)) return true;
  const name = (categoryName || "").toLowerCase().trim();
  if (/^invest/.test(name)) return true;
  if (/dividend/.test(name)) return true;
  if (/^savings/.test(name)) return true;
  if (/emergency.?fund/.test(name)) return true;
  if (/^transfers?$/.test(name)) return true;
  if (/credit.?card/.test(name)) return true;
  if (/^income$/.test(name)) return true;
  return false;
}

function isRealIncome(tx, categoryMap, incomeCategoryIds, transferCategoryIds) {
  if (Number(tx.amount) <= 0) return false;
  if (tx.transfer_id) return false;
  if (/starting balance/i.test(tx.payee_name || "")) return false;
  const categoryName = categoryMap[tx.category] || "Uncategorized";
  if (transferCategoryIds.has(tx.category)) return false;
  const name = categoryName.toLowerCase();
  if (/invest|dividend|savings|transfer|credit.?card|interest.?charge|emergency.?fund/.test(name)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// MERCHANT HELPERS
// ─────────────────────────────────────────────────────────────

function normalizeMerchantName(notes) {
  if (!notes) return "unknown";
  return notes.toLowerCase()
    .replace(/\*/g, " ").replace(/paypal\s*/g, "paypal ").replace(/aplpay\s*/g, "")
    .replace(/\b(payment|payments|purchase|member|membership|monthly|subscription|autopay|auto pay|thank you|electronic|plan fee)\b/g, "")
    .replace(/\b(inc|llc|co|corp|ltd)\b/g, "")
    .replace(/[0-9]{3,}/g, "").replace(/[^a-z0-9&.+\- ]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalizeMerchantName(name) {
  if (!name) return "unknown";
  return name
    .replace(/^paypal /, "").replace(/^pp /, "").replace(/^sq /, "").replace(/^tst /, "")
    .replace(/\bchatgpt subs\b/g, "chatgpt").replace(/\bopenai chatgpt\b/g, "chatgpt")
    .replace(/\byoutube premium\b/g, "youtube").replace(/\bspotify usa\b/g, "spotify")
    .replace(/\bpeloton\b.*$/g, "peloton").replace(/\bpeacock\b.*$/g, "peacock")
    .replace(/\bgeico\b.*$/g, "geico").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────
// SPENDING ANALYSIS HELPERS
// ─────────────────────────────────────────────────────────────

function analyzeTransactions(transactions, categories) {
  const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
  let totalIncome = 0, totalSpending = 0;
  const spendingByCategory = {};
  const largeTransactions = [];

  for (const tx of transactions) {
    const amount = Number(tx.amount) / 100;
    const categoryName = categoryMap[tx.category] || "Uncategorized";

    if (amount > 0) {
      if (isRealIncome(tx, categoryMap, incomeCategoryIds, transferCategoryIds)) {
        totalIncome += amount;
      }
    } else if (amount < 0) {
      if (isExcludedSpending(tx.category, categoryName, incomeCategoryIds, transferCategoryIds) || tx.transfer_id) continue;
      const spend = Math.abs(amount);
      totalSpending += spend;
      spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + spend;
      if (spend >= 100) {
        largeTransactions.push({ id: tx.id, date: tx.date, notes: tx.notes || tx.payee_name || "No description", amount: Number(spend.toFixed(2)), categoryName });
      }
    }
  }

  const topCategories = Object.entries(spendingByCategory)
    .map(([name, total]) => ({ name, total: Number(total.toFixed(2)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  largeTransactions.sort((a, b) => b.amount - a.amount);

  return {
    income: Number(totalIncome.toFixed(2)),
    spending: Number(totalSpending.toFixed(2)),
    net: Number((totalIncome - totalSpending).toFixed(2)),
    topCategories,
    spendingByCategory,
    largeTransactions: largeTransactions.slice(0, 5)
  };
}

function detectRecurringCharges(transactions, categories) {
  const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);

  const negTx = transactions
    .filter(tx => Number(tx.amount) < 0 && !tx.transfer_id)
    .map(tx => {
      const categoryName = categoryMap[tx.category] || "Uncategorized";
      const merchant = canonicalizeMerchantName(normalizeMerchantName(tx.notes || tx.payee_name || ""));
      return { id: tx.id, date: tx.date, merchant, amount: Number(Math.abs(Number(tx.amount) / 100).toFixed(2)), categoryName, rawCategoryId: tx.category };
    })
    .filter(tx => {
      if (isExcludedSpending(tx.rawCategoryId, tx.categoryName, incomeCategoryIds, transferCategoryIds)) return false;
      return tx.merchant && tx.merchant !== "unknown";
    });

  const grouped = {};
  for (const tx of negTx) {
    const key = `${tx.merchant}__${tx.categoryName}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(tx);
  }

  return Object.values(grouped).map(items => {
    const sorted = items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length < 2) return null;
    const amounts = sorted.map(x => x.amount);
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const maxAmount = Math.max(...amounts), minAmount = Math.min(...amounts);
    const amountSpread = avgAmount > 0 ? ((maxAmount - minAmount) / avgAmount) * 100 : 0;
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i-1].date), curr = new Date(sorted[i].date);
      gaps.push(Math.round((curr - prev) / (1000 * 60 * 60 * 24)));
    }
    const avgGap = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;
    let frequency = "irregular";
    if (avgGap >= 25 && avgGap <= 35) frequency = "monthly";
    else if (avgGap >= 6 && avgGap <= 9) frequency = "weekly";
    else if (avgGap >= 12 && avgGap <= 18) frequency = "biweekly";
    let confidence = 0;
    if (sorted.length >= 3) confidence += 40; else confidence += 20;
    if (frequency === "monthly") confidence += 35; else if (["weekly","biweekly"].includes(frequency)) confidence += 25;
    if (amountSpread <= 5) confidence += 25; else if (amountSpread <= 15) confidence += 15; else if (amountSpread <= 25) confidence += 5;
    confidence = Math.min(confidence, 100);
    if (confidence < 50) return null;
    const latest = sorted[sorted.length - 1];
    return { merchant: latest.merchant, categoryName: latest.categoryName, count: sorted.length, averageAmount: Number(avgAmount.toFixed(2)), latestAmount: latest.amount, latestDate: latest.date, frequency, confidence, samples: sorted.slice(-3) };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence || b.averageAmount - a.averageAmount);
}

function loadTargets() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "targets.json"), "utf-8")); } catch { return {}; }
}

function loadAPRRates() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "apr-rates.json"), "utf-8")); } catch { return {}; }
}

function saveAPRRates(rates) {
  fs.writeFileSync(path.join(__dirname, "apr-rates.json"), JSON.stringify(rates, null, 2));
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ message: "Vault for Actual backend is running" }));

app.get("/health", (req, res) => res.json({
  backend: "ok",
  actualHttpApiUrl: ACTUAL_HTTP_API_URL,
  hasSyncId: !!ACTUAL_SYNC_ID,
  hasApiKey: !!ACTUAL_HTTP_API_KEY,
  openRouterModel: OPENROUTER_MODEL,
  timestamp: new Date().toISOString()
}));

app.get("/categories", async (req, res) => {
  try {
    const categories = await actualGet("/categories");
    const { categoryMap } = buildCategoryContext(categories);
    const list = Object.entries(categoryMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, categories: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/transactions", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const { start, end } = getMonthRange(currentMonth);
    const [transactions, categories] = await Promise.all([
      getAllTransactions(start, end),
      actualGet("/categories")
    ]);
    const { categoryMap } = buildCategoryContext(categories);
    const cleaned = transactions.slice(0, 500).map(tx => ({
      id: tx.id, date: tx.date,
      notes: tx.notes || tx.imported_payee || tx.payee_name || null,
      amount: Number((Number(tx.amount) / 100).toFixed(2)),
      accountName: tx.accountName || null,
      categoryName: categoryMap[tx.category] || "Uncategorized",
      cleared: tx.cleared || false
    }));
    res.json({ success: true, count: transactions.length, showing: cleaned.length, transactions: cleaned });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/update-transaction-category", async (req, res) => {
  try {
    const { transactionId, categoryId } = req.body;
    if (!transactionId || !categoryId) return res.status(400).json({ success: false, error: "Missing transactionId or categoryId" });
    await actualPut(`/transactions/${transactionId}`, { category_id: categoryId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/insights", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const { start, end } = getMonthRange(currentMonth);
    const [transactions, categories] = await Promise.all([
      getAllTransactions(start, end),
      actualGet("/categories")
    ]);
    const analysis = analyzeTransactions(transactions, categories);
    const insights = [];
    if (analysis.net < 0) insights.push(`You are currently over budget this month by $${Math.abs(analysis.net).toFixed(2)}.`);
    else insights.push(`You are currently under budget this month by $${analysis.net.toFixed(2)}.`);
    if (analysis.topCategories.length > 0) insights.push(`Your highest spending area this month is ${analysis.topCategories[0].name} at $${analysis.topCategories[0].total.toFixed(2)}.`);
    if (analysis.topCategories.length > 1) insights.push(`Your second highest spending area is ${analysis.topCategories[1].name} at $${analysis.topCategories[1].total.toFixed(2)}.`);
    if (analysis.spending > analysis.income) insights.push("Focus on reducing discretionary spending this month so your spending drops below your income.");
    res.json({ success: true, month: currentMonth, summary: { income: analysis.income, spending: analysis.spending, net: analysis.net }, topCategories: analysis.topCategories, insights });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/accounts-summary", async (req, res) => {
  try {
    const accounts = await actualGet("/accounts");
    const open = accounts.filter(a => !a.closed);
    const summaries = open.map(a => ({
      id: a.id, name: a.name,
      offbudget: a.offbudget || false,
      closed: a.closed || false,
      balance: Number((Number(a.balance_current || a.balance || 0) / 100).toFixed(2)),
      type: Number(a.balance_current || a.balance || 0) < 0 ? "debt" : "asset"
    })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    const totalAssets = summaries.filter(a => a.type === "asset").reduce((sum, a) => sum + a.balance, 0);
    const totalDebts = summaries.filter(a => a.type === "debt").reduce((sum, a) => sum + Math.abs(a.balance), 0);
    res.json({ success: true, summary: { totalAccounts: summaries.length, totalAssets: Number(totalAssets.toFixed(2)), totalDebts: Number(totalDebts.toFixed(2)), netWorth: Number((totalAssets - totalDebts).toFixed(2)) }, accounts: summaries });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/account-transactions", async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId" });
    const [accounts, categories, txs] = await Promise.all([
      actualGet("/accounts"),
      actualGet("/categories"),
      actualGet(`/accounts/${accountId}/transactions?startDate=2020-01-01&endDate=2030-12-31`)
    ]);
    const account = accounts.find(a => a.id === accountId);
    if (!account) return res.status(404).json({ success: false, error: "Account not found" });
    const { categoryMap } = buildCategoryContext(categories);
    const balance = Number((Number(account.balance || 0) / 100).toFixed(2));
    const cleaned = txs.slice(0, 100).map(tx => ({
      id: tx.id, date: tx.date, notes: tx.notes || tx.imported_payee || tx.payee_name || null,
      amount: Number((Number(tx.amount) / 100).toFixed(2)),
      accountName: account.name,
      categoryName: categoryMap[tx.category] || "Uncategorized",
      cleared: tx.cleared || false
    }));
    res.json({ success: true, account: { id: account.id, name: account.name, balance, type: balance < 0 ? "debt" : "asset" }, transactions: cleaned });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const targets = loadTargets();
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);

    const [currentTxs, previousTxs, categories, allTxs] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", cEnd)
    ]);

    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);

    const allNames = Array.from(new Set([...Object.keys(current.spendingByCategory), ...Object.keys(previous.spendingByCategory)]));
    const categoryTrends = allNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      const change = curr - prev;
      const percentChange = prev > 0 ? (change / prev) * 100 : curr > 0 ? 100 : 0;
      return { name, current: Number(curr.toFixed(2)), previous: Number(prev.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
    }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const budgetStatus = Object.keys(targets).map(name => {
      const spent = current.spendingByCategory[name] || 0;
      const target = Number(targets[name]) || 0;
      const remaining = target - spent;
      const percentUsed = target > 0 ? (spent / target) * 100 : 0;
      return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: remaining < 0 ? "over" : "under" };
    });

    const recurringCharges = detectRecurringCharges(allTxs, categories);
    const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 80);
    const newRecurring = monthlyRecurring.filter(r => r.count === 2);

    const alerts = [];
    if (current.net < 0) alerts.push({ level: "warning", title: "Over budget", message: `You are over budget by $${Math.abs(current.net).toFixed(2)} this month.` });
    if (previous.spending > 0 && current.spending > previous.spending) {
      const diff = current.spending - previous.spending;
      const pct = (diff / previous.spending) * 100;
      if (pct >= 10) alerts.push({ level: "warning", title: "Spending increased", message: `Your spending is up $${diff.toFixed(2)} (${pct.toFixed(1)}%) versus ${previousMonth}.` });
    }
    const biggestTrend = categoryTrends.find(i => i.change > 0);
    if (biggestTrend && biggestTrend.percentChange >= 10) alerts.push({ level: "info", title: "Largest category increase", message: `${biggestTrend.name} is up $${biggestTrend.change.toFixed(2)} (${biggestTrend.percentChange.toFixed(1)}%) versus ${previousMonth}.` });
    const overBudget = budgetStatus.filter(i => i.status === "over").sort((a, b) => Math.abs(b.remaining) - Math.abs(a.remaining));
    if (overBudget.length > 0) alerts.push({ level: "warning", title: "Category over target", message: `${overBudget[0].name} is over target by $${Math.abs(overBudget[0].remaining).toFixed(2)}.` });
    if (current.largeTransactions.length > 0) { const l = current.largeTransactions[0]; alerts.push({ level: "info", title: "Largest recent expense", message: `${l.notes} was $${l.amount.toFixed(2)} on ${l.date}.` }); }
    if (newRecurring.length > 0) alerts.push({ level: "info", title: "New recurring charge", message: `${newRecurring[0].merchant} looks like a new monthly charge at ~$${newRecurring[0].averageAmount.toFixed(2)}.` });
    if (alerts.length === 0) alerts.push({ level: "good", title: "No major issues", message: "This month looks stable based on your current spending patterns." });

    res.json({ success: true, month: currentMonth, previousMonth, summary: current, alerts, categoryTrends: categoryTrends.slice(0, 5), budgetStatus, recurringSummary: { monthlyCount: monthlyRecurring.length, newRecurringCount: newRecurring.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/ai-coach", async (req, res) => {
  try {
    const targets = loadTargets();
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);

    const [currentTxs, previousTxs, categories, allTxs] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", cEnd)
    ]);

    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);
    const recurringCharges = detectRecurringCharges(allTxs, categories);

    const allNames = Array.from(new Set([...Object.keys(current.spendingByCategory), ...Object.keys(previous.spendingByCategory)]));
    const categoryTrends = allNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      const change = curr - prev;
      const percentChange = prev > 0 ? (change / prev) * 100 : curr > 0 ? 100 : 0;
      return { name, current: Number(curr.toFixed(2)), previous: Number(prev.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
    }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const budgetStatus = Object.keys(targets).map(name => {
      const spent = current.spendingByCategory[name] || 0;
      const target = Number(targets[name]) || 0;
      const remaining = target - spent;
      const percentUsed = target > 0 ? (spent / target) * 100 : 0;
      return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: spent > target ? "over" : "under" };
    });

    const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 80);

    let score = 100;
    const priorities = [], debtAdvice = [], spendingAdvice = [], subscriptionAdvice = [];
    const overBudget = budgetStatus.filter(i => i.status === "over").sort((a, b) => Math.abs(b.remaining) - Math.abs(a.remaining));
    const rising = categoryTrends.filter(i => i.change > 0).sort((a, b) => b.change - a.change);

    if (current.net < 0) { score -= 30; priorities.push(`You are overspending by $${Math.abs(current.net).toFixed(2)} this month.`); debtAdvice.push("Pause aggressive extra debt payments until monthly cash flow is positive again."); }
    else { const safe = Math.max(current.net * 0.35, 0), agg = Math.max(current.net * 0.60, 0); debtAdvice.push(`Your surplus is $${current.net.toFixed(2)}. Conservative extra payment: $${safe.toFixed(2)}/mo. Aggressive: $${agg.toFixed(2)}/mo.`); }
    if (overBudget.length > 0) { score -= Math.min(overBudget.length * 8, 24); priorities.push(`${overBudget[0].name} is over budget by $${Math.abs(overBudget[0].remaining).toFixed(2)}.`); overBudget.slice(0, 3).forEach(i => spendingAdvice.push(`${i.name} is over target by $${Math.abs(i.remaining).toFixed(2)}.`)); }
    if (rising.length > 0 && rising[0].percentChange >= 10) { score -= 8; priorities.push(`${rising[0].name} is up $${rising[0].change.toFixed(2)} vs last month.`); }
    if (monthlyRecurring.length >= 10) { score -= 10; priorities.push(`You have ${monthlyRecurring.length} recurring charges. Review for cuts.`); }
    monthlyRecurring.sort((a, b) => b.averageAmount - a.averageAmount).slice(0, 5).forEach(i => subscriptionAdvice.push(`${i.merchant} averages $${i.averageAmount.toFixed(2)}/month.`));
    score = Math.max(1, Math.min(100, Math.round(score)));
    let healthLabel = "Strong";
    if (score < 80) healthLabel = "Stable";
    if (score < 65) healthLabel = "Needs Attention";
    if (score < 45) healthLabel = "High Risk";

    res.json({ success: true, month: currentMonth, previousMonth, summary: current, financialHealthScore: score, healthLabel, priorities: priorities.slice(0, 5), debtAdvice: debtAdvice.slice(0, 5), spendingAdvice: spendingAdvice.slice(0, 5), subscriptionAdvice: subscriptionAdvice.slice(0, 5), recurringSummary: { monthlyCount: monthlyRecurring.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/budget", async (req, res) => {
  try {
    const targets = loadTargets();
    const currentMonth = getRequestedMonth(req);
    const { start, end } = getMonthRange(currentMonth);
    const [transactions, categories] = await Promise.all([getAllTransactions(start, end), actualGet("/categories")]);
    const analysis = analyzeTransactions(transactions, categories);
    const budget = Object.keys(targets).map(name => {
      const spent = analysis.spendingByCategory[name] || 0;
      const target = Number(targets[name]) || 0;
      const remaining = target - spent;
      const percentUsed = target > 0 ? (spent / target) * 100 : 0;
      return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: remaining < 0 ? "over" : "under" };
    });
    res.json({ success: true, month: currentMonth, budget });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/update-target", (req, res) => {
  try {
    const { category, target } = req.body;
    if (!category || typeof target !== "number") return res.status(400).json({ success: false, error: "Invalid input" });
    const filePath = path.join(__dirname, "targets.json");
    let targets = {};
    try { targets = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {}
    targets[category] = target;
    fs.writeFileSync(filePath, JSON.stringify(targets, null, 2));
    res.json({ success: true, category, target });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/update-apr", (req, res) => {
  try {
    const { accountId, apr } = req.body;
    if (!accountId || typeof apr !== "number") return res.status(400).json({ success: false, error: "Invalid input" });
    const rates = loadAPRRates();
    rates[accountId] = apr;
    saveAPRRates(rates);
    res.json({ success: true, accountId, apr });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/recurring-charges", async (req, res) => {
  try {
    const [allTxs, categories] = await Promise.all([
      getAllTransactions("2024-01-01", new Date().toISOString().slice(0, 10)),
      actualGet("/categories")
    ]);
    const recurringCharges = detectRecurringCharges(allTxs, categories);
    res.json({ success: true, recurringCharges });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/monthly-trends", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const [year, month] = currentMonth.split("-").map(Number);
      const date = new Date(year, month - 1 - i, 1);
      months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
    }
    const categories = await actualGet("/categories");
    const monthlyData = await Promise.all(months.map(async monthKey => {
      const { start, end } = getMonthRange(monthKey);
      const txs = await getAllTransactions(start, end);
      const analysis = analyzeTransactions(txs, categories);
      const [y, m] = monthKey.split("-");
      const label = new Date(Number(y), Number(m)-1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      return { month: monthKey, label, income: analysis.income, spending: analysis.spending, net: analysis.net, topCategories: analysis.topCategories, _spending: analysis.spendingByCategory };
    }));
    const allCategoryNames = Array.from(new Set(monthlyData.flatMap(m => Object.keys(m._spending))));
    const categoryTrends = allCategoryNames.map(name => ({ name, data: monthlyData.map(m => ({ month: m.month, label: m.label, total: Number((m._spending[name] || 0).toFixed(2)) })) })).sort((a, b) => { const aL = a.data[a.data.length-1]?.total || 0, bL = b.data[b.data.length-1]?.total || 0; return bL - aL; });
    const cleanMonths = monthlyData.map(({ _spending, ...rest }) => rest);
    res.json({ success: true, months: cleanMonths, categoryTrends });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/forecast", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const { start, end } = getMonthRange(currentMonth);
    const [transactions, categories, allTxs] = await Promise.all([
      getAllTransactions(start, end),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", end)
    ]);
    const analysis = analyzeTransactions(transactions, categories);
    const today = new Date();
    const currentDayOfMonth = today.getDate();
    const daysInMonth = new Date(Number(currentMonth.slice(0,4)), Number(currentMonth.slice(5,7)), 0).getDate();
    const daysRemaining = Math.max(daysInMonth - currentDayOfMonth, 0);
    const dailyAvg = currentDayOfMonth > 0 ? analysis.spending / currentDayOfMonth : 0;
    const recurringCharges = detectRecurringCharges(allTxs, categories);
    const remainingRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 80).reduce((sum, r) => { const day = Number(String(r.latestDate).slice(-2)); return day > currentDayOfMonth ? sum + r.latestAmount : sum; }, 0);
    const projectedTotal = analysis.spending + (dailyAvg * daysRemaining) + remainingRecurring;
    const projectedNet = analysis.income - projectedTotal;
    let runwayStatus = "Stable";
    if (projectedNet < 0) runwayStatus = "Risk";
    if (projectedNet < -250) runwayStatus = "High Risk";
    res.json({ success: true, month: currentMonth, forecast: { totalSpentSoFar: analysis.spending, totalIncomeSoFar: analysis.income, dailyAverageSpend: Number(dailyAvg.toFixed(2)), projectedVariableSpendRemaining: Number((dailyAvg * daysRemaining).toFixed(2)), remainingRecurringThisMonth: Number(remainingRecurring.toFixed(2)), projectedTotalMonthSpend: Number(projectedTotal.toFixed(2)), projectedNetEndOfMonth: Number(projectedNet.toFixed(2)), daysRemaining, runwayStatus } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/merchant-insights", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);
    const [currentTxs, previousTxs, categories] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      actualGet("/categories")
    ]);
    const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);

    function getMerchantMap(txs) {
      const map = {};
      for (const tx of txs) {
        if (Number(tx.amount) >= 0 || tx.transfer_id) continue;
        const categoryName = categoryMap[tx.category] || "Uncategorized";
        if (isExcludedSpending(tx.category, categoryName, incomeCategoryIds, transferCategoryIds)) continue;
        const merchant = canonicalizeMerchantName(normalizeMerchantName(tx.notes || tx.payee_name || ""));
        if (!merchant || merchant === "unknown") continue;
        const amount = Math.abs(Number(tx.amount) / 100);
        if (!map[merchant]) map[merchant] = { name: merchant, totalSpent: 0, visitCount: 0, categoryName, transactions: [] };
        map[merchant].totalSpent += amount;
        map[merchant].visitCount += 1;
        map[merchant].transactions.push({ date: tx.date, amount: Number(amount.toFixed(2)) });
      }
      return map;
    }

    const currentMap = getMerchantMap(currentTxs);
    const prevMap = getMerchantMap(previousTxs);
    const prevTotals = Object.fromEntries(Object.entries(prevMap).map(([k, v]) => [k, v.totalSpent]));

    const merchants = Object.values(currentMap).map(m => {
      const prev = prevTotals[m.name] || 0;
      const change = m.totalSpent - prev;
      return { name: m.name, categoryName: m.categoryName, totalSpent: Number(m.totalSpent.toFixed(2)), visitCount: m.visitCount, avgPerVisit: Number((m.totalSpent / m.visitCount).toFixed(2)), previousMonthTotal: Number(prev.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number((prev > 0 ? (change / prev) * 100 : m.totalSpent > 0 ? 100 : 0).toFixed(1)), lastVisit: m.transactions.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.date || "" };
    }).filter(m => m.totalSpent > 0).sort((a, b) => b.totalSpent - a.totalSpent);

    const totalSpend = merchants.reduce((sum, m) => sum + m.totalSpent, 0);
    res.json({ success: true, month: currentMonth, previousMonth, summary: { totalMerchants: merchants.length, totalSpend: Number(totalSpend.toFixed(2)) }, topBySpend: merchants.slice(0, 10), topByFrequency: [...merchants].sort((a, b) => b.visitCount - a.visitCount).slice(0, 10), newMerchants: merchants.filter(m => m.previousMonthTotal === 0).slice(0, 5), biggestIncreases: merchants.filter(m => m.change > 0 && m.previousMonthTotal > 0).sort((a, b) => b.change - a.change).slice(0, 5) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/debt-tracker", async (req, res) => {
  try {
    const aprRates = loadAPRRates();
    const extraPayment = Number(req.query.extra) || 0;
    const [accounts, categories, allTxs] = await Promise.all([
      actualGet("/accounts"),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", new Date().toISOString().slice(0, 10))
    ]);
    const { categoryMap, transferCategoryIds } = buildCategoryContext(categories);

    const debtAccounts = accounts.filter(a => !a.closed && Number(a.balance_current || a.balance || 0) < 0).map(account => {
      const debt = Math.abs(Number(account.balance_current || account.balance || 0) / 100);
      const accountTxs = allTxs.filter(tx => tx.accountId === account.id);
      const payments = accountTxs.filter(tx => {
        if (Number(tx.amount) <= 0) return false;
        const name = categoryMap[tx.category] || "";
        return transferCategoryIds.has(tx.category) || /credit.?card.?pay|card.?pay|transfer/i.test(name);
      }).map(tx => ({ date: tx.date, amount: Number(tx.amount) / 100 })).sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 7);
      const recentPayments = payments.filter(p => p.date && p.date.slice(0, 7) >= threeMonthsAgoStr);
      const avgMonthlyPayment = recentPayments.length > 0 ? recentPayments.reduce((sum, p) => sum + p.amount, 0) / 3 : 0;
      const lastPayment = payments[0] || null;
      const monthsToPayoff = avgMonthlyPayment > 0 ? Math.ceil(debt / avgMonthlyPayment) : null;
      let payoffDate = null;
      if (monthsToPayoff) { const d = new Date(); d.setMonth(d.getMonth() + monthsToPayoff); payoffDate = d.toISOString().slice(0, 7); }
      const totalPaymentWithExtra = avgMonthlyPayment + extraPayment;
      const monthsToPayoffWithExtra = totalPaymentWithExtra > 0 && extraPayment > 0 ? Math.ceil(debt / totalPaymentWithExtra) : null;
      const monthsSavedWithCustomExtra = monthsToPayoff && monthsToPayoffWithExtra ? monthsToPayoff - monthsToPayoffWithExtra : null;
      const apr = aprRates[account.id] || null;
      const monthlyInterest = apr && debt > 0 ? Number(((apr / 100 / 12) * debt).toFixed(2)) : null;
      return { id: account.id, name: account.name, type: /loan|auto|mortgage/i.test(account.name) ? "loan" : "credit_card", currentBalance: Number(debt.toFixed(2)), avgMonthlyPayment: Number(avgMonthlyPayment.toFixed(2)), lastPaymentAmount: lastPayment ? Number(lastPayment.amount.toFixed(2)) : null, lastPaymentDate: lastPayment ? lastPayment.date : null, monthsToPayoff, payoffDate, apr, monthlyInterest, monthsToPayoffWithExtra, monthsSavedWithCustomExtra };
    }).sort((a, b) => b.currentBalance - a.currentBalance);

    const totalDebt = debtAccounts.reduce((sum, a) => sum + a.currentBalance, 0);
    const totalMonthlyPayments = debtAccounts.reduce((sum, a) => sum + a.avgMonthlyPayment, 0);
    const snowballOrder = [...debtAccounts].sort((a, b) => a.currentBalance - b.currentBalance);
    const avalancheOrder = [...debtAccounts].sort((a, b) => { if (a.apr && b.apr) return b.apr - a.apr; if (a.apr) return -1; if (b.apr) return 1; return b.currentBalance - a.currentBalance; });
    const hasAPRData = debtAccounts.some(a => a.apr !== null);
    const smallDebts = debtAccounts.filter(a => a.currentBalance < 500);
    const recommendedStrategy = smallDebts.length >= 2 && !hasAPRData ? "snowball" : "avalanche";

    res.json({ success: true, summary: { totalDebt: Number(totalDebt.toFixed(2)), totalMonthlyPayments: Number(totalMonthlyPayments.toFixed(2)), accountCount: debtAccounts.length, hasAPRData }, strategy: { recommended: recommendedStrategy, snowball: snowballOrder.map((d, i) => ({ order: i+1, accountId: d.id, name: d.name, balance: d.currentBalance, apr: d.apr })), avalanche: avalancheOrder.map((d, i) => ({ order: i+1, accountId: d.id, name: d.name, balance: d.currentBalance, apr: d.apr })) }, debts: debtAccounts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/ai-chat", async (req, res) => {
  try {
    const { messages, month, apiKey, model } = req.body;
    const resolvedAPIKey = apiKey || null;
    if (!resolvedAPIKey) return res.status(500).json({ success: false, error: "Please add your OpenRouter API key in Settings to use AI features." });
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ success: false, error: "Missing messages array" });

    const currentMonth = month || getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const twoMonthsAgo = getPreviousMonth(previousMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);
    const { start: tStart, end: tEnd } = getMonthRange(twoMonthsAgo);

    const [currentTxs, previousTxs, twoMonthAgoTxs, categories, allTxs, accounts] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      getAllTransactions(tStart, tEnd),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", cEnd),
      actualGet("/accounts")
    ]);

    const debtAccounts = accounts
      .filter(a => !a.closed && Number(a.balance_current || a.balance || 0) < 0)
      .map(a => ({
        name: a.name,
        balance: Math.abs(Number(a.balance_current || a.balance || 0) / 100)
      }))
      .sort((a, b) => b.balance - a.balance);
    const totalDebt = debtAccounts.reduce((sum, a) => sum + a.balance, 0);

    const targets = loadTargets();
    const locked = loadLockedCategories();
    const prefs = loadPreferences();
    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);
    const twoMonthAgo = analyzeTransactions(twoMonthAgoTxs, categories);
    const recurringCharges = detectRecurringCharges(allTxs, categories);
    const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 75).sort((a, b) => b.averageAmount - a.averageAmount).slice(0, 15);

    // Income averaging — use 3-month average when current month income is low
    const avgIncome = (previous.income + twoMonthAgo.income) / 2;
    const workingIncome = current.income < avgIncome * 0.5 ? avgIncome : current.income;
    const incomeNote = current.income < avgIncome * 0.5
      ? `Current month income is $${current.income.toFixed(2)} (likely not paid yet). Using 3-month average of $${avgIncome.toFixed(2)} for all calculations.`
      : `Income is on track.`;

    // Spending anomaly detection — compare categories to their 3-month average
    const allCategoryNames = Array.from(new Set([
      ...Object.keys(current.spendingByCategory),
      ...Object.keys(previous.spendingByCategory),
      ...Object.keys(twoMonthAgo.spendingByCategory)
    ]));
    const anomalies = allCategoryNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const avg = ((previous.spendingByCategory[name] || 0) + (twoMonthAgo.spendingByCategory[name] || 0)) / 2;
      const pct = avg > 0 ? ((curr - avg) / avg) * 100 : 0;
      return { name, current: curr, average: avg, percentChange: pct };
    }).filter(a => a.percentChange > 50 && a.current > 50).sort((a, b) => b.percentChange - a.percentChange).slice(0, 3);

    // Positive wins — categories that improved vs last month
    const wins = allCategoryNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      const saved = prev - curr;
      return { name, saved };
    }).filter(w => w.saved > 50).sort((a, b) => b.saved - a.saved).slice(0, 3);

    // Auto-detect fixed categories by name pattern
    const autoFixedPatterns = /car.?pay|insurance|mortgage|rent|loan|tuition|child.?sup|child.?care|internet|phone.?bill|utilities|hoa/i;
    const autoFixed = allCategoryNames.filter(n => autoFixedPatterns.test(n));

    // Locked categories context
    const lockedNames = Object.keys(locked);
    const reviewDue = getReviewDueCategories(locked);

    // Goals context
    const goals = prefs.goals || [];
    const goalsWithProgress = goals.map(g => {
      const debtAccount = debtAccounts.find(a => a.accountId === g.accountId || a.name === g.accountName);
      const currentBalance = debtAccount ? debtAccount.balance : null;
      return { ...g, currentBalance };
    });

    // Debt freedom date calculation
    const totalMonthlyDebtPayments = monthlyRecurring
      .filter(r => /car.?pay|loan|credit.?card/i.test(r.categoryName))
      .reduce((sum, r) => sum + r.averageAmount, 0);
    const monthsToDebtFree = totalMonthlyDebtPayments > 0 ? Math.ceil(totalDebt / totalMonthlyDebtPayments) : null;
    const debtFreeDate = monthsToDebtFree ? (() => { const d = new Date(); d.setMonth(d.getMonth() + monthsToDebtFree); return d.toISOString().slice(0, 7); })() : null;

    // Safe to spend calculation
    const fixedMonthly = monthlyRecurring.reduce((sum, r) => sum + r.averageAmount, 0);
    const safeToSpend = Math.max(0, workingIncome - fixedMonthly - (totalDebt * 0.05));

    // Category tags from user preferences
    const categoryTags = prefs.categoryTags || {};

    const budgetStatus = Object.keys(targets).map(name => {
      const spent = current.spendingByCategory[name] || 0;
      const target = Number(targets[name]) || 0;
      return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number((target-spent).toFixed(2)), percentUsed: target > 0 ? Number(((spent/target)*100).toFixed(1)) : 0, status: spent > target ? "over" : "under" };
    });

    const systemPrompt = `You are a blunt, encouraging personal financial coach with real access to the user's financial data. You celebrate wins, call out problems directly, and give specific advice based on actual numbers — like a smart friend who happens to be a CFP.

INCOME CONTEXT:
- This month: $${current.income.toFixed(2)} | Last month: $${previous.income.toFixed(2)} | Two months ago: $${twoMonthAgo.income.toFixed(2)}
- Working income for calculations: $${workingIncome.toFixed(2)}/month
- ${incomeNote}

SPENDING SUMMARY:
- ${currentMonth}: Spending $${current.spending.toFixed(2)} | Net $${current.net.toFixed(2)} (${current.net >= 0 ? "SURPLUS" : "DEFICIT"})
- ${previousMonth}: Spending $${previous.spending.toFixed(2)} | Net $${previous.net.toFixed(2)}
- ${twoMonthsAgo}: Spending $${twoMonthAgo.spending.toFixed(2)} | Net $${twoMonthAgo.net.toFixed(2)}

TOP SPENDING (${currentMonth}):
${current.topCategories.map(c => `- ${c.name}: $${c.total.toFixed(2)}`).join("\n")}

DEBT ACCOUNTS ($${totalDebt.toFixed(2)} total):
${debtAccounts.length > 0 ? debtAccounts.map(a => `- ${a.name}: $${a.balance.toFixed(2)}`).join("\n") : "No debt accounts."}
${debtFreeDate ? `- At current payment pace, debt-free by: ${debtFreeDate}` : ""}

SAFE TO SPEND THIS MONTH: ~$${safeToSpend.toFixed(2)} (after fixed bills and minimum debt payments)

${anomalies.length > 0 ? `SPENDING ANOMALIES (unusual spikes vs your average):
${anomalies.map(a => `- ${a.name}: $${a.current.toFixed(2)} this month vs $${a.average.toFixed(2)} average (+${a.percentChange.toFixed(0)}%)`).join("\n")}` : ""}

${wins.length > 0 ? `WINS THIS MONTH (improvements vs last month):
${wins.map(w => `- ${w.name}: saved $${w.saved.toFixed(2)} vs last month`).join("\n")}` : ""}

BUDGET STATUS:
${budgetStatus.length > 0 ? budgetStatus.map(b => `- ${b.name}: $${b.spent}/$${b.target} (${b.percentUsed}%) ${b.status === "over" ? "OVER" : "ok"}`).join("\n") : "No targets set."}

LOCKED CATEGORIES (NEVER suggest cutting these):
${lockedNames.length > 0 ? lockedNames.map(n => `- ${n}: ${locked[n].reason}`).join("\n") : "None locked."}
${autoFixed.length > 0 ? `Auto-detected fixed (treat as non-negotiable): ${autoFixed.join(", ")}` : ""}

${reviewDue.length > 0 ? `LOCKED CATEGORIES DUE FOR REVIEW (mention naturally in conversation):
${reviewDue.map(r => `- ${r.name} (locked ${r.lockedAt}, reason: ${r.reason})`).join("\n")}` : ""}

CATEGORY FLEXIBILITY TAGS:
${Object.entries(categoryTags).length > 0 ? Object.entries(categoryTags).map(([k,v]) => `- ${k}: ${v}`).join("\n") : "No tags set. Use auto-detection."}

${goalsWithProgress.length > 0 ? `USER GOALS:
${goalsWithProgress.map(g => `- Pay off ${g.accountName} by ${g.targetDate}${g.currentBalance ? ` (current balance: $${g.currentBalance.toFixed(2)})` : ""}`).join("\n")}` : ""}

MONTHLY RECURRING CHARGES:
${monthlyRecurring.map(r => `- ${r.merchant}: ~$${r.averageAmount.toFixed(2)}/mo (${r.categoryName})`).join("\n")}

AVAILABLE BUDGET CATEGORIES (use EXACT names when setting budgets):
${Object.values(buildCategoryContext(categories).categoryMap).filter(n => !["Income","Transfers","Credit Card Payments","Investments","Savings","Investments Dividend"].includes(n)).sort().join(", ")}

BUDGET UPDATE RULES: When user asks to set/change/update a budget, respond with a JSON action block on its own line:
{"action":"update_budget","category":"EXACT CATEGORY NAME","amount":500}
Use one line per category. After the JSON lines add a brief confirmation.

LOCKED CATEGORY REVIEW RULES: If any categories are listed under "DUE FOR REVIEW" above, naturally bring it up once in the conversation: "Hey, you locked [category] 3 months ago for [reason] — is that still the case or can we work with it now?" If user says still locked, call POST /snooze-category-review. If user says unlock, call POST /unlock-category.

YOUR COACHING PERSONALITY:
- Always use REAL numbers — never be vague
- Celebrate specific wins: "You spent $X less on Y than last month — keep that up!"
- For debt payoff: calculate exact extra payment needed, which account first, realistic timeline
- For budget recommendations: use 3-month averages as baseline, suggest realistic reductions
- Reference goals when giving advice
- Always end with one concrete actionable next step
- If income looks low this month, reference average income — never assume user is broke
- "Safe to spend" is your north star for discretionary advice
- Max 5-6 sentences unless user asks for a full plan
- Never make up numbers — only use data provided`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resolvedAPIKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://vault-for-actual", "X-Title": "Vault for Actual" },
      body: JSON.stringify({ model: model || OPENROUTER_MODEL, messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-10)], max_tokens: 1500, temperature: 0.7 })
    });

    if (!response.ok) { const err = await response.text(); throw new Error(`OpenRouter error ${response.status}: ${err}`); }
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "I couldn't generate a response. Please try again.";
    res.json({ success: true, message: reply, model: data.model });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/sync", async (req, res) => {
  // Respond immediately — fire and forget the bank sync
  res.json({ success: true, synced: new Date().toISOString(), message: "Sync initiated" });
  // Trigger bank sync in background, don't await
  actualPost("/accounts/banksync", {}).catch(() => {
    // Silently ignore — bank sync fails if no connections configured
  });
});

app.get("/category-trends", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);
    const [currentTxs, previousTxs, categories] = await Promise.all([getAllTransactions(cStart, cEnd), getAllTransactions(pStart, pEnd), actualGet("/categories")]);
    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);
    const allNames = Array.from(new Set([...Object.keys(current.spendingByCategory), ...Object.keys(previous.spendingByCategory)]));
    const categoryTrends = allNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      const change = curr - prev;
      const percentChange = prev > 0 ? (change / prev) * 100 : curr > 0 ? 100 : 0;
      return { name, current: Number(curr.toFixed(2)), previous: Number(prev.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
    }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    res.json({ success: true, month: currentMonth, previousMonth, categoryTrends });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/update-budget-amount", async (req, res) => {
  try {
    const { categoryName, amount, month } = req.body;
    if (!categoryName || typeof amount !== "number") {
      return res.status(400).json({ success: false, error: "Missing categoryName or amount" });
    }
    const currentMonth = month || getRequestedMonth(req);

    // Get all categories to find the matching one
    const categories = await actualGet("/categories");
    const { categoryMap } = buildCategoryContext(categories);

    const searchName = categoryName.toLowerCase().trim();
    const entries = Object.entries(categoryMap);

    // 1. Exact match
    let match = entries.find(([id, name]) => name.toLowerCase() === searchName);

    // 2. Partial match
    if (!match) {
      match = entries.find(([id, name]) =>
        name.toLowerCase().includes(searchName) || searchName.includes(name.toLowerCase())
      );
    }

    // 3. Word-level fuzzy match
    if (!match) {
      const searchWords = searchName.split(/\s+/);
      match = entries.find(([id, name]) => {
        const nameWords = name.toLowerCase().split(/\s+/);
        return searchWords.some(sw => nameWords.some(nw => nw.includes(sw) || sw.includes(nw)));
      });
    }

    // 4. Singularize/pluralize both ways
    if (!match) {
      // Convert search to plural: grocery -> groceries, shop -> shopping/shops
      const pluralVariants = [
        searchName + 's',
        searchName.replace(/y$/, 'ies'),
        searchName.replace(/ie$/, 'ies'),
      ];
      // Convert search to singular: groceries -> grocery, shops -> shop
      const singularVariants = [
        searchName.replace(/ies$/, 'y'),
        searchName.replace(/s$/, ''),
      ];
      const allVariants = [...pluralVariants, ...singularVariants];
      match = entries.find(([id, name]) => {
        const n = name.toLowerCase();
        return allVariants.some(v => n === v || n.startsWith(v) || v.startsWith(n));
      });
    }

    if (!match) {
      return res.status(404).json({
        success: false,
        error: `Category "${categoryName}" not found`,
        availableCategories: Object.values(categoryMap).sort()
      });
    }

    const [categoryId, matchedName] = match;

    await actualPatch(`/months/${currentMonth}/categories/${categoryId}`, {
      category: { budgeted: Math.round(amount * 100) }
    });
    res.json({
      success: true,
      categoryName: matchedName,
      categoryId,
      amount,
      month: currentMonth,
      message: `Budget for ${matchedName} set to $${amount.toFixed(2)} for ${currentMonth}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// LOCKED CATEGORIES
// ─────────────────────────────────────────────────────────────

function loadLockedCategories() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "locked-categories.json"), "utf-8")); } catch { return {}; }
}

function saveLockedCategories(data) {
  fs.writeFileSync(path.join(__dirname, "locked-categories.json"), JSON.stringify(data, null, 2));
}

function getReviewDueCategories(locked) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.entries(locked)
    .filter(([, v]) => v.reviewAfter && v.reviewAfter <= today)
    .map(([name, v]) => ({ name, reason: v.reason, lockedAt: v.lockedAt, reviewAfter: v.reviewAfter }));
}

app.post("/lock-category", (req, res) => {
  try {
    const category = req.body.category || req.body.categoryName;
    const { reason, reviewMonths } = req.body;
    if (!category) return res.status(400).json({ success: false, error: "Missing category" });
    const locked = loadLockedCategories();
    const reviewAfter = new Date();
    reviewAfter.setMonth(reviewAfter.getMonth() + (reviewMonths || 3));
    locked[category] = {
      reason: reason || "User locked",
      lockedAt: new Date().toISOString().slice(0, 10),
      reviewAfter: reviewAfter.toISOString().slice(0, 10),
      lastReviewed: null
    };
    saveLockedCategories(locked);
    res.json({ success: true, category, message: `${category} locked. Review scheduled for ${reviewAfter.toISOString().slice(0, 7)}.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/unlock-category", (req, res) => {
  try {
    const category = req.body.category || req.body.categoryName;
    if (!category) return res.status(400).json({ success: false, error: "Missing category" });
    const locked = loadLockedCategories();
    // Case-insensitive key lookup so "Child Support" matches "child support", etc.
    const key = Object.keys(locked).find(k => k.toLowerCase() === category.toLowerCase()) || category;
    delete locked[key];
    saveLockedCategories(locked);
    res.json({ success: true, category: key, message: `${key} unlocked.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/snooze-category-review", (req, res) => {
  try {
    const category = req.body.category || req.body.categoryName;
    if (!category) return res.status(400).json({ success: false, error: "Missing category" });
    const locked = loadLockedCategories();
    // Case-insensitive key lookup so the app's category name always finds the stored key
    const key = Object.keys(locked).find(k => k.toLowerCase() === category.toLowerCase());
    if (!key) {
      // Category isn't in locked-categories.json yet — lock it automatically so the snooze works
      const reviewAfter = new Date();
      reviewAfter.setMonth(reviewAfter.getMonth() + 3);
      locked[category] = {
        reason: "Auto-locked from AI review",
        lockedAt: new Date().toISOString().slice(0, 10),
        reviewAfter: reviewAfter.toISOString().slice(0, 10),
        lastReviewed: new Date().toISOString().slice(0, 10)
      };
      saveLockedCategories(locked);
      return res.json({ success: true, category, message: `Review snoozed. Next check-in: ${reviewAfter.toISOString().slice(0, 7)}.` });
    }
    const reviewAfter = new Date();
    reviewAfter.setMonth(reviewAfter.getMonth() + 3);
    locked[key].reviewAfter = reviewAfter.toISOString().slice(0, 10);
    locked[key].lastReviewed = new Date().toISOString().slice(0, 10);
    saveLockedCategories(locked);
    res.json({ success: true, category: key, message: `Review snoozed. Next check-in: ${reviewAfter.toISOString().slice(0, 7)}.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/locked-categories", (req, res) => {
  try {
    const locked = loadLockedCategories();
    const reviewDue = getReviewDueCategories(locked);
    res.json({ success: true, locked, reviewDue });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// USER PREFERENCES
// ─────────────────────────────────────────────────────────────

function loadPreferences() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "user-preferences.json"), "utf-8")); } catch { return {}; }
}

function savePreferences(data) {
  fs.writeFileSync(path.join(__dirname, "user-preferences.json"), JSON.stringify(data, null, 2));
}

app.post("/set-paycheck", (req, res) => {
  try {
    const { amount, frequency, dayOfMonth, dayOfMonth2 } = req.body;
    if (!amount) return res.status(400).json({ success: false, error: "Missing amount" });
    const prefs = loadPreferences();
    prefs.paycheck = { amount, frequency: frequency || "biweekly", dayOfMonth: dayOfMonth || 15, dayOfMonth2: dayOfMonth2 || 30, updatedAt: new Date().toISOString().slice(0, 10) };
    savePreferences(prefs);
    res.json({ success: true, paycheck: prefs.paycheck });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/set-category-tag", (req, res) => {
  try {
    const category = req.body.category || req.body.categoryName;
    const { tag } = req.body;
    if (!category || !tag) return res.status(400).json({ success: false, error: "Missing category or tag" });
    if (!["fixed", "reduce", "cuttable"].includes(tag)) return res.status(400).json({ success: false, error: "Tag must be fixed, reduce, or cuttable" });
    const prefs = loadPreferences();
    if (!prefs.categoryTags) prefs.categoryTags = {};
    prefs.categoryTags[category] = tag;
    savePreferences(prefs);
    res.json({ success: true, category, tag });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/set-goal", (req, res) => {
  try {
    const { type, accountId, accountName, targetDate, targetAmount, note } = req.body;
    const goalType = type || "debt_payoff";
    const prefs = loadPreferences();
    if (!prefs.goals) prefs.goals = [];
    const goal = { id: Date.now().toString(), type: goalType, accountId, accountName, targetDate, targetAmount, note, createdAt: new Date().toISOString().slice(0, 10) };
    prefs.goals = prefs.goals.filter(g => g.accountId !== accountId);
    prefs.goals.push(goal);
    savePreferences(prefs);
    res.json({ success: true, goal });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/preferences", (req, res) => {
  try {
    res.json({ success: true, preferences: loadPreferences() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/detect-setup", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startDate = threeMonthsAgo.toISOString().slice(0, 10);

    const [allTxs, categories] = await Promise.all([
      getAllTransactions(startDate, today),
      actualGet("/categories")
    ]);

    const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);

    // ── Detect paychecks ──────────────────────────────────────────
    const incomeTxs = allTxs.filter(tx =>
      isRealIncome(tx, categoryMap, incomeCategoryIds, transferCategoryIds)
    ).map(tx => ({
      date: tx.date,
      amount: Number(tx.amount) / 100,
      notes: tx.notes || tx.imported_payee || tx.payee_name || "Unknown",
      dayOfMonth: new Date(tx.date).getDate()
    }));

    // Group by normalized payee name
    const payeeGroups = {};
    for (const tx of incomeTxs) {
      const key = tx.notes.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 30);
      if (!payeeGroups[key]) payeeGroups[key] = [];
      payeeGroups[key].push(tx);
    }

    // Find recurring income sources (appeared at least 2 times)
    const detectedPaychecks = Object.entries(payeeGroups)
      .filter(([, txs]) => txs.length >= 2)
      .map(([key, txs]) => {
        const amounts = txs.map(t => t.amount);
        const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
        const days = txs.map(t => t.dayOfMonth);
        const avgDay = Math.round(days.reduce((s, v) => s + v, 0) / days.length);
        const gaps = [];
        const sorted = txs.sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 1; i < sorted.length; i++) {
          const diff = (new Date(sorted[i].date) - new Date(sorted[i-1].date)) / (1000 * 60 * 60 * 24);
          gaps.push(diff);
        }
        const avgGap = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 30;
        let frequency = "monthly";
        if (avgGap <= 9) frequency = "weekly";
        else if (avgGap <= 16) frequency = "biweekly";
        else if (avgGap <= 20) frequency = "twice_monthly";
        return {
          name: txs[0].notes,
          avgAmount: Number(avgAmount.toFixed(2)),
          frequency,
          typicalDay: avgDay,
          occurrences: txs.length,
          lastDate: sorted[sorted.length - 1].date
        };
      })
      .sort((a, b) => b.avgAmount - a.avgAmount);

    // ── Detect category tags ──────────────────────────────────────
    const fixedPatterns = /car.?pay|insurance|mortgage|rent|loan|tuition|child.?sup|child.?care|internet|phone.?bill|utilities|hoa|subscription.*annual/i;
    const cuttablePatterns = /eating.?out|restaurant|shopping|entertainment|gaming|hobby|personal.?care|clothing/i;

    const allSpendingCategories = Array.from(new Set(
      allTxs
        .filter(tx => Number(tx.amount) < 0 && !tx.transfer_id)
        .map(tx => categoryMap[tx.category] || "Uncategorized")
        .filter(n => n !== "Uncategorized")
    ));

    const suggestedTags = allSpendingCategories.map(name => {
      let tag = "reduce"; // default
      if (fixedPatterns.test(name)) tag = "fixed";
      else if (cuttablePatterns.test(name)) tag = "cuttable";
      return { category: name, suggestedTag: tag };
    }).sort((a, b) => {
      const order = { fixed: 0, reduce: 1, cuttable: 2 };
      return order[a.suggestedTag] - order[b.suggestedTag];
    });

    res.json({
      success: true,
      detectedPaychecks,
      suggestedTags,
      summary: {
        totalIncomeSourcesFound: detectedPaychecks.length,
        totalCategoriesFound: suggestedTags.length,
        fixedCount: suggestedTags.filter(t => t.suggestedTag === "fixed").length,
        reduceCount: suggestedTags.filter(t => t.suggestedTag === "reduce").length,
        cuttableCount: suggestedTags.filter(t => t.suggestedTag === "cuttable").length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/export-summary", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const twoMonthsAgo = getPreviousMonth(previousMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);
    const { start: tStart, end: tEnd } = getMonthRange(twoMonthsAgo);

    const [currentTxs, previousTxs, twoMonthAgoTxs, categories, allTxs, accounts] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      getAllTransactions(tStart, tEnd),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", cEnd),
      actualGet("/accounts")
    ]);

    const targets = loadTargets();
    const locked = loadLockedCategories();
    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);
    const twoMonthAgo = analyzeTransactions(twoMonthAgoTxs, categories);
    const recurringCharges = detectRecurringCharges(allTxs, categories);
    const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 75).sort((a, b) => b.averageAmount - a.averageAmount);

    const avgIncome = (previous.income + twoMonthAgo.income) / 2;
    const workingIncome = current.income < avgIncome * 0.5 ? avgIncome : current.income;

    const debtAccounts = accounts
      .filter(a => !a.closed && Number(a.balance_current || a.balance || 0) < 0)
      .map(a => ({ name: a.name, balance: Math.abs(Number(a.balance_current || a.balance || 0) / 100) }))
      .sort((a, b) => b.balance - a.balance);
    const totalDebt = debtAccounts.reduce((sum, a) => sum + a.balance, 0);

    const budgetStatus = Object.keys(targets).map(name => {
      const spent = current.spendingByCategory[name] || 0;
      const target = Number(targets[name]) || 0;
      return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number((target-spent).toFixed(2)), status: spent > target ? "over" : "under" };
    });

    const fixedMonthly = monthlyRecurring.reduce((sum, r) => sum + r.averageAmount, 0);
    const safeToSpend = Math.max(0, workingIncome - fixedMonthly);

    // Build HTML for PDF
    const [y, m] = currentMonth.split("-");
    const monthLabel = new Date(Number(y), Number(m)-1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 24px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 28px; font-weight: 700; margin: 0 0 4px; color: #1a1a1a; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card { background: #f5f5f7; border-radius: 12px; padding: 16px; }
  .card-label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .card-value { font-size: 22px; font-weight: 700; }
  .positive { color: #34c759; }
  .negative { color: #ff3b30; }
  .neutral { color: #1a1a1a; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e5e5; }
  .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row-label { color: #333; }
  .row-value { font-weight: 600; }
  .over { color: #ff3b30; }
  .under { color: #34c759; }
  .trend-row { display: flex; gap: 16px; margin-bottom: 12px; }
  .trend-card { flex: 1; background: #f5f5f7; border-radius: 8px; padding: 12px; }
  .trend-month { font-size: 11px; color: #888; margin-bottom: 2px; }
  .trend-income { font-size: 13px; color: #34c759; font-weight: 600; }
  .trend-spending { font-size: 13px; color: #ff3b30; font-weight: 600; }
  .trend-net { font-size: 12px; color: #666; margin-top: 2px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 12px; color: #999; text-align: center; }
  .locked-badge { background: #e8f5e9; color: #2e7d32; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
</style>
</head>
<body>
  <h1>Financial Summary</h1>
  <div class="subtitle">${monthLabel} · Generated by Vault for Actual</div>

  <div class="grid">
    <div class="card">
      <div class="card-label">Income</div>
      <div class="card-value neutral">$${workingIncome.toFixed(2)}</div>
      ${current.income < avgIncome * 0.5 ? '<div style="font-size:11px;color:#888;margin-top:4px;">Based on 3-month avg</div>' : ''}
    </div>
    <div class="card">
      <div class="card-label">Spending</div>
      <div class="card-value negative">$${current.spending.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="card-label">Net</div>
      <div class="card-value ${current.net >= 0 ? 'positive' : 'negative'}">${current.net >= 0 ? '+' : ''}$${current.net.toFixed(2)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">3-Month Trend</div>
    <div class="trend-row">
      ${[{label: twoMonthsAgo, data: twoMonthAgo}, {label: previousMonth, data: previous}, {label: currentMonth + " (current)", data: current}].map(m => {
        const [my, mm] = m.label.replace(" (current)", "").split("-");
        const ml = new Date(Number(my), Number(mm)-1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
        return `<div class="trend-card">
          <div class="trend-month">${ml}</div>
          <div class="trend-income">↑ $${m.data.income.toFixed(0)}</div>
          <div class="trend-spending">↓ $${m.data.spending.toFixed(0)}</div>
          <div class="trend-net">${m.data.net >= 0 ? '+' : ''}$${m.data.net.toFixed(0)}</div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Top Spending Categories</div>
    ${current.topCategories.map(c => {
      const isLocked = Object.keys(locked).includes(c.name);
      return `<div class="row">
        <div class="row-label">${c.name}${isLocked ? '<span class="locked-badge">Fixed</span>' : ''}</div>
        <div class="row-value">$${c.total.toFixed(2)}</div>
      </div>`;
    }).join('')}
  </div>

  ${budgetStatus.length > 0 ? `
  <div class="section">
    <div class="section-title">Budget Status</div>
    ${budgetStatus.map(b => `<div class="row">
      <div class="row-label">${b.name}</div>
      <div class="row-value ${b.status}">$${b.spent.toFixed(2)} / $${b.target.toFixed(2)}</div>
    </div>`).join('')}
  </div>` : ''}

  ${debtAccounts.length > 0 ? `
  <div class="section">
    <div class="section-title">Debt Accounts ($${totalDebt.toFixed(2)} total)</div>
    ${debtAccounts.map(a => `<div class="row">
      <div class="row-label">${a.name}</div>
      <div class="row-value negative">-$${a.balance.toFixed(2)}</div>
    </div>`).join('')}
  </div>` : ''}

  ${monthlyRecurring.length > 0 ? `
  <div class="section">
    <div class="section-title">Monthly Recurring ($${fixedMonthly.toFixed(2)}/mo)</div>
    ${monthlyRecurring.slice(0, 10).map(r => `<div class="row">
      <div class="row-label">${r.merchant}</div>
      <div class="row-value">$${r.averageAmount.toFixed(2)}/mo</div>
    </div>`).join('')}
  </div>` : ''}

  <div class="section">
    <div class="section-title">Quick Summary</div>
    <div class="row"><div class="row-label">Safe to spend this month</div><div class="row-value">$${safeToSpend.toFixed(2)}</div></div>
    <div class="row"><div class="row-label">Total debt</div><div class="row-value negative">$${totalDebt.toFixed(2)}</div></div>
    <div class="row"><div class="row-label">Fixed monthly bills</div><div class="row-value">$${fixedMonthly.toFixed(2)}</div></div>
  </div>

  <div class="footer">Generated by Vault for Actual · ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="vault-summary-${currentMonth}.html"`);
    res.send(html);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/smart-prompts", async (req, res) => {
  try {
    const currentMonth = getRequestedMonth(req);
    const previousMonth = getPreviousMonth(currentMonth);
    const { start: cStart, end: cEnd } = getMonthRange(currentMonth);
    const { start: pStart, end: pEnd } = getMonthRange(previousMonth);

    const [currentTxs, previousTxs, categories, allTxs] = await Promise.all([
      getAllTransactions(cStart, cEnd),
      getAllTransactions(pStart, pEnd),
      actualGet("/categories"),
      getAllTransactions("2024-01-01", cEnd)
    ]);

    const current = analyzeTransactions(currentTxs, categories);
    const previous = analyzeTransactions(previousTxs, categories);
    const recurringCharges = detectRecurringCharges(allTxs, categories);
    const locked = loadLockedCategories();
    const prefs = loadPreferences();
    const goals = prefs.goals || [];

    const prompts = [];

    // Income-based prompts
    const avgIncome = previous.income;
    if (current.income < avgIncome * 0.5) {
      prompts.push({ text: "I haven't been paid yet — what's my financial situation based on my usual income?", category: "income" });
    }

    // Spending anomaly prompts
    const allNames = Array.from(new Set([...Object.keys(current.spendingByCategory), ...Object.keys(previous.spendingByCategory)]));
    const anomalies = allNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      const pct = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
      return { name, curr, prev, pct };
    }).filter(a => a.pct > 30 && a.curr > 100).sort((a, b) => b.pct - a.pct);

    if (anomalies.length > 0) {
      prompts.push({ text: `I spent more on ${anomalies[0].name} this month — what should I do about it?`, category: "spending" });
    }

    // Win prompts
    const wins = allNames.map(name => {
      const curr = current.spendingByCategory[name] || 0;
      const prev = previous.spendingByCategory[name] || 0;
      return { name, saved: prev - curr };
    }).filter(w => w.saved > 100).sort((a, b) => b.saved - a.saved);

    if (wins.length > 0) {
      prompts.push({ text: `I spent less on ${wins[0].name} this month — am I on track?`, category: "win" });
    }

    // Debt prompts
    if (goals.length > 0) {
      prompts.push({ text: `Am I on track to meet my goal of paying off ${goals[0].accountName} by ${goals[0].targetDate}?`, category: "goal" });
    } else {
      prompts.push({ text: "Which of my debts should I focus on first?", category: "debt" });
    }

    // Recurring prompts
    const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 80);
    if (monthlyRecurring.length >= 8) {
      prompts.push({ text: `I have ${monthlyRecurring.length} recurring charges — which ones should I consider canceling?`, category: "subscriptions" });
    }

    // Net prompt
    if (current.net < 0) {
      prompts.push({ text: "I'm spending more than I earn this month — what's the fastest way to fix that?", category: "urgent" });
    } else {
      prompts.push({ text: `I have a $${current.net.toFixed(0)} surplus this month — what's the smartest thing to do with it?`, category: "surplus" });
    }

    // Locked category review prompts
    const reviewDue = getReviewDueCategories(locked);
    if (reviewDue.length > 0) {
      prompts.push({ text: `It's been 3 months since I locked ${reviewDue[0].name} — should we revisit it?`, category: "review" });
    }

    // Always include these fallback prompts
    prompts.push({ text: "What's my safe to spend amount this month?", category: "general" });
    prompts.push({ text: "Based on my last 3 months, what budgets should I set?", category: "budget" });

    // Return top 5 most relevant
    res.json({ success: true, prompts: prompts.slice(0, 5), month: currentMonth });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/update-transaction-notes", async (req, res) => {
  try {
    const { transactionId, notes, accountId } = req.body;
    if (!transactionId) return res.status(400).json({ success: false, error: "Missing transactionId" });
    await actualPatch(`/transactions/${transactionId}`, {
      transaction: { notes: notes || "" }
    });
    res.json({ success: true, transactionId, notes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/paycheck-reminder", async (req, res) => {
  try {
    const prefs = loadPreferences();
    const paycheck = prefs.paycheck;
    const today = new Date();
    const todayDay = today.getDate();

    if (!paycheck || !paycheck.dayOfMonth) {
      return res.json({ success: true, hasReminder: false, message: "No paycheck schedule set" });
    }

    // Calculate next payday
    const days = [paycheck.dayOfMonth];
    if (paycheck.dayOfMonth2 && paycheck.dayOfMonth2 !== paycheck.dayOfMonth) {
      days.push(paycheck.dayOfMonth2);
    }
    days.sort((a, b) => a - b);

    let nextPayday = null;
    let daysUntilPayday = null;

    for (const day of days) {
      if (day > todayDay) {
        nextPayday = new Date(today.getFullYear(), today.getMonth(), day);
        daysUntilPayday = day - todayDay;
        break;
      }
    }

    if (!nextPayday) {
      // Next month's first payday
      nextPayday = new Date(today.getFullYear(), today.getMonth() + 1, days[0]);
      daysUntilPayday = Math.ceil((nextPayday - today) / (1000 * 60 * 60 * 24));
    }

    // Get upcoming bills in the next daysUntilPayday days
    const currentMonth = getRequestedMonth(req);
    const allTxs = await getAllTransactions("2024-01-01", new Date().toISOString().slice(0, 10));
    const categories = await actualGet("/categories");
    const recurringCharges = detectRecurringCharges(allTxs, categories);

    const upcomingBills = recurringCharges
      .filter(r => r.frequency === "monthly" && r.confidence >= 80)
      .filter(r => {
        const lastDay = Number(String(r.latestDate).slice(-2));
        const nextBillDay = lastDay;
        return nextBillDay > todayDay && nextBillDay <= (todayDay + daysUntilPayday);
      })
      .sort((a, b) => b.averageAmount - a.averageAmount);

    const totalUpcoming = upcomingBills.reduce((sum, b) => sum + b.averageAmount, 0);
    const paydayLabel = nextPayday.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    let message = "";
    if (daysUntilPayday === 0) {
      message = `Payday today! 🎉 You have $${paycheck.amount.toFixed(2)} coming in.`;
    } else if (daysUntilPayday === 1) {
      message = `Payday tomorrow (${paydayLabel}).`;
    } else {
      message = `Payday in ${daysUntilPayday} days (${paydayLabel}).`;
    }

    if (upcomingBills.length > 0) {
      message += ` You have ${upcomingBills.length} bill${upcomingBills.length > 1 ? "s" : ""} due before then totaling $${totalUpcoming.toFixed(2)}.`;
    }

    res.json({
      success: true,
      hasReminder: true,
      daysUntilPayday,
      nextPayday: nextPayday.toISOString().slice(0, 10),
      paydayLabel,
      expectedAmount: paycheck.amount,
      upcomingBills: upcomingBills.slice(0, 5).map(b => ({
        merchant: b.merchant,
        amount: b.averageAmount,
        categoryName: b.categoryName
      })),
      totalUpcoming: Number(totalUpcoming.toFixed(2)),
      message
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Vault for Actual backend running on http://localhost:${PORT}`);
  console.log(`Connected to actual-http-api at ${ACTUAL_HTTP_API_URL}`);
});
