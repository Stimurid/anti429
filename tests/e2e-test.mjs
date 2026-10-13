// End-to-end: isolated Chrome (temp profile) + the real extension + a local HTTPS mock that impersonates chatgpt.com
// (host-resolver-rules maps chatgpt.com -> 127.0.0.1). Exercises content scripts, webRequest metering, learning,
// traffic light/badge, loop detection, discard and paced session restore.
// Usage: node tests/e2e-test.mjs
import { spawn, execFileSync } from "node:child_process";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "../extension");
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MOCK = 18443, DEBUG = 19334;
const WINDOW = 3000, MAX_DETAIL = 3, MAX_STREAM = 8; // real limit (3) is BELOW the assumed ceiling (4): the extension must learn it
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- cert for chatgpt.com ----------
const key = path.join(outDir, "mock.key"), crt = path.join(outDir, "mock.crt");
if (!fs.existsSync(crt)) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2",
    "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
}

// ---------- mock chatgpt.com ----------
const PAGE = `<!doctype html><title>chat</title><body>mock<script>
const id=location.pathname.split('/').pop(), q=new URLSearchParams(location.search);
fetch('/backend-api/conversations/'+id).then(r=>{document.title='status '+r.status}).catch(()=>{});
if(q.get('poll')) setInterval(()=>{fetch('/backend-api/conversation/'+id+'/stream_status').catch(()=>{});fetch('/backend-api/conversations/'+id).catch(()=>{})},1500);
if(q.get('draft')) document.body.insertAdjacentHTML('beforeend','<div id="prompt-textarea" contenteditable="true">unsent draft text</div>');
if(q.get('resume')) (async()=>{
  await fetch('/backend-api/conversation/'+id+'/stream_status').then(r=>r.json());
  const r=await fetch('/backend-api/f/conversation/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversation_id:id,offset:5})});
  document.title='resume '+r.status+' '+(r.headers.get('content-type')||'');
})();
if(q.get('burst')) Promise.all(Array.from({length:10},(_,i)=>fetch('/backend-api/conversations/b'+i).then(r=>r.status))).then(s=>{document.title='burst '+s.join(',')});
</script>`;
let lim;
const reset = () => (lim = { detail: { starts: [], pen: 0, rej: [] }, stream: { starts: [], pen: 0, rej: [] }, stats: { ok: 0, r429: 0 } });
reset();
function limited(kind, max, now, res) {
  const L = lim[kind];
  L.starts = L.starts.filter(t => now - t < WINDOW);
  if (now < L.pen || L.starts.length >= max) {
    L.rej.push(now); lim.stats.r429++;
    const pen = Math.min(2 + L.rej.filter(t => now - t < 30000).length * 0.5, 8);
    L.pen = Math.max(L.pen, now + pen * 1000);
    res.statusCode = 429; res.setHeader("retry-after", String(Math.ceil((L.pen - now) / 1000)));
    res.end('{"detail":"Too many requests"}');
    return true;
  }
  L.starts.push(now); lim.stats.ok++;
  return false;
}
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
  const now = Date.now();
  const u = new URL(req.url, "https://chatgpt.com");
  if (u.pathname.startsWith("/c/")) { res.setHeader("content-type", "text/html"); return res.end(PAGE); }
  if (u.pathname === "/__reset") { reset(); return res.end("ok"); }
  if (/^\/backend-api\/conversations\/[^/]+$/.test(u.pathname)) {
    if (limited("detail", MAX_DETAIL, now, res)) return;
    return setTimeout(() => { res.setHeader("content-type", "application/json"); res.setHeader("content-length", "20"); res.end('{"ok":true,"pad":"xx"}'); }, 30);
  }
  if (/^\/backend-api\/conversation\/[^/]+\/stream_status$/.test(u.pathname)) {
    if (limited("stream", MAX_STREAM, now, res)) return;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ status: u.pathname.includes("/resume") ? "IS_STREAMING" : "IS_STREAMING" }));
  }
  if (u.pathname === "/backend-api/f/conversation/resume" && req.method === "POST") {
    let raw = ""; req.on("data", c => (raw += c));
    return req.on("end", () => {
      let off = -1; try { off = JSON.parse(raw).offset; } catch {}
      lim.resumeCalls = (lim.resumeCalls || []).concat(off);
      if (off !== 0) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"type":"resume_conversation_token","token":"t"}\n\ndata: {"v":{"message":{"author":{"role":"assistant"}}}}\n\n');
    });
  }
  res.statusCode = 404; res.end();
});
await new Promise(r => server.listen(MOCK, "127.0.0.1", r));

