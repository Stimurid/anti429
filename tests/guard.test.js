"use strict";
// Runs the real extension/guard.js inside a vm sandbox with a fake page (localStorage, navigator.locks, fetch).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("../extension/shared.js");
const code = fs.readFileSync(path.join(__dirname, "../extension/guard.js"), "utf8");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One shared "browser profile": localStorage + Web Locks are shared by all tabs of the origin.
function makeProfile(cfg) {
  const store = new Map();
  store.set("a429:cfg3", JSON.stringify(Object.assign({ enabled: true, timeScale: 0.001, windowMs: 200, holdMaxMs: 5000 }, cfg || {})));
  const chains = new Map();
  const locks = {
    request(name, opts, fn) {
      const prev = chains.get(name) || Promise.resolve();
      const run = prev.then(() => fn());
      chains.set(name, run.catch(() => {}));
      return run;
    }
  };
  return { store, locks };
}

function makeTab(profile, fetchImpl, preload) {
  const events = [];
  const win = {
    A429: A, fetch: fetchImpl, location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
    localStorage: {
      getItem: k => (profile.store.has(k) ? profile.store.get(k) : null),
      setItem: (k, v) => profile.store.set(k, String(v)),
      removeItem: k => profile.store.delete(k)
    },
    navigator: { locks: profile.locks },
    document: {
      visibilityState: "visible", _l: [],
      addEventListener(t, f) { if (t === "visibilitychange") this._l.push(f); },
      removeEventListener(t, f) { this._l = this._l.filter(x => x !== f); }
    },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    dispatchEvent(e) { events.push(JSON.parse(e.detail)); return true; },
    URL, Request, DOMException, Date, Math, JSON, Promise, Number, String, Object, Array, Map, Error, setTimeout, clearTimeout
  };
  win.window = win;
  vm.createContext(win);
  for (const src of preload || []) vm.runInContext(src, win); // an OLDER generation that is already running in the page
  vm.runInContext(code, win);
  const setVisible = v => { win.document.visibilityState = v ? "visible" : "hidden"; win.document._l.slice().forEach(f => f()); };
  return { win, events, setVisible, fetch: (u, i) => win.window.fetch(u, i) };
}

const DETAIL = "/backend-api/conversations/aaaa-bbbb";

test("non-guarded requests pass straight through", async () => {
  const calls = [];
  const tab = makeTab(makeProfile(), async (u, i) => { calls.push([String(u), i && i.method]); return { status: 200, headers: new Map() }; });
  await tab.fetch("/backend-api/models");
  await tab.fetch("/backend-api/f/conversation/resume", { method: "POST" });
  await tab.fetch("https://example.com/backend-api/conversations/x");
  assert.equal(calls.length, 3);
});

test("429 is held and retried; the page never sees it", async () => {
  let n = 0;
  const tab = makeTab(makeProfile(), async () => (++n <= 2
    ? { status: 429, headers: new Map([["retry-after", "0"]]) }
    : { status: 200, headers: new Map() }));
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 200);
  assert.equal(n, 3);
  const types = tab.events.map(e => e.type);
  assert.ok(types.includes("hold-start") && types.includes("429") && types.includes("recovered") && types.includes("hold-end"));
});

test("pacing: a burst of 9 requests never exceeds the cap inside the window", async () => {
  const profile = makeProfile({ windowMs: 200 });
  profile.store.set("a429:ceil", JSON.stringify({ detail: 4 })); // cap = floor(4*0.75) = 3
  const starts = [];
  const tab = makeTab(profile, async () => { starts.push(Date.now()); return { status: 200, headers: new Map() }; });
  const rs = await Promise.all(Array.from({ length: 9 }, () => tab.fetch(DETAIL)));
  assert.ok(rs.every(r => r.status === 200));
  starts.sort((a, b) => a - b);
  for (let i = 0; i + 3 < starts.length; i++) {
    assert.ok(starts[i + 3] - starts[i] >= 190, `4 starts within ${starts[i + 3] - starts[i]}ms`);
  }
});

