// Minimal real-clock integration smoke tests for pi-pulse.
// The detailed, deterministic meter-level invariants are exercised in
// test/meter.test.mjs with a fake clock. Event wiring and the ticker are
// covered in test/extension.test.mjs. This file only proves the real
// extension_pi_ wiring still works end-to-end with wall-clock timers.

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

test("single assistant message produces a formatted footer end-to-end", async () => {
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

	const final = lastStatus(ctx.statuses);
	assert.ok(final, "expected a final footer status");
	assert.ok(/^TPS /.test(final), `expected TPS first in ${final}`);
	assert.ok(final.includes("TTFT"), `expected TTFT in ${final}`);
	assert.ok(final.includes("Elapsed"), `expected Elapsed in ${final}`);
});

test("non-assistant messages produce no footer", async () => {
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

	assert.strictEqual(ctx.statuses.length, 0);
});

test("snapshot persists across shutdown and restores on reload", async () => {
	const entries = [];
	const ctx1 = createMockCtx();
	const pi1 = createMockPi({ entries });

	await pi1.emit("session_start", ctx1);
	await pi1.emit("before_provider_request", ctx1);
	await pi1.emit("message_start", ctx1, { message: { role: "assistant" } });
	await sleep(TICK);
	await pi1.emit("message_update", ctx1, {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello world" },
	});
	await sleep(TICK);
	await pi1.emit("message_end", ctx1, { message: { role: "assistant" } });
	await pi1.emit("session_shutdown", ctx1, { type: "session_shutdown", reason: "reload" });

	assert.strictEqual(entries.length, 1, "expected snapshot persisted");
	assert.strictEqual(entries[0].type, "pi-pulse/snapshot");
	assert.ok(entries[0].data, "expected snapshot data");

	const pi2 = createMockPi();
	const ctx2 = createMockCtx();
	ctx2.sessionManager.getBranch = () => [
		{ type: "custom", customType: "pi-pulse/snapshot", data: entries[0].data },
	];
	await pi2.emit("session_start", ctx2, { type: "session_start", reason: "reload" });

	const restored = lastStatus(ctx2.statuses);
	assert.ok(restored, "expected restored footer after session_start");
	assert.ok(restored.includes("TTFT"), `expected TTFT in restored: ${restored}`);
	assert.ok(restored.includes("Elapsed"), `expected Elapsed in restored: ${restored}`);
});
