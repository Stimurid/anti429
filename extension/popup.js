// 4̅2̅9̅ panel. All text from tabs is inserted via textContent (chat titles are untrusted data).
"use strict";
const A = self.A429;
const MODE = new URLSearchParams(location.search).get("mode") || "popup"; // popup | window | panel
document.documentElement.dataset.mode = MODE;
const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

// Every button answers a press (2026-10-26, owner: "I press and have no idea whether it worked"): it turns busy at
// once, and when the action ends a line at the bottom says what happened. A handler may return the text to show,
// or false when the owner cancelled it in a confirm dialog (then nothing is reported).
let toastTimer = null;
function toast(text, failed) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = text; t.className = failed ? "show failed" : "show";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, failed ? 7000 : 4500);
}
function press(btn, fn) {
  return async e => {
    if (btn.dataset.busy) return;
    const label = btn.textContent.trim();
    btn.dataset.busy = "1"; btn.classList.add("busy"); btn.setAttribute("aria-busy", "true");
    const t0 = Date.now();
    let msg, failed = false;
    try { msg = await fn(e); } catch (err) { failed = true; msg = String((err && err.message) || err); }
    setTimeout(() => { // let the press be seen even when the action is instant
      delete btn.dataset.busy; btn.classList.remove("busy"); btn.removeAttribute("aria-busy");
      if (msg === false) return;
      toast((failed ? "✕ " : "✓ ") + (typeof msg === "string" && msg ? msg : label + ": готово"), failed);
      if (btn.isConnected) { btn.classList.add(failed ? "failed" : "done"); setTimeout(() => btn.classList.remove("done", "failed"), 1600); }
    }, Math.max(0, 350 - (Date.now() - t0)));
  };
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "onclick" && tag === "button") n.addEventListener("click", press(n, v));
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}
const plural = (n, one, few, many) => { const m = n % 100, d = n % 10; return `${n} ${m > 10 && m < 15 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many}`; };

let snap = null;
let tabsNow = [];
let curTabId = null; // the tab the owner is looking at (active tab of the last focused normal window)
let states = [];     // per tab: { t, s, sev, text, extra, primary }
let lastSig = "";
const statusNote = {}; // tabId -> { text, at }: the last "what does the server say" answer for a tab

