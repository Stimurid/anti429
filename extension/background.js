// 4̅2̅9̅ (Anti-429) service worker.
// Observes every /backend-api request via webRequest (read-only), meters the four limiter families,
// learns lower ceilings from real 429s, drives the badge/icon traffic light and serves the popup.
importScripts("shared.js", "health_bridge.js");
const A = self.A429;

const DEFAULT_CFG = {
  enabled: true,          // page guard on/off (mirrored to localStorage by bridge.js)
  loopDetail: 4,          // history GETs / 60 s that make a tab look like a poll loop
  loopStream: 5,          // stream_status/resume / 60 s
  loopMb10: 100,          // MB transferred in 10 min
  restoreGapSec: 12,      // pause between tabs when restoring a saved session
  reaper: true,           // account-wide audit: stop chats stuck on IS_STREAMING with a frozen update_time
  reaperIdleMs: 30 * 60000,    // idle (since update_time) required before a chat may be stopped
  reaperConfirmMs: 10 * 60000, // the SAME update_time must be seen again at least this much later
  reaperEveryMs: 15 * 60000,   // audit period when nothing is under suspicion (the head scan is only a few requests)
  runsEveryMs: 2 * 60000,      // audit period while background runs are being watched
  runStaleMs: 15 * 60000,      // a run whose update_time did not move for this long is shown as 'stalled'
  notifyRuns: true,            // desktop notification when a watched background run finishes
  reaperFastMs: 5 * 60000,     // audit period while there are suspects
  reaperLookbackMs: 14 * 86400000, // only chats updated within this window are checked
  reaperMaxStopsPerDay: 30,
  reaperPaceMs: 2000,          // one audit request per 2 s (<= 5 per 10 s)
  reaperMaxStatus: 20,         // stream_status checks per audit (the backlog drains over several audits)
  reaperDeepEveryMs: 24 * 3600000, // full walk through all lists + projects at most this often
  reaperRateBackoffMs: 30 * 60000, // after a 429 the audit sleeps this long
  autoStop: false,        // send stop_conversation for chats whose stream looks dead (OFF by default: stopping a live run destroys it)
  autoStopMin: 45,        // ... only after IS_STREAMING was observed this long AND the resume breaker tripped
  hibernate: true,        // put a tab with a streak of 429s (page-side retry loop) to sleep: it blocks the whole account
  hibernate429: 40,       // 429s within 10 minutes that make a tab 'looping'
  memDiscard: true,       // under memory pressure, discard idle background chatgpt tabs (never active / draft / generating / audible)
  memDiscardPct: 93,      // physical memory used, % — at or above this one tab is discarded per check
  memDiscardGapMs: 6000,  // pause after a discard so the freed memory shows up before the next one
  autoHeal: true,         // revive tabs stuck on "Could not load this conversation" when the limiter is calm
  calmMs: 30000,          // required quiet time since the last 429 before a heal
  healGapMs: 15000,       // at least this long between two heals (any tabs)
  healBackoffScale: 1,    // multiplies the per-tab retry spacing (test hook)
  healPauseScale: 1,      // multiplies the global pause after a failed heal (test hook)
  notifyStorm: true       // desktop notification when 3+ ChatGPT tabs are opened within 3 minutes
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
const STOP = {}; // tabId -> { at }  when the extension last sent stop_conversation for that tab
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

// ---------- journal: what actually happened, kept across restarts (so an incident can be explained afterwards) ----------
let JR = [], jrDirty = false, LOADS = 0, lastJrMin = Date.now();
let OTHER = {};   // path pattern -> count since the last journal line: backend-api traffic that is NOT one of the limiter families
const HB = {};    // tabId -> timestamps of automatic heals (the budget)
const HF = { streak: 0, until: 0, last: 0 };
const RQ = [];    // restart queue [{ id, dueAt, why }]: tabs to reload by themselves once the limiter is calm
let lastRestartAt = 0;
const HRB = {};   // tabId -> time of the last automatic restart after hibernation (once per hour)
const rqReady = chrome.storage.local.get("rq").then(r => { for (const q of (r.rq || [])) if (!RQ.some(x => x.id === q.id)) RQ.push(q); }).catch(() => {});
const saveRQ = () => chrome.storage.local.set({ rq: RQ }).catch(() => {});
function queueRestart(id, delayMs, why) {
  const i = RQ.findIndex(q => q.id === id);
  if (i >= 0) RQ.splice(i, 1);
  RQ.push({ id, dueAt: Date.now() + delayMs, why });
  saveRQ();
  jr("restart-queued", { tab: id, why, inSec: Math.round(delayMs / 1000) });
}
async function restartTick(now) {
  await rqReady;
  if (!RQ.length) return;
  const id = A.restartPick(RQ, { now, calm: calmNow(now), lastRestartAt, gapMs: 25000, pausedUntil: HF.until });
  if (id == null) return;
  const i = RQ.findIndex(q => q.id === id);
  const q = RQ.splice(i, 1)[0];
  saveRQ();
  let tab = null;
  try { tab = await chrome.tabs.get(id); } catch {}
  if (!tab) return;
  lastRestartAt = now;
  try { await chrome.tabs.reload(id); jr("restart", { tab: id, why: q.why }); } catch {}
} // consecutive heals answered by another 429 -> escalating global pause
const normPath = p => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>").replace(/g-p-[0-9a-f]+/g, "g-p-<id>").replace(/[0-9a-f]{16,}/g, "<hex>").slice(0, 70);
const jrReady = chrome.storage.local.get("journal").then(r => { JR = (r.journal || []).concat(JR).slice(-400); }).catch(() => {});
function jr(e, data) {
  JR.push(Object.assign({ t: Date.now(), e }, data || {}));
  if (JR.length > 400) JR.splice(0, JR.length - 400);
  if (jrDirty) return;
  jrDirty = true;
  setTimeout(async () => { jrDirty = false; await jrReady; try { await chrome.storage.local.set({ journal: JR }); } catch {} }, 4000);
}
// once a minute, only if something happened: requests per family, busiest tabs, tab loads, held requests
async function journalTick(now) {
  if (now - lastJrMin < 60000) return;
  lastJrMin = now;
  const fam = {};
  for (const id of A.FAMILY_IDS) { const n = A.countIn(F[id].starts, now, 60000); if (n) fam[id] = n; }
  const top = Object.entries(T).map(([id, s]) => [id, s.req.length, s.c429.length]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const held = Object.values(H).reduce((a, n) => a + (n || 0), 0);
  if (!Object.keys(fam).length && !LOADS && !held && !Object.keys(OTHER).length) return;
  const topT = [];
  for (const [id, req, c] of top) {
    let t = ""; try { t = ((await chrome.tabs.get(Number(id))).title || "").slice(0, 28); } catch {}
    topT.push({ tab: Number(id), req, c429: c, t });
  }
  const other = Object.entries(OTHER).sort((a, b) => b[1] - a[1]).slice(0, 6);
  jr("min", { fam, loads: LOADS, held, top: topT, other });
  LOADS = 0; OTHER = {};
}

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
  if (reaperAuditing && (fam === "list" || fam === "stream")) return; // the reaper's own paced requests
  if (details.tabId >= 0) {
    const s = tabStats(details.tabId);
    s.req.push(now);
    if (fam) (s.fam[fam] || (s.fam[fam] = [])).push(now);
  }
  if (fam) F[fam].starts.push(now);
  else if (!reaperAuditing) {
    const who = details.tabId >= 0 ? "tab" + details.tabId : (details.initiator || "?").replace("chrome-extension://", "ext:").slice(0, 16);
    const k = details.method + " " + normPath(u.pathname) + " [" + who + "]";
    OTHER[k] = (OTHER[k] || 0) + 1;
  }
  persistSoon();
  scheduleRender();
}, { urls: URLS });

