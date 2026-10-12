// Real-browser test: launches a SEPARATE Chrome (temp profile, never the user's) with the extension loaded,
// a mock ChatGPT backend that rate-limits like the real one, and compares guard OFF vs ON in two tabs.
// Usage: node tests/browser-test.mjs
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "../extension");
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 18765, DEBUG = 19333;
const WINDOW = 3000, MAX = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mock backend: >MAX starts per WINDOW -> 429, penalty escalates when hammered ----------
let st;
const resetState = () => (st = { starts: [], penaltyUntil: 0, rejects: [], ok: 0, r429: 0 });
resetState();
const server = http.createServer((req, res) => {
  const now = Date.now();
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/index.html") { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><title>mock</title><body>mock chatgpt"); }
  if (u.pathname === "/reset") { resetState(); return res.end("ok"); }
  if (u.pathname === "/stats") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: st.ok, r429: st.r429 })); }
  if (/^\/backend-api\/conversations\/[^/]+$/.test(u.pathname)) {
    st.starts = st.starts.filter(t => now - t < WINDOW);
    if (now < st.penaltyUntil || st.starts.length >= MAX) {
      st.rejects.push(now); st.r429++;
      const pen = Math.min(2 + st.rejects.filter(t => now - t < 30000).length * 0.5, 8);
      st.penaltyUntil = Math.max(st.penaltyUntil, now + pen * 1000);
      res.statusCode = 429; res.setHeader("retry-after", String(Math.ceil((st.penaltyUntil - now) / 1000)));
      return res.end('{"detail":"Too many requests"}');
    }
    st.starts.push(now); st.ok++;
    return setTimeout(() => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }, 40);
  }
  res.statusCode = 404; res.end();
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// ---------- tiny CDP client ----------
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0; const pend = new Map(); const listeners = [];
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else listeners.forEach(l => l(m));
  });
  return {
    on: l => listeners.push(l),
    send: (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, m => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    eval: async expr => {
      const r = await (await cdp.last).send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      return r;
    },
    close: () => ws.close()
  };
}
const evalIn = async (c, expr) => {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const getJSON = async (p, method = "GET") => (await fetch(`http://127.0.0.1:${DEBUG}${p}`, { method })).json();

// ---------- launch isolated chrome ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "a429-chrome-"));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG}`, "--remote-allow-origins=*",
  "--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--no-first-run", "--no-default-browser-check", "--window-size=900,900", "about:blank"
], { stdio: "ignore" });
const results = { extension: {}, ab: {} };
let exitCode = 0;
try {
  for (let i = 0; i < 40; i++) { try { await getJSON("/json/version"); break; } catch { await sleep(500); } }

  // ----- A. the extension itself: loads, service worker boots without errors, popup renders -----
  // Chrome 137+ ignores --load-extension in branded builds; load through the browser-level CDP instead.
  const ver = await getJSON("/json/version");
  const bc = await cdp(ver.webSocketDebuggerUrl);
  try { results.extension.loadResult = await bc.send("Extensions.loadUnpacked", { path: extDir }); }
  catch (e) { results.extension.loadError = String(e.message || e); }
  bc.close();
  await sleep(2500);
  const targets = await getJSON("/json/list");
  const sw = targets.find(t => t.type === "service_worker" && t.url.includes("/background.js"));
  results.extension.serviceWorkerFound = !!sw;
  if (sw) {
    const extId = new URL(sw.url).host;
    results.extension.id = extId;
    const c = await cdp(sw.webSocketDebuggerUrl);
    const errors = [];
    c.on(m => { if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    await c.send("Runtime.enable");
    results.extension.manifest = await evalIn(c, "JSON.stringify({n:chrome.runtime.getManifest().name,v:chrome.runtime.getManifest().version})");
    results.extension.badge = await evalIn(c, "chrome.action.getBadgeText({})");
    results.extension.snapshot = await evalIn(c, "chrome.runtime.sendMessage({type:'snapshot'}).then(s=>JSON.stringify({overall:s.overall,fams:s.fams.map(f=>f.id+':'+f.count+'/'+f.ceil)}))").catch(e => "ERR " + e);
    await sleep(500);
    results.extension.swErrors = errors;
    c.close();

    const popup = await getJSON(`/json/new?${encodeURIComponent(`chrome-extension://${extId}/popup.html`)}`, "PUT");
    const pc = await cdp(popup.webSocketDebuggerUrl);
    const perrors = [];
    pc.on(m => { if (m.method === "Runtime.exceptionThrown") perrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    await pc.send("Runtime.enable");
    await pc.send("Emulation.setDeviceMetricsOverride", { width: 430, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(2000);
    results.extension.popupText = (await evalIn(pc, "document.body.innerText")).slice(0, 220).replace(/\n/g, " | ");
    results.extension.popupErrors = perrors;
    const shot = await pc.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, "popup.png"), Buffer.from(shot.data, "base64"));
    pc.close();
  }

  // ----- B. guard OFF vs ON, two tabs of the same origin -----
  const sharedSrc = fs.readFileSync(path.join(extDir, "shared.js"), "utf8");
  const guardSrc = fs.readFileSync(path.join(extDir, "guard.js"), "utf8");
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const t = await getJSON(`/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/index.html`)}`, "PUT");
    const c = await cdp(t.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    tabs.push(c);
  }
  await sleep(800);
  const burst = n => `(async()=>{const r=await Promise.all(Array.from({length:${n}},(_, i)=>fetch('/backend-api/conversations/c'+i).then(x=>x.status).catch(e=>'ERR')));return JSON.stringify(r)})()`;

  async function scenario(enabled) {
    await fetch(`http://127.0.0.1:${PORT}/reset`);
    for (const c of tabs) {
      await evalIn(c, `localStorage.clear();localStorage.setItem('a429:cfg',JSON.stringify({enabled:${enabled},windowMs:${WINDOW},holdMaxMs:120000}));localStorage.setItem('a429:ceil',JSON.stringify({detail:${MAX}}));`);
      await evalIn(c, sharedSrc + "\n" + guardSrc + "\ntrue");
    }
    const t0 = Date.now();
    const settled = await Promise.all(tabs.map(c => evalIn(c, burst(6)).then(JSON.parse)));
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    const server429 = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
    const statuses = settled.flat();
    return {
      requests: statuses.length,
      surfaced429: statuses.filter(s => s === 429).length,
      surfaced200: statuses.filter(s => s === 200).length,
      serverRejects: server429.r429, serverOk: server429.ok, seconds: secs
    };
  }
  results.ab.guardOff = await scenario(false);
  await sleep(WINDOW * 3 + 9000); // let the mock's penalty expire
  results.ab.guardOn = await scenario(true);
  tabs.forEach(c => c.close());
} catch (e) {
  results.error = String(e && e.stack || e);
  exitCode = 1;
} finally {
  try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  server.close();
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(JSON.stringify(results, null, 2));
const ab = results.ab;
const ok = !results.error && results.extension.serviceWorkerFound && !(results.extension.swErrors || []).length &&
  ab.guardOn && ab.guardOn.surfaced429 === 0 && ab.guardOn.surfaced200 === ab.guardOn.requests && ab.guardOff && ab.guardOff.surfaced429 > 0;
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
