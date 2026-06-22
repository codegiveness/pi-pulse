import assert from "node:assert";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import piPulseExtension from "../dist/extension.js";

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

function createMockPi() {
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
	piPulseExtension(pi);
	return pi;
}

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
	const ctx = createMockCtx();
	const pi = createMockPi();

	await pi.emit("before_provider_request", ctx, { type: "before_provider_request", payload: {} });
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });

	await pi.emit("message_update", ctx, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});

	await setTimeout(300); // one tick at TICK_MS = 250ms

	const liveCount = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
	assert.ok(liveCount >= 1, `expected at least one live status, got ${liveCount}`);

	const before = ctx.statuses.length;
	await pi.emit("message_end", ctx, { message: { role: "assistant" } });
	const afterMessageEnd = ctx.statuses.length;
	assert.ok(afterMessageEnd > before, "expected final status after message_end");

	// Wait to ensure the ticker was stopped.
	await setTimeout(300);
	const afterWait = ctx.statuses.length;
	assert.strictEqual(afterWait, afterMessageEnd, "ticker should stop after message_end");
});

test("session_shutdown stops ticker and clears status", async () => {
	const ctx = createMockCtx();
	const pi = createMockPi();

	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await setTimeout(300);
	const liveCount = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
	assert.ok(liveCount >= 1);

	await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
	const cleared = ctx.statuses.at(-1);
	assert.strictEqual(cleared.key, "tps");
	assert.strictEqual(cleared.text, undefined);

	const before = ctx.statuses.length;
	await setTimeout(300);
	assert.strictEqual(ctx.statuses.length, before, "ticker should stop after session_shutdown");
});

test("abort signal stops the live ticker", async () => {
	const controller = new AbortController();
	const ctx = createMockCtx({ signal: controller.signal });
	const pi = createMockPi();

	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await setTimeout(300);
	const liveCountBefore = ctx.statuses.filter((s) => s.key === "tps" && s.text !== undefined).length;
	assert.ok(liveCountBefore >= 1);

	controller.abort();

	const before = ctx.statuses.length;
	await setTimeout(300);
	assert.strictEqual(ctx.statuses.length, before, "ticker should stop when signal aborts");
});

test("session_shutdown persists snapshot and session_start restores it", async () => {
	const entries = [];
	const pi = createMockPiWithEntries(entries);

	const ctx1 = createMockCtx();
	await pi.emit("before_provider_request", ctx1, { type: "before_provider_request", payload: {} });
	await pi.emit("message_start", ctx1, { message: { role: "assistant" } });
	await pi.emit("message_update", ctx1, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});
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

test("no status calls when UI is unavailable", async () => {
	const ctx = createMockCtx();
	ctx.hasUI = false;
	const pi = createMockPi();
	await pi.emit("session_start", ctx, { type: "session_start", reason: "startup" });
	await pi.emit("message_start", ctx, { message: { role: "assistant" } });
	await setTimeout(300);
	assert.strictEqual(ctx.statuses.length, 0, "expected no status calls when hasUI is false");
	// Stop the ticker the message_start handler started (hasUI is false, so
	// session_shutdown's safeSetStatus is a no-op and does not affect the assertion).
	await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
});

test("throwing setStatus does not crash the extension", async () => {
	const ctx = createMockCtx();
	ctx.ui.setStatus = () => { throw new Error("boom"); };
	const pi = createMockPi();
	await pi.emit("session_start", ctx, { type: "session_start", reason: "startup" });
	await assert.doesNotReject(async () => {
		await pi.emit("message_start", ctx, { message: { role: "assistant" } });
		await setTimeout(300);
		await pi.emit("message_end", ctx, { message: { role: "assistant" } });
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
