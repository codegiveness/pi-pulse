/**
 * Core stats accumulator: TPS rolling window, TTFT samples, and elapsed time.
 *
 * All state lives in a class instance created by the extension factory so
 * multiple extension loads (tests, reloads) never share mutable module state.
 */

import { ALL_TIME_WINDOW_MS, GRAPH_DOTS, TPS_ALL_TIME_CAP, TPS_MIN_ELAPSED_SEC, TPS_WIN_MS, TPS_WIN_SIZE } from "./constants.js";
import { fmtElapsed, fmtTps, fmtTtft, tpsColor, ttftColor, type Theme } from "./format.js";
import { brailleGraph } from "./graph.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Estimate tokens from characters (≈ 4 chars per token). */
function tokEst(ch: number): number {
	return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

export interface MeterOptions {
	/** Injectable clock for deterministic tests. Defaults to `performance.now()`. */
	now?: () => number;
}

export interface MeterSnapshot {
	savedAt: number;
	allTps: { values: number[]; times: number[] };
	allTtft: { values: number[]; times: number[] };
	win: { values: number[]; times: number[] };
	graph: number[];
	lastElapsedMs: number;
	totalElapsedMs: number;
}

class RingBuf {
	private data: Float64Array;
	private times: Float64Array;
	private mask: number;
	len = 0;
	head = 0;

	constructor(size: number) {
		this.mask = size - 1;
		if (size & this.mask) throw new Error("RingBuf size must be power of two");
		this.data = new Float64Array(size);
		this.times = new Float64Array(size);
	}

	push(value: number, nowMs: number): void {
		this.data[this.head] = value;
		this.times[this.head] = nowMs;
		this.head = (this.head + 1) & this.mask;
		if (this.len <= this.mask) this.len++;
	}

	/** Average of values within `windowMs` of `nowMs`. */
	avg(nowMs: number, windowMs: number): number {
		if (this.len === 0) return 0;
		const cutoff = nowMs - windowMs;
		let sum = 0;
		let n = 0;
		const start = this.len <= this.mask ? 0 : this.head;
		for (let i = 0; i < this.len; i++) {
			const idx = (start + i) & this.mask;
			if (this.times[idx]! < cutoff) continue;
			sum += this.data[idx]!;
			n++;
		}
		return n === 0 ? 0 : sum / n;
	}

	toArray(): Float64Array {
		const out = new Float64Array(this.len);
		const start = this.len <= this.mask ? 0 : this.head;
		for (let i = 0; i < this.len; i++) {
			// idx is masked to [0, capacity), so the typed-array access is in-bounds.
		out[i] = this.data[(start + i) & this.mask]!;
		}
		return out;
	}

	/** Yield values whose timestamps fall within `windowMs` of `nowMs`. */
	*valuesInWindow(nowMs: number, windowMs: number): Generator<number> {
		if (this.len === 0) return;
		const cutoff = nowMs - windowMs;
		const start = this.len <= this.mask ? 0 : this.head;
		for (let i = 0; i < this.len; i++) {
			const idx = (start + i) & this.mask;
			if (this.times[idx]! >= cutoff) {
				// idx is masked to [0, capacity), so the typed-array access is in-bounds.
				yield this.data[idx]!;
			}
		}
	}

	toTimeArray(): Float64Array {
		const out = new Float64Array(this.len);
		const start = this.len <= this.mask ? 0 : this.head;
		for (let i = 0; i < this.len; i++) {
			// idx is masked to [0, capacity), so the typed-array access is in-bounds.
		out[i] = this.times[(start + i) & this.mask]!;
		}
		return out;
	}
}

/** Type guard for a persisted `MeterSnapshot` loaded from a session file. */
export function isMeterSnapshot(data: unknown): data is MeterSnapshot {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.savedAt !== "number") return false;
	for (const key of ["allTps", "allTtft", "win"] as const) {
		const b = d[key];
		if (!b || typeof b !== "object") return false;
		const o = b as Record<string, unknown>;
		if (!Array.isArray(o.values) || !Array.isArray(o.times)) return false;
		if (!o.values.every((v) => typeof v === "number")) return false;
		if (!o.times.every((v) => typeof v === "number")) return false;
	}
	if (!Array.isArray(d.graph) || !d.graph.every((v) => typeof v === "number")) return false;
	if (typeof d.lastElapsedMs !== "number") return false;
	if (typeof d.totalElapsedMs !== "number") return false;
	return true;
}

export class StatsMeter {
	private nowFn: () => number;