test("two tabs share ONE ledger (account-wide pacing)", async () => {
  const profile = makeProfile({ windowMs: 200 });
  profile.store.set("a429:ceil", JSON.stringify({ detail: 4 }));
  const starts = [];
  const f = async () => { starts.push(Date.now()); return { status: 200, headers: new Map() }; };
  const a = makeTab(profile, f), b = makeTab(profile, f);
  await Promise.all([
    ...Array.from({ length: 6 }, () => a.fetch(DETAIL)),
    ...Array.from({ length: 6 }, () => b.fetch(DETAIL))
  ]);
  starts.sort((x, y) => x - y);
  assert.equal(starts.length, 12);
  for (let i = 0; i + 3 < starts.length; i++) assert.ok(starts[i + 3] - starts[i] >= 190);
});

test("cooldown set by tab A blocks tab B for the Retry-After period", async () => {
  const profile = makeProfile({ windowMs: 100 });
  let aFirst = true;
  const tStart = Date.now();
  const bStarts = [];
  const a = makeTab(profile, async () => {
    if (aFirst) { aFirst = false; return { status: 429, headers: new Map([["retry-after", "0.4"]]) }; }
    return { status: 200, headers: new Map() };
  });
  const b = makeTab(profile, async () => { bStarts.push(Date.now()); return { status: 200, headers: new Map() }; });
  const pa = a.fetch(DETAIL);          // gets 429 -> sets shared cooldown ~400ms
  await sleep(30);
  const rb = await b.fetch("/backend-api/conversations/zzzz");  // other conversation, same family
  await pa;
  assert.equal(rb.status, 200);
  assert.ok(bStarts[0] - tStart >= 350, `B started after only ${bStarts[0] - tStart}ms`);
});

test("hold budget exhausted: the 429 is finally returned and a terminal cooldown is set", async () => {
  const tab = makeTab(makeProfile({ holdMaxMs: 60 }), async () => ({ status: 429, headers: new Map([["retry-after", "0.05"]]) }));
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 429);
  assert.ok(tab.events.some(e => e.type === "terminal"));
  assert.ok(tab.win.window.__A429_STATE__().detail.cooldownMs > 0);
});

test("kill switch (cfg.enabled=false) bypasses everything", async () => {
  let n = 0;
  const tab = makeTab(makeProfile({ enabled: false }), async () => { n++; return { status: 429, headers: new Map() }; });
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 429);
  assert.equal(n, 1);
});

test("abort while held rejects with AbortError and leaves no hold open", async () => {
  const profile = makeProfile({ windowMs: 100 });
  profile.store.set("a429:cd:detail", String(Date.now() + 10000));
  const tab = makeTab(profile, async () => ({ status: 200, headers: new Map() }));
  const ac = new AbortController();
  const p = tab.fetch(DETAIL, { signal: ac.signal });
  setTimeout(() => ac.abort(), 60);
  await assert.rejects(p, e => e.name === "AbortError");
  const types = tab.events.map(e => e.type);
  assert.equal(types.filter(t => t === "hold-start").length, types.filter(t => t === "hold-end").length);
});

test("success clears the failure level and cooldown", async () => {
  const profile = makeProfile();
  let n = 0;
  const tab = makeTab(profile, async () => (++n === 1 ? { status: 429, headers: new Map([["retry-after", "0"]]) } : { status: 200, headers: new Map() }));
  await tab.fetch(DETAIL);
  assert.equal(profile.store.get("a429:fl:detail"), undefined);
  assert.equal(profile.store.get("a429:cd:detail"), undefined);
});

test("v0.4: a hidden tab does NOT load history until it becomes visible", async () => {
  const profile = makeProfile();
  let sent = 0;
  const tab = makeTab(profile, async () => { sent++; return { status: 200, headers: new Map() }; });
  tab.setVisible(false);
  const p = tab.fetch(DETAIL);
  await sleep(150);
  assert.equal(sent, 0, "hidden tab must not hit the server");
  tab.setVisible(true);
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(sent, 1);
});

