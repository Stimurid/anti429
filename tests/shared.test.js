"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../extension/shared.js");

test("classify: the four families and non-matches", () => {
  assert.equal(A.classify("GET", "/backend-api/conversations"), "list");
  assert.equal(A.classify("POST", "/backend-api/conversations/batch"), "list");
  assert.equal(A.classify("GET", "/backend-api/conversations/6abb0a1f-3bc0-83e9"), "detail");
  assert.equal(A.classify("GET", "/backend-api/conversation/6abb0a1f-3bc0-83e9"), "legacy");
  assert.equal(A.classify("GET", "/backend-api/conversation/abc/stream_status"), "stream");
  assert.equal(A.classify("POST", "/backend-api/f/conversation/resume"), "stream");
  assert.equal(A.classify("GET", "/backend-api/models"), null);
  assert.equal(A.classify("GET", "/api/auth/session"), null);
  assert.equal(A.classify("POST", "/backend-api/conversations/abc"), null);
});

test("isGuardable: only idempotent GETs may be held/retried", () => {
  assert.equal(A.isGuardable("GET", "detail"), true);
  assert.equal(A.isGuardable("POST", "stream"), false);
  assert.equal(A.isGuardable("GET", "other"), false);
});

test("parseRetryAfter: seconds, http-date, junk, cap", () => {
  assert.equal(A.parseRetryAfter("22", 0), 22000);
  assert.equal(A.parseRetryAfter("0", 0), 0);
  assert.equal(A.parseRetryAfter(null, 0), 0);
  assert.equal(A.parseRetryAfter("nonsense", 0), 0);
  const now = Date.UTC(2026, 9, 13, 0, 0, 0);
  assert.equal(A.parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(A.parseRetryAfter("999999", 0), A.RETRY_AFTER_CAP_MS);
});

test("paceWaitMs: sliding window", () => {
  const W = 10000;
  assert.equal(A.paceWaitMs([], 1000, W, 3), 0);
  assert.equal(A.paceWaitMs([100, 200], 1000, W, 3), 0);           // 2 < cap 3
  // 3 starts in window, cap 3 -> must wait until the oldest (100) expires: 100+10000-1000 = 9100 (+1)
  assert.equal(A.paceWaitMs([100, 200, 300], 1000, W, 3), 9101);
  // old entries outside the window do not count
  assert.equal(A.paceWaitMs([-20000, -15000, 500], 1000, W, 3), 0);
  // over the cap by two -> must wait for the 3rd-oldest... idx = len - cap
  assert.equal(A.paceWaitMs([100, 200, 300, 400, 500], 1000, W, 3), 300 + W - 1000 + 1);
});

test("capFor keeps pacing below the ceiling", () => {
  assert.equal(A.capFor(4), 3);
  assert.equal(A.capFor(2), 1);
  assert.equal(A.capFor(1), 1);
});

test("learnCeiling moves down toward observed, never below minimum, never up", () => {
  assert.equal(A.learnCeiling(4, 2, "detail"), 3);
  assert.equal(A.learnCeiling(4, 3, "detail"), 3);  // floor((4+3)/2): a real limit of 3 is actually learned
  assert.equal(A.learnCeiling(4, 0, "detail"), 3);  // clamped target=2 -> avg 3
  assert.equal(A.learnCeiling(3, 2, "detail"), 2);  // floor((3+2)/2)
  assert.ok(A.learnCeiling(2, 0, "detail") >= A.CEIL_MIN);
  assert.equal(A.learnCeiling(4, 9, "detail"), 4);  // 429 above ceiling: ceiling stays
});

test("relaxCeiling creeps up by one, capped by family max", () => {
  assert.equal(A.relaxCeiling(3, "detail"), 4);
  assert.equal(A.relaxCeiling(A.MAX_CEIL.detail, "detail"), A.MAX_CEIL.detail);
});

test("levelOf thresholds and worstLevel ordering", () => {
  assert.equal(A.levelOf(0.1, false), "green");
  assert.equal(A.levelOf(0.5, false), "yellow");
  assert.equal(A.levelOf(0.8, false), "orange");
  assert.equal(A.levelOf(1, false), "red");
  assert.equal(A.levelOf(0, true), "red");
  assert.equal(A.worstLevel(["green", "orange", "yellow"]), "orange");
  assert.equal(A.worstLevel([]), "idle");
});

test("isLoop: HAR-like stream polling, history hammering, huge transfers", () => {
  assert.equal(A.isLoop({ fam60: { stream: 5 }, mb10: 0 }), true);
  assert.equal(A.isLoop({ fam60: { detail: 3, legacy: 1 }, mb10: 0 }), true);
  assert.equal(A.isLoop({ fam60: { detail: 1 }, mb10: 12.9 }), false);
  assert.equal(A.isLoop({ fam60: {}, mb10: 590 }), true);
  assert.equal(A.isLoop(null), false);
});

test("retryBackoffMs / jitter bounds", () => {
  assert.equal(A.retryBackoffMs(0), 2000);
  assert.equal(A.retryBackoffMs(99), 60000);
  for (let i = 0; i < 50; i++) {
    const j = A.jitter(1000, 0.15);
    assert.ok(j >= 850 && j <= 1150);
  }
});

test("manifest: no wide host access, no remote code, valid JSON", () => {
  const m = require("../extension/manifest.json");
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions, ["https://chatgpt.com/*"]);
  assert.ok(!m.permissions.includes("webRequestBlocking"));
  assert.ok(!m.permissions.includes("cookies"));
  assert.ok(!JSON.stringify(m).includes("unsafe-eval"));
});

