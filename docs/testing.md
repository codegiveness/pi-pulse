# Testing guide

Every behavior change must be accompanied by a test. The suite is deterministic and does not require a running Pi instance.

## Run the suite

```bash
npm test
```

This invokes the `pretest` hook, which runs `npm run build`, then executes every `test/*.test.mjs` file with Node's built-in test runner.

```bash
# Run the shell wrapper instead
./run-tests.sh

# Type-check without building
npm run typecheck
```

## Test layout

| File | Focus |
|------|-------|
| `test/format.test.mjs` | Number/duration formatting and color helpers. |
| `test/graph.test.mjs` | Braille sparkline rendering, wraparound, and color thresholds. |
| `test/meter.test.mjs` | Full TPS/TTFT/Elapsed lifecycle, multi-message sequences, clock injection, buffer caps, snapshot restore, and time-windowing. |
| `test/extension.test.mjs` | Pi event wiring, start/stop of the live ticker, status clear on shutdown, and abort cleanup. |
| `test/stats.test.mjs` | Integration behavior through the extension wiring. |
| `test/ttft-leak.test.mjs` | Tool-only / no-first-token turns must not record phantom TTFT or TPS samples. |

## Use a fake clock

`StatsMeter` accepts an injectable `now()` function so tests can fully control time:

```ts
import { createMeter } from "../dist/meter.js";

let clock = 0;
const meter = createMeter({ now: () => clock });

meter.markRequestStart();
clock += 100;
meter.startAssistantMessage();
clock += 250;
meter.addDelta("text_delta", "hello world");
clock += 500;
meter.endAssistantMessage();

// Assertions are deterministic because we own the clock.
```

This pattern is used everywhere so the test suite does not depend on real wall-clock time or a live provider.

## What to assert

Good tests usually check one or more of:

- **Internal state** via `meter.inspect()`, e.g. sample counts, total elapsed, streaming flag.
- **Rendered output** via `meter.renderLive(theme)` or `meter.renderFinal(theme)`, using a small fake theme.
- **Snapshot round-trips** via `meter.serialize()` and `meter.restore(snapshot)`.
- **Resource cleanup** in extension tests, e.g. that `setInterval` is always paired with `clearInterval`.

## Adding a new test

1. Decide whether the behavior belongs in `meter.ts`, `extension.ts`, or a utility module.
2. Pick the matching test file (or create a new one if it does not fit).
3. Use the fake clock and assert on outcomes, not on intermediate steps.
4. Run `npm test` and make sure the new test is green and existing tests stay green.
5. If the change is user-facing, run `npx changeset` before opening a PR.

## Common pitfalls

- **Do not record phantom TTFT.** TTFT is recorded only when the first assistant output arrives, never on `message_end` or `session_shutdown`.
- **Do not let timers leak.** Every `setInterval` must be cleared on `message_end`, `session_shutdown`, or abort.
- **Cap every collection.** Anything that grows across a long session must have a fixed bound.
- **Keep tests deterministic.** Avoid `setTimeout`, real network calls, or provider I/O.
