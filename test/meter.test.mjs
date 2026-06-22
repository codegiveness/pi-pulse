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
	assert.strictEqual(s.lastElapsedMs, 600); // 1600-1000 (E2E from before_provider_request)
	assert.strictEqual(s.totalElapsedMs, 600);

	// TPS = 5 tokens / 0.4s (decode phase from first token at 1200 to end at 1600) = 12.5 → rounded to 13
	const final = meter.renderFinal(theme);
	assert.ok(final.includes("[error:13] avg"), `expected colored 13 avg in ${final}`);
	assert.ok(final.includes("0.20s"), `expected "0.20s" TTFT in ${final}`);
	assert.ok(final.includes("Elapsed [dim:0.6s]"), `expected frozen elapsed in ${final}`);
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

test("live TPS and recorded sample agree at the 0.3 s minimum-elapsed boundary", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.startAssistantMessage();
	meter.addDelta("text_delta", "hello world"); // 3 tokens; firstTokenTime = 1000

	// Exactly at the 0.3 s boundary: the live display must show non-zero TPS and
	// endAssistantMessage must record a sample. The two must never disagree
	// (regression for the effectiveTps `>` vs endAssistantMessage `<` asymmetry).
	clock.advance(300); // decode elapsed = 0.300 s
	const live = meter.renderLive(theme);
	assert.ok(!live.includes("[error:0.0 tps]"), `expected non-zero live tps at boundary: ${live}`);

	meter.endAssistantMessage();
	const s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 1, "expected a TPS sample recorded at the 0.3 s boundary");
	assert.strictEqual(s.graphLen, 1, "expected a graph sample at the 0.3 s boundary");
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
	assert.strictEqual(s.lastElapsedMs, 10_100); // E2E from before_provider_request at 1000
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
	assert.ok(final.includes("p10 10"), `expected p10 10 in ${final}`);
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
	assert.strictEqual(before.lastElapsedMs, 1100); // E2E from before_provider_request at 1000

	const snapshot = meter.serialize();
	assert.strictEqual(snapshot.allTps.values.length, 1);
	assert.strictEqual(snapshot.allTtft.values.length, 1);
	assert.strictEqual(snapshot.graph.length, 1);
	assert.strictEqual(snapshot.lastElapsedMs, 1100);

	// Simulate time passing and a new process/extension instance.
	clock.advance(5_000);
	const meter2 = createMeter({ now: clock.now });
	meter2.restore(snapshot);

	const after = meter2.inspect();
	assert.strictEqual(after.tpsSamples, 1);
	assert.strictEqual(after.ttftSamples, 1);
	assert.strictEqual(after.lastElapsedMs, 1100);
	assert.strictEqual(after.totalElapsedMs, 1100);

	const final = meter2.renderFinal(theme);
	assert.ok(final.includes("μ 13"), `expected mean TPS after restore: ${final}`);
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
	// p10 of 1..20 = ceil(20 * 0.10) - 1 = 2nd value (1-indexed) = 2 (error color, < TPS_MED=20).
	assert.ok(final.includes("[error:p10 2.0]"), `expected p10 2.0 in ${final}`);
});

test("isMeterSnapshot rejects corrupt snapshots", () => {
	assert.strictEqual(isMeterSnapshot(null), false);
	assert.strictEqual(isMeterSnapshot(undefined), false);
	assert.strictEqual(isMeterSnapshot({}), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: "x" }), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: 1, allTps: {}, allTtft: {}, win: {}, graph: [], lastElapsedMs: 0, totalElapsedMs: 0 }), false);
	assert.strictEqual(isMeterSnapshot({ savedAt: 1, allTps: { values: [1], times: [1] }, allTtft: { values: [], times: [] }, win: { values: [], times: [] }, graph: ["x"], lastElapsedMs: 0, totalElapsedMs: 0 }), false);
	// Mismatched values/times lengths would push NaN timestamps on restore.
	assert.strictEqual(isMeterSnapshot({ savedAt: 1, allTps: { values: [1, 2], times: [1] }, allTtft: { values: [], times: [] }, win: { values: [], times: [] }, graph: [], lastElapsedMs: 0, totalElapsedMs: 0 }), false);
});

