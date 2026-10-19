// 4̅2̅9̅ popup. All text from tabs is inserted via textContent (chat titles are untrusted data).
"use strict";
const A = self.A429;
const MODE = new URLSearchParams(location.search).get("mode") || "popup"; // popup | window | panel
document.documentElement.dataset.mode = MODE;
const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

let snap = null;
let tabsNow = [];

function renderMeters() {
  const box = $("meters");
  box.replaceChildren();
  for (const r of snap.fams) {
    const fam = A.FAMILIES.find(f => f.id === r.id);
    const pct = Math.min(100, Math.round(r.ratio * 100));
    const bar = el("div", { class: "bar" }, el("i", { class: r.level === "green" ? "" : r.level, style: `width:${pct}%` }));
    const val = el("div", { class: "val" });
    if (r.cooling) val.append(el("span", { class: "cd", text: `блок ${Math.ceil(r.cooldownMs / 1000)}с` }));
    else val.append(`${r.count}/${r.ceil}${r.learned ? "" : "~"}`);
    if (r.c429_10m) val.append(el("div", { class: "note", text: `429 ×${r.c429_10m} за 10 мин` }));
    box.append(el("div", { class: "meter" },
      el("div", { class: "name" }, fam.label, el("em", { text: fam.hint })), bar, val));
  }
  const learned = snap.fams.some(r => r.learned);
  $("meterNote").textContent = learned
    ? "Пороги частично выучены по реальным 429."
    : "Пороги — предположение (~): реальный 429 ещё не пойман.";
}

function tabLabel(t) { return (t.title || t.url || "").replace(/^ChatGPT\s*[-–—]?\s*/i, "") || t.url; }