	// Streaming state.
	private streaming = false;
	private streamStart = 0; // assistant message_start timestamp
	private streamChars = 0;
	private streamTokens = 0;

	// TTFT state.
	private requestStart = 0; // timestamp from last before_provider_request
	private msgRequestStart = 0; // captured per message at message_start
	private firstTokenArrived = false;
	private firstTokenTime = 0; // monotonic timestamp of first output token (decode TPS anchor)
	private currentTtft = 0;

	// Elapsed state: E2E request latency from before_provider_request to message_end.
	private elapsedStart = 0; // before_provider_request timestamp (fallback: message_start)
	private lastElapsedMs = 0;
	private totalElapsedMs = 0;

	// Spinner state.
	private spinIndex = 0;

	// Buffers.
	private win = new RingBuf(TPS_WIN_SIZE);
	private allTps = new RingBuf(TPS_ALL_TIME_CAP);
	private allTtft = new RingBuf(TPS_ALL_TIME_CAP);
	private graph = new Float64Array(GRAPH_DOTS);
	private graphLen = 0;
	private graphHead = 0;

	constructor(options?: MeterOptions) {
		this.nowFn = options?.now ?? (() => performance.now());
	}

	private now(): number {
		return this.nowFn();
	}

	reset(): void {
		this.streaming = false;
		this.streamStart = 0;
		this.streamChars = 0;
		this.streamTokens = 0;
		this.requestStart = 0;
		this.msgRequestStart = 0;
		this.firstTokenArrived = false;
		this.firstTokenTime = 0;
		this.currentTtft = 0;
		this.elapsedStart = 0;
		this.lastElapsedMs = 0;
		this.totalElapsedMs = 0;
		this.spinIndex = 0;
		this.win = new RingBuf(TPS_WIN_SIZE);
		this.allTps = new RingBuf(TPS_ALL_TIME_CAP);
		this.allTtft = new RingBuf(TPS_ALL_TIME_CAP);
		this.graph = new Float64Array(GRAPH_DOTS);
		this.graphLen = 0;
		this.graphHead = 0;
	}

	hasData(): boolean {
		return this.allTps.len > 0 || this.allTtft.len > 0 || this.totalElapsedMs > 0;
	}

	serialize(): MeterSnapshot {
		return {
			savedAt: this.now(),
			allTps: {
				values: Array.from(this.allTps.toArray()),
				times: Array.from(this.allTps.toTimeArray()),
			},
			allTtft: {
				values: Array.from(this.allTtft.toArray()),
				times: Array.from(this.allTtft.toTimeArray()),
			},
			win: {
				values: Array.from(this.win.toArray()),
				times: Array.from(this.win.toTimeArray()),
			},
			graph: Array.from(this.graphSnapshotArray()),
			lastElapsedMs: this.lastElapsedMs,
			totalElapsedMs: this.totalElapsedMs,
		};
	}

	restore(data: MeterSnapshot): void {
		if (!isMeterSnapshot(data)) return;

		const nowMs = this.now();
		const timeShift = nowMs - data.savedAt;

		// All three buffers are shifted so that their timestamps align with
		// the current monotonic clock. This matters for the 60-second rolling
		// avg (win) and the 10-minute trailing window (allTps, allTtft).
		const restoreShifted = (buf: RingBuf, values: number[], times: number[]) => {
			for (let i = 0; i < values.length; i++) {
				// i < values.length and i < times.length by the loop bound.
			buf.push(values[i]!, times[i]! + timeShift);
			}
		};

		restoreShifted(this.win, data.win.values, data.win.times);
		restoreShifted(this.allTps, data.allTps.values, data.allTps.times);
		restoreShifted(this.allTtft, data.allTtft.values, data.allTtft.times);

		for (const v of data.graph) this.pushGraph(v);
		this.lastElapsedMs = data.lastElapsedMs;
		this.totalElapsedMs = data.totalElapsedMs;
	}

	markRequestStart(): void {
		this.requestStart = this.now();
	}

	startAssistantMessage(): void {
		this.streamStart = this.now();
		this.streamChars = 0;
		this.streamTokens = 0;
		this.firstTokenArrived = false;
		this.firstTokenTime = 0;
		this.currentTtft = 0;
		this.streaming = true;
		this.spinIndex = 0;
		this.msgRequestStart = this.requestStart;
		this.requestStart = 0;
		// E2E latency anchor: use before_provider_request timestamp if available,
		// otherwise fall back to message_start.
		this.elapsedStart = this.msgRequestStart > 0 ? this.msgRequestStart : this.streamStart;
	}