test("restore ignores corrupt snapshots without throwing", () => {
	const meter = createMeter();
	assert.doesNotThrow(() => meter.restore(null));
	assert.doesNotThrow(() => meter.restore({ savedAt: "bad" }));
	assert.doesNotThrow(() => meter.restore({ savedAt: 1, allTps: { values: [1, 2], times: [1] }, allTtft: { values: [], times: [] }, win: { values: [], times: [] }, graph: [], lastElapsedMs: 0, totalElapsedMs: 0 }));
	assert.strictEqual(meter.inspect().tpsSamples, 0);
});

test("TPS uses decode-phase denominator (excludes TTFT)", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();           // T0 = 1000
	clock.advance(100);                 // network + prefill
	meter.startAssistantMessage();       // T1 = 1100
	clock.advance(200);                 // continued prefill until first token
	meter.addDelta("text_delta", "a".repeat(40)); // T2 = 1300, 10 tokens
	clock.advance(800);                 // decode phase
	meter.endAssistantMessage();         // T3 = 2100

	// TPS = 10 tokens / 0.8s decode phase (T2→T3), NOT 10 / 1.0s (T1→T3) or 10 / 1.1s (T0→T3)
	const s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 1);
	assert.strictEqual(s.firstTokenTime, 1300);

	const final = meter.renderFinal(theme);
	// 10 / 0.8 = 12.5 → rounded to 13
	assert.ok(final.includes("[error:13] avg"), `expected decode TPS 13 in ${final}`);
});

test("Elapsed includes before_provider_request gap", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();           // T0 = 1000
	clock.advance(100);                 // network + prefill gap
	meter.startAssistantMessage();       // T1 = 1100
	clock.advance(100);                 // first token at T2 = 1200
	meter.addDelta("text_delta", "hi");
	clock.advance(400);                 // end at T3 = 1600
	meter.endAssistantMessage();

	// Elapsed = T3 - T0 = 600ms (E2E from before_provider_request), NOT T3 - T1 = 500ms
	const s = meter.inspect();
	assert.strictEqual(s.elapsedStart, 1000);
	assert.strictEqual(s.lastElapsedMs, 600);
	assert.strictEqual(s.totalElapsedMs, 600);
});

test("Elapsed fallback when no before_provider_request", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// No markRequestStart() called — elapsed should fall back to message_start.
	meter.startAssistantMessage();       // streamStart = 1000, elapsedStart fallback = 1000
	clock.advance(200);
	meter.addDelta("text_delta", "hi");
	clock.advance(800);
	meter.endAssistantMessage();         // T3 = 2000

	const s = meter.inspect();
	assert.strictEqual(s.elapsedStart, 1000);
	assert.strictEqual(s.lastElapsedMs, 1000); // 2000 - 1000, same as old behavior
});

test("tool-only response: elapsed includes full E2E from request start", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();           // T0 = 1000
	clock.advance(200);                 // network + prefill
	meter.startAssistantMessage();       // T1 = 1200
	clock.advance(100);                 // toolcall_start at T2 = 1300
	meter.markFirstToken();
	clock.advance(50);                  // end at T3 = 1350
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 1);
	assert.strictEqual(s.tpsSamples, 0);  // no streaming tokens
	assert.strictEqual(s.lastElapsedMs, 350); // E2E: 1350 - 1000, includes prefill
});

test("samples older than 10 minutes are excluded from mean and percentiles", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// Record a TPS=20 sample at T=1000.
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(80)); // 20 tokens
	clock.advance(1000); // 20 tokens / 1s = 20 tps
	meter.endAssistantMessage();

	// Record a TTFT=0.5s sample.
	meter.markRequestStart();
	clock.advance(500);
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(40)); // 10 tokens
	clock.advance(1000); // 10 tps
	meter.endAssistantMessage();

	// At this point, μ should reflect both samples.
	let final = meter.renderFinal(theme);
	assert.ok(final.includes("TPS"), `expected TPS section before aging: ${final}`);
	assert.ok(final.includes("TTFT"), `expected TTFT section before aging: ${final}`);

	// Advance 11 minutes — both samples are now outside the 10-minute window.
	clock.advance(11 * 60 * 1000);

	// Record a fresh TPS=50 sample at T≈12 min.
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(200)); // 50 tokens
	clock.advance(1000); // 50 tps
	meter.endAssistantMessage();

	// Record a fresh TTFT=0.1s sample.
	meter.markRequestStart();
	clock.advance(100);
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(40));
	clock.advance(1000);
	meter.endAssistantMessage();

	// μ and p95 should now reflect only the fresh samples, not the old ones.
	// The fresh TPS samples are 50 and 10 → mean = 30, p95 = 50, p10 = 10.
	final = meter.renderFinal(theme);
	assert.ok(final.includes("μ 30"), `expected recent μ 30 in ${final}`);
	assert.ok(final.includes("p95 50"), `expected recent p95 50 in ${final}`);
	assert.ok(final.includes("0.10s"), `expected recent TTFT 0.10s in ${final}`);
});

