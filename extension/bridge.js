// 4̅2̅9̅ bridge — isolated-world content script.
// 1) mirrors learned ceilings + config from chrome.storage.local into the page's localStorage
//    (localStorage is shared between worlds), because guard.js (MAIN) cannot call chrome.*;
// 2) relays guard events (hold/429/recovered) to the service worker for the popup and badge.
(() => {
  "use strict";
  if (window.__A429_BRIDGE__) return;
  window.__A429_BRIDGE__ = true;

  const NS = "a429:";
  const mirror = items => {
    try {
      if (items.ceilings) localStorage.setItem(NS + "ceil", JSON.stringify(items.ceilings));
      if (items.cfg) localStorage.setItem(NS + "cfg", JSON.stringify(items.cfg));
    } catch {}
  };
  const pull = () => {
    try { chrome.storage.local.get(["ceilings", "cfg"]).then(mirror).catch(() => {}); } catch {}
  };
  pull();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes.ceilings || changes.cfg)) return;
      pull();
    });
  } catch {}

  // Tab state for the tab doctor: is there an unsent draft / a running answer? (never sends the text itself)
  const composerHasDraft = () => {
    const el = document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!el) return false;
    const t = "value" in el && typeof el.value === "string" ? el.value : (el.innerText || el.textContent || "");
    return t.trim().length > 0;
  };
  const isGenerating = () => !!document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop"], button[aria-label*="Останов"]');
  let lastState = "";
  const reportState = force => {
    try {
      const st = { draft: composerHasDraft(), generating: isGenerating() };
      const key = JSON.stringify(st);
      if (!force && key === lastState) return;
      lastState = key;
      chrome.runtime.sendMessage({ type: "a429_tabstate", state: st }).catch(() => {});
    } catch {}
  };
  setInterval(() => reportState(false), 4000);
  document.addEventListener("input", () => reportState(false), true);
  document.addEventListener("visibilitychange", () => reportState(true));
  setTimeout(() => reportState(true), 1500);

  window.addEventListener("__a429_event__", event => {
    try {
      const ev = JSON.parse(event.detail);
      chrome.runtime.sendMessage({ type: "a429_event", ev }).catch(() => {});
    } catch {}
  });
})();
