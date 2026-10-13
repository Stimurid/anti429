// 4̅2̅9̅ (Anti-429) service worker.
// Observes every /backend-api request via webRequest (read-only), meters the four limiter families,
// learns lower ceilings from real 429s, drives the badge/icon traffic light and serves the popup.
importScripts("shared.js");
const A = self.A429;

const DEFAULT_CFG = {
  enabled: true,          // page guard on/off (mirrored to localStorage by bridge.js)
  loopDetail: 4,          // history GETs / 60 s that make a tab look like a poll loop
  loopStream: 5,          // stream_status/resume / 60 s
  loopMb10: 100,          // MB transferred in 10 min
  restoreGapSec: 12,      // pause between tabs when restoring a saved session
  autoHeal: true,         // revive tabs stuck on "Could not load this conversation" when the limiter is calm
  calmMs: 30000,          // required quiet time since the last 429 before a heal
  healGapMs: 15000,       // at least this long between two heals (any tabs)
  healBackoffScale: 1     // multiplies the per-tab retry spacing (test hook)
};

const URLS = ["https://chatgpt.com/backend-api/*"];
const COLORS = { green: "#2ecc71", yellow: "#f1c40f", orange: "#e67e22", red: "#e74c3c", idle: "#7f8c8d" };
const TEN_MIN = 10 * 60 * 1000;

// ---------- state ----------
let cfg = Object.assign({}, DEFAULT_CFG);
let ceilings = Object.assign({}, A.DEFAULT_CEIL);
const F = {};   // family -> { starts:[ts], c429:[ts], cd:ms, last429:ts, learned:bool }
for (const id of A.FAMILY_IDS) F[id] = { starts: [], oks: [], c429: [], cd: 0, last429: 0, learned: false };
const T = {};   // tabId -> { req:[ts], fam:{id:[ts]}, bytes:[{ts,b}], c429:[ts] }
const H = {};   // tabId -> held requests (from guard events)
const P = {};   // tabId -> { draft, generating } reported by bridge.js
const G = {};   // tabId -> true once guard.js announced itself in that tab
const R = {};   // tabId -> number of successful resume recoveries
const B = {};   // tabId -> { failedAt, status, heals, lastHealAt }  pages that were shown a failed history load
const D = {};   // tabId -> ts the guard declared that tab's stream dead
const S = {};   // tabId -> { status, since }  last stream_status seen on that page
let lastHealAny = 0;
let dirty = false;

const tabStats = id => (T[id] || (T[id] = { req: [], fam: {}, bytes: [], c429: [] }));

const ready = (async () => {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["cfg", "ceilings", "learned", "schema"]),
    chrome.storage.session.get(["state"]).catch(() => ({}))
  ]);
  if (local.cfg) cfg = Object.assign({}, DEFAULT_CFG, local.cfg);
  if (local.ceilings) ceilings = Object.assign({}, A.DEFAULT_CEIL, local.ceilings);
  if (local.learned) for (const id of A.FAMILY_IDS) F[id].learned = !!local.learned[id];
  const s = session && session.state;
  if (s) {
    for (const id of A.FAMILY_IDS) if (s.F && s.F[id]) Object.assign(F[id], s.F[id]);
    Object.assign(T, s.T || {});
    Object.assign(H, s.H || {});
    Object.assign(P, s.P || {});
    Object.assign(G, s.G || {});
    Object.assign(R, s.R || {});
    Object.assign(B, s.B || {});
  }
  // v0.2.1: earlier builds could learn a ceiling of 2 from a limiter that was already hot. Forget those once.
  if (!local.schema || local.schema < 3) {
    ceilings = Object.assign({}, A.DEFAULT_CEIL);
    for (const id of A.FAMILY_IDS) F[id].learned = false;
    await chrome.storage.local.set({ schema: 3, ceilings, learned: {} });
  }
  // make sure the bridge has something to mirror
  await chrome.storage.local.set({ cfg, ceilings });
})();

