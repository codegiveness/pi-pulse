---
"pi-pulse": patch
---

Internal tidy-up since v0.3.2 with no user-visible behavior change: restore `noUnusedLocals`/`noUnusedParameters` in tsconfig (inadvertently dropped when enabling `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`), add a `StatsMeter.isStreaming()` accessor used by the live ticker to avoid recomputing windowed counts on every 250 ms tick, accept an optional `{ meter }` dependency-injection hook on `piPulseExtension` for deterministic tests, harden CI to assert the npm tarball excludes `src/`, `test/`, `internal/`, `docs/`, and `.github/`, and correct the README's stale claim that `toolcall_start` is ignored by the meter (a non-streamed `toolcall_start` actually stops the TTFT timer, matching behavior since v0.2.1).
