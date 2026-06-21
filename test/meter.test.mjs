import assert from "node:assert";
import test from "node:test";
import { createMeter, isMeterSnapshot } from "../dist/meter.js";

const theme = {
	fg: (name, text) => `[${name}:${text}]`,
};

function makeClock(initial = 0) {
	let t = initial;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
		get: () => t,
	};
}

test("reset clears all state", () => {
	const clock = makeClock();
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(10);
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "hello world");
	clock.advance(400); // >= TPS_MIN_ELAPSED_SEC so a sample is recorded
	meter.endAssistantMessage();
	assert.ok(meter.inspect().tpsSamples > 0);

	meter.reset();
	const s = meter.inspect();
	assert.strictEqual(s.streaming, false);
	assert.strictEqual(s.tpsSamples, 0);
	assert.strictEqual(s.ttftSamples, 0);
	assert.strictEqual(s.lastElapsedMs, 0);
	assert.strictEqual(s.totalElapsedMs, 0);
	assert.strictEqual(s.graphLen, 0);
});

test("single assistant message records TTFT, TPS, elapsed and graph", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(100); // request at t=1000, message starts at t=1100
	meter.startAssistantMessage();
	clock.advance(100); // first token at t=1200
	meter.addDelta("text_delta", "hello world"); // 11 chars -> 3 tokens
	clock.advance(400); // end at t=1600, elapsed 500ms
	meter.addDelta("text_delta", " again"); // +6 chars -> +2 tokens, total 5 tokens
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.streaming, false);
	assert.strictEqual(s.ttftSamples, 1);
	assert.strictEqual(s.currentTtft, 0.2); // 1200-1000
	assert.strictEqual(s.tpsSamples, 1);
	assert.strictEqual(s.graphLen, 1);
	assert.strictEqual(s.lastElapsedMs, 500); // 1600-1100
	assert.strictEqual(s.totalElapsedMs, 500);

	// TPS = 5 tokens / 0.5s = 10
	const final = meter.renderFinal(theme);
	assert.ok(final.includes("[error:10] avg"), `expected colored 10 avg in ${final}`);
	assert.ok(final.includes("0.20s"), `expected "0.20s" TTFT in ${final}`);
	assert.ok(final.includes("Elapsed [dim:0.5s]"), `expected frozen elapsed in ${final}`);
});

test("effective TPS is suppressed during the first 300 ms", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.startAssistantMessage();
	meter.addDelta("text_delta", "hello world"); // 3 tokens

	// t=1000 exactly -> elapsed 0 -> 0 tps
	assert.ok(meter.renderLive(theme).includes("[error:0.0 tps]"), "expected 0 tps at start");

	clock.advance(100);
	assert.ok(meter.renderLive(theme).includes("[error:0.0 tps]"), "expected 0 tps at 100ms");

	clock.advance(250);
	// elapsed 350ms, 3 tokens -> ~8.6 tps
	assert.ok(meter.renderLive(theme).includes("[error:8.6 tps]"), `expected live tps at 350ms: ${meter.renderLive(theme)}`);
});

test("TTFT is not recorded without a first-token event", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(100);
	meter.startAssistantMessage();
	clock.advance(10_000);
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 0);
	assert.strictEqual(s.tpsSamples, 0);
	assert.strictEqual(s.graphLen, 0);
	assert.strictEqual(s.lastElapsedMs, 10_000);
});

test("markFirstToken records TTFT without contributing TPS", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(300);
	meter.startAssistantMessage();
	clock.advance(150);
	meter.markFirstToken();
	clock.advance(100);
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 1);
	assert.strictEqual(s.currentTtft, 0.45);
	assert.strictEqual(s.tpsSamples, 0);
	assert.strictEqual(s.graphLen, 0);
});

test("multiple messages accumulate all-time TPS stats", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	for (let i = 0; i < 5; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40)); // 40 chars -> 10 tokens each
		clock.advance(1000); // 10 tokens / 1s = 10 tps
		meter.endAssistantMessage();
		clock.advance(100);
	}

	const s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 5);
	assert.strictEqual(s.graphLen, 5);
	assert.strictEqual(s.totalElapsedMs, 5000); // 5 × 1s of assistant streaming

	const final = meter.renderFinal(theme);
	assert.ok(final.includes("μ 10"), `expected mean 10 in ${final}`);
	assert.ok(final.includes("p95 10"), `expected p95 10 in ${final}`);
	assert.ok(final.includes("Elapsed [dim:5s]"), `expected total elapsed 5s in ${final}`);
});

