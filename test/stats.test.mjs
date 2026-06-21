// Functional integration test for pi-pulse.
// Drives the compiled extension handlers through a fake Pi runtime using the
// real wall-clock timer (the extension factory creates its own meter), with
// short sleeps so the full suite runs in a few seconds.
import assert from "node:assert";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import piPulseExtension from "../dist/extension.js";

// Short tick wait: TICK_MS = 250. One tick needs ~250 ms of real time.
const TICK = 260;

function createMockCtx({ signal } = {}) {
	const statuses = [];
	return {
		hasUI: true,
		mode: "tui",
		signal,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_n, t) => t },
			setStatus: (k, t) => statuses.push({ k, t }),
		},
		statuses,
	};
}

function createMockPi({ entries } = {}) {
	const handlers = new Map();
	const pi = {
		on(event, fn) {
			(handlers.get(event) ?? handlers.set(event, []).get(event)).push(fn);
		},
		async emit(event, ctx, payload = {}) {
			for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
		},
		appendEntry(type, data) {
			entries?.push({ type, data });
		},
		handlers,
	};
	piPulseExtension(pi);
	return pi;
}

function lastStatus(statuses, key = "tps") {
	for (let i = statuses.length - 1; i >= 0; i--) {
		if (statuses[i].k === key) return statuses[i].t;
	}
	return null;
}

function matchTtftMu(text) {
	return text?.match(/TTFT μ ([\d.]+)s/)?.[1];
}

function matchElapsed(text) {
	return text?.match(/Elapsed (.+)$/)?.[1];
}

test("[1] registers every handler pi-pulse needs", () => {
	const pi = createMockPi();
	for (const e of [
		"session_start",
		"before_provider_request",
		"message_start",
		"message_update",
		"message_end",
		"session_shutdown",
	]) {
		assert.ok(pi.handlers.has(e), `expected handler for ${e}`);
	}
});

test("[2] TTFT measured from before_provider_request → first token", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	// Short prefill: ~80 ms before first token.
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "Hello" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	assert.ok(f?.includes("TTFT"), `expected TTFT in ${f}`);
	assert.ok(f.includes("TTFT μ"), `expected TTFT μ in ${f}`);
	const ttft = matchTtftMu(f);
	assert.ok(ttft && parseFloat(ttft) > 0.05 && parseFloat(ttft) < 0.25, `TTFT ~0.08s, got ${ttft}`);
});

test("[3] single-line format matches spec", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	assert.ok(/^TPS /.test(f), `TPS first in ${f}`);
	assert.ok(f.split(" | ").length >= 3, `single-line with separators in ${f}`);
	assert.ok(/p10 [\d.]+ \| p95 [\d.]+ \| TTFT μ [\d.]+s \| Elapsed/.test(f), `order in ${f}`);
});

test("[4] thinking_delta counts as first token for TTFT", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "thinking_delta", delta: "hmm some tokens here" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const ttft = matchTtftMu(f);
	assert.ok(ttft && parseFloat(ttft) > 0.05 && parseFloat(ttft) < 0.25, `thinking TTFT ~0.08s, got ${ttft}`);
});

test("[5] TTFT μ is the mean across messages", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "first message tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });

	// Second message with a different prefill (≈160 ms).
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(160);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "second message tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const mu = matchTtftMu(f);
	assert.ok(mu && parseFloat(mu) > 0.08 && parseFloat(mu) < 0.22, `TTFT μ ≈ mean(0.08,0.16), got ${mu}`);
});

test("[6] session_start resets TTFT + elapsed", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	// First: a longish elapsed.
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(400);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	// Reset and produce a much shorter response.
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(10);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(120);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "real tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const mu = matchTtftMu(f);
	assert.ok(mu && parseFloat(mu) < 0.3, `post-reset TTFT small, got ${mu}`);
	// Elapsed total also resets: only the second response (~0.13s) accumulates.
	const el = matchElapsed(f);
	assert.ok(el && parseFloat(el) < 0.5, `post-reset elapsed small, got ${el}`);
});

test("[7] reqStart does not leak across responses", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	// A message with no first-token event should not leave a stale requestStart.
	await pi.emit("before_provider_request", ctx);
	await sleep(10);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	// Now a real response; TTFT should be measured from its own requestStart.
	await pi.emit("before_provider_request", ctx);
	await sleep(30);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(120);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "real tokens here" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const mu = matchTtftMu(f);
	assert.ok(mu && parseFloat(mu) < 0.4, `no stale reqStart leak, got ${mu}`);
});

test("[8] Elapsed format pattern", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	assert.ok(/Elapsed (\d+(\.\d+)?s|\d+m \d\d?s|\d+h \d\d?m \d\d?s)$/.test(f), `valid elapsed in ${f}`);
});

