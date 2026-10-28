"use strict";
// Static hosting: local paper records only. No broker credentials or order API.
(() => {
  const initial = JSON.parse(document.querySelector("#bootstrap").textContent), core = window.FreshCore;
  const snapshot = initial.snapshot, key = "fresh-paper-v2-" + (snapshot.demo ? "demo" : "live");
  let book = [], storageError = "";
  try {
    const saved = localStorage.getItem(key); book = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(book) || book.some((t) => !t || !["OPEN", "CLOSED"].includes(t.status)
      || ![t.id, t.instrumentId, t.symbol, t.currency, t.family].every((v) => typeof v === "string" && v.length > 0)
      || !["BUY", "SELL"].includes(t.side) || !Number.isFinite(Date.parse(t.entryAt))
      || ![t.entry, t.stop, t.target, t.quantity, t.tickSize].every((v) => Number.isFinite(v) && v > 0)
      || t.status === "CLOSED" && (!t.exit || ![t.exit.price, t.exit.gross].every(Number.isFinite)
        || !(t.exit.net === null || Number.isFinite(t.exit.net))))) throw Error("Invalid paper record");
    book = core.observe(book, snapshot.observedQuotes || {}, snapshot.demo ? Date.parse(snapshot.builtAt) : Date.now());
    localStorage.setItem(key, JSON.stringify(book));
  } catch { storageError = "Browser paper storage is unavailable or damaged. Export your existing record before clearing storage. Recording is disabled."; book = []; }
  const markup = new DOMParser().parseFromString(core.render(snapshot, { hosted: true, book }), "text/html");
  document.querySelector("main").replaceWith(markup.querySelector("main"));
  // Keep the original publication revision; rendering the local book must not change it.
  document.querySelector("#bootstrap").textContent = JSON.stringify(initial);
  if (storageError) document.querySelector("#job").textContent = storageError;
  const save = (next) => {
    if (storageError) throw Error(storageError);
    localStorage.setItem(key, JSON.stringify(next)); book = next;
  };
  window.FreshHosted = {
    async request(url, body) {
      if (storageError) throw Error(storageError);
      const now = snapshot.demo ? Date.parse(snapshot.builtAt) : Date.now();
      if (url === "/api/paper") {
        const plan = snapshot.results.flatMap((r) => r.plans).find((p) => p.id === body.planId);
        save(core.openTrade(book, plan, { fill: body.fill, quantity: body.quantity, now }));
      } else if (url === "/api/paper/close") {
        if (!book.some((t) => t.id === body.id)) throw Error("PAPER_TRADE_NOT_FOUND");
        save(book.map((t) => t.id === body.id ? core.closeTrade(t, { price: body.price, costs: body.costs, at: new Date(Math.max(now, Date.parse(t.entryAt))).toISOString() }) : t));
      } else throw Error("This action needs the local app.");
      return { ok: true };
    }
  };
  document.querySelector("#reload-snapshot").addEventListener("click", () => location.reload());
  document.querySelector("#export-paper").addEventListener("click", () => {
    // Preserve the raw record for recovery if its schema cannot be read.
    let raw; try { raw = localStorage.getItem(key) || "[]"; } catch { document.querySelector("#job").textContent = "Browser storage cannot be read."; return; }
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" })), a = document.createElement("a");
    a.href = url; a.download = snapshot.demo ? "fresh-paper-demo.json" : "fresh-paper-live.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (storageError) document.querySelectorAll(".record,.close-trade").forEach((b) => b.remove());
  if (location.protocol !== "file:") setInterval(async () => {
    try {
      const response = await fetch("./version.json?t=" + Date.now(), { cache: "no-store" }); if (!response.ok) throw Error();
      const version = await response.json();
      if (version.revision && version.revision !== initial.revision) {
        document.querySelector("#job").textContent = "New snapshot available. Check for update when ready.";
        if (!/INPUT|SELECT/.test(document.activeElement.tagName) && !document.querySelector(".fill-details[open]")) location.reload();
      }
    } catch { document.querySelector("#job").textContent = "Update check unavailable. Displayed references still expire on schedule."; }
  }, 30000);
})();
