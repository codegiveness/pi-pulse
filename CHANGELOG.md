# Changelog

## 0.3.0

### Minor Changes

- Add p10 TPS percentile to the final footer, displayed before p95. Add a NOTICE file attributing the `pi-tps-meter` inspiration. Update all GitHub Actions and development dependencies to their latest versions.

## Unreleased

### Added

- Added a p10 TPS percentile alongside p95, displayed before p95 in the final footer. The p10 value represents the floor of the TPS distribution across completed responses.

## 0.2.1

### Fixed

- Tool-call streaming: `toolcall_delta` events now count toward TPS and mark the first-token boundary for TTFT. Previously, long streamed tool calls showed 0 TPS and a TTFT timer that kept ticking for the entire tool output.

- Non-streamed tool-call TTFT: a `toolcall_start` event that is not followed by deltas also marks the first assistant output and stops the TTFT timer.

- Accumulated elapsed: the footer `Elapsed` now accumulates the duration of every completed assistant response during the session, so you can score total model working time. It is persisted across reloads and resumes.

- Lifecycle cleanup: the live ticker is stopped on `message_end`, `session_shutdown`, and on turn abort via `ctx.signal`, preventing leaked timers across reloads or cancelled turns.

- Live/final TPS threshold asymmetry: both the live display and the sample recorded on `message_end` are suppressed below `TPS_MIN_ELAPDED_SEC` (0.3s), so a short response no longer shows 0 tps live while recording a large sample.

- Sub-second `Elapsed` rendering: durations below 1s now render as `0.5s` instead of `0s`.

- `fmtTps` consistency: negative inputs now format as `0.0`, matching the zero branch.

### Changed

- **TPS** now measures decode-phase throughput only (from first output token to `message_end`), matching the industry-standard `1/TPOT` metric (IETF `draft-gaikwad-llm-benchmarking-terminology`). Previously the denominator included part of the TTFT wait (from `message_start`), producing a hybrid metric that didn't correspond to any standard definition. Decode TPS is slightly higher than the previous hybrid for most responses.

- **Elapsed** now measures end-to-end request latency (from `before_provider_request` to `message_end`), matching the industry-standard E2E latency definition. Previously it excluded the `before_provider_request → message_start` gap, making the user's initial wait invisible. Elapsed is now slightly higher than before for responses with non-trivial prefill.

- Braille sparkline columns are now colored by the average of both contributing samples instead of only the left one.

- `p95` computation now uses `Float64Array.slice().sort((a, b) => a - b)` (O(n log n)) instead of an O(n²) insertion sort on every render.

- Restored snapshots are validated with a type guard (`isMeterSnapshot`); corrupt session entries are ignored instead of pushing `NaN` into the buffers.

- Snapshot restore only time-shifts the rolling-window timestamps (the only buffer that uses them); all-time buffers are restored verbatim.

### Removed

- Dead `IDLE_TICK_MS` constant.

- Unused `export { createMeter }` from the extension entry point.

- `as` casts for `ctx.ui.theme` and persisted snapshot data.

- `jiti` devDependency (the integration test now imports the compiled output directly).
