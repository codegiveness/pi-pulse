/**
 * Number/duration formatting and color helpers.
 */

import { TPS_FAST, TPS_MED, TTFT_FAST, TTFT_MED } from "./constants.js";

export interface Theme {
	fg(name: string, text: string): string;
}

/** Format TPS as a compact number string. */
export function fmtTps(v: number): string {
	if (!Number.isFinite(v) || v < 0) return "0.0";
	if (v < 10) return v.toFixed(1);
	return `${Math.round(v)}`;
}

/** Format a TTFT duration in seconds. */
export function fmtTtft(t: number): string {
	if (t <= 0) return "0.00s";
	if (t < 10) return `${t.toFixed(2)}s`;
	if (t < 100) return `${t.toFixed(1)}s`;
	return `${Math.round(t)}s`;
}

/** Format elapsed time as `1h 30m 15s`, `30m 15s`, `15s`, or `0.5s` for sub-second values. */
export function fmtElapsed(ms: number): string {
	if (ms < 0) ms = 0;
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
	if (h > 0) return `${h}h ${pad2(m)}m ${pad2(sec)}s`;
	if (m > 0) return `${m}m ${pad2(sec)}s`;
	return `${sec}s`;
}

/**
 * Format a wall-clock timestamp as ISO 8601 UTC with second precision,
 * e.g. `2026-06-24T02:22:47Z`. Defaults to the current time.
 */
export function fmtClock(date: Date = new Date()): string {
	return date.toISOString().slice(0, 19) + "Z";
}

/**
 * Color-code TPS: fast = success, medium = warning, slow = error.
 */
export function tpsColor(tps: number, text: string, theme: Theme): string {
	if (tps >= TPS_FAST) return theme.fg("success", text);
	if (tps >= TPS_MED) return theme.fg("warning", text);
	return theme.fg("error", text);
}

/**
 * Color-code TTFT: fast = success, medium = warning, slow = error.
 */
export function ttftColor(t: number, text: string, theme: Theme): string {
	if (t <= 0) return theme.fg("dim", text);
	if (t <= TTFT_FAST) return theme.fg("success", text);
	if (t <= TTFT_MED) return theme.fg("warning", text);
	return theme.fg("error", text);
}
