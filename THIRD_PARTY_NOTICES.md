# Third-party notices

## ChatGPT Conversation Availability Guard (design inspiration)

- Project: https://github.com/Ai-b0ss/chatgpt-429-conversation-recovery
- License: MIT. Copyright notice as published in that repository.
- Use: the *approach* of wrapping `window.fetch` for conversation reads, honoring `Retry-After`, holding the request
  pending with exponential backoff instead of surfacing the 429, sharing cooldown state between tabs through
  `localStorage` / `BroadcastChannel` / `navigator.locks`, and the endpoint classification idea.
- `extension/guard.js`, `bridge.js`, `background.js` here are an independent implementation; no source file of that project is
  copied verbatim. The differences are deliberate: an account-wide sliding-window ledger shared by all tabs (the original
  keeps cooldown per conversation), four separately metered limiter families, learned ceilings, per-tab telemetry,
  a traffic-light indicator and a tab doctor (discard / paced restore).
- v0.2: `extension/recovery.js` re-implements the *behaviour* of the active `resume` 404 recovery described in that
  project's `stream-observer.js` (wait for natural recovery signals first, bounded retries with other offsets, stream
  validation, cross-tab lock, WebSocket turn-complete signal). It was written from a reading of that file's logic, not
  copied; names, structure and tests are our own.
