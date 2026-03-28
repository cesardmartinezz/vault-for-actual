const express = require("express");
const cors = require("cors");
require("dotenv").config();

const actual = require("@actual-app/api");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

function loadTargets() {
  try {
    const data = fs.readFileSync(path.join(__dirname, "targets.json"), "utf-8");
    return JSON.parse(data);
  } catch { return {}; }
}

function loadAPRRates() {
  try {
    const data = fs.readFileSync(path.join(__dirname, "apr-rates.json"), "utf-8");
    return JSON.parse(data);
  } catch { return {}; }
}

function saveAPRRates(rates) {
  fs.writeFileSync(path.join(__dirname, "apr-rates.json"), JSON.stringify(rates, null, 2));
}

const app = express();
let actualRequestQueue = Promise.resolve();

function runActualSafely(task) {
  const run = actualRequestQueue.then(async () => {
    try { return await task(); } catch (error) { throw error; }
  });
  actualRequestQueue = run.catch(() => {});
  return run;
}

const PORT = process.env.PORT || 3000;
const ACTUAL_BASE_URL = process.env.ACTUAL_BASE_URL;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// DYNAMIC CATEGORY HELPERS — works for ANY Actual Budget setup
// No hardcoded UUIDs or category names
// ─────────────────────────────────────────────────────────────

function buildCategoryMap(categories) {
  const categoryMap = {};
  function collect(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && item.id && item.name) categoryMap[item.id] = item.name.trim();
      if (item && Array.isArray(item.categories)) collect(item.categories);
      if (item && Array.isArray(item.children)) collect(item.children);
    }
  }
  collect(categories);
  return categoryMap;
}

// Build full category context dynamically from any Actual Budget setup
function buildCategoryContext(categories) {
  const categoryMap = buildCategoryMap(categories);
  const incomeCategoryIds = new Set();
  const transferCategoryIds = new Set();

  // Detect income groups by group name
  function detectGroups(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const groupName = (item.name || "").toLowerCase().trim();
      // If this is a group with income-like name, all its categories are income
      if (item.categories && (
        groupName === "income" ||
        groupName.startsWith("income") ||
        groupName.includes("revenue") ||
        groupName.includes("earnings") ||
        groupName.includes("salary") ||
        groupName.includes("wages") ||
        groupName.includes("ingresos")
      )) {
        (item.categories || []).forEach(c => { if (c && c.id) incomeCategoryIds.add(c.id); });
      }
      if (item.children) detectGroups(item.children);
    }
  }
  detectGroups(categories);

  // Detect transfer/payment categories by name patterns
  const transferPatterns = [
    /credit.?card.?pay/i,
    /cc.?pay/i,
    /card.?pay/i,
    /^transfers?$/i,
    /^transfer$/i,
    /payment.*transfer/i,
    /internal.*transfer/i,
    /account.*transfer/i,
    /pago.*tarjeta/i,
    /transferencia/i,
    /^child.?support$/i,
    /^child support$/i,
  ];

  for (const [id, name] of Object.entries(categoryMap)) {
    if (transferPatterns.some(p => p.test(name))) {
      transferCategoryIds.add(id);
    }
  }

  return { categoryMap, incomeCategoryIds, transferCategoryIds };
}

// Check if a category should be excluded from spending calculations
// Child support, ATM, work spending = real expenses, keep them
function isExcludedSpending(categoryId, categoryName, incomeCategoryIds, transferCategoryIds) {
  if (incomeCategoryIds.has(categoryId)) return true;
  if (transferCategoryIds.has(categoryId)) return true;
  const name = categoryName.toLowerCase().trim();
  // Investments and savings - not real spending
  if (/^invest/.test(name)) return true;
  if (/dividend/.test(name)) return true;
  if (/^savings/.test(name)) return true;
  if (/emergency.?fund/.test(name)) return true;
  // Transfers between accounts
  if (/^transfers?$/.test(name)) return true;
  // Credit card related - payments and interest are not spending
  if (/credit.?card/.test(name)) return true;
  // Income category itself
  if (/^income$/.test(name)) return true;
  return false;
}

// Check if a transaction is real income (not transfers, not investments)
function isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId) {
  if (Number(t.amount) === 0) return false;
  if (t.transfer_id) return false;
  if (startingBalancePayeeId && t.payee === startingBalancePayeeId) return false;
  if (Number(t.amount) <= 0) return false;

  const categoryName = categoryMap[t.category] || "Uncategorized";

  // Exclude transfer/payment categories
  if (transferCategoryIds.has(t.category)) return false;

  // Exclude investment and savings (they're not income)
  const excludePatterns = /invest|dividend|savings|transfer|credit.?card.?pay|interest.?charge|emergency.?fund/i;
  if (excludePatterns.test(categoryName)) return false;

  return true;
}

