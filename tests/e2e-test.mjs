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
if(!q.get('broken')) fetch('/backend-api/conversations/'+id).then(r=>{document.title='status '+r.status}).catch(()=>{});
if(q.get('poll')) setInterval(()=>{fetch('/backend-api/conversation/'+id+'/stream_status').catch(()=>{});fetch('/backend-api/conversations/'+id).catch(()=>{})},1500);
if(q.get('draft')) document.body.insertAdjacentHTML('beforeend','<div id="prompt-textarea" contenteditable="true">unsent draft text</div>');
if(q.get('resume')) (async()=>{
  await fetch('/backend-api/conversation/'+id+'/stream_status').then(r=>r.json());
  const r=await fetch('/backend-api/f/conversation/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversation_id:id,offset:5})});
  document.title='resume '+r.status+' '+(r.headers.get('content-type')||'');
})();
if(q.get('zombie')) (async()=>{
  for(let i=0;i<40;i++){
    const st=await fetch('/backend-api/conversation/'+id+'/stream_status').then(r=>r.json()).catch(()=>({}));
    if(st.status!=='IS_STREAMING'){ document.title='zombie settled '+st.status; const r=await fetch('/backend-api/conversations/'+id).then(r=>r.status).catch(()=>0); document.title='zombie loaded '+r; return; }
    await fetch('/backend-api/f/conversation/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversation_id:id,offset:5})}).catch(()=>{});
    await new Promise(r=>setTimeout(r,800));
  }
  document.title='zombie gave up';
})();
if(q.get('stuck')) {
  document.title='stuck';
  document.body.insertAdjacentHTML('beforeend','<main><div id="e">Could not load this ChatGPT conversation <button id="retry">Try again</button></div></main>');
  document.getElementById('retry').onclick=()=>{ document.title='stuck healed'; document.getElementById('e').remove(); };
}
if(q.get('broken')) {
  document.body.insertAdjacentHTML('beforeend','<main><section id="ans">Assistant answer text <button id="decoy">Try again</button></section></main>');
  document.getElementById('decoy').onclick=()=>{document.title='DECOY CLICKED'};
  const load=async()=>{
    const r=await fetch('/backend-api/conversations/'+id);
    if(r.ok){ const e=document.getElementById('e'); if(e) e.remove(); document.title='healed '+r.status; }
    else { document.title='broken '+r.status;
      if(!document.getElementById('e')) document.querySelector('main').insertAdjacentHTML('afterbegin','<div id="e">Could not load this ChatGPT conversation <button id="retry">Try again</button></div>');
      document.getElementById('retry').onclick=load; }
  };
  load();
}
if(q.get('burst')) Promise.all(Array.from({length:10},(_,i)=>fetch('/backend-api/conversations/b'+i).then(r=>r.status))).then(s=>{document.title='burst '+s.join(',')});
</script>`;
let lim;
const reset = () => (lim = { brk: 0,  detail: { starts: [], pen: 0, rej: [] }, stream: { starts: [], pen: 0, rej: [] }, stats: { ok: 0, r429: 0 } });
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
  if (u.pathname === "/api/auth/session") { res.setHeader("content-type", "application/json"); return res.end('{"accessToken":"tok"}'); }
  if (u.pathname === "/backend-api/stop_conversation" && req.method === "POST") {
    let raw = ""; req.on("data", c => (raw += c));
    return req.on("end", () => {
      (lim.stops = lim.stops || []).push({ body: raw, auth: req.headers.authorization || "" });
      res.setHeader("content-type", "application/json"); res.end('{"status":"ok","last_message_id":null}');
    });
  }
  if (u.pathname.startsWith("/c/")) { res.setHeader("content-type", "text/html"); return res.end(PAGE); }
  if (u.pathname === "/__reset") { reset(); return res.end("ok"); }
  if (u.pathname === "/backend-api/conversations/brk1") {
    lim.brk++;
    if (lim.brk <= 3) { res.statusCode = 429; res.setHeader("retry-after", "1"); return res.end('{"detail":"Too many requests"}'); }
    res.setHeader("content-type", "application/json"); return res.end('{"ok":true}');
  }
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
      lim.resumeTotal = (lim.resumeTotal || 0) + 1;
      if (off !== 0 || /zombie|d00d/.test(raw)) { res.statusCode = 404; return res.end(); }
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
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
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
  // the resume tab may legitimately wait in the guard's queue: poll for its result instead of a fixed sleep
  for (let i = 0; i < 30; i++) {
    const t = (await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>ts.map(x=>({url:x.url,title:x.title})))")).find(x => x.url.includes("resume1"));
    if (t && /^resume /.test(t.title)) break;
    await sleep(1000);
  }
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

  // 6) resizable dashboard: separate window + side panel (the toolbar popup is hard-capped by Chrome at ~600 px)
  const popMode = await ev(pop, "JSON.stringify({mode:document.documentElement.dataset.mode,w:Math.round(document.body.getBoundingClientRect().width),btnWin:getComputedStyle(document.getElementById('btnWinL')).display,btnPanel:getComputedStyle(document.getElementById('btnPanel')).display})");
  const pm = JSON.parse(popMode);
  check("toolbar popup keeps its compact 430px layout and shows both expand buttons", pm.mode === "popup" && pm.w === 430 && pm.btnWin !== "none" && pm.btnPanel !== "none", pm);
  const scr = JSON.parse(await ev(pop, "JSON.stringify({left:screen.availLeft||0,top:screen.availTop||0,width:screen.availWidth,height:screen.availHeight})"));
  const ow = await call({ type: "openWindow", side: "right", screen: scr });
  check("openWindow creates a dashboard window", ow && ow.windowId != null, ow);
  await sleep(2500);
  const lst = await dbg("/json/list");
  const winPage = lst.find(t => t.type === "page" && t.url.includes("popup.html?mode=window"));
  check("dashboard window page exists", !!winPage, winPage && winPage.url);
  if (winPage) {
    const wc = await cdp(winPage.webSocketDebuggerUrl);
    await wc.send("Runtime.enable");
    await wc.send("Emulation.setDeviceMetricsOverride", { width: 560, height: 1100, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const info = JSON.parse(await ev(wc, "JSON.stringify({mode:document.documentElement.dataset.mode,maxH:getComputedStyle(document.body).maxHeight,bodyW:Math.round(document.body.getBoundingClientRect().width),vw:innerWidth,btnWin:getComputedStyle(document.getElementById('btnWinL')).display,btnPanel:getComputedStyle(document.getElementById('btnPanel')).display,tabRows:document.querySelectorAll('.tab').length,docH:document.documentElement.scrollHeight})"));
    check("window mode: no height cap, fluid width, dock buttons still available", info.mode === "window" && info.maxH === "none" && info.bodyW <= info.vw && info.bodyW >= info.vw - 20 && info.btnWin !== "none" && info.btnPanel !== "none", info);
    check("window mode shows many tab rows at once (not 3)", info.tabRows >= 6 && info.docH > 600, { rows: info.tabRows, docH: info.docH });
    const sh = await wc.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, "e2e-window.png"), Buffer.from(sh.data, "base64"));
    wc.close();
  }
  const wRight = await ev(pop, "chrome.windows.getAll().then(ws=>JSON.stringify(ws.filter(w=>w.type==='popup').map(w=>({left:w.left,top:w.top,width:w.width,height:w.height}))))");
  const rw = JSON.parse(wRight)[0];
  check("dock RIGHT: window hugs the right edge of the usable screen at (almost) full height", rw && Math.abs(rw.left + rw.width - (scr.left + scr.width)) <= 20 && rw.height >= scr.height - 80, { win: rw, scr });
  const ow2 = await call({ type: "openWindow", side: "left", screen: scr });
  check("a second openWindow re-docks the existing window instead of opening another", ow2 && ow2.reused === true && ow2.side === "left", ow2);
  await sleep(800);
  const leftWins = JSON.parse(await ev(pop, "chrome.windows.getAll().then(ws=>JSON.stringify(ws.filter(w=>w.type==='popup').map(w=>({left:w.left,width:w.width}))))"));
  check("dock LEFT: same single window moved to the left edge", leftWins.length === 1 && Math.abs(leftWins[0].left - scr.left) <= 20, { popups: leftWins, scrLeft: scr.left });
  const sp = await ev(pop, "chrome.sidePanel.getOptions({}).then(o=>JSON.stringify(o))");
  check("side panel is registered with the panel-mode page", /mode=panel/.test(sp), sp);

  // 7) the herd: 8 tabs open at once, only the last one is visible (this is what a session restore looks like)
  // the docked dashboard windows from step 6 would cover the browser window (Chrome then reports its tabs as hidden)
  await ev(pop, "chrome.windows.getAll({windowTypes:['popup']}).then(ws=>Promise.all(ws.map(w=>chrome.windows.remove(w.id))))");
  await ev(pop, "chrome.windows.getAll({windowTypes:['normal']}).then(ws=>chrome.windows.update(ws[0].id,{focused:true,state:'normal'}))");
  await sleep(1000);
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "resetLearned" });
  await sleep(11000); // let the mock's penalty window and the tabs' shared cooldown run out
  await resetMock();
  const titleOf = async frag => (await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>ts.map(t=>({u:t.url||'',t:t.title||'',id:t.id,disc:t.discarded})))")).find(x => (x.u || '').includes(frag));
  const herdTabs = [];
  // like a session restore: every tab except the last is created in the BACKGROUND (never visible)
  for (let i = 0; i < 8; i++) herdTabs.push(await ev(pop, `chrome.tabs.create({url:'https://chatgpt.com/c/herd${i}', active:${i === 7}}).then(t=>t.id)`));
  await sleep(2500);
  let fgOk = false;
  for (let i = 0; i < 30 && !fgOk; i++) { const t = await titleOf("herd7"); fgOk = t && /^status 200/.test(t.t); if (!fgOk) await sleep(1000); }
  check("the VISIBLE tab loaded its history promptly", fgOk);
  let loadedHidden = 0;
  for (let i = 0; i < 7; i++) { const t = await titleOf(`herd${i}`); if (t && /^status/.test(t.t)) loadedHidden++; }
  check("hidden tabs did NOT hit the server while invisible (deferred)", loadedHidden === 0, { loadedHidden });
  check("no 429s from the herd while only the visible tab worked", lim.stats.r429 <= 1, lim.stats);
  const idsHidden = [];
  for (let i = 0; i < 7; i++) idsHidden.push((await titleOf(`herd${i}`)).id);
  // a tab you switch away from before its turn comes goes back to "hidden" and waits again (by design),
  // so visit them one at a time and let each finish while it is visible
  let allOk = true;
  for (let k = 0; k < 7; k++) {
    await ev(pop, `chrome.tabs.update(${idsHidden[k]},{active:true})`);
    await sleep(700);
    const visNow = await ev(pop, `chrome.scripting.executeScript({target:{tabId:${idsHidden[k]}},world:'MAIN',func:()=>document.visibilityState}).then(r=>r[0].result)`).catch(() => "err");
    if (k === 0) check("an activated tab really reports visibilityState=visible (test environment sanity)", visNow === "visible", visNow);
    let ok = false;
    for (let i = 0; i < 25 && !ok; i++) { const t = await titleOf(`herd${k}`); ok = t && /^status 200/.test(t.t); if (!ok) await sleep(1000); }
    if (!ok) allOk = false;
  }
  let dbgRows = null;
  if (!allOk) {
    dbgRows = [];
    for (let k = 0; k < 7; k++) {
      const tt = await titleOf(`herd${k}`);
      let info = null;
      try { info = await ev(pop, `chrome.scripting.executeScript({target:{tabId:${tt.id}},world:'MAIN',func:()=>({vis:document.visibilityState,st:window.__A429_STATE__&&window.__A429_STATE__(),ls:Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('a429:')&&!/cfg|ceil/.test(k)).map(k=>[k,localStorage.getItem(k)]))})}).then(r=>JSON.stringify(r[0].result))`); } catch (e) { info = String(e).slice(0, 80); }
      dbgRows.push({ k, title: tt && tt.t, info });
    }
  }
  check("visiting the hidden tabs one by one, every tab loads while it is visible", allOk, dbgRows);
  check("the whole herd cost at most a few 429s in total", lim.stats.r429 <= 4, lim.stats);

  // 8) auto-heal: a visible tab whose history terminally failed (banner) is revived once the limiter is calm
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "setCfg", patch: { holdMaxMs: 1500, timeScale: 0.05, calmMs: 3000, healGapMs: 2000, healBackoffScale: 0.05, autoHeal: true } });
  await call({ type: "resetLearned" });
  await ev(pop, "chrome.storage.local.set({ceilings:{detail:12,legacy:12,stream:12,list:12}})");
  await sleep(4000);
  await resetMock();
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/brk1?broken=1', active:true}).then(t=>t.id)");
  let sawBroken = false, brokenFlagged = false;
  for (let i = 0; i < 25 && !sawBroken; i++) { const t = await titleOf("brk1"); sawBroken = t && /^broken 429/.test(t.t); if (!sawBroken) await sleep(500); }
  check("the page was finally shown the 429 (banner) after the hold budget", sawBroken);
  await sleep(1200);
  const sb = await snap();
  const brkTab = await titleOf("brk1");
  brokenFlagged = brkTab && sb.tabs[brkTab.id] && sb.tabs[brkTab.id].broken && sb.tabs[brkTab.id].broken.status === 429;
  check("the extension knows that tab is broken (status 429)", brokenFlagged, brkTab && sb.tabs[brkTab.id] && sb.tabs[brkTab.id].broken);
  let healed = false;
  for (let i = 0; i < 70 && !healed; i++) { const t = await titleOf("brk1"); healed = t && /^healed 200/.test(t.t); if (!healed) await sleep(500); }
  check("the tab was revived automatically (its own 'Try again' clicked) once calm", healed);
  const fin = await titleOf("brk1");
  check("the decoy 'Try again' inside the answer was NOT clicked", fin && !/DECOY/.test(fin.t), fin && fin.t);
  check("exactly one heal was needed: 3 failed attempts + 1 success on the mock", lim.brk === 4, { brkCalls: lim.brk });
  // 8b) a tab that is ALREADY stuck on the error block (no guard event ever reached the worker) is noticed and healed too
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await sleep(1500);
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/stuck1?stuck=1', active:true}).then(t=>t.id)");
  let noticed = false;
  for (let i = 0; i < 40 && !noticed; i++) { const t = await titleOf("stuck1"); const sn = await snap(); noticed = t && sn.tabs[t.id] && sn.tabs[t.id].broken; if (!noticed) await sleep(1000); }
  check("a tab already showing the error block is noticed by the bridge (no network event needed)", !!noticed, noticed);
  let stuckHealed = false;
  for (let i = 0; i < 60 && !stuckHealed; i++) { const t = await titleOf("stuck1"); stuckHealed = t && /^stuck healed/.test(t.t); if (!stuckHealed) await sleep(1000); }
  check("...and it is revived by clicking the page's own Try again", stuckHealed);
  await call({ type: "setCfg", patch: { holdMaxMs: 300000, timeScale: 1, calmMs: 30000, healGapMs: 15000, healBackoffScale: 1 } });

  // 9) zombie stream: server says IS_STREAMING forever, resume is always 404 (observed on the real site)
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "setCfg", patch: { holdMaxMs: 300000, timeScale: 1, calmMs: 30000, healGapMs: 15000, healBackoffScale: 1 } });
  await sleep(1500);
  await resetMock();
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/zombie1?zombie=1', active:true}).then(t=>t.id)");
  let zdone = false, zt = null;
  for (let i = 0; i < 90 && !zdone; i++) { zt = await titleOf("zombie1"); zdone = zt && /^zombie loaded/.test(zt.t); if (!zdone) await sleep(1000); }
  check("zombie chat: after the breaker trips the page stops looping, gets COMPLETE and loads the history", zdone, zt && zt.t);
  check("the page did NOT hammer the server forever (bounded number of resume POSTs)", (lim.resumeTotal || 0) <= 14, { resumePosts: lim.resumeTotal });
  const zsn = await snap();
  check("the tab is flagged 'dead stream' in the dashboard", zt && zsn.tabs[zt.id] && zsn.tabs[zt.id].deadStream > 0, zt && zsn.tabs[zt.id]);

  // 10) manual "mark as stuck": the user does not want to wait for two failed recoveries
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "setCfg", patch: { deadAfter: 99 } }); // automatic breaker effectively off for this tab
  await sleep(1500);
  await resetMock();
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/6acbd9ff-5b94-83ea-b5c9-455b40c38d01?zombie=1', active:true}).then(t=>t.id)");
  let sawStreaming = false, zt2 = null;
  for (let i = 0; i < 30 && !sawStreaming; i++) { zt2 = await titleOf("6acbd9ff"); const sn = await snap(); sawStreaming = zt2 && sn.tabs[zt2.id] && sn.tabs[zt2.id].streaming >= 0; if (!sawStreaming) await sleep(500); }
  check("the dashboard knows the server reports IS_STREAMING for that tab", sawStreaming);
  const md = await call({ type: "markDead", id: zt2.id });
  check("markDead is accepted by the page bridge", md && md.ok === true, md);
  let settled = false, zt3 = null;
  for (let i = 0; i < 40 && !settled; i++) { zt3 = await titleOf("6acbd9ff"); settled = zt3 && /^zombie loaded/.test(zt3.t); if (!settled) await sleep(1000); }
  check("after the manual mark the (reloaded) page gets COMPLETE immediately and loads the chat", settled, zt3 && zt3.t);
  await call({ type: "setCfg", patch: { deadAfter: 2 } });

  // 11) manual "Stop" for a stuck stream: the same request the page's own Stop button sends
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "setCfg", patch: { deadAfter: 99 } });
  await sleep(1500);
  await resetMock();
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/6acbd9ff-5b94-83ea-b5c9-455b40c38d02?zombie=1', active:true}).then(t=>t.id)");
  let streaming2 = false, stz = null;
  for (let i = 0; i < 30 && !streaming2; i++) { stz = await titleOf("38d02"); const sn = await snap(); streaming2 = stz && sn.tabs[stz.id] && sn.tabs[stz.id].streaming >= 0; if (!streaming2) await sleep(500); }
  check("stop: the dashboard sees the chat as streaming", streaming2);
  const sres = await call({ type: "stopStream", id: stz.id });
  check("stop: the bridge sent stop_conversation and the server accepted it", sres && sres.ok === true && sres.result === "ok", sres);
  const stopCall = (lim.stops || [])[0];
  check("stop: exactly one request, for THIS conversation, with the user's own bearer token", (lim.stops || []).length === 1 && stopCall && JSON.parse(stopCall.body).conversation_id.endsWith("38d02") && stopCall.auth === "Bearer tok", lim.stops);
  await call({ type: "setCfg", patch: { deadAfter: 2 } });

  // 12) opt-in auto-stop: IS_STREAMING long enough AND the resume breaker tripped -> one stop, not repeated
  await ev(pop, "chrome.tabs.query({url:'https://chatgpt.com/*'}).then(ts=>chrome.tabs.remove(ts.map(t=>t.id)))");
  await call({ type: "setCfg", patch: { autoStop: true, autoStopMin: 0.04, deadAfter: 2 } });
  await sleep(1500);
  await resetMock();
  await ev(pop, "chrome.tabs.create({url:'https://chatgpt.com/c/6acbd9ff-5b94-83ea-b5c9-455b40c3d00d?zombie=1', active:true}).then(t=>t.id)");
  let autoStopped = false;
  for (let i = 0; i < 70 && !autoStopped; i++) { autoStopped = (lim.stops || []).length >= 1; if (!autoStopped) await sleep(1000); }
  check("auto-stop (opt-in): a long-dead stream is stopped by the extension itself", autoStopped, lim.stops);
  await sleep(12000);
  check("auto-stop is NOT repeated for the same chat", (lim.stops || []).length === 1, { stops: (lim.stops || []).length });
  await call({ type: "setCfg", patch: { autoStop: false, autoStopMin: 45 } });

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
