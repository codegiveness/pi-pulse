import assert from "node:assert";
import test from "node:test";
import piPulseExtension from "../dist/extension.js";
import { createMeter } from "../dist/meter.js";
import { withFakeTimers } from "./_fake-timers.mjs";

function makeClock(initial = 0) {
	let t = initial;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
	};
}

function createMockCtx({ signal } = {}) {
	const statuses = [];
	return {
		hasUI: true,
		mode: "tui",
		signal,
		sessionManager: {
			getBranch: () => [],
		},
		ui: {
			theme: {
				fg: (name, text) => `[${name}:${text}]`,
			},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
		},
		statuses,
	};
}

function createMockPiWithEntries(entries = []) {
	const handlers = {};
	const pi = {
		on(event, handler) {
			(handlers[event] ||= []).push(handler);
		},
		async emit(event, ctx, payload = {}) {
			const list = handlers[event] || [];
			for (const h of list) {
				await h(payload, ctx);
			}
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		handlers,
	};
	piPulseExtension(pi);
	return pi;
}

function createMockPi({ meter } = {}) {
	const handlers = {};
	const pi = {
		on(event, handler) {
			(handlers[event] ||= []).push(handler);
		},
		async emit(event, ctx, payload = {}) {
			const list = handlers[event] || [];
			for (const h of list) {
				await h(payload, ctx);
			}
		},
		handlers,
	};
	piPulseExtension(pi, { meter });
	return pi;
}

test("registers every handler pi-pulse needs", () => {
	const pi = createMockPi();
	for (const e of [
		"session_start",
		"before_provider_request",
		"message_start",
		"message_update",
		"message_end",
		"session_shutdown",
	]) {
		assert.ok(pi.handlers[e]?.length > 0, `expected handler for ${e}`);
	}
});

test("session_start resets status", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();
	await pi.emit("session_start", ctx, { type: "session_start", reason: "startup" });
	const cleared = ctx.statuses.find((s) => s.key === "tps" && s.text === undefined);
	assert.ok(cleared, `expected status cleared, got ${JSON.stringify(ctx.statuses)}`);
});

test("non-assistant messages are ignored", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();

	await pi.emit("message_start", ctx, { message: { role: "user" } });
	await pi.emit("message_update", ctx, { message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
	await pi.emit("message_end", ctx, { message: { role: "user" } });

	assert.strictEqual(ctx.statuses.length, 0);
});

test("assistant streaming lifecycle renders live and final status", async () => {
	await withFakeTimers(async (timers) => {
		const ctx = createMockCtx();
		const pi = createMockPi();

		await pi.emit("before_provider_request", ctx, { type: "before_provider_request", payload: {} });
		await pi.emit("message_start", ctx, { message: { role: "assistant" } });

		await pi.emit("message_update", ctx, {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "hello world" },
		});

		timers.tick(2); // drive the live ticker synchronously

		const liveCount = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
		assert.ok(liveCount >= 1, `expected at least one live status, got ${liveCount}`);

		const before = ctx.statuses.length;
		await pi.emit("message_end", ctx, { message: { role: "assistant" } });
		const afterMessageEnd = ctx.statuses.length;
		assert.ok(afterMessageEnd > before, "expected final status after message_end");

		// The ticker was stopped on message_end; further ticks are no-ops.
		timers.tick(2);
		assert.strictEqual(ctx.statuses.length, afterMessageEnd, "ticker should stop after message_end");
	});
});

test("session_shutdown stops ticker and clears status", async () => {
	await withFakeTimers(async (timers) => {
		const ctx = createMockCtx();
		const pi = createMockPi();

		await pi.emit("message_start", ctx, { message: { role: "assistant" } });
		timers.tick(2);
		const liveCount = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
		assert.ok(liveCount >= 1);

		await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
		const cleared = ctx.statuses.at(-1);
		assert.strictEqual(cleared.key, "tps");
		assert.strictEqual(cleared.text, undefined);

		const before = ctx.statuses.length;
		timers.tick(2);
		assert.strictEqual(ctx.statuses.length, before, "ticker should stop after session_shutdown");
	});
});

test("abort signal stops the live ticker", async () => {
	await withFakeTimers(async (timers) => {
		const controller = new AbortController();
		const ctx = createMockCtx({ signal: controller.signal });
		const pi = createMockPi();

		await pi.emit("message_start", ctx, { message: { role: "assistant" } });
		timers.tick(2);
		const liveCountBefore = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
		assert.ok(liveCountBefore >= 1);

		controller.abort();

		const before = ctx.statuses.length;
		timers.tick(2);
		assert.strictEqual(ctx.statuses.length, before, "ticker should stop when signal aborts");
	});
});

