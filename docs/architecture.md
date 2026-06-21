# pi-pulse Design Document

This document explains how `pi-pulse` is built, why its metrics are defined
the way they are, and how the extension stays small and safe for long Pi
sessions. It is intended for contributors and advanced users who want more
detail than the README provides.

- For installation and everyday usage, see [`README.md`](../README.md).
- For behavioral guidelines when modifying this project, see
  [`AGENTS.md`](../AGENTS.md).

---

## 1. What pi-pulse does

`pi-pulse` replaces Pi's stock `"tps"` footer key with a live meter that
tracks the performance of the active LLM provider during a coding session.
It observes only five Pi events (`session_start`, `session_shutdown`,
`before_provider_request`, `message_start`, `message_update`, `message_end`)
and derives three orthogonal metrics:

| Metric | What it tells you | Windowed? |
|--------|-------------------|-----------|
| **TTFT** | How long you wait before the first model output appears. | Yes — trailing 10 minutes for the mean. |
| **TPS** | How fast the model generates tokens once it starts. | Yes — 60-second rolling avg + trailing 10 minutes for mean / p10 / p95. |
| **Elapsed** | Total wall-clock time you have spent waiting for assistant responses. | No — it is a cumulative counter. |

The three metrics are intentionally **additive**:

```text
Elapsed ≈ TTFT + decode_time
```

This means the numbers can be cross-checked mentally and each metric
isolates a different failure mode.

---

## 2. Event timeline and metric definitions

For every assistant response, pi-pulse observes the following event
sequence:

```text
T0  before_provider_request
│   Pi serializes the request
│   Network round-trip
│   Provider queue / prefill (KV-cache construction)
│
T1  message_start (assistant only)
│   Possible further prefill / stream start
│
T2  first output token arrives
│   text_delta | thinking_delta | toolcall_delta | toolcall_start
│
T3  message_end (assistant only)
│
```

### 2.1 TTFT — Time to First Token

```text
TTFT = T2 - T0
```

TTFT measures the user-perceived wait before the model starts producing
output. It includes request serialization, network latency, provider
queueing, and prefill computation. The first output token can be:

- a streamed `text_delta`, `thinking_delta`, or `toolcall_delta`, or
- a non-streamed `toolcall_start` event.

If a response produces no assistant output at all, no TTFT sample is
recorded.

### 2.2 TPS — Decode-phase throughput

```text
tokens = estimated_token_count of all streamed output
decode_time = T3 - T2
TPS = tokens / decode_time
```

Each token is estimated as roughly **4 characters**. TPS uses the
decode phase only, excluding the prefill wait captured by TTFT. This is
equivalent to `1 / TPOT` (time per output token) as defined in the IETF
LLM benchmarking terminology and in NVIDIA's NIM benchmarking docs.

A TPS sample is recorded only when:

- at least one output token arrived (`streamTokens > 0`), and
- the decode phase lasted at least `TPS_MIN_ELAPSED_SEC` (0.3 s).

Very short responses are suppressed so the footer never shows absurdly
high, noisy values.

### 2.3 Elapsed — End-to-end request latency

```text
last_elapsed = T3 - T0
elapsed_total += last_elapsed
```

`Elapsed` is the full wall-clock wait for the current or completed
response. It is a cumulative counter, so it grows monotonically across
the session and is persisted across reloads/resumes. If
`before_provider_request` does not fire for a response, pi-pulse falls
back to `T1` (`message_start`) as the start anchor.

---

## 3. Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                     Pi event loop                            │
└───────────────────────┬──────────────────────────────────────┘
                        │
          ┌─────────────▼──────────────┐
          │   piPulseExtension factory │  ← per session / reload
          │  (src/extension.ts)        │
          └─────────────┬──────────────┘
                        │
          ┌─────────────▼──────────────┐
          │       StatsMeter           │
          │  (src/meter.ts)            │
          └─────────────┬──────────────┘
                        │
     ┌──────────────────┼──────────────────┐
     │                  │                  │
