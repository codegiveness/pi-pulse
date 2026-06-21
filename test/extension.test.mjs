import assert from "node:assert";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import statsMeterExtension from "../dist/extension.js";

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
	statsMeterExtension(pi);
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
	statsMeterExtension(pi);
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
	assert.strictEqual(entries[0]?.type, "pi-stats-meter/snapshot");
	const snapshot = entries[0]?.data;
	assert.ok(snapshot, "snapshot data should be present");

	// Simulate a fresh extension load / reload with the persisted snapshot in the session branch.
	const pi2 = createMockPiWithEntries([]);
	const ctx2 = createMockCtx();
	ctx2.sessionManager.getBranch = () => [
		{ type: "custom", customType: "pi-stats-meter/snapshot", data: snapshot },
	];
	await pi2.emit("session_start", ctx2, { type: "session_start", reason: "reload" });

	const restored = ctx2.statuses.find((s) => s.key === "tps" && s.text !== undefined);
	assert.ok(restored, `expected restored footer after session_start, got ${JSON.stringify(ctx2.statuses)}`);
	assert.ok(restored.text.includes("TTFT"), `expected TTFT in restored footer: ${restored.text}`);
	assert.ok(restored.text.includes("Elapsed"), `expected Elapsed in restored footer: ${restored.text}`);
});
