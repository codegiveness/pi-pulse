import assert from "node:assert";
import test from "node:test";
import { fmtTps, fmtTtft, fmtElapsed, tpsColor, ttftColor } from "../dist/format.js";

const theme = {
	fg: (name, text) => `[${name}:${text}]`,
};

test("fmtTps handles non-finite and negative values", () => {
	assert.strictEqual(fmtTps(NaN), "0.0");
	assert.strictEqual(fmtTps(Infinity), "0.0");
	assert.strictEqual(fmtTps(-1), "0.0");
	assert.strictEqual(fmtTps(-Infinity), "0.0");
});

test("fmtTps formats small values with one decimal", () => {
	assert.strictEqual(fmtTps(0), "0.0");
	assert.strictEqual(fmtTps(0.5), "0.5");
	assert.strictEqual(fmtTps(9.99), "10.0");
});

test("fmtTps formats values at or above 10 as rounded integers", () => {
	assert.strictEqual(fmtTps(10), "10");
	assert.strictEqual(fmtTps(10.4), "10");
	assert.strictEqual(fmtTps(10.6), "11");
	assert.strictEqual(fmtTps(99.9), "100");
	assert.strictEqual(fmtTps(100.4), "100");
	assert.strictEqual(fmtTps(1234.56), "1235");
});

test("fmtTtft renders durations in seconds", () => {
	assert.strictEqual(fmtTtft(0), "0.00s");
	assert.strictEqual(fmtTtft(-0.5), "0.00s");
	assert.strictEqual(fmtTtft(0.25), "0.25s");
	assert.strictEqual(fmtTtft(9.999), "10.00s");
	assert.strictEqual(fmtTtft(10.25), "10.3s");
	assert.strictEqual(fmtTtft(99.9), "99.9s");
	assert.strictEqual(fmtTtft(100.4), "100s");
});

test("fmtElapsed formats durations", () => {
	assert.strictEqual(fmtElapsed(0), "0.0s");
	assert.strictEqual(fmtElapsed(-1000), "0.0s");
	assert.strictEqual(fmtElapsed(500), "0.5s");
	assert.strictEqual(fmtElapsed(999), "1.0s");
	assert.strictEqual(fmtElapsed(1000), "1s");
	assert.strictEqual(fmtElapsed(59_000), "59s");
	assert.strictEqual(fmtElapsed(60_000), "1m 00s");
	assert.strictEqual(fmtElapsed(3_661_000), "1h 01m 01s");
});

test("tpsColor color-codes by threshold", () => {
	assert.strictEqual(tpsColor(100, "fast", theme), "[success:fast]");
	assert.strictEqual(tpsColor(50, "med", theme), "[success:med]");
	assert.strictEqual(tpsColor(30, "warn", theme), "[warning:warn]");
	assert.strictEqual(tpsColor(20, "boundary", theme), "[warning:boundary]");
	assert.strictEqual(tpsColor(19.9, "slow", theme), "[error:slow]");
	assert.strictEqual(tpsColor(0, "zero", theme), "[error:zero]");
});

test("ttftColor color-codes by threshold", () => {
	assert.strictEqual(ttftColor(-1, "neg", theme), "[dim:neg]");
	assert.strictEqual(ttftColor(0, "zero", theme), "[dim:zero]");
	assert.strictEqual(ttftColor(0.01, "tiny", theme), "[success:tiny]");
	assert.strictEqual(ttftColor(0.5, "fast", theme), "[success:fast]");
	assert.strictEqual(ttftColor(2, "boundary", theme), "[warning:boundary]");
	assert.strictEqual(ttftColor(2.1, "slow", theme), "[error:slow]");
});
