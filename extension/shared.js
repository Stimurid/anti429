// 4̅2̅9̅ (Anti-429) — shared pure logic. Loaded in page (MAIN), service worker, popup and Node tests.
// No DOM / chrome.* here: everything below must stay testable under plain Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.A429 = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Four request families that ChatGPT's web client rate-limits separately.
  // "detail"  = GET /backend-api/conversations/<id>   (new history endpoint, the one that fails in the UI)
  // "legacy"  = GET /backend-api/conversation/<id>    (old history endpoint, separate limiter)
  // "stream"  = GET .../stream_status, POST /f/conversation/resume  (resume/poll loop)
  // "list"    = GET /backend-api/conversations, POST .../batch (sidebar list)
  const FAMILIES = [
    { id: "detail", label: "История чата", hint: "conversations/<id>", guarded: true },
    { id: "legacy", label: "История (старый)", hint: "conversation/<id>", guarded: true },
    { id: "stream", label: "Статус потока", hint: "stream_status · resume", guarded: true },
    { id: "list", label: "Список чатов", hint: "conversations", guarded: true }
  ];
  const FAMILY_IDS = FAMILIES.map(f => f.id);

  // Metering window and assumed ceilings (requests per WINDOW_MS before ChatGPT answers 429).
  // These are ASSUMPTIONS until the extension observes a real 429 and learns a lower number.
  const WINDOW_MS = 10000;
  const DEFAULT_CEIL = { detail: 4, legacy: 4, stream: 6, list: 8 };
  const MAX_CEIL = { detail: 12, legacy: 12, stream: 20, list: 24 };
  const CEIL_MIN = 2;
  const PACE_FRACTION = 0.75; // guard keeps starts <= 75% of the ceiling
  const RELAX_AFTER_MS = 30 * 60 * 1000; // ceiling creeps back up after 30 quiet minutes

  const BACKOFFS_MS = [2000, 4000, 8000, 15000, 30000, 45000, 60000];
  const HOLD_MAX_MS = 5 * 60 * 1000; // how long the guard keeps a request pending instead of failing it
  const TERMINAL_COOLDOWN_MS = 3 * 60 * 1000;
  const RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

  const BACKEND = /^\/backend-api\//;

  // method: "GET" | "POST" ...; pathname: "/backend-api/..."; returns family id or null.
  function classify(method, pathname) {
    if (!BACKEND.test(pathname)) return null;
    const m = String(method || "GET").toUpperCase();
    if (m === "GET" && pathname === "/backend-api/conversations") return "list";
    if (m === "POST" && pathname === "/backend-api/conversations/batch") return "list";
    if (m === "GET" && /^\/backend-api\/conversations\/[^/?]+$/.test(pathname)) return "detail";
    if (m === "GET" && /^\/backend-api\/conversation\/[^/?]+\/stream_status$/.test(pathname)) return "stream";
    if (m === "GET" && /^\/backend-api\/conversation\/[^/?]+$/.test(pathname)) return "legacy";
    if (pathname === "/backend-api/f/conversation/resume") return "stream";
    return null;
  }

  // The guard may only hold/retry idempotent GETs.
  function isGuardable(method, family) {
    return String(method || "GET").toUpperCase() === "GET" && FAMILY_IDS.includes(family);
  }

  function parseRetryAfter(raw, now) {
    if (raw == null || raw === "") return 0;
    const sec = Number(raw);
    let ms = 0;
    if (Number.isFinite(sec) && sec >= 0) ms = sec * 1000;
    else {
      const when = Date.parse(raw);
      if (Number.isFinite(when)) ms = Math.max(0, when - (now == null ? Date.now() : now));
    }
    return Math.min(ms, RETRY_AFTER_CAP_MS);
  }

  function retryBackoffMs(level) {
    const i = Math.max(0, Math.min(level | 0, BACKOFFS_MS.length - 1));
    return BACKOFFS_MS[i];
  }

  function jitter(ms, fraction, rnd) {
    const r = typeof rnd === "number" ? rnd : Math.random();
    const f = fraction == null ? 0.15 : fraction;
    return Math.round(ms * (1 - f + r * 2 * f));
  }

  function countIn(times, now, windowMs) {
    let n = 0;
    for (const t of times) if (now - t < windowMs && now - t >= 0) n++;
    return n;
  }

  function capFor(ceiling) {
    return Math.max(1, Math.floor(ceiling * PACE_FRACTION));
  }

  // Sliding-window limiter: how long must a new request wait so that at most `cap`
  // starts fall inside `windowMs`? 0 means "go now".
  function paceWaitMs(times, now, windowMs, cap) {
    const inWin = times.filter(t => now - t < windowMs && now - t >= 0).sort((a, b) => a - b);
    if (inWin.length < cap) return 0;
    const idx = inWin.length - cap; // this entry must expire first
    return Math.max(1, inWin[idx] + windowMs - now + 1);
  }

  // Size of the burst of accepted requests that ends at `now`: walk backwards while gaps stay <= gapMs.
  // This estimates what the limiter actually tolerated without depending on its (unknown) window length.
  function burstCount(times, now, gapMs) {
    const gap = gapMs == null ? 1500 : gapMs;
    const t = times.filter(x => x <= now).sort((a, b) => b - a);
    if (!t.length || now - t[0] > gap) return 0;
    let n = 1;
    for (let i = 1; i < t.length; i++) { if (t[i - 1] - t[i] > gap) break; n++; }
    return n;
  }

  // A 429 arrived after `observed` starts inside the window. Move the ceiling toward that number.
  function learnCeiling(old, observed, family) {
    const max = MAX_CEIL[family] || 12;
    const target = Math.max(CEIL_MIN, observed);
    if (target >= old) return Math.min(old, max);
    return Math.max(CEIL_MIN, Math.min(max, Math.floor((old + target) / 2)));
  }

  function relaxCeiling(old, family) {
    const max = MAX_CEIL[family] || 12;
    return Math.min(max, old + 1);
  }

  // ratio = starts in window / ceiling.  Traffic-light level.
  function levelOf(ratio, cooling) {
    if (cooling || ratio >= 1) return "red";
    if (ratio >= 0.8) return "orange";
    if (ratio >= 0.5) return "yellow";
    return "green";
  }

  const LEVEL_RANK = { idle: 0, green: 1, yellow: 2, orange: 3, red: 4 };
  function worstLevel(levels) {
    let best = "idle";
    for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
    return best;
  }

  // Heuristic for a tab stuck in a resume/poll loop.
  function isLoop(stats, cfg) {
    const c = Object.assign({ loopDetail: 4, loopStream: 5, loopMb10: 100 }, cfg || {});
    if (!stats) return false;
    return (stats.fam60 && ((stats.fam60.detail || 0) + (stats.fam60.legacy || 0) >= c.loopDetail ||
      (stats.fam60.stream || 0) >= c.loopStream)) || (stats.mb10 || 0) >= c.loopMb10;
  }

  // May this tab be discarded without losing the user's work?
  // state: { draft:bool, generating:bool } as reported by the page bridge (unknown = assume safe).
  // opts.force lets the user override an explicit single-tab confirmation.
  function canDiscard(state, opts) {
    const o = opts || {};
    const st = state || {};
    if (o.active) return { ok: false, reason: "active" };
    if (o.discarded) return { ok: false, reason: "discarded" };
    if (o.audible) return { ok: false, reason: "audible" };
    if (o.force) return { ok: true, reason: null };
    if (st.generating) return { ok: false, reason: "generating" };
    if (st.draft) return { ok: false, reason: "draft" };
    return { ok: true, reason: null };
  }

  // After a heal that was answered with another 429 the server needs real silence: Retry-After alone is not enough
  // (it is understated and the penalty accumulates). Pause all automatic heals, doubling per consecutive failure.
  const HEAL_PAUSE_MS = [0, 120000, 240000, 480000, 900000, 1800000];
  function healPauseMs(streak) { return HEAL_PAUSE_MS[Math.max(0, Math.min(HEAL_PAUSE_MS.length - 1, streak | 0))]; }

  // Restart queue: reload tabs ONE AT A TIME, only when the limiter is calm (the owner never has to hunt for them).
  // queue: [{ id, dueAt }]; ctx: { now, calm, lastRestartAt, gapMs, pausedUntil } -> tab id to reload now, or null.
  function restartPick(queue, ctx) {
    const c = Object.assign({ now: Date.now(), calm: false, lastRestartAt: 0, gapMs: 25000, pausedUntil: 0 }, ctx || {});
    if (!c.calm || c.now < c.pausedUntil) return null;
    if (c.now - c.lastRestartAt < c.gapMs) return null;
    const due = (queue || []).filter(q => q.dueAt <= c.now).sort((a, b) => a.dueAt - b.dueAt);
    return due.length ? due[0].id : null;
  }

  // Restart queue: reload tabs ONE AT A TIME, only when the limiter is calm (the owner never has to hunt for them).
  // queue: [{ id, dueAt }]; ctx: { now, calm, lastRestartAt, gapMs, pausedUntil } -> tab id to reload now, or null.
  function restartPick(queue, ctx) {
    const c = Object.assign({ now: Date.now(), calm: false, lastRestartAt: 0, gapMs: 25000, pausedUntil: 0 }, ctx || {});
    if (!c.calm || c.now < c.pausedUntil) return null;
    if (c.now - c.lastRestartAt < c.gapMs) return null;
    const due = (queue || []).filter(q => q.dueAt <= c.now).sort((a, b) => a.dueAt - b.dueAt);
    return due.length ? due[0].id : null;
  }

  // Heal budget per tab, independent of the tab's banner state (which flips as the page retries on its own):
  // at most `max` automatic heals per `windowMs`, otherwise a tab whose Try-again does not help is poked forever.
  function healBudgetOk(times, now, max, windowMs) {
    const recent = (times || []).filter(t => now - t < (windowMs || 20 * 60000));
    return recent.length < (max || 4);
  }

  // A tab that keeps getting 429s (a page-side retry loop) keeps the whole account blocked. Put it to sleep (discard):
  // the tab stays in the strip with its title, nothing is lost unless it has a draft / a running answer.
  // stats: { c429_10 } ; tab: { active, discarded, audible } ; state: { draft, generating }
  function shouldHibernate(stats, tab, state, cfg) {
    const c = Object.assign({ hibernate: true, hibernate429: 40 }, cfg || {});
    if (c.hibernate === false) return { ok: false, reason: "off" };
    if (!stats || (stats.c429_10 || 0) < c.hibernate429) return { ok: false, reason: "below" };
    const v = canDiscard(state, { active: tab && tab.active, discarded: tab && tab.discarded, audible: tab && tab.audible });
    return v.ok ? { ok: true, reason: null } : { ok: false, reason: v.reason };
  }

  // ---- background (async) runs: verdict for ONE conversation (pure) ----
  // Observed on the real service: an async/agent run has async_status 3, stream_status COMPLETE (nothing is streamed to the
  // page) and an update_time that keeps moving (~1/min). The page then shows "Message delivery timed out" although the work
  // goes on. A chat that is IS_STREAMING is NOT a run: that is the zombie domain (reaper).
  // prev: { firstSeen, lastU, lastMoveAt, lastSeen } | null ; cur: { a, status, updMs } | null (null = not in this scan)
  function runVerdict(prev, cur, now, cfg) {
    const c = Object.assign({ runStaleMs: 15 * 60000, forgetMs: 30 * 60000 }, cfg || {});
    const out = (action, rec) => ({ action, rec: rec || null });
    if (cur && cur.status === "IS_STREAMING") return out("ignore");
    if (cur && cur.a === 3) {
      const idle = Number.isFinite(cur.updMs) && cur.updMs > 0 ? now - cur.updMs : Infinity;
      const rec = {
        firstSeen: (prev && prev.firstSeen) || now, lastU: cur.updMs, lastSeen: now,
        lastMoveAt: prev && prev.lastU === cur.updMs ? (prev.lastMoveAt || now) : now
      };
      return out(idle <= c.runStaleMs ? "live" : "stalled", rec);
    }
    if (cur && prev) return out("done", prev);   // async_status left 3: the run finished
    if (!cur && prev) return now - (prev.lastSeen || 0) > c.forgetMs ? out("forget") : out("unknown", prev);
    return out("ignore");
  }

  // ---- zombie reaper: verdict for ONE conversation (pure) ----
  // A live run keeps moving the conversation's update_time; a dead stream leaves it frozen while stream_status keeps
  // saying IS_STREAMING. So: IS_STREAMING + the SAME update_time at two checks >= confirmMs apart + idle >= idleMs.
  // (resume 404 is NOT used: it also answers 404 for finished chats and for live runs nobody can attach to.)
  // prev: { status, updMs, since } | null ; cur: { status, updMs, generatingTab } ; returns { action, reason, rec }
  const REAPER_DEFAULTS = { idleMs: 30 * 60000, confirmMs: 10 * 60000 };
  function reaperVerdict(prev, cur, now, cfg) {
    const c = Object.assign({}, REAPER_DEFAULTS, cfg || {});
    const out = (action, reason, rec) => ({ action, reason, rec: rec || null });
    if (!cur || !cur.status || cur.status === "COMPLETE") return out("clear", "not-streaming");
    if (cur.status === "IS_STOP_REQUESTED") {
      return out("stopping", "stop-requested", { status: cur.status, updMs: cur.updMs, since: (prev && prev.since) || now });
    }
    if (cur.status !== "IS_STREAMING") return out("clear", "other-status");
    if (!Number.isFinite(cur.updMs) || cur.updMs <= 0) return out("watch", "no-update-time", { status: cur.status, updMs: 0, since: now });
    const same = !!(prev && prev.status === "IS_STREAMING" && prev.updMs === cur.updMs);
    const rec = { status: cur.status, updMs: cur.updMs, since: same ? prev.since : now };
    if (cur.generatingTab) return out("watch", "visible-generation", { status: cur.status, updMs: cur.updMs, since: now });
    if (now - cur.updMs < c.idleMs) return out("watch", "recently-active", rec);
    if (!same) return out("watch", "first-sight", rec);
    if (now - rec.since < c.confirmMs) return out("watch", "confirming", rec);
    return out("stop", "stagnant", rec);
  }

  // Should the extension itself send "Stop" for a chat whose server-side stream looks dead?
  // t: { status, since, dead, lastStopAt }  (status = last stream_status seen, since = when IS_STREAMING was first seen,
  // dead = the resume-404 circuit breaker has tripped).  Deliberately conservative: stopping a LIVE long run would destroy it.
  function shouldAutoStop(t, now, cfg) {
    const c = Object.assign({ autoStop: false, autoStopMin: 45, stopCooldownMs: 6 * 3600 * 1000 }, cfg || {});
    if (!c.autoStop) return false;
    if (!t || t.status !== "IS_STREAMING" || !t.dead) return false;
    if (now - (t.since || now) < c.autoStopMin * 60000) return false;
    if (t.lastStopAt && now - t.lastStopAt < c.stopCooldownMs) return false;
    return true;
  }

  // "0.4.10" > "0.4.2": numeric, component-wise. Anything that is not x.y.z[...] never wins.
  function versionGreater(a, b) {
    const parse = v => (/^\d+(\.\d+){0,3}$/.test(String(v || "")) ? String(v).split(".").map(Number) : null);
    const x = parse(a), y = parse(b);
    if (!x || !y) return false;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d !== 0) return d > 0;
    }
    return false;
  }

  // ---- auto-heal policy (pure; the worker feeds it live state) ----
  // Is the limiter quiet enough that reviving a dead tab cannot hurt tabs that are working right now?
  // fams: [{id, cd, last429, starts:[ts]}] ; cfg.calmMs = required quiet time since the last 429.
  function isCalm(fams, now, cfg) {
    const c = Object.assign({ calmMs: 30000, calmPer429Ms: 20000 }, cfg || {});
    for (const f of fams) {
      if (f.cd > now) return false;
      // the more 429s in the last 20 min, the longer the quiet period: poking a blocked account only prolongs the block
      const recent = (f.c429 || []).filter(t => now - t < 20 * 60000).length;
      const quiet = Math.max(c.calmMs, Math.min(10 * 60000, recent * c.calmPer429Ms));
      if (f.last429 && now - f.last429 < quiet) return false;
    }
    const hist = fams.filter(f => f.id === "detail" || f.id === "legacy")
      .reduce((n, f) => n + countIn(f.starts || [], now, WINDOW_MS), 0);
    return hist <= 1; // somebody is loading history right now -> not calm
  }

  const HEAL_BACKOFF_MS = [0, 30000, 90000, 240000];
  // tabs: [{id, active, failedAt, heals, lastHealAt}] -> id of the ONE tab to revive now, or null.
  function pickHealTarget(tabs, ctx) {
    const c = Object.assign({ calm: false, now: Date.now(), lastHealAny: 0, minGapMs: 15000, maxHeals: 4, settleMs: 3000 }, ctx || {});
    if (!c.calm) return null;
    if (c.now - c.lastHealAny < c.minGapMs) return null;
    const ok = (tabs || []).filter(t => {
      const heals = t.heals || 0;
      if (heals >= c.maxHeals) return false;
      if (c.now - (t.failedAt || 0) < c.settleMs) return false;
      const gap = HEAL_BACKOFF_MS[Math.min(heals, HEAL_BACKOFF_MS.length - 1)] * (c.backoffScale == null ? 1 : c.backoffScale);
      return c.now - (t.lastHealAt || 0) >= gap;
    });
    ok.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (a.failedAt || 0) - (b.failedAt || 0));
    return ok.length ? ok[0].id : null;
  }

  // Memory pressure: which background tab should be discarded next (pure)?
  // used = physical memory in use, 0..100. tabs: [{ id, active, discarded, audible, lastAccessed, state }], state = { draft, generating }
  // as reported by the page bridge. A tab whose state is unknown is skipped: without it we cannot know about a draft.
  // Returns the tab id that was idle the longest, or null (below the threshold / nothing safe to discard).
  function pickMemoryVictim(used, tabs, cfg) {
    const c = Object.assign({ memDiscard: true, memDiscardPct: 93 }, cfg || {});
    if (c.memDiscard === false || !(used >= c.memDiscardPct)) return null;
    const ok = (tabs || []).filter(t => t.state && canDiscard(t.state, { active: t.active, discarded: t.discarded, audible: t.audible }).ok);
    ok.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
    return ok.length ? ok[0].id : null;
  }

  // Only transient failures are worth retrying (not 404 = deleted conversation, not 403 = no access).
  function isHealableStatus(status) { return status === 429 || status >= 500 || status === 0; }

  return {
    runVerdict, shouldHibernate, healBudgetOk, healPauseMs, restartPick, restartPick,
    GEN: 3, // page-side generation: bump when guard.js/recovery.js/bridge.js change behaviour
    reaperVerdict, REAPER_DEFAULTS,
    shouldAutoStop,
    versionGreater, isCalm, pickHealTarget, isHealableStatus, HEAL_BACKOFF_MS,
    canDiscard, pickMemoryVictim,
    FAMILIES, FAMILY_IDS, WINDOW_MS, DEFAULT_CEIL, MAX_CEIL, CEIL_MIN, PACE_FRACTION,
    RELAX_AFTER_MS, BACKOFFS_MS, HOLD_MAX_MS, TERMINAL_COOLDOWN_MS, RETRY_AFTER_CAP_MS,
    classify, isGuardable, parseRetryAfter, retryBackoffMs, jitter, countIn, capFor,
    paceWaitMs, burstCount, learnCeiling, relaxCeiling, levelOf, worstLevel, isLoop
  };
});
