// 4̅2̅9̅ (Anti-429) page guard — runs in the page (MAIN world) on chatgpt.com at document_start.
//
// What it does (design inspired by ChatGPT Conversation Availability Guard, MIT — see THIRD_PARTY_NOTICES.md):
//  * wraps window.fetch for idempotent GET history/stream/list requests;
//  * ACCOUNT-WIDE pacing: all tabs share one sliding-window ledger (localStorage) behind a
//    navigator.locks mutex, so opening 20 tabs at once cannot stampede the limiter;
//  * on HTTP 429 it does NOT show the error to the page: it sets a shared per-family cooldown from
//    Retry-After (or exponential backoff), keeps the request pending and retries through the same queue;
//  * gives up (returns the 429) only after HOLD_MAX_MS and then keeps a terminal cooldown.
// It never touches POST/stream bodies and never bypasses the limiter — it only spaces requests out.
(() => {
  "use strict";
  if (window.__A429_GUARD__) return;
  const A = window.A429;
  if (!A) return; // shared.js did not load
  window.__A429_GUARD__ = true;

  const NS = "a429:";
  const nativeFetch = window.fetch.bind(window);

  const ls = {
    get(k) { try { return localStorage.getItem(NS + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(NS + k, v); } catch {} },
    del(k) { try { localStorage.removeItem(NS + k); } catch {} }
  };
  const readJSON = (k, d) => { try { const v = ls.get(k); return v ? JSON.parse(v) : d; } catch { return d; } };

  // cfg is mirrored from chrome.storage by bridge.js; tests set it directly.
  const cfg = () => Object.assign(
    { enabled: true, timeScale: 1, windowMs: A.WINDOW_MS, holdMaxMs: A.HOLD_MAX_MS }, readJSON("cfg", {}));
  const off = () => cfg().enabled === false;
  const ceilOf = fam => {
    const c = readJSON("ceil", {});
    const v = Number(c && c[fam]);
    return Number.isFinite(v) && v >= A.CEIL_MIN ? v : A.DEFAULT_CEIL[fam];
  };

  const stats = { holds: 0, r429: 0, recovered: 0, terminal: 0 };
  const STAT_OF = { "hold-start": "holds", "429": "r429", "recovered": "recovered", "terminal": "terminal" };
  const emit = (type, data) => {
    if (STAT_OF[type]) stats[STAT_OF[type]]++;
    try {
      window.dispatchEvent(new CustomEvent("__a429_event__",
        { detail: JSON.stringify(Object.assign({ type, ts: Date.now() }, data || {})) }));
    } catch {}
  };

  const abortError = signal => {
    if (signal && signal.reason) return signal.reason;
    try { return new DOMException("Aborted", "AbortError"); }
    catch { const e = new Error("Aborted"); e.name = "AbortError"; return e; }
  };
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal));
    let timer;
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    timer = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });

  const withLock = (fam, signal, fn) => {
    const locks = typeof navigator !== "undefined" && navigator.locks;
    if (locks && typeof locks.request === "function") {
      const opts = { mode: "exclusive" };
      if (signal) opts.signal = signal;
      return locks.request(NS + fam, opts, async () => fn());
    }
    return Promise.resolve().then(fn);
  };

  const setCdMax = (fam, until) => {
    const cur = Number(ls.get("cd:" + fam)) || 0;
    ls.set("cd:" + fam, String(Math.max(cur, until)));
  };

  // Wait until this request may start. Returns when a slot has been reserved in the shared ledger.
  async function admit(fam, signal, onWait) {
    for (;;) {
      const wait = await withLock(fam, signal, () => {
        const now = Date.now();
        const c = cfg();
        const cd = Number(ls.get("cd:" + fam)) || 0;
        if (cd > now) return cd - now;
        const led = readJSON("led:" + fam, []).filter(t => now - t < c.windowMs * 2);
        const w = A.paceWaitMs(led, now, c.windowMs, A.capFor(ceilOf(fam)));
        if (w > 0) { ls.set("led:" + fam, JSON.stringify(led)); return w; }
        led.push(now);
        ls.set("led:" + fam, JSON.stringify(led));
        return 0;
      });
      if (wait <= 0) return;
      onWait();
      const scale = cfg().timeScale;
      await sleep(A.jitter(wait, 0.1) + Math.floor(Math.random() * 300 * scale), signal);
    }
  }

  async function guarded(input, init, fam, signal) {
    const t0 = Date.now();
    let held = false;
    const onWait = () => { if (!held) { held = true; emit("hold-start", { fam }); } };
    try {
      for (let attempt = 0; ; attempt++) {
        await admit(fam, signal, onWait);
        const resp = await nativeFetch(input, init);
        const c = cfg();
        if (resp.status !== 429) {
          ls.del("fl:" + fam);
          ls.del("cd:" + fam);
          if (attempt > 0) emit("recovered", { fam, attempt, heldMs: Date.now() - t0 });
          return resp;
        }
        // ---- 429 ----
        const ra = A.parseRetryAfter(resp.headers && resp.headers.get && resp.headers.get("retry-after"), Date.now());
        const level = Number(ls.get("fl:" + fam)) || 0;
        ls.set("fl:" + fam, String(level + 1));
        const wait = A.jitter(Math.max(ra, A.retryBackoffMs(level) * c.timeScale), 0.1);
        setCdMax(fam, Date.now() + wait);
        emit("429", { fam, attempt, waitMs: wait, retryAfterMs: ra });
        if (Date.now() - t0 + wait > c.holdMaxMs) {
          setCdMax(fam, Date.now() + A.TERMINAL_COOLDOWN_MS * c.timeScale);
          emit("terminal", { fam });
          return resp; // let the page see the 429 after the hold budget is spent
        }
        onWait();
      }
    } finally {
      if (held) emit("hold-end", { fam });
    }
  }

  const signalOf = (input, init) =>
    (init && init.signal) || (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);

  const reqInfo = (input, init) => {
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = String((init && init.method) || (isReq && input.method) || "GET").toUpperCase();
      const url = new URL(isReq ? input.url : String(input), location.href);
      return url.origin === location.origin ? { method, url } : null;
    } catch { return null; }
  };

  window.fetch = function (input, init) {
    try {
      if (off()) return nativeFetch(input, init);
      const info = reqInfo(input, init);
      if (!info) return nativeFetch(input, init);
      const fam = A.classify(info.method, info.url.pathname);
      if (!fam || !A.isGuardable(info.method, fam)) return nativeFetch(input, init);
      return guarded(input, init, fam, signalOf(input, init));
    } catch {
      return nativeFetch(input, init);
    }
  };

  window.__A429_STATE__ = () => {
    const now = Date.now();
    const out = { stats: Object.assign({}, stats) };
    for (const fam of A.FAMILY_IDS) {
      out[fam] = {
        cooldownMs: Math.max(0, (Number(ls.get("cd:" + fam)) || 0) - now),
        startsInWindow: A.countIn(readJSON("led:" + fam, []), now, cfg().windowMs),
        ceiling: ceilOf(fam), failureLevel: Number(ls.get("fl:" + fam)) || 0
      };
    }
    return out;
  };

  emit("installed", { version: "0.1.0" });
})();
