/**
 * Braille sparkline renderer for the footer status graph.
 */

import { GRAPH_DOTS, GRAPH_W, TPS_FAST, TPS_MED } from "./constants.js";
import type { Theme } from "./format.js";

const BRAILLE_OFFSET = 0x2800;

const DOT_BITS: number[][] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

/** Color name for a single TPS value, based on the same thresholds as the numeric TPS. */
function tpsColorName(v: number): string {
	if (v >= TPS_FAST) return "success";
	if (v >= TPS_MED) return "warning";
	return "error";
}

/**
 * Render a 10-column colored braille sparkline from a circular buffer of TPS
 * values. Each column combines two adjacent samples into one braille glyph and
 * is colored by the *average* of those two samples, so the color reflects the
 * combined column rather than only its left half.
 */
export function brailleGraph(
	buf: Float64Array,
	len: number,
	head: number,
	theme: Theme,
): string {
	if (len < 2) return theme.fg("dim", "·".repeat(GRAPH_W));

	const oldest = len < GRAPH_DOTS ? 0 : head;
	let localMax = 1;
	for (let i = 0; i < len; i++) {
		const v = buf[(oldest + i) % GRAPH_DOTS];
		if (v > localMax) localMax = v;
	}

	let result = "";
	for (let ch = 0; ch < GRAPH_W; ch++) {
		let code = BRAILLE_OFFSET;
		const colL = ch * 2;
		const colR = ch * 2 + 1;
		let sum = 0;
		let counted = 0;
		for (let row = 0; row < 4; row++) {
			const li = (oldest + colL) % GRAPH_DOTS;
			if (li < len) {
				const v = buf[li];
				sum += v;
				counted++;
				const norm = v / localMax;
				const threshold = (3 - row) / 3;
				if (norm >= threshold) code |= DOT_BITS[row][0];
			}
			const ri = (oldest + colR) % GRAPH_DOTS;
			if (ri < len) {
				const v = buf[ri];
				sum += v;
				counted++;
				const norm = v / localMax;
				const threshold = (3 - row) / 3;
				if (norm >= threshold) code |= DOT_BITS[row][1];
			}
		}

		const avg = counted > 0 ? sum / counted : 0;
		const char = String.fromCharCode(code);
		result += theme.fg(tpsColorName(avg), char);
	}
	return result;
}