test("session_shutdown persists snapshot and session_start restores it", async () => {
	await withFakeTimers(async (timers) => {
		const entries = [];
		const pi = createMockPiWithEntries(entries);

		const ctx1 = createMockCtx();
		await pi.emit("before_provider_request", ctx1, { type: "before_provider_request", payload: {} });
		await pi.emit("message_start", ctx1, { message: { role: "assistant" } });
		await pi.emit("message_update", ctx1, {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "hello world" },
		});
		timers.tick();
		await pi.emit("message_end", ctx1, { message: { role: "assistant" } });
		await pi.emit("session_shutdown", ctx1, { type: "session_shutdown", reason: "reload" });

		assert.strictEqual(entries.length, 1, "expected snapshot persisted on shutdown");
		assert.strictEqual(entries[0]?.type, "pi-pulse/snapshot");
		const snapshot = entries[0]?.data;
		assert.ok(snapshot, "snapshot data should be present");

		// Simulate a fresh extension load / reload with the persisted snapshot in the session branch.
		const pi2 = createMockPiWithEntries([]);
		const ctx2 = createMockCtx();
		ctx2.sessionManager.getBranch = () => [
			{ type: "custom", customType: "pi-pulse/snapshot", data: snapshot },
		];
		await pi2.emit("session_start", ctx2, { type: "session_start", reason: "reload" });

		const restored = ctx2.statuses.find((s) => s.key === "tps" && s.text !== undefined);
		assert.ok(restored, `expected restored footer after session_start, got ${JSON.stringify(ctx2.statuses)}`);
		assert.ok(restored.text.includes("TTFT"), `expected TTFT in restored footer: ${restored.text}`);
		assert.ok(restored.text.includes("Elapsed"), `expected Elapsed in restored footer: ${restored.text}`);
	});
});

test("no status calls when UI is unavailable", async () => {
	await withFakeTimers(async (timers) => {
		const ctx = createMockCtx();
		ctx.hasUI = false;
		const pi = createMockPi();
		await pi.emit("session_start", ctx, { type: "session_start", reason: "startup" });
		await pi.emit("message_start", ctx, { message: { role: "assistant" } });
		timers.tick(2);
		assert.strictEqual(ctx.statuses.length, 0, "expected no status calls when hasUI is false");
		await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
	});
});

test("throwing setStatus does not crash the extension", async () => {
	await withFakeTimers(async (timers) => {
		const ctx = createMockCtx();
		ctx.ui.setStatus = () => { throw new Error("boom"); };
		const pi = createMockPi();
		await pi.emit("session_start", ctx, { type: "session_start", reason: "startup" });
		await assert.doesNotReject(async () => {
			await pi.emit("message_start", ctx, { message: { role: "assistant" } });
			timers.tick(2);
			await pi.emit("message_end", ctx, { message: { role: "assistant" } });
		});
	});
});

test("session_start restores the latest snapshot from a branch with multiple entries", async () => {
	const entries = [
		{ type: "custom", customType: "pi-pulse/snapshot", data: { savedAt: 0, allTps: { values: [], times: [] }, allTtft: { values: [], times: [] }, win: { values: [], times: [] }, graph: [], lastElapsedMs: 0, totalElapsedMs: 0 } },
		{ type: "custom", customType: "other-plugin/snapshot", data: {} },
		{ type: "custom", customType: "pi-pulse/snapshot", data: { savedAt: 1000, allTps: { values: [10], times: [1000] }, allTtft: { values: [0.2], times: [1000] }, win: { values: [10], times: [1000] }, graph: [10], lastElapsedMs: 100, totalElapsedMs: 100 } },
	];
	const ctx = createMockCtx();
	ctx.sessionManager.getBranch = () => entries;
	const pi = createMockPiWithEntries([]);
	await pi.emit("session_start", ctx, { type: "session_start", reason: "reload" });
	const restored = ctx.statuses.find((s) => s.key === "tps" && s.text !== undefined);
	assert.ok(restored, "expected restored footer with latest snapshot");
	// The latest snapshot has totalElapsedMs: 100 -> "Elapsed" is rendered.
	// The stale snapshot has totalElapsedMs: 0 -> renderFinal returns "" -> no status pushed.
	// A non-empty restored footer therefore proves the LATEST snapshot was picked.
	assert.ok(restored.text.includes("Elapsed"), `expected Elapsed from latest snapshot: ${restored.text}`);
});

test("ticker renders deterministic values with an injected fake-clock meter", async () => {
	await withFakeTimers(async (timers) => {
		const clock = makeClock(0);
		const meter = createMeter({ now: clock.now });
		const pi = createMockPi({ meter });
		const ctx = createMockCtx();

		clock.advance(100);
		await pi.emit("before_provider_request", ctx, { type: "before_provider_request", payload: {} });
		clock.advance(200);
		await pi.emit("message_start", ctx, { message: { role: "assistant" } });
		clock.advance(100);
		await pi.emit("message_update", ctx, {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		});

		// The meter is driven by the fake clock and the ticker is driven by the
		// fake timer, so the rendered live footer is fully deterministic.
		timers.tick();

		const live = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).pop();
		// Stop the ticker before asserting so a failed assertion does not leave
		// a dangling interval behind.
		await pi.emit("message_end", ctx, { message: { role: "assistant" } });

		assert.ok(live, "expected a live status render from the ticker");
		assert.ok(live.text.includes("0.30s"), `expected TTFT 0.30s in live footer: ${live.text}`);
		assert.ok(live.text.includes("0.3s"), `expected Elapsed 0.3s in live footer: ${live.text}`);
	});
});