function renderTabs() {
  const box = $("tabs");
  box.replaceChildren();
  const rows = tabsNow.map(t => {
    const s = snap.tabs[t.id] || { req60: 0, fam60: {}, mb10: 0, c429_10: 0, held: 0, loop: false };
    return { t, s };
  }).sort((a, b) =>
    (b.s.loop - a.s.loop) || (b.s.held - a.s.held) || (b.s.req60 - a.s.req60) || (b.s.mb10 - a.s.mb10));
  $("tabCount").textContent = `${rows.length} шт., ${rows.filter(r => r.s.loop).length} с циклом`;

  for (const { t, s } of rows) {
    const chips = [];
    if (t.active) chips.push(el("span", { class: "chip act", text: "активная" }));
    if (t.discarded) chips.push(el("span", { class: "chip", text: "выгружена" }));
    if (s.loop) chips.push(el("span", { class: "chip warn", text: "цикл?" }));
    if (s.held) chips.push(el("span", { class: "chip hold", text: `⏸ держу ${s.held}` }));
    if (s.draft) chips.push(el("span", { class: "chip draft", text: "✎ черновик", title: "В поле ввода есть неотправленный текст" }));
    if (s.generating) chips.push(el("span", { class: "chip gen", text: "⏵ идёт ответ", title: "Сейчас генерируется ответ" }));
    if (s.recovered) chips.push(el("span", { class: "chip rec", text: `↻ ${s.recovered}`, title: "Сколько раз восстановлен поток после resume-404" }));
    if (s.stopReq >= 0) chips.push(el("span", { class: "chip hold", text: `⏹ стоп запрошен${s.stopReq ? ` ${s.stopReq} мин` : ""}`, title: "Сервер принял «Стоп», но поток ещё не освободил состояние (IS_STOP_REQUESTED)." }));
    const runHere = snap.reaper && snap.reaper.runs.find(x => x.id === convOf(t.url));
    if (runHere) chips.push(el("span", { class: "chip gen", text: runHere.state === "live" ? "⚙ работает на сервере" : "⚙ давно не обновлялся", title: "Фоновый прогон: страница может показывать «delivery timed out», но работа идёт. Не нажимайте Retry." }));
    if (s.deadStream) chips.push(el("span", { class: "chip warn", text: "☠ поток завис: игнорирую", title: "Сервер «ведёт» генерацию, но возобновить её не удаётся (resume 404 несколько раз). Расширение отвечает странице, что поток завершён, чтобы она перестала долбить лимит. Снимается само через 20 минут." }));
    else if (s.streaming >= 10) chips.push(el("span", { class: "chip hold", text: `⏵ поток идёт ${s.streaming} мин`, title: "Сервер уже давно сообщает IS_STREAMING для этого чата: возможно, генерация зависла." }));
    if (s.broken) chips.push(el("span", { class: "chip warn", text: `⚠ не загрузилась${s.broken.heals ? ` · лечу ×${s.broken.heals}` : ""}`, title: `История вернула ${s.broken.status}. Расширение само нажмёт «Try again», когда лимит успокоится.` }));
    if (!t.discarded && !s.guard) chips.push(el("span", { class: "chip noguard", text: "без защиты", title: "Защита не подключена к этой вкладке — нажмите «Защитить открытые вкладки»" }));
    const m = el("div", { class: "m" },
      el("span", { text: `${s.req60} запр/мин` }),
      el("span", { text: `ист ${(s.fam60.detail || 0) + (s.fam60.legacy || 0)} · поток ${s.fam60.stream || 0}` }),
      el("span", { text: `${s.mb10} МБ/10м` }),
      s.c429_10 ? el("span", { text: `429×${s.c429_10}` }) : null,
      ...chips);
    if (s.loop || s.c429_10 >= (snap.cfg.hibernate429 || 40)) { if (t.active && s.c429_10 >= (snap.cfg.hibernate429 || 40)) chips.push(el("span", { class: "chip warn", text: "💤 усну, как только уйдёте с неё", title: "Вкладка зациклилась (много 429). Она активна в каком-то окне Chrome; как только вы переключитесь на другую вкладку, расширение её усыпит." })); }
    const canDiscard = !t.active && !t.discarded;
    const b = el("div", { class: "b" },
      el("button", { class: "small ghost", text: "Показать", title: "Перейти к этой вкладке (в её окне)", onclick: () => send({ type: "focus", id: t.id }) }),
      el("button", { class: "small", text: "Сбросить", disabled: canDiscard ? null : "", title: "Выгрузить содержимое, вкладка останется",
        onclick: async () => {
          const risky = s.draft || s.generating;
          if (risky && !confirm(s.generating
            ? "В этой вкладке идёт ответ. Сброс прервёт его отображение. Всё равно сбросить?"
            : "В этой вкладке есть неотправленный черновик. Он может пропасть. Всё равно сбросить?")) return;
          await send({ type: "discard", ids: [t.id], force: risky });
          refresh();
        } }),
      (s.streaming >= 0 || s.stopReq >= 0) ? el("button", { class: "small", text: "⏹ Остановить поток", title: "Отправить stop_conversation: то же, что кнопка «Стоп» в самом чате. Сервер освобождает чат не сразу: на реальных зависших чатах (6 из 6) статус сначала держится в IS_STOP_REQUESTED (от ~10 минут до получаса), потом становится COMPLETE. Если там идёт настоящая задача, она будет прервана.",
        onclick: async () => {
          if (!confirm("Остановить генерацию в этом чате на сервере?\n\nЕсли там идёт настоящая задача (а не зависший поток), она будет прервана.\n\nЧат освобождается не сразу: статус сначала станет «стоп запрошен» и может держаться несколько минут.")) return;
          const r = await send({ type: "stopStream", id: t.id });
          if (!r || !r.ok) alert("Не получилось отправить «Стоп»: " + ((r && (r.reason || r.http)) || "нет ответа"));
          refresh();
        } }) : null,
      (!s.deadStream && s.streaming >= 0) ? el("button", { class: "small", text: "Считать зависшим", title: "Сервер говорит, что в этом чате идёт генерация. Если она висит часами: пометить поток мёртвым на 20 минут и один раз перезагрузить вкладку. Страница получит «завершено» и откроет чат как обычно.",
        onclick: async () => { await send({ type: "markDead", id: t.id }); refresh(); } }) : null,
      s.deadStream ? el("button", { class: "small ghost", text: "Снять игнор", title: "Перестать подменять статус потока для этой вкладки",
        onclick: async () => { await send({ type: "undead", id: t.id }); refresh(); } }) : null,
      s.broken ? el("button", { class: "small", text: "Повторить", title: "Нажать «Try again» на этой вкладке сейчас",
        onclick: async () => { await send({ type: "healNow", id: t.id }); refresh(); } }) : null,
      el("button", { class: "small ghost", text: "✕", title: "Закрыть вкладку",
        onclick: async () => { await send({ type: "close", id: t.id }); refresh(); } }));
    box.append(el("div", { class: "tab" + (s.loop ? " loop" : "") + (t.discarded ? " disc" : "") },
      el("div", { class: "t", text: tabLabel(t), title: t.title || t.url, onclick: () => send({ type: "focus", id: t.id }) }), b, m));
  }
  if (!rows.length) box.append(el("p", { class: "note", text: "Открытых вкладок chatgpt.com нет." }));
}