function persistSoon() {
  if (dirty) return;
  dirty = true;
  setTimeout(async () => {
    dirty = false;
    try { await chrome.storage.session.set({ state: { F, T, H, P, G, R, B } }); } catch {}
  }, 2500);
}

function prune(now) {
  for (const id of A.FAMILY_IDS) {
    F[id].starts = F[id].starts.filter(t => now - t < TEN_MIN);
    F[id].oks = (F[id].oks || []).filter(t => now - t < TEN_MIN);
    F[id].c429 = F[id].c429.filter(t => now - t < TEN_MIN);
  }
  for (const [id, s] of Object.entries(T)) {
    s.req = s.req.filter(t => now - t < 60000);
    for (const f of Object.keys(s.fam)) s.fam[f] = s.fam[f].filter(t => now - t < 60000);
    s.bytes = s.bytes.filter(x => now - x.ts < TEN_MIN);
    s.c429 = s.c429.filter(t => now - t < TEN_MIN);
    if (!s.req.length && !s.bytes.length && !s.c429.length && !H[id]) delete T[id];
  }
}

// ---------- webRequest observation ----------
const parseUrl = u => { try { return new URL(u); } catch { return null; } };
const header = (headers, name) => {
  if (!headers) return null;
  const h = headers.find(x => x.name.toLowerCase() === name);
  return h ? h.value : null;
};

chrome.webRequest.onBeforeRequest.addListener(details => {
  const u = parseUrl(details.url);
  if (!u) return;
  const now = Date.now();
  const fam = A.classify(details.method, u.pathname);
  if (details.tabId >= 0) {
    const s = tabStats(details.tabId);
    s.req.push(now);
    if (fam) (s.fam[fam] || (s.fam[fam] = [])).push(now);
  }
  if (fam) F[fam].starts.push(now);
  persistSoon();
  scheduleRender();
}, { urls: URLS });

