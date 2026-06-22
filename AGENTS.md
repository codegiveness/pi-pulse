# AGENTS.md — pi-pulse

Guidelines for anyone (human or agent) working on the `pi-pulse` extension.

## Project purpose

A Pi footer/status extension that replaces the stock `"tps"` key with live,
rolling metrics. The goal is to give comparable, quantitative numbers for
judging provider and model performance instead of relying on impressions.

- **TPS** — decode-phase throughput: tokens per second from first output token to `message_end` (equivalent to `1/TPOT` as defined by the IETF LLM benchmarking terminology). Shown as a colored braille sparkline plus 60-second rolling average, 10-minute trailing mean, p10, and p95.
- **TTFT** — time from `before_provider_request` to the first assistant output
  token (`text_delta`, `thinking_delta`, `toolcall_delta`, or `toolcall_start`).
- **Elapsed** — end-to-end request latency from `before_provider_request` to `message_end`, accumulated across all completed assistant responses. While streaming, the *rendered* value is the current E2E latency; while idle, the value is the running total and is persisted across reloads/resumes.

The source compiles to `dist/` and is loaded by Pi via `package.json#pi.extensions`.

## Event lifecycle assumptions

The extension observes these Pi events and nothing else:

| Event | Purpose |
|-------|---------|
| `session_start` | Reset the meter and (re)start in a clean state. |
| `session_shutdown` | Persist the latest snapshot, then stop the live ticker and reset state. |
| `before_provider_request` | Mark the start of an LLM request so TTFT can be measured from this point. |
| `message_start` (assistant only) | Start the response timer and the live ticker. |
| `message_update` (assistant only, delta/toolcall_start events) | Count tokens, mark the first token, drive TTFT. |
| `message_end` (assistant only) | Stop the ticker, record the final TPS sample and elapsed time. |

Do **not** add handlers for unrelated events without updating the README and
regression tests. Do **not** use turn-level events (`turn_start`, `turn_end`,
`agent_start`, `agent_end`) for timing; message-level events give the correct
granularity for per-response metrics.

## Resource management

- **No background work from the factory.** Timers, file watchers, sockets, or
  recurring polling must be created only in response to `session_start` or to a
  specific command/tool/event that needs them.
- **Clean up timers.** `setInterval` must always be paired with `clearInterval`.
  Stop the ticker on `message_end` and on `session_shutdown`.
- **Abort-aware cleanup.** When a `ctx.signal` is available during streaming, attach
  an abort listener that stops the ticker if the turn is cancelled.
- **Guard UI calls.** Use `ctx.hasUI` before calling `ctx.ui.setStatus`, and wrap
  calls in `try`/`catch` so a footer rendering bug does not crash Pi.
- **No global mutable state.** Each extension load gets its own `StatsMeter`
  instance. Do not store state in module-level variables.

## Timing and numeric correctness

- Use a monotonic clock for internal metrics (`performance.now()` by default).
  The meter accepts an injectable `now()` function so tests can use a fake clock.
- Compute all displayed values from a single snapshot of `now()` inside each
  render call so `TPS`, `TTFT`, and `Elapsed` are mutually consistent.
- Token counts are estimates (≈ 4 characters per token). This is documented
  behavior; do not change it silently.
- TTFT must measure from the most recent `before_provider_request` to the first
  assistant output token. If `before_provider_request` did not fire for a
  message, fall back to `message_start`.
- TPS must use the decode-phase denominator (first output token to
  `message_end`), not the full response duration. TTFT captures prefill
  latency separately.
- Elapsed must start from `before_provider_request` (with fallback to
  `message_start`) to capture the full E2E request latency.
- A non-streamed tool call (`tool_call` update without deltas) still counts as
  the first assistant output for TTFT, even though it contributes no streamed
  tokens to TPS.
- Bound all histories: TPS rolling window, all-time TPS buffer, all-time TTFT
  buffer, and the graph buffer all have fixed caps. TPS and TTFT distribution
  statistics (mean, p10, p95) use a trailing 10-minute window
  (`ALL_TIME_WINDOW_MS`); older samples are excluded from calculation but
  retained in the ring buffer up to the count cap.

## Persistence

The meter survives Pi reloads and restarts of the same session by saving a
small snapshot to the session file on `session_shutdown` and restoring it on
the next `session_start`.

- Persist via `pi.appendEntry("pi-pulse/snapshot", meter.serialize())`
  in the `session_shutdown` handler, guarded by `meter.hasData()`.
- Restore by scanning `ctx.sessionManager.getBranch()` for the latest
  `"pi-pulse/snapshot"` custom entry and calling `meter.restore()`.
- The snapshot stores capped buffers (all-time TPS, all-time TTFT, rolling
  window, sparkline graph) plus `totalElapsedMs`. All buffer timestamps are
  shifted to the current monotonic clock on restore so both the 60-second
  rolling-window average and the 10-minute trailing window remain valid.
- Do not persist streaming/per-message state (`streaming`, `streamStart`,
  `firstTokenArrived`, etc.). When a session starts the meter must be idle and
  wait for the next assistant message.
- New sessions (`reason: "new"`) begin with fresh metrics. Only reload/resume
  (same underlying session file) restores the previous snapshot. If you need
  cross-session persistence, use a project-local or global state file instead
  of `appendEntry`.

## Code style and type safety

- Import real Pi types (`ExtensionAPI`, `ExtensionContext`, event types) from
  `@earendil-works/pi-coding-agent`. Do not maintain hand-rolled event shapes.
- Keep `strict: true` and `noUnusedLocals: true` passing.
- Avoid `as` casts. When narrowing union types (e.g. `AssistantMessageEvent`),
  use a type-safe switch or helper.
- Prefer explicit `return` types only where they catch real bugs; otherwise rely
  on inference to keep the code concise.

## Testing policy

Every behavior change must be accompanied by tests. Run `npm test` before
committing.

| Test file | Covers |
|-----------|--------|
| `test/format.test.mjs` | Number/duration formatting and color helpers. |
| `test/graph.test.mjs` | Braille sparkline rendering, wraparound, and color thresholds. |
| `test/meter.test.mjs` | Full TPS/TTFT/Elapsed lifecycle, multi-message sequences, clock injection, and buffer caps. |
| `test/extension.test.mjs` | Pi event wiring, start/stop of the live ticker, status clear on shutdown, and abort cleanup. |
| `test/stats.test.mjs` | Integration behavior through the extension wiring. |
| `test/ttft-leak.test.mjs` | Tool-only / no-first-token turns must not record phantom TTFT or TPS samples. |

Use the fake clock (`createMeter({ now: () => clock }`) to make timing tests
deterministic. Assert on internal `snapshot()` values and rendered output.

## Common pitfalls

- **Race between event handler and ticker.** JavaScript runs one callback at a
  time, but the interval can fire between handlers. Always read `meter.snapshot()`
  inside the interval callback and bail out if the meter is no longer streaming.
- **Timer leak on reload.** `session_shutdown` must run `stopTick()`. The ticker
  callback must not hold references to stale `ctx` objects after shutdown.
- **Phantom TTFT.** Do not record a TTFT sample on `message_end` or
  `session_shutdown`. It must be recorded only when the first assistant output
  arrives.
- **Unbounded growth.** Every collection used across a long session must be
  capped or pruned.

## Release checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] README updated if user-visible behavior changed.
