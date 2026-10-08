/* SafeSpend — local ADHD-friendly money decision planner.
   All figures come from one ledger stored in localStorage. Nothing leaves this device. */
(function () {
  "use strict";

  const STORAGE_KEY = "safespend.v1";
  const CURRENCIES = {
    USD: { symbol: "$", label: "US dollar" },
    CAD: { symbol: "CA$", label: "Canadian dollar" },
    GBP: { symbol: "£", label: "British pound" },
    EUR: { symbol: "€", label: "Euro" },
    AUD: { symbol: "A$", label: "Australian dollar" },
    NZD: { symbol: "NZ$", label: "New Zealand dollar" },
    PKR: { symbol: "Rs", label: "Pakistani rupee" },
    AED: { symbol: "AED", label: "UAE dirham" },
    SAR: { symbol: "SAR", label: "Saudi riyal" }
  };
  const DEFAULT_CATEGORIES = ["Groceries", "Transport", "Eating out", "Household", "Health", "Personal", "Fun", "Kids", "Pets", "Other"];
  const LEAK_CATEGORIES = ["Subscription", "Late fee", "Duplicate purchase", "Food delivery", "Impulse spend", "Unused membership", "Other"];

  const ui = {
    view: "home",
    modal: null,
    toast: "",
    horizon: "payday",
    billFilter: "upcoming",
    expenseRange: "month",
    afford: { name: "", price: "", alts: "" },
    comparisons: [],
    onboardStep: 0,
    resetStep: 0,
    resetDraft: null,
    moreOpen: false,
    confirm: null
  };

  let state = load();

  function uid() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function parseISO(iso) {
    const [y, m, d] = String(iso || "").split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  function toISO(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }
  function addDays(iso, days) {
    const d = parseISO(iso) || new Date();
    d.setDate(d.getDate() + days);
    return toISO(d);
  }
  function endOfWeek(iso) {
    const d = parseISO(iso) || new Date();
    const day = d.getDay();
    const diff = day === 0 ? 0 : 7 - day;
    d.setDate(d.getDate() + diff);
    return toISO(d);
  }
  function endOfMonth(iso) {
    const d = parseISO(iso) || new Date();
    return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }
  function addMonths(iso, n) {
    const d = parseISO(iso) || new Date();
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return toISO(d);
  }
  function formatDate(iso) {
    const d = parseISO(iso);
    if (!d) return "No date";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function daysUntil(iso) {
    const d = parseISO(iso);
    if (!d) return null;
    const t = parseISO(todayISO());
    return Math.round((d - t) / 86400000);
  }
  function dueLabel(iso) {
    const n = daysUntil(iso);
    if (n === null) return "No due date";
    if (n === 0) return "Due today";
    if (n === 1) return "Due tomorrow";
    if (n > 1) return "Due in " + n + " days";
    if (n === -1) return "1 day overdue";
    return Math.abs(n) + " days overdue";
  }
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;")
      .replace(/'/g, "&#" + "39;");
  }
  function num(v) {
    if (typeof v === "number") return v;
    const cleaned = String(v ?? "").replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  function symbol() {
    if (state.settings.customSymbol) return state.settings.customSymbol;
    return (CURRENCIES[state.settings.currency] || CURRENCIES.USD).symbol;
  }
  function money(n) {
    const v = round2(n);
    const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? "−" : "") + symbol() + abs;
  }
  function clamp0(n) { return Math.max(0, round2(n)); }

  function defaultState() {
    return {
      version: 1,
      onboarded: false,
      openingBalance: 0,
      transactions: [],
      bills: [],
      funds: [],
      essentials: [],
      incomeSources: [],
      impulses: [],
      leaks: [],
      settings: {
        currency: "USD",
        customSymbol: "",
        theme: "warm",
        paySchedule: "biweekly",
        nextPayday: "",
        safetyBuffer: 150,
        categories: DEFAULT_CATEGORIES.slice(),
        lastExport: null,
        createdAt: todayISO(),
        displayName: ""
      }
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const data = JSON.parse(raw);
      const base = defaultState();
      data.settings = Object.assign(base.settings, data.settings || {});
      ["transactions", "bills", "funds", "essentials", "incomeSources", "impulses", "leaks"].forEach(function (k) {
        if (!Array.isArray(data[k])) data[k] = [];
      });
      if (typeof data.openingBalance !== "number") data.openingBalance = 0;
      return data;
    } catch (e) {
      return defaultState();
    }
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function commit() {
    save();
    render();
  }

  function signed(t) {
    if (t.type === "income") return round2(t.amount);
    if (t.type === "adjustment") return round2(t.amount);
    return -round2(t.amount);
  }
  function currentBalance() {
    return round2(state.openingBalance + state.transactions.reduce(function (s, t) { return s + signed(t); }, 0));
  }
  function nextPaydaySuggestion(iso, schedule) {
    if (!iso) return "";
    if (schedule === "weekly") return addDays(iso, 7);
    if (schedule === "biweekly") return addDays(iso, 14);
    if (schedule === "monthly") return addMonths(iso, 1);
    if (schedule === "twice-monthly") {
      const d = parseISO(iso);
      if (d.getDate() < 15) return toISO(new Date(d.getFullYear(), d.getMonth(), 15));
      if (d.getDate() === 15) return endOfMonth(iso);
      return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 15));
    }
    return "";
  }
  function horizonDate(horizon) {
    const today = todayISO();
    if (horizon === "today") return today;
    if (horizon === "week") return endOfWeek(today);
    if (horizon === "month") return endOfMonth(today);
    if (state.settings.nextPayday && state.settings.nextPayday >= today) return state.settings.nextPayday;
    return endOfMonth(today);
  }
  function horizonLabel(horizon) {
    return { today: "Today", week: "This week", payday: "Until payday", month: "This month" }[horizon] || "Until payday";
  }
  function periodStart() {
    const payday = state.settings.nextPayday;
    const schedule = state.settings.paySchedule;
    if (!payday) return addDays(todayISO(), -30);
    if (schedule === "weekly") return addDays(payday, -7);
    if (schedule === "biweekly") return addDays(payday, -14);
    if (schedule === "monthly") return addMonths(payday, -1);
    if (schedule === "twice-monthly") return addDays(payday, -15);
    return addDays(payday, -30);
  }

  function snapshot(horizon) {
    const end = horizonDate(horizon);
    const today = todayISO();
    const balance = currentBalance();
    const bills = state.bills.filter(function (b) {
      return !b.paid && b.dueDate && b.dueDate <= end;
    });
    const billTotal = round2(bills.reduce(function (s, b) { return s + round2(b.amount); }, 0));
    const funds = state.funds.map(function (f) {
      const setAside = clamp0(f.setAside);
      if (!setAside) return null;
      const applies = f.protectAlways || !f.byDate || f.byDate <= end;
      if (!applies) return null;
      return { id: f.id, name: f.name, amount: setAside, byDate: f.byDate };
    }).filter(Boolean);
    const fundTotal = round2(funds.reduce(function (s, f) { return s + f.amount; }, 0));
    const essentials = state.essentials.map(function (e) {
      const include = (horizon === "month") || (horizon === "payday" && e.horizon !== "month") || (e.horizon === horizon);
      if (!include) return null;
      if (horizon === "today" || horizon === "week") return null;
      const spent = state.transactions.filter(function (t) {
        return t.type === "expense" && t.category === e.category && t.date >= periodStart() && t.date <= today;
      }).reduce(function (s, t) { return s + round2(t.amount); }, 0);
      const remaining = clamp0(round2(e.amount) - spent);
      return remaining > 0 ? { id: e.id, name: e.name, amount: remaining, spent: round2(spent) } : null;
    }).filter(Boolean);
    const essentialTotal = round2(essentials.reduce(function (s, e) { return s + e.amount; }, 0));
    const buffer = clamp0(state.settings.safetyBuffer);
    const protectedTotal = round2(billTotal + fundTotal + essentialTotal + buffer);
    const safe = round2(balance - protectedTotal);
    const projected = state.incomeSources.filter(function (src) {
      return src.nextDate && src.nextDate <= end && src.nextDate >= today;
    });
    const projectedTotal = round2(projected.reduce(function (s, src) { return s + round2(src.amount); }, 0));
    return {
      horizon: horizon,
      end: end,
      balance: balance,
      bills: bills,
      billTotal: billTotal,
      funds: funds,
      fundTotal: fundTotal,
      essentials: essentials,
      essentialTotal: essentialTotal,
      buffer: buffer,
      protectedTotal: protectedTotal,
      safe: safe,
      projected: projected,
      projectedTotal: projectedTotal,
      paydayMissing: horizon === "payday" && !(state.settings.nextPayday && state.settings.nextPayday >= today)
    };
  }

  function verdictFor(after, price, before) {
    const buffer = clamp0(state.settings.safetyBuffer);
    if (after < 0) {
      return {
        key: "wait",
        label: "Wait for Now",
        detail: "This would use money that is protecting bills, funds, or your buffer. Waiting keeps those commitments intact."
      };
    }
    const thin = after < Math.max(25, buffer * 0.25) || (before > 0 && price > before * 0.5);
    if (thin) {
      return {
        key: "pause",
        label: "Pause & Check",
        detail: "You could pay for this and still cover what is protected, but the cushion afterward is thin."
      };
    }
    return {
      key: "fits",
      label: "Fits Your Plan",
      detail: "Bills, fund set-asides, and your safety buffer stay covered after this purchase."
    };
  }

  function monthKey(iso) { return String(iso || "").slice(0, 7); }
  function leakMonthly(leak) {
    const amount = round2(leak.amount);
    if (leak.frequency === "weekly") return round2(amount * 52 / 12);
    if (leak.frequency === "monthly") return amount;
    if (monthKey(leak.date) === monthKey(todayISO())) return amount;
    return 0;
  }

  function icon(name) {
    const paths = {
      home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10.5V20h12v-9.5"/>',
      in: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/><path d="M4 19h16"/>',
      out: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
      bill: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      fund: '<path d="M4 8h16v10H4z"/><path d="M4 8l8-4 8 4"/>',
      afford: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
      pause: '<circle cx="12" cy="12" r="8"/><path d="M10 9v6M14 9v6"/>',
      leak: '<path d="M12 3s6 6.2 6 10a6 6 0 1 1-12 0c0-3.8 6-10 6-10z"/>',
      reset: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/>',
      insight: '<path d="M5 19V10M12 19V5M19 19v-7"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
      more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || "") + "</svg>";
  }

  function toast(msg) {
    ui.toast = msg;
    render();
    setTimeout(function () {
      if (ui.toast === msg) { ui.toast = ""; render(); }
    }, 2800);
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.settings.theme === "dusk" ? "dusk" : "warm");
  }

  function render() {
    applyTheme();
    const root = document.getElementById("app");
    if (!state.onboarded) {
      root.innerHTML = renderOnboarding();
      return;
    }
    root.innerHTML = renderShell();
    const first = document.querySelector(".modal input, .modal select, .modal textarea");
    if (first) first.focus();
  }

  function navItems() {
    return [
      ["home", "Today", "home"],
      ["income", "Money in", "in"],
      ["expenses", "Spending", "out"],
      ["bills", "Bills", "bill"],
      ["funds", "Future funds", "fund"],
      ["afford", "Can I afford this?", "afford"],
      ["pause", "Impulse pause", "pause"],
      ["leaks", "Money leaks", "leak"],
      ["reset", "5-minute reset", "reset"],
      ["insights", "Insights", "insight"],
      ["settings", "Settings", "gear"]
    ];
  }

  function renderShell() {
    const snap = snapshot(ui.horizon);
    const ready = state.impulses.filter(function (i) { return i.status === "waiting" && i.waitUntil <= todayISO(); }).length;
    const nav = navItems().map(function (item) {
      const badge = item[0] === "pause" && ready ? ' <span class="badge soon">' + ready + " ready</span>" : "";
      return '<button type="button" data-action="nav" data-view="' + item[0] + '" class="' + (ui.view === item[0] ? "active" : "") + '">' + icon(item[2]) + "<span>" + item[1] + badge + "</span></button>";
    }).join("");
    const bottom = [
      ["home", "Today", "home"],
      ["afford", "Afford", "afford"],
      ["bills", "Bills", "bill"],
      ["pause", "Pause", "pause"],
      ["more", "More", "more"]
    ].map(function (item) {
      const active = item[0] === "more" ? ui.moreOpen : ui.view === item[0];
      return '<button type="button" data-action="' + (item[0] === "more" ? "more" : "nav") + '" data-view="' + item[0] + '" class="' + (active ? "active" : "") + '">' + icon(item[2]) + "<span>" + item[1] + "</span></button>";
    }).join("");
    return '<div class="app-shell"><aside class="sidebar"><div class="brand"><div class="mark">' + icon("home") + '</div><div><strong>SafeSpend</strong><span>Spend with a plan</span></div></div><nav class="nav" aria-label="Primary">' + nav + '</nav><div class="side-note">Your data stays on this device. Nothing is uploaded.</div></aside><div class="main"><div id="view">' + renderView(snap) + '</div></div></div><nav class="bottom-nav" aria-label="Mobile">' + bottom + "</nav>" + renderMore() + renderModal() + (ui.toast ? '<div class="toast" role="status">' + esc(ui.toast) + "</div>" : "");
  }

  function renderMore() {
    if (!ui.moreOpen) return "";
    const extra = ["income", "expenses", "funds", "leaks", "reset", "insights", "settings"];
    const buttons = navItems().filter(function (i) { return extra.indexOf(i[0]) >= 0; }).map(function (item) {
      return '<button type="button" class="btn" data-action="nav" data-view="' + item[0] + '">' + item[1] + "</button>";
    }).join("");
    return '<div class="modal-back" data-action="close-more"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="more-title"><h2 id="more-title">More</h2><p class="sub">The rest of SafeSpend.</p><div class="actions">' + buttons + "</div></div></div>";
  }

  function pageHead(kicker, title, sub) {
    return '<header class="topbar"><div><div class="eyebrow">' + esc(kicker) + "</div><h1>" + esc(title) + "</h1>" + (sub ? '<p class="sub">' + sub + "</p>" : "") + '</div><div class="privacy">Your data stays on this device</div></header>';
  }

  function renderView(snap) {
    const views = {
      home: renderHome,
      income: renderIncome,
      expenses: renderExpenses,
      bills: renderBills,
      funds: renderFunds,
      afford: renderAfford,
      pause: renderPause,
      leaks: renderLeaks,
      reset: renderReset,
      insights: renderInsights,
      settings: renderSettings
    };
    return (views[ui.view] || renderHome)(snap);
  }

  function renderHome() {
    const snap = snapshot(ui.horizon);
    const name = state.settings.displayName ? state.settings.displayName.split(" ")[0] : "";
    const greet = (name ? name + ", here is" : "Here is") + " what you can safely spend";
    const horizons = ["today", "week", "payday", "month"].map(function (h) {
      return '<button type="button" data-action="horizon" data-horizon="' + h + '" class="' + (ui.horizon === h ? "active" : "") + '">' + horizonLabel(h) + "</button>";
    }).join("");
    const billLines = snap.bills.map(function (b) { return esc(b.name) + " " + money(b.amount); }).join(" · ");
    const fundLines = snap.funds.map(function (f) { return esc(f.name) + " " + money(f.amount); }).join(" · ");
    const essLines = snap.essentials.map(function (e) { return esc(e.name) + " " + money(e.amount); }).join(" · ");
    const status = snap.safe < 0
      ? "Protected commitments are " + money(Math.abs(snap.safe)) + " above today’s balance. That is information, not a failure."
      : "This is what’s left after protecting bills, funds, essentials, and your buffer.";
    const upcoming = state.bills.filter(function (b) { return !b.paid; }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; }).slice(0, 5);
    const timeline = upcoming.length ? upcoming.map(function (b) {
      const late = b.dueDate < todayISO();
      return '<div class="t-item"><div class="rail"></div><div class="row"><div><h3>' + esc(b.name) + '</h3><div class="meta">' + dueLabel(b.dueDate) + " · " + formatDate(b.dueDate) + (b.autopay ? " · Autopay reminder" : "") + '</div></div><div><strong>' + money(b.amount) + "</strong> " + (late ? '<span class="badge late">Overdue</span>' : '<span class="badge soon">Unpaid</span>') + "</div></div></div>";
    }).join("") : '<div class="empty"><h3>No bills listed yet</h3><p>Add rent, utilities, or debt payments so they stop looking like spendable money.</p></div>';
    const insight = homeInsight(snap);
    const backup = !state.settings.lastExport && state.transactions.length + state.bills.length > 2
      ? '<div class="callout warm" style="margin-bottom:14px"><strong>Backup reminder.</strong> A JSON export is the only copy outside this browser. Clearing browser data can erase SafeSpend. <button class="linkish" data-action="nav" data-view="settings">Export backup</button></div>'
      : "";
    const paydayNote = snap.paydayMissing ? '<div class="callout warm"><strong>Payday isn’t set.</strong> Until-payday is using the end of the month. <button class="linkish" data-action="nav" data-view="settings">Set payday</button></div>' : "";
    return pageHead("Today", greet, "Know what you can safely spend — before you spend it.") +
      backup +
      '<section class="hero"><article class="card hero-card"><div class="sts-label">Safe to spend · ' + horizonLabel(ui.horizon) + '</div><div class="sts-amount ' + (snap.safe < 0 ? "neg" : "ok") + '" aria-label="Safe to spend ' + money(snap.safe) + '">' + money(snap.safe) + '</div><p class="promise">' + status + '</p><div class="horizons" role="tablist">' + horizons + "</div>" +
      paydayNote +
      '<div class="breakdown"><div class="kicker">How this is calculated</div><div class="line"><span>Current balance</span><strong>' + money(snap.balance) + '</strong></div><div class="line"><span>Unpaid bills in this window</span><strong>−' + money(snap.billTotal) + "</strong></div>" + (billLines ? '<div class="mini-items">' + billLines + "</div>" : "") +
      '<div class="line"><span>Future-fund set-asides</span><strong>−' + money(snap.fundTotal) + "</strong></div>" + (fundLines ? '<div class="mini-items">' + fundLines + "</div>" : "") +
      '<div class="line"><span>Essentials still expected</span><strong>−' + money(snap.essentialTotal) + "</strong></div>" + (essLines ? '<div class="mini-items">' + essLines + "</div>" : "") +
      '<div class="line"><span>Safety buffer</span><strong>−' + money(snap.buffer) + '</strong></div><div class="line total"><span>Safe to spend</span><strong>' + money(snap.safe) + "</strong></div></div>" +
      '<p class="help" style="margin-top:8px">Projected income is not included. Paid bills and money already moved into funds are not deducted again.</p></article>' +
      '<aside class="stack"><div class="card"><div class="kicker">Protected money</div><strong class="money" style="font-size:1.8rem;font-family:var(--font-display)">' + money(snap.protectedTotal) + '</strong><p class="meta">Held back so bills, goals, and a buffer are not spent by accident.</p></div>' +
      '<div class="callout"><strong>Projected income ' + money(snap.projectedTotal) + '</strong><p class="meta">Expected before ' + formatDate(snap.end) + ", shown separately. It becomes spendable only after you mark it received.</p></div>" +
      '<div class="card"><div class="kicker">A useful next step</div><p style="margin:8px 0">' + insight + '</p><button class="btn btn-primary" data-action="nav" data-view="afford">Can I afford this?</button></div></aside></section>' +
      '<div class="stat-grid"><article class="card stat"><div class="kicker">Current balance</div><strong>' + money(snap.balance) + '</strong></article><article class="card stat"><div class="kicker">Protected</div><strong>' + money(snap.protectedTotal) + '</strong></article><article class="card stat"><div class="kicker">Bills in window</div><strong>' + money(snap.billTotal) + '</strong></article><article class="card stat"><div class="kicker">Safety buffer</div><strong>' + money(snap.buffer) + "</strong></article></div>" +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="expense">Add expense</button><button class="btn" data-action="open" data-modal="income">Add income</button><button class="btn" data-action="open" data-modal="paybill">Pay bill</button><button class="btn" data-action="open" data-modal="fund">Add future fund</button><button class="btn btn-blue" data-action="nav" data-view="afford">Can I afford this?</button></div>' +
      '<section class="card"><div class="section-head"><h2>Upcoming bills</h2><button class="btn btn-ghost" data-action="nav" data-view="bills">All bills</button></div><div class="timeline">' + timeline + "</div></section>";
  }

  function homeInsight(snap) {
    const avoided = state.impulses.filter(function (i) { return i.status === "avoided"; }).reduce(function (s, i) { return s + round2(i.price); }, 0);
    if (snap.safe < 0) return "New spending waits until protected commitments fit inside the balance, or you adjust what you’re protecting.";
    if (avoided > 0) return "You’ve let " + money(avoided) + " in paused purchases pass. That money is still in the plan.";
    if (!state.bills.length) return "Add the bills due before payday. Safe to Spend gets honest once those are protected.";
    return "Bills in this window are already pulled out of the number above. A purchase check takes about 15 seconds.";
  }

  function renderIncome() {
    const today = todayISO();
    const sources = state.incomeSources.slice().sort(function (a, b) { return (a.nextDate || "") < (b.nextDate || "") ? -1 : 1; });
    const received = state.transactions.filter(function (t) { return t.type === "income"; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    const expected = sources.reduce(function (s, src) { return s + round2(src.amount); }, 0);
    const passed = state.settings.nextPayday && state.settings.nextPayday < today;
    const list = sources.length ? sources.map(function (src) {
      return '<div class="row"><div><h3>' + esc(src.name) + '</h3><div class="meta">' + esc(src.kind) + " · " + esc(src.schedule) + " · next " + formatDate(src.nextDate) + '</div></div><div class="inline-actions"><strong>' + money(src.amount) + '</strong><button class="btn" data-action="receive" data-id="' + src.id + '">Received</button><button class="btn btn-ghost" data-action="edit-source" data-id="' + src.id + '">Edit</button><button class="btn btn-ghost" data-action="delete-source" data-id="' + src.id + '">Delete</button></div></div>';
    }).join("") : '<div class="empty"><h3>No expected income yet</h3><p>Add a paycheck or freelance payment. Expected money stays out of Safe to Spend until it arrives.</p></div>';
    const hist = received.length ? received.slice(0, 12).map(function (t) {
      return '<div class="row"><div><h3>' + esc(t.description) + '</h3><div class="meta">' + formatDate(t.date) + " · received</div></div><div><strong>" + money(t.amount) + '</strong> <button class="btn btn-ghost" data-action="delete-tx" data-id="' + t.id + '">Remove</button></div></div>';
    }).join("") : '<p class="meta">Received income will show here and raise your balance.</p>';
    return pageHead("Money in", "Income, without pretending it’s here yet", "Expected pay is tracked separately from cash you can spend.") +
      (passed ? '<div class="callout warm" style="margin-bottom:14px"><strong>Payday may have passed.</strong> Mark the income received only if it has landed in your balance.</div>' : "") +
      '<div class="stat-grid"><article class="card stat"><div class="kicker">Next payday</div><strong>' + (state.settings.nextPayday ? formatDate(state.settings.nextPayday) : "Not set") + '</strong></article><article class="card stat"><div class="kicker">Expected sources</div><strong>' + money(expected) + '</strong></article><article class="card stat"><div class="kicker">Current balance</div><strong>' + money(currentBalance()) + '</strong></article><article class="card stat"><div class="kicker">Schedule</div><strong style="font-size:1.1rem">' + esc(state.settings.paySchedule) + '</strong></article></div>' +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="source">Add expected income</button><button class="btn" data-action="open" data-modal="income">Log money received</button></div>' +
      '<div class="grid-2"><section class="card"><div class="section-head"><h2>Expected</h2></div>' + list + '</section><section class="card"><div class="section-head"><h2>Received</h2></div>' + hist + "</section></div>";
  }

  function rangeStart(range) {
    const today = todayISO();
    if (range === "today") return today;
    if (range === "week") return addDays(today, -6);
    return today.slice(0, 8) + "01";
  }
  function renderExpenses() {
    const start = rangeStart(ui.expenseRange);
    const txs = state.transactions.filter(function (t) { return t.type === "expense" && t.date >= start; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    const total = round2(txs.reduce(function (s, t) { return s + round2(t.amount); }, 0));
    const ranges = ["today", "week", "month"].map(function (r) {
      return '<button type="button" class="' + (ui.expenseRange === r ? "active" : "") + '" data-action="expense-range" data-range="' + r + '">' + (r === "today" ? "Today" : r === "week" ? "7 days" : "This month") + "</button>";
    }).join("");
    const rows = txs.length ? txs.map(function (t) {
      return '<div class="row"><div><h3>' + esc(t.description) + '</h3><div class="meta">' + formatDate(t.date) + " · " + esc(t.category || "Other") + '</div></div><div class="inline-actions"><strong>' + money(t.amount) + '</strong><button class="btn btn-ghost" data-action="edit-tx" data-id="' + t.id + '">Edit</button><button class="btn btn-ghost" data-action="delete-tx" data-id="' + t.id + '">Delete</button></div></div>';
    }).join("") : '<div class="empty"><h3>Nothing logged in this window</h3><p>Everyday spending goes here. Bills you already listed should be marked paid on Bills, so they are not counted twice.</p></div>';
    const ess = state.essentials.length ? state.essentials.map(function (e) {
      return '<div class="row"><div><h3>' + esc(e.name) + '</h3><div class="meta">' + esc(e.category) + " · " + esc(e.horizon) + ' window</div></div><div class="inline-actions"><strong>' + money(e.amount) + '</strong><button class="btn btn-ghost" data-action="delete-essential" data-id="' + e.id + '">Remove</button></div></div>';
    }).join("") : '<p class="meta">Optional. Example: groceries you still expect to buy before payday. Money already spent in that category is not deducted again.</p>';
    return pageHead("Spending", "Expenses, lightly tracked", "Log what left the account. Safe to Spend updates immediately.") +
      '<div class="card" style="margin-bottom:14px"><div class="filters" role="tablist">' + ranges + '</div><div class="kicker">Spent in view</div><strong style="font-family:var(--font-display);font-size:2rem">' + money(total) + "</strong></div>" +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="expense">Add expense</button><button class="btn" data-action="open" data-modal="essential">Add expected essential</button></div>' +
      '<div class="grid-2"><section class="card"><div class="section-head"><h2>Logged spending</h2></div>' + rows + '</section><section class="card"><div class="section-head"><h2>Expected essentials</h2></div>' + ess + "</section></div>";
  }

  function renderBills() {
    const today = todayISO();
    const filters = [["overdue", "Overdue"], ["soon", "Due soon"], ["upcoming", "Upcoming"], ["paid", "Paid"]];
    const chips = filters.map(function (f) {
      return '<button type="button" class="' + (ui.billFilter === f[0] ? "active" : "") + '" data-action="bill-filter" data-filter="' + f[0] + '">' + f[1] + "</button>";
    }).join("");
    let items = state.bills.slice();
    if (ui.billFilter === "overdue") items = items.filter(function (b) { return !b.paid && b.dueDate < today; });
    if (ui.billFilter === "soon") items = items.filter(function (b) { return !b.paid && b.dueDate >= today && daysUntil(b.dueDate) <= 3; });
    if (ui.billFilter === "upcoming") items = items.filter(function (b) { return !b.paid; });
    if (ui.billFilter === "paid") {
      const payments = state.transactions.filter(function (t) { return t.type === "bill-payment"; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      const paidBills = state.bills.filter(function (b) { return b.paid; });
      const rows = payments.map(function (t) {
        return '<div class="row"><div><h3>' + esc(t.description) + '</h3><div class="meta">' + formatDate(t.date) + (t.onTime ? " · on time" : " · after due date") + '</div></div><strong>' + money(t.amount) + "</strong></div>";
      }).join("") + paidBills.map(function (b) {
        return '<div class="row"><div><h3>' + esc(b.name) + '</h3><div class="meta">Marked paid ' + formatDate(b.paidDate) + '</div></div><strong>' + money(b.amount) + "</strong></div>";
      }).join("");
      return pageHead("Bills", "Bills that are not spendable money", "Unpaid bills are protected in Safe to Spend. Marking one paid does not free that money twice.") +
        '<div class="filters">' + chips + '</div><div class="actions"><button class="btn btn-primary" data-action="open" data-modal="bill">Add bill</button></div><section class="card">' + (rows || '<div class="empty"><h3>No paid bills yet</h3><p>When you mark a bill paid, it lands here.</p></div>') + "</section>";
    }
    items.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; });
    const rows = items.length ? items.map(function (b) {
      const late = b.dueDate < today;
      const soon = !late && daysUntil(b.dueDate) <= 3;
      return '<div class="row"><div><h3>' + esc(b.name) + ' <span class="badge ' + (late ? "late" : soon ? "soon" : "") + '">' + (late ? "Overdue" : soon ? "Due soon" : "Upcoming") + '</span></h3><div class="meta">' + dueLabel(b.dueDate) + " · " + esc(b.schedule) + " · " + esc(b.kind) + (b.autopay ? " · Autopay" : "") + '</div></div><div class="inline-actions"><strong>' + money(b.amount) + '</strong><button class="btn" data-action="open-pay" data-id="' + b.id + '">Mark paid</button><button class="btn btn-ghost" data-action="edit-bill" data-id="' + b.id + '">Edit</button><button class="btn btn-ghost" data-action="delete-bill" data-id="' + b.id + '">Delete</button></div></div>';
    }).join("") : '<div class="empty"><h3>Nothing in this view</h3><p>Add a bill, or switch filters. Autopay is a reminder — mark it paid when the charge lands.</p></div>';
    return pageHead("Bills", "Bills that are not spendable money", "Unpaid bills are protected in Safe to Spend. Marking one paid does not free that money twice.") +
      '<div class="filters">' + chips + '</div><div class="actions"><button class="btn btn-primary" data-action="open" data-modal="bill">Add bill</button></div><section class="card">' + rows + "</section>";
  }

  function renderFunds() {
    const cards = state.funds.length ? state.funds.map(function (f) {
      const pct = f.target > 0 ? Math.min(100, Math.round((f.saved / f.target) * 100)) : 0;
      return '<article class="card"><div class="section-head"><h2>' + esc(f.name) + '</h2><span class="badge">' + pct + '% saved</span></div><div class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></div><p class="meta" style="margin-top:8px">Saved ' + money(f.saved) + " of " + money(f.target) + " · still to set aside " + money(f.setAside || 0) + (f.byDate ? " by " + formatDate(f.byDate) : "") + '</p><div class="actions"><button class="btn" data-action="open-contrib" data-id="' + f.id + '">Add contribution</button><button class="btn btn-ghost" data-action="edit-fund" data-id="' + f.id + '">Edit</button><button class="btn btn-ghost" data-action="delete-fund" data-id="' + f.id + '">Delete</button></div></article>';
    }).join("") : '<div class="card empty"><h3>No future funds yet</h3><p>Eid gifts, insurance, travel, school fees. Set aside an amount and SafeSpend protects it until you move the money.</p><button class="btn btn-primary" data-action="open" data-modal="fund">Add a fund</button></div>';
    return pageHead("Future funds", "Irregular expenses, funded on purpose", "Saved money has already left spendable cash. Only the amount still to set aside is protected again.") +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="fund">Add future fund</button></div><div class="grid-2">' + cards + "</div>";
  }

  function renderAfford() {
    const snap = snapshot("payday");
    const price = round2(num(ui.afford.price));
    const after = round2(snap.safe - price);
    const verdict = price > 0 ? verdictFor(after, price, snap.safe) : null;
    const alts = String(ui.afford.alts || "").split(",").map(function (x) { return round2(num(x)); }).filter(function (n) { return n > 0; });
    const altRows = alts.map(function (p) {
      const a = round2(snap.safe - p);
      const v = verdictFor(a, p, snap.safe);
      return '<div class="row"><div><h3>' + money(p) + '</h3><div class="meta">' + v.label + "</div></div><strong>" + money(a) + " left</strong></div>";
    }).join("");
    const result = verdict ? '<div class="verdict ' + verdict.key + '"><div class="kicker">Recommendation</div><h3>' + verdict.label + '</h3><p>' + verdict.detail + '</p><div class="line"><span>Safe to spend now</span><strong>' + money(snap.safe) + '</strong></div><div class="line"><span>This purchase</span><strong>−' + money(price) + '</strong></div><div class="line total"><span>Safe to spend after</span><strong>' + money(after) + '</strong></div><p class="meta">Until payday (' + formatDate(snap.end) + "): bills " + money(snap.billTotal) + ", fund set-asides " + money(snap.fundTotal) + ", essentials " + money(snap.essentialTotal) + ", buffer " + money(snap.buffer) + " stay reserved. " + (after >= 0 ? "They remain covered." : "They would no longer be fully covered.") + "</p></div>" : '<div class="callout sage"><strong>Enter a price.</strong><p class="meta">You’ll see the Safe to Spend figure after the purchase, using today’s real plan.</p></div>';
    return pageHead("Can I afford this?", "Check a purchase before it happens", "The answer uses your current balance, unpaid bills, fund set-asides, essentials, and buffer.") +
      '<div class="grid-2"><section class="card"><div class="field"><label for="aff-name">Purchase</label><input id="aff-name" data-bind="name" value="' + esc(ui.afford.name) + '" placeholder="New headphones"></div><div class="field" style="margin-top:10px"><label for="aff-price">Price</label><input id="aff-price" data-bind="price" inputmode="decimal" value="' + esc(ui.afford.price) + '" placeholder="0.00"></div><div class="field" style="margin-top:10px"><label for="aff-alts">Compare other prices</label><input id="aff-alts" data-bind="alts" value="' + esc(ui.afford.alts) + '" placeholder="49, 79, 120"><p class="help">Comma-separated. Each is checked against the same Safe to Spend.</p></div><div class="actions"><button class="btn btn-primary" data-action="log-purchase"' + (price > 0 ? "" : " disabled") + '>Log this purchase</button><button class="btn" data-action="send-pause"' + (price > 0 ? "" : " disabled") + ">Pause it instead</button></div></section><section>" + result + (altRows ? '<section class="card" style="margin-top:12px"><h2>Price comparison</h2>' + altRows + "</section>" : "") + "</section></div>";
  }

  function renderPause() {
    const today = todayISO();
    const items = state.impulses.slice().sort(function (a, b) { return a.waitUntil < b.waitUntil ? -1 : 1; });
    const rows = items.length ? items.map(function (item) {
      const ready = item.status === "waiting" && item.waitUntil <= today;
      const status = item.status === "avoided" ? "Let it pass" : item.status === "bought" ? "You chose it" : ready ? "Ready to revisit" : "Waiting until " + formatDate(item.waitUntil);
      const badge = item.status === "avoided" ? "good" : item.status === "bought" ? "" : ready ? "soon" : "wait";
      return '<div class="row"><div><h3>' + esc(item.name) + ' <span class="badge ' + badge + '">' + status + '</span></h3><div class="meta">Saved ' + formatDate(item.createdAt) + (item.note ? " · " + esc(item.note) : "") + '</div></div><div class="inline-actions"><strong>' + money(item.price) + '</strong>' + (item.status === "waiting" ? '<button class="btn" data-action="pause-afford" data-id="' + item.id + '">Check affordability</button><button class="btn" data-action="pause-avoid" data-id="' + item.id + '">Let it pass</button><button class="btn btn-ghost" data-action="pause-bought" data-id="' + item.id + '">I bought it</button>' : "") + '<button class="btn btn-ghost" data-action="delete-impulse" data-id="' + item.id + '">Remove</button></div></div>';
    }).join("") : '<div class="empty"><h3>Nothing waiting</h3><p>Park a want for 24 hours, 3 days, or a week. This app can’t send phone alerts — ready items show a badge here.</p></div>';
    const avoided = state.impulses.filter(function (i) { return i.status === "avoided"; }).reduce(function (s, i) { return s + round2(i.price); }, 0);
    return pageHead("Impulse pause", "A waiting room, not a lecture", "Waiting isn’t a no. It’s a chance to check the purchase against the plan.") +
      '<div class="stat-grid"><article class="card stat"><div class="kicker">Waiting</div><strong>' + state.impulses.filter(function (i) { return i.status === "waiting"; }).length + '</strong></article><article class="card stat"><div class="kicker">Let pass</div><strong>' + money(avoided) + '</strong></article></div>' +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="impulse">Park a purchase</button></div><section class="card">' + rows + "</section>";
  }

  function renderLeaks() {
    const monthly = round2(state.leaks.reduce(function (s, l) { return s + leakMonthly(l); }, 0));
    const rows = state.leaks.length ? state.leaks.map(function (l) {
      return '<div class="row"><div><h3>' + esc(l.name) + '</h3><div class="meta">' + esc(l.category) + " · " + esc(l.frequency) + " · " + formatDate(l.date) + '</div></div><div class="inline-actions"><strong>' + money(l.amount) + '</strong><button class="btn btn-ghost" data-action="delete-leak" data-id="' + l.id + '">Remove</button></div></div>';
    }).join("") : '<div class="empty"><h3>No leaks noted</h3><p>Subscriptions, late fees, duplicates, delivery, unused memberships. If it’s already a bill, don’t add it here too.</p></div>';
    return pageHead("Money leaks", "Noticed, not judged", "A leak is just spending you might not want to repeat. Monthly totals are estimates from what you log.") +
      '<div class="card" style="margin-bottom:14px"><div class="kicker">Potentially avoidable this month</div><strong style="font-family:var(--font-display);font-size:2rem">' + money(monthly) + '</strong><p class="meta">Weekly items are converted to a monthly equivalent. One-time items count in the month they happened.</p></div>' +
      '<div class="actions"><button class="btn btn-primary" data-action="open" data-modal="leak">Add a leak</button></div><section class="card">' + rows + "</section>";
  }

  function renderReset() {
    if (!ui.resetDraft) {
      ui.resetDraft = {
        balance: String(currentBalance()),
        buffer: String(state.settings.safetyBuffer),
        unpaid: state.bills.filter(function (b) { return !b.paid; }).map(function (b) { return b.id; }),
        funds: state.funds.map(function (f) { return { id: f.id, setAside: String(f.setAside || 0) }; })
      };
    }
    const d = ui.resetDraft;
    const step = ui.resetStep;
    const dots = [0, 1, 2, 3, 4].map(function (i) { return '<i class="' + (i <= step ? "on" : "") + '"></i>'; }).join("");
    let body = "";
    if (step === 0) body = '<div class="field"><label for="rs-bal">Current balance in the account you spend from</label><input id="rs-bal" class="big-input" data-reset="balance" value="' + esc(d.balance) + '"><p class="help">We’ll trust this number. Older spending stays in history but won’t be subtracted again.</p></div>';
    if (step === 1) {
      const bills = state.bills.filter(function (b) { return !b.paid || d.unpaid.indexOf(b.id) >= 0; });
      body = bills.length ? bills.map(function (b) {
        const on = d.unpaid.indexOf(b.id) >= 0;
        return '<label class="check"><input type="checkbox" data-reset-bill="' + b.id + '"' + (on ? " checked" : "") + ">" + esc(b.name) + " · " + money(b.amount) + " · " + dueLabel(b.dueDate) + "</label>";
      }).join("") : "<p>No unpaid bills on file. You can add them after the reset.</p>";
      body = '<p class="sub">Checked bills are still unpaid and will be protected. Unchecked bills are marked paid without taking the amount off the balance you just entered.</p>' + body;
    }
    if (step === 2) {
      body = state.funds.length ? state.funds.map(function (f) {
        const row = d.funds.find(function (x) { return x.id === f.id; }) || { setAside: "0" };
        return '<div class="field" style="margin-bottom:10px"><label>Still to set aside · ' + esc(f.name) + '</label><input data-reset-fund="' + f.id + '" value="' + esc(row.setAside) + '"><p class="help">Already saved: ' + money(f.saved) + ". Don’t include money you already moved.</p></div>";
      }).join("") : "<p>No future funds yet. Skip ahead — you can add them later.</p>";
    }
    if (step === 3) body = '<div class="field"><label for="rs-buf">Safety buffer to keep untouched</label><input id="rs-buf" data-reset="buffer" value="' + esc(d.buffer) + '"><p class="help">A small buffer is enough. Zero is allowed.</p></div>';
    if (step === 4) {
      const preview = previewReset();
      body = '<div class="sts-amount ' + (preview.safe < 0 ? "neg" : "ok") + '">' + money(preview.safe) + '</div><p class="promise">Safe to spend until payday after this reset.</p><div class="line"><span>Balance you’ll use</span><strong>' + money(preview.balance) + '</strong></div><div class="line"><span>Unpaid bills</span><strong>−' + money(preview.billTotal) + '</strong></div><div class="line"><span>Set-asides</span><strong>−' + money(preview.fundTotal) + '</strong></div><div class="line"><span>Essentials still expected</span><strong>−' + money(preview.essentialTotal) + '</strong></div><div class="line"><span>Buffer</span><strong>−' + money(preview.buffer) + '</strong></div>';
    }
    return pageHead("5-minute reset", "Start again without the speech", "Missed a week? Update the few numbers that matter and go back to the dashboard.") +
      '<section class="card onboard-card"><div class="steps" aria-hidden="true">' + dots + "</div><h2>" + ["Balance", "Unpaid bills", "Fund set-asides", "Buffer", "Your number"][step] + "</h2><div style='margin-top:12px'>" + body + '</div><div class="actions"><button class="btn" data-action="reset-back"' + (step === 0 ? " disabled" : "") + ">Back</button>" + (step < 4 ? '<button class="btn btn-primary" data-action="reset-next">Continue</button>' : '<button class="btn btn-primary" data-action="reset-finish">Use this plan</button>') + "</div></section>";
  }

  function previewReset() {
    const d = ui.resetDraft || { balance: "0", buffer: "0", unpaid: [], funds: [] };
    const balance = round2(num(d.balance));
    const buffer = clamp0(num(d.buffer));
    const billTotal = round2(state.bills.filter(function (b) { return d.unpaid.indexOf(b.id) >= 0; }).reduce(function (s, b) { return s + round2(b.amount); }, 0));
    const fundTotal = round2((d.funds || []).reduce(function (s, f) { return s + clamp0(num(f.setAside)); }, 0));
    const today = todayISO();
    const essentialTotal = round2(state.essentials.reduce(function (s, e) {
      const spent = state.transactions.filter(function (t) {
        return t.type === "expense" && t.category === e.category && t.date >= periodStart() && t.date <= today;
      }).reduce(function (sum, t) { return sum + round2(t.amount); }, 0);
      return s + clamp0(round2(e.amount) - spent);
    }, 0));
    return { balance: balance, buffer: buffer, billTotal: billTotal, fundTotal: fundTotal, essentialTotal: essentialTotal, safe: round2(balance - billTotal - fundTotal - essentialTotal - buffer) };
  }

  function renderInsights() {
    const saved = state.funds.reduce(function (s, f) { return s + round2(f.saved); }, 0);
    const target = state.funds.reduce(function (s, f) { return s + round2(f.target); }, 0);
    const payments = state.transactions.filter(function (t) { return t.type === "bill-payment"; });
    const onTime = payments.filter(function (t) { return t.onTime; }).length;
    const rate = payments.length ? Math.round((onTime / payments.length) * 100) : 0;
    const avoided = state.impulses.filter(function (i) { return i.status === "avoided"; });
    const avoidedSum = avoided.reduce(function (s, i) { return s + round2(i.price); }, 0);
    const byCat = {};
    state.transactions.filter(function (t) { return t.type === "expense" && t.date >= todayISO().slice(0, 8) + "01"; }).forEach(function (t) {
      byCat[t.category || "Other"] = round2((byCat[t.category || "Other"] || 0) + t.amount);
    });
    const maxCat = Math.max.apply(null, Object.keys(byCat).map(function (k) { return byCat[k]; }).concat([1]));
    const bars = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).map(function (k) {
      return '<div class="bar-row"><span>' + esc(k) + '</span><div class="bar-track"><span style="width:' + Math.round((byCat[k] / maxCat) * 100) + '%"></span></div><strong>' + money(byCat[k]) + "</strong></div>";
    }).join("") || '<p class="meta">Log a few expenses to see a category pattern.</p>';
    const weeks = [];
    for (let i = 5; i >= 0; i--) {
      const end = addDays(todayISO(), -i * 7);
      const start = addDays(end, -6);
      const sum = state.transactions.filter(function (t) { return t.type === "expense" && t.date >= start && t.date <= end; }).reduce(function (s, t) { return s + t.amount; }, 0);
      weeks.push({ label: formatDate(start).replace(/, \d{4}/, ""), sum: round2(sum) });
    }
    const maxW = Math.max.apply(null, weeks.map(function (w) { return w.sum; }).concat([1]));
    const weekBars = weeks.map(function (w) {
      return '<div class="bar-row"><span>' + esc(w.label) + '</span><div class="bar-track"><span style="width:' + Math.round((w.sum / maxW) * 100) + '%"></span></div><strong>' + money(w.sum) + "</strong></div>";
    }).join("");
    return pageHead("Insights", "Progress, without a report card", "These numbers come only from what you’ve logged.") +
      '<div class="stat-grid"><article class="card stat"><div class="kicker">Saved in funds</div><strong>' + money(saved) + '</strong><p class="meta">of ' + money(target) + ' targeted</p></article><article class="card stat"><div class="kicker">Bills marked on time</div><strong>' + (payments.length ? rate + "%" : "—") + '</strong><p class="meta">' + onTime + " of " + payments.length + ' payments</p></article><article class="card stat"><div class="kicker">Pauses that passed</div><strong>' + money(avoidedSum) + '</strong><p class="meta">' + avoided.length + ' purchases</p></article><article class="card stat"><div class="kicker">Leaks noted</div><strong>' + money(state.leaks.reduce(function (s, l) { return s + leakMonthly(l); }, 0)) + '</strong><p class="meta">monthly equivalent</p></article></div>' +
      '<div class="grid-2" style="margin-top:14px"><section class="card"><h2>Spending this month</h2>' + bars + '</section><section class="card"><h2>Weekly spending</h2><p class="meta">Last 6 weeks, from logged expenses.</p>' + weekBars + "</section></div>";
  }

  function renderSettings() {
    const cats = state.settings.categories.map(function (c) {
      return '<span class="badge">' + esc(c) + ' <button class="linkish" data-action="delete-cat" data-name="' + esc(c) + '">remove</button></span>';
    }).join(" ");
    const opts = Object.keys(CURRENCIES).map(function (k) {
      return '<option value="' + k + '"' + (state.settings.currency === k ? " selected" : "") + ">" + k + " · " + CURRENCIES[k].label + "</option>";
    }).join("");
    return pageHead("Settings", "Make the plan yours", "Currency, payday, buffer, and your backup live here.") +
      '<div class="grid-2"><section class="card"><h2>Plan</h2><div class="form-grid" style="margin-top:12px"><div class="field"><label>Name on greeting</label><input data-setting="displayName" value="' + esc(state.settings.displayName) + '"></div><div class="field"><label>Currency</label><select data-setting="currency">' + opts + '</select></div><div class="field"><label>Custom symbol</label><input data-setting="customSymbol" value="' + esc(state.settings.customSymbol) + '" placeholder="Optional"></div><div class="field"><label>Pay schedule</label><select data-setting="paySchedule"><option' + (state.settings.paySchedule === "weekly" ? " selected" : "") + '>weekly</option><option' + (state.settings.paySchedule === "biweekly" ? " selected" : "") + '>biweekly</option><option' + (state.settings.paySchedule === "twice-monthly" ? " selected" : "") + '>twice-monthly</option><option' + (state.settings.paySchedule === "monthly" ? " selected" : "") + '>monthly</option><option' + (state.settings.paySchedule === "irregular" ? " selected" : "") + '>irregular</option></select></div><div class="field"><label>Next payday</label><input type="date" data-setting="nextPayday" value="' + esc(state.settings.nextPayday) + '"></div><div class="field"><label>Safety buffer</label><input data-setting="safetyBuffer" value="' + esc(state.settings.safetyBuffer) + '"></div><div class="field"><label>Theme</label><select data-setting="theme"><option value="warm"' + (state.settings.theme !== "dusk" ? " selected" : "") + '>Warm</option><option value="dusk"' + (state.settings.theme === "dusk" ? " selected" : "") + '>Dusk</option></select></div></div><p class="help">Changes save immediately and recalculate Safe to Spend.</p></section>' +
      '<section class="card"><h2>Categories</h2><div style="margin:10px 0">' + cats + '</div><div class="two"><input id="new-cat" placeholder="New category"><button class="btn" data-action="add-cat">Add</button></div><hr class="sep"><h2>Data</h2><p class="meta">Export is a JSON file on your computer. Import replaces what’s in this browser. Clearing browser data may erase SafeSpend — it does not sync across devices.</p><div class="actions"><button class="btn btn-primary" data-action="export">Export backup</button><button class="btn" data-action="import-pick">Import backup</button><button class="btn" data-action="demo">Load example numbers</button><button class="btn btn-danger" data-action="reset-ask">Erase everything</button></div><input id="import-file" type="file" accept="application/json,.json" hidden></section></div>';
  }

  function renderOnboarding() {
    const step = ui.onboardStep;
    const dots = [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) { return '<i class="' + (i <= step ? "on" : "") + '"></i>'; }).join("");
    const s = state.settings;
    let body = "";
    if (step === 0) body = '<p class="sub">Know what you can safely spend — before you spend it. Bills, future funds, and a buffer come out first. Expected pay stays separate until it arrives.</p><p class="meta" style="margin-top:10px">Your data stays on this device. No account, no upload.</p>';
    if (step === 1) {
      const opts = Object.keys(CURRENCIES).map(function (k) {
        return '<option value="' + k + '"' + (s.currency === k ? " selected" : "") + ">" + CURRENCIES[k].symbol + " " + k + "</option>";
      }).join("");
      body = '<div class="field"><label>Currency</label><select data-setting="currency">' + opts + '</select></div><div class="field" style="margin-top:10px"><label>What should we call you? Optional</label><input data-setting="displayName" value="' + esc(s.displayName) + '"></div>';
    }
    if (step === 2) body = '<div class="field"><label>Current balance</label><input class="big-input" data-open-balance="1" value="' + esc(state.openingBalance || "") + '" placeholder="0.00"><p class="help">The account you actually spend from. You can adjust it later.</p></div>';
    if (step === 3) body = '<div class="field"><label>How you’re paid</label><select data-setting="paySchedule"><option value="weekly">Weekly</option><option value="biweekly" selected>Every two weeks</option><option value="twice-monthly">Twice a month</option><option value="monthly">Monthly</option><option value="irregular">Irregular</option></select></div><div class="field" style="margin-top:10px"><label>Next payday</label><input type="date" data-setting="nextPayday" value="' + esc(s.nextPayday) + '"></div>';
    if (step === 4) body = '<div class="field"><label>Safety buffer</label><input class="big-input" data-setting="safetyBuffer" value="' + esc(s.safetyBuffer) + '"><p class="help">Money you don’t want a random Tuesday to touch. Zero is fine.</p></div>';
    if (step === 5) body = '<p class="sub">Add bills due soon. You can skip and add them later.</p><div id="ob-bills">' + state.bills.map(function (b) { return '<div class="row"><span>' + esc(b.name) + "</span><strong>" + money(b.amount) + "</strong></div>"; }).join("") + '</div><div class="form-grid" style="margin-top:10px"><div class="field"><label>Name</label><input id="ob-bill-name" placeholder="Rent"></div><div class="field"><label>Amount</label><input id="ob-bill-amt" inputmode="decimal"></div><div class="field"><label>Due</label><input id="ob-bill-date" type="date"></div><div class="field"><label>Repeats</label><select id="ob-bill-sch"><option value="monthly">Monthly</option><option value="once">Once</option><option value="weekly">Weekly</option></select></div></div><button class="btn" data-action="ob-add-bill">Add bill</button>';
    if (step === 6) body = '<p class="sub">Optional. A fund for something irregular, plus what you want to set aside now.</p>' + state.funds.map(function (f) { return '<div class="row"><span>' + esc(f.name) + "</span><strong>" + money(f.setAside) + " set aside</strong></div>"; }).join("") + '<div class="form-grid" style="margin-top:10px"><div class="field"><label>Name</label><input id="ob-fund-name" placeholder="Car insurance"></div><div class="field"><label>Target</label><input id="ob-fund-target" inputmode="decimal"></div><div class="field"><label>Set aside now</label><input id="ob-fund-aside" inputmode="decimal"></div></div><button class="btn" data-action="ob-add-fund">Add fund</button>';
    if (step === 7) {
      const snap = snapshot("payday");
      body = '<div class="sts-label">Safe to spend · until payday</div><div class="sts-amount ' + (snap.safe < 0 ? "neg" : "ok") + '">' + money(snap.safe) + '</div><p class="promise">' + (snap.safe < 0 ? "Protected commitments are larger than the balance. You can still adjust bills or the buffer." : "Bills, set-asides, and your buffer are already out of this number.") + "</p>";
    }
    const titles = ["Welcome", "Currency", "Balance", "Payday", "Buffer", "Bills", "Future funds", "Your number"];
    return '<div class="onboard"><section class="card onboard-card"><div class="brand" style="margin-bottom:16px"><div class="mark">' + icon("home") + '</div><div><strong>SafeSpend</strong><span>ADHD-friendly money decisions</span></div></div><div class="steps">' + dots + '</div><div class="eyebrow">Step ' + (step + 1) + " of 8</div><h1 style='font-size:2rem;margin:6px 0 12px'>" + titles[step] + "</h1>" + body + '<div class="actions"><button class="btn" data-action="ob-back"' + (step === 0 ? " disabled" : "") + ">Back</button>" + (step < 7 ? '<button class="btn btn-primary" data-action="ob-next">' + (step === 5 || step === 6 ? "Continue" : "Next") + "</button>" : '<button class="btn btn-primary" data-action="ob-finish">Go to dashboard</button>') + (step === 5 || step === 6 ? '<button class="btn btn-ghost" data-action="ob-next">Skip for now</button>' : "") + "</div></section></div>";
  }

  function renderModal() {
    if (!ui.modal) return "";
    const m = ui.modal;
    return '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">' + esc(m.title) + '</h2><form data-form="' + esc(m.type) + '" style="margin-top:12px">' + m.body + '<div class="actions"><button class="btn btn-primary" type="submit">' + esc(m.submit || "Save") + '</button><button class="btn btn-ghost" type="button" data-action="close">Cancel</button></div></form></div></div>';
  }

  function field(name, label, value, extra) {
    return '<div class="field"><label>' + label + '</label><input name="' + name + '" value="' + esc(value ?? "") + '" ' + (extra || "") + "></div>";
  }
  function opt(value, label, current) {
    return '<option value="' + esc(value) + '"' + (value === current ? " selected" : "") + ">" + esc(label) + "</option>";
  }
  function catOptions(selected) {
    return state.settings.categories.map(function (c) {
      return '<option' + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  function openModal(type, extra) {
    extra = extra || {};
    const today = todayISO();
    if (type === "expense") {
      const t = extra.tx;
      ui.modal = { type: "expense", title: t ? "Edit expense" : "Add expense", submit: t ? "Update" : "Add expense", body: '<input type="hidden" name="id" value="' + esc(t ? t.id : "") + '">' + field("amount", "Amount", t ? t.amount : "", 'inputmode="decimal" required') + field("description", "Description", t ? t.description : "", "required") + '<div class="field"><label>Category</label><select name="category">' + catOptions(t && t.category) + '</select></div>' + field("date", "Date", t ? t.date : today, 'type="date" required') };
    } else if (type === "income") {
      ui.modal = { type: "income", title: "Log money received", submit: "Add to balance", body: field("amount", "Amount", "", 'inputmode="decimal" required') + field("description", "From", "", 'placeholder="Paycheck" required') + field("date", "Date", today, 'type="date" required') + '<p class="help">This increases your balance. It is not the same as expected income.</p>' };
    } else if (type === "source") {
      const src = extra.src || {};
      ui.modal = { type: "source", title: src.id ? "Edit expected income" : "Add expected income", body: '<input type="hidden" name="id" value="' + esc(src.id || "") + '">' + field("name", "Name", src.name || "", "required") + field("amount", "Amount", src.amount || "", 'inputmode="decimal" required') + '<div class="field"><label>Kind</label><select name="kind">' + ["paycheck", "freelance", "business", "gift", "other"].map(function (k) { return opt(k, k, src.kind || "paycheck"); }).join("") + '</select></div><div class="field"><label>Schedule</label><select name="schedule">' + ["weekly", "biweekly", "twice-monthly", "monthly", "irregular"].map(function (k) { return opt(k, k, src.schedule || "biweekly"); }).join("") + "</select></div>" + field("nextDate", "Next date", src.nextDate || state.settings.nextPayday || today, 'type="date"') };
    } else if (type === "bill") {
      const b = extra.bill || {};
      ui.modal = { type: "bill", title: b.id ? "Edit bill" : "Add bill", body: '<input type="hidden" name="id" value="' + esc(b.id || "") + '">' + field("name", "Name", b.name || "", "required") + field("amount", "Amount", b.amount || "", 'inputmode="decimal" required') + field("dueDate", "Due date", b.dueDate || today, 'type="date" required') + '<div class="field"><label>Repeats</label><select name="schedule">' + [opt("once", "Once", b.schedule || "monthly"), opt("weekly", "Weekly", b.schedule), opt("biweekly", "Every two weeks", b.schedule), opt("monthly", "Monthly", b.schedule || "monthly"), opt("yearly", "Yearly", b.schedule)].join("") + '</select></div><div class="field"><label>Type</label><select name="kind">' + opt("bill", "Bill", b.kind || "bill") + opt("debt", "Debt payment", b.kind) + '</select></div><label class="check"><input type="checkbox" name="autopay"' + (b.autopay ? " checked" : "") + ">Autopay reminder</label>" };
    } else if (type === "paybill") {
      const unpaid = state.bills.filter(function (b) { return !b.paid; });
      const opts = unpaid.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + " · " + money(b.amount) + "</option>"; }).join("");
      ui.modal = { type: "paybill", title: "Pay a bill", submit: "Mark paid", body: unpaid.length ? '<div class="field"><label>Bill</label><select name="id">' + opts + "</select></div>" + field("amount", "Amount paid", unpaid[0].amount, 'inputmode="decimal" required') + field("date", "Date", today, 'type="date"') + '<label class="check"><input type="checkbox" name="deduct" checked>Deduct this from my balance</label><p class="help">Leave unchecked if the money has already left and your balance already reflects it.</p>' : "<p>No unpaid bills. Add one first.</p>" };
    } else if (type === "fund") {
      const f = extra.fund || {};
      ui.modal = { type: "fund", title: f.id ? "Edit fund" : "Add future fund", body: '<input type="hidden" name="id" value="' + esc(f.id || "") + '">' + field("name", "Name", f.name || "", "required") + field("target", "Target", f.target || "", 'inputmode="decimal" required') + field("saved", "Already saved", f.saved || 0, 'inputmode="decimal"') + field("setAside", "Still to set aside", f.setAside || "", 'inputmode="decimal"') + field("byDate", "Set aside by", f.byDate || "", 'type="date"') + '<label class="check"><input type="checkbox" name="protectAlways"' + (f.protectAlways !== false ? " checked" : "") + ">Always protect this set-aside</label>" };
    } else if (type === "contrib") {
      ui.modal = { type: "contrib", title: "Add contribution", submit: "Move money", body: '<input type="hidden" name="id" value="' + esc(extra.id) + '">' + field("amount", "Amount", "", 'inputmode="decimal" required') + field("date", "Date", today, 'type="date"') + '<label class="check"><input type="checkbox" name="deduct" checked>Deduct from my balance</label>' };
    } else if (type === "essential") {
      ui.modal = { type: "essential", title: "Expected essential", body: field("name", "Name", "", 'placeholder="Groceries" required') + field("amount", "Still expected", "", 'inputmode="decimal" required') + '<div class="field"><label>Category to match spending</label><select name="category">' + catOptions("Groceries") + '</select></div><div class="field"><label>Window</label><select name="horizon"><option value="payday">Until payday</option><option value="month">This month</option></select></div>' };
    } else if (type === "impulse") {
      ui.modal = { type: "impulse", title: "Park a purchase", submit: "Start waiting", body: field("name", "What is it?", ui.afford.name || "", "required") + field("price", "Price", ui.afford.price || "", 'inputmode="decimal" required') + '<div class="field"><label>Wait</label><select name="wait"><option value="1">24 hours</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="custom">Custom days</option></select></div>' + field("custom", "Custom days", "5", 'inputmode="numeric"') + field("note", "Note", "", "") };
    } else if (type === "leak") {
      ui.modal = { type: "leak", title: "Note a money leak", body: field("name", "What", "", "required") + field("amount", "Amount", "", 'inputmode="decimal" required') + '<div class="field"><label>Category</label><select name="category">' + LEAK_CATEGORIES.map(function (c) { return "<option>" + c + "</option>"; }).join("") + '</select></div><div class="field"><label>How often</label><select name="frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="once">One time</option></select></div>' + field("date", "Date", today, 'type="date"') };
    } else if (type === "confirm") {
      ui.modal = { type: "confirm", title: extra.title || "Are you sure?", submit: extra.submit || "Confirm", body: "<p>" + esc(extra.message || "") + '</p><input type="hidden" name="kind" value="' + esc(extra.kind || "") + '"><input type="hidden" name="id" value="' + esc(extra.id || "") + '">' };
    }
    render();
  }

  function advanceDue(iso, schedule) {
    if (schedule === "weekly") return addDays(iso, 7);
    if (schedule === "biweekly") return addDays(iso, 14);
    if (schedule === "yearly") return addMonths(iso, 12);
    if (schedule === "monthly") return addMonths(iso, 1);
    return iso;
  }

  function onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "close-more") { ui.moreOpen = false; render(); return; }
    if (action === "more") { ui.moreOpen = !ui.moreOpen; render(); return; }
    if (action === "nav") { ui.view = btn.dataset.view; ui.moreOpen = false; ui.modal = null; if (ui.view === "reset") { ui.resetStep = 0; ui.resetDraft = null; } render(); return; }
    if (action === "horizon") { ui.horizon = btn.dataset.horizon; render(); return; }
    if (action === "open") { openModal(btn.dataset.modal); return; }
    if (action === "close") { ui.modal = null; render(); return; }
    if (action === "expense-range") { ui.expenseRange = btn.dataset.range; render(); return; }
    if (action === "bill-filter") { ui.billFilter = btn.dataset.filter; render(); return; }
    if (action === "edit-tx") { openModal("expense", { tx: state.transactions.find(function (t) { return t.id === btn.dataset.id; }) }); return; }
    if (action === "delete-tx") { openModal("confirm", { title: "Remove this entry?", message: "The balance will be recalculated without it.", submit: "Remove", kind: "tx", id: btn.dataset.id }); return; }
    if (action === "edit-bill") { openModal("bill", { bill: state.bills.find(function (b) { return b.id === btn.dataset.id; }) }); return; }
    if (action === "delete-bill") { openModal("confirm", { title: "Delete this bill?", message: "Past payments stay in history.", submit: "Delete", kind: "bill", id: btn.dataset.id }); return; }
    if (action === "open-pay") { const b = state.bills.find(function (x) { return x.id === btn.dataset.id; }); openModal("paybill"); if (b) setTimeout(function () { const sel = document.querySelector('.modal select[name="id"]'); const amt = document.querySelector('.modal input[name="amount"]'); if (sel) sel.value = b.id; if (amt) amt.value = b.amount; }, 0); return; }
    if (action === "edit-fund") { openModal("fund", { fund: state.funds.find(function (f) { return f.id === btn.dataset.id; }) }); return; }
    if (action === "delete-fund") { openModal("confirm", { title: "Delete this fund?", message: "Contributions already recorded stay in history.", submit: "Delete", kind: "fund", id: btn.dataset.id }); return; }
    if (action === "open-contrib") { openModal("contrib", { id: btn.dataset.id }); return; }
    if (action === "delete-essential") { state.essentials = state.essentials.filter(function (e) { return e.id !== btn.dataset.id; }); commit(); return; }
    if (action === "delete-source") { openModal("confirm", { title: "Remove expected income?", message: "Received payments stay in history.", submit: "Remove", kind: "source", id: btn.dataset.id }); return; }
    if (action === "edit-source") { openModal("source", { src: state.incomeSources.find(function (s) { return s.id === btn.dataset.id; }) }); return; }
    if (action === "receive") { receiveSource(btn.dataset.id); return; }
    if (action === "delete-leak") { state.leaks = state.leaks.filter(function (l) { return l.id !== btn.dataset.id; }); commit(); return; }
    if (action === "delete-impulse") { state.impulses = state.impulses.filter(function (i) { return i.id !== btn.dataset.id; }); commit(); return; }
    if (action === "pause-avoid") { const item = state.impulses.find(function (i) { return i.id === btn.dataset.id; }); if (item) item.status = "avoided"; commit(); toast("Left in the plan. No lecture attached."); return; }
    if (action === "pause-bought") { const item = state.impulses.find(function (i) { return i.id === btn.dataset.id; }); if (item) { item.status = "bought"; state.transactions.push({ id: uid(), type: "expense", amount: round2(item.price), date: todayISO(), description: item.name, category: "Fun" }); } commit(); toast("Logged as spending."); return; }
    if (action === "pause-afford") { const item = state.impulses.find(function (i) { return i.id === btn.dataset.id; }); if (item) { ui.afford.name = item.name; ui.afford.price = String(item.price); } ui.view = "afford"; render(); return; }
    if (action === "log-purchase") { logPurchase(); return; }
    if (action === "send-pause") { openModal("impulse"); return; }
    if (action === "add-cat") { const input = document.getElementById("new-cat"); const name = input && input.value.trim(); if (!name) return; if (state.settings.categories.indexOf(name) < 0) state.settings.categories.push(name); commit(); return; }
    if (action === "delete-cat") { state.settings.categories = state.settings.categories.filter(function (c) { return c !== btn.dataset.name; }); commit(); return; }
    if (action === "export") { exportData(); return; }
    if (action === "import-pick") { const f = document.getElementById("import-file"); if (f) f.click(); return; }
    if (action === "demo") { openModal("confirm", { title: "Load example numbers?", message: "This replaces your current plan with a sample household so you can click around. Export first if you want to keep today’s data.", submit: "Load example", kind: "demo" }); return; }
    if (action === "reset-ask") { openModal("confirm", { title: "Erase everything?", message: "This deletes the plan stored in this browser. Export a backup first if you might want it. Type is not required — confirm to wipe.", submit: "Erase data", kind: "wipe" }); return; }
    if (action === "ob-next") { readOnboardFields(); ui.onboardStep = Math.min(7, ui.onboardStep + 1); render(); return; }
    if (action === "ob-back") { readOnboardFields(); ui.onboardStep = Math.max(0, ui.onboardStep - 1); render(); return; }
    if (action === "ob-finish") { state.onboarded = true; save(); ui.view = "home"; render(); return; }
    if (action === "ob-add-bill") { addOnboardBill(); return; }
    if (action === "ob-add-fund") { addOnboardFund(); return; }
    if (action === "reset-next") { readResetFields(); ui.resetStep = Math.min(4, ui.resetStep + 1); render(); return; }
    if (action === "reset-back") { readResetFields(); ui.resetStep = Math.max(0, ui.resetStep - 1); render(); return; }
    if (action === "reset-finish") { finishReset(); return; }
  }

  function onSubmit(e) {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const type = form.dataset.form;
    if (type === "expense") return saveExpense(data);
    if (type === "income") return saveIncome(data);
    if (type === "source") return saveSource(data);
    if (type === "bill") return saveBill(data);
    if (type === "paybill") return payBill(data);
    if (type === "fund") return saveFund(data);
    if (type === "contrib") return saveContrib(data);
    if (type === "essential") return saveEssential(data);
    if (type === "impulse") return saveImpulse(data);
    if (type === "leak") return saveLeak(data);
    if (type === "confirm") return confirmAction(data);
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === "id" && t.form && t.form.dataset.form === "paybill") {
      const bill = state.bills.find(function (b) { return b.id === t.value; });
      const amt = t.form.querySelector('[name="amount"]');
      if (bill && amt) amt.value = bill.amount;
    }
    if (t.dataset.setting) {
      const key = t.dataset.setting;
      let value = t.value;
      if (key === "safetyBuffer") value = clamp0(num(value));
      state.settings[key] = value;
      save();
      if (key === "theme") applyTheme();
      if (ui.view === "settings" || ui.view === "home") render();
      return;
    }
    if (t.dataset.openBalance != null) { state.openingBalance = round2(num(t.value)); save(); }
    if (t.dataset.bind) { ui.afford[t.dataset.bind] = t.value; updateAfford(); return; }
    if (t.dataset.reset) { ui.resetDraft[t.dataset.reset] = t.value; }
    if (t.dataset.resetBill) {
      const id = t.dataset.resetBill;
      const has = ui.resetDraft.unpaid.indexOf(id);
      if (t.checked && has < 0) ui.resetDraft.unpaid.push(id);
      if (!t.checked && has >= 0) ui.resetDraft.unpaid.splice(has, 1);
    }
    if (t.dataset.resetFund) {
      const row = ui.resetDraft.funds.find(function (f) { return f.id === t.dataset.resetFund; });
      if (row) row.setAside = t.value;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.bind) { ui.afford[t.dataset.bind] = t.value; updateAfford(); }
  }

  function updateAfford() {
    if (ui.view !== "afford") return;
    const view = document.getElementById("view");
    if (!view) return;
    const focus = document.activeElement && document.activeElement.id;
    const sel = document.activeElement && document.activeElement.selectionStart;
    view.innerHTML = renderAfford();
    if (focus) {
      const el = document.getElementById(focus);
      if (el) { el.focus(); if (sel != null) el.setSelectionRange(sel, sel); }
    }
  }

  function saveExpense(data) {
    const amount = round2(num(data.amount));
    if (amount <= 0 || !data.description) return toast("Add a description and an amount above zero.");
    if (data.id) {
      const tx = state.transactions.find(function (t) { return t.id === data.id; });
      if (tx) { tx.amount = amount; tx.description = data.description.trim(); tx.category = data.category; tx.date = data.date; }
    } else {
      state.transactions.push({ id: uid(), type: "expense", amount: amount, description: data.description.trim(), category: data.category, date: data.date || todayISO() });
    }
    ui.modal = null;
    commit();
    toast("Expense saved. Safe to Spend updated.");
  }
  function saveIncome(data) {
    const amount = round2(num(data.amount));
    if (amount <= 0) return toast("Enter an amount above zero.");
    state.transactions.push({ id: uid(), type: "income", amount: amount, description: data.description.trim() || "Income", date: data.date || todayISO(), category: "Income" });
    ui.modal = null;
    commit();
    toast("Income added to your balance.");
  }
  function saveSource(data) {
    const amount = round2(num(data.amount));
    if (!data.name || amount < 0) return toast("Name the income and check the amount.");
    if (data.id) {
      const src = state.incomeSources.find(function (s) { return s.id === data.id; });
      if (src) Object.assign(src, { name: data.name.trim(), amount: amount, kind: data.kind, schedule: data.schedule, nextDate: data.nextDate });
    } else {
      state.incomeSources.push({ id: uid(), name: data.name.trim(), amount: amount, kind: data.kind, schedule: data.schedule, nextDate: data.nextDate });
    }
    ui.modal = null;
    commit();
  }
  function receiveSource(id) {
    const src = state.incomeSources.find(function (s) { return s.id === id; });
    if (!src) return;
    state.transactions.push({ id: uid(), type: "income", amount: round2(src.amount), description: src.name, date: todayISO(), category: "Income", refId: src.id });
    if (src.schedule !== "irregular") src.nextDate = nextPaydaySuggestion(src.nextDate || todayISO(), src.schedule);
    if (!state.settings.nextPayday || state.settings.nextPayday <= todayISO()) state.settings.nextPayday = src.nextDate || nextPaydaySuggestion(todayISO(), state.settings.paySchedule);
    commit();
    toast("Marked received. Expected pay was not counted before this.");
  }
  function saveBill(data) {
    const amount = round2(num(data.amount));
    if (!data.name || amount < 0 || !data.dueDate) return toast("Name, amount, and due date are needed.");
    const payload = { name: data.name.trim(), amount: amount, dueDate: data.dueDate, schedule: data.schedule, kind: data.kind || "bill", autopay: !!data.autopay };
    if (data.id) {
      const b = state.bills.find(function (x) { return x.id === data.id; });
      if (b) Object.assign(b, payload);
    } else state.bills.push(Object.assign({ id: uid(), paid: false }, payload));
    ui.modal = null;
    commit();
    toast("Bill saved. Unpaid amount is protected.");
  }
  function payBill(data) {
    const bill = state.bills.find(function (b) { return b.id === data.id; });
    if (!bill) return toast("Choose a bill.");
    const amount = round2(num(data.amount || bill.amount));
    const date = data.date || todayISO();
    if (data.deduct) {
      state.transactions.push({ id: uid(), type: "bill-payment", amount: amount, date: date, description: bill.name, category: bill.kind === "debt" ? "Debt" : "Bills", refId: bill.id, dueDate: bill.dueDate, onTime: date <= bill.dueDate });
    }
    if (bill.schedule === "once") { bill.paid = true; bill.paidDate = date; }
    else { bill.dueDate = advanceDue(bill.dueDate, bill.schedule); bill.paid = false; }
    ui.modal = null;
    commit();
    toast(data.deduct ? "Paid and removed from protected bills." : "Marked paid without changing the balance.");
  }
  function saveFund(data) {
    if (!data.name) return toast("Name the fund.");
    const payload = { name: data.name.trim(), target: clamp0(num(data.target)), saved: clamp0(num(data.saved)), setAside: clamp0(num(data.setAside)), byDate: data.byDate || "", protectAlways: !!data.protectAlways };
    if (data.id) {
      const f = state.funds.find(function (x) { return x.id === data.id; });
      if (f) Object.assign(f, payload);
    } else state.funds.push(Object.assign({ id: uid() }, payload));
    ui.modal = null;
    commit();
  }
  function saveContrib(data) {
    const fund = state.funds.find(function (f) { return f.id === data.id; });
    if (!fund) return;
    const amount = round2(num(data.amount));
    if (amount <= 0) return toast("Enter an amount above zero.");
    if (data.deduct) state.transactions.push({ id: uid(), type: "fund-contribution", amount: amount, date: data.date || todayISO(), description: fund.name, category: "Savings", refId: fund.id });
    fund.saved = round2(fund.saved + amount);
    fund.setAside = clamp0(fund.setAside - amount);
    ui.modal = null;
    commit();
    toast("Contribution recorded once.");
  }
  function saveEssential(data) {
    if (!data.name || num(data.amount) < 0) return;
    state.essentials.push({ id: uid(), name: data.name.trim(), amount: clamp0(num(data.amount)), category: data.category, horizon: data.horizon || "payday" });
    ui.modal = null;
    commit();
  }
  function saveImpulse(data) {
    const price = round2(num(data.price));
    if (!data.name || price <= 0) return toast("Name it and add a price.");
    let days = Number(data.wait) || 7;
    if (data.wait === "custom") days = Math.max(1, Number(data.custom) || 1);
    state.impulses.push({ id: uid(), name: data.name.trim(), price: price, waitUntil: addDays(todayISO(), days), createdAt: todayISO(), status: "waiting", note: data.note || "" });
    ui.modal = null;
    ui.view = "pause";
    commit();
    toast("Parked. Revisit it when the wait is up.");
  }
  function saveLeak(data) {
    if (!data.name || num(data.amount) <= 0) return toast("Name the leak and add an amount.");
    state.leaks.push({ id: uid(), name: data.name.trim(), amount: round2(num(data.amount)), category: data.category, frequency: data.frequency, date: data.date || todayISO() });
    ui.modal = null;
    commit();
  }
  function logPurchase() {
    const price = round2(num(ui.afford.price));
    if (price <= 0) return;
    state.transactions.push({ id: uid(), type: "expense", amount: price, date: todayISO(), description: ui.afford.name.trim() || "Purchase", category: "Fun" });
    ui.afford = { name: "", price: "", alts: "" };
    commit();
    toast("Purchase logged. Safe to Spend updated.");
  }
  function confirmAction(data) {
    if (data.kind === "tx") state.transactions = state.transactions.filter(function (t) { return t.id !== data.id; });
    if (data.kind === "bill") state.bills = state.bills.filter(function (b) { return b.id !== data.id; });
    if (data.kind === "fund") state.funds = state.funds.filter(function (f) { return f.id !== data.id; });
    if (data.kind === "source") state.incomeSources = state.incomeSources.filter(function (s) { return s.id !== data.id; });
    if (data.kind === "wipe") { state = defaultState(); state.onboarded = false; ui.onboardStep = 0; save(); ui.modal = null; render(); return; }
    if (data.kind === "demo") { loadDemo(); ui.modal = null; ui.view = "home"; commit(); toast("Example plan loaded. Erase it in Settings when you’re done."); return; }
    ui.modal = null;
    commit();
  }

  function readOnboardFields() {
    document.querySelectorAll("[data-setting]").forEach(function (el) {
      const key = el.dataset.setting;
      state.settings[key] = key === "safetyBuffer" ? clamp0(num(el.value)) : el.value;
    });
    const bal = document.querySelector("[data-open-balance]");
    if (bal) state.openingBalance = round2(num(bal.value));
    save();
  }
  function addOnboardBill() {
    const name = document.getElementById("ob-bill-name").value.trim();
    const amount = round2(num(document.getElementById("ob-bill-amt").value));
    const due = document.getElementById("ob-bill-date").value;
    const schedule = document.getElementById("ob-bill-sch").value;
    if (!name || amount <= 0 || !due) return toast("Add a name, amount, and due date.");
    state.bills.push({ id: uid(), name: name, amount: amount, dueDate: due, schedule: schedule, kind: "bill", autopay: false, paid: false });
    save();
    render();
  }
  function addOnboardFund() {
    const name = document.getElementById("ob-fund-name").value.trim();
    const target = clamp0(num(document.getElementById("ob-fund-target").value));
    const aside = clamp0(num(document.getElementById("ob-fund-aside").value));
    if (!name) return toast("Name the fund.");
    state.funds.push({ id: uid(), name: name, target: target || aside, saved: 0, setAside: aside, byDate: "", protectAlways: true });
    save();
    render();
  }
  function readResetFields() {
    document.querySelectorAll("[data-reset]").forEach(function (el) { ui.resetDraft[el.dataset.reset] = el.value; });
    document.querySelectorAll("[data-reset-fund]").forEach(function (el) {
      const row = ui.resetDraft.funds.find(function (f) { return f.id === el.dataset.resetFund; });
      if (row) row.setAside = el.value;
    });
  }
  function finishReset() {
    readResetFields();
    const target = round2(num(ui.resetDraft.balance));
    const delta = round2(target - currentBalance());
    if (delta !== 0) state.transactions.push({ id: uid(), type: "adjustment", amount: delta, date: todayISO(), description: "Balance reset", category: "Adjustment" });
    state.bills.forEach(function (b) {
      if (b.paid) return;
      if (ui.resetDraft.unpaid.indexOf(b.id) < 0) { b.paid = true; b.paidDate = todayISO(); }
    });
    state.funds.forEach(function (f) {
      const row = ui.resetDraft.funds.find(function (x) { return x.id === f.id; });
      if (row) f.setAside = clamp0(num(row.setAside));
    });
    state.settings.safetyBuffer = clamp0(num(ui.resetDraft.buffer));
    ui.view = "home";
    ui.resetDraft = null;
    commit();
    toast("Plan updated. You’re back.");
  }

  function exportData() {
    state.settings.lastExport = todayISO();
    save();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "safespend-backup-" + todayISO() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Backup downloaded.");
    render();
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.transactions) || !data.settings) throw new Error("bad");
        state = data;
        state.settings = Object.assign(defaultState().settings, data.settings);
        save();
        ui.view = "home";
        render();
        toast("Backup imported.");
      } catch (err) {
        toast("That file isn’t a SafeSpend backup.");
      }
    };
    reader.readAsText(file);
  }

  function loadDemo() {
    const today = todayISO();
    const payday = addDays(today, 9);
    state = defaultState();
    state.onboarded = true;
    state.openingBalance = 2480;
    state.settings.displayName = "Sara";
    state.settings.paySchedule = "biweekly";
    state.settings.nextPayday = payday;
    state.settings.safetyBuffer = 200;
    state.bills = [
      { id: uid(), name: "Rent", amount: 900, dueDate: addDays(today, 4), schedule: "monthly", autopay: true, paid: false, kind: "bill" },
      { id: uid(), name: "Phone", amount: 45, dueDate: addDays(today, 6), schedule: "monthly", autopay: true, paid: false, kind: "bill" },
      { id: uid(), name: "Internet", amount: 75, dueDate: addDays(today, 8), schedule: "monthly", autopay: false, paid: false, kind: "bill" }
    ];
    state.funds = [
      { id: uid(), name: "Car insurance", target: 480, saved: 160, setAside: 80, byDate: payday, protectAlways: true }
    ];
    state.essentials = [{ id: uid(), name: "Groceries", amount: 120, category: "Groceries", horizon: "payday" }];
    state.incomeSources = [{ id: uid(), name: "Paycheck", amount: 1600, kind: "paycheck", schedule: "biweekly", nextDate: payday }];
    state.transactions = [
      { id: uid(), type: "expense", amount: 42.5, date: addDays(today, -1), description: "Groceries", category: "Groceries" },
      { id: uid(), type: "expense", amount: 18, date: today, description: "Bus pass top-up", category: "Transport" }
    ];
    state.impulses = [{ id: uid(), name: "Weekend jacket", price: 90, waitUntil: addDays(today, 2), createdAt: today, status: "waiting", note: "" }];
    state.leaks = [{ id: uid(), name: "Unused streaming add-on", amount: 8, category: "Unused membership", frequency: "monthly", date: today }];
  }

  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "import-file" && e.target.files[0]) importData(e.target.files[0]);
  });

  window.SafeSpendTest = { snapshot: snapshot, currentBalance: currentBalance, state: function () { return state; }, loadDemo: loadDemo, setState: function (s) { state = s; }, money: money };

  render();
})();
