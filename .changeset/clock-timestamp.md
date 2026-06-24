---
"pi-pulse": minor
---

Add a ticking wall-clock timestamp (`Clock`) to the footer, appended after `Elapsed` as an ISO 8601 UTC value with second precision, e.g. `... | Elapsed 15s | 2026-06-24T02:22:47Z`. A session-scoped ticker re-renders the idle footer every second so the timestamp stays current even while nothing is streaming; while streaming, the existing live ticker already refreshes it. The clock is presentation only and never feeds back into TPS/TTFT/Elapsed measurements. Both tickers are started on `session_start` and cleared on `session_shutdown` (and on reset) so no interval outlives the session.
