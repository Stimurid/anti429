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
  store.set("a429:cfg", JSON.stringify(Object.assign({ enabled: true, timeScale: 0.001, windowMs: 200, holdMaxMs: 5000 }, cfg || {})));
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

function makeTab(profile, fetchImpl) {
  const events = [];
  const win = {
    A429: A, fetch: fetchImpl, location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
    localStorage: {
      getItem: k => (profile.store.has(k) ? profile.store.get(k) : null),
      setItem: (k, v) => profile.store.set(k, String(v)),
      removeItem: k => profile.store.delete(k)
    },
    navigator: { locks: profile.locks },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    dispatchEvent(e) { events.push(JSON.parse(e.detail)); return true; },
    URL, Request, DOMException, Date, Math, JSON, Promise, Number, String, Object, Array, Map, Error, setTimeout, clearTimeout
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return { win, events, fetch: (u, i) => win.window.fetch(u, i) };
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