test("v0.4: a hidden tab still makes non-history requests (stream/list) normally", async () => {
  let sent = 0;
  const tab = makeTab(makeProfile(), async () => { sent++; return { status: 200, headers: new Map() }; });
  tab.setVisible(false);
  await tab.fetch("/backend-api/conversations?offset=0&limit=28");
  assert.equal(sent, 1);
});

test("v0.4: Retry-After is honored as-is (not stretched by our own backoff)", async () => {
  let n = 0;
  const tab = makeTab(makeProfile({ timeScale: 1, windowMs: 100 }), async () => (++n === 1
    ? { status: 429, headers: new Map([["retry-after", "0.2"]]) }
    : { status: 200, headers: new Map() }));
  const t0 = Date.now();
  const r = await tab.fetch(DETAIL);
  const dt = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(dt < 1500, "waited " + dt + "ms; the old max(retry-after, 2s backoff) would be >= 2000ms");
});

test("v0.4: many simultaneous 429s escalate the shared failure level ONCE per episode", async () => {
  const profile = makeProfile({ timeScale: 0.2, windowMs: 100 }); // episode window = 4000ms * 0.2 = 800ms
  profile.store.set("a429:ceil", JSON.stringify({ detail: 12 }));
  let calls = 0;
  const f = async () => (++calls <= 6 ? { status: 429, headers: new Map([["retry-after", "0.05"]]) } : { status: 200, headers: new Map() });
  const a = makeTab(profile, f), b = makeTab(profile, f);
  let maxLevel = 0;
  const watcher = setInterval(() => { maxLevel = Math.max(maxLevel, Number(profile.store.get("a429:fl:detail")) || 0); }, 2);
  await Promise.all([...Array.from({ length: 4 }, () => a.fetch(DETAIL)), ...Array.from({ length: 4 }, () => b.fetch(DETAIL))]);
  clearInterval(watcher);
  assert.ok(maxLevel <= 2, "failure level reached " + maxLevel + " (was ~6 before coalescing)");
});

test("v0.4: after a 429 episode only ONE probe is in flight until it succeeds", async () => {
  const profile = makeProfile({ timeScale: 0.01, windowMs: 100 });
  profile.store.set("a429:ceil", JSON.stringify({ detail: 12 }));
  const log = []; // {start,end,status}
  let calls = 0;
  const f = async () => {
    const n = ++calls;
    const rec = { start: Date.now(), n };
    log.push(rec);
    await sleep(40);
    rec.end = Date.now();
    rec.status = n <= 3 ? 429 : 200;
    return n <= 3 ? { status: 429, headers: new Map([["retry-after", "0.05"]]) } : { status: 200, headers: new Map() };
  };
  const a = makeTab(profile, f), b = makeTab(profile, f);
  await Promise.all([...Array.from({ length: 3 }, () => a.fetch(DETAIL)), ...Array.from({ length: 3 }, () => b.fetch(DETAIL))]);
  const probe = log.filter(r => r.status === 200).sort((x, y) => x.start - y.start)[0];
  assert.ok(probe, "some request must succeed");
  const overlapping = log.filter(r => r !== probe && r.start > log.find(x => x.n === 3).end - 1 && r.start < probe.end && r.start >= probe.start - 0 && r.n > 3);
  assert.equal(overlapping.length, 0, "other requests started while the probe was in flight: " + overlapping.length);
});

test("v0.4: a foreground tab is not starved: it proceeds while a hidden tab's history waits", async () => {
  const profile = makeProfile();
  const sentBy = [];
  const bg = makeTab(profile, async () => { sentBy.push("bg"); return { status: 200, headers: new Map() }; });
  const fgTab = makeTab(profile, async () => { sentBy.push("fg"); return { status: 200, headers: new Map() }; });
  bg.setVisible(false);
  const pb = bg.fetch(DETAIL);
  const rf = await fgTab.fetch("/backend-api/conversations/zzzz");
  assert.equal(rf.status, 200);
  assert.deepEqual(sentBy, ["fg"]);
  bg.setVisible(true);
  await pb;
  assert.deepEqual(sentBy, ["fg", "bg"]);
});

