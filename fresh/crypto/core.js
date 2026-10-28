"use strict";(()=>{const definitions={"./engine":function(module,exports,require){
"use strict";
module.exports = require("./strategy-engine");

},
"./strategy-engine":function(module,exports,require){
"use strict";
const RULES = require("./rules.json");
const { finite, tickRound, describe } = require("./analysis");
const dayAt = (n) => new Date(n + 330 * 60000).toISOString().slice(0, 10);
const clock = (at) => typeof at === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? Date.parse(at) : NaN;
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && finite(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s; }
const identity = (i) => i.instrumentId || [i.market || "NSE_FUTURES", i.symbol, i.expiry || "SPOT"].join("|");
function levels({ side, entry, stop, target: structuralTarget = null, tickSize, quantity = RULES.quantity }) {
  if (!["BUY", "SELL"].includes(side) || ![entry, stop, tickSize, quantity].every((v) => finite(v) && v > 0) || tickSize < 1e-8) throw Error("INVALID_PLAN_INPUT");
  const sign = side === "BUY" ? 1 : -1, risk = sign * (entry - stop), riskPct = risk / entry * 100;
  if (!(risk > 0 && riskPct <= RULES.maxRiskPct + 1e-9)) throw Error("STOP_OUTSIDE_RISK_LIMIT");
  const goalTarget = tickRound(entry * (1 + sign * RULES.targetPct / 100), tickSize, sign > 0);
  const target = structuralTarget === null ? goalTarget : tickRound(structuralTarget, tickSize, sign < 0);
  const rewardRisk = sign * (target - entry) / risk;
  if (!(target > 0 && rewardRisk >= RULES.minimumRewardRisk - 1e-9)) throw Error("INSUFFICIENT_ROOM_TO_TARGET");
  if (!finite(risk * quantity)) throw Error("POSITION_TOO_LARGE");
  return { side, entry, stop, target, goalTarget, tickSize, quantity, riskPct, rewardRisk, riskAmount: risk * quantity, costs: "UNKNOWN" };
}
function assessSetups(bars, x, tick) {
  const b = bars.at(-1), p = bars.at(-2), previous = bars.slice(-RULES.structureBars - 2, -2);
  const oldLow = Math.min(...previous.map((v) => v.low)), oldHigh = Math.max(...previous.map((v) => v.high));
  const assessments = [];
  for (const side of RULES.sides) {
    const s = side === "BUY" ? 1 : -1, directional = s * (b.close - b.open) > 0;
    const boundary = s > 0 ? x.resistance : x.support, opposite = s > 0 ? x.support : x.resistance;
    const add = (family, matched, stop, target, explanation) => assessments.push({ family, side, matched, stop, target, explanation });
    const crossed = s * (b.close - boundary) > 0 && s * (p.close - boundary) <= 0;
    const volume = ["EXCHANGE_VOLUME", "TICK_VOLUME"].includes(x.volumeKind) && x.volumeRatio !== null && x.volumeRatio >= RULES.volumeMultiple;
    add("STRUCTURE_BREAKOUT", directional && crossed && volume && (x.supportTouches >= 2 || x.resistanceTouches >= 2),
      s > 0 ? b.low - tick : b.high + tick, boundary + s * (x.resistance - x.support),
      "Completed candle crosses a prior boundary with increased activity; target projects the prior range, stop invalidates the breakout candle.");
    const trend = s > 0 ? x.regime === "UPTREND" : x.regime === "DOWNTREND";
    const retrace = bars.slice(-3, -1).some((v) => s > 0 ? v.low <= x.previousAverage + x.tolerance : v.high >= x.previousAverage - x.tolerance);
    const confirms = s * (b.close - (s > 0 ? p.high : p.low)) > 0 && s * (b.close - x.average) > 0;
    add("TREND_PULLBACK", trend && retrace && directional && confirms,
      s > 0 ? Math.min(...bars.slice(-3).map((v) => v.low)) - tick : Math.max(...bars.slice(-3).map((v) => v.high)) + tick,
      boundary - s * tick, "A pre-existing higher-timeframe trend pulls back toward its average, then confirms a resumption; the prior swing is the target.");
    const oldBoundary = s > 0 ? oldLow : oldHigh, farBoundary = s > 0 ? oldHigh : oldLow;
    const failed = s > 0 ? p.low < oldBoundary && p.close > oldBoundary : p.high > oldBoundary && p.close < oldBoundary;
    add("FAILED_BREAKOUT", failed && directional && s * (b.close - (s > 0 ? p.high : p.low)) > 0,
      s > 0 ? Math.min(p.low, b.low) - tick : Math.max(p.high, b.high) + tick,
      farBoundary - s * tick, "The prior candle breaks a range and returns inside; the next completed candle confirms failure. Stop sits beyond the failed excursion.");
    const rejection = s > 0 ? b.low <= opposite + x.tolerance && b.close > opposite && b.close > p.close : b.high >= opposite - x.tolerance && b.close < opposite && b.close < p.close;
    add("RANGE_BOUNCE", x.regime === "RANGE" && rejection && directional && (s > 0 ? b.close < (x.support + x.resistance) / 2 : b.close > (x.support + x.resistance) / 2),
      s > 0 ? Math.min(b.low, opposite) - tick : Math.max(b.high, opposite) + tick,
      boundary - s * tick, "Repeated range boundaries and low directional efficiency; enter a confirmed reaction near an edge and target the opposite boundary.");
  }
  return assessments;
}
function analyse(input, { now = Date.now(), tradingSession = null } = {}) {
  const out = { symbol: input?.symbol || "?", expiry: input?.expiry || null, instrumentId: input ? identity(input) : "?",
    market: input?.market || "NSE_FUTURES", currency: input?.currency || "INR", status: "WAIT", reason: null,
    evaluatedSides: ["BUY", "SELL"], evidence: null, plans: [], candles: [], assessments: [] };
  const wait = (reason) => ({ ...out, reason });
  if (!input || !/^[A-Z0-9&_.:/-]{1,40}$/.test(input.symbol || "") || typeof input.source !== "string" || !input.source
    || !["NSE_FUTURES", "CRYPTO_SPOT", "CRYPTO_PERP", "FOREX", "EQUITY", "COMMODITY_FUTURES"].includes(out.market)
    || typeof out.currency !== "string" || !/^[A-Z]{3,8}$/.test(out.currency)) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  const nse = out.market === "NSE_FUTURES", session = dayAt(now), step = (input.intervalMinutes ?? RULES.barMinutes) * 60000;
  const open = nse ? Date.parse(`${session}T09:15:00+05:30`) : clock(input.sessionStart), isOpen = nse ? tradingSession : input.isOpen;
  if (isOpen !== true) return wait(isOpen === false ? "MARKET_CLOSED" : "CALENDAR_UNVERIFIED");
  if (nse && (now < open || now >= Date.parse(`${session}T${RULES.lastEntryIst}:00+05:30`))) return wait("OUTSIDE_ENTRY_SESSION");
  if (!finite(open) || !finite(step) || step < 60000 || step > 864e5 || !Number.isInteger(step / 60000)) return wait("SESSION_OR_INTERVAL_UNVERIFIED");
  if (nse && (input.source !== "ANGELONE_NFO" || !validDate(input.expiry) || input.expiry < session)) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  if (out.market.endsWith("FUTURES") && (!validDate(input.expiry) || input.expiry < new Date(now).toISOString().slice(0, 10))) return wait("CONTRACT_OR_SOURCE_UNVERIFIED");
  if (!(finite(input.tickSize) && input.tickSize >= 1e-8)) return wait("TICK_MISSING_OR_INVALID");
  if (!Array.isArray(input.bars)) return wait("CANDLES_UNAVAILABLE");
  const bars = [];
  for (const b of input.bars) {
    if (!b || typeof b !== "object") return wait("INVALID_CANDLE");
    const at = clock(b.at);
    if (!finite(at) || b.symbol !== input.symbol || (b.expiry || null) !== out.expiry || at < open || (at - open) % step !== 0
      || ![b.open, b.high, b.low, b.close].every((v) => finite(v) && v > 0) || (b.volume !== null && (!finite(b.volume) || b.volume < 0))
      || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) return wait("INVALID_CANDLE");
    if (at > now) return wait("FUTURE_CANDLE");
    if (at + step <= now) bars.push({ ...b, ms: at });
  }
  bars.sort((a, b) => a.ms - b.ms);
  if (bars.some((b, i) => b.ms !== open + i * step)) return wait("MISSING_OR_DUPLICATE_CANDLES");
  if (bars.length < RULES.minimumBars) return wait("WARMING_UP");
  const last = bars.at(-1), signalEnd = last.ms + step;
  if (now - signalEnd >= step) return wait("SIGNAL_STALE");
  const x = describe(bars, { ...RULES, barMinutes: step / 60000 });
  x.volumeKind = input.volumeKind || (nse ? "EXCHANGE_VOLUME" : "UNKNOWN");
  out.evidence = { ...x, context: undefined, signalAt: new Date(signalEnd).toISOString(), lastClose: last.close,
    orderFlow: "NOT_AVAILABLE", source: input.source, sourceUrl: input.sourceUrl || null };
  out.candles = bars.slice(-60).map(({ ms, ...b }) => b);
  out.assessments = assessSetups(bars, x, input.tickSize);
  if (nse && (input.eligibility?.session !== session || input.eligibility?.state !== "CLEAR" || !input.eligibility?.source)) return wait(input.eligibility?.session === session && input.eligibility?.state === "BANNED" ? "NSE_BAN_NEW_ENTRY" : "BAN_STATUS_UNVERIFIED");
  if (!nse && input.tradeable !== true) return wait("INSTRUMENT_ELIGIBILITY_UNVERIFIED");
  const q = input.quote, quoteAt = clock(q?.at);
  if (q?.symbol !== input.symbol || (q?.expiry || null) !== out.expiry || (q.instrumentId && q.instrumentId !== out.instrumentId)
    || !finite(quoteAt) || now - quoteAt > RULES.maxQuoteAgeMs || quoteAt > now + 30000 || quoteAt < signalEnd) return wait("FRESH_POST_SIGNAL_QUOTE_REQUIRED");
  if (![q.bid, q.ask].every((v) => finite(v) && v > 0 && Math.abs(v / input.tickSize - Math.round(v / input.tickSize)) < 1e-5) || q.ask < q.bid) return wait("VALID_BID_ASK_REQUIRED");
  if (100 * (q.ask - q.bid) / ((q.ask + q.bid) / 2) > RULES.maxSpreadPct) return wait("SPREAD_TOO_WIDE");
  for (const a of out.assessments) {
    if (!a.matched) { a.rejection = "TRIGGER_NOT_PRESENT"; continue; }
    if (a.side === "SELL" && !nse && input.canShort !== true) { a.rejection = "SHORT_NOT_SUPPORTED_OR_UNVERIFIED"; continue; }
    const entry = a.side === "BUY" ? q.ask : q.bid;
    if (Math.abs(entry - last.close) / last.close * 100 > RULES.maxEntryDriftPct) { a.rejection = "ENTRY_TOO_FAR_FROM_SIGNAL"; continue; }
    try {
      const stop = tickRound(a.stop, input.tickSize, a.side === "SELL"), plan = levels({ side: a.side, entry, stop, target: a.target, tickSize: input.tickSize, quantity: nse ? 20 : input.defaultQuantity || 1 });
      out.plans.push({ ...plan, id: [RULES.version, out.instrumentId, a.family, a.side, signalEnd].join("~"), setups: [a.family], family: a.family,
        symbol: input.symbol, expiry: out.expiry, instrumentId: out.instrumentId, market: out.market, currency: out.currency, canShort: nse || input.canShort === true,
        minQuantity: nse ? 20 : input.minQuantity || 0, quantityStep: nse ? 1 : input.quantityStep || null,
        explanation: a.explanation, targetBasis: "STRUCTURAL_TARGET", status: "UNVALIDATED_RESEARCH", quoteAt: q.at,
        signalAt: out.evidence.signalAt, validUntil: new Date(signalEnd + step).toISOString(), reviewAt: nse ? `${session}T15:25:00+05:30` : null,
        exitBy: nse ? `${out.expiry}T15:25:00+05:30` : input.expiryAt || null, intervalMinutes: step / 60000,
        entryBasis: a.side === "BUY" ? "OBSERVED_ASK_REFERENCE" : "OBSERVED_BID_REFERENCE" });
    } catch (e) { a.rejection = e.message; }
  }
  return { ...out, status: out.plans.length ? "RESEARCH_SETUP" : "WAIT", reason: out.plans.length ? null : "NO_SETUP_WITHIN_RISK" };
}
module.exports = { RULES, analyse, levels, assessSetups, identity, dayAt, clock };

},
"./analysis":function(module,exports,require){
"use strict";
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const mean = (a) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b.length % 2 ? b[b.length >> 1] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2 : null; };
function ema(values, n) { const a = 2 / (n + 1); return values.reduce((out, v) => { out.push(out.length ? a * v + (1 - a) * out.at(-1) : v); return out; }, []); }
function tickRound(price, tick, up) {
  if (![price, tick].every((v) => finite(v) && v > 0) || price / tick > Number.MAX_SAFE_INTEGER / 2) throw Error("INVALID_TICK_OR_PRICE");
  return Number(((up ? Math.ceil(price / tick - 1e-7) : Math.floor(price / tick + 1e-7)) * tick).toFixed(8));
}
function aggregate(bars, count = 3) {
  const out = [];
  for (let i = 0; i + count <= bars.length; i += count) {
    const a = bars.slice(i, i + count);
    out.push({ at: a[0].at, open: a[0].open, high: Math.max(...a.map((b) => b.high)), low: Math.min(...a.map((b) => b.low)), close: a.at(-1).close, volume: a.reduce((s, b) => s + (b.volume || 0), 0) });
  }
  return out;
}
function candleFacts(b, p) {
  const body = Math.abs(b.close - b.open), range = b.high - b.low, lower = Math.min(b.open, b.close) - b.low, upper = b.high - Math.max(b.open, b.close);
  const names = [], side = b.close > b.open ? "BULLISH" : b.close < b.open ? "BEARISH" : "DOJI";
  if (range > 0 && body / range <= 0.1) names.push("DOJI");
  if (body > 0 && lower >= 2 * body && upper <= body) names.push("LOWER_WICK_REJECTION");
  if (body > 0 && upper >= 2 * body && lower <= body) names.push("UPPER_WICK_REJECTION");
  if (p && b.high <= p.high && b.low >= p.low) names.push("INSIDE_BAR");
  if (p && b.close > b.open && p.close < p.open && b.open <= p.close && b.close >= p.open) names.push("BULLISH_ENGULFING");
  if (p && b.close < b.open && p.close > p.open && b.open >= p.close && b.close <= p.open) names.push("BEARISH_ENGULFING");
  if (range > 0 && body / range >= 0.8) names.push(side + "_WIDE_BODY");
  return { side, names, body, range, lower, upper };
}
function describe(bars, config) {
  const last = bars.at(-1), prior = bars.slice(-config.structureBars - 1, -1), closes = bars.map((b) => b.close);
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  const atr = mean(tr.slice(-14)), averages = ema(closes, 10), support = Math.min(...prior.map((b) => b.low)), resistance = Math.max(...prior.map((b) => b.high));
  const previousCloses = prior.map((b) => b.close), travel = previousCloses.slice(1).reduce((s, c, i) => s + Math.abs(c - previousCloses[i]), 0);
  const efficiency = travel > 0 ? Math.abs(previousCloses.at(-1) - previousCloses[0]) / travel : 0;
  const context = aggregate(bars.slice(0, -3), 3), tail = context.slice(-3);
  const rising = tail.length === 3 && tail.slice(1).every((b, i) => b.high > tail[i].high && b.low > tail[i].low);
  const falling = tail.length === 3 && tail.slice(1).every((b, i) => b.high < tail[i].high && b.low < tail[i].low);
  const tolerance = atr * config.levelToleranceAtr;
  const supportTouches = prior.filter((b) => b.low <= support + tolerance).length, resistanceTouches = prior.filter((b) => b.high >= resistance - tolerance).length;
  const range = efficiency <= config.rangeEfficiencyMax && supportTouches >= 2 && resistanceTouches >= 2 && resistance - support >= 2 * atr;
  const regime = range ? "RANGE" : rising ? "UPTREND" : falling ? "DOWNTREND" : "TRANSITION";
  let pv = 0, volume = 0;
  for (const b of bars) if (finite(b.volume)) { pv += (b.high + b.low + b.close) / 3 * b.volume; volume += b.volume; }
  const volumeBaseline = median(bars.slice(-7, -1).map((b) => b.volume).filter(finite));
  const volumeRatio = volumeBaseline > 0 && finite(last.volume) ? last.volume / volumeBaseline : null;
  const firstWidth = Math.max(...prior.slice(0, 6).map((b) => b.high)) - Math.min(...prior.slice(0, 6).map((b) => b.low));
  const lastWidth = Math.max(...prior.slice(-6).map((b) => b.high)) - Math.min(...prior.slice(-6).map((b) => b.low));
  const pattern = firstWidth > 0 && lastWidth < firstWidth * 0.65 ? "CONTRACTING_RANGE" : supportTouches >= 2 && resistanceTouches >= 2 ? "HORIZONTAL_RANGE" : "SWING_STRUCTURE";
  return { regime, atr, average: averages.at(-1), previousAverage: averages.at(-2), support, resistance, supportTouches, resistanceTouches,
    efficiency, tolerance, volumeRatio, vwap: volume > 0 ? pv / volume : null, pattern, candle: candleFacts(last, bars.at(-2)), context, contextMinutes: config.barMinutes * 3 };
}
module.exports = { finite, mean, median, ema, tickRound, aggregate, candleFacts, describe };

},
"./rules.json":function(module,exports,require){
module.exports={
  "version": "price-action-workbench-v2",
  "status": "UNVALIDATED_RESEARCH",
  "sides": [
    "BUY",
    "SELL"
  ],
  "barMinutes": 5,
  "minimumBars": 24,
  "structureBars": 20,
  "volumeMultiple": 1.5,
  "levelToleranceAtr": 0.2,
  "rangeEfficiencyMax": 0.35,
  "minimumRewardRisk": 1.5,
  "maxRiskPct": 2,
  "maxSpreadPct": 0.15,
  "maxEntryDriftPct": 0.35,
  "maxQuoteAgeMs": 120000,
  "targetPct": 3,
  "lastEntryIst": "15:00",
  "reviewIst": "15:25",
  "quantity": 20,
  "families": [
    "TREND_PULLBACK",
    "STRUCTURE_BREAKOUT",
    "FAILED_BREAKOUT",
    "RANGE_BOUNCE"
  ],
  "meaning": "Separate mechanical research interpretations of public price-action concepts. Numerical thresholds are application research choices, not the named traders' complete methods or validated results. Structural targets drive each setup; 3% from actual fill is a separate reference. No minimum holding period or predicted time to profit.",
  "sources": [
    {
      "name": "CME: trend and continuation patterns",
      "url": "https://www.cmegroup.com/education/courses/technical-analysis/trend-and-continuation-patterns"
    },
    {
      "name": "CME: support and resistance",
      "url": "https://www.cmegroup.com/education/courses/technical-analysis/support-and-resistance"
    },
    {
      "name": "Linda Raschke: momentum and pullback interview",
      "url": "https://lindaraschke.net/wp-content/uploads/2026/03/raschke_pt2_0304.pdf"
    },
    {
      "name": "Peter Brandt: entry categories and structures",
      "url": "https://www.peterlbrandt.com/wp-content/uploads/2021/07/The-Factor-Chart-Lab.pdf"
    }
  ]
}
;
},
"./paper":function(module,exports,require){
"use strict";
const crypto = require("node:crypto");
const { levels, clock } = require("./engine");
const { finite } = require("./analysis");
function openTrade(book, plan, { fill, quantity, now = Date.now() } = {}) {
  if (!plan?.id || plan.status !== "UNVALIDATED_RESEARCH" || !(now < clock(plan.validUntil)) || now < clock(plan.signalAt)) throw Error("PLAN_EXPIRED_OR_INVALID");
  if (plan.side === "SELL" && plan.canShort !== true) throw Error("SHORT_NOT_SUPPORTED_ON_THIS_INSTRUMENT");
  if (book.some((t) => t.planId === plan.id)) throw Error("PLAN_ALREADY_RECORDED");
  if (quantity < plan.minQuantity || plan.quantityStep && Math.abs(quantity / plan.quantityStep - Math.round(quantity / plan.quantityStep)) > 1e-6) throw Error("QUANTITY_OUTSIDE_INSTRUMENT_RULES");
  if (book.some((t) => t.instrumentId === plan.instrumentId && t.status === "OPEN")) throw Error("POSITION_ALREADY_OPEN_FOR_INSTRUMENT");
  const recalculated = levels({ ...plan, entry: fill, quantity });
  const trade = { ...plan, ...recalculated, id: crypto.randomUUID(), planId: plan.id, entryAt: new Date(now).toISOString(),
    status: "OPEN", entryBasis: "MANUALLY_RECORDED_PAPER_FILL", lastCheckedAt: null, exit: null };
  return [...book, trade];
}
function closeTrade(trade, { price, at, reason = "MANUAL", costs = null }) {
  if (trade.status !== "OPEN") throw Error("TRADE_ALREADY_CLOSED");
  if (!finite(price) || price <= 0 || !finite(clock(at)) || clock(at) < clock(trade.entryAt)
    || (costs !== null && (!finite(costs) || costs < 0))) throw Error("INVALID_EXIT");
  const sign = trade.side === "BUY" ? 1 : -1, gross = sign * (price - trade.entry) * trade.quantity;
  return { ...trade, status: "CLOSED", exit: { price, at, reason, costs, gross, net: costs === null ? null : gross - costs,
    grossPct: sign * (price / trade.entry - 1) * 100, basis: reason === "MANUAL" ? "MANUALLY_RECORDED_PAPER_FILL" : "OBSERVED_QUOTE_PAPER_EXIT" } };
}
function observe(book, quotes, now = Date.now()) {
  return book.map((t) => {
    if (t.status !== "OPEN") return t;
    const q = quotes[t.instrumentId], at = clock(q?.at);
    if (!q || q.instrumentId !== t.instrumentId || !finite(at) || at < clock(t.entryAt) || at <= (clock(t.lastCheckedAt) || 0)
      || now - at > 120000 || at > now + 30000 || ![q.bid, q.ask].every((v) => finite(v) && v > 0) || q.ask < q.bid) return t.exitBy && now >= clock(t.exitBy) ? { ...t, reviewRequired: "EXPIRY_EXIT_DATA_REQUIRED" } : t;
    const s = t.side === "BUY" ? 1 : -1, available = s > 0 ? q.bid : q.ask;
    if (s * (available - t.stop) <= 0) return closeTrade(t, { price: available, at: q.at, reason: "OBSERVED_STOP" });
    if (s * (available - t.target) >= 0) return closeTrade(t, { price: t.target, at: q.at, reason: "OBSERVED_TARGET" });
    if (t.exitBy && at >= clock(t.exitBy)) return closeTrade(t, { price: available, at: q.at, reason: "OBSERVED_EXPIRY_EXIT" });
    return { ...t, lastCheckedAt: q.at, lastPrice: available };
  });
}
function summary(book) {
  const closed = book.filter((t) => t.status === "CLOSED"), groups = {};
  for (const t of closed) {
    // Never add rupees, dollars and crypto units into a misleading common total.
    const key = t.currency, g = groups[key] ||= { closed: 0, gross: 0, net: 0, unknownCosts: 0 };
    g.closed++; g.gross += t.exit.gross; if (t.exit.net === null) g.unknownCosts++; else g.net += t.exit.net;
  }
  return { open: book.filter((t) => t.status === "OPEN").length, closed: closed.length, byCurrency: groups,
    verdict: "PAPER_OBSERVATIONS_NOT_VALIDATION" };
}
module.exports = { openTrade, closeTrade, observe, summary };

},
"./view":function(module,exports,require){
"use strict";
module.exports = require("./workbench-view");

},
"./workbench-view":function(module,exports,require){
"use strict";
const { RULES } = require("./engine");
const { playbook, sources } = require("./playbook");
const { summary } = require("./paper");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const text = (s) => String(s || "").replace(/_/g, " ").toLowerCase();
function money(n, currency = "INR", tick = 0.01) {
  if (!Number.isFinite(n)) return "—";
  const digits = Math.min(8, Math.max(2, (String(tick).split(".")[1] || "").length, /e-(\d+)/.test(String(tick)) ? Number(String(tick).split("e-")[1]) : 0));
  const number = n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (currency === "INR" ? "₹" : currency === "USD" ? "$" : "") + number;
}
const stamp = (at) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " IST" : "—";
function chart(p, r) {
  const bars = r.candles || []; if (!bars.length) return "";
  const marks = [{ value: p.entry, label: "Entry", color: "#bfcce2" }, { value: p.stop, label: "Stop", color: "#f7a4a4" }, { value: p.target, label: "Target", color: "#74e4b1" }];
  const lo = Math.min(...bars.map((b) => b.low), ...marks.map((m) => m.value)), hi = Math.max(...bars.map((b) => b.high), ...marks.map((m) => m.value));
  const y = (v) => 155 - (v - lo) / Math.max(1e-8, hi - lo) * 135, step = 294 / bars.length, width = Math.min(7, step * 0.65);
  const axisTime = (at) => new Date(at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  return `<svg class="chart" viewBox="0 0 380 180" role="img" aria-label="${esc(p.symbol)} completed candles with entry, stop and target"><g class="candle-plot">${bars.map((b, i) => {
    const x = 10 + (i + 0.5) * step, color = b.close >= b.open ? "#74e4b1" : "#f7a4a4";
    return `<g stroke="${color}" fill="${color}"><line x1="${x}" y1="${y(b.high)}" x2="${x}" y2="${y(b.low)}"/><rect x="${x - width / 2}" y="${Math.min(y(b.open), y(b.close))}" width="${width}" height="${Math.max(1, Math.abs(y(b.close) - y(b.open)))}"/></g>`;
  }).join("")}</g><polyline class="line-plot" hidden fill="none" stroke="#a7c4ff" stroke-width="1.6" points="${bars.map((b, i) => `${10 + (i + 0.5) * step},${y(b.close)}`).join(" ")}"/>${marks.map((m) => `<line x1="7" x2="307" y1="${y(m.value)}" y2="${y(m.value)}" stroke="${m.color}" stroke-dasharray="3 4" opacity=".6"/><text x="313" y="${y(m.value) + 3}" fill="${m.color}" font-size="9">${m.label}</text>`).join("")}<text x="8" y="176" fill="#8e9cb0" font-size="8">${esc(axisTime(bars[0].at))}</text><text x="258" y="176" fill="#8e9cb0" font-size="8">${esc(axisTime(bars.at(-1).at))}</text></svg>`;
}
function render(snapshot, { server = false, hosted = false, csrf = "", job = {}, book = [] } = {}) {
  const editable = server || hosted;
  const results = snapshot.results || [], plans = results.flatMap((r) => r.plans.map((p) => ({ p, r }))), stats = summary(book);
  const card = ({ p, r }) => `<article class="plan" data-symbol="${esc(p.symbol)}" data-side="${p.side}" data-family="${p.family}" data-market="${esc(p.market)}" data-until="${p.validUntil}" data-plan="${esc(JSON.stringify(p))}">
    <div class="card-top"><span class="family">${esc(playbook.find((f) => f.id === p.family)?.name || text(p.family))}</span><b class="${p.side === "BUY" ? "up" : "down"}">${p.side === "BUY" ? "BUY / LONG" : "SELL / SHORT"}</b></div>
    <h3>${esc(p.symbol)}</h3><p class="muted small">${esc(text(p.market))} · ${esc(p.currency)}${p.expiry ? " · " + esc(p.expiry) : ""} · ${p.intervalMinutes} min</p>
    <dl class="levels"><div><dt>Entry reference</dt><dd>${money(p.entry, p.currency, p.tickSize)}</dd></div><div><dt>Stop-loss</dt><dd class="down">${money(p.stop, p.currency, p.tickSize)}</dd></div><div><dt>Structure target</dt><dd class="up">${money(p.target, p.currency, p.tickSize)}</dd></div></dl>
    <div class="metrics"><span>${p.rewardRisk.toFixed(2)}R available</span><span>${p.riskPct.toFixed(2)}% price risk</span><span>${esc(text(r.evidence.regime))}</span></div>
    ${chart(p, r)}<div class="facts"><span>Support ${money(r.evidence.support, p.currency, p.tickSize)}</span><span>Resistance ${money(r.evidence.resistance, p.currency, p.tickSize)}</span></div>
    <p class="small muted">${esc(r.evidence.candle.names.map(text).join(" · ") || text(r.evidence.candle.side) + " candle")} · ${r.evidence.volumeRatio === null ? "volume unavailable" : r.evidence.volumeRatio.toFixed(2) + "× " + (r.evidence.volumeKind === "TICK_VOLUME" ? "tick activity" : "volume")}</p>
    <details><summary>Why this setup?</summary><p>${esc(p.explanation)}</p><p class="small">Target comes from the price structure. The separate 3% reference is ${money(p.goalTarget, p.currency, p.tickSize)}. Neither is a predicted outcome.</p></details>
    <details class="fill-details"><summary>My fill and paper entry</summary><div class="inputs"><label>Entry price<input class="fill" type="number" min="0" step="${p.tickSize}" inputmode="decimal" value="${p.entry}"/></label><label>Quantity<input class="quantity" type="number" min="0" step="any" inputmode="decimal" value="${p.quantity}"/></label></div><output aria-live="polite">Enter a fill to check the stop and target.</output>${editable ? '<button class="record">Record paper entry</button>' : ""}</details>
    <p class="small clock">Quote ${stamp(p.quoteAt)} · expires ${stamp(p.validUntil)}</p><p class="expiry-note" hidden>Reference expired · refresh before considering an entry</p>
    <p class="small muted">Target or stop first · no minimum hold${p.expiry ? " · exit by contract expiry" : ""} · before unknown costs</p>
  </article>`;
  const lane = (side) => `<section class="lane" data-side="${side}"><div class="lane-title"><h2 class="${side === "BUY" ? "up" : "down"}">${side === "BUY" ? "Upside" : "Downside"}</h2><span>${plans.filter((v) => v.p.side === side).length} research plans</span></div>${plans.filter((v) => v.p.side === side).map(card).join("")}<p class="empty" ${plans.some((v) => v.p.side === side) ? "hidden" : ""}>No fresh ${side === "BUY" ? "buy" : "sell"} setup in this snapshot.</p></section>`;
  const bootstrap = JSON.stringify({ demo: snapshot.demo === true, source: snapshot.source || (snapshot.demo ? "demo" : "nse"), builtAt: snapshot.builtAt, server, hosted, csrf, ...(hosted ? { snapshot } : {}),
    rules: { maxRiskPct: RULES.maxRiskPct, minimumRewardRisk: RULES.minimumRewardRisk, targetPct: RULES.targetPct } }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Fresh Desk · Price action</title><link rel="stylesheet" href="./app.css"/></head><body><main>
    <header><div><p class="eyebrow">FRESH DESK / PRICE ACTION</p><h1>Price action.<br/>Both directions.</h1><p class="muted">Structure · candles · clear exits</p></div><span class="badge">RESEARCH · UNVALIDATED</span></header>
    ${snapshot.demo ? '<div class="notice demo">DEMO · synthetic prices · paper only</div>' : ""}
    <div class="status-bar"><div><b id="state">${esc(text(snapshot.state))}</b><p class="small muted">${results.length} instruments · ${plans.length} research plans · ${stamp(snapshot.builtAt)}</p></div>${server ? `<div class="scan-controls"><select id="source" aria-label="Data source"><option value="nse">NSE futures</option><option value="crypto">Crypto spot</option><option value="demo">Demonstration</option></select><button id="refresh">Refresh scan</button></div>` : `<span class="small muted">${hosted ? "Published snapshot · auto-checks for updates" : "Local snapshot"}</span>`}</div>
    <p class="small muted" id="job" aria-live="polite">${job.running ? "Scan running…" : snapshot.errors?.length ? esc(snapshot.errors.join(" · ")) : "References are not recorded fills."}</p>
    ${hosted ? `<p class="small"><a href="${snapshot.source === "nse" ? "./" : "../"}">NSE futures</a> · <a href="${snapshot.source === "nse" ? "./" : "../"}crypto/">Crypto spot</a> · <a href="${snapshot.source === "nse" ? "./" : "../"}demo/">Demo</a> · <button id="reload-snapshot">Check for update</button></p>` : ""}
    <nav class="tabs" aria-label="Workspace"><button data-tab="plans" aria-selected="true">Plans</button><button data-tab="market" aria-selected="false">Market read</button><button data-tab="playbook" aria-selected="false">Playbook</button><button data-tab="paper" aria-selected="false">Paper record</button></nav>
    <section class="workspace" id="plans"><div class="filters"><div class="directions"><button data-filter="ALL" aria-pressed="true">Both</button><button data-filter="BUY" aria-pressed="false">Buy</button><button data-filter="SELL" aria-pressed="false">Sell</button></div><select id="family" aria-label="Strategy family"><option value="ALL">All strategies</option>${playbook.map((f) => `<option value="${f.id}">${f.name}</option>`).join("")}</select><input id="search" type="search" placeholder="Find a symbol" aria-label="Find a symbol"/><button id="chart-type" aria-pressed="false">Line chart</button></div><div class="lanes">${lane("BUY")}${lane("SELL")}</div></section>
    <section class="workspace" id="market" hidden><div class="section-head"><h2>Context before the candle.</h2><p class="muted">Every family is checked independently, in both directions.</p></div>${results.map((r) => `<article class="market-card"><div class="card-top"><h3>${esc(r.symbol)}</h3><span class="badge">${esc(text(r.evidence?.regime || "waiting for data"))}</span></div><p>${esc(text(r.reason || r.status))}</p>${r.evidence ? `<div class="facts"><span>Pattern: ${esc(text(r.evidence.pattern))}</span><span>Context: ${r.evidence.contextMinutes} min</span><span>Candle: ${esc(text(r.evidence.candle.side))}</span><span>ATR: ${money(r.evidence.atr, r.currency)}</span></div><details><summary>All setup checks</summary><div class="checks">${r.assessments.map((a) => `<div><b>${a.side} · ${esc(text(a.family))}</b><span>${esc(text(a.rejection || (a.matched ? "qualified research" : "trigger not present")))}</span></div>`).join("")}</div></details>` : ""}</article>`).join("") || '<div class="empty">Awaiting data. Use a live connector or import a current-session dataset.</div>'}${server ? '<label class="import">Import market data (JSON)<input id="import" type="file" accept="application/json,.json"/></label><p class="small muted">Equities, commodities and forex use the documented import format. Fresh timestamps, instrument identity and eligibility are checked.</p>' : ""}</section>
    <section class="workspace" id="playbook" hidden><div class="section-head"><h2>Four setups. Separate rules.</h2><p class="muted">Mechanical research interpretations of published concepts—not reproductions of a trader’s complete method.</p></div><div class="playbooks">${playbook.map((f, i) => `<article class="playbook"><p class="eyebrow">0${i + 1} / BOTH DIRECTIONS</p><h3>${f.name}</h3><p class="context">${f.setting}</p><dl><dt>Trigger</dt><dd>${f.trigger}</dd><dt>Invalidation</dt><dd>${f.stop}</dd><dt>Exit</dt><dd>${f.target}</dd><dt>What can fail</dt><dd>${f.failure}</dd></dl><a href="${esc(sources[f.source].url)}" target="_blank" rel="noopener noreferrer">Read the source ↗</a></article>`).join("")}</div><div class="notice"><b>Evidence before promotion</b><p>These rules have no demonstrated profitability. A registered historical study and a separate forward record are required before calling them validated.</p><p class="small">Actual trades, fees and liquidation mechanics differ by market. The crypto connector reads spot prices and does not permit naked-short paper entries. Genuine order-flow data is not inferred from candles or tick counts.</p></div></section>
    <section class="workspace" id="paper" hidden><div class="section-head"><h2>Record the decision.</h2><p class="muted">${stats.open} open · ${stats.closed} closed · ${hosted ? "saved in this browser only" : "paper observations, not a verified strategy record"}</p></div>${Object.entries(stats.byCurrency).map(([currency, g]) => `<div class="notice">${esc(currency)} · gross ${money(g.gross, currency)} · ${g.unknownCosts ? "net unavailable: costs missing" : "net " + money(g.net, currency)}</div>`).join("")}${book.map((t) => `<article class="paper-trade" data-id="${esc(t.id)}"><div class="card-top"><h3>${esc(t.symbol)}</h3><b class="${t.side === "BUY" ? "up" : "down"}">${t.side} · ${t.reviewRequired ? "EXIT DATA NEEDED" : t.status}</b></div><p class="small muted">${esc(text(t.family))} · ${stamp(t.entryAt)} · ${t.quantity} units</p><dl class="levels"><div><dt>Recorded entry</dt><dd>${money(t.entry, t.currency, t.tickSize)}</dd></div><div><dt>Fixed stop</dt><dd>${money(t.stop, t.currency, t.tickSize)}</dd></div><div><dt>Fixed target</dt><dd>${money(t.target, t.currency, t.tickSize)}</dd></div></dl>${t.exit ? `<p>Exit ${money(t.exit.price, t.currency, t.tickSize)} · ${esc(text(t.exit.reason))} · gross ${money(t.exit.gross, t.currency)}${t.exit.net === null ? " · net unknown" : " · net " + money(t.exit.net, t.currency)}</p>` : editable ? '<div class="inputs"><label>Exit price<input class="exit-price" type="number" min="0" step="any" inputmode="decimal"/></label><label>Total costs (optional)<input class="exit-costs" type="number" min="0" step="any" inputmode="decimal"/></label></div><button class="close-trade">Record paper exit</button><output aria-live="polite"></output>' : ""}</article>`).join("") || '<div class="empty">No paper trades recorded. Choose a fresh plan and record your paper fill to begin.</div>'}${hosted ? '<button id="export-paper">Download my paper record</button><p class="small muted">Keep a backup. Clearing browser storage removes this record. Quotes are checked only when this page loads a new published snapshot; this is not continuous position monitoring.</p>' : ""}<p class="small muted">Quotes may be sampled, so intrabar touches can be missed. Automatic paper exits use only fresh post-entry quotes, never earlier candle extremes. Costs stay unknown until supplied. Existing accounts and holdings are not managed.</p></section>
    <footer>${server ? "Local app" : hosted ? "Published research desk" : "Static preview"} · ${esc(RULES.version)} · no win-rate or time-to-profit prediction</footer>
    </main><script id="bootstrap" type="application/json">${bootstrap}</script>${hosted ? '<script src="./core.js"></script><script src="./hosted.js"></script>' : ""}<script src="./app.js"></script></body></html>`;
}
module.exports = { render, money, chart };

},
"./playbook":function(module,exports,require){
"use strict";
const { RULES } = require("./engine");
const playbook = [
  { id: "TREND_PULLBACK", name: "Trend pullback", setting: "Established uptrend or downtrend", trigger: "A pullback toward the 10-bar average is followed by a completed candle beyond the prior candle's high/low.", stop: "Beyond the last three candles' pullback extreme.", target: "Just before the prior 20-bar swing high/low.", failure: "The pullback develops into a reversal, or there is too little room before the prior swing.", source: 2 },
  { id: "STRUCTURE_BREAKOUT", name: "Structure breakout", setting: "A clearly defined prior boundary", trigger: "A completed candle closes beyond the previous 20-bar boundary with at least 1.5 times the median of six prior activity readings.", stop: "Beyond the breakout candle's opposite extreme.", target: "Project the height of the previous range beyond its broken boundary.", failure: "A false break, thin activity or a late entry consumes the available reward.", source: 0 },
  { id: "FAILED_BREAKOUT", name: "Failed breakout", setting: "An attempted escape returns inside a prior range", trigger: "The previous candle crossed a prior boundary and closed inside again; the latest candle confirms the rejection.", stop: "Beyond the failed excursion.", target: "Just before the opposite boundary of the previous range.", failure: "The apparent rejection is only a pause before the original breakout resumes.", source: 3 },
  { id: "RANGE_BOUNCE", name: "Range bounce", setting: "Repeated boundaries, low directional efficiency", trigger: "A directional candle reacts near an edge, with room to the opposite edge; entries in the middle are excluded.", stop: "Beyond the rejected range edge or signal candle, whichever is farther.", target: "Just before the opposite range boundary.", failure: "A range becomes a trend and the boundary gives way.", source: 1 }
];
module.exports = { playbook, sources: RULES.sources };

}},cache={};function require(id){if(id==="node:crypto")return {randomUUID:()=>crypto.randomUUID()};if(!definitions[id])throw Error("UNKNOWN_BROWSER_MODULE");if(!cache[id]){const m=cache[id]={exports:{}};definitions[id](m,m.exports,require);}return cache[id].exports;}window.FreshCore={...require("./paper"),render:require("./view").render};})();