// ---------- CDP ----------
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0; const pend = new Map(); const ls = [];
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else ls.forEach(l => l(m)); });
  return {
    on: l => ls.push(l), close: () => ws.close(),
    send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); })
  };
}
const ev = async (c, expr) => {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("exception: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const dbg = async (p, method = "GET") => { const t = await (await fetch(`http://127.0.0.1:${DEBUG}${p}`, { method })).text(); try { return JSON.parse(t); } catch { return t; } };

const resetMock = () => new Promise(res => {
  const r = https.request({ host: "127.0.0.1", port: MOCK, path: "/__reset", rejectUnauthorized: false, servername: "chatgpt.com" }, x => { x.resume(); x.on("end", res); });
  r.on("error", res); r.end();
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "a429-e2e-"));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, "--remote-allow-origins=*",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch",
  `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${MOCK}`, "--ignore-certificate-errors", "--test-type",
  "--no-first-run", "--no-default-browser-check", "about:blank"
], { stdio: "ignore" });

const R = { checks: [] };
const check = (name, pass, detail) => { R.checks.push({ name, pass: !!pass, detail }); console.log((pass ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); };
let fatal = null;
try {
  for (let i = 0; i < 40; i++) { try { await dbg("/json/version"); break; } catch { await sleep(500); } }
  const ver = await dbg("/json/version");
  const preTab = await dbg(`/json/new?${encodeURIComponent("https://chatgpt.com/c/pre1")}`, "PUT");
  await sleep(1500);
  const bc = await cdp(ver.webSocketDebuggerUrl);
  const { id: extId } = await bc.send("Extensions.loadUnpacked", { path: extDir });
  bc.close();
  await sleep(2000);

  // control console = the popup page (extension origin, has chrome.*)
  const pt = await dbg(`/json/new?${encodeURIComponent(`chrome-extension://${extId}/popup.html`)}`, "PUT");
  const pop = await cdp(pt.webSocketDebuggerUrl);
  await pop.send("Runtime.enable");
  const call = msg => ev(pop, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  const snap = () => call({ type: "snapshot" });
  const openTab = async url => (await dbg(`/json/new?${encodeURIComponent(url)}`, "PUT"));
  const tabsList = () => ev(pop, `chrome.tabs.query({url:'https://chatgpt.com/*'}).then(t=>t.map(x=>({id:x.id,url:x.url,discarded:x.discarded,title:x.title})))`);

  // 0) the tab that was open before installation gets guard + bridge injected (no F5 needed)
  await sleep(4500);
  let s0 = await snap();
  const tl0 = await tabsList();
  const preId = tl0.find(t => t.url.includes("pre1"));
  check("tab opened BEFORE install was protected by injection (no reload)", preId && s0.tabs[preId.id] && s0.tabs[preId.id].guard === true, preId && s0.tabs[preId.id]);
  await dbg(`/json/close/${preTab.id}`);

  // 1) learning: guard OFF, burst of 10 against a limiter that allows only 3 per 3 s (assumed ceiling is 4)
  await call({ type: "setCfg", patch: { enabled: false } });
  const warm = await openTab("https://chatgpt.com/c/warm"); // bridge mirrors cfg into the origin's localStorage on load
  await sleep(2000);
  await dbg(`/json/close/${warm.id}`);
  await sleep(1500);
  await resetMock();
  const bt = await openTab("https://chatgpt.com/c/burst1?burst=1");
  await sleep(3500);
  let s = await snap();
  const det = s.fams.find(f => f.id === "detail");
  check("burst without guard produced real 429s that the extension observed", det.c429_10m >= 1, { c429_10m: det.c429_10m });
  check("extension LEARNED the real ceiling (3) instead of the assumed 4", det.learned && det.ceil === 3, { ceil: det.ceil, learned: det.learned, ep: det.ep });
  check("traffic light is red during the cooldown", det.cooling && s.overall === "red", { overall: s.overall, cooldownMs: det.cooldownMs });
  const badge = await ev(pop, "chrome.action.getBadgeText({})");
  check("badge shows seconds of block (e.g. '7s')", /^\d+s$/.test(badge), { badge });
  const learnedCeil = det.ceil;
  await dbg(`/json/close/${bt.id}`); // close the burst tab

  // 2) guard ON: poll-loop tab + two quiet tabs
  await call({ type: "setCfg", patch: { enabled: true } });
  await call({ type: "resetLearned" });
  await ev(pop, "chrome.storage.local.set({ceilings:{detail:3,legacy:3,stream:6,list:6}})");
  await resetMock();
  await sleep(10000); // let any cooldown/penalty from step 1 expire
  const loopTab = await openTab("https://chatgpt.com/c/loop1?poll=1");
  const q1 = await openTab("https://chatgpt.com/c/quiet1");
  const q2 = await openTab("https://chatgpt.com/c/quiet2");
  await sleep(16000);
  s = await snap();
  const tl = await tabsList();
  const idOf = frag => tl.find(t => t.url.includes(frag)).id;
  const loopStats = s.tabs[idOf("loop1")];
  check("polling tab is flagged as a loop", loopStats && loopStats.loop, loopStats);
  check("quiet tabs are NOT flagged", !(s.tabs[idOf("quiet1")] || {}).loop && !(s.tabs[idOf("quiet2")] || {}).loop);
  const surfaced = await ev(pop, "0"); // placeholder to keep structure simple
  const st2 = { ok: lim.stats.ok, r429: lim.stats.r429 };
  check("with guard ON the mock saw (almost) no 429s from the poller + quiet tabs", st2.r429 <= 2, st2);
  const badge2 = await ev(pop, "chrome.action.getBadgeText({})");
  check("badge shows a percentage while traffic flows", /^\d+s?$/.test(badge2) && badge2 !== "", { badge2 });

  // 3) discard the loop tab: content dropped, tab stays
  const d = await call({ type: "discard", ids: [idOf("loop1")] });
  await sleep(800);
  const after = (await tabsList()).find(t => t.url.includes("loop1"));
  check("discard keeps the tab but unloads it", d.discarded.length === 1 && after && after.discarded === true, { discarded: d.discarded, tabDiscarded: after && after.discarded });

  // 3b) draft protection + resume recovery
  const draftTab = await openTab("https://chatgpt.com/c/draft1?draft=1");
  const plainTab = await openTab("https://chatgpt.com/c/plain1");
  const resumeTab = await openTab("https://chatgpt.com/c/resume1?resume=1");
  const frontTab = await openTab("https://chatgpt.com/c/front1");
  await sleep(7000);
  s = await snap();
  const tl2 = await tabsList();
  const byFrag = frag => tl2.find(t => t.url.includes(frag));
  check("unsent draft is detected by the bridge", s.tabs[byFrag("draft1").id] && s.tabs[byFrag("draft1").id].draft === true, s.tabs[byFrag("draft1").id]);
  const res2 = await call({ type: "discard", ids: [byFrag("draft1").id, byFrag("plain1").id] });
  const draftSkipped = (res2.skipped || []).some(x => x.id === byFrag("draft1").id && x.reason === "draft");
  const plainDone = res2.discarded.includes(byFrag("plain1").id);
  check("bulk discard SKIPS the tab with a draft but discards the plain one", draftSkipped && plainDone, res2);
  const forced = await call({ type: "discard", ids: [byFrag("draft1").id], force: true });
  check("explicit force discards even a draft tab", forced.discarded.includes(byFrag("draft1").id), forced);
  const rt = (await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(t=>t.map(x=>({id:x.id,url:x.url,title:x.title})))")).find(t => t.url.includes("resume1"));
  s = await snap();
  check("resume-404 was recovered: the page received 200 event-stream", rt && /^resume 200 text\/event-stream/.test(rt.title), rt && rt.title);
  check("recovery counted for that tab", rt && s.tabs[rt.id] && s.tabs[rt.id].recovered >= 1, rt && s.tabs[rt.id]);

  // 4) save session, close chat tabs, paced restore (gap 3 s -> at least ~3 s between tabs)
  const sess = await call({ type: "saveSession", name: "e2e" });
  check("session saved with all chat tabs", sess.tabs.length >= 3, { tabs: sess.tabs.length });
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await sleep(800);
  check("all chat tabs closed", (await tabsList()).length === 0);
  await call({ type: "setCfg", patch: { restoreGapSec: 3 } });
  await call({ type: "restore", id: sess.id, gapSec: 3 });
  const seen = [];
  const t0 = Date.now();
  for (let i = 0; i < 70; i++) {
    const n = (await tabsList()).length;
    if (!seen.length || seen[seen.length - 1].n !== n) seen.push({ n, t: Math.round((Date.now() - t0) / 100) / 10 });
    if (n >= sess.tabs.length) break;
    await sleep(500);
  }
  const steps = seen.filter(x => x.n > 0);
  check("tabs were restored one by one, not all at once", steps.length >= 3 && steps[steps.length - 1].n === sess.tabs.length, seen);
  // 5) after an extension reload the worker forgets which tabs run the guard while the page-side guards keep
  //    running. 'forgetGuards' reproduces exactly that memory loss; the probe must re-learn it from the pages.
  const rl = await openTab("https://chatgpt.com/c/reloadtest");
  await sleep(3500);
  check("guard attached to a fresh tab", ((await snap()).tabs[(await tabsList()).find(t => t.url.includes("reloadtest")).id] || {}).guard === true);
  await call({ type: "forgetGuards" });
  const forgotten = (await snap()).tabs;
  const liveNow = await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(t=>t.filter(x=>!x.discarded).map(x=>({id:x.id,url:x.url})))");
  const flaggedBefore = liveNow.filter(t => !(forgotten[t.id] || {}).guard).length;
  await sleep(5000); // snapshot triggers a throttled probe; the alarm/startup probe also exist
  await snap();
  await sleep(1500);
  const after2 = await snap();
  const unprot = liveNow.filter(t => !(after2.tabs[t.id] || {}).guard).map(t => t.url);
  check("after the worker forgot, the probe re-learned every live tab (no false 'без защиты')", liveNow.length >= 3 && unprot.length === 0, { live: liveNow.length, wasFlagged: flaggedBefore, stillUnprotected: unprot });
  const prot = await call({ type: "protectTabs" });
  check("'Protect open tabs' injects nothing twice when everything is already protected", prot.injected === 0, prot);

  const shot = await pop.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, "e2e-popup.png"), Buffer.from(shot.data, "base64"));
  pop.close();
  R.learnedCeil = learnedCeil;
} catch (e) {
  fatal = String(e && e.stack || e);
  console.log("FATAL " + fatal);
} finally {
  try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  server.close(); server.closeAllConnections?.();
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
const failed = R.checks.filter(c => !c.pass);
console.log(`\n${R.checks.length - failed.length}/${R.checks.length} checks passed` + (fatal ? " (FATAL error)" : ""));
console.log(failed.length || fatal ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed.length || fatal ? 1 : 0);