test("canDiscard: never silently throws away a draft or a running answer", () => {
  assert.equal(A.canDiscard({}, {}).ok, true);
  assert.equal(A.canDiscard(undefined, {}).ok, true);
  assert.deepEqual(A.canDiscard({ draft: true }, {}), { ok: false, reason: "draft" });
  assert.deepEqual(A.canDiscard({ generating: true }, {}), { ok: false, reason: "generating" });
  assert.deepEqual(A.canDiscard({ draft: true, generating: true }, {}), { ok: false, reason: "generating" });
  assert.equal(A.canDiscard({ draft: true }, { force: true }).ok, true);
  assert.deepEqual(A.canDiscard({}, { active: true }), { ok: false, reason: "active" });
  assert.deepEqual(A.canDiscard({}, { audible: true }), { ok: false, reason: "audible" });
  assert.deepEqual(A.canDiscard({}, { discarded: true }), { ok: false, reason: "discarded" });
  assert.equal(A.canDiscard({ draft: true }, { force: true, active: true }).ok, false, "force never overrides the active tab");
});

test("burstCount: counts the cluster of accepted requests ending now, ignoring older ones", () => {
  assert.equal(A.burstCount([], 1000), 0);
  assert.equal(A.burstCount([100, 110, 120], 130), 3);
  assert.equal(A.burstCount([100, 3000, 3010, 3020], 3030), 3, "an older lone request does not inflate the burst");
  assert.equal(A.burstCount([100, 110], 5000), 0, "nothing recent -> no evidence");
});

test("isCalm: quiet only when no cooldown, no recent 429 and nobody is loading history", () => {
  const now = 100000;
  const quiet = [{ id: "detail", cd: 0, last429: 0, starts: [] }, { id: "stream", cd: 0, last429: 0, starts: [now - 500] }];
  assert.equal(A.isCalm(quiet, now, { calmMs: 30000 }), true);
  assert.equal(A.isCalm([{ id: "detail", cd: now + 5000, last429: 0, starts: [] }], now), false, "cooldown active");
  assert.equal(A.isCalm([{ id: "list", cd: 0, last429: now - 10000, starts: [] }], now, { calmMs: 30000 }), false, "429 10 s ago");
  assert.equal(A.isCalm([{ id: "list", cd: 0, last429: now - 40000, starts: [] }], now, { calmMs: 30000 }), true, "429 40 s ago is old enough");
  assert.equal(A.isCalm([{ id: "detail", cd: 0, last429: 0, starts: [now - 1000, now - 2000] }], now), false, "history is being loaded right now");
});