test("[9] live TTFT: prefill phase A then measured phase B", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(TICK);
	const liveA = lastStatus(ctx.statuses);
	assert.ok(/TTFT [\d.]+s…/.test(liveA), `Phase A waiting TTFT in ${liveA}`);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x tokens" },
	});
	await sleep(TICK);
	const liveB = lastStatus(ctx.statuses);
	assert.ok(/TTFT [\d.]+s(?!…)/.test(liveB) && !liveB.includes("…"), `Phase B measured TTFT in ${liveB}`);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
});

test("[10] no nerd-font glyphs in output", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const all = ctx.statuses.map((s) => s.t).filter(Boolean).join(" ");
	assert.ok(!all.includes("⏱") && !all.includes("⏰"));
	assert.ok(all.includes("Elapsed"));
});

test("[11] non-assistant messages ignored", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	ctx.statuses.length = 0;
	await pi.emit("message_start", ctx, { message: { role: "user" } });
	await pi.emit("message_update", ctx, {
		message: { role: "user" },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
	await pi.emit("message_end", ctx, { message: { role: "user" } });
	assert.strictEqual(ctx.statuses.length, 0, `no status calls for user msgs, got ${ctx.statuses.length}`);
});

test("[12] non-streamed toolcall_start marks first token and stops TTFT", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(40);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	// A non-streamed tool call: toolcall_start with NO subsequent deltas.
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_start" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	assert.ok(f?.includes("TTFT"), `expected TTFT in ${f}`);
	const mu = matchTtftMu(f);
	// ~0.08s prefill; recorded despite no token stream.
	assert.ok(mu && parseFloat(mu) > 0.05 && parseFloat(mu) < 0.25, `toolcall_start TTFT, got ${mu}`);
});

test("[13] TTFT resets per assistant message across a tool-only gap", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	// First: normal text response.
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "m1" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });

	// Second: a non-streamed tool call (toolcall_start) — must still record TTFT.
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_start" },
	});
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });

	// Third: another text response after the tool gap. TTFT μ must stay small.
	await pi.emit("before_provider_request", ctx);
	await sleep(20);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "m2" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const mu = matchTtftMu(f);
	assert.ok(mu && parseFloat(mu) < 0.4, `TTFT μ small after tool gap, got ${mu}`);
});

test("[14] elapsed frozen while idle", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "tokens" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const before = matchElapsed(lastStatus(ctx.statuses));
	await sleep(500);
	const after = matchElapsed(lastStatus(ctx.statuses));
	assert.strictEqual(before, after, `elapsed frozen while idle: ${before} vs ${after}`);
});

test("[15] toolcall_delta counts as output and stops TTFT prefill", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx);
	await pi.emit("before_provider_request", ctx);
	await sleep(30);
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await sleep(80);
	// First streamed tool-call parameter bytes count as the first token.
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: "a".repeat(8_000) },
	});
	await sleep(TICK);
	const live = lastStatus(ctx.statuses);
	assert.ok(/TTFT [\d.]+s(?!…)/.test(live) && !live.includes("…"), `first toolcall_delta stops TTFT: ${live}`);
	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: "b".repeat(4_000) },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const f = lastStatus(ctx.statuses);
	const tps = f?.match(/TPS .*? ([\d.]+) avg/)?.[1];
	assert.ok(tps && parseFloat(tps) > 10, `toolcall_delta contributes high TPS, got ${tps}`);
});

test("[16] session_shutdown persists snapshot and session_start restores it", async () => {
	const entries = [];
	const ctx1 = createMockCtx();
	const pi = createMockPi({ entries });
	await pi.emit("session_start", ctx1);
	await pi.emit("before_provider_request", ctx1);
	await pi.emit("message_start", ctx1, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi.emit("message_update", ctx1, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});
	await sleep(TICK);
	await pi.emit("message_end", ctx1, { message: { role: "assistant" } });
	await pi.emit("session_shutdown", ctx1, { type: "session_shutdown", reason: "reload" });
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].type, "pi-pulse/snapshot");
	const snapshot = entries[0].data;
	assert.ok(snapshot);

	const pi2 = createMockPi();
	const ctx2 = createMockCtx();
	ctx2.sessionManager.getBranch = () => [{ type: "custom", customType: "pi-pulse/snapshot", data: snapshot }];
	await pi2.emit("session_start", ctx2, { type: "session_start", reason: "reload" });
	const restored = lastStatus(ctx2.statuses);
	assert.ok(restored, `expected restored footer, got ${ctx2.statuses}`);
	assert.ok(restored.includes("TTFT"), `TTFT in restored: ${restored}`);
	assert.ok(restored.includes("Elapsed"), `Elapsed in restored: ${restored}`);
});