chrome.webRequest.onHeadersReceived.addListener(details => {
  const u = parseUrl(details.url);
  if (!u) return;
  const now = Date.now();
  const fam = A.classify(details.method, u.pathname);
  if (reaperAuditing && (fam === "list" || fam === "stream")) return;
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
  if (lastHealAny && now - lastHealAny < 120000 && now - HF.last > 20000) {
    HF.last = now; HF.streak++;
    HF.until = now + A.healPauseMs(HF.streak) * (cfg.healPauseScale == null ? 1 : cfg.healPauseScale);
    jr("heal-pause", { streak: HF.streak, min: Math.round(A.healPauseMs(HF.streak) / 60000) });
  }
  jr("429", { fam, tab: details.tabId, ra: ra ? Math.round(ra / 1000) : null, acc: observed, n10: f.c429.length, tabReq60: details.tabId >= 0 ? A.countIn(tabStats(details.tabId).req, now, 60000) : null });
  f.cd = Math.max(f.cd, now + (ra || 15000));
  if (details.tabId >= 0) tabStats(details.tabId).c429.push(now);
  chrome.storage.local.set({ ceilings, learned: Object.fromEntries(A.FAMILY_IDS.map(i => [i, F[i].learned])) });
  persistSoon();
  scheduleRender();
}, { urls: URLS }, ["responseHeaders"]);

