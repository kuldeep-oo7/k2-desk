"use strict";
const config = JSON.parse(document.querySelector("#bootstrap").textContent);
const cards = [...document.querySelectorAll(".plan")], search = document.querySelector("#search"), family = document.querySelector("#family");
let direction = "ALL", activeTab = "plans";
try { activeTab = sessionStorage.getItem("fresh-tab") || "plans"; } catch { /* file-mode storage may be disabled */ }
function tab(name) { if (!["plans", "market", "playbook", "paper"].includes(name)) name = "plans"; document.querySelectorAll(".workspace").forEach((el) => el.hidden = el.id !== name); document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name))); try { sessionStorage.setItem("fresh-tab", name); } catch { /* optional state */ } }
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab(b.dataset.tab); window.scrollTo(0, 0); })); tab(activeTab);
function filter() {
  document.querySelectorAll(".lane").forEach((lane) => { lane.hidden = direction !== "ALL" && lane.dataset.side !== direction; });
  cards.forEach((c) => c.hidden = !c.dataset.symbol.toLowerCase().includes(search.value.trim().toLowerCase()) || family.value !== "ALL" && c.dataset.family !== family.value);
  document.querySelectorAll(".lane").forEach((l) => { l.querySelector(".empty").hidden = [...l.querySelectorAll(".plan")].some((p) => !p.hidden); });
}
document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { direction = b.dataset.filter; document.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); filter(); })); search.addEventListener("input", filter); family.addEventListener("change", filter);
document.querySelector("#chart-type").addEventListener("click", (e) => { const line = e.target.getAttribute("aria-pressed") !== "true"; e.target.setAttribute("aria-pressed", String(line)); e.target.textContent = line ? "Candles" : "Line chart"; document.querySelectorAll(".candle-plot").forEach((p) => p.toggleAttribute("hidden", line)); document.querySelectorAll(".line-plot").forEach((p) => p.toggleAttribute("hidden", !line)); });
const decimals = (tick) => Math.min(8, Math.max(2, (String(tick).split(".")[1] || "").length, /e-(\d+)/.test(String(tick)) ? Number(String(tick).split("e-")[1]) : 0));
const format = (n, p) => (p.currency === "INR" ? "₹" : p.currency === "USD" ? "$" : p.currency + " ") + n.toLocaleString("en-IN", { minimumFractionDigits: decimals(p.tickSize), maximumFractionDigits: decimals(p.tickSize) });
function checkFill(p, entry, quantity) {
  const s = p.side === "BUY" ? 1 : -1, risk = s * (entry - p.stop), riskPct = risk / entry * 100, rewardRisk = s * (p.target - entry) / risk;
  if (![entry, quantity].every((v) => Number.isFinite(v) && v > 0) || !(risk > 0 && riskPct <= config.rules.maxRiskPct + 1e-9)) throw Error("Fill is outside the stop/risk limit.");
  if (quantity < p.minQuantity || p.quantityStep && Math.abs(quantity / p.quantityStep - Math.round(quantity / p.quantityStep)) > 1e-6) throw Error("Quantity is outside this instrument’s rules.");
  if (!(rewardRisk >= config.rules.minimumRewardRisk - 1e-9)) throw Error("Too little room to the structure target at this fill.");
  const raw = entry * (1 + s * config.rules.targetPct / 100), steps = s > 0 ? Math.ceil(raw / p.tickSize - 1e-7) : Math.floor(raw / p.tickSize + 1e-7), goal = Number((steps * p.tickSize).toFixed(8));
  return { riskAmount: risk * quantity, goal, rewardRisk };
}
function expire() { cards.forEach((c) => { const old = !config.demo && Date.now() >= Date.parse(c.dataset.until); c.classList.toggle("expired", old); c.querySelector(".expiry-note").hidden = !old; const button = c.querySelector(".record"); if (button) button.disabled = old || c.dataset.fillInvalid === "true"; }); }
expire(); if (!config.demo) setInterval(expire, 10000);
async function request(url, body) {
  if (config.hosted) return window.FreshHosted.request(url, body);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Fresh-CSRF": config.csrf }, body: JSON.stringify(body) });
  const result = await r.json(); if (!r.ok) throw Error(result.error || "Request could not be completed."); return result;
}
cards.forEach((c) => {
  const p = JSON.parse(c.dataset.plan), input = c.querySelector(".fill"), quantity = c.querySelector(".quantity"), output = c.querySelector("output");
  function update() { try { if (!input.value.trim() || !quantity.value.trim()) throw Error("Enter your actual fill and quantity."); const result = checkFill(p, Number(input.value), Number(quantity.value)); output.textContent = "Structure target " + format(p.target, p) + " · 3% reference " + format(result.goal, p) + " · cash at risk " + format(result.riskAmount, p) + " · before costs"; output.className = ""; c.dataset.fillInvalid = "false"; } catch (e) { output.textContent = e.message; output.className = "error"; c.dataset.fillInvalid = "true"; } expire(); }
  input.addEventListener("input", update); quantity.addEventListener("input", update);
  c.querySelector(".record")?.addEventListener("click", async (e) => { e.target.disabled = true; try { checkFill(p, Number(input.value), Number(quantity.value)); await request("/api/paper", { planId: p.id, fill: Number(input.value), quantity: Number(quantity.value) }); try { sessionStorage.setItem("fresh-tab", "paper"); } catch { /* optional */ } location.reload(); } catch (error) { output.textContent = error.message; output.className = "error"; e.target.disabled = false; expire(); } });
});
document.querySelectorAll(".paper-trade").forEach((t) => { t.querySelector(".close-trade")?.addEventListener("click", async () => { const output = t.querySelector("output"), price = t.querySelector(".exit-price"), costs = t.querySelector(".exit-costs"); try { if (!price.value.trim()) throw Error("Enter the paper exit fill."); await request("/api/paper/close", { id: t.dataset.id, price: Number(price.value), costs: costs.value.trim() ? Number(costs.value) : null }); location.reload(); } catch (e) { output.textContent = e.message; output.className = "error"; } }); });
const source = document.querySelector("#source"); if (source) source.value = ["nse", "crypto", "demo"].includes(config.source) ? config.source : "nse";
document.querySelector("#refresh")?.addEventListener("click", async (e) => { try { e.target.disabled = true; await request("/api/refresh", { source: source.value }); document.querySelector("#job").textContent = "Scan started. Current references still expire on schedule."; } catch (error) { document.querySelector("#job").textContent = error.message; e.target.disabled = false; } });
document.querySelector("#import")?.addEventListener("change", async (e) => { const file = e.target.files[0]; if (!file) return; try { if (file.size > 4e6) throw Error("Import file is larger than 4 MB."); const data = JSON.parse(await file.text()); await request("/api/import", data); location.reload(); } catch (error) { document.querySelector("#job").textContent = error.message; } });
if (config.server) setInterval(async () => { try { const r = await fetch("/api/state", { cache: "no-store" }), state = await r.json(); document.querySelector("#job").textContent = state.job.running ? "Scanning current data…" : state.job.error || "Snapshot ready. References expire when their signal window ends."; const refresh = document.querySelector("#refresh"); refresh.disabled = state.job.running; if (state.builtAt !== config.builtAt && !/INPUT|SELECT/.test(document.activeElement.tagName)) location.reload(); } catch { document.querySelector("#job").textContent = "Local app connection unavailable."; } }, 2500);
