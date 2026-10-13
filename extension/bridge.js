// 4̅2̅9̅ bridge — isolated-world content script.
// 1) mirrors learned ceilings + config from chrome.storage.local into the page's localStorage
//    (localStorage is shared between worlds), because guard.js (MAIN) cannot call chrome.*;
// 2) relays guard events (hold/429/recovered) to the service worker for the popup and badge.
(() => {
  "use strict";
  if (window.__A429_BRIDGE2__) return;
  window.__A429_BRIDGE2__ = true;

  const NS = "a429:";
  const mirror = items => {
    try {
      if (items.ceilings) localStorage.setItem(NS + "ceil", JSON.stringify(items.ceilings));
      if (items.cfg) localStorage.setItem(NS + "cfg2", JSON.stringify(items.cfg));
      // Previous generations of guard.js/recovery.js (already running in this page, impossible to unwrap) read "cfg":
      // tell them to pass everything straight through; the new guard takes over via "cfg2".
      localStorage.setItem(NS + "cfg", JSON.stringify({ enabled: false, handedOffTo: "cfg2" }));
    } catch {}
  };
  const pull = () => {
    try { chrome.storage.local.get(["ceilings", "cfg"]).then(mirror).catch(() => {}); } catch {}
  };
  pull();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes.ceilings || changes.cfg)) return;
      pull();
    });
  } catch {}

  // Tab state for the tab doctor: is there an unsent draft / a running answer? (never sends the text itself)
  const composerHasDraft = () => {
    const el = document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!el) return false;
    const t = "value" in el && typeof el.value === "string" ? el.value : (el.innerText || el.textContent || "");
    return t.trim().length > 0;
  };
  const isGenerating = () => !!document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop"], button[aria-label*="Останов"]');
  // A tab that is ALREADY showing the error block when the extension (re)starts has no history-failed event to
  // tell us so: look for the block itself, rarely (visible tabs only, every 30 s) and cheaply (text nodes of <main>).
  let lastBannerAt = 0, lastBanner = false;
  const bannerPresent = force => {
    const now = Date.now();
    if (!force && now - lastBannerAt < 30000) return lastBanner;
    if (document.visibilityState === "hidden" && !force) return lastBanner;
    lastBannerAt = now;
    try {
      const root = document.querySelector("main") || document.body;
      if (!root) return (lastBanner = false);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let found = false;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (BANNER.test(n.nodeValue || "")) { found = true; break; } }
      return (lastBanner = found);
    } catch { return (lastBanner = false); }
  };
  let lastState = "";
  const reportState = force => {
    try {
      const st = { draft: composerHasDraft(), generating: isGenerating(), banner: bannerPresent(force) };
      const key = JSON.stringify(st);
      if (!force && key === lastState) return;
      lastState = key;
      chrome.runtime.sendMessage({ type: "a429_tabstate", state: st }).catch(() => {});
    } catch {}
  };
  setInterval(() => reportState(false), 4000);
  document.addEventListener("input", () => reportState(false), true);
  document.addEventListener("visibilitychange", () => reportState(true));
  setTimeout(() => reportState(true), 1500);

  // Auto-heal: click the page's own retry button, but ONLY inside the error block (never the
  // "Try again" of a model answer, which would regenerate it).
  const BANNER = /could not load this (chatgpt )?conversation|unable to load (this )?(chatgpt )?conversation|не удалось загрузить/i;
  const RETRY = /^(try again|retry|повторить|повторите)$/i;
  const healNow = () => {
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!BANNER.test(n.nodeValue || "")) continue;
      for (let el = n.parentElement, depth = 0; el && depth < 5; el = el.parentElement, depth++) {
        const txt = (el.innerText || "").trim();
        if (txt.length > 400) break; // too big: this is the page, not the error block
        const btn = [...el.querySelectorAll('button, [role="button"]')].find(b => RETRY.test((b.textContent || "").trim()));
        if (btn) { btn.click(); return { clicked: true }; }
      }
      return { clicked: false, reason: "no-retry-button" };
    }
    return { clicked: false, reason: "no-banner" };
  };
  // ---- read-only account audit (runs inside the page's own session; the token stays in this closure) ----
  // Lists the user's conversations (main list + every project seen), then asks stream_status for the ones that have
  // been idle long enough. Slow on purpose (250 ms between calls) and stops at the first 429.
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  async function scanAccount(p) {
    const pace = Math.max(0, p.paceMs == null ? 2000 : p.paceMs); // one request per `pace` ms: stay far below the limiters
    const t0 = Date.now();
    const out = { ok: false, items: [], statuses: {}, rate: false, errors: 0, requests: 0, ms: 0 };
    let tok = null;
    try { tok = (await (await fetch("/api/auth/session", { credentials: "include" })).json()).accessToken; } catch {}
    if (!tok) return { ok: false, reason: "no-session" };
    const H = { Authorization: "Bearer " + tok };
    let lastAt = 0;
    const get = async url => {
      // spacing is enforced HERE, before every single request, so no code path can ever burst
      const wait = lastAt + pace - Date.now();
      if (wait > 0) await sleepMs(wait);
      lastAt = Date.now();
      let r;
      out.requests++;
      try { r = await fetch(url, { credentials: "include", headers: H }); } catch { out.errors++; return null; }
      if (r.status === 429) { out.rate = true; return null; }
      if (!r.ok) { out.errors++; return null; }
      return r;
    };
    const seen = new Set();
    const gizmos = new Set(p.projectIds || []);
    const add = (it, g) => {
      if (!it || !it.id || seen.has(it.id)) return;
      seen.add(it.id);
      if (it.gizmo_id) gizmos.add(it.gizmo_id);
      out.items.push({ id: it.id, t: String(it.title || "").slice(0, 40), u: Date.parse(it.update_time) || 0, g: it.gizmo_id || g || null });
    };
    for (let off = 0; off < (p.maxList || 112) && !out.rate; off += 28) {
      const r = await get("/backend-api/conversations?offset=" + off + "&limit=28&order=updated");
      if (!r) break;
      const j = await r.json();
      if (!j.items || !j.items.length) break;
      j.items.forEach(it => add(it, null));
    }
    for (const g of gizmos) {
      if (out.rate) break;
      let cur = "0";
      for (let i = 0; i < (p.projectPages || 4); i++) {
        const r = await get("/backend-api/gizmos/" + g + "/conversations?cursor=" + cur + "&limit=25");
        if (!r) break;
        const j = await r.json();
        (j.items || []).forEach(it => add(it, g));
        if (!j.cursor || !(j.items || []).length) break;
        cur = j.cursor;
        }
    }
    const now = Date.now();
    const skip = p.skip || {};
    const suspects = [], fresh = [];
    for (const it of out.items) {
      if ((p.checkIds || []).includes(it.id)) { suspects.push(it.id); continue; }
      if (skip[it.id] && skip[it.id] === it.u) continue; // already known COMPLETE at this update_time
      if (it.u && now - it.u <= (p.lookbackMs || 14 * 86400000)) fresh.push(it);
    }
    fresh.sort((a, b) => b.u - a.u); // most recently active first: new zombies are caught early, the old backlog drains over time
    const want = suspects.concat(fresh.map(x => x.id));
    for (const id of want.slice(0, p.maxStatus || 20)) {
      if (out.rate) break;
      const r = await get("/backend-api/conversation/" + id + "/stream_status");
      if (!r) continue;
      try { const j = await r.json(); out.statuses[id] = (j && j.status) || null; } catch {}
    }
    out.ok = true;
    out.ms = Date.now() - t0;
    return out;
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "a429_scan" && sender.id === chrome.runtime.id) {
        scanAccount(msg.params || {}).then(sendResponse, () => sendResponse({ ok: false, reason: "scan-error" }));
        return true; // async response
      }
      if (msg && msg.type === "a429_stop" && sender.id === chrome.runtime.id) {
        // The same request the page's own "Stop" button sends. Runs with the user's own session; the access token
        // stays in this local variable (never stored, logged or sent anywhere else).
        (async () => {
          const m = msg.conv ? [null, msg.conv] : location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
          if (!m) return sendResponse({ ok: false, reason: "no-conversation-in-url" });
          try {
            const sess = await (await fetch("/api/auth/session", { credentials: "include" })).json();
            if (!sess || !sess.accessToken) return sendResponse({ ok: false, reason: "no-session" });
            const r = await fetch("/backend-api/stop_conversation", {
              method: "POST", credentials: "include",
              headers: { "content-type": "application/json", Authorization: "Bearer " + sess.accessToken },
              body: JSON.stringify({ conversation_id: m[1] })
            });
            let body = null;
            try { body = await r.json(); } catch {}
            sendResponse({ ok: r.ok, http: r.status, result: body && body.status || null });
          } catch (e) { sendResponse({ ok: false, reason: "network" }); }
        })();
        return true; // async response
      }
      if (msg && msg.type === "a429_markdead" && sender.id === chrome.runtime.id) {
        const m = location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
        if (!m) { sendResponse({ ok: false, reason: "no-conversation-in-url" }); return; }
        try { localStorage.setItem(NS + "dead:" + m[1], String(Date.now() + 20 * 60 * 1000)); } catch {}
        sendResponse({ ok: true });
        return;
      }
      if (msg && msg.type === "a429_undead" && sender.id === chrome.runtime.id) {
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith(NS + "dead:") || k.startsWith(NS + "ex:")) localStorage.removeItem(k);
        } catch {}
        sendResponse({ ok: true });
        return;
      }
      if (!msg || msg.type !== "a429_heal" || sender.id !== chrome.runtime.id) return;
      try { sendResponse(healNow()); } catch (e) { sendResponse({ clicked: false, reason: "error" }); }
    });
  } catch {}

  window.addEventListener("__a429_event__", event => {
    try {
      const ev = JSON.parse(event.detail);
      chrome.runtime.sendMessage({ type: "a429_event", ev }).catch(() => {});
    } catch {}
  });
})();