// who opens ChatGPT tabs? Log every new one (parent, group, window, focus) and warn about a storm of them.
const CREATED = [];
let lastStormNote = 0;
chrome.tabs.onCreated.addListener(tab => {
  const url = tab.pendingUrl || tab.url || "";
  if (!url.startsWith("https://chatgpt.com/")) return;
  const now = Date.now();
  let path = "";
  try { path = normPath(new URL(url).pathname); } catch {}
  jr("tab-new", { tab: tab.id, win: tab.windowId, grp: tab.groupId, opener: tab.openerTabId || null, active: !!tab.active, u: path });
  CREATED.push(now);
  while (CREATED.length && now - CREATED[0] > 3 * 60000) CREATED.shift();
  if (CREATED.length >= 3 && now - lastStormNote > 10 * 60000) {
    lastStormNote = now;
    jr("tab-storm", { n: CREATED.length });
    if (cfg.notifyStorm !== false) notifyLoop("a429-storm-" + now, "Кто-то массово открывает вкладки ChatGPT", CREATED.length + " новых вкладки за 3 минуты. Это не вы? Смотрите «Журнал событий» в панели 4̅2̅9̅: там видно окно, группу и фокус каждой.");
  }
});

chrome.tabs.onRemoved.addListener(id => { delete T[id]; delete H[id]; delete P[id]; delete G[id]; delete R[id]; delete B[id]; delete D[id]; delete S[id]; delete STOP[id]; persistSoon(); });
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (info.status === "loading") { if (tab && String(tab.url || "").startsWith("https://chatgpt.com/")) LOADS++; delete H[id]; delete P[id]; delete G[id]; delete B[id]; delete D[id]; delete S[id]; } });

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
    t.stopReq = S[id] && S[id].status === "IS_STOP_REQUESTED" ? Math.round((now - S[id].since) / 60000) : -1;
    t.stoppedAgoSec = STOP[id] ? Math.round((now - STOP[id].at) / 1000) : 0;
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
  return A.isCalm(A.FAMILY_IDS.map(id => ({ id, cd: F[id].cd, last429: F[id].last429, starts: F[id].starts, c429: F[id].c429 })), now, cfg);
}

