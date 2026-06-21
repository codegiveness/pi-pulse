/**
 * Configuration constants for pi-stats-meter.
 */

// TPS rolling-window config.
export const TPS_WIN_SIZE = 64;
export const TPS_WIN_MS = 60_000;
export const TPS_ALL_TIME_CAP = 512;

// Live-render timing.
export const TICK_MS = 250; // interval while streaming

// Braille graph config.
export const GRAPH_W = 10;
export const GRAPH_DOTS = GRAPH_W * 2;

// Minimum response elapsed (seconds) before a TPS sample is recorded or shown.
// Applied to both the live display and the sample stored on message_end so the
// two never disagree for very short responses.
export const TPS_MIN_ELAPSED_SEC = 0.3;

// Thresholds for color-coded values (tokens per second).
export const TPS_FAST = 50;
export const TPS_MED = 20;

// TTFT thresholds (seconds).
export const TTFT_FAST = 0.5;
export const TTFT_MED = 2.0;

// Session persistence key.
export const SNAPSHOT_TYPE = "pi-stats-meter/snapshot";