chrome.webRequest.onHeadersReceived.addListener(details => {
  const u = parseUrl(details.url);
  if (!u) return;
  const now = Date.now();
  const fam = A.classify(details.method, u.pathname);
  if (details.tabId >= 0 && details.statusCode === 200) {
    const len = Number(header(details.responseHeaders, "content-length"));
    if (Number.isFinite(len) && len > 0) tabStats(details.tabId).bytes.push({ ts: now, b: len });
  }
  if (!fam) return;
  if (details.statusCode !== 429) {
    if (details.statusCode < 400) {
      const fo = F[fam];
      (fo.oks || (fo.oks = [])).push(now);
      // An accepted reply that lands inside a 429 episode (rejections are usually faster than accepted answers)
      // raises the evidence for this episode; re-evaluate the ceiling from the episode maximum.
      if (fo.epBase != null && now - fo.last429 <= A.WINDOW_MS) {
        fo.epMax = Math.max(fo.epMax || 0, A.burstCount(fo.oks, now));
        if (fo.epMax >= A.CEIL_MIN) {
          ceilings[fam] = A.learnCeiling(fo.epBase, fo.epMax, fam);
          chrome.storage.local.set({ ceilings });
        }
      }
    }
    return;
  }

  const f = F[fam];
  const ra = A.parseRetryAfter(header(details.responseHeaders, "retry-after"), now);
  // How many requests did the server ACCEPT in the window before it started refusing? That is the real ceiling.
  // (Counting starts would be wrong: a parallel burst registers all its starts before the first answer arrives.)
  const observed = A.burstCount(f.oks || [], now);
  // One 429 "episode" = rejections within WINDOW_MS of each other. The ceiling is derived from the episode's
  // MAXIMUM of accepted requests, taken from the ceiling at the episode start (so a burst of rejections cannot
  // ratchet it down reply by reply). If the server accepted fewer than CEIL_MIN requests, the limiter was
  // already "hot" (penalty box after somebody else's burst) and says nothing about the steady-state ceiling.
  if (now - f.last429 > A.WINDOW_MS || f.epBase == null) {
    f.epBase = ceilings[fam] || A.DEFAULT_CEIL[fam];
    f.epMax = observed;
  } else {
    f.epMax = Math.max(f.epMax || 0, observed);
  }
  if (f.epMax >= A.CEIL_MIN) ceilings[fam] = A.learnCeiling(f.epBase, f.epMax, fam);
  f.learned = true;
  f.last429 = now;
  f.c429.push(now);
  f.cd = Math.max(f.cd, now + (ra || 15000));
  if (details.tabId >= 0) tabStats(details.tabId).c429.push(now);
  chrome.storage.local.set({ ceilings, learned: Object.fromEntries(A.FAMILY_IDS.map(i => [i, F[i].learned])) });
  persistSoon();
  scheduleRender();
}, { urls: URLS }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener(id => { delete T[id]; delete H[id]; delete P[id]; delete G[id]; delete R[id]; delete B[id]; delete D[id]; delete S[id]; persistSoon(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "loading") { delete H[id]; delete P[id]; delete G[id]; delete B[id]; delete D[id]; delete S[id]; } });

// ---------- snapshot / render ----------
function famRow(id, now) {
  const f = F[id];
  const count = A.countIn(f.starts, now, A.WINDOW_MS);
  const ceil = ceilings[id] || A.DEFAULT_CEIL[id];
  const cooling = f.cd > now;
  const ratio = count / ceil;
  return {
    id, count, ceil, ratio, cooling,
    cooldownMs: cooling ? f.cd - now : 0,
    level: A.levelOf(ratio, cooling),
    c429_10m: f.c429.length,
    learned: f.learned,
    ep: { base: f.epBase, max: f.epMax, oks: (f.oks || []).length },
    last429Ago: f.last429 ? now - f.last429 : null
  };
}

function snapshot() {
  const now = Date.now();
  prune(now);
  const fams = A.FAMILY_IDS.map(id => famRow(id, now));
  const tabs = {};
  for (const [id, s] of Object.entries(T)) {
    const fam60 = {};
    for (const [k, v] of Object.entries(s.fam)) fam60[k] = A.countIn(v, now, 60000);
    const mb10 = s.bytes.reduce((a, x) => a + x.b, 0) / 1048576;
    const stats = { req60: A.countIn(s.req, now, 60000), fam60, mb10: Math.round(mb10 * 10) / 10, c429_10: s.c429.length, held: H[id] || 0 };
    stats.loop = A.isLoop(stats, cfg);
    tabs[id] = stats;
  }
  for (const [id, n] of Object.entries(H)) if (n && !tabs[id]) tabs[id] = { req60: 0, fam60: {}, mb10: 0, c429_10: 0, held: n, loop: false };
  const ids = new Set([...Object.keys(tabs), ...Object.keys(P), ...Object.keys(G), ...Object.keys(R), ...Object.keys(B), ...Object.keys(D), ...Object.keys(S)]);
  for (const id of ids) {
    const t = tabs[id] || (tabs[id] = { req60: 0, fam60: {}, mb10: 0, c429_10: 0, held: 0, loop: false });
    t.draft = !!(P[id] && P[id].draft);
    t.generating = !!(P[id] && P[id].generating);
    t.guard = !!G[id];
    t.recovered = R[id] || 0;
    t.deadStream = D[id] ? Math.round((now - D[id]) / 1000) : 0;
    t.streaming = S[id] && S[id].status === "IS_STREAMING" ? Math.round((now - S[id].since) / 60000) : -1;
    t.broken = B[id] ? { status: B[id].status, heals: B[id].heals || 0, agoSec: Math.round((now - B[id].failedAt) / 1000) } : null;
  }
  return { now, fams, overall: A.worstLevel(fams.map(r => r.level)), tabs, cfg, families: A.FAMILIES };
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render().catch(() => {}); }, 400);
}