// ---------- zombie reaper ----------
// Finds chats whose server-side stream is dead (IS_STREAMING, update_time frozen) and sends Stop on its own.
// State lives in chrome.storage.local ("reaper"): obs = suspects, chk = update_time at which a chat was last seen
// COMPLETE (so the next audit can skip it), log = recent actions for the dashboard.
const convOfUrl = u => { const m = String(u || "").split("/c/")[1]; return m ? m.split(/[/?#]/)[0] : null; };
let reaperBusy = false;
let reaperAuditing = false;

async function reaperState() {
  const { reaper } = await chrome.storage.local.get("reaper");
  return Object.assign({ obs: {}, chk: {}, log: [], runs: {}, done: [], lastAudit: 0, lastDeep: 0, lastReqs: 0, lastMs: 0, lastRate: 0, lastError: null, stopsDay: { day: "", n: 0 } }, reaper || {});
}

async function reaperTick(force) {
  if (reaperBusy) return { busy: true };
  if (cfg.reaper === false && !force) return { off: true };
  reaperBusy = true;
  try {
    const now = Date.now();
    const R = await reaperState();
    if (R.lastError === "no-bridge") await ensureBridges();
    const suspects = Object.keys(R.obs).filter(id => R.obs[id].status === "IS_STREAMING");
    const watchRow=await chrome.storage.local.get("hydra.health.watches.v1");
    const watchIds=Object.entries(watchRow["hydra.health.watches.v1"]||{}).filter(([,t])=>now-t<10*60000).map(([id])=>id).sort((a,b)=>(R.health?.[a]?.stream_observed_at_ms||0)-(R.health?.[b]?.stream_observed_at_ms||0)).slice(0,32);
    const every = watchIds.length ? Math.min(cfg.runsEveryMs,120000) : suspects.length ? cfg.reaperFastMs : (Object.keys(R.runs).length ? cfg.runsEveryMs : cfg.reaperEveryMs);
    if (!force && now - R.lastAudit < every) return { skipped: true };
    // Never add load while the limiter is busy: no cooldown, no recent 429, nobody loading history right now.
    if (!force && !calmNow(now)) return { notCalm: true };
    const deep = force || !R.lastDeep || now - R.lastDeep > cfg.reaperDeepEveryMs;
    const tabs = (await chatTabs()).filter(t => !t.discarded);
    if (!tabs.length) return { noTab: true };
    const tab = tabs.find(t => t.active) || tabs[0];
    const generating = new Set(tabs.filter(t => P[t.id] && P[t.id].generating).map(t => convOfUrl(t.url)).filter(Boolean));

    let scan = null;
    reaperAuditing = true; // the audit's own requests are not the user's load: keep them out of the meters/learning
    try {
      scan = await chrome.tabs.sendMessage(tab.id, { type: "a429_scan", params: {
        idleMs: cfg.reaperIdleMs, lookbackMs: cfg.reaperLookbackMs, checkIds: [...new Set([...watchIds,...Object.keys(R.obs)])],
        paceMs: cfg.reaperPaceMs, maxStatus: cfg.reaperMaxStatus, maxList: deep ? 224 : 56, projectPages: deep ? 6 : 1,
        skip: Object.fromEntries(Object.entries(R.chk).filter(([, v]) => v.st === "COMPLETE").map(([k, v]) => [k, v.u])),
        projectIds: [...new Set(tabs.map(t => (String(t.url).split("/g/")[1] || "").split("/")[0]).filter(Boolean))]
      } });
    } catch {}
    reaperAuditing = false;
    R.lastAudit = now;
    if (scan && scan.ok) { R.lastReqs = scan.requests || 0; R.lastMs = scan.ms || 0; if (deep && !scan.rate) R.lastDeep = now; }
    if (!scan || !scan.ok) { R.lastError = (scan && scan.reason) || "no-bridge"; await chrome.storage.local.set({ reaper: R }); return { error: R.lastError }; }
    R.lastError = null;
    R.health=self.A429Health.observe(R.health||{},scan,Date.now());
    if (scan.rate) { R.lastRate = now; R.lastAudit = now - every + cfg.reaperRateBackoffMs; } // 429: back off for a long time

    const day = new Date(now).toISOString().slice(0, 10);
    if (R.stopsDay.day !== day) R.stopsDay = { day, n: 0 };
    const stopped = [];
    for (const it of scan.items) {
      const st = scan.statuses[it.id];
      const known = R.chk[it.id];
      const status = st !== undefined ? st : (known && known.u === it.u ? known.st : undefined);
      if (status === undefined) continue; // not checked this time (too recent / over the cap)
      if (status === "COMPLETE") { R.chk[it.id] = { u: it.u, st: "COMPLETE" }; delete R.obs[it.id]; continue; }
      const v = A.reaperVerdict(R.obs[it.id] || null, { status, updMs: it.u, generatingTab: generating.has(it.id) }, now,
        { idleMs: cfg.reaperIdleMs, confirmMs: cfg.reaperConfirmMs });
      if (v.rec) R.obs[it.id] = Object.assign({}, v.rec, { t: it.t });
      else delete R.obs[it.id];
      // A HYDRA observation lease never grants destructive recovery.
      if (v.action === "stop" && !watchIds.includes(it.id) && R.stopsDay.n < cfg.reaperMaxStopsPerDay) {
        let r = null;
        try { r = await chrome.tabs.sendMessage(tab.id, { type: "a429_stop", conv: it.id }); } catch {}
        R.stopsDay.n++;
        R.log.unshift({ id: it.id, t: it.t, at: Date.now(), ok: !!(r && r.ok) });
        if (r && r.ok) { stopped.push(it.id); R.obs[it.id] = { status: "IS_STOP_REQUESTED", updMs: it.u, since: Date.now(), t: it.t }; }
      }
    }
    // background (async) runs: show them as "working on the server" and say when they finish
    const seenIds = new Set();
    for (const it of scan.items) {
      seenIds.add(it.id);
      const rv = A.runVerdict(R.runs[it.id] || null, { a: it.a, status: scan.statuses[it.id], updMs: it.u }, now, { runStaleMs: cfg.runStaleMs });
      if (rv.action === "live" || rv.action === "stalled") R.runs[it.id] = Object.assign({}, rv.rec, { t: it.t, g: it.g || null, state: rv.action });
      else if (rv.action === "done") { notifyRunDone(R, it.id, R.runs[it.id], it.t, now); delete R.runs[it.id]; }
      else if (rv.action === "ignore") delete R.runs[it.id];
    }
    for (const id of Object.keys(R.runs)) {
      if (seenIds.has(id)) continue;
      if (A.runVerdict(R.runs[id], null, now, {}).action === "forget") delete R.runs[id];
    }
    // forget what disappeared from the lists / went stale
    const alive = new Set(scan.items.map(i => i.id));
    for (const id of Object.keys(R.obs)) if (!alive.has(id) && now - (R.obs[id].since || 0) > 3 * 86400000) delete R.obs[id];
    for (const id of Object.keys(R.chk)) if (!alive.has(id)) delete R.chk[id];
    R.log = R.log.slice(0, 40);
    await chrome.storage.local.set({ reaper: R });
    return { scanned: scan.items.length, checked: Object.keys(scan.statuses).length, stopped, rate: !!scan.rate };
  } finally { reaperBusy = false; reaperAuditing = false; }
}

function notifyRunDone(R, id, prev, title, now) {
  const took = prev && prev.firstSeen ? Math.round((now - prev.firstSeen) / 60000) : 0;
  R.done.unshift({ id, t: title || (prev && prev.t) || "", at: now, tookMin: took, g: (prev && prev.g) || null });
  R.done = R.done.slice(0, 10);
  if (cfg.notifyRuns !== false && chrome.notifications) {
    try {
      chrome.notifications.create("a429-run-" + id + "-" + now, {
        type: "basic", iconUrl: "icons/icon128.png", title: "Фоновый прогон завершён",
        message: (title || "чат") + (took ? " (наблюдали " + took + " мин)" : ""), priority: 1
      });
    } catch {}
  }
}

async function reaperSummary() {
  const R = await reaperState();
  const now = Date.now();
  const entries = Object.entries(R.obs);
  return {
    on: cfg.reaper !== false,
    lastAuditAgoSec: R.lastAudit ? Math.round((now - R.lastAudit) / 1000) : null,
    watching: entries.filter(([, o]) => o.status === "IS_STREAMING").length,
    stopping: entries.filter(([, o]) => o.status === "IS_STOP_REQUESTED").length,
    stoppedToday: R.stopsDay.day === new Date(now).toISOString().slice(0, 10) ? R.stopsDay.n : 0,
    rateLimited: !!(R.lastRate && now - R.lastRate < 30 * 60000),
    lastReqs: R.lastReqs || 0,
    lastSec: Math.round((R.lastMs || 0) / 1000),
    deepAgoH: R.lastDeep ? Math.round((now - R.lastDeep) / 360000) / 10 : null,
    error: R.lastError,
    runs: Object.entries(R.runs).map(([id, r]) => ({
      id, t: r.t, g: r.g || null, state: r.state,
      idleSec: r.lastU ? Math.round((now - r.lastU) / 1000) : null,
      watchedMin: Math.round((now - (r.firstSeen || now)) / 60000)
    })).sort((a, b) => (a.idleSec || 0) - (b.idleSec || 0)).slice(0, 12),
    done: R.done.slice(0, 6).map(d => ({ id: d.id, t: d.t, g: d.g || null, agoMin: Math.round((now - d.at) / 60000), tookMin: d.tookMin })),
    log: R.log.slice(0, 8).map(l => ({ t: l.t, agoMin: Math.round((now - l.at) / 60000), ok: l.ok }))
  };
}

async function stopStream(id) {
  // Reserve BEFORE sending: two overlapping ticks must never send "Stop" twice for the same chat.
  const prev = STOP[id];
  STOP[id] = { at: Date.now(), pending: true };
  let res = null;
  try { res = await chrome.tabs.sendMessage(id, { type: "a429_stop" }); } catch {}
  if (res && res.ok) STOP[id] = { at: Date.now() };
  else STOP[id] = prev || { at: Date.now() - 6 * 3600 * 1000 + 5 * 60 * 1000 }; // failed: the auto mode may retry in ~5 min
  persistSoon();
  return res || { ok: false, reason: "no-bridge" };
}

// Opt-in (cfg.autoStop): stop chats that were IS_STREAMING for autoStopMin AND whose resume kept failing.
async function autoStopTick() {
  if (!cfg.autoStop) return;
  const now = Date.now();
  for (const [sid, st] of Object.entries(S)) {
    const id = Number(sid);
    if (A.shouldAutoStop({ status: st.status, since: st.since, dead: !!D[id], lastStopAt: STOP[id] && STOP[id].at }, now, cfg)) {
      await stopStream(id);
    }
  }
}

async function healTab(id, manual) {
  const b = B[id] || (B[id] = { heals: 0, lastHealAt: 0, failedAt: Date.now() });
  b.heals = (b.heals || 0) + 1;
  b.lastHealAt = Date.now();
  if (!manual) { lastHealAny = Date.now(); (HB[id] = (HB[id] || []).filter(t => Date.now() - t < 20 * 60000)).push(Date.now()); }
  let res = null;
  jr("heal", { tab: id, manual: !!manual, n: b.heals });
  try { res = await chrome.tabs.sendMessage(id, { type: "a429_heal" }); } catch {}
  if (res && !res.clicked && res.reason === "no-banner") delete B[id]; // the page already recovered by itself
  persistSoon();
  return res || { clicked: false, reason: "no-bridge" };
}

let healBusy = false;
const HIB_NOTIFIED = {};
async function hibernateTick() {
  if (cfg.hibernate === false) return;
  const now = Date.now();
  for (const [sid, s] of Object.entries(T)) {
    const id = Number(sid);
    const stats = { c429_10: s.c429.length };
    if (stats.c429_10 < cfg.hibernate429) continue;
    let tab = null;
    try { tab = await chrome.tabs.get(id); } catch {}
    if (!tab || tab.discarded) continue;
    const v = A.shouldHibernate(stats, tab, P[id], cfg);
    if (v.ok) {
      const r = await discardTabs([id], false);
      if (r.discarded.includes(id)) {
        const { hib = [] } = await chrome.storage.local.get("hib");
        hib.unshift({ id, t: tab.title || tab.url, url: tab.url, at: now, n: stats.c429_10 });
        await chrome.storage.local.set({ hib: hib.slice(0, 20) });
        jr("hib", { tab: id, n: stats.c429_10 });
        if (now - (HRB[id] || 0) > 3600000) { HRB[id] = now; queueRestart(id, 5 * 60000, "after-hibernate"); } // once per hour per tab
        notifyLoop("a429-hib-" + id + "-" + now, "Вкладка усыплена: зациклилась", (tab.title || "вкладка") + " (" + stats.c429_10 + "×429 за 10 мин). Она осталась на месте, кликните по ней, чтобы загрузить.");
      }
    } else if (v.reason === "active" && now - (HIB_NOTIFIED[id] || 0) > 30 * 60000) {
      HIB_NOTIFIED[id] = now;
      notifyLoop("a429-loop-" + id + "-" + now, "Вкладка зациклилась и держит блокировку", (tab.title || "вкладка") + ": " + stats.c429_10 + "×429. Переключитесь на другую вкладку, и я её усыплю.");
    }
  }
}
// Memory pressure: below the OS-level watchdog's kill threshold, quietly put the longest-idle background tab to sleep.
let lastMemDiscard = 0;
async function memoryTick() {
  if (cfg.memDiscard === false || !chrome.system || !chrome.system.memory) return;
  const now = Date.now();
  if (now - lastMemDiscard < cfg.memDiscardGapMs) return;
  const m = await chrome.system.memory.getInfo();
  const used = 100 * (1 - m.availableCapacity / m.capacity);
  if (used < cfg.memDiscardPct) return;
  const tabs = (await chatTabs()).map(t => ({ id: t.id, active: t.active, discarded: t.discarded, audible: t.audible, lastAccessed: t.lastAccessed, state: P[t.id] }));
  const id = A.pickMemoryVictim(used, tabs, cfg);
  if (id == null) return;
  lastMemDiscard = now;
  const r = await discardTabs([id], false);
  if (r.discarded.includes(id)) jr("mem-discard", { tab: id, used: Math.round(used * 10) / 10 });
}
function notifyLoop(nid, title, message) {
  if (!chrome.notifications) return;
  try { chrome.notifications.create(nid, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 }); } catch {}
}

async function healTick() {
  reaperTick(false).catch(() => {});
  autoStopTick().catch(() => {});
  hibernateTick().catch(() => {});
  memoryTick().catch(() => {});
  restartTick(Date.now()).catch(() => {});
  journalTick(Date.now()).catch(() => {});
  if (healBusy || cfg.autoHeal === false) return;
  if (Date.now() < HF.until) return; // paused after a heal that got another 429
  if (HF.streak && Date.now() - HF.last > 30 * 60000) HF.streak = 0;
  healBusy = true;
  try {
    const now = Date.now();
    const cands = [];
    for (const [sid, b] of Object.entries(B)) {
      const id = Number(sid);
      let tab = null;
      try { tab = await chrome.tabs.get(id); } catch {}
      if (!tab || tab.discarded) { delete B[sid]; continue; }
      if (!A.healBudgetOk(HB[id], now, 4, 20 * 60000)) continue; // already poked 4 times in 20 min: leave it alone
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
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: "MAIN", func: () => window.__A429_GEN__ || 0 });
      if (r && r.result >= A.GEN) G[t.id] = true; else delete G[t.id]; // an OLDER generation counts as unprotected: it gets replaced
    } catch {}
  }
  persistSoon();
}

