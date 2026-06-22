# Metrics reference

pi-pulse exists so you can judge providers and models with numbers instead of gut feelings. It measures three orthogonal, additive quantities for every assistant response:

```text
Elapsed ≈ TTFT + decode_time
```

Because the metrics are non-overlapping, you can reason about *which* part of a response feels slow: the wait before output starts, the speed of generation, or the total wall-clock wait.

---

## TL;DR: reading the footer

### While streaming (live)

```text
⠼ ⣤⣸⠀⠀⠀⠀⠀⠀ 42 tps | TTFT 0.25s | Elapsed 0.6s
```

| Field | Meaning |
|-------|---------|
| `TPS` | Live decode-phase throughput for the response in flight. |
| `TTFT` | Either a ticking wait indicator before the first token, or the measured time-to-first-token once it arrives. |
| `Elapsed` | Current end-to-end latency for this request so far. |

### While idle (final)

```text
TPS ⣤⣸⠀⠀⠀⠀⠀⠀ 42 avg | μ 38 | p10 25 | p95 55 | TTFT μ 0.25s | Elapsed 15s
```

| Field | Meaning |
|-------|---------|
| `avg` | 60-second rolling average of completed-response TPS. |
| `μ` | Mean TPS over the last **10 minutes**. |
| `p10` | 10th percentile of TPS over the last **10 minutes** — the "floor" you can usually expect. |
| `p95` | 95th percentile of TPS over the last **10 minutes** — the "ceiling". |
| `TTFT μ` | Mean time to first token over the last **10 minutes**. |
| `Elapsed` | Accumulated end-to-end request latency for the whole session. |

---

## What each metric measures

### TTFT — time to first token

```text
TTFT = first_assistant_output - before_provider_request
```

TTFT measures the user-perceived wait before the model produces any output. It includes request serialization, network round-trip, provider queueing, and prefill computation (KV-cache construction).

The "first assistant output" is the earliest of:

- `text_delta`
- `thinking_delta`
- `toolcall_delta`
- `toolcall_start` (non-streamed tool call)

If a response produces no assistant output at all, no TTFT sample is recorded.

| Color | Range | Meaning |
|-------|-------|---------|
| success | `<= 0.5 s` | Fast prefill / routing. |
| warning | `0.5 – 2.0 s` | Acceptable, but shows prefill/network cost. |
| error | `> 2.0 s` | Slow prefill, queueing, or provider routing. |

**Use it for:** comparing prefill performance across providers or models, especially on long contexts or reasoning models.

---

### TPS — tokens per second (decode phase)

```text
tokens = estimated_tokens(streamed_output)
T2     = time of first assistant output token
T3     = message_end
TPS    = tokens / (T3 - T2)
```

TPS measures how fast the model generates tokens *after* it starts producing output. It intentionally excludes the prefill wait measured by TTFT, matching the industry-standard `1 / TPOT` definition from the IETF LLM benchmarking terminology.

Token counts are estimated because provider streams do not always report per-delta token counts. The estimate is **≈ 4 characters per token**.

A TPS sample is recorded only when:

- at least one output token arrived, and
- the decode phase lasted at least **0.3 s** (`TPS_MIN_ELAPSED_SEC`).

This prevents very short responses from producing absurdly high, noisy values.

| Color | Range | Meaning |
|-------|-------|---------|
| success | `>= 50 t/s` | Fast generation. |
| warning | `20 – 49 t/s` | Moderate generation. |
| error | `< 20 t/s` | Slow generation. |

**Use it for:** comparing raw generation speed. A large gap between `p10` and `p95` means throughput is bouncy (likely load- or routing-dependent).

---

### Elapsed — end-to-end request latency

```text
T0 = before_provider_request
T3 = message_end
per_response_elapsed = T3 - T0 (with fallback to T3 - message_start)
total_elapsed       = Σ per_response_elapsed
```

Elapsed is a cumulative counter of the total time you have spent waiting for assistant responses during the session. It captures the full user-perceived wait, including serialization, network, prefill, and decode.

While a response is streaming, the footer shows the live current E2E latency. Once the response ends, the footer freezes and shows the running total.

Elapsed is **not** windowed: it grows monotonically for the lifetime of the session and is persisted across Pi reloads/resumes.

**Use it for:** scoring total session cost in wall-clock time, or comparing the full latency of one provider/model to another on real tasks.

---

## Time windows — why the numbers move

Provider performance is **non-stationary**. A model may be fast at 09:00 and slow at 09:10 because of load, routing, or context length. pi-pulse uses fixed time windows so the numbers describe the provider you are using *now*, not the average of the whole session.

| Statistic | Window | Why |
|-----------|--------|-----|
| TPS `avg` | 60 seconds | Reactive recent throughput. |
| TPS `μ`, `p10`, `p95` | 10 minutes | Stable enough for a meaningful distribution, short enough to age out stale behavior. |
| TTFT `μ` | 10 minutes | Same reasoning as TPS distribution. |
| Elapsed | none | Cumulative total. Windowing would destroy its meaning. |

Older samples remain in bounded ring buffers (max **512** entries) but are excluded from mean/percentile calculations. If you idle for more than 10 minutes, the footer will drop the TPS/TTFT stats and show only `Elapsed` until the next assistant response refreshes the window.

---

## Comparing providers and models

pi-pulse can not tell you which model is "best" in the abstract — it can only tell you how fast the providers you actually use are on the work you actually do. For fair comparisons:

1. **Use similar prompts and context lengths.** Prefill latency is extremely sensitive to context size.
2. **Run more than one response.** A single response is not a benchmark; look at `μ`, `p10`, and `p95` once several samples are in the 10-minute window.
3. **Watch TTFT for prefill quality.** A model with high TPS but terrible TTFT can still feel sluggish.
4. **Watch `p10` for usability.** The floor tells you the worst decode speed you are likely to hit. A high `p95` with a low `p10` means unpredictable performance.
5. **Compare Elapsed on real tasks.** If you measure a series of similar edits/reasoning steps, the session total is the most honest comparison.

---

## Caveats

- **Token counts are estimates.** They are not provider-reported tokens, so absolute numbers may differ from provider dashboards. Relative comparisons (same provider, different models/tasks) are still valid.
- **Short responses are suppressed.** TPS samples and live display are suppressed when the decode phase is under 0.3 s.
- **The sparkline is not time-windowed.** It shows the last 20 completed-response TPS samples. After a long idle, it may briefly show old bars while the numeric stats have already dropped to 0.
- **Tool-only responses may show only TTFT.** Non-streamed tool calls stop the TTFT timer but contribute no tokens, so they do not produce a TPS sample.

---

## Glossary

| Term | Meaning |
|------|---------|
| **TTFT** | Time to First Token. |
| **TPS** | Tokens per second during the decode phase. Equivalent to `1 / TPOT`. |
| **TPOT** | Time per Output Token; pi-pulse TPS is the reciprocal. |
| **E2E latency** | End-to-end request latency (`message_end - before_provider_request`). |
| **p10** | 10th percentile — the value below which 10 % of recent samples fall. |
| **p95** | 95th percentile — the value below which 95 % of recent samples fall. |