test("upgrade hand-off: an older guard already wrapping fetch is switched to pass-through, the new guard still protects", async () => {
  const profile = makeProfile();
  // what the new bridge writes for previous generations (they read a429:cfg)
  profile.store.set("a429:cfg", JSON.stringify({ enabled: false, handedOffTo: "cfg2" }));
  let native = 0, oldIntercepts = 0;
  const nativeFetch = async () => { native++; return { status: 200, headers: new Map() }; };
  const oldWrapper = function (i, n) {
    const c = JSON.parse(profile.store.get("a429:cfg") || "{}");
    if (c.enabled === false) return nativeFetch(i, n);
    oldIntercepts++;
    return nativeFetch(i, n);
  };
  const tab = makeTab(profile, oldWrapper); // the new guard installs on top of the old wrapper
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 200);
  assert.equal(native, 1);
  assert.equal(oldIntercepts, 0, "the old generation must not act any more");
  assert.ok(profile.store.get("a429:led:detail"), "the new guard reserved a slot in the shared ledger");
  assert.equal(tab.win.window.__A429_GUARD2__, true);
});

test("generation hand-off: the REAL gen-2 guard (0.4.2 file) already in the page is switched to pass-through; gen 3 takes over", async () => {
  const old = fs.readFileSync(path.join(__dirname, "fixtures/guard-gen2-0.4.2.js"), "utf8");
  const profile = makeProfile();
  // exactly what the new bridge writes for previous generations
  profile.store.set("a429:cfg", JSON.stringify({ enabled: false, handedOffTo: "cfg3" }));
  profile.store.set("a429:cfg2", JSON.stringify({ enabled: false, recovery: false, deadStream: false, handedOffTo: "cfg3" }));
  let native = 0;
  const tab = makeTab(profile, async () => { native++; return { status: 200, ok: true, headers: new Map() }; }, [old]);
  assert.equal(tab.win.window.__A429_GUARD2__, true, "the old generation really is installed first");
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 200);
  assert.equal(native, 1, "exactly one network request: the old wrapper only passes through");
  const led = JSON.parse(profile.store.get("a429:led:detail") || "[]");
  assert.equal(led.length, 1, "only the NEW guard reserved a slot (a still-active old guard would have booked two)");
  assert.equal(tab.win.window.__A429_GEN__, A.GEN);
});

test("generation protocol: a NEWER generation disposes the previous one cleanly (no stacked wrappers)", async () => {
  const profile = makeProfile();
  let native = 0;
  const tab = makeTab(profile, async () => { native++; return { status: 200, ok: true, headers: new Map() }; });
  assert.equal(tab.win.window.__A429_GEN__, A.GEN);
  tab.win.A429 = Object.assign({}, A, { GEN: A.GEN + 1 });   // pretend the next generation ships
  vm.runInContext(code, tab.win);
  assert.equal(tab.win.window.__A429_GEN__, A.GEN + 1, "the newer generation is installed");
  const r = await tab.fetch(DETAIL);
  assert.equal(r.status, 200);
  assert.equal(native, 1);
  assert.equal(JSON.parse(profile.store.get("a429:led:detail") || "[]").length, 1, "one slot: the old guard was removed, not stacked");
});

test("generation protocol: the same generation never installs twice", async () => {
  const profile = makeProfile();
  let native = 0;
  const tab = makeTab(profile, async () => { native++; return { status: 200, ok: true, headers: new Map() }; });
  vm.runInContext(code, tab.win); // injected again (e.g. protectOpenTabs on a tab that already has it)
  await tab.fetch(DETAIL);
  assert.equal(JSON.parse(profile.store.get("a429:led:detail") || "[]").length, 1);
  assert.equal(native, 1);
});