// After every extension (re)load the bridge (isolated world) that was running in an open tab is orphaned: it can no longer
// talk to the service worker, so tab state, heal, stop, scan and the event relay all go silent. Ping each tab and
// re-inject the bridge wherever nobody answers.
let lastEnsure = 0;
async function ensureBridges() {
  lastEnsure = Date.now();
  const tabs = (await chatTabs()).filter(t => !t.discarded);
  let pinged = 0, injected = 0;
  for (const t of tabs) {
    let alive = false;
    try { const r = await chrome.tabs.sendMessage(t.id, { type: "a429_ping" }); alive = !!(r && r.ok); } catch {}
    if (alive) { pinged++; continue; }
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["bridge.js"], world: "ISOLATED" }); injected++; } catch {}
    await sleep(100);
  }
  return { tabs: tabs.length, pinged, injected };
}

async function startupRepair() {
  await ready;
  await protectOpenTabs();   // replaces older page-side generations
  await ensureBridges();     // revives bridges orphaned by the reload
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
          } else if (msg.ev.type === "history-ok") { delete B[id]; HF.streak = 0; HF.until = 0; }
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
      case "ensureBridges": return sendResponse(await ensureBridges());
      case "healNow": return sendResponse(await healTab(msg.id, true));
      case "stopStream": return sendResponse(await stopStream(msg.id));
      case "reaperRun": return sendResponse(await reaperTick(true));
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
        return sendResponse(Object.assign(snapshot(), { sessions, restoreQueue: restoreQueue.length, reaper: await reaperSummary(), journal: (await jrReady, JR.slice(-40)), hib: (await chrome.storage.local.get('hib')).hib || [] }));
      }
      case "discard": return sendResponse(await discardTabs(msg.ids || [], msg.force));
      case "restart": {
        let tab = null;
        try { tab = await chrome.tabs.get(msg.id); } catch {}
        if (!tab) return sendResponse({ ok: false, reason: "gone" });
        const risky = P[msg.id] && (P[msg.id].draft || P[msg.id].generating);
        if (risky && !msg.force) return sendResponse({ ok: false, reason: P[msg.id].generating ? "generating" : "draft" });
        if (!tab.discarded && !tab.active) { const r = await discardTabs([msg.id], !!msg.force); if (r.skipped.length) return sendResponse({ ok: false, reason: r.skipped[0].reason }); }
        queueRestart(msg.id, 15000, "owner");
        return sendResponse({ ok: true, afterSec: 15 });
      }
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
    probeGuards(false).catch(() => {});
    if (Date.now() - lastEnsure > 120000) ensureBridges().catch(() => {});
    healTick().catch(() => {});
    pump();
  }
});
chrome.runtime.onInstalled.addListener(() => { chatTabs().then(t => jr("installed", { tabs: t.length })).catch(() => {}); render().catch(() => {}); setTimeout(() => startupRepair().catch(() => {}), 1500); });
chrome.runtime.onStartup.addListener(() => { chatTabs().then(t => jr("chrome-start", { tabs: t.length, discarded: t.filter(x => x.discarded).length })).catch(() => {}); render().catch(() => {}); setTimeout(() => startupRepair().catch(() => {}), 3000); });
render().catch(() => {});