test("pickHealTarget: one tab at a time, active first, spaced, bounded", () => {
  const now = 1000000;
  const tabs = [
    { id: 1, active: false, failedAt: now - 60000, heals: 0, lastHealAt: 0 },
    { id: 2, active: true, failedAt: now - 20000, heals: 0, lastHealAt: 0 },
    { id: 3, active: false, failedAt: now - 90000, heals: 0, lastHealAt: 0 }
  ];
  const ctx = { calm: true, now, lastHealAny: 0 };
  assert.equal(A.pickHealTarget(tabs, ctx), 2, "the tab you are looking at first");
  assert.equal(A.pickHealTarget(tabs, Object.assign({}, ctx, { calm: false })), null, "never when not calm");
  assert.equal(A.pickHealTarget(tabs, Object.assign({}, ctx, { lastHealAny: now - 5000 })), null, "global spacing between heals");
  const without2 = tabs.filter(t => t.id !== 2);
  assert.equal(A.pickHealTarget(without2, ctx), 3, "then the oldest failure");
  assert.equal(A.pickHealTarget([{ id: 9, active: true, failedAt: now - 1000, heals: 0 }], ctx), null, "a fresh failure settles first");
  assert.equal(A.pickHealTarget([{ id: 9, active: true, failedAt: now - 60000, heals: 1, lastHealAt: now - 10000 }], ctx), null, "per-tab backoff after a heal");
  assert.equal(A.pickHealTarget([{ id: 9, active: true, failedAt: now - 600000, heals: 1, lastHealAt: now - 40000 }], ctx), 9, "...and allowed again after the backoff");
  assert.equal(A.pickHealTarget([{ id: 9, active: true, failedAt: now - 600000, heals: 4, lastHealAt: 0 }], ctx), null, "gives up after maxHeals");
});

test("isHealableStatus: transient failures only", () => {
  assert.equal(A.isHealableStatus(429), true);
  assert.equal(A.isHealableStatus(503), true);
  assert.equal(A.isHealableStatus(0), true);
  assert.equal(A.isHealableStatus(404), false);
  assert.equal(A.isHealableStatus(403), false);
});

test("versionGreater: numeric component-wise comparison, junk never wins", () => {
  assert.equal(A.versionGreater("0.4.2", "0.4.1"), true);
  assert.equal(A.versionGreater("0.4.10", "0.4.2"), true);
  assert.equal(A.versionGreater("1.0", "0.9.9"), true);
  assert.equal(A.versionGreater("0.4.1", "0.4.1"), false);
  assert.equal(A.versionGreater("0.4.0", "0.4.1"), false);
  assert.equal(A.versionGreater("0.4.2", "0.4.2.0"), false);
  assert.equal(A.versionGreater("", "0.4.1"), false);
  assert.equal(A.versionGreater(undefined, "0.4.1"), false);
  assert.equal(A.versionGreater("0.4.x", "0.4.1"), false);
});

test("shouldAutoStop: conservative - needs opt-in, a dead stream, long IS_STREAMING and a cooldown", () => {
  const now = 10 * 3600 * 1000;
  const base = { status: "IS_STREAMING", since: now - 50 * 60000, dead: true, lastStopAt: 0 };
  assert.equal(A.shouldAutoStop(base, now, { autoStop: true, autoStopMin: 45 }), true);
  assert.equal(A.shouldAutoStop(base, now, { autoStop: false }), false, "off by default");
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { dead: false }), now, { autoStop: true }), false, "resume still works -> maybe alive");
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { since: now - 10 * 60000 }), now, { autoStop: true, autoStopMin: 45 }), false, "not long enough");
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { status: "COMPLETE" }), now, { autoStop: true }), false);
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { status: "IS_STOP_REQUESTED" }), now, { autoStop: true }), false, "already asked to stop");
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { lastStopAt: now - 3600 * 1000 }), now, { autoStop: true }), false, "stop cooldown");
  assert.equal(A.shouldAutoStop(Object.assign({}, base, { lastStopAt: now - 7 * 3600 * 1000 }), now, { autoStop: true }), true, "allowed again after the cooldown");
});

test("reaperVerdict: stop only for IS_STREAMING + frozen update_time + idle + confirmed twice", () => {
  const now = 100 * 3600000, H = 3600000;
  const cfg = { idleMs: 30 * 60000, confirmMs: 10 * 60000 };
  const zombie = { status: "IS_STREAMING", updMs: now - 5 * H };
  let v = A.reaperVerdict(null, zombie, now, cfg);
  assert.equal(v.action, "watch"); assert.equal(v.reason, "first-sight");
  v = A.reaperVerdict(v.rec, zombie, now + 5 * 60000, cfg);
  assert.equal(v.reason, "confirming", "needs confirmMs between the two checks");
  v = A.reaperVerdict(v.rec, zombie, now + 11 * 60000, cfg);
  assert.equal(v.action, "stop"); assert.equal(v.reason, "stagnant");
  // a live run moves update_time: the clock restarts and it is never stopped
  const live = A.reaperVerdict({ status: "IS_STREAMING", updMs: now - 5 * H, since: now - 20 * 60000 }, { status: "IS_STREAMING", updMs: now - 60000 }, now, cfg);
  assert.equal(live.action, "watch"); assert.equal(live.reason, "recently-active");
  // changed update_time -> restart even if idle
  const moved = A.reaperVerdict({ status: "IS_STREAMING", updMs: now - 6 * H, since: now - 3 * H }, { status: "IS_STREAMING", updMs: now - 5 * H }, now, cfg);
  assert.equal(moved.reason, "first-sight");
  assert.equal(moved.rec.since, now);
});

