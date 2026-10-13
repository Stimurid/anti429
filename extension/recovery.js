// 4̅2̅9̅ stream-resume recovery — page (MAIN world), chatgpt.com, document_start, loaded AFTER guard.js.
//
// Problem (seen in public HAR captures): the page re-attaches to a running/finished answer with
//   POST /backend-api/f/conversation/resume {conversation_id, offset}
// The server answers 404, the page then polls stream_status every ~12 s and re-downloads the whole
// conversation (46× in 10 min, ~590 MB) — a self-inflicted rate-limit storm.
//
// What this does: ONLY when (a) the 404 happens within 30 s of a stream_status that said IS_STREAMING,
// (b) no "natural" recovery arrives first (WebSocket conversation-turn-complete, or the page's own
// history GET succeeding), and (c) no other tab/request is already recovering that conversation,
// it re-sends the same resume request with at most two other offsets and hands the page the first
// response that really is an event-stream with protocol evidence. Everything is bounded and
// abortable. Design inspired by the MIT-licensed ChatGPT Conversation Availability Guard
// (stream-observer.js); independent implementation — see THIRD_PARTY_NOTICES.md.
(() => {
  "use strict";
  if (window.__A429_RECOVERY2__) return;
  const A = window.A429;
  if (!A) return;
  window.__A429_RECOVERY2__ = true;
  window.__A429_RECOVERY__ = true;

  const NS = "a429:";
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;

  const TTL_MS = 2 * 60 * 1000;
  const STREAMING_MAX_AGE_MS = 30 * 1000;
  const GRACE_MS = 1200;            // wait for a natural signal first
  const DETAIL_EXT_MS = 4800;       // ... longer if the page's own history GET is in flight
  const POST_DETAIL_GRACE_MS = 800;
  const RETRY_DELAY_MS = 150;
  const OFFSETS = [0, 1, 2];
  const VALIDATE_MAX_BYTES = 128 * 1024;
  const VALIDATE_MAX_MS = 1500;

  const readJSON = (k, d) => { try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const cfg = () => Object.assign({ enabled: true, recovery: true, timeScale: 1 }, readJSON("cfg2", {}));
  const T = ms => Math.max(1, Math.round(ms * (Number(cfg().timeScale) || 1))); // timeScale is a test hook
  const active = () => { const c = cfg(); return c.enabled !== false && c.recovery !== false; };

  const stats = { resume404: 0, attempts: 0, success: 0, suppressed: 0, skipped: 0, exhausted: 0, stopped: 0 };
  const STAT_OF = { "resume-404": "resume404", "resume-recovery-attempt": "attempts", "resume-recovery-success": "success",
    "resume-recovery-suppressed": "suppressed", "resume-recovery-skipped": "skipped", "resume-recovery-exhausted": "exhausted", "resume-recovery-stopped": "stopped" };
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

  // ---------- per-conversation knowledge ----------
  const streamStatus = new Map();   // conv -> {status, at}
  const completion = new Map();     // conv -> {at, seq}   (WebSocket turn-complete)
  const detailOk = new Map();       // conv -> {at, seq}   (page's own history GET succeeded)
  const detailInFlight = new Map(); // conv -> count
  const inFlight = new Set();       // conversations being recovered by THIS tab
  const listeners = new Set();
  let seq = 0;
  const bump = (conv, type) => { for (const l of [...listeners]) { try { l({ conv, type }); } catch {} } };
  const clean = () => {
    const cut = Date.now() - TTL_MS;
    for (const m of [streamStatus, completion, detailOk]) for (const [k, v] of m) if (!v || v.at < cut) m.delete(k);
  };

  function waitNatural(conv, seq0, ms, signal) {
    return new Promise((resolve, reject) => {
      if ((completion.get(conv) || { seq: 0 }).seq > seq0) return resolve("provider-complete");
      if ((detailOk.get(conv) || { seq: 0 }).seq > seq0) return resolve("stock-detail-success");
      if (signal && signal.aborted) return reject(abortError(signal));
      let settled = false, timer;
      const finish = v => {
        if (settled) return;
        settled = true; clearTimeout(timer); listeners.delete(l);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const l = ev => {
        if (ev.conv !== conv) return;
        if (ev.type === "complete") finish("provider-complete");
        else if (ev.type === "detail-ok") finish("stock-detail-success");
        else if (ev.type === "detail-fail") finish("stock-detail-failed");
      };
      const onAbort = () => { if (settled) return; settled = true; clearTimeout(timer); listeners.delete(l); reject(abortError(signal)); };
      listeners.add(l);
      timer = setTimeout(() => finish(null), ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---------- request parsing ----------
  const quick = (input, init) => {
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = String((init && init.method) || (isReq && input.method) || "GET").toUpperCase();
      const url = new URL(isReq ? input.url : String(input), location.href);
      return url.origin === location.origin ? { method, url, isReq } : null;
    } catch { return null; }
  };
  const convFromStatus = u => { const m = u.pathname.match(/^\/backend-api\/conversation\/([^/?]+)\/stream_status$/); return m ? decodeURIComponent(m[1]) : null; };
  const convFromDetail = (method, u) => {
    if (method !== "GET") return null;
    const m = u.pathname.match(/^\/backend-api\/conversations?\/([^/?]+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  async function resumeMeta(request) {
    try {
      const body = JSON.parse(await request.text());
      const conv = body && typeof body.conversation_id === "string" && body.conversation_id ? body.conversation_id : null;
      if (!conv) return null;
      return { conv, body, offset: Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0 };
    } catch { return null; }
  }

  async function rememberStatus(resp, conv) {
    if (!resp || !resp.ok || resp.status === 204 || resp.status === 205) return;
    try {
      const raw = await resp.text();
      if (!raw.trim()) return;
      const p = JSON.parse(raw);
      const status = String(typeof p.status === "string" ? p.status : (typeof p.stream_status === "string" ? p.stream_status : "unknown")).slice(0, 64);
      streamStatus.set(conv, { status, at: Date.now() });
      clean();
    } catch {}
  }

  // ---------- stream validation ----------
  const evidenceIn = event => {
    const st = { evidence: false, error: null };
    const visit = v => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (typeof v.error_code === "string" && v.error_code) st.error = v.error_code.slice(0, 80);
      if (v.type === "resume_conversation_token" || v.type === "stream_handoff" || v.type === "message_stream_complete" ||
          v.message || Object.prototype.hasOwnProperty.call(v, "v")) st.evidence = true;
      if (Array.isArray(v.v)) v.v.forEach(visit); else if (v.v && typeof v.v === "object") visit(v.v);
    };
    visit(event);
    return st;
  };

  async function validateStream(resp, signal) {
    let clone;
    try { clone = resp.clone(); } catch { return { ok: false, reason: "clone-failed" }; }
    if (!clone.body) return { ok: false, reason: "missing-body" };
    const reader = clone.body.getReader();
    const dec = new TextDecoder();
    let buf = "", bytes = 0, explicitError = null;
    const deadline = Date.now() + VALIDATE_MAX_MS;
    const inspect = block => {
      const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (!data || data === "[DONE]") return false;
      try { const e = evidenceIn(JSON.parse(data)); if (e.error) explicitError = e.error; return e.evidence; } catch { return false; }
    };
    try {
      while (bytes <= VALIDATE_MAX_BYTES) {
        if (signal && signal.aborted) throw abortError(signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ok: false, reason: "validation-timeout" };
        const TO = Symbol("timeout");
        const r = await Promise.race([reader.read(), sleep(remaining, signal).then(() => TO)]);
        if (r === TO) return { ok: false, reason: "validation-timeout" };
        if (r.done) {
          if (buf.trim() && inspect(buf) && !explicitError) return { ok: true, reason: "protocol-evidence" };
          return { ok: false, reason: explicitError ? "error-only-stream" : "empty-stream" };
        }
        bytes += (r.value && r.value.byteLength) || 0;
        buf += dec.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
        const blocks = buf.split("\n\n");
        buf = blocks.pop() || "";
        for (const b of blocks) if (inspect(b) && !explicitError) return { ok: true, reason: "protocol-evidence" };
      }
      return { ok: false, reason: "validation-byte-limit" };
    } finally { try { void reader.cancel(); } catch {} }
  }

  // ---------- recovery ----------
  async function maybeRecover(retryReq, metaP, seq0) {
    const meta = await metaP;
    if (!retryReq || !meta) { emit("resume-recovery-skipped", { reason: "unsupported-request" }); return null; }
    const { conv, body, offset } = meta;
    const st = streamStatus.get(conv);
    const age = st ? Date.now() - st.at : null;
    if (!(st && st.status === "IS_STREAMING" && age >= 0 && age <= STREAMING_MAX_AGE_MS)) {
      emit("resume-recovery-skipped", { reason: st && st.status === "IS_STREAMING" ? "stale-streaming-evidence" : "no-recent-streaming" });
      return null;
    }
    if (inFlight.has(conv)) { emit("resume-recovery-skipped", { reason: "concurrent" }); return null; }
    const signal = retryReq.signal;

    const run = async () => {
      let nat = await waitNatural(conv, seq0, T(GRACE_MS), signal);
      if (!nat && (detailInFlight.get(conv) || 0) > 0) nat = await waitNatural(conv, seq0, T(DETAIL_EXT_MS), signal);
      if (nat === "provider-complete") { emit("resume-recovery-suppressed", { reason: nat }); return null; }
      if (nat === "stock-detail-success") {
        if (await waitNatural(conv, seq0, T(POST_DETAIL_GRACE_MS), signal) === "provider-complete") {
          emit("resume-recovery-suppressed", { reason: "provider-complete-after-detail" });
          return null;
        }
      }
      const offsets = OFFSETS.filter(o => o !== offset);
      let attempt = 0;
      for (const next of offsets) {
        if (signal && signal.aborted) throw abortError(signal);
        attempt++;
        await sleep(T(RETRY_DELAY_MS + Math.floor(Math.random() * 100)), signal);
        let req;
        try { req = new Request(retryReq, { body: JSON.stringify(Object.assign({}, body, { offset: next })) }); }
        catch { emit("resume-recovery-skipped", { reason: "request-rebuild-failed" }); return null; }
        let resp;
        try { resp = await nativeFetch(req); }
        catch (e) { if (signal && signal.aborted) throw e; emit("resume-recovery-network-error", { attempt }); return null; }
        emit("resume-recovery-attempt", { attempt, offset: next, status: resp.status });
        if (resp.status === 404) continue;
        if (!resp.ok) { emit("resume-recovery-stopped", { attempt, status: resp.status }); return null; }
        const ct = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || "";
        if (!resp.body || !ct.includes("text/event-stream")) { emit("resume-recovery-stopped", { attempt, reason: "non-stream-response" }); return null; }
        const v = await validateStream(resp, signal);
        if (!v.ok) { emit("resume-recovery-stopped", { attempt, reason: v.reason }); return null; }
        emit("resume-recovery-success", { attempt, offset: next, status: resp.status });
        return resp;
      }
      emit("resume-recovery-exhausted", { attempts: attempt });
      return null;
    };

    inFlight.add(conv);
    try {
      const locks = typeof navigator !== "undefined" && navigator.locks;
      if (locks && typeof locks.request === "function") {
        return await locks.request("a429-resume:" + conv, { ifAvailable: true }, async lock => {
          if (!lock) { emit("resume-recovery-skipped", { reason: "cross-tab" }); return null; }
          return await run();
        });
      }
      return await run();
    } catch (e) {
      if (signal && signal.aborted) { emit("resume-recovery-aborted"); throw e; }
      emit("resume-recovery-error");
      return null;
    } finally { inFlight.delete(conv); }
  }

  // ---------- fetch wrapper ----------
  window.fetch = function (input, init) {
    let info;
    try { if (!active()) return nativeFetch(input, init); info = quick(input, init); } catch { return nativeFetch(input, init); }
    if (!info) return nativeFetch(input, init);

    const statusConv = convFromStatus(info.url);
    const detailConv = convFromDetail(info.method, info.url);
    const isResume = info.method === "POST" && info.url.pathname === "/backend-api/f/conversation/resume";
    if (!statusConv && !detailConv && !isResume) return nativeFetch(input, init);

    if (detailConv) detailInFlight.set(detailConv, (detailInFlight.get(detailConv) || 0) + 1);
    const finishDetail = ok => {
      if (!detailConv) return;
      const n = Math.max(0, (detailInFlight.get(detailConv) || 1) - 1);
      if (n) detailInFlight.set(detailConv, n); else detailInFlight.delete(detailConv);
      if (ok) { detailOk.set(detailConv, { at: Date.now(), seq: ++seq }); bump(detailConv, "detail-ok"); }
      else bump(detailConv, "detail-fail");
    };

    let retryReq = null, metaP = Promise.resolve(null);
    const seq0 = seq;
    if (isResume) {
      try {
        const request = info.isReq ? input : new Request(info.url.href, init); // absolute URL: robust for relative inputs
        retryReq = request.clone();
        metaP = resumeMeta(request.clone());
      } catch { retryReq = null; }
    }

    let task;
    try { task = nativeFetch(input, init); }
    catch (e) { finishDetail(false); throw e; }

    return task.then(async resp => {
      if (detailConv) finishDetail(resp.ok);
      if (statusConv) { let c = null; try { c = resp.clone(); } catch {} if (c) void rememberStatus(c, statusConv); }
      if (isResume && resp.status === 404) {
        emit("resume-404", {});
        const rec = await maybeRecover(retryReq, metaP, seq0);
        if (rec) return rec;
      }
      return resp;
    }, err => { finishDetail(false); throw err; });
  };

  // ---------- WebSocket: natural completion signal ----------
  const inspectFrame = f => {
    if (!f || typeof f !== "object") return;
    if (Array.isArray(f)) { f.forEach(inspectFrame); return; }
    if (f.type === "message" && f.topic_id === "conversations" && f.payload && f.payload.type === "conversation-turn-complete") {
      const conv = f.payload.payload && f.payload.payload.conversation_id;
      if (typeof conv === "string") { completion.set(conv, { at: Date.now(), seq: ++seq }); bump(conv, "complete"); }
    }
    if (f.type === "reply" && f.reply && Array.isArray(f.reply.catchups)) f.reply.catchups.forEach(inspectFrame);
  };
  if (typeof NativeWebSocket === "function") {
    try {
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget);
          socket.addEventListener("message", e => {
            if (typeof e.data !== "string") return;
            try { inspectFrame(JSON.parse(e.data)); } catch {}
          });
          return socket;
        }
      });
    } catch {}
  }

  window.__A429_RECOVERY_STATE__ = () => ({
    active: active(), stats: Object.assign({}, stats), inFlight: inFlight.size, tracked: streamStatus.size,
    detailInFlight: detailInFlight.size
  });
  emit("recovery-installed", { version: "0.2.0" });
})();