setTimeout(() => startupRepair().catch(() => {}), 2500); // ANY service-worker start (incl. runtime.reload(), which may not fire onInstalled): upgrade page-side code and revive bridges

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

// HYDRA requests cached evidence only. It cannot make this API Send, Retry,
// Stop, enumerate history or force an account scan past the existing governor.
if(chrome.runtime.onMessageExternal)chrome.runtime.onMessageExternal.addListener((msg,sender,reply)=>{
 if(sender.id!=="opgnfgihbjphabgflgnaiamenmdgfjom" || sender.tab ||
    msg?.type!=="hydra.health.read" || !self.A429Health.validId(msg.conversationId)){
   reply({ok:false,error:"HEALTH_READ_SCOPE_REQUIRED"});return false;
 }
 (async()=>{await ready;
   if(msg.watch===true){const k="hydra.health.watches.v1",now=Date.now(),row=await chrome.storage.local.get(k);
     const map=Object.fromEntries(Object.entries(row[k]||{}).filter(([,t])=>now-t<10*60000));
     if(Object.keys(map).length<32||map[msg.conversationId]){map[msg.conversationId]=now;await chrome.storage.local.set({[k]:map});}
   }
   return Object.assign(self.A429Health.snapshot(msg.conversationId,await reaperState(),cfg,F),
     {observer_version:chrome.runtime.getManifest().version});
 })().then(reply,()=>reply({ok:false,error:"HEALTH_CACHE_UNAVAILABLE"}));return true;
});
