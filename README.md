# pi-stats-meter

Live footer meter for the [pi coding agent](https://pi.dev) that shows:

- **TPS** — tokens per second during assistant streaming (text, reasoning, and streamed tool-call parameters), with a braille sparkline, rolling average, mean, and p95
- **TTFT μ** — mean time from `before_provider_request` to the first assistant output token (text, thinking, or tool-call parameter delta)
- **Elapsed** — total wall-clock time the assistant spent generating responses during the session (accumulated across all completed assistant messages). While streaming, the live footer shows the current response duration; the idle footer shows the running total.

The extension replaces the stock `pi-tps-meter` footer key (`"tps"`).

## Example footer

```text
TPS ⣤⣸⠀⠀⠀⠀⠀⠀ 42 avg | μ 38 | p95 55 | TTFT μ 0.25s | Elapsed 15s
```

## Install

### Local development

1. Clone or copy this repository.
2. Add the source extension to `~/.pi/agent/settings.json`:

   ```json
   {
     "extensions": ["/path/to/pi-stats-meter/src/extension.ts"]
   }
   ```
3. Remove the stock `pi-tps-meter` extension if it is enabled.
4. Reload pi: `/reload`.

### As a Pi package (once published)

```bash
pi install npm:pi-stats-meter
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-stats-meter"]
}
```

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
pi-stats-meter/
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
├── AGENTS.md          # Developer guidelines for this project
├── CHANGELOG.md       # Release history
├── package.json
├── tsconfig.json
├── run-tests.sh
└── README.md
```

## How it measures

Pi streams assistant output through `message_update` events. pi-stats-meter recognizes three *token-like* delta events:

| Event | Counts for TPS | Stops TTFT timer | Notes |
|-------|----------------|------------------|-------|
| `text_delta` | yes | yes | Normal assistant text |
| `thinking_delta` | yes | yes | Hidden reasoning tokens |
| `toolcall_delta` | yes | yes | Streamed tool parameters — covers `write`, `edit`, `bash`, and any other tool call that streams its arguments |

Other events such as `text_start`, `toolcall_start`, `toolcall_end`, and `done` are lifecycle markers with no token payload, so they are ignored by the meter.

**TTFT** is measured from `before_provider_request` to the first assistant output token (`text_delta`, `thinking_delta`, `toolcall_delta`) or non-streamed `toolcall_start` of the same assistant message.

**TPS** is `estimated_tokens / response_elapsed`, where response elapsed runs from `message_start` to `message_end`. This is a user-perceived throughput metric (prefill wait included), which keeps short-prefill operations such as write/edit fast-looking while still penalizing long time-to-first-token. Both the live display and the sample stored on `message_end` are suppressed when the response is shorter than `TPS_MIN_ELAPSED_SEC` (0.3s), so they never disagree.

**Elapsed** is the total wall-clock time the assistant spent generating responses during the session. Each completed assistant message adds its `message_start → message_end` duration to the running total. While a response is streaming, the live footer shows the *current* response duration; once idle, the footer freezes and displays the accumulated total, which is persisted across reloads/resumes.

## Persistence across reloads

On `session_shutdown` the meter saves a compact snapshot
(`customType: "pi-stats-meter/snapshot"`) to the current session file.
On the next `session_start` (reload, resume, or restart of the same session)
it restores the all-time TPS/TTFT buffers, rolling-window average, sparkline,
and the accumulated elapsed time.

New sessions (`/new`, `/fork`) intentionally start fresh; only the same
underlying session file restores the snapshot.

## License

MIT
