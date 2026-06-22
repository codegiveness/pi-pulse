/**
 * pi-pulse — Live TPS, TTFT, and response-time footer for pi.
 *
 * Displays a single-line footer under the "tps" status key:
 *
 *   TPS ⣤⣸⠀⠀ 42 avg | μ 38 | p10 25 | p95 55 | TTFT μ 0.25s | Elapsed 15s
 *
 * Metrics:
 *   - TPS: tokens per second during assistant text/thinking/tool-call-stream output
 *   - TTFT: mean time from `before_provider_request` to first assistant output token
 *   - Elapsed: duration of the current response while streaming, then the
 *     accumulated total across completed responses while idle.
 *
 * Built as a Pi package. Source lives in `src/`; Pi loads the compiled
 * output declared in `package.json#pi.extensions`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SNAPSHOT_TYPE, TICK_MS } from "./constants.js";
import { createMeter, isMeterSnapshot, type MeterSnapshot, type StatsMeter } from "./meter.js";

/** Called once per Pi session when this extension is loaded. */
export default function piPulseExtension(pi: ExtensionAPI, deps?: { meter?: StatsMeter }): void {
	const meter = deps?.meter ?? createMeter();

	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let abortCleanup: (() => void) | null = null;

	function startTick(ctx: ExtensionContext): void {
		if (tickTimer) return;

		tickTimer = setInterval(() => {
			if (!meter.inspect().streaming) return;
			safeSetStatus(ctx, "tps", meter.renderLive(ctx.ui.theme));
		}, TICK_MS);

		// If the current turn is aborted, stop ticking immediately so we don't
		// keep rendering status while the runner is tearing down the stream.
		const signal = ctx.signal;
		if (signal && !signal.aborted) {
			const onAbort = () => stopTick();
			signal.addEventListener("abort", onAbort, { once: true });
			abortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
	}

	function stopTick(): void {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		if (abortCleanup) {
			abortCleanup();
			abortCleanup = null;
		}
	}

	function safeSetStatus(ctx: ExtensionContext, key: string, text: string | undefined): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(key, text);
		} catch {
			// Footer rendering is best-effort; a rendering error should not bring down Pi.
		}
	}

	function reset(ctx: ExtensionContext): void {
		stopTick();
		meter.reset();
		safeSetStatus(ctx, "tps", undefined);
	}

	function isAssistantMessage(message: { role: string }): boolean {
		return message.role === "assistant";
	}

	function findLatestSnapshot(ctx: ExtensionContext): MeterSnapshot | undefined {
		if (!ctx.sessionManager?.getBranch) return undefined;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry &&
				entry.type === "custom" &&
				entry.customType === SNAPSHOT_TYPE &&
				isMeterSnapshot(entry.data)
			) {
				return entry.data;
			}
		}
		return undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
		const snapshot = findLatestSnapshot(ctx);
		if (snapshot) {
			meter.restore(snapshot);
			const text = meter.renderFinal(ctx.ui.theme);
			if (text) safeSetStatus(ctx, "tps", text);
		}
	});

	pi.on("before_provider_request", async () => {
		meter.markRequestStart();
	});

	pi.on("message_start", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		meter.startAssistantMessage();
		startTick(ctx);
	});

	pi.on("message_update", async (event) => {
		if (!isAssistantMessage(event.message)) return;
		const payload = event.assistantMessageEvent;

		// Streamed assistant output: text, reasoning, or tool-call parameters.
		if (
			payload.type === "text_delta" ||
			payload.type === "thinking_delta" ||
			payload.type === "toolcall_delta"
		) {
			meter.addDelta(payload.type, payload.delta ?? "");
			return;
		}

		// Non-streamed tool call (toolcall_start with no deltas): no token stream,
		// but it is still the first model output of the turn, so it stops the TTFT timer.
		if (payload.type === "toolcall_start") {
			meter.markFirstToken();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		stopTick();
		meter.endAssistantMessage();
		const text = meter.renderFinal(ctx.ui.theme);
		if (text) safeSetStatus(ctx, "tps", text);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (meter.hasData() && typeof pi.appendEntry === "function") {
			pi.appendEntry(SNAPSHOT_TYPE, meter.serialize());
		}
		reset(ctx);
	});
}
