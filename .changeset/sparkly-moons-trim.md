---
"pi-pulse": patch
---

Fix the live-footer example in `docs/metrics.md` and `docs/architecture.md`: the streaming footer starts with the spinner and sparkline (e.g. `⠼ ⣤⣸⠀⠀⠀⠀⠀⠀ 42 tps | …`), not a literal `TPS` prefix. Only the idle/final footer is prefixed with `TPS`. Also harden `isMeterSnapshot` to reject snapshots whose per-buffer `values` and `times` arrays have mismatched lengths, so a damaged session entry can no longer push `NaN` timestamps into the ring buffers on restore.
