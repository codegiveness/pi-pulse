---
"pi-pulse": patch
---

Internal tidy-up since v0.3.2 with no user-visible behavior change: restore `noUnusedLocals`/`noUnusedParameters` in tsconfig (inadvertently dropped when enabling `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`), add a `StatsMeter.isStreaming()` accessor used by the live ticker to avoid recomputing windowed counts on every 250 ms tick, accept an optional `{ meter }` dependency-injection hook on `piPulseExtension` for deterministic tests, and harden CI to assert the npm tarball excludes `src/`, `test/`, `internal/`, `docs/`, and `.github/`.