	/**
	 * Record the arrival of the first assistant output token. Idempotent:
	 * only the first call for a message has an effect.
	 */
	private recordFirstToken(nowMs: number): void {
		if (this.firstTokenArrived) return;
		this.firstTokenArrived = true;
		this.firstTokenTime = nowMs;

		const base = this.msgRequestStart > 0 ? this.msgRequestStart : this.streamStart;
		if (base <= 0) return;

		const ttft = (nowMs - base) / 1000;
		if (ttft > 0) {
			this.currentTtft = ttft;
			this.allTtft.push(ttft, nowMs);
		}
		this.msgRequestStart = 0;
	}

	/** Public hook for non-streamed first-token events (e.g. `toolcall_start`). */
	markFirstToken(): void {
		this.recordFirstToken(this.now());
	}

	addDelta(type: string, delta?: string): void {
		// Count any model-output delta: text, reasoning, or tool-call parameters.
		// Tool calls are part of the assistant's generated output (e.g. write/edit with
		// large file contents) and must contribute to both TPS and TTFT first-token
		// detection. Non-delta events such as text_start/toolcall_start are ignored.
		if (type !== "text_delta" && type !== "thinking_delta" && type !== "toolcall_delta") {
			return;
		}
		if (!delta) return;

		this.streamChars += delta.length;
		this.streamTokens = tokEst(this.streamChars);
		this.recordFirstToken(this.now());
	}

	/** Decode-phase TPS: tokens per second from first output token to now. */
	private effectiveTps(nowMs: number): number {
		if (this.firstTokenTime <= 0) return 0;
		const elapsed = (nowMs - this.firstTokenTime) / 1000;
		return elapsed > TPS_MIN_ELAPSED_SEC ? this.streamTokens / elapsed : 0;
	}

	endAssistantMessage(): void {
		this.streaming = false;
		this.msgRequestStart = 0;

		const nowMs = this.now();
		// E2E request latency: from before_provider_request (or message_start fallback) to message_end.
		if (this.elapsedStart > 0) {
			this.lastElapsedMs = nowMs - this.elapsedStart;
			this.totalElapsedMs += this.lastElapsedMs;
		}

		// Decode-phase TPS: tokens per second from first output token to message_end.
		// Use the same minimum-elapsed threshold as the live display so a very short
		// decode never shows 0 tps live but records a huge sample on completion.
		if (this.firstTokenTime <= 0 || this.streamTokens === 0) return;
		const elapsed = (nowMs - this.firstTokenTime) / 1000;
		if (elapsed < TPS_MIN_ELAPSED_SEC) return;

		const tps = this.streamTokens / elapsed;
		this.win.push(tps, nowMs);
		this.allTps.push(tps, nowMs);
		this.pushGraph(tps);
	}

	private pushGraph(tps: number): void {
		this.graph[this.graphHead] = tps;
		this.graphHead = (this.graphHead + 1) % GRAPH_DOTS;
		if (this.graphLen < GRAPH_DOTS) this.graphLen++;
	}

	private graphSnapshotArray(): Float64Array {
		if (this.graphLen === 0) return new Float64Array(0);
		const out = new Float64Array(this.graphLen);
		const start = this.graphLen === GRAPH_DOTS ? this.graphHead : 0;
		for (let i = 0; i < this.graphLen; i++) {
			// `(start + i) % GRAPH_DOTS` is always inside the graph buffer.
		out[i] = this.graph[(start + i) % GRAPH_DOTS]!;
		}
		return out;
	}

	/** Count of samples in `buf` that fall within the trailing 10-minute window. */
	private windowedCount(buf: RingBuf, nowMs: number): number {
		let n = 0;
		for (const _ of buf.valuesInWindow(nowMs, ALL_TIME_WINDOW_MS)) n++;
		return n;
	}

	private calcTpsMean(nowMs: number): number {
		const a = Array.from(this.allTps.valuesInWindow(nowMs, ALL_TIME_WINDOW_MS));
		return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length;
	}

	private calcTpsP95(nowMs: number): number {
		const a = Array.from(this.allTps.valuesInWindow(nowMs, ALL_TIME_WINDOW_MS));
		if (a.length === 0) return 0;
		const sorted = a.slice().sort((x, y) => x - y);
		return sorted[Math.ceil(a.length * 0.95) - 1] || 0;
	}