test("graph buffer wraps at GRAPH_DOTS samples", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	for (let i = 0; i < 30; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40));
		clock.advance(1000);
		meter.endAssistantMessage();
	}

	const s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 30);
	assert.ok(s.graphLen <= 20, `graph length ${s.graphLen} exceeds cap`);
});

test("all-time TPS buffer caps at TPS_ALL_TIME_CAP", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	for (let i = 0; i < 600; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40));
		clock.advance(1000);
		meter.endAssistantMessage();
	}

	const s = meter.inspect();
	assert.ok(s.tpsSamples <= 512, `tps sample count ${s.tpsSamples} exceeds cap`);
});

test("renderFinal returns empty string when there is no data", () => {
	const meter = createMeter({ now: () => 0 });
	assert.strictEqual(meter.renderFinal(theme), "");
});

test("renderLive shows waiting TTFT before first token and measured TTFT after", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(100);
	meter.startAssistantMessage();
	clock.advance(250);

	const liveBefore = meter.renderLive(theme);
	assert.ok(liveBefore.includes("TTFT"), `expected waiting TTFT in ${liveBefore}`);
	assert.ok(!liveBefore.includes("μ"), `expected no measured μ before first token: ${liveBefore}`);

	meter.addDelta("text_delta", "hi");
	const liveAfter = meter.renderLive(theme);
	assert.ok(liveAfter.includes("TTFT [success:0.35s]"), `expected measured TTFT in ${liveAfter}`);
});

test("serialize and restore preserves metrics across meters", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(100); // request at 1000, message starts at 1100
	meter.startAssistantMessage();
	clock.advance(200); // first token at 1300 -> TTFT 0.3s
	meter.addDelta("text_delta", "a".repeat(40)); // 10 tokens
	clock.advance(800); // response ends at 2100, elapsed 1000ms
	meter.endAssistantMessage();

	const before = meter.inspect();
	assert.strictEqual(before.tpsSamples, 1);
	assert.strictEqual(before.ttftSamples, 1);
	assert.strictEqual(before.lastElapsedMs, 1000);

	const snapshot = meter.serialize();
	assert.strictEqual(snapshot.allTps.values.length, 1);
	assert.strictEqual(snapshot.allTtft.values.length, 1);
	assert.strictEqual(snapshot.graph.length, 1);
	assert.strictEqual(snapshot.lastElapsedMs, 1000);

	// Simulate time passing and a new process/extension instance.
	clock.advance(5_000);
	const meter2 = createMeter({ now: clock.now });
	meter2.restore(snapshot);

	const after = meter2.inspect();
	assert.strictEqual(after.tpsSamples, 1);
	assert.strictEqual(after.ttftSamples, 1);
	assert.strictEqual(after.lastElapsedMs, 1000);
	assert.strictEqual(after.totalElapsedMs, 1000);

	const final = meter2.renderFinal(theme);
	assert.ok(final.includes("μ 10"), `expected mean TPS after restore: ${final}`);
	assert.ok(final.includes("TTFT"), `expected TTFT after restore: ${final}`);
	assert.ok(final.includes("Elapsed [dim:1s]"), `expected 1s elapsed after restore: ${final}`);
});

test("p95 is computed correctly across many distinct values", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });
	// 20 samples at 1s each -> distinct TPS values 1..20.
	for (let i = 1; i <= 20; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(i * 4)); // i tokens
		clock.advance(1000); // i tps
		meter.endAssistantMessage();
	}
	const final = meter.renderFinal(theme);
	// p95 of 1..20 = ceil(20 * 0.95) - 1 = 19th value (1-indexed) = 19 (error color, < TPS_MED=20).
	assert.ok(final.includes("[error:p95 19]"), `expected p95 19 in ${final}`);
});

test("isMeterSnapshot rejects corrupt snapshots", () => {
	assert.strictEqual(isMeterSnapshot(null), false);
	assert.strictEqual(isMeterSnapshot(undefined), false);
	assert.strictEqual(isMeterSnapshot({}), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: "x" }), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: 1, allTps: {}, allTtft: {}, win: {}, graph: [], lastElapsedMs: 0, totalElapsedMs: 0 }), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: 1, allTps: { values: [1], times: [1] }, allTtft: { values: [], times: [] }, win: { values: [], times: [] }, graph: ["x"], lastElapsedMs: 0, totalElapsedMs: 0 }), false);
});

test("restore ignores corrupt snapshots without throwing", () => {
	const meter = createMeter();
	assert.doesNotThrow(() => meter.restore(null));
	assert.doesNotThrow(() => meter.restore({ savedAt: "bad" }));
	assert.strictEqual(meter.inspect().tpsSamples, 0);
});
