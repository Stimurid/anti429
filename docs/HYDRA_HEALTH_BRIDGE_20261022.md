# anti429 0.5.13 — scoped cached health for HYDRA

Date: 2026-10-22. Baseline 0.5.12 / 1a8f835.

Only HYDRA worker (extension ID opgnfgihbjphabgflgnaiamenmdgfjom, no tab sender) may use hydra.health.read with an exact conversationId. The response is a429-health/v1: separate list/stream source timestamps, async status, stream status, update time, observer version and cooldown. No text, tokens or history. Scope is SAME_CHROME_PROFILE, not a fabricated canonical account ID.

The handler reads existing cache and optionally registers watch=true for ten minutes, max32 chats. No fetch, forced audit, Retry, Send or Stop is invoked by this endpoint. The existing scheduled audit prioritizes watched IDs under existing calm/cooldown/request caps, oldest observation first. A HYDRA read-only watch excludes that chat from automatic reaper Stop. Ordinary provider traffic remains with anti429, not a second HYDRA fetch loop.

Cache reads do not make source evidence fresh. A new list timestamp cannot refresh an old stream check. async_status3 plus COMPLETE is not completed work. Missing/stale evidence remains UNKNOWN. Stream COMPLETE with unknown async status remains incomplete evidence.

Verification: 76 shared/guard/recovery/health tests passed. Actual isolated Chrome worker-to-worker messaging accepted the cached read and refused stopStream. Zero provider requests in that test; owner profile not used. Activate the actual loaded0.5.13 worker; files on disk alone are not loaded-version proof. Preexisting anti429 self-update remains intact.

The corresponding HYDRA0.2.42 broker may collect exactly bound existing outputs and return source links to the existing inbox. The health bridge does not authorize any provider mutation.