const convOf = u => { const m = String(u || "").split("/c/")[1]; return m ? m.split(/[/?#]/)[0] : null; };
async function openChat(id, g) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const t = tabs.find(x => String(x.url).includes("/c/" + id));
  if (t) await send({ type: "focus", id: t.id });
  else chrome.tabs.create({ url: "https://chatgpt.com/" + (g ? "g/" + g + "/" : "") + "c/" + id });
}

function renderJournal() {
  const box = $("jrBox");
  const hh = t => new Date(t).toTimeString().slice(0, 8);
  const line = e => {
    if (e.e === "429") return `${hh(e.t)} 429 ${e.fam} вкладка ${e.tab} · принято до отказа ${e.acc} · retry-after ${e.ra == null ? "?" : e.ra + "с"} · 429 за 10 мин: ${e.n10}`;
    if (e.e === "min") return `${hh(e.t)} за минуту: ${Object.entries(e.fam).map(([k, v]) => k + " " + v).join(", ") || "запросов нет"} · загрузок вкладок ${e.loads} · держу ${e.held}` + (e.top.length ? " · больше всего: " + e.top.map(x => `«${x.t}» ${x.req}`).join("; ") : "");
    if (e.e === "chrome-start") return `${hh(e.t)} ЗАПУСК Chrome: вкладок ChatGPT ${e.tabs}, спящих ${e.discarded}`;
    if (e.e === "installed") return `${hh(e.t)} расширение (пере)установлено, вкладок ${e.tabs}`;
    if (e.e === "hib") return `${hh(e.t)} вкладка ${e.tab} усыплена (${e.n}×429)`;
    if (e.e === "heal") return `${hh(e.t)} оживляю вкладку ${e.tab}${e.manual ? " (вручную)" : ""}, попытка ${e.n}`;
    return `${hh(e.t)} ${e.e}`;
  };
  box.textContent = (snap.journal || []).slice(-25).reverse().map(line).join("\n") ||"пока пусто";
}

function renderHib() {
  const box = $("hibBox"), list = snap.hib || [];
  $("hibSec").hidden = !list.length;
  box.replaceChildren();
  for (const h of list.slice(0, 6)) {
    const ago = Math.round((Date.now() - h.at) / 60000);
    box.append(el("div", { class: "sess" },
      el("span", { text: `💤 ${h.t} · ${ago} мин назад · ${h.n}×429`, title: h.url }),
      el("button", { class: "small ghost", text: "Показать", onclick: () => send({ type: "focus", id: h.id }) })));
  }
}

function renderRuns() {
  const r = snap.reaper;
  if (!r) return;
  const live = r.runs.filter(x => x.state === "live").length;
  const stalled = r.runs.length - live;
  $("runsLine").textContent = r.runs.length
    ? `работают: ${live}` + (stalled ? ` · давно не обновлялись: ${stalled}` : "") + (r.done.length ? ` · недавно завершено: ${r.done.length}` : "")
    : "сейчас нет известных фоновых прогонов" + (r.done.length ? ` · недавно завершено: ${r.done.length}` : "");
  const box = $("runsBox");
  box.replaceChildren();
  for (const x of r.runs) {
    const when = x.idleSec == null ? "" : x.idleSec < 90 ? `обновлён ${x.idleSec} с назад` : `обновлён ${Math.round(x.idleSec / 60)} мин назад`;
    box.append(el("div", { class: "sess" },
      el("span", { text: `${x.state === "live" ? "⚙" : "⚠"} ${x.t || "(без названия)"} · ${when}`, title: x.state === "live" ? "Работа идёт, время обновления двигается" : "Время обновления давно не менялось: возможно, прогон остановился" }),
      el("button", { class: "small ghost", text: "Открыть", onclick: () => openChat(x.id, x.g) })));
  }
  for (const d of r.done.slice(0, 4)) {
    box.append(el("div", { class: "sess" },
      el("span", { class: "note", text: `✓ завершено: ${d.t || "(без названия)"} · ${d.agoMin} мин назад` }),
      el("button", { class: "small ghost", text: "Открыть", onclick: () => openChat(d.id, d.g) })));
  }
}

function renderReaper() {
  const r = snap.reaper;
  if (!r) return;
  const bits = [];
  bits.push(r.on ? "авто-режим включён" : "авто-режим выключен");
  bits.push(r.lastAuditAgoSec == null ? "аудит ещё не было" : `последний аудит ${Math.round(r.lastAuditAgoSec / 60)} мин назад`);
  bits.push(`подозреваю: ${r.watching}`);
  bits.push(`останавливается: ${r.stopping}`);
  bits.push(`остановлено сегодня: ${r.stoppedToday}`);
  if (r.lastReqs) bits.push(`аудит: ${r.lastReqs} запросов за ${r.lastSec} с`);
  if (r.deepAgoH != null) bits.push(`полный обход ${r.deepAgoH} ч назад`);
  if (r.rateLimited) bits.push("лимит ответил 429, повтор позже");
  if (r.error) bits.push("нет вкладки/сессии для аудита (" + r.error + ")");
  $("reaperLine").textContent = bits.join(" · ");
  const box = $("reaperLog");
  box.replaceChildren();
  for (const l of r.log) box.append(el("div", { class: "sess" }, el("span", { text: `${l.ok ? "⏹" : "⚠"} ${l.t || "(без названия)"}` }), el("span", { class: "note", text: `${l.agoMin} мин назад` })));
}

function renderSessions() {
  const box = $("sessions");
  box.replaceChildren();
  for (const s of snap.sessions || []) {
    box.append(el("div", { class: "sess" },
      el("span", { text: `${s.name} · ${s.tabs.length} вкл.`, title: s.tabs.map(t => t.title).join("\n") }),
      el("span", {},
        el("button", { class: "small", text: "Восстановить", title: "Открывать по одной с паузой",
          onclick: async () => { await send({ type: "restore", id: s.id, gapSec: Number($("gap").value) || undefined }); refresh(); } }),
        " ",
        el("button", { class: "small ghost", text: "✕", onclick: async () => { await send({ type: "deleteSession", id: s.id }); refresh(); } }))));
  }
  if (snap.restoreQueue) box.append(el("p", { class: "note", text: `В очереди на открытие: ${snap.restoreQueue}` }));
}

function renderHeader() {
  const open = tabsNow.length > 0;
  const level = open ? snap.overall : "idle";
  $("light").className = "light " + level;
  const worst = snap.fams.slice().sort((a, b) => b.ratio - a.ratio)[0];
  const cd = snap.fams.find(r => r.cooling);
  $("summary").textContent = !open ? "нет вкладок ChatGPT"
    : cd ? `блок ${Math.ceil(cd.cooldownMs / 1000)} с — запросы удерживаются`
    : `загрузка ${Math.round(worst.ratio * 100)}% порога`;
}

async function refresh() {
  try {
    snap = await send({ type: "snapshot" });
    tabsNow = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (!snap || snap.error) return;
    renderHeader(); renderMeters(); renderTabs(); renderSessions(); renderJournal(); renderHib(); renderRuns(); renderReaper();
    const unprotected = tabsNow.filter(t => !t.discarded && !(snap.tabs[t.id] || {}).guard).length;
    $("btnProtect").hidden = unprotected === 0;
    $("btnProtect").textContent = `Защитить открытые вкладки (${unprotected})`;
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
  const why = r => ({ draft: "черновик", generating: "идёт ответ", audible: "звук", active: "активная" }[r] || r);
  const counts = {};
  for (const s of res.skipped) counts[why(s.reason)] = (counts[why(s.reason)] || 0) + 1;
  note.textContent = `Не тронуто ${n}: ` + Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(", ") + ". Чтобы сбросить такую вкладку, нажмите «Сбросить» на ней отдельно.";
  note.hidden = false;
}
$("btnLoops").onclick = async () => {
  const ids = tabsNow.filter(t => !t.active && !t.discarded && (snap.tabs[t.id] || {}).loop).map(t => t.id);
  if (ids.length) showSkipped(await send({ type: "discard", ids }));
  refresh();
};
$("btnBg").onclick = async () => {
  const ids = tabsNow.filter(t => !t.active && !t.discarded && !t.audible).map(t => t.id);
  if (ids.length && confirm(`Выгрузить содержимое фоновых вкладок ChatGPT (до ${ids.length})? Вкладки с черновиком или идущим ответом будут пропущены.`)) {
    showSkipped(await send({ type: "discard", ids }));
  }
  refresh();
};
$("btnProtect").onclick = async () => {
  $("btnProtect").disabled = true;
  await send({ type: "protectTabs" });
  setTimeout(() => { $("btnProtect").disabled = false; refresh(); }, 1200);
};
$("btnSave").onclick = async () => { await send({ type: "saveSession" }); refresh(); };
$("btnCancel").onclick = async () => { await send({ type: "cancelRestore" }); refresh(); };
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
$("btnReset").onclick = async () => { await send({ type: "resetLearned" }); refresh(); };
$("chkAutoStop").onchange = async e => {
  if (e.target.checked && !confirm("Включить авто-стоп?\n\nРасширение само отправит «Стоп» чатам, у которых сервер сообщает «идёт генерация» не меньше 45 минут И продолжить поток не удаётся. Если там была настоящая долгая задача, она будет прервана.")) { e.target.checked = false; return; }
  await send({ type: "setCfg", patch: { autoStop: e.target.checked } });
};
$("chkReaper").onchange = async e => { await send({ type: "setCfg", patch: { reaper: e.target.checked } }); };
$("btnReaper").onclick = async () => { $("btnReaper").disabled = true; await send({ type: "reaperRun" }); $("btnReaper").disabled = false; refresh(); };
$("chkHeal").onchange = async e => { await send({ type: "setCfg", patch: { autoHeal: e.target.checked } }); };
$("chkEnabled").onchange = async e => { await send({ type: "setCfg", patch: { enabled: e.target.checked } }); };
$("gap").onchange = async e => { await send({ type: "setCfg", patch: { restoreGapSec: Math.max(3, Number(e.target.value) || 12) } }); };

refresh();
setInterval(refresh, 1500);
