import assert from "node:assert";
import test from "node:test";
import { createMeter } from "../dist/meter.js";

function makeClock(initial = 0) {
	let t = initial;
	return {
		now: () => t,
		advance: (ms) => { t += ms; },
	};
}

test("no phantom TTFT sample when a message produces no assistant tokens", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(200);
	meter.startAssistantMessage();
	clock.advance(10_000); // long wait
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 0, "must not record TTFT without first token");
	assert.strictEqual(s.tpsSamples, 0, "must not record TPS without tokens");
	assert.strictEqual(s.lastElapsedMs, 10_000, "elapsed should still reflect message duration");
});

test("TTFT sample is recorded exactly once per message", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(100);
	meter.startAssistantMessage();
	clock.advance(50);
	meter.addDelta("text_delta", "a");
	meter.addDelta("text_delta", "b");
	meter.addDelta("text_delta", "c");
	clock.advance(100);
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 1, "TTFT should be recorded exactly once");
	assert.strictEqual(s.currentTtft, 0.15, "TTFT should match first-token time");
});

test("markFirstToken records TTFT but no TPS", () => {
	const clock = makeClock(1000);
	const meter = createMeter({ now: clock.now });

	meter.markRequestStart();
	clock.advance(250);
	meter.startAssistantMessage();
	clock.advance(150);
	meter.markFirstToken();
	clock.advance(100);
	meter.endAssistantMessage();

	const s = meter.inspect();
	assert.strictEqual(s.ttftSamples, 1, "tool call start must stop TTFT timer");
	assert.strictEqual(s.currentTtft, 0.4, "TTFT should include request-to-first-token time");
	assert.strictEqual(s.tpsSamples, 0, "tool call start without deltas must not add a TPS sample");
});