function drawIcon(color) {
  const out = {};
  for (const size of [16, 32]) {
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext("2d");
    const r = size * 0.22;
    g.fillStyle = "#1b1f2a";
    g.beginPath();
    g.moveTo(r, 0); g.arcTo(size, 0, size, size, r); g.arcTo(size, size, 0, size, r);
    g.arcTo(0, size, 0, 0, r); g.arcTo(0, 0, size, 0, r); g.fill();
    g.fillStyle = "#ffffff";
    g.font = `bold ${Math.round(size * 0.52)}px sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("429", size / 2, size * 0.5);
    g.fillRect(size * 0.1, size * 0.14, size * 0.8, Math.max(1, size * 0.08)); // overline = "NOT"
    g.fillStyle = color;
    g.beginPath(); g.arc(size * 0.81, size * 0.81, size * 0.14, 0, Math.PI * 2); g.fill();
    out[size] = g.getImageData(0, 0, size, size);
  }
  return out;
}

let lastIconColor = null;
async function render() {
  await ready;
  const snap = snapshot();
  const tabsOpen = (await chrome.tabs.query({ url: "https://chatgpt.com/*" })).length;
  const active = tabsOpen > 0;
  const level = active ? snap.overall : "idle";
  const color = COLORS[level];
  const cooling = snap.fams.filter(r => r.cooling).sort((a, b) => b.cooldownMs - a.cooldownMs)[0];

  let text = "";
  if (active) {
    if (cooling) text = Math.ceil(cooling.cooldownMs / 1000) + "s";
    else text = String(Math.min(99, Math.round(Math.max(...snap.fams.map(r => r.ratio)) * 100)));
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: level === "yellow" ? "#000000" : "#ffffff" });
  if (color !== lastIconColor) {
    lastIconColor = color;
    try { await chrome.action.setIcon({ imageData: drawIcon(color) }); } catch {}
  }
  const lines = ["4̅2̅9̅ — лимиты ChatGPT"].concat(snap.fams.map(r => {
    const f = A.FAMILIES.find(x => x.id === r.id);
    return `${f.label}: ${r.count}/${r.ceil}${r.learned ? "" : "~"}` +
      (r.cooling ? ` · блок ${Math.ceil(r.cooldownMs / 1000)}с` : "") +
      (r.c429_10m ? ` · 429×${r.c429_10m}` : "");
  }));
  await chrome.action.setTitle({ title: lines.join("\n") });
}

// ---------- actions ----------
async function chatTabs() { return chrome.tabs.query({ url: "https://chatgpt.com/*" }); }

// Never throws away unsent drafts or running answers unless the user explicitly forces it for that tab.
async function discardTabs(ids, force) {
  const done = [], skipped = [];
  for (const id of ids) {
    let tab = null;
    try { tab = await chrome.tabs.get(id); } catch {}
    const verdict = A.canDiscard(P[id], { active: tab && tab.active, discarded: tab && tab.discarded, audible: tab && tab.audible, force: !!force });
    if (!verdict.ok) { if (verdict.reason !== "discarded") skipped.push({ id, reason: verdict.reason }); continue; }
    try { const t = await chrome.tabs.discard(id); if (t) { done.push(id); delete T[id]; delete H[id]; delete P[id]; delete G[id]; } } catch {}
  }
  persistSoon();
  return { discarded: done, skipped };
}

// ---------- auto-heal of dead tabs ----------
function calmNow(now) {
  return A.isCalm(A.FAMILY_IDS.map(id => ({ id, cd: F[id].cd, last429: F[id].last429, starts: F[id].starts })), now, cfg);
}

async function healTab(id, manual) {
  const b = B[id] || (B[id] = { heals: 0, lastHealAt: 0, failedAt: Date.now() });
  b.heals = (b.heals || 0) + 1;
  b.lastHealAt = Date.now();
  if (!manual) lastHealAny = Date.now();
  let res = null;
  try { res = await chrome.tabs.sendMessage(id, { type: "a429_heal" }); } catch {}
  if (res && !res.clicked && res.reason === "no-banner") delete B[id]; // the page already recovered by itself
  persistSoon();
  return res || { clicked: false, reason: "no-bridge" };
}

let healBusy = false;
async function healTick() {
  if (healBusy || cfg.autoHeal === false) return;
  healBusy = true;
  try {
    const now = Date.now();
    const cands = [];
    for (const [sid, b] of Object.entries(B)) {
      const id = Number(sid);
      let tab = null;
      try { tab = await chrome.tabs.get(id); } catch {}
      if (!tab || tab.discarded) { delete B[sid]; continue; }
      cands.push({ id, active: !!tab.active, failedAt: b.failedAt, heals: b.heals || 0, lastHealAt: b.lastHealAt || 0 });
    }
    if (!cands.length) return;
    const pick = A.pickHealTarget(cands, { calm: calmNow(now), now, lastHealAny, minGapMs: cfg.healGapMs, backoffScale: cfg.healBackoffScale });
    if (pick != null) await healTab(pick, false);
  } finally { healBusy = false; }
}
setInterval(() => { healTick().catch(() => {}); }, 5000);

// Inject bridge + guard into chatgpt tabs that were open before the extension was installed/updated,
// so nobody has to F5 twenty tabs at once (that reload burst is exactly the stampede we want to avoid).
// Ask each tab's page directly whether guard.js is alive there. The 'installed' event alone is not enough:
// after an extension reload the old page-side guard keeps running but never announces itself again.
let lastProbe = 0;
async function probeGuards(force) {
  const now = Date.now();
  if (!force && now - lastProbe < 4000) return;
  lastProbe = now;
  for (const t of await chatTabs()) {
    if (t.discarded) { delete G[t.id]; continue; }
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: "MAIN", func: () => !!window.__A429_GUARD2__ });
      if (r && r.result) G[t.id] = true; else delete G[t.id];
    } catch {}
  }
  persistSoon();
}

async function protectOpenTabs() {
  await probeGuards(true);
  const tabs = await chatTabs();
  let injected = 0;
  for (const t of tabs) {
    if (t.discarded || G[t.id]) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["bridge.js"], world: "ISOLATED" });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["shared.js", "guard.js", "recovery.js"], world: "MAIN" });
      injected++;
    } catch {}
    await sleep(150);
  }
  await sleep(300);
  await probeGuards(true);
  return { injected, total: tabs.length, protectedNow: Object.keys(G).length };
}

async function saveSession(name) {
  const tabs = (await chatTabs()).map(t => ({ url: t.url, title: t.title || t.url }));
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const s = { id: String(Date.now()), name: name || new Date().toLocaleString("ru-RU"), ts: Date.now(), tabs };
  sessions.unshift(s);
  await chrome.storage.local.set({ sessions: sessions.slice(0, 10) });
  return s;
}

let pumping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const { restoreQueue = [] } = await chrome.storage.local.get("restoreQueue");
      if (!restoreQueue.length) break;
      const next = restoreQueue.shift();
      await chrome.storage.local.set({ restoreQueue });
      try { await chrome.tabs.create({ url: next.url, active: false }); } catch {}
      await sleep(Math.max(3, cfg.restoreGapSec) * 1000);
    }
  } finally { pumping = false; }
}

async function restoreSession(sessionId, gapSec) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return { error: "session not found" };
  if (gapSec) cfg.restoreGapSec = gapSec;
  await chrome.storage.local.set({ cfg, restoreQueue: s.tabs.map(t => ({ url: t.url })) });
  pump();
  return { queued: s.tabs.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg && msg.type) {
      case "a429_event": {
        const id = sender.tab && sender.tab.id;
        if (id != null && msg.ev) {
          if (msg.ev.type === "hold-start") H[id] = (H[id] || 0) + 1;
          else if (msg.ev.type === "hold-end") H[id] = Math.max(0, (H[id] || 0) - 1);
          else if (msg.ev.type === "installed") G[id] = true;
          else if (msg.ev.type === "resume-recovery-success") R[id] = (R[id] || 0) + 1;
          else if (msg.ev.type === "history-failed") {
            if (A.isHealableStatus(msg.ev.status)) B[id] = Object.assign({ heals: 0, lastHealAt: 0 }, B[id], { failedAt: Date.now(), status: msg.ev.status });
          } else if (msg.ev.type === "history-ok") delete B[id];
          else if (msg.ev.type === "dead-stream") D[id] = Date.now();
          else if (msg.ev.type === "stream-status") {
            const st = msg.ev.status;
            if (!S[id] || S[id].status !== st) S[id] = { status: st, since: Date.now() };
            if (st === "COMPLETE") delete D[id];
          }
          persistSoon(); scheduleRender();
        }
        return sendResponse({ ok: true });
      }
      case "a429_tabstate": {
        const id = sender.tab && sender.tab.id;
        if (id != null && msg.state) {
          P[id] = { draft: !!msg.state.draft, generating: !!msg.state.generating };
          // the page itself shows the error block (e.g. it was already stuck when the extension started)
          if (msg.state.banner && !B[id]) B[id] = { heals: 0, lastHealAt: 0, failedAt: Date.now() - 5000, status: 429, seenOnPage: true };
          persistSoon();
        }
        return sendResponse({ ok: true });
      }
      case "protectTabs": return sendResponse(await protectOpenTabs());
      case "healNow": return sendResponse(await healTab(msg.id, true));
      case "markDead": {
        // the user says: this chat's stream is stuck. Flag it dead for 20 min and reload the tab ONCE.
        let res = null;
        try { res = await chrome.tabs.sendMessage(msg.id, { type: "a429_markdead" }); } catch {}
        if (res && res.ok) {
          D[msg.id] = Date.now();
          setTimeout(() => { chrome.tabs.reload(msg.id).catch(() => {}); }, 400);
        }
        return sendResponse(res || { ok: false, reason: "no-bridge" });
      }
      case "undead": {
        let res = null;
        try { res = await chrome.tabs.sendMessage(msg.id, { type: "a429_undead" }); } catch {}
        delete D[msg.id];
        return sendResponse(res || { ok: false });
      }
      case "openWindow": {
        const { dashWin, dashBounds, dashSide } = await chrome.storage.local.get(["dashWin", "dashBounds", "dashSide"]);
        const side = msg.side || null;
        const scr = msg.screen || null;
        const width = Math.max(380, (dashBounds && dashBounds.width) || 520);
        // Dock to a screen edge at full usable height when a side is requested; otherwise reuse last size/position.
        let box;
        if (side && scr) {
          box = { width, height: scr.height, top: scr.top, left: side === "right" ? scr.left + scr.width - width : scr.left };
        } else {
          box = dashBounds ? { width: dashBounds.width, height: dashBounds.height, left: dashBounds.left, top: dashBounds.top } : { width, height: 900 };
        }
        if (dashWin != null) {
          try {
            await chrome.windows.update(dashWin, Object.assign({ focused: true, state: "normal" }, side ? box : {}));
            if (side) await chrome.storage.local.set({ dashSide: side });
            return sendResponse({ reused: true, side: side || dashSide || null });
          } catch {}
        }
        const w = await chrome.windows.create(Object.assign({ url: chrome.runtime.getURL("popup.html?mode=window"), type: "popup" }, box));
        await chrome.storage.local.set({ dashWin: w.id, dashSide: side || dashSide || null });
        return sendResponse({ windowId: w.id, side, left: w.left, width: w.width });
      }
      case "forgetGuards": { for (const k of Object.keys(G)) delete G[k]; return sendResponse({ ok: true }); } // diagnostic: mimics what an extension reload does to the worker's memory
      case "snapshot": {
        probeGuards(false).catch(() => {});
        const { sessions = [], restoreQueue = [] } = await chrome.storage.local.get(["sessions", "restoreQueue"]);
        return sendResponse(Object.assign(snapshot(), { sessions, restoreQueue: restoreQueue.length }));
      }
      case "discard": return sendResponse(await discardTabs(msg.ids || [], msg.force));
      case "focus": {
        const t = await chrome.tabs.update(msg.id, { active: true });
        if (t) await chrome.windows.update(t.windowId, { focused: true });
        return sendResponse({ ok: true });
      }
      case "close": { await chrome.tabs.remove(msg.id); return sendResponse({ ok: true }); }
      case "saveSession": return sendResponse(await saveSession(msg.name));
      case "deleteSession": {
        const { sessions = [] } = await chrome.storage.local.get("sessions");
        await chrome.storage.local.set({ sessions: sessions.filter(s => s.id !== msg.id) });
        return sendResponse({ ok: true });
      }
      case "restore": return sendResponse(await restoreSession(msg.id, msg.gapSec));
      case "cancelRestore": { await chrome.storage.local.set({ restoreQueue: [] }); return sendResponse({ ok: true }); }
      case "setCfg": {
        cfg = Object.assign({}, cfg, msg.patch || {});
        await chrome.storage.local.set({ cfg });
        return sendResponse({ cfg });
      }
      case "resetLearned": {
        ceilings = Object.assign({}, A.DEFAULT_CEIL);
        for (const id of A.FAMILY_IDS) { F[id].learned = false; F[id].cd = 0; F[id].c429 = []; F[id].oks = []; }
        await chrome.storage.local.set({ ceilings, learned: {} });
        scheduleRender();
        return sendResponse({ ok: true });
      }
      default: return sendResponse({ error: "unknown message" });
    }
  })().catch(e => sendResponse({ error: String(e && e.message || e) }));
  return true; // async response
});

// ---------- self-update for unpacked installs ----------
// Chrome never re-reads an unpacked extension folder by itself; the user would have to press the reload arrow after
// every update. Reading our own manifest from disk shows whether a newer build is sitting in the folder.
async function checkForNewerVersion() {
  if (cfg.autoReload === false) return;
  const { lastAutoReload = 0 } = await chrome.storage.local.get("lastAutoReload");
  if (Date.now() - lastAutoReload < 10 * 60 * 1000) return; // never a reload loop
  const r = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
  const disk = (await r.json()).version;
  if (A.versionGreater(disk, chrome.runtime.getManifest().version)) {
    await chrome.storage.local.set({ lastAutoReload: Date.now(), reloadedFrom: chrome.runtime.getManifest().version, reloadedTo: disk });
    chrome.runtime.reload();
  }
}

// ---------- housekeeping ----------
chrome.alarms.create("a429-tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async alarm => {
  await ready;
  if (alarm.name === "a429-tick") {
    checkForNewerVersion().catch(() => {});
    const now = Date.now();
    let changed = false;
    for (const id of A.FAMILY_IDS) {
      const f = F[id];
      const quiet = now - Math.max(f.last429, 0);
      if (f.learned && quiet > A.RELAX_AFTER_MS && ceilings[id] < A.DEFAULT_CEIL[id]) {
        ceilings[id] = Math.min(A.DEFAULT_CEIL[id], A.relaxCeiling(ceilings[id], id));
        f.last429 = now - A.RELAX_AFTER_MS / 2; // next step after another 15 quiet minutes
        changed = true;
      }
    }
    if (changed) chrome.storage.local.set({ ceilings });
    render().catch(() => {});
setTimeout(() => probeGuards(true).catch(() => {}), 2000);
    probeGuards(false).catch(() => {});
    healTick().catch(() => {});
    pump();
  }
});
chrome.runtime.onInstalled.addListener(async () => { await ready; render().catch(() => {}); setTimeout(() => protectOpenTabs().catch(() => {}), 1500); });
chrome.runtime.onStartup.addListener(() => { render().catch(() => {}); setTimeout(() => probeGuards(true).catch(() => {}), 3000); });
render().catch(() => {});

setTimeout(() => probeGuards(true).catch(() => {}), 2000); // service worker (re)start: re-learn which tabs already run the guard

// Remember the dashboard window's size/position so the next one opens exactly where the user left it.
let boundsTimer = null;
chrome.windows.onBoundsChanged.addListener(win => {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(async () => {
    const { dashWin } = await chrome.storage.local.get("dashWin");
    if (win.id === dashWin) chrome.storage.local.set({ dashBounds: { width: win.width, height: win.height, left: win.left, top: win.top } });
  }, 600);
});
chrome.windows.onRemoved.addListener(async id => {
  const { dashWin } = await chrome.storage.local.get("dashWin");
  if (id === dashWin) chrome.storage.local.remove("dashWin");
});
