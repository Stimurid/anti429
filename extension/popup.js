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
    if (!t.discarded && !s.guard) chips.push(el("span", { class: "chip noguard", text: "без защиты", title: "Защита не подключена к этой вкладке — нажмите «Защитить открытые вкладки»" }));
    const m = el("div", { class: "m" },
      el("span", { text: `${s.req60} запр/мин` }),
      el("span", { text: `ист ${(s.fam60.detail || 0) + (s.fam60.legacy || 0)} · поток ${s.fam60.stream || 0}` }),
      el("span", { text: `${s.mb10} МБ/10м` }),
      s.c429_10 ? el("span", { text: `429×${s.c429_10}` }) : null,
      ...chips);
    const canDiscard = !t.active && !t.discarded;
    const b = el("div", { class: "b" },
      el("button", { class: "small", text: "Сбросить", disabled: canDiscard ? null : "", title: "Выгрузить содержимое, вкладка останется",
        onclick: async () => {
          const risky = s.draft || s.generating;
          if (risky && !confirm(s.generating
            ? "В этой вкладке идёт ответ. Сброс прервёт его отображение. Всё равно сбросить?"
            : "В этой вкладке есть неотправленный черновик. Он может пропасть. Всё равно сбросить?")) return;
          await send({ type: "discard", ids: [t.id], force: risky });
          refresh();
        } }),
      el("button", { class: "small ghost", text: "✕", title: "Закрыть вкладку",
        onclick: async () => { await send({ type: "close", id: t.id }); refresh(); } }));
    box.append(el("div", { class: "tab" + (s.loop ? " loop" : "") + (t.discarded ? " disc" : "") },
      el("div", { class: "t", text: tabLabel(t), title: t.title || t.url, onclick: () => send({ type: "focus", id: t.id }) }), b, m));
  }
  if (!rows.length) box.append(el("p", { class: "note", text: "Открытых вкладок chatgpt.com нет." }));
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
    renderHeader(); renderMeters(); renderTabs(); renderSessions();
    const unprotected = tabsNow.filter(t => !t.discarded && !(snap.tabs[t.id] || {}).guard).length;
    $("btnProtect").hidden = unprotected === 0;
    $("btnProtect").textContent = `Защитить открытые вкладки (${unprotected})`;
    if (document.activeElement !== $("gap")) $("gap").value = snap.cfg.restoreGapSec;
    $("chkEnabled").checked = snap.cfg.enabled !== false;
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
$("chkEnabled").onchange = async e => { await send({ type: "setCfg", patch: { enabled: e.target.checked } }); };
$("gap").onchange = async e => { await send({ type: "setCfg", patch: { restoreGapSec: Math.max(3, Number(e.target.value) || 12) } }); };

refresh();
setInterval(refresh, 1500);
