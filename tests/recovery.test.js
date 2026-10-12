"use strict";
// Runs the real extension/recovery.js in a vm sandbox with real Request/Response objects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("../extension/shared.js");
const code = fs.readFileSync(path.join(__dirname, "../extension/recovery.js"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeWS {
  constructor() { this.l = []; FakeWS.last = this; }
  addEventListener(t, f) { if (t === "message") this.l.push(f); }
  emit(obj) { this.l.forEach(f => f({ data: JSON.stringify(obj) })); }
}

function makeProfile(cfg) {
  const store = new Map();
  store.set("a429:cfg", JSON.stringify(Object.assign({ enabled: true, recovery: true, timeScale: 0.05 }, cfg || {})));
  const held = new Set();
  const locks = {
    async request(name, opts, fn) {
      if (opts && opts.ifAvailable) {
        if (held.has(name)) return fn(null);
        held.add(name);
        try { return await fn({ name }); } finally { held.delete(name); }
      }
      return fn({ name });
    }
  };
  return { store, locks };
}

function makeTab(profile, fetchImpl) {
  const events = [];
  const skew = { ms: 0 };
  class FD extends Date { static now() { return Date.now.call(Date) + skew.ms; } }
  const realNow = Date.now;
  FD.now = () => realNow() + skew.ms;
  const win = {
    A429: A, fetch: fetchImpl, WebSocket: FakeWS, location: { href: "https://chatgpt.com/", origin: "https://chatgpt.com" },
    localStorage: { getItem: k => (profile.store.has(k) ? profile.store.get(k) : null), setItem: (k, v) => profile.store.set(k, String(v)), removeItem: k => profile.store.delete(k) },
    navigator: { locks: profile.locks },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    dispatchEvent(e) { events.push(JSON.parse(e.detail)); return true; },
    URL, Request, Response, TextDecoder, DOMException, Date: FD, Math, JSON, Promise, Number, String, Object, Array, Map, Set, Symbol, Reflect, Proxy,
    Error, setTimeout, clearTimeout, performance
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return { win, events, skew, fetch: (u, i) => win.window.fetch(u, i) };
}

const SSE = body => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const GOOD_SSE = 'data: {"type":"resume_conversation_token","token":"x"}\n\ndata: {"v":{"message":{"author":{"role":"assistant"}}}}\n\n';
const STATUS = "/backend-api/conversation/c1/stream_status";
const RESUME = "/backend-api/f/conversation/resume";
const resumeInit = offset => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation_id: "c1", offset }) });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// A programmable backend: statusBody for stream_status; resumeHandler(offset, n) for POST resume.
function backend({ statusBody = { status: "IS_STREAMING" }, resumeHandler }) {
  const calls = { resume: [], status: 0 };
  const impl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), "https://chatgpt.com"), init);
    const u = new URL(req.url);
    if (u.pathname === STATUS) { calls.status++; return json(statusBody); }
    if (u.pathname === RESUME) {
      const body = JSON.parse(await req.text());
      calls.resume.push(body.offset);
      return resumeHandler(body.offset, calls.resume.length);
    }
    return json({ ok: true });
  };
  return { impl, calls };
}

test("recovers: resume 404 while streaming -> retried with another offset -> page gets the stream", async () => {
  const b = backend({ resumeHandler: (off, n) => (n === 1 ? new Response("", { status: 404 }) : SSE(GOOD_SSE)) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS);
  await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /event-stream/);
  assert.deepEqual(b.calls.resume, [5, 0]);
  assert.ok(tab.events.some(e => e.type === "resume-recovery-success"));
});

test("no recent streaming evidence -> the 404 is left alone", async () => {
  const b = backend({ statusBody: { status: "NOT_STREAMING" }, resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5]);
  assert.ok(tab.events.some(e => e.type === "resume-recovery-skipped" && e.reason === "no-recent-streaming"));
});

test("no stream_status seen at all -> no recovery", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile(), b.impl);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5]);
});

test("stale streaming evidence (>30 s old) -> skipped", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  tab.skew.ms = 45000;
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5]);
  assert.ok(tab.events.some(e => e.reason === "stale-streaming-evidence"));
});