test("count cap protects against unbounded growth even without trim", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// Record 600 samples without advancing time enough to expire them.
	for (let i = 0; i < 600; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40));
		clock.advance(1000);
		meter.endAssistantMessage();
	}

	const s = meter.inspect();
	assert.ok(s.tpsSamples <= 512, `tps sample count ${s.tpsSamples} exceeds cap`);
	// All 512 samples are within the window (time barely advanced relative to window).
	assert.strictEqual(s.tpsSamplesRecent, s.tpsSamples);
});

test("renderFinal shows only Elapsed when window is empty", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// Record a TPS/TTFT sample and accumulate elapsed.
	meter.markRequestStart();
	clock.advance(100);
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(40)); // 10 tokens
	clock.advance(1000); // 10 tps
	meter.endAssistantMessage();

	// Confirm TPS + TTFT + Elapsed are all shown.
	let final = meter.renderFinal(theme);
	assert.ok(final.includes("TPS"), `expected TPS before aging: ${final}`);
	assert.ok(final.includes("TTFT"), `expected TTFT before aging: ${final}`);
	assert.ok(final.includes("Elapsed"), `expected Elapsed before aging: ${final}`);

	// Advance past the 10-minute window so all rate samples expire.
	clock.advance(11 * 60 * 1000);

	// Only Elapsed should remain.
	final = meter.renderFinal(theme);
	assert.ok(!final.includes("TPS"), `expected no TPS after aging: ${final}`);
	assert.ok(!final.includes("TTFT"), `expected no TTFT after aging: ${final}`);
	assert.ok(final.includes("Elapsed"), `expected Elapsed after aging: ${final}`);
});

test("inspect exposes windowed sample counts", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// Record 5 TPS samples at T≈1s each.
	for (let i = 0; i < 5; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40));
		clock.advance(1000);
		meter.endAssistantMessage();
	}

	let s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 5);
	assert.strictEqual(s.tpsSamplesRecent, 5);

	// Advance 11 minutes — all 5 samples expire from the window.
	clock.advance(11 * 60 * 1000);

	// Record 2 more samples.
	for (let i = 0; i < 2; i++) {
		meter.startAssistantMessage();
		meter.addDelta("text_delta", "a".repeat(40));
		clock.advance(1000);
		meter.endAssistantMessage();
	}

	s = meter.inspect();
	assert.strictEqual(s.tpsSamples, 7); // raw ring buffer has all 7
	assert.strictEqual(s.tpsSamplesRecent, 2); // only the 2 recent ones
});

test("restore shifts all buffer timestamps and old samples expire correctly", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	// Record a sample at T=1000.
	meter.startAssistantMessage();
	meter.addDelta("text_delta", "a".repeat(40)); // 10 tokens
	clock.advance(1000); // 10 tps
	meter.endAssistantMessage();

	const snapshot = meter.serialize();

	// Simulate 5 minutes passing and a new meter instance.
	clock.advance(5 * 60 * 1000);
	const meter2 = createMeter({ now: clock.now });
	meter2.restore(snapshot);

	// The restored sample is shifted to T=5min (age = 0 min) → still in window.
	let final = meter2.renderFinal(theme);
	assert.ok(final.includes("μ 10"), `expected μ 10 after restore: ${final}`);

	// Advance another 11 minutes (total 16 min from original, 11 min since restore).
	// The sample is now 11 minutes old → outside the 10-minute window.
	clock.advance(11 * 60 * 1000);
	final = meter2.renderFinal(theme);
	assert.ok(!final.includes("TPS"), `expected no TPS after aging past window: ${final}`);

	const s = meter2.inspect();
	assert.strictEqual(s.tpsSamples, 1); // raw buffer still has the stale sample
	assert.strictEqual(s.tpsSamplesRecent, 0); // but it's outside the window
});