async function getStartingBalancePayeeId() {
  try {
    const payees = await actual.getPayees();
    const sb = payees.find(p => (p.name || "").toLowerCase().includes("starting balance"));
    return sb ? sb.id : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// MERCHANT NORMALIZATION
// ─────────────────────────────────────────────────────────────

function normalizeMerchantName(notes) {
  if (!notes) return "unknown";
  return notes.toLowerCase()
    .replace(/\*/g, " ").replace(/paypal\s*/g, "paypal ").replace(/aplpay\s*/g, "")
    .replace(/\b(payment|payments|purchase|member|membership|monthly|subscription|subscripti|autopay|auto pay|thank you|electronic|plan fee)\b/g, "")
    .replace(/\b(san francisco|new york city|new york|richfield|chestnut mountain|orange co|san diego|san clemente|ca|ny|gb|mn)\b/g, "")
    .replace(/\b(inc|llc|co|corp|ltd)\b/g, "")
    .replace(/[0-9]{3,}/g, "").replace(/[^a-z0-9&.+\- ]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalizeMerchantName(name) {
  if (!name) return "unknown";
  return name
    .replace(/^paypal /, "").replace(/^pp /, "").replace(/^sq /, "").replace(/^tst /, "").replace(/^pwp /, "")
    .replace(/\bchatgpt subs\b/g, "chatgpt").replace(/\bopenai chatgpt\b/g, "chatgpt")
    .replace(/\bprime video channels\b/g, "prime video").replace(/\bdisneyplus\b/g, "disney plus")
    .replace(/\byoutube premium\b/g, "youtube").replace(/\bapple\.com\/bi\b/g, "apple")
    .replace(/\bapplecare mnthly pla\b/g, "applecare").replace(/\bpeloton\b.*$/g, "peloton")
    .replace(/\bcox orange\b.*$/g, "cox").replace(/\bus mobile\b.*$/g, "us mobile")
    .replace(/\bford motor cr\b.*$/g, "ford motor").replace(/\baffirm\.com payme\b/g, "affirm")
    .replace(/\bgeico\b.*$/g, "geico").replace(/\bsoundcloud\b.*$/g, "soundcloud")
    .replace(/\bspotify usa\b/g, "spotify").replace(/\bclasspass\b.*$/g, "classpass")
    .replace(/\bpeacock\b.*$/g, "peacock").replace(/\bpaypal youtube\b/g, "youtube")
    .replace(/\bpaypal jagex\b/g, "jagex").replace(/\s+/g, " ")
    .replace(/\bmcdonald s f\b/g, "mcdonald's").replace(/\blowe s\b/g, "lowe's").trim();
}

function getPreviousMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getRequestedMonth(req) {
  const m = req.query.month;
  if (m && /^\d{4}-\d{2}$/.test(m)) return m;
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function summarizeMonthForAlerts(transactions, categories, monthKey, startingBalancePayeeId) {
  const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
  const monthTx = transactions.filter(t => t.date && t.date.startsWith(monthKey));
  let income = 0, spending = 0;
  const spendingByCategory = {}, largeTransactions = [];

  for (const t of monthTx) {
    const amount = Number(t.amount) / 100;
    const categoryName = categoryMap[t.category] || "Uncategorized";
    if (amount > 0) {
      if (isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId)) income += amount;
      continue;
    }
    const spend = Math.abs(amount);
    if (isExcludedSpending(t.category, categoryName, incomeCategoryIds, transferCategoryIds) || t.transfer_id) continue;
    spending += spend;
    spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + spend;
    if (spend >= 100) largeTransactions.push({ id: t.id, date: t.date, notes: t.notes || "No description", amount: Number(spend.toFixed(2)), categoryName });
  }

  const topCategories = Object.entries(spendingByCategory).map(([name, total]) => ({ name, total: Number(total.toFixed(2)) })).sort((a, b) => b.total - a.total).slice(0, 5);
  largeTransactions.sort((a, b) => b.amount - a.amount);
  return { income: Number(income.toFixed(2)), spending: Number(spending.toFixed(2)), net: Number((income - spending).toFixed(2)), topCategories, largeTransactions: largeTransactions.slice(0, 5) };
}

function summarizeCategorySpending(transactions, categories, monthKey) {
  const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
  const monthTx = transactions.filter(t => t.date && t.date.startsWith(monthKey));
  const spendingByCategory = {};
  for (const t of monthTx) {
    const amount = Number(t.amount) / 100;
    if (amount < 0) {
      const categoryName = categoryMap[t.category] || "Uncategorized";
      if (isExcludedSpending(t.category, categoryName, incomeCategoryIds, transferCategoryIds) || t.transfer_id) continue;
      spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + Math.abs(amount);
    }
  }
  return spendingByCategory;
}

function detectRecurringCharges(transactions, categories) {
  const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);

  const negTx = transactions
    .filter(t => Number(t.amount) < 0 && !t.transfer_id)
    .map(t => {
      const categoryName = categoryMap[t.category] || "Uncategorized";
      return {
        id: t.id, date: t.date, notes: t.notes || "",
        merchant: canonicalizeMerchantName(normalizeMerchantName(t.notes || "")),
        amount: Number(Math.abs(Number(t.amount) / 100).toFixed(2)),
        categoryName, rawCategoryId: t.category
      };
    })
    .filter(t => {
      if (isExcludedSpending(t.rawCategoryId, t.categoryName, incomeCategoryIds, transferCategoryIds)) return false;
      return t.merchant && t.merchant !== "unknown";
    });

  const grouped = {};
  for (const t of negTx) {
    const key = `${t.merchant}__${t.categoryName}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }

  return Object.values(grouped).map(items => {
    const sorted = items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const count = sorted.length;
    if (count < 2) return null;
    const amounts = sorted.map(x => x.amount);
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const minAmount = Math.min(...amounts), maxAmount = Math.max(...amounts);
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
    if (count >= 3) confidence += 40; else if (count === 2) confidence += 20;
    if (frequency === "monthly") confidence += 35; else if (["weekly","biweekly"].includes(frequency)) confidence += 25;
    if (amountSpread <= 5) confidence += 25; else if (amountSpread <= 15) confidence += 15; else if (amountSpread <= 25) confidence += 5;
    confidence = Math.min(confidence, 100);
    if (confidence < 50) return null;
    const latest = sorted[sorted.length - 1];
    return { merchant: latest.merchant, categoryName: latest.categoryName, count, averageAmount: Number(avgAmount.toFixed(2)), latestAmount: latest.amount, latestDate: latest.date, frequency, confidence, samples: sorted.slice(-3) };
  }).filter(Boolean).sort((a, b) => b.confidence - a.confidence || b.averageAmount - a.averageAmount);
}

function summarizeRecurringChanges(recurringCharges) {
  const monthlyItems = recurringCharges.filter(item => item.frequency === "monthly" && item.confidence >= 80);
  const newRecurring = monthlyItems.filter(item => item.count === 2);
  const changedAmount = monthlyItems.filter(item => {
    if (!Array.isArray(item.samples) || item.samples.length < 2) return false;
    const amounts = item.samples.map(s => Number(s.amount) || 0);
    const min = Math.min(...amounts), max = Math.max(...amounts);
    const avg = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    return avg > 0 && ((max - min) / avg) * 100 >= 10;
  });
  return { monthlyItems, newRecurring, changedAmount };
}

function buildAICoachAdvice({ summary, budgetStatus, alerts, categoryTrends, recurringSummary, recurringCharges }) {
  const priorities = [], debtAdvice = [], spendingAdvice = [], subscriptionAdvice = [];
  let score = 100;
  const overBudget = budgetStatus.filter(i => i.status === "over").sort((a,b) => Math.abs(b.remaining) - Math.abs(a.remaining));
  const nearLimit = budgetStatus.filter(i => i.status === "under" && i.percentUsed >= 85).sort((a,b) => b.percentUsed - a.percentUsed);
  const rising = categoryTrends.filter(i => i.change > 0).sort((a,b) => b.change - a.change);
  const monthlySubs = recurringCharges.filter(i => i.frequency === "monthly" && i.confidence >= 80);

  if (summary.net < 0) {
    score -= 30;
    priorities.push(`You are overspending by $${Math.abs(summary.net).toFixed(2)} this month.`);
    debtAdvice.push("Pause aggressive extra debt payments until monthly cash flow is positive again.");
  } else {
    const safe = Math.max(summary.net * 0.35, 0), agg = Math.max(summary.net * 0.60, 0);
    debtAdvice.push(`Your current monthly surplus is about $${summary.net.toFixed(2)}.`);
    debtAdvice.push(`Conservative extra debt payment: $${safe.toFixed(2)}/month. Aggressive: $${agg.toFixed(2)}/month.`);
    priorities.push(`Use your surplus to attack debt. Target range: $${safe.toFixed(2)} to $${agg.toFixed(2)}/month.`);
  }
  if (overBudget.length > 0) { score -= Math.min(overBudget.length * 8, 24); priorities.push(`${overBudget[0].name} is over budget by $${Math.abs(overBudget[0].remaining).toFixed(2)}.`); overBudget.slice(0,3).forEach(i => spendingAdvice.push(`${i.name} is over target by $${Math.abs(i.remaining).toFixed(2)}.`)); }
  if (nearLimit.length > 0) { score -= 5; nearLimit.slice(0,2).forEach(i => spendingAdvice.push(`${i.name} is at ${i.percentUsed.toFixed(1)}% of target.`)); }
  if (rising.length > 0 && rising[0].percentChange >= 10) { score -= 8; priorities.push(`${rising[0].name} is up $${rising[0].change.toFixed(2)} vs last month.`); }
  if (recurringSummary.monthlyCount >= 10) { score -= 10; priorities.push(`You have ${recurringSummary.monthlyCount} recurring charges. Review for cuts.`); }
  if (recurringSummary.newRecurringCount > 0) { score -= 6; subscriptionAdvice.push(`${recurringSummary.newRecurringCount} new recurring charges detected.`); }
  if (recurringSummary.changedAmountCount > 0) { score -= 4; subscriptionAdvice.push(`${recurringSummary.changedAmountCount} recurring charges changed amount recently.`); }
  monthlySubs.sort((a,b) => b.averageAmount - a.averageAmount).slice(0,5).forEach(i => subscriptionAdvice.push(`${i.merchant} averages $${i.averageAmount.toFixed(2)}/month.`));
  score = Math.max(1, Math.min(100, Math.round(score)));
  let healthLabel = "Strong";
  if (score < 80) healthLabel = "Stable";
  if (score < 65) healthLabel = "Needs Attention";
  if (score < 45) healthLabel = "High Risk";
  return { financialHealthScore: score, healthLabel, priorities: priorities.slice(0,5), debtAdvice: debtAdvice.slice(0,5), spendingAdvice: spendingAdvice.slice(0,5), subscriptionAdvice: subscriptionAdvice.slice(0,5) };
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ message: "Vault for Actual backend is running" }));

app.get("/health", (req, res) => res.json({
  backend: "ok", actualBaseUrl: ACTUAL_BASE_URL,
  hasPassword: !!ACTUAL_PASSWORD, hasSyncId: !!ACTUAL_SYNC_ID,
  openRouterModel: OPENROUTER_MODEL,
  timestamp: new Date().toISOString()
}));

app.get("/transactions", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const accounts = await actual.getAccounts();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const accountMap = Object.fromEntries(accounts.map(a => [a.id, a.name]));
      const { categoryMap } = buildCategoryContext(categories);
      const currentMonth = getRequestedMonth(req);
      const filtered = transactions.filter(t => t.date && t.date.startsWith(currentMonth));
      const cleaned = filtered.slice(0, 500).map(t => ({
        id: t.id, date: t.date, notes: t.notes || null,
        amount: Number((Number(t.amount) / 100).toFixed(2)),
        accountName: accountMap[t.account] || t.account || null,
        categoryName: categoryMap[t.category] || "Uncategorized",
        cleared: t.cleared || false
      }));
      return { success: true, count: filtered.length, showing: cleaned.length, transactions: cleaned };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.post("/update-transaction-category", async (req, res) => {
  try {
    const { transactionId, categoryId } = req.body;
    if (!transactionId || !categoryId) return res.status(400).json({ success: false, error: "Missing transactionId or categoryId" });
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      await actual.updateTransaction(transactionId, { category: categoryId });
      await actual.shutdown();
      return { success: true };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/insights", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
      const monthTx = transactions.filter(t => t.date && t.date.startsWith(currentMonth));
      let totalIncome = 0, totalSpending = 0;
      const spendingByCategory = {};
      for (const t of monthTx) {
        const amount = Number(t.amount) / 100;
        const categoryName = categoryMap[t.category] || "Uncategorized";
        if (amount > 0) { if (isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId)) totalIncome += amount; continue; }
        if (amount < 0) {
          if (isExcludedSpending(t.category, categoryName, incomeCategoryIds, transferCategoryIds) || t.transfer_id) continue;
          totalSpending += Math.abs(amount);
          spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + Math.abs(amount);
        }
      }
      const topCategories = Object.entries(spendingByCategory).map(([name, total]) => ({ name, total: Number(total.toFixed(2)) })).sort((a, b) => b.total - a.total).slice(0, 5);
      const net = Number((totalIncome - totalSpending).toFixed(2));
      const insights = [];
      if (net < 0) insights.push(`You are currently over budget this month by $${Math.abs(net).toFixed(2)}.`);
      else insights.push(`You are currently under budget this month by $${net.toFixed(2)}.`);
      if (topCategories.length > 0) insights.push(`Your highest spending area this month is ${topCategories[0].name} at $${topCategories[0].total.toFixed(2)}.`);
      if (topCategories.length > 1) insights.push(`Your second highest spending area is ${topCategories[1].name} at $${topCategories[1].total.toFixed(2)}.`);
      if (totalSpending > totalIncome) insights.push("Focus on reducing discretionary spending this month so your spending drops below your income.");
      return { success: true, month: currentMonth, summary: { income: Number(totalIncome.toFixed(2)), spending: Number(totalSpending.toFixed(2)), net }, topCategories, insights };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const targets = loadTargets();
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const previousMonth = getPreviousMonth(currentMonth);
      const currentSummary = summarizeMonthForAlerts(transactions, categories, currentMonth, startingBalancePayeeId);
      const previousSummary = summarizeMonthForAlerts(transactions, categories, previousMonth, startingBalancePayeeId);
      const currentSpending = summarizeCategorySpending(transactions, categories, currentMonth);
      const previousSpending = summarizeCategorySpending(transactions, categories, previousMonth);
      const allNames = Array.from(new Set([...Object.keys(currentSpending), ...Object.keys(previousSpending)]));
      const categoryTrends = allNames.map(name => {
        const current = currentSpending[name] || 0, previous = previousSpending[name] || 0;
        const change = current - previous;
        const percentChange = previous > 0 ? (change / previous) * 100 : current > 0 ? 100 : 0;
        return { name, current: Number(current.toFixed(2)), previous: Number(previous.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
      }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      const budgetStatus = Object.keys(targets).map(name => {
        const spent = currentSpending[name] || 0, target = Number(targets[name]) || 0;
        const remaining = target - spent, percentUsed = target > 0 ? (spent / target) * 100 : 0;
        return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: remaining < 0 ? "over" : "under" };
      });
      const recurringDetection = detectRecurringCharges(transactions, categories);
      const recurringSummary = summarizeRecurringChanges(Array.isArray(recurringDetection) ? recurringDetection : []);
      const alerts = [];
      if (currentSummary.net < 0) alerts.push({ level: "warning", title: "Over budget", message: `You are over budget by $${Math.abs(currentSummary.net).toFixed(2)} this month.` });
      if (previousSummary.spending > 0 && currentSummary.spending > previousSummary.spending) { const diff = currentSummary.spending - previousSummary.spending, pct = (diff / previousSummary.spending) * 100; if (pct >= 10) alerts.push({ level: "warning", title: "Spending increased", message: `Your spending is up $${diff.toFixed(2)} (${pct.toFixed(1)}%) versus ${previousMonth}.` }); }
      const biggestTrend = categoryTrends.find(i => i.change > 0);
      if (biggestTrend && biggestTrend.percentChange >= 10) alerts.push({ level: "info", title: "Largest category increase", message: `${biggestTrend.name} is up $${biggestTrend.change.toFixed(2)} (${biggestTrend.percentChange.toFixed(1)}%) versus ${previousMonth}.` });
      const overBudget = budgetStatus.filter(i => i.status === "over").sort((a,b) => Math.abs(b.remaining) - Math.abs(a.remaining));
      if (overBudget.length > 0) { const w = overBudget[0]; alerts.push({ level: "warning", title: "Category over target", message: `${w.name} is over target by $${Math.abs(w.remaining).toFixed(2)} this month.` }); }
      const nearLimit = budgetStatus.filter(i => i.status === "under" && i.percentUsed >= 80).sort((a,b) => b.percentUsed - a.percentUsed);
      if (nearLimit.length > 0) { const n = nearLimit[0]; alerts.push({ level: "info", title: "Approaching target", message: `${n.name} has used ${n.percentUsed.toFixed(1)}% of its budget target.` }); }
      if (currentSummary.topCategories.length > 0) { const top = currentSummary.topCategories[0]; const share = currentSummary.spending > 0 ? (top.total / currentSummary.spending) * 100 : 0; if (share >= 25) alerts.push({ level: "info", title: "Top category concentration", message: `${top.name} makes up ${share.toFixed(1)}% of this month's spending.` }); }
      if (currentSummary.largeTransactions.length > 0) { const l = currentSummary.largeTransactions[0]; alerts.push({ level: "info", title: "Largest recent expense", message: `${l.notes} was $${l.amount.toFixed(2)} on ${l.date}.` }); }
      if (recurringSummary.newRecurring.length > 0) { const n = recurringSummary.newRecurring[0]; alerts.push({ level: "info", title: "New recurring charge detected", message: `${n.merchant} looks like a new monthly recurring charge at about $${n.averageAmount.toFixed(2)}.` }); }
      if (recurringSummary.changedAmount.length > 0) { const c = recurringSummary.changedAmount[0]; const amounts = c.samples.map(s => Number(s.amount) || 0); alerts.push({ level: "info", title: "Recurring amount changed", message: `${c.merchant} has varied between $${Math.min(...amounts).toFixed(2)} and $${Math.max(...amounts).toFixed(2)} recently.` }); }
      if (alerts.length === 0) alerts.push({ level: "good", title: "No major issues detected", message: "This month looks stable based on your current spending patterns." });
      return { success: true, month: currentMonth, previousMonth, summary: currentSummary, alerts, categoryTrends: categoryTrends.slice(0, 5), budgetStatus, recurringSummary: { monthlyCount: recurringSummary.monthlyItems.length, newRecurringCount: recurringSummary.newRecurring.length, changedAmountCount: recurringSummary.changedAmount.length } };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/accounts-summary", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const accounts = await actual.getAccounts();
      const transactions = await actual.getTransactions();
      await actual.shutdown();
      const accountSummaries = accounts.map(account => {
        const balance = transactions.filter(t => t.account === account.id).reduce((sum, t) => sum + Number(t.amount || 0), 0) / 100;
        return { id: account.id, name: account.name, offbudget: account.offbudget || false, closed: account.closed || false, balance: Number(balance.toFixed(2)), type: balance < 0 ? "debt" : "asset" };
      });
      const open = accountSummaries.filter(a => !a.closed);
      const totalAssets = open.filter(a => a.type === "asset").reduce((sum, a) => sum + a.balance, 0);
      const totalDebts = open.filter(a => a.type === "debt").reduce((sum, a) => sum + Math.abs(a.balance), 0);
      return { success: true, summary: { totalAccounts: open.length, totalAssets: Number(totalAssets.toFixed(2)), totalDebts: Number(totalDebts.toFixed(2)), netWorth: Number((totalAssets - totalDebts).toFixed(2)) }, accounts: open.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)) };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/account-transactions", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      const accountId = req.query.accountId;
      if (!accountId) return { success: false, error: "Missing accountId" };
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const accounts = await actual.getAccounts();
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const account = accounts.find(a => a.id === accountId);
      if (!account) return { success: false, error: "Account not found" };
      const { categoryMap } = buildCategoryContext(categories);
      const allTx = transactions.filter(t => t.account === accountId);
      const balance = allTx.reduce((sum, t) => sum + Number(t.amount || 0), 0) / 100;
      const accountTx = allTx.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 100).map(t => ({
        id: t.id, date: t.date, notes: t.notes || null,
        amount: Number((Number(t.amount) / 100).toFixed(2)),
        accountName: account.name,
        categoryName: categoryMap[t.category] || "Uncategorized",
        cleared: t.cleared || false
      }));
      return { success: true, account: { id: account.id, name: account.name, offbudget: account.offbudget || false, closed: account.closed || false, balance: Number(balance.toFixed(2)), type: balance < 0 ? "debt" : "asset" }, transactions: accountTx };
    });
    if (result.success === false && result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/budget", async (req, res) => {
  try {
    const targets = loadTargets();
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const spending = summarizeCategorySpending(transactions, categories, currentMonth);
      const budget = Object.keys(targets).map(name => {
        const spent = spending[name] || 0, target = Number(targets[name]) || 0;
        const remaining = target - spent, percentUsed = target > 0 ? (spent / target) * 100 : 0;
        return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: remaining < 0 ? "over" : "under" };
      });
      return { success: true, month: currentMonth, budget };
    });
    res.json(result);
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
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      return { success: true, recurringCharges: detectRecurringCharges(transactions, categories) };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/ai-coach", async (req, res) => {
  try {
    const targets = loadTargets();
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const previousMonth = getPreviousMonth(currentMonth);
      const currentSummary = summarizeMonthForAlerts(transactions, categories, currentMonth, startingBalancePayeeId);
      const currentSpending = summarizeCategorySpending(transactions, categories, currentMonth);
      const previousSpending = summarizeCategorySpending(transactions, categories, previousMonth);
      const allNames = Array.from(new Set([...Object.keys(currentSpending), ...Object.keys(previousSpending)]));
      const categoryTrends = allNames.map(name => {
        const current = currentSpending[name] || 0, previous = previousSpending[name] || 0;
        const change = current - previous;
        const percentChange = previous > 0 ? (change / previous) * 100 : current > 0 ? 100 : 0;
        return { name, current: Number(current.toFixed(2)), previous: Number(previous.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
      }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      const budgetStatus = Object.keys(targets).map(name => {
        const spent = currentSpending[name] || 0, target = Number(targets[name]) || 0;
        const remaining = target - spent, percentUsed = target > 0 ? (spent / target) * 100 : 0;
        return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number(remaining.toFixed(2)), percentUsed: Number(percentUsed.toFixed(1)), status: remaining < 0 ? "over" : "under" };
      });
      const alerts = [];
      if (currentSummary.net < 0) alerts.push({ level: "warning", title: "Over budget", message: `You are over budget by $${Math.abs(currentSummary.net).toFixed(2)} this month.` });
      const overBudget = budgetStatus.filter(i => i.status === "over");
      if (overBudget.length > 0) alerts.push({ level: "warning", title: "Category over target", message: `${overBudget[0].name} is over target by $${Math.abs(overBudget[0].remaining).toFixed(2)} this month.` });
      const recurringDetection = detectRecurringCharges(transactions, categories);
      const recurringSummary = summarizeRecurringChanges(Array.isArray(recurringDetection) ? recurringDetection : []);
      const coach = buildAICoachAdvice({ summary: currentSummary, budgetStatus, alerts, categoryTrends, recurringSummary, recurringCharges: Array.isArray(recurringDetection) ? recurringDetection : [] });
      return { success: true, month: currentMonth, previousMonth, summary: currentSummary, ...coach, recurringSummary: { monthlyCount: recurringSummary.monthlyItems.length, newRecurringCount: recurringSummary.newRecurring.length, changedAmountCount: recurringSummary.changedAmount.length } };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/categories", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const categories = await actual.getCategories();
      await actual.shutdown();
      const { categoryMap } = buildCategoryContext(categories);
      const unique = Array.from(new Map(Object.entries(categoryMap).map(([id, name]) => [id, { id, name }])).values()).sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, categories: unique };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/category-trends", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const previousMonth = getPreviousMonth(currentMonth);
      const currentSpending = summarizeCategorySpending(transactions, categories, currentMonth);
      const previousSpending = summarizeCategorySpending(transactions, categories, previousMonth);
      const allNames = Array.from(new Set([...Object.keys(currentSpending), ...Object.keys(previousSpending)]));
      const categoryTrends = allNames.map(name => {
        const current = currentSpending[name] || 0, previous = previousSpending[name] || 0;
        const change = current - previous;
        const percentChange = previous > 0 ? (change / previous) * 100 : current > 0 ? 100 : 0;
        return { name, current: Number(current.toFixed(2)), previous: Number(previous.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)) };
      }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      return { success: true, month: currentMonth, previousMonth, categoryTrends };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/forecast", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
      const today = new Date();
      const currentDayOfMonth = today.getDate();
      const monthTx = transactions.filter(t => t.date && t.date.startsWith(currentMonth));
      const expenseTx = monthTx.filter(t => {
        if (Number(t.amount) >= 0 || t.transfer_id) return false;
        const name = categoryMap[t.category] || "Uncategorized";
        return !isExcludedSpending(t.category, name, incomeCategoryIds, transferCategoryIds);
      });
      const incomeTx = monthTx.filter(t => Number(t.amount) > 0 && isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId));
      const totalSpent = expenseTx.reduce((sum, t) => sum + Math.abs(Number(t.amount) / 100), 0);
      const totalIncome = incomeTx.reduce((sum, t) => sum + Number(t.amount) / 100, 0);
      const dailyAvg = currentDayOfMonth > 0 ? totalSpent / currentDayOfMonth : 0;
      const daysInMonth = new Date(Number(currentMonth.slice(0,4)), Number(currentMonth.slice(5,7)), 0).getDate();
      const daysRemaining = Math.max(daysInMonth - currentDayOfMonth, 0);
      const recurringCharges = detectRecurringCharges(transactions, categories);
      const remainingRecurring = recurringCharges.filter(i => i.frequency === "monthly" && i.confidence >= 80).reduce((sum, i) => { const day = Number(String(i.latestDate).slice(-2)); return day > currentDayOfMonth ? sum + i.latestAmount : sum; }, 0);
      const projectedTotal = totalSpent + (dailyAvg * daysRemaining) + remainingRecurring;
      const projectedNet = totalIncome - projectedTotal;
      let runwayStatus = "Stable";
      if (projectedNet < 0) runwayStatus = "Risk";
      if (projectedNet < -250) runwayStatus = "High Risk";
      return { success: true, month: currentMonth, forecast: { totalSpentSoFar: Number(totalSpent.toFixed(2)), totalIncomeSoFar: Number(totalIncome.toFixed(2)), dailyAverageSpend: Number(dailyAvg.toFixed(2)), projectedVariableSpendRemaining: Number((dailyAvg * daysRemaining).toFixed(2)), remainingRecurringThisMonth: Number(remainingRecurring.toFixed(2)), projectedTotalMonthSpend: Number(projectedTotal.toFixed(2)), projectedNetEndOfMonth: Number(projectedNet.toFixed(2)), daysRemaining, runwayStatus } };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/monthly-trends", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
      const currentMonth = getRequestedMonth(req);
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const [year, month] = currentMonth.split("-").map(Number);
        const date = new Date(year, month - 1 - i, 1);
        months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
      }
      const monthlyData = months.map(monthKey => {
        const monthTx = transactions.filter(t => t.date && t.date.startsWith(monthKey));
        let income = 0, spending = 0;
        const spendingByCategory = {};
        for (const t of monthTx) {
          const amount = Number(t.amount) / 100;
          const categoryName = categoryMap[t.category] || "Uncategorized";
          if (amount > 0) { if (isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId)) income += amount; continue; }
          if (amount < 0) {
            if (isExcludedSpending(t.category, categoryName, incomeCategoryIds, transferCategoryIds) || t.transfer_id) continue;
            spending += Math.abs(amount);
            spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + Math.abs(amount);
          }
        }
        const [y, m] = monthKey.split("-");
        const label = new Date(Number(y), Number(m)-1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
        return { month: monthKey, label, income: Number(income.toFixed(2)), spending: Number(spending.toFixed(2)), net: Number((income-spending).toFixed(2)), topCategories: Object.entries(spendingByCategory).map(([name, total]) => ({ name, total: Number(total.toFixed(2)) })).sort((a,b) => b.total - a.total).slice(0, 5), _all: spendingByCategory };
      });
      const allCategoryNames = Array.from(new Set(monthlyData.flatMap(m => Object.keys(m._all))));
      const categoryTrends = allCategoryNames.map(name => ({ name, data: monthlyData.map(m => ({ month: m.month, label: m.label, total: Number((m._all[name] || 0).toFixed(2)) })) })).sort((a,b) => { const aL = a.data[a.data.length-1]?.total || 0, bL = b.data[b.data.length-1]?.total || 0; return bL - aL; });
      const cleanMonths = monthlyData.map(({ _all, ...rest }) => rest);
      return { success: true, months: cleanMonths, categoryTrends };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/merchant-insights", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const currentMonth = getRequestedMonth(req);
      const previousMonth = getPreviousMonth(currentMonth);
      const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);

      function getMerchant(t) { return canonicalizeMerchantName(normalizeMerchantName(t.notes || "")); }

      const filterSpending = (tx, month) => tx.filter(t => {
        if (!t.date || !t.date.startsWith(month) || Number(t.amount) >= 0 || t.transfer_id) return false;
        const name = categoryMap[t.category] || "Uncategorized";
        return !isExcludedSpending(t.category, name, incomeCategoryIds, transferCategoryIds);
      });

      const currentTx = filterSpending(transactions, currentMonth);
      const prevTx = filterSpending(transactions, previousMonth);

      const merchantMap = {};
      for (const t of currentTx) {
        const merchant = getMerchant(t);
        if (!merchant || merchant === "unknown") continue;
        const amount = Math.abs(Number(t.amount) / 100);
        const categoryName = categoryMap[t.category] || "Uncategorized";
        if (!merchantMap[merchant]) merchantMap[merchant] = { name: merchant, totalSpent: 0, visitCount: 0, categoryName, transactions: [] };
        merchantMap[merchant].totalSpent += amount;
        merchantMap[merchant].visitCount += 1;
        merchantMap[merchant].transactions.push({ date: t.date, amount: Number(amount.toFixed(2)) });
      }

      const prevMerchantMap = {};
      for (const t of prevTx) {
        const merchant = getMerchant(t);
        if (!merchant || merchant === "unknown") continue;
        const amount = Math.abs(Number(t.amount) / 100);
        prevMerchantMap[merchant] = (prevMerchantMap[merchant] || 0) + amount;
      }

      const merchants = Object.values(merchantMap).map(m => {
        const prev = prevMerchantMap[m.name] || 0;
        const change = m.totalSpent - prev;
        const percentChange = prev > 0 ? ((change / prev) * 100) : m.totalSpent > 0 ? 100 : 0;
        return { name: m.name, categoryName: m.categoryName, totalSpent: Number(m.totalSpent.toFixed(2)), visitCount: m.visitCount, avgPerVisit: Number((m.totalSpent / m.visitCount).toFixed(2)), previousMonthTotal: Number(prev.toFixed(2)), change: Number(change.toFixed(2)), percentChange: Number(percentChange.toFixed(1)), lastVisit: m.transactions.sort((a,b) => String(b.date).localeCompare(String(a.date)))[0]?.date || "" };
      }).filter(m => m.totalSpent > 0).sort((a, b) => b.totalSpent - a.totalSpent);

      const totalSpend = merchants.reduce((sum, m) => sum + m.totalSpent, 0);
      return {
        success: true, month: currentMonth, previousMonth,
        summary: { totalMerchants: merchants.length, totalSpend: Number(totalSpend.toFixed(2)), avgPerMerchant: merchants.length > 0 ? Number((totalSpend / merchants.length).toFixed(2)) : 0 },
        topBySpend: merchants.slice(0, 10),
        topByFrequency: [...merchants].sort((a, b) => b.visitCount - a.visitCount).slice(0, 10),
        newMerchants: merchants.filter(m => m.previousMonthTotal === 0).slice(0, 5),
        biggestIncreases: merchants.filter(m => m.change > 0 && m.previousMonthTotal > 0).sort((a, b) => b.change - a.change).slice(0, 5)
      };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/debt-tracker", async (req, res) => {
  try {
    const aprRates = loadAPRRates();
    const extraPayment = Number(req.query.extra) || 0;
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const accounts = await actual.getAccounts();
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      await actual.shutdown();
      const { categoryMap, transferCategoryIds } = buildCategoryContext(categories);

      const debtAccounts = accounts.filter(a => !a.closed).map(account => {
        const accountTx = transactions.filter(t => t.account === account.id);
        const balance = accountTx.reduce((sum, t) => sum + Number(t.amount || 0), 0) / 100;
        if (balance >= 0) return null;
        const debt = Math.abs(balance);

        const payments = accountTx.filter(t => {
          if (Number(t.amount) <= 0) return false;
          const name = categoryMap[t.category] || "Uncategorized";
          return transferCategoryIds.has(t.category) || /credit.?card.?pay|card.?pay|transfer/i.test(name);
        }).map(t => ({ date: t.date, amount: Number(t.amount) / 100 })).sort((a, b) => String(b.date).localeCompare(String(a.date)));

        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 7);
        const recentPayments = payments.filter(p => p.date && p.date.slice(0, 7) >= threeMonthsAgoStr);
        const avgMonthlyPayment = recentPayments.length > 0 ? recentPayments.reduce((sum, p) => sum + p.amount, 0) / 3 : 0;
        const lastPayment = payments[0] || null;
        const monthsToPayoff = avgMonthlyPayment > 0 ? Math.ceil(debt / avgMonthlyPayment) : null;
        let payoffDate = null;
        if (monthsToPayoff) { const d = new Date(); d.setMonth(d.getMonth() + monthsToPayoff); payoffDate = d.toISOString().slice(0, 7); }
        const monthsWithExtra100 = avgMonthlyPayment > 0 ? Math.ceil(debt / (avgMonthlyPayment + 100)) : null;
        const monthsSaved100 = monthsToPayoff && monthsWithExtra100 ? monthsToPayoff - monthsWithExtra100 : null;
        const totalPaymentWithExtra = avgMonthlyPayment + extraPayment;
        const monthsToPayoffWithExtra = totalPaymentWithExtra > 0 && extraPayment > 0 ? Math.ceil(debt / totalPaymentWithExtra) : null;
        const monthsSavedWithCustomExtra = monthsToPayoff && monthsToPayoffWithExtra ? monthsToPayoff - monthsToPayoffWithExtra : null;
        const apr = aprRates[account.id] || null;
        const monthlyInterest = apr && debt > 0 ? Number(((apr / 100 / 12) * debt).toFixed(2)) : null;
        const lowerName = (account.name || "").toLowerCase();
        const isLoan = /loan|ford|usaa|auto|mortgage/i.test(lowerName);
        const isCard = /visa|card|amex|mastercard|sapphire|platinum|robinhood|amazon/i.test(lowerName);
        return { id: account.id, name: account.name, type: isLoan ? "loan" : isCard ? "credit_card" : "other", currentBalance: Number(debt.toFixed(2)), avgMonthlyPayment: Number(avgMonthlyPayment.toFixed(2)), lastPaymentAmount: lastPayment ? Number(lastPayment.amount.toFixed(2)) : null, lastPaymentDate: lastPayment ? lastPayment.date : null, monthsToPayoff, payoffDate, monthsSavedWithExtra: monthsSaved100, extraPaymentAmount: 100, recentPaymentCount: recentPayments.length, apr, monthlyInterest, monthsToPayoffWithExtra, monthsSavedWithCustomExtra };
      }).filter(Boolean).sort((a, b) => b.currentBalance - a.currentBalance);

      const totalDebt = debtAccounts.reduce((sum, a) => sum + a.currentBalance, 0);
      const totalMonthlyPayments = debtAccounts.reduce((sum, a) => sum + a.avgMonthlyPayment, 0);
      const longestPayoff = debtAccounts.filter(a => a.monthsToPayoff).reduce((max, a) => Math.max(max, a.monthsToPayoff), 0);
      const hasAPRData = debtAccounts.some(a => a.apr !== null);

      const snowballOrder = [...debtAccounts].filter(a => a.currentBalance > 0).sort((a, b) => a.currentBalance - b.currentBalance);
      const avalancheOrder = [...debtAccounts].filter(a => a.currentBalance > 0).sort((a, b) => {
        if (a.apr && b.apr) return b.apr - a.apr;
        if (a.apr && !b.apr) return -1;
        if (!a.apr && b.apr) return 1;
        return b.currentBalance - a.currentBalance;
      });

      const smallDebts = debtAccounts.filter(a => a.currentBalance < 500);
      const recommendedStrategy = smallDebts.length >= 2 && !hasAPRData ? "snowball" : "avalanche";
      const recommendationReason = recommendedStrategy === "snowball"
        ? `You have ${smallDebts.length} accounts under $500 — pay those off first for quick wins, then attack the larger balances with momentum.`
        : hasAPRData ? "With APR data available, avalanche saves you the most in interest charges."
        : `Focus on your largest balance first — clearing it frees up the most cash flow.`;

      return {
        success: true,
        summary: { totalDebt: Number(totalDebt.toFixed(2)), totalMonthlyPayments: Number(totalMonthlyPayments.toFixed(2)), accountCount: debtAccounts.length, longestPayoffMonths: longestPayoff || null, hasAPRData },
        strategy: {
          recommended: recommendedStrategy, reason: recommendationReason,
          snowball: snowballOrder.map((d, i) => ({ order: i+1, accountId: d.id, name: d.name, balance: d.currentBalance, apr: d.apr, reason: i === 0 ? "Smallest balance — pay this off first for a quick win" : "Then attack this one with freed-up payments" })),
          avalanche: avalancheOrder.map((d, i) => ({ order: i+1, accountId: d.id, name: d.name, balance: d.currentBalance, apr: d.apr, reason: i === 0 ? (d.apr ? `Highest interest rate (${d.apr}% APR)` : "Largest balance — biggest impact") : (d.apr ? `${d.apr}% APR — tackle next` : "Continue working down the list") }))
        },
        debts: debtAccounts
      };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.post("/ai-chat", async (req, res) => {
  try {
    const { messages, month, apiKey, model } = req.body;
    const resolvedAPIKey = apiKey || null;
    if (!resolvedAPIKey) return res.status(500).json({ success: false, error: "Please add your OpenRouter API key in the app Settings to use AI features." });
    const resolvedModel = model || OPENROUTER_MODEL;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ success: false, error: "Missing messages array" });

    const financialContext = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      const transactions = await actual.getTransactions();
      const categories = await actual.getCategories();
      const startingBalancePayeeId = await getStartingBalancePayeeId();
      await actual.shutdown();
      const currentMonth = month || getRequestedMonth(req);
      const { categoryMap, incomeCategoryIds, transferCategoryIds } = buildCategoryContext(categories);
      const monthTx = transactions.filter(t => t.date && t.date.startsWith(currentMonth));
      let totalIncome = 0, totalSpending = 0;
      const spendingByCategory = {};
      for (const t of monthTx) {
        const amount = Number(t.amount) / 100;
        const categoryName = categoryMap[t.category] || "Uncategorized";
        if (amount > 0) { if (isRealIncome(t, categoryMap, incomeCategoryIds, transferCategoryIds, startingBalancePayeeId)) totalIncome += amount; continue; }
        if (amount < 0) { if (isExcludedSpending(t.category, categoryName, incomeCategoryIds, transferCategoryIds) || t.transfer_id) continue; totalSpending += Math.abs(amount); spendingByCategory[categoryName] = (spendingByCategory[categoryName] || 0) + Math.abs(amount); }
      }
      const topCategories = Object.entries(spendingByCategory).sort((a,b) => b[1]-a[1]).slice(0,10).map(([name,total]) => ({ name, total: Number(total.toFixed(2)) }));
      const targets = loadTargets();
      const budgetStatus = Object.keys(targets).map(name => { const spent = spendingByCategory[name] || 0, target = Number(targets[name]) || 0; return { name, spent: Number(spent.toFixed(2)), target: Number(target.toFixed(2)), remaining: Number((target-spent).toFixed(2)), percentUsed: target > 0 ? Number(((spent/target)*100).toFixed(1)) : 0, status: spent > target ? "over" : "under" }; });
      const recurringCharges = detectRecurringCharges(transactions, categories);
      const monthlyRecurring = recurringCharges.filter(r => r.frequency === "monthly" && r.confidence >= 75).sort((a,b) => b.averageAmount - a.averageAmount).slice(0, 15);
      return { month: currentMonth, income: Number(totalIncome.toFixed(2)), spending: Number(totalSpending.toFixed(2)), net: Number((totalIncome-totalSpending).toFixed(2)), topCategories, budgetStatus, recurringCharges: monthlyRecurring };
    });

    const systemPrompt = `You are a blunt, direct personal financial advisor. Real financial data for ${financialContext.month}:

MONTHLY: Income $${financialContext.income.toFixed(2)} | Spending $${financialContext.spending.toFixed(2)} | Net $${financialContext.net.toFixed(2)} (${financialContext.net >= 0 ? "SURPLUS" : "DEFICIT"})

TOP SPENDING:
${financialContext.topCategories.map(c => `- ${c.name}: $${c.total.toFixed(2)}`).join("\n")}

BUDGET STATUS:
${financialContext.budgetStatus.length > 0 ? financialContext.budgetStatus.map(b => `- ${b.name}: $${b.spent}/$${b.target} (${b.percentUsed}%) ${b.status === "over" ? "OVER" : "ok"}`).join("\n") : "No targets set."}

RECURRING CHARGES:
${financialContext.recurringCharges.map(r => `- ${r.merchant}: ~$${r.averageAmount.toFixed(2)}/mo (${r.categoryName})`).join("\n")}

Rules: Be direct. Use actual numbers. Calculate concrete savings. Max 4-5 sentences unless asked for more. Never generic advice.`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resolvedAPIKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://vault-for-actual", "X-Title": "Vault for Actual" },
      body: JSON.stringify({ model: resolvedModel, messages: [{ role: "system", content: systemPrompt }, ...messages.slice(-10)], max_tokens: 1500, temperature: 0.7 })
    });

    if (!response.ok) { const err = await response.text(); throw new Error(`OpenRouter error ${response.status}: ${err}`); }
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "I couldn't generate a response. Please try again.";
    res.json({ success: true, message: reply, model: data.model });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

app.get("/sync", async (req, res) => {
  try {
    const result = await runActualSafely(async () => {
      await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
      await actual.downloadBudget(ACTUAL_SYNC_ID);
      await actual.shutdown();
      return { success: true, synced: new Date().toISOString() };
    });
    res.json(result);
  } catch (error) {
    try { await actual.shutdown(); } catch (_) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Vault for Actual backend running on http://localhost:${PORT}`);
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await runActualSafely(async () => {
        await actual.init({ dataDir: "./actual-data", serverURL: ACTUAL_BASE_URL, password: ACTUAL_PASSWORD });
        await actual.downloadBudget(ACTUAL_SYNC_ID);
        await actual.shutdown();
      });
      console.log("Auto-sync complete:", new Date().toISOString());
    } catch (error) {
      console.log("Auto-sync failed:", error.message);
    }
  }, SIX_HOURS);
});