test("reaperVerdict: completed / stop-requested / other states / visible generation / unknown update_time", () => {
  const now = 100 * 3600000, cfg = { idleMs: 1000, confirmMs: 1000 };
  assert.equal(A.reaperVerdict({ status: "IS_STREAMING", updMs: 1, since: 1 }, { status: "COMPLETE", updMs: 1 }, now, cfg).action, "clear");
  assert.equal(A.reaperVerdict(null, { status: "IS_STOP_REQUESTED", updMs: now }, now, cfg).action, "stopping");
  assert.equal(A.reaperVerdict(null, { status: "WHATEVER", updMs: 1 }, now, cfg).action, "clear");
  const gen = A.reaperVerdict({ status: "IS_STREAMING", updMs: 5, since: 1 }, { status: "IS_STREAMING", updMs: 5, generatingTab: true }, now, cfg);
  assert.equal(gen.action, "watch"); assert.equal(gen.reason, "visible-generation");
  const unk = A.reaperVerdict({ status: "IS_STREAMING", updMs: 0, since: 1 }, { status: "IS_STREAMING", updMs: 0 }, now, cfg);
  assert.equal(unk.action, "watch"); assert.equal(unk.reason, "no-update-time", "never stops without a known update_time");
});

test("runVerdict: async_status 3 + not streaming = a live run; stale update_time = stalled; leaving 3 = done", () => {
  const now = 100 * 3600000, cfg = { runStaleMs: 15 * 60000 };
  let v = A.runVerdict(null, { a: 3, status: "COMPLETE", updMs: now - 20000 }, now, cfg);
  assert.equal(v.action, "live");
  assert.equal(v.rec.firstSeen, now);
  const first = v.rec;
  v = A.runVerdict(first, { a: 3, status: "COMPLETE", updMs: now + 60000 - 5000 }, now + 60000, cfg);
  assert.equal(v.action, "live"); assert.equal(v.rec.firstSeen, now, "firstSeen is kept");
  assert.equal(v.rec.lastMoveAt, now + 60000, "update_time moved -> lastMoveAt advanced");
  v = A.runVerdict(first, { a: 3, status: "COMPLETE", updMs: now - 20000 }, now + 20 * 60000, cfg);
  assert.equal(v.action, "stalled", "update_time frozen for 20 min");
  v = A.runVerdict(first, { a: 4, status: "COMPLETE", updMs: now + 90000 }, now + 120000, cfg);
  assert.equal(v.action, "done");
  assert.equal(A.runVerdict(null, { a: 4, status: "COMPLETE", updMs: now }, now, cfg).action, "ignore", "a finished chat we never watched is not 'done'");
});

test("runVerdict: IS_STREAMING is the zombie domain, never a run; unseen runs are kept 30 min then forgotten", () => {
  const now = 100 * 3600000;
  assert.equal(A.runVerdict(null, { a: 3, status: "IS_STREAMING", updMs: now - 5 * 3600000 }, now, {}).action, "ignore");
  const prev = { firstSeen: now - 600000, lastU: now - 70000, lastSeen: now - 60000, lastMoveAt: now - 70000 };
  assert.equal(A.runVerdict(prev, null, now, {}).action, "unknown");
  assert.equal(A.runVerdict(prev, null, now + 40 * 60000, {}).action, "forget");
  assert.equal(A.runVerdict(null, null, now, {}).action, "ignore");
});

test("isCalm: a long streak of 429s lengthens the quiet period (no poking a blocked account)", () => {
  const now = 10 * 3600000;
  const fam = (n, ago) => [{ id: "detail", cd: 0, last429: now - ago, starts: [], c429: Array.from({ length: n }, (_, i) => now - ago - i * 1000) }];
  assert.equal(A.isCalm(fam(1, 40000), now, { calmMs: 30000 }), true, "one 429, 40 s ago: calm");
  assert.equal(A.isCalm(fam(9, 120000), now, { calmMs: 30000 }), false, "nine 429s, last 2 min ago: not calm yet");
  assert.equal(A.isCalm(fam(9, 11 * 60000), now, { calmMs: 30000 }), true, "quiet for 11 min: calm again (cap 10 min)");
});