const convOf = u => { const m = String(u || "").split("/c/")[1]; return m ? m.split(/[/?#]/)[0] : null; };
function tabLabel(t) { return (t.title || t.url || "").replace(/^ChatGPT\s*[-–—]?\s*/i, "") || t.url; }

function explainStatus(r) {
  if (!r) return "вкладка не ответила";
  if (r.reason === "no-bridge") return "расширение не подключено к этой вкладке: нажмите «Защитить открытые»";
  if (r.reason) return "не получилось узнать (" + r.reason + ")";
  if (r.http === 429) return "сервер просит подождать" + (r.retryAfter ? " " + r.retryAfter + " с" : "") + ". Пока ничего не нажимайте и не перезагружайте.";
  if (!r.ok) return "сервер ответил ошибкой " + r.http + ". Попробуйте через пару минут.";
  if (r.status === "IS_STREAMING") return "сервер ещё работает над ответом. Страница потеряла с ним связь, но ответ не пропал. Если так уже давно и чат не меняется, он, скорее всего, завис: тогда «Остановить ответ» в меню ⋯.";
  if (r.status === "IS_STOP_REQUESTED") return "остановка принята, сервер заканчивает работу. Подождите несколько минут.";
  if (r.status === "COMPLETE") return "сервер уже закончил отвечать, ответ готов. Застряла только эта страница: нажмите «Перезапустить», она загрузится заново и покажет ответ.";
  return "сервер сообщил: " + r.status;
}

// ---- what is going on with one tab, in plain words ----
function tabState(t) {
  const s = snap.tabs[t.id] || { req60: 0, fam60: {}, mb10: 0, c429_10: 0, held: 0, loop: false, streaming: -1, stopReq: -1 };
  const run = snap.reaper && snap.reaper.runs.find(x => x.id === convOf(t.url));
  const hot = s.c429_10 >= (snap.cfg.hibernate429 || 40);
  const extras = [];
  if (s.generating && !(s.interrupted >= 0)) extras.push("идёт ответ");
  if ((s.generating || s.interrupted >= 0) && s.answerQuietMin >= 2) extras.push(`ответ на странице не менялся ${s.answerQuietMin} мин`);
  if (s.draft) extras.push("в поле ввода есть неотправленный текст");
  if (s.held) extras.push(`запросов придержано: ${s.held}`);
  if (s.recovered) extras.push(`поток восстановлен ${s.recovered} раз`);
  // how long ago the SERVER last changed this chat (from the background-runs audit): the only honest sign that a long
  // agent answer is still alive when the page itself shows "Connection interrupted" (2026-10-26)
  const srvAgo = run && run.idleSec != null ? (run.idleSec < 90 ? `${run.idleSec} с` : `${Math.round(run.idleSec / 60)} мин`) : "";
  if (srvAgo) extras.push(`на сервере чат обновлялся ${srvAgo} назад`);
  const base = { t, s, extra: extras.join(" · ") };
  const bad = (text, primary) => Object.assign(base, { sev: "bad", text, primary });
  const warn = (text, primary) => Object.assign(base, { sev: "warn", text, primary });
  const ok = text => Object.assign(base, { sev: "ok", text, primary: null });
  if (t.discarded) return Object.assign(ok("Спит: страница выгружена из памяти, загрузится при открытии."), { sleeping: true });
  if (s.broken) return bad(`Страница не загрузилась (сервер ответил ${s.broken.status}). Расширение попробует снова, когда сервер спокоен${s.broken.heals ? `; попыток: ${s.broken.heals}` : ""}.`, { label: "Повторить", act: "heal" });
  // checked before "knocks too often": a page that lost its answer polls the server while it waits, and restarting
  // it does not help (the answer is produced on the server either way)
  if (s.interrupted >= 0) return warn(`Связь с ответом оборвалась${s.interrupted ? " " + s.interrupted + " мин назад" : ""} («Connection interrupted»): кнопка остановки видна, но страница ответа не получает и сама опрашивает сервер — перезапуск не поможет. ${srvAgo ? (run.state === "live" ? "Сервер ещё работает над чатом — подождите." : "Сервер давно не менял чат — скорее всего, завис: остановите ответ в меню ⋯.") : "Спросите сервер: если ответ готов, обновите вкладку."}`, { label: "Что на сервере?", act: "status" });
  if (s.loop || hot) return bad(`Слишком часто стучится на сервер: ${s.req60} запросов в минуту${hot ? `, отказов за 10 минут: ${s.c429_10}` : ""}. Лучше перезапустить.`, { label: "Перезапустить", act: "restart" });
  if (s.deadStream) return warn("Ответ завис на сервере. Расширение сказало странице, что он закончился, чтобы она не долбила сервер. Снимется само через 20 минут.", { label: "Снять", act: "undead" });
  if (s.streaming >= 10) return warn(`Сервер уже ${s.streaming} мин пишет ответ. Если чат давно не менялся, он завис: спросите сервер кнопкой «Что на сервере?».`, { label: "Что на сервере?", act: "status" });
  if (s.stopReq >= 0) return warn("Остановка принята, сервер заканчивает работу. Подождите несколько минут.", null);
  if (run && run.state === "stalled") return warn("Фоновая работа давно не обновлялась: возможно, она остановилась.", { label: "Что на сервере?", act: "status" });
  if (run && run.state === "live") return ok("Работает на сервере в фоне. Страница может писать «Message delivery timed out»: это нормально, не нажимайте Retry.");
  if (!s.guard) return warn("Расширение не следит за этой вкладкой.", { label: "Защитить открытые", act: "protect" });
  return ok("В порядке.");
}

// ---- header: one sentence about the whole state ----
function renderHeader() {
  const open = tabsNow.length > 0;
  const worst = snap.fams.slice().sort((a, b) => b.ratio - a.ratio)[0];
  const cd = snap.fams.find(r => r.cooling);
  const bads = states.filter(x => x.sev === "bad").length;
  const warns = states.filter(x => x.sev === "warn").length;
  let cls = "idle", main, sub;
  if (!open) { main = "Нет вкладок ChatGPT"; sub = "Откройте chatgpt.com, и я начну следить."; }
  else if (cd) { cls = "bad"; main = `Сервер просит подождать ${Math.ceil(cd.cooldownMs / 1000)} с`; sub = "Запросы придержаны. Пока ничего не перезагружайте."; }
  else if (bads) { cls = "bad"; main = `Нужно внимание: ${plural(bads, "вкладка", "вкладки", "вкладок")}`; sub = warns ? `и ещё замечаний: ${warns}` : "Подробности ниже."; }
  else if (warns) { cls = "warn"; main = `Есть замечания: ${warns}`; sub = "Ничего срочного, подробности ниже."; }
  else { cls = "calm"; main = "Всё спокойно"; sub = "Ограничений нет, вкладки в порядке."; }
  $("top").className = "state-" + (cls === "idle" ? "idle" : cls);
  $("summary").textContent = main;
  $("summarySub").textContent = open ? `${sub} · нагрузка на лимит ${Math.round(worst.ratio * 100)}% · вкладок: ${tabsNow.length}` : sub;
}

// ---- one tab card ----
function actionBtn(t, s, p) {
  const act = {
    heal: async () => { await send({ type: "healNow", id: t.id }); refresh(true); return "Повторная загрузка вкладки запущена"; },
    status: async () => { const r = await send({ type: "chatStatus", id: t.id }); statusNote[t.id] = { text: explainStatus(r), at: Date.now() }; refresh(true); return "Сервер: " + explainStatus(r); },
    undead: async () => { await send({ type: "undead", id: t.id }); refresh(true); },
    protect: async () => { await send({ type: "protectTabs" }); setTimeout(() => refresh(true), 1200); },
    restart: () => restartTab(t, s)
  }[p.act];
  return el("button", { class: "small", text: p.label, onclick: act });
}

async function restartTab(t, s) {
  let r = await send({ type: "restart", id: t.id });
  if (r && !r.ok && (r.reason === "draft" || r.reason === "generating")) {
    if (!confirm(r.reason === "generating" ? "В этой вкладке идёт ответ. Перезапуск прервёт его отображение. Перезапустить?" : "В этой вкладке есть неотправленный текст. Он может пропасть. Перезапустить?")) return false;
    r = await send({ type: "restart", id: t.id, force: true });
  }
  refresh(true);
  if (!r || !r.ok) throw new Error("Перезапуск не получился: " + ((r && r.reason) || "нет ответа"));
  return "Вкладка выгружена и загрузится сама, когда сервер спокоен";
}

function card(x, calm) {
  const { t, s } = x;
  const here = t.id === curTabId;
  const cardEl = el("div", { class: `tab sev-${x.sev}${x.sleeping ? " disc" : ""}${here ? " cur" : ""}${calm ? " calm" : ""}` });
  const title = el("div", { class: "t", title: t.title || t.url, onclick: () => send({ type: "focus", id: t.id }) });
  if (here) title.append(el("span", { class: "here", text: "вы здесь" }));
  if (s.project) title.append(el("span", { class: "proj", text: s.project, title: "проект" }));
  title.append(tabLabel(t));
  cardEl.append(title);
  cardEl.append(el("div", { class: "st" }, x.text, x.extra ? el("span", { class: "dim", text: "  ·  " + x.extra }) : null));

  const acts = el("div", { class: "acts" });
  if (x.primary) acts.append(actionBtn(t, s, x.primary));
  acts.append(el("button", { class: "small ghost", text: "Показать", title: "Перейти к этой вкладке (в её окне)", onclick: () => send({ type: "focus", id: t.id }) }));
  if (!x.primary || x.primary.act !== "status") {
    acts.append(el("button", { class: "small ghost", text: "Что на сервере?", title: "Один запрос: что сервер сообщает о чате этой вкладки",
      onclick: async () => { const r = await send({ type: "chatStatus", id: t.id }); statusNote[t.id] = { text: explainStatus(r), at: Date.now() }; refresh(true); return "Сервер: " + explainStatus(r); } }));
  }
  const menu = el("div", { class: "menu" });
  const m = (label, fn, cls) => menu.append(el("button", { class: cls || "", text: label, onclick: fn }));
  if (!x.primary || x.primary.act !== "restart") m("Перезапустить: выгрузить и сама загрузится", () => restartTab(t, s));
  const canDiscard = !t.active && !t.discarded;
  if (canDiscard) m("Выгрузить из памяти", async () => {
    const risky = s.draft || s.generating;
    if (risky && !confirm(s.generating ? "В этой вкладке идёт ответ. Выгрузка прервёт его отображение. Всё равно?" : "В этой вкладке есть неотправленный текст. Он может пропасть. Всё равно?")) return false;
    const r = await send({ type: "discard", ids: [t.id], force: risky }); refresh(true);
    if (!r || !(r.discarded || []).length) throw new Error("Вкладку не удалось выгрузить" + (r && r.skipped && r.skipped[0] ? ": " + r.skipped[0].reason : ""));
    return "Вкладка выгружена из памяти";
  });
  if (s.broken && (!x.primary || x.primary.act !== "heal")) m("Повторить загрузку сейчас", async () => { await send({ type: "healNow", id: t.id }); refresh(true); });
  if (s.streaming >= 0 || s.stopReq >= 0) m("Остановить ответ на сервере", async () => {
    if (!confirm("Остановить генерацию в этом чате на сервере?\n\nЕсли там идёт настоящая задача, а не зависший ответ, она будет прервана.\n\nСервер освобождает чат не сразу: статус «остановка запрошена» может держаться несколько минут.")) return false;
    const r = await send({ type: "stopStream", id: t.id });
    refresh(true);
    if (!r || !r.ok) throw new Error("Остановку отправить не удалось: " + ((r && (r.reason || r.http)) || "нет ответа"));
    return "Остановка отправлена, сервер её принял";
  }, "dangerous");
  if (!s.deadStream && s.streaming >= 0) m("Считать ответ зависшим (20 мин)", async () => { await send({ type: "markDead", id: t.id }); refresh(true); });
  if (s.deadStream && (!x.primary || x.primary.act !== "undead")) m("Снять пометку «зависший»", async () => { await send({ type: "undead", id: t.id }); refresh(true); });
  m("Закрыть вкладку", async () => { await send({ type: "close", id: t.id }); refresh(true); }, "dangerous");
  acts.append(el("details", { class: "more" }, el("summary", { text: "⋯", title: "Ещё действия" }), menu));
  cardEl.append(acts);

  const det = (s.fam60.detail || 0) + (s.fam60.legacy || 0);
  cardEl.append(el("div", { class: "meta", text: `${s.req60} запр/мин · история ${det} · ответ ${s.fam60.stream || 0} · ${s.mb10} МБ/10 мин${s.c429_10 ? ` · отказов ${s.c429_10}` : ""}` }));
  const sn = statusNote[t.id];
  if (sn && Date.now() - sn.at < 10 * 60000) {
    const ago = Math.floor((Date.now() - sn.at) / 60000);
    cardEl.append(el("div", { class: "srv", text: `Сервер (проверено в ${new Date(sn.at).toTimeString().slice(0, 5)}, ${ago ? ago + " мин назад" : "только что"}): ${sn.text}` }));
  }
  return cardEl;
}

function renderTabs() {
  const attn = $("attn"), box = $("tabs");
  attn.replaceChildren(); box.replaceChildren();
  const cur = x => (x.t.id === curTabId ? 1 : 0);
  const sorted = states.slice().sort((a, b) => cur(b) - cur(a) || (b.s.req60 - a.s.req60) || (b.s.mb10 - a.s.mb10));
  const needs = sorted.filter(x => x.sev !== "ok");
  const calm = sorted.filter(x => x.sev === "ok");
  $("attnSec").hidden = !needs.length;
  $("attnCount").textContent = needs.length ? `(${needs.length})` : "";
  for (const x of needs) attn.append(card(x, false));
  $("tabCount").textContent = `${tabsNow.length} шт.`;
  const VISIBLE = 6;
  calm.slice(0, VISIBLE).forEach(x => box.append(card(x, true)));
  if (calm.length > VISIBLE) {
    const rest = el("div", { class: "tabs", style: "margin-top:7px" });
    calm.slice(VISIBLE).forEach(x => rest.append(card(x, true)));
    box.append(el("details", { class: "sec" }, el("summary", { class: "", text: `Остальные вкладки: ${calm.length - VISIBLE}` }), el("div", { class: "s-body" }, rest)));
  }
  if (!states.length) box.append(el("p", { class: "note", text: "Открытых вкладок chatgpt.com нет." }));
}

// ---- sections ----
function renderMeters() {
  const box = $("meters");
  box.replaceChildren();
  for (const r of snap.fams) {
    const fam = A.FAMILIES.find(f => f.id === r.id);
    const pct = Math.min(100, Math.round(r.ratio * 100));
    const bar = el("div", { class: "bar" }, el("i", { class: r.level === "green" ? "" : r.level, style: `width:${pct}%` }));
    const val = el("div", { class: "val" });
    if (r.cooling) val.append(el("span", { class: "cd", text: `блок ${Math.ceil(r.cooldownMs / 1000)} с` }));
    else val.append(`${r.count} из ${r.ceil}${r.learned ? "" : "~"}`);
    if (r.c429_10m) val.append(el("span", { class: "n429", text: `отказов за 10 мин: ${r.c429_10m}` }));
    box.append(el("div", { class: "meter", title: fam.hint }, el("div", { class: "name", text: fam.label }), bar, val));
  }
  const learned = snap.fams.some(r => r.learned);
  $("meterNote").textContent = learned ? "Пороги частично выучены по настоящим отказам сервера." : "Пороги пока предположение (~): настоящего отказа ещё не было.";
  const cd = snap.fams.find(r => r.cooling);
  const worst = snap.fams.slice().sort((a, b) => b.ratio - a.ratio)[0];
  $("meterSum").textContent = cd ? `блок ${Math.ceil(cd.cooldownMs / 1000)} с` : `нагрузка ${Math.round(worst.ratio * 100)}% порога`;
  if (cd || worst.ratio >= 0.6) $("secMeters").open = true;
}

function renderJournal() {
  const box = $("jrBox");
  const hh = t => new Date(t).toTimeString().slice(0, 8);
  const line = e => {
    if (e.e === "429") return `${hh(e.t)} отказ сервера (${e.fam}) · вкладка ${e.tab} · принято до отказа ${e.acc} · ждать ${e.ra == null ? "?" : e.ra + " с"} · за 10 мин: ${e.n10}`;
    if (e.e === "min") return `${hh(e.t)} за минуту: ${Object.entries(e.fam).map(([k, v]) => k + " " + v).join(", ") || "запросов нет"} · загрузок вкладок ${e.loads} · придержано ${e.held}` + (e.top.length ? " · больше всего: " + e.top.map(x => `«${x.t}» ${x.req}`).join("; ") : "") + (e.other && e.other.length ? " · прочий трафик: " + e.other.map(x => `${x[0]} ×${x[1]}`).join("; ") : "");
    if (e.e === "chrome-start") return `${hh(e.t)} ЗАПУСК Chrome: вкладок ChatGPT ${e.tabs}, спящих ${e.discarded}`;
    if (e.e === "installed") return `${hh(e.t)} расширение (пере)установлено, вкладок ${e.tabs}`;
    if (e.e === "tab-new") return `${hh(e.t)} НОВАЯ вкладка ${e.tab} · окно ${e.win} · группа ${e.grp} · ${e.opener ? "открыта со страницы вкладки " + e.opener : "открыта программно, без родителя"}${e.active ? " · забрала фокус" : ""} · ${e.u}`;
    if (e.e === "tab-storm") return `${hh(e.t)} ШТОРМ вкладок: ${e.n} новых за 3 мин`;
    if (e.e === "heal-pause") return `${hh(e.t)} оживление дало ещё один отказ (подряд: ${e.streak}): пауза всех оживлений ${e.min} мин`;
    if (e.e === "hib") return `${hh(e.t)} вкладка ${e.tab} усыплена (отказов: ${e.n})`;
    if (e.e === "heal") return `${hh(e.t)} оживляю вкладку ${e.tab}${e.manual ? " (вручную)" : ""}, попытка ${e.n}`;
    if (e.e === "restart-queued") return `${hh(e.t)} вкладка ${e.tab} поставлена в очередь на перезапуск (${e.why})`;
    if (e.e === "err") return `${hh(e.t)} ошибка: ${e.what} · ${e.m} ${e.p}${e.tab != null ? " · вкладка " + e.tab : ""}`;
    if (e.e === "ui-error") return `${hh(e.t)} на странице «This response couldn't load» · вкладка ${e.tab}${e.title ? " «" + e.title + "»" : ""}`;
    if (e.e === "hot-hold") return `${hh(e.t)} сервер отказывает подряд (${e.streak}): запросы «${e.fam}» придержаны на ${e.min} мин`;
    if (e.e === "restart") return `${hh(e.t)} вкладка ${e.tab} перезапущена`;
    return `${hh(e.t)} ${e.e}`;
  };
  box.textContent = (snap.journal || []).slice(-25).reverse().map(line).join("\n") || "пока пусто";
}

function renderHib() {
  const box = $("hibBox"), list = snap.hib || [];
  $("hibSec").hidden = !list.length;
  box.replaceChildren();
  for (const h of list.slice(0, 6)) {
    const ago = Math.round((Date.now() - h.at) / 60000);
    box.append(el("div", { class: "sess" },
      el("span", { text: `${h.t} · ${ago} мин назад · отказов ${h.n}`, title: h.url }),
      el("button", { class: "small ghost", text: "Показать", onclick: () => send({ type: "focus", id: h.id }) })));
  }
}

async function openChat(id, g) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const t = tabs.find(x => String(x.url).includes("/c/" + id));
  if (t) await send({ type: "focus", id: t.id });
  else chrome.tabs.create({ url: "https://chatgpt.com/" + (g ? "g/" + g + "/" : "") + "c/" + id });
}

function renderRuns() {
  const r = snap.reaper;
  if (!r) return;
  const live = r.runs.filter(x => x.state === "live").length;
  const stalled = r.runs.filter(x => x.state === "stalled").length;
  $("runsLine").textContent = r.runs.length
    ? `работают: ${live}` + (stalled ? ` · давно не обновлялись: ${stalled}` : "") + (r.done.length ? ` · недавно завершено: ${r.done.length}` : "")
    : "Сейчас фоновых прогонов нет" + (r.done.length ? ` · недавно завершено: ${r.done.length}` : "");
  $("runsSum").textContent = r.runs.length ? `работают ${live}` + (stalled ? `, застряли ${stalled}` : "") : "нет";
  const box = $("runsBox");
  box.replaceChildren();
  for (const x of r.runs) {
    const when = x.idleSec == null ? "" : x.idleSec < 90 ? `обновлён ${x.idleSec} с назад` : `обновлён ${Math.round(x.idleSec / 60)} мин назад`;
    box.append(el("div", { class: "sess" },
      el("span", x.state === "leftover" ? { class: "note", text: `Закончено давно (сервер не снял пометку «фоновая работа»): ${x.t || "(без названия)"} · ${when}` }
        : { text: `${x.state === "live" ? "Работает" : "Застряло?"}: ${x.t || "(без названия)"} · ${when}` }),
      el("button", { class: "small ghost", text: "Открыть", onclick: () => openChat(x.id, x.g) })));
  }
  for (const d of r.done.slice(0, 4)) {
    box.append(el("div", { class: "sess" },
      el("span", { class: "note", text: `Завершено: ${d.t || "(без названия)"} · ${d.agoMin} мин назад` }),
      el("button", { class: "small ghost", text: "Открыть", onclick: () => openChat(d.id, d.g) })));
  }
}

function renderReaper() {
  const r = snap.reaper;
  if (!r) return;
  const bits = [];
  bits.push(r.on ? "авто-режим включён" : "авто-режим выключен");
  bits.push(r.lastAuditAgoSec == null ? "проверок ещё не было" : `последняя проверка ${Math.round(r.lastAuditAgoSec / 60)} мин назад`);
  bits.push(`подозрительных: ${r.watching}`);
  if (r.stopping) bits.push(`останавливается: ${r.stopping}`);
  bits.push(`остановлено сегодня: ${r.stoppedToday}`);
  if (r.lastReqs) bits.push(`проверка стоила ${r.lastReqs} запросов за ${r.lastSec} с`);
  if (r.rateLimited) bits.push("сервер попросил подождать, повтор позже");
  if (r.error) bits.push("нет вкладки для проверки (" + r.error + ")");
  $("reaperLine").textContent = bits.join(" · ");
  $("reaperSum").textContent = r.on ? `включено · остановлено сегодня ${r.stoppedToday}` : "выключено";
  const box = $("reaperLog");
  box.replaceChildren();
  for (const l of r.log) box.append(el("div", { class: "sess" }, el("span", { text: `${l.ok ? "Остановлен" : "Не вышло"}: ${l.t || "(без названия)"}` }), el("span", { class: "note", text: `${l.agoMin} мин назад` })));
}

function renderSessions() {
  const box = $("sessions");
  box.replaceChildren();
  $("sessSum").textContent = (snap.sessions || []).length ? `сохранено: ${(snap.sessions || []).length}` : "";
  for (const s of snap.sessions || []) {
    box.append(el("div", { class: "sess" },
      el("span", { text: `${s.name} · ${s.tabs.length} вкл.`, title: s.tabs.map(t => t.title).join("\n") }),
      el("span", {},
        el("button", { class: "small", text: "Восстановить", title: "Открывать по одной с паузой",
          onclick: async () => { await send({ type: "restore", id: s.id, gapSec: Number($("gap").value) || undefined }); refresh(true); } }),
        " ",
        el("button", { class: "small ghost", text: "✕", onclick: async () => { await send({ type: "deleteSession", id: s.id }); refresh(true); } }))));
  }
  if (snap.restoreQueue) box.append(el("p", { class: "note", text: `В очереди на открытие: ${snap.restoreQueue}` }));
}

// ---- refresh: re-draw only when something changed and no ⋯ menu is open ----
async function refresh(force) {
  try {
    snap = await send({ type: "snapshot" });
    tabsNow = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"], populate: true });
      const a = w && w.tabs && w.tabs.find(x => x.active);
      curTabId = a ? a.id : null;
    } catch { curTabId = null; }
    if (!snap || snap.error) return;
    states = tabsNow.map(tabState);
    renderHeader(); renderMeters(); renderSessions(); renderJournal(); renderHib(); renderRuns(); renderReaper();
    const sig = JSON.stringify([states.map(x => [x.t.id, x.t.title, x.t.active, x.t.discarded, x.sev, x.text, x.extra, x.s.req60, x.s.mb10, x.s.c429_10]), curTabId, Object.keys(statusNote).map(k => statusNote[k].at), Math.floor(Date.now() / 60000)]);
    if (force || (sig !== lastSig && !document.querySelector("details.more[open]"))) { renderTabs(); lastSig = sig; }
    const unprotected = tabsNow.filter(t => !t.discarded && !(snap.tabs[t.id] || {}).guard).length;
    $("btnProtect").hidden = unprotected === 0;
    $("btnProtect").textContent = `Защитить открытые (${unprotected})`;
    if (document.activeElement !== $("gap")) $("gap").value = snap.cfg.restoreGapSec;
    $("chkEnabled").checked = snap.cfg.enabled !== false;
    $("chkHeal").checked = snap.cfg.autoHeal !== false;
    $("chkAutoStop").checked = snap.cfg.autoStop === true;
    $("chkReaper").checked = snap.cfg.reaper !== false;
  } catch {}
}

function showSkipped(res) {
  const n = res && res.skipped ? res.skipped.length : 0;
  const note = $("skipNote");
  if (!n) { note.hidden = true; return; }
  const why = r => ({ draft: "есть неотправленный текст", generating: "идёт ответ", audible: "играет звук", active: "активная" }[r] || r);
  const counts = {};
  for (const s of res.skipped) counts[why(s.reason)] = (counts[why(s.reason)] || 0) + 1;
  note.textContent = `Не тронуто ${n}: ` + Object.entries(counts).map(([k, v]) => `${k} (${v})`).join(", ") + ". Чтобы выгрузить такую вкладку, используйте меню ⋯ на ней.";
  note.hidden = false;
}
$("btnLoops").onclick = async () => {
  const ids = tabsNow.filter(t => !t.active && !t.discarded && (snap.tabs[t.id] || {}).loop).map(t => t.id);
  if (!ids.length) return "Зацикленных вкладок нет";
  const r = await send({ type: "discard", ids }); showSkipped(r);
  refresh(true);
  return `Выгружено вкладок: ${(r && r.discarded || []).length}`;
};
$("btnAll").onclick = async () => {
  const ids = tabsNow.filter(t => !t.discarded);
  if (!ids.length) return "Выгружаемых вкладок нет";
  if (!confirm(`Выгрузить ВСЕ вкладки ChatGPT (${ids.length})? Это остановит вообще все запросы к серверу (страницы, HYDRA, опросы) и освободит память. Неотправленный текст и недописанные ответы в выгруженных вкладках пропадут. Активную вкладку Chrome не даст выгрузить.`)) return false;
  const r = await send({ type: "discardAll" });
  refresh(true);
  const kept = (r && r.kept || []).length;
  return `Выгружено вкладок: ${(r && r.discarded || []).length}` + (kept ? `, осталась активная (${kept})` : "");
};
$("btnBg").onclick = async () => {
  const ids = tabsNow.filter(t => !t.active && !t.discarded && !t.audible).map(t => t.id);
  if (!ids.length) return "Фоновых вкладок для выгрузки нет";
  if (!confirm(`Выгрузить из памяти фоновые вкладки ChatGPT (до ${ids.length})? Вкладки с неотправленным текстом или идущим ответом будут пропущены.`)) {
    const r = await send({ type: "discard", ids }); showSkipped(r); refresh(true);
    return `Выгружено вкладок: ${(r && r.discarded || []).length}`;
  }
  return false;
};
$("btnProtect").onclick = async () => {
  $("btnProtect").disabled = true;
  await send({ type: "protectTabs" });
  setTimeout(() => { $("btnProtect").disabled = false; refresh(true); }, 1200);
};
$("btnSave").onclick = async () => { await send({ type: "saveSession" }); refresh(true); };
$("btnCancel").onclick = async () => { await send({ type: "cancelRestore" }); refresh(true); };
const dock = side => async () => {
  // screen.avail* = usable desktop area of the monitor this window is on (excludes the taskbar)
  const scr = { left: screen.availLeft || 0, top: screen.availTop || 0, width: screen.availWidth, height: screen.availHeight };
  await send({ type: "openWindow", side, screen: scr });
  if (MODE === "popup") window.close();
};
$("btnWinL").onclick = dock("left");
$("btnWinR").onclick = dock("right");
$("btnPanelSide").onclick = () => chrome.tabs.create({ url: "chrome://settings/appearance" });
$("btnPanel").onclick = async () => {
  // sidePanel.open() needs the user gesture of this very click, so it must be called here, not in the worker.
  try {
    const w = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: w.id });
    if (MODE === "popup") window.close();
  } catch (e) { alert("Не удалось открыть боковую панель: " + (e && e.message || e)); }
};
$("btnReset").onclick = async () => { await send({ type: "resetLearned" }); refresh(true); };
$("chkAutoStop").onchange = async e => {
  if (e.target.checked && !confirm("Включить остановку по старому правилу?\n\nРасширение само остановит чаты, у которых сервер сообщает «идёт ответ» не меньше 45 минут И продолжить поток не удаётся. Если там была настоящая долгая задача, она будет прервана.")) { e.target.checked = false; return; }
  await send({ type: "setCfg", patch: { autoStop: e.target.checked } });
};
$("chkReaper").onchange = async e => { await send({ type: "setCfg", patch: { reaper: e.target.checked } }); };
$("btnReaper").onclick = async () => { $("btnReaper").disabled = true; await send({ type: "reaperRun" }); $("btnReaper").disabled = false; refresh(true); };
$("chkHeal").onchange = async e => { await send({ type: "setCfg", patch: { autoHeal: e.target.checked } }); };
$("chkEnabled").onchange = async e => { await send({ type: "setCfg", patch: { enabled: e.target.checked } }); };
$("gap").onchange = async e => { await send({ type: "setCfg", patch: { restoreGapSec: Math.max(3, Number(e.target.value) || 12) } }); };

// static buttons get the same press feedback as the card buttons
for (const b of document.querySelectorAll("button[id]")) if (b.onclick) { const f = b.onclick; b.onclick = null; b.addEventListener("click", press(b, f)); }
refresh(true);
setInterval(() => refresh(false), 1500);
