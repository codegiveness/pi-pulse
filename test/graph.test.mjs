import assert from "node:assert";
import test from "node:test";
import { brailleGraph } from "../dist/graph.js";
import { GRAPH_W } from "../dist/constants.js";

const theme = {
	fg: (name, text) => `[${name}:${text}]`,
};

function makeBuf(values) {
	const buf = new Float64Array(values.length);
	for (let i = 0; i < values.length; i++) buf[i] = values[i];
	return buf;
}

test("empty or single-value graph returns fallback dots", () => {
	assert.strictEqual(brailleGraph(makeBuf([]), 0, 0, theme), `[dim:${"·".repeat(GRAPH_W)}]`);
	assert.strictEqual(brailleGraph(makeBuf([42]), 1, 1, theme), `[dim:${"·".repeat(GRAPH_W)}]`);
});

test("graph renders the expected number of columns", () => {
	const buf = makeBuf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
	const out = brailleGraph(buf, buf.length, 0, theme);
	const cols = out.split("[").filter(Boolean).length;
	assert.strictEqual(cols, GRAPH_W);
});

test("graph uses success color for high values", () => {
	const buf = makeBuf(Array(20).fill(100));
	const out = brailleGraph(buf, buf.length, 0, theme);
	assert.ok(out.includes("[success:"), `expected success color in ${out}`);
	assert.ok(!out.includes("[error:"), `expected no error color in ${out}`);
});

test("graph uses error color for low values", () => {
	const buf = makeBuf(Array(20).fill(1));
	const out = brailleGraph(buf, buf.length, 0, theme);
	assert.ok(out.includes("[error:"), `expected error color in ${out}`);
	assert.ok(!out.includes("[success:"), `expected no success color in ${out}`);
});

test("wrapped buffer renders correctly", () => {
	// 25 high samples into a 20-slot buffer; head = 5, valid samples wrap from index 5..19,0..4.
	const buf = makeBuf(Array(20).fill(100));
	for (let i = 20; i < 25; i++) {
		buf[i % 20] = 100;
	}
	const out = brailleGraph(buf, 20, 5, theme);
	assert.strictEqual(out.split("[").filter(Boolean).length, GRAPH_W);
	assert.ok(out.includes("[success:"), `expected success coloring for high values in ${out}`);
});

test("mixed columns are colored by their own average, not a global color", () => {
	// 20 samples: first 10 are slow (1 tps -> error), last 10 are fast (100 tps -> success).
	const values = [...Array(10).fill(1), ...Array(10).fill(100)];
	const buf = makeBuf(values);
	const out = brailleGraph(buf, buf.length, 0, theme);
	assert.ok(out.includes("[error:"), `expected at least one error column in ${out}`);
	assert.ok(out.includes("[success:"), `expected at least one success column in ${out}`);
});