┌────▼────┐       ┌─────▼────┐       ┌────▼────┐
│ RingBuf │       │  Graph   │       │  Format │
│(buffers)│       │(sparkline│       │(numbers │
└─────────┘       │ renderer)│       │ & colors│
                  └──────────┘       └─────────┘
```

### 3.1 `extension.ts` — event adapter

The extension factory creates one `StatsMeter` instance per Pi session.
It starts and stops the live ticker, wires Pi events to meter methods,
persists a snapshot on `session_shutdown`, and restores a previous
snapshot on `session_start`. It guards UI calls with `ctx.hasUI` and
catches rendering errors so that a footer bug cannot crash Pi.

### 3.2 `meter.ts` — `StatsMeter`

`StatsMeter` owns all mutable state. It is deliberately a single class so
that tests and reloads get a fresh instance; there is no module-level
state.

Key responsibilities:

- Streaming state management (start, ticks, first-token detection, end).
- Per-response token counting.
- Sample recording into bounded buffers.
- Time-windowed mean / percentile calculations.
- Snapshot serialization and restore.
- Footer string generation (live and final).

### 3.3 `RingBuf` — bounded sample store

`RingBuf` is a power-of-two circular buffer that stores a numeric value
and a monotonic timestamp for each sample. It supports:

- fixed-size insertion (`push`)
- count-bounded full-array export (`toArray`, `toTimeArray`)
- time-windowed average (`avg`)
- time-windowed value iteration (`valuesInWindow`) — used for windowed
  p10/p95/mean calculations

All buffers have fixed maximum sizes:

| Buffer | Max entries | Purpose |
|--------|-------------|---------|
| `win` | 64 | 60-second rolling TPS average. |
| `allTps` | 512 | TPS distribution for mean / p10 / p95. |
| `allTtft` | 512 | TTFT distribution for mean. |
| `graph` | 20 | Braille sparkline columns. |

### 3.4 `graph.ts` — `brailleGraph`

Renders a 10-column colored braille sparkline from the last up to 20 TPS
samples. Each column combines two adjacent samples. The local maximum is
used for normalization so the sparkline always spans the full height.

### 3.5 `format.ts` — `fmt*` helpers and color thresholds

Converts numbers into compact strings and assigns colors based on
thresholds:

| Metric | `success` | `warning` | `error` |
|--------|-----------|-----------|---------|
| TPS | >= 50 t/s | 20–49 t/s | < 20 t/s |
| TTFT | <= 0.5 s | 0.5–2.0 s | > 2.0 s |

Elapsed time is always rendered as neutral/dim because "fast" or "slow"
is not meaningful for a cumulative total.

---

## 4. Windowing and aging strategy

Provider performance is **non-stationary**: a model may be fast at 09:00
and slow at 10:00 because of load, routing, context length, or rate
limits. Reporting a mean or percentile over the entire session would
show the historical average, not the current experience.

### 4.1 What is windowed

| Metric | Window | Description |
|--------|--------|-------------|
| TPS `avg` | 60 seconds | Rolling average of completed-response TPS samples. Already existed to show recent throughput. |
| TPS `μ` | 10 minutes | Mean of completed-response TPS samples. |
| TPS `p10` | 10 minutes | 10th percentile — the "floor" of recent throughput. |
| TPS `p95` | 10 minutes | 95th percentile — the "ceiling" of recent throughput. |
| TTFT `μ` | 10 minutes | Mean time to first token. |

TTFT does not currently expose a percentile because the session usually
has many fewer TTFT samples than TPS samples (one per assistant
response). A percentile over a sparse distribution is noisy and
potentially misleading.

### 4.2 What is **not** windowed

- **`Elapsed`** is a cumulative counter. Windowing it would destroy its
  meaning as a session total.
- **The braille sparkline** is a fixed-length view of the last 20
  completed-response samples, not a time window. This keeps the visualizer
  stable and easy to read. After a long idle period, the sparkline may
  still display old data while the windowed stats (μ, p10, p95, TTFT μ)
  show 0 — this is an accepted minor inconsistency.
- **The 60-second rolling TPS average (`avg`)** uses its own window
  (`TPS_WIN_MS`). If the session is idle for more than 60 seconds, `avg`
  returns 0. This is existing behavior, not introduced by the 10-minute
  windowing change, but it becomes more visible because all TPS stats
  simultaneously drop to 0 after idle.

### 4.3 How samples are filtered

Each sample carries a monotonic timestamp. When `renderFinal()` runs, it
captures a single `nowMs` value and passes it to every stat function
(`calcTpsMean`, `calcTpsP95`, `calcTpsP10`, `calcTtftMean`), which now
require it as a parameter. This ensures all values in the footer are
computed from one consistent snapshot. Samples with
`timestamp < nowMs - ALL_TIME_WINDOW_MS` are excluded from the mean and
percentile calculations via `RingBuf.valuesInWindow()`.

Buffers are additionally count-capped (`TPS_ALL_TIME_CAP = 512`), so
memory usage never depends on session length or message density. No
`trim()` or compaction is needed — expired samples are simply skipped
during aggregation.

### 4.4 Why 10 minutes?

10 minutes is a pragmatic starting point that balances two goals:

1. **Enough data for a stable mean / percentile.** At a reasonable chat
   cadence this usually includes several to dozens of assistant responses.
2. **Short enough to reflect current provider behavior.** If the provider
   degrades, old fast samples are pruned within 10 minutes.

The constant is tunable. A future version could expose it as a user
setting or add multiple views (recent / session).

### 4.5 Could we use EWMA instead?

A one-pole exponential weighted moving average (EWMA) is a popular
alternative to fixed windows. It is elegant and O(1) in memory.

pi-pulse does **not** use EWMA for the recorded distribution because:

- EWMA cannot produce honest p10 / p95 percentiles — it only estimates a
  central tendency.
- With bounded ring buffers the memory cost is already negligible.
- Fixed windows make the behavior easy to reason about and test with a
  fake clock.

EWMA remains a good future option for a *live* current-TPS display if the
user wants an even more reactive number.

---

## 5. Persistence and restore

### 5.1 Snapshot contents

When Pi fires `session_shutdown`, `pi-pulse` appends one small JSON entry
to the session file under the custom type `pi-pulse/snapshot`.

The snapshot contains:

- `savedAt`: monotonic timestamp at save time.
- `allTps`: capped array of `{values, times}` — only values within the
  10-minute window contribute to future stats.
- `allTtft`: capped array of `{values, times}` — same.
- `win`: capped 60-second rolling TPS buffer.
- `graph`: last up to 20 TPS samples for the sparkline.
- `lastElapsedMs`: last completed response E2E latency.
- `totalElapsedMs`: running session total E2E latency.

Streaming-only state (`streaming`, `streamStart`, `firstTokenArrived`,
etc.) is **not** persisted.

### 5.2 Restore semantics

On `session_start`:

1. Find the latest `pi-pulse/snapshot` entry in the session branch.
2. If it validates, shift all sample timestamps (including `allTps` and
   `allTtft`) so that the old `savedAt` aligns with the current monotonic
   clock.
3. Expired samples are automatically excluded by `valuesInWindow()` on the
   next render.
4. Render the final footer from the restored state.

If the snapshot cannot be validated, the meter starts fresh. New sessions
(`/new`, `/fork`) also start fresh because they use a different session
file.

### 5.3 Monotonic clock assumption

`pi-pulse` uses `performance.now()` for all internal timing. This is the
right choice for measuring intervals because it is not affected by system
_clock_ changes. However, if the Pi process is fully restarted, the
monotonic clock resets and the snapshot shift can become inaccurate.
In practice, this affects the absolute age of restored samples, not
memory safety or correctness: expired samples are still dropped and the
total `Elapsed` is still correct. The `win.avg` and the 10-minute window
may briefly include samples that are older than intended after a process
restart. A future improvement could store wall clock alongside monotonic
time to handle long restarts more accurately.

---

## 6. Memory and disk safety

`pi-pulse` is designed to run for hours or days without leaking memory or
bloating the Pi session file.

### 6.1 Bounded in-memory state

| State | Bound | Mechanism |
|-------|-------|-----------|
| TPS history | ≤ 512 samples | `TPS_ALL_TIME_CAP` ring buffer |
| TTFT history | ≤ 512 samples | same cap |
| 60-second rolling TPS window | ≤ 64 samples | `TPS_WIN_SIZE` ring buffer |
| Sparkline | ≤ 20 points | `GRAPH_DOTS` |
| Timer instances | ≤ 1 | single interval, cleared on end/shutdown/abort |
| Snapshot resident footprint | ≤ tens of KB | derived from buffers above |

### 6.2 Disk write behavior

- Exactly **one** custom snapshot entry is appended per `session_shutdown`.
- No writes happen during streaming or between turns.
- The snapshot JSON is bounded by the ring-buffer caps, so its size does
  not grow with conversation length.

### 6.3 No background work from the factory

Following the `AGENTS.md` resource rules:

- Timers are created only in response to `message_start` (a specific
  streaming response that needs the live footer).
- The live `setInterval` is always paired with `clearInterval` on
  `message_end`, `session_shutdown`, and abort.
- Abort listeners are attached only while a stream is active and removed
  when the stream ends or aborts.
- No file watchers, polling loops, or global mutable state exist.

### 6.4 Why these bounds are sufficient

At 512 stored TPS samples, the raw numeric payload is approximately
16 KB. With JSON, timestamps, and graph overhead, a snapshot is still
well under 200 KB. For comparison, Pi session files can legitimately grow
to many megabytes from message history, so `pi-pulse` contributes a tiny,
constant fraction of that.

---

## 7. Footer rendering

### 7.1 Live footer (while streaming)

```text
TPS ⣤⣸⠀⠀ 42 tps | TTFT 0.25s | Elapsed 0.6s
```

- The leftmost character is a rotating braille spinner.
- The sparkline shows the last completed responses, not the in-flight
  response.
- `TPS` shows the instantaneous decode-phase throughput of the current
  response, suppressed during the first 0.3 s to avoid spikes.
- `TTFT` shows either a ticking wait indicator (while waiting for the
  first token) or the measured TTFT for this response.
- `Elapsed` shows the current end-to-end latency from
  `before_provider_request` to now.

### 7.2 Final footer (idle)

```text
TPS ⣤⣸⠀⠀ 42 avg | μ 38 | p10 25 | p95 55 | TTFT μ 0.25s | Elapsed 15s
```

- `avg` = TPS average over the last 60 seconds.
- `μ` = mean of TPS samples over the last 10 minutes.
- `p10` / `p95` = 10th and 95th percentiles of TPS over the last
  10 minutes.
- `TTFT μ` = mean TTFT over the last 10 minutes.
- `Elapsed` = running total across completed responses.

When all rate data (TPS and TTFT) expires from the 10-minute window but
`Elapsed` is non-zero, the footer shows only `Elapsed 5m` — no confusing
zeroes for TPS/TTFT. When there is no data at all (no samples, no
elapsed), the footer line is hidden entirely.

---

## 8. Testing strategy

Tests are deterministic because `StatsMeter` accepts an injectable
`now()` function.

| Test file | Focus |
|-----------|-------|
| `test/format.test.mjs` | Number formatting and color helpers. |
| `test/graph.test.mjs` | Braille sparkline and buffer wraparound. |
| `test/meter.test.mjs` | Full lifecycle, multi-message sequences, buffer caps, snapshot restore, time-windowing. |
| `test/extension.test.mjs` | Pi event wiring, ticker start/stop, abort cleanup, status clear. |
| `test/stats.test.mjs` | Integration behavior through the extension wiring. |
| `test/ttft-leak.test.mjs` | Tool-only / no-first-token turns must not record phantom TTFT or TPS samples. |

Key invariants verified:

- `setInterval` is always cleared.
- No samples are recorded without a first token.
- Buffer sizes never exceed their caps.
- Old samples outside the configured time window do not affect mean or
  percentile outputs.
- Snapshot restore produces the same rendered footer as the original
  meter (subject to timestamp shifting).

---

## 9. Design decisions and tradeoffs

### 9.1 Why decode-phase TPS?

Some tools report "per-user" TPS (`tokens / total_response_time`).
`pi-pulse` intentionally uses the decode phase only because TTFT is
already shown separately. This decomposition lets a user distinguish:

- *"the provider is slow to start"* (high TTFT)
- *"the provider generates slowly"* (low TPS)
- *"the response is long"* (high Elapsed)

### 9.2 Why token estimation instead of provider-reported counts?

Provider streams do not always report token counts with each delta.
Approximating one token per four characters keeps the meter universal
across providers and matches the documented approximation in similar
extensions.

### 9.3 Why are there two TPS means?

- The 60-second `avg` is for *recent trend*: it reacts quickly.
- The 10-minute `μ` is for *baseline expectation*: it smooths noise while
  still dropping old provider behavior.

### 9.4 Why 4-character token estimation?

It is the widely used rule of thumb for English/ASCII text in LLM
systems, balancing simplicity and reasonable accuracy for code and
natural-language output.

### 9.5 Why not histograms or reservoir sampling?

They are excellent for bounded-memory percentile estimation, but they
add complexity and approximation error. With only one sample per
assistant response, the memory savings are not worth the loss of exact
arithmetic.

---

## 10. Future directions

- **Configurable window:** expose `ALL_TIME_WINDOW_MS` as a Pi setting or
  extension option.
- **Multiple views:** allow the user to toggle between "recent" (10 min)
  and "session" statistics.
- **EWMA live TPS:** offer a more reactive live number alongside the
  stable rolling average.
- **TTFT p95/p99:** once enough TTFT samples accumulate, expose a tail
  latency percentile.
- **Persistent cross-session totals:** store `totalElapsedMs` in a project
  or global file so Elapsed can optionally span sessions.
- **Wall-clock-aware restore:** store both monotonic and wall-clock time
  in snapshots to handle long Pi restarts more gracefully.

---

## 11. Glossary

| Term | Meaning |
|------|---------|
| **TTFT** | Time To First Token: `before_provider_request` → first assistant output. |
| **TPS** | Tokens Per Second during decode phase: `tokens / (message_end - first_token)`. |
| **TPOT** | Time Per Output Token: `decode_time / tokens`; pi-pulse TPS is the reciprocal. |
| **E2E latency** | End-to-end request latency: `message_end - before_provider_request`. |
| **Delta** metric | A metric reporting a value for a specific interval. Contrast with *cumulative*. |
| **Cumulative** metric | A monotonically increasing total (e.g., Elapsed). |
| **RingBuf** | The circular buffer data structure used for bounded sample storage. |

---

## References

- Google SRE Workbook — [SLO windows](https://sre.google/workbook/implementing-slos/)
- Prometheus docs — [rate() and irate()](https://prometheus.io/docs/prometheus/3.12/querying/functions)
- OpenTelemetry — [metrics data model](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/metrics/data-model.md)
- NVIDIA NIM — [LLM benchmarking metrics](https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html)
