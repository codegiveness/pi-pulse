# pi-pulse

[![npm](https://img.shields.io/npm/v/pi-pulse?style=flat-square)](https://www.npmjs.com/package/pi-pulse)
[![CI](https://github.com/codegiveness/pi-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/codegiveness/pi-pulse/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/pi-pulse?style=flat-square)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/codegiveness/pi-pulse/badge)](https://api.securityscorecards.dev/projects/github.com/codegiveness/pi-pulse)

Live footer meter for the [pi coding agent](https://pi.dev) that shows:

- **TPS** — tokens per second during assistant streaming (text, reasoning, and streamed tool-call parameters), with a braille sparkline, rolling average, mean, p10 (floor), and p95
- **TTFT μ** — mean time from `before_provider_request` to the first assistant output token (text, thinking, or tool-call parameter delta)
- **Elapsed** — total wall-clock time the assistant spent generating responses during the session (accumulated across all completed assistant messages). While streaming, the live footer shows the current response duration; the idle footer shows the running total.
- **Clock** — the current wall-clock time as an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`), ticking every second. Appended after Elapsed so each footer snapshot can be correlated with logs.

The extension replaces the stock `pi-tps-meter` footer key (`"tps"`).

## Why pi-pulse? — at a glance

| Question | Answer |
|----------|--------|
| **What** is it? | A live footer meter that replaces Pi's stock TPS key with richer, context-aware performance numbers. |
| **Why** does it exist? | So you can compare providers and models with measurements, not impressions. Prefill, decode speed, and total wait are shown separately to make slowdowns diagnosable. |
| **Who** is it for? | Anyone using Pi who wants to know whether a model or provider feels slow because of prefill, generation, or both. |
| **Where** does it run? | Inside Pi as a status extension. It observes the same events Pi already emits; it does not call providers directly. |
| **How** does it measure? | By listening to `before_provider_request`, `message_start`, `message_update`, and `message_end`, then deriving TTFT, decode-phase TPS, and end-to-end Elapsed. See [`docs/metrics.md`](./docs/metrics.md) for the full definitions. |

## Inspiration

This extension and its documentation were originally inspired by [`pi-tps-meter`](https://github.com/vskrch/pi-tps-meter) by vskrch, which demonstrated live TPS and TTFT metering for the Pi CLI. If you reuse concepts or documentation from upstream projects, please ensure you comply with their respective licenses and give appropriate credit.

## Example footer

```text
TPS ⣤⣸⠀⠀⠀⠀⠀⠀ 42 avg | μ 38 | p10 25 | p95 55 | TTFT μ 0.25s | Elapsed 15s | 2026-06-24T02:22:47Z
```

## Install

```bash
pi install npm:pi-pulse
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-pulse"]
}
```

> **Security:** Pi extensions run with your full system permissions. Only install from sources you trust. This package is published with npm [provenance](https://docs.npmjs.com/generating-provenance-statements/) so you can verify it was built from this repository.

### Local development

1. Clone or copy this repository.
2. Add the source extension to `~/.pi/agent/settings.json`:

   ```json
   {
     "extensions": ["/path/to/pi-pulse/src/extension.ts"]
   }
   ```
3. Remove the stock `pi-tps-meter` extension if it is enabled.
4. Reload pi: `/reload`.

## Build

```bash
npm install
npm run build
```

The compiled output lands in `dist/` and is declared in `package.json#pi.extensions`.

## Test

```bash
npm test
```

Or run the shell runner:

```bash
./run-tests.sh
```

## Project layout

```text
pi-pulse/
├── src/
│   ├── extension.ts   # Pi event wiring
│   ├── meter.ts       # TPS/TTFT/Elapsed accumulator
│   ├── graph.ts       # Braille sparkline renderer
│   ├── format.ts      # Formatting / color helpers
│   └── constants.ts   # Configuration
├── test/
│   ├── format.test.mjs       # Formatting and color helper tests
│   ├── graph.test.mjs        # Braille sparkline tests
│   ├── meter.test.mjs        # Stats accumulator lifecycle tests
│   ├── extension.test.mjs    # Pi event wiring and ticker tests
│   ├── stats.test.mjs        # Integration tests through the extension wiring
│   └── ttft-leak.test.mjs    # Tool-only / no-first-token correctness check
├── docs/
│   ├── README.md            # Documentation index
│   ├── getting-started.md   # Install, build, and dev setup
│   ├── metrics.md           # What TPS, TTFT, and Elapsed mean
│   ├── architecture.md      # System design and tradeoffs
│   ├── testing.md           # Test guide
│   └── contributing.md      # Contributor guide
├── AGENTS.md          # Developer guidelines for this project
├── CHANGELOG.md       # Release history
├── CONTRIBUTING.md    # Pointer to docs/contributing.md
├── SECURITY.md        # Security policy
├── LICENSE
├── NOTICE             # Upstream inspiration attribution
├── package.json
├── tsconfig.json
├── run-tests.sh
└── README.md
```

## How it measures

Pi streams assistant output through `message_update` events. pi-pulse recognizes three *token-like* delta events:

| Event | Counts for TPS | Stops TTFT timer | Notes |
|-------|----------------|------------------|-------|
| `text_delta` | yes | yes | Normal assistant text |
| `thinking_delta` | yes | yes | Hidden reasoning tokens |
| `toolcall_delta` | yes | yes | Streamed tool parameters — covers `write`, `edit`, `bash`, and any other tool call that streams its arguments |

Other events such as `text_start`, `toolcall_end`, and `done` are lifecycle markers with no token payload, so they are ignored by the meter. A non-streamed `toolcall_start` (not followed by deltas) carries no token stream but still marks the first assistant output, so it stops the TTFT timer without contributing to TPS.

**TTFT** is measured from `before_provider_request` to the first assistant output token (`text_delta`, `thinking_delta`, `toolcall_delta`) or non-streamed `toolcall_start` of the same assistant message.

**TPS** is `estimated_tokens / decode_elapsed`, where decode elapsed runs from the first assistant output token to `message_end`. This is a decode-phase throughput metric (equivalent to `1 / TPOT` as defined by the IETF LLM benchmarking terminology), measuring how fast the model generates tokens once it starts talking, independent of prefill latency. TTFT separately captures the prefill cost. Both the live display and the sample stored on `message_end` are suppressed when the decode phase is shorter than `TPS_MIN_ELAPSED_SEC` (0.3s), so they never disagree.

**p10** is the 10th percentile of TPS samples within the trailing 10-minute window — the floor of the recent throughput distribution. It shows the slowest decode speed you are likely to encounter, complementing p95 which shows the fastest. A large gap between p10 and p95 indicates variable streaming performance across recent responses.

**Trailing window.** The TPS mean (μ), p10, p95, and TTFT mean are computed over a **trailing 10-minute window**. Older samples are retained in memory (up to a count cap of 512) but excluded from these statistics. This ensures the numbers reflect the provider's *current* behavior, not an average that includes stale data from hours ago. The `avg` field uses a shorter 60-second rolling window for a more reactive view. **Elapsed** is a cumulative counter and is not windowed — it shows the total time spent waiting across the entire session.

**Elapsed** is the end-to-end (E2E) request latency accumulated across all completed assistant responses. Each response measures from `before_provider_request` to `message_end`, capturing the full user-perceived wait time including request serialization, network latency, and provider prefill. If `before_provider_request` did not fire for a response, the fallback anchor is `message_start`. While a response is streaming, the live footer shows the current E2E latency; once idle, the footer freezes and displays the accumulated total, which is persisted across reloads/resumes.

**Clock** is the current wall-clock time rendered as `YYYY-MM-DDTHH:MM:SSZ` (ISO 8601 UTC, second precision) and appended after Elapsed. A session-scoped ticker re-renders the idle footer every second so the timestamp stays current even when nothing is streaming; while streaming, the faster live ticker already refreshes it. The clock is presentation only — it lives in the extension layer, not the metric meter — so it never affects TPS/TTFT/Elapsed measurements.

## Persistence across reloads

On `session_shutdown` the meter saves a compact snapshot
(`customType: "pi-pulse/snapshot"`) to the current session file.
On the next `session_start` (reload, resume, or restart of the same session)
it restores the TPS/TTFT buffers (with timestamps shifted to the current
monotonic clock), rolling-window average, sparkline,
and the accumulated elapsed time.

New sessions (`/new`, `/fork`) intentionally start fresh; only the same
underlying session file restores the snapshot.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please also read [AGENTS.md](./AGENTS.md) if you are using the pi coding agent to modify this repository.

## License

[MIT](./LICENSE)