	private calcTpsP10(nowMs: number): number {
		const a = Array.from(this.allTps.valuesInWindow(nowMs, ALL_TIME_WINDOW_MS));
		if (a.length === 0) return 0;
		const sorted = a.slice().sort((x, y) => x - y);
		return sorted[Math.max(0, Math.ceil(a.length * 0.10) - 1)] || 0;
	}

	private calcTtftMean(nowMs: number): number {
		const a = Array.from(this.allTtft.valuesInWindow(nowMs, ALL_TIME_WINDOW_MS));
		return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length;
	}

	private spin(): string {
		// spinIndex is modulo SPIN.length, so the index is always valid.
		const s = SPIN[this.spinIndex]!;
		this.spinIndex = (this.spinIndex + 1) % SPIN.length;
		return s;
	}

	renderLive(theme: Theme): string {
		const nowMs = this.now();
		const tps = this.effectiveTps(nowMs);
		const s = theme.fg("accent", this.spin());
		const g = brailleGraph(this.graph, this.graphLen, this.graphHead, theme);
		const num = tpsColor(tps, `${fmtTps(tps)} tps`, theme);
		const parts: string[] = [`${s} ${g} ${num}`];

		// Phase A (prefill): live ticking TTFT wait indicator.
		if (!this.firstTokenArrived) {
			const base = this.msgRequestStart > 0 ? this.msgRequestStart : this.streamStart;
			const waitSec = base > 0 ? (nowMs - base) / 1000 : 0;
			if (waitSec > 0) {
				parts.push(`TTFT ${ttftColor(waitSec, `${fmtTtft(waitSec)}…`, theme)}`);
			}
		} else if (this.currentTtft > 0) {
			// Phase B (streaming): measured TTFT for this response.
			parts.push(`TTFT ${ttftColor(this.currentTtft, fmtTtft(this.currentTtft), theme)}`);
		}

		// E2E request latency: from before_provider_request (or message_start fallback) to now.
		if (this.elapsedStart > 0) {
			parts.push(`Elapsed ${theme.fg("dim", fmtElapsed(nowMs - this.elapsedStart))}`);
		}

		return parts.join(" | ");
	}

	renderFinal(theme: Theme): string {
		const nowMs = this.now();
		const avg = this.win.avg(nowMs, TPS_WIN_MS);
		const mu = this.calcTpsMean(nowMs);
		const p10 = this.calcTpsP10(nowMs);
		const p95 = this.calcTpsP95(nowMs);
		const wTtft = this.windowedCount(this.allTtft, nowMs);

		const hasRateData = avg > 0 || mu > 0 || wTtft > 0;
		const hasElapsed = this.totalElapsedMs > 0;
		if (!hasRateData && !hasElapsed) return "";

		const parts: string[] = [];

		if (hasRateData) {
			parts.push(`TPS ${brailleGraph(this.graph, this.graphLen, this.graphHead, theme)} ${tpsColor(avg, fmtTps(avg), theme)} avg`);
			parts.push(`${tpsColor(mu, `μ ${fmtTps(mu)}`, theme)}`);
			parts.push(`${tpsColor(p10, `p10 ${fmtTps(p10)}`, theme)}`);
			parts.push(`${tpsColor(p95, `p95 ${fmtTps(p95)}`, theme)}`);

			const ttftMu = this.calcTtftMean(nowMs);
			parts.push(`TTFT ${ttftColor(ttftMu, `μ ${fmtTtft(ttftMu)}`, theme)}`);
		}

		if (hasElapsed) {
			parts.push(`Elapsed ${theme.fg("dim", fmtElapsed(this.totalElapsedMs))}`);
		}

		return parts.join(" | ");
	}

	/**
	 * Diagnostic accessor: inspect internal state without breaking encapsulation.
	 * Useful for tests and commands.
	 */
	inspect() {
		const nowMs = this.now();
		return {
			streaming: this.streaming,
			ttftSamples: this.allTtft.len,
			tpsSamples: this.allTps.len,
			tpsSamplesRecent: this.windowedCount(this.allTps, nowMs),
			ttftSamplesRecent: this.windowedCount(this.allTtft, nowMs),
			lastElapsedMs: this.lastElapsedMs,
			totalElapsedMs: this.totalElapsedMs,
			graphLen: this.graphLen,
			currentTtft: this.currentTtft,
			streamTokens: this.streamTokens,
			firstTokenTime: this.firstTokenTime,
			elapsedStart: this.elapsedStart,
		};
	}
}

export function createMeter(options?: MeterOptions): StatsMeter {
	return new StatsMeter(options);
}