test("WebSocket turn-complete during the grace period suppresses recovery (natural recovery wins)", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile({ timeScale: 0.5 }), b.impl);
  new tab.win.WebSocket("wss://x");
  await tab.fetch(STATUS); await sleep(20);
  const p = tab.fetch(RESUME, resumeInit(5));
  await sleep(100);
  FakeWS.last.emit({ type: "message", topic_id: "conversations", payload: { type: "conversation-turn-complete", payload: { conversation_id: "c1" } } });
  const r = await p;
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5], "must not re-send resume");
  assert.ok(tab.events.some(e => e.type === "resume-recovery-suppressed"));
});

test("bounded: every candidate offset 404 -> at most 2 retries, original 404 returned", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5, 0, 1, 2]);
  const b2 = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab2 = makeTab(makeProfile(), b2.impl);
  await tab2.fetch(STATUS); await sleep(20);
  await tab2.fetch(RESUME, resumeInit(0));
  assert.deepEqual(b2.calls.resume, [0, 1, 2], "original offset excluded from candidates");
  assert.ok(tab2.events.some(e => e.type === "resume-recovery-exhausted"));
});

test("a non-stream or empty 'success' is NOT handed to the page", async () => {
  const b = backend({ resumeHandler: (o, n) => (n === 1 ? new Response("", { status: 404 }) : json({ not: "a stream" })) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  const b2 = backend({ resumeHandler: (o, n) => (n === 1 ? new Response("", { status: 404 }) : SSE("")) });
  const tab2 = makeTab(makeProfile(), b2.impl);
  await tab2.fetch(STATUS); await sleep(20);
  const r2 = await tab2.fetch(RESUME, resumeInit(5));
  assert.equal(r2.status, 404);
  assert.ok(tab2.events.some(e => e.type === "resume-recovery-stopped"));
});

test("an event-stream carrying only an error is rejected", async () => {
  const b = backend({ resumeHandler: (o, n) => (n === 1 ? new Response("", { status: 404 }) : SSE('data: {"error_code":"conversation_not_found"}\n\n')) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
});

test("concurrent resumes for the same conversation: only one recovers", async () => {
  const b = backend({ resumeHandler: (o, n) => (o === 5 || o === 6 ? new Response("", { status: 404 }) : SSE(GOOD_SSE)) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const [r1, r2] = await Promise.all([tab.fetch(RESUME, resumeInit(5)), tab.fetch(RESUME, resumeInit(6))]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 404]);
  assert.ok(tab.events.some(e => e.reason === "concurrent"));
});

test("cross-tab: another tab already recovering holds the lock -> this tab skips", async () => {
  const profile = makeProfile();
  const b = backend({ resumeHandler: (o, n) => (o === 5 ? new Response("", { status: 404 }) : SSE(GOOD_SSE)) });
  const a = makeTab(profile, b.impl), c = makeTab(profile, b.impl);
  await a.fetch(STATUS); await c.fetch(STATUS); await sleep(20);
  const pa = a.fetch(RESUME, resumeInit(5));
  await sleep(5);
  const rc = await c.fetch(RESUME, resumeInit(5));
  const ra = await pa;
  assert.equal(ra.status, 200);
  assert.equal(rc.status, 404);
  assert.ok(c.events.some(e => e.reason === "cross-tab"));
});

test("recovery disabled by cfg -> pure pass-through", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile({ recovery: false }), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const r = await tab.fetch(RESUME, resumeInit(5));
  assert.equal(r.status, 404);
  assert.deepEqual(b.calls.resume, [5]);
});

test("a normal successful resume is untouched", async () => {
  const b = backend({ resumeHandler: () => SSE(GOOD_SSE) });
  const tab = makeTab(makeProfile(), b.impl);
  await tab.fetch(STATUS);
  const r = await tab.fetch(RESUME, resumeInit(3));
  assert.equal(r.status, 200);
  assert.deepEqual(b.calls.resume, [3]);
});

test("abort during the grace wait rejects and leaves no recovery in flight", async () => {
  const b = backend({ resumeHandler: () => new Response("", { status: 404 }) });
  const tab = makeTab(makeProfile({ timeScale: 1 }), b.impl);
  await tab.fetch(STATUS); await sleep(20);
  const ac = new AbortController();
  const p = tab.fetch(RESUME, Object.assign(resumeInit(5), { signal: ac.signal }));
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p, e => e.name === "AbortError");
  assert.equal(tab.win.window.__A429_RECOVERY_STATE__().inFlight, 0);
});
