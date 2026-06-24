/**
 * Configuration constants for pi-pulse.
 */

// TPS rolling-window config.
export const TPS_WIN_SIZE = 64;
export const TPS_WIN_MS = 60_000;
export const TPS_ALL_TIME_CAP = 512;

// How far back TPS/TTFT distribution statistics look. Older samples are
// retained in the ring buffer (up to TPS_ALL_TIME_CAP) but excluded from
// mean/percentile calculations.
export const ALL_TIME_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Live-render timing.
export const TICK_MS = 250; // interval while streaming
export const CLOCK_MS = 1000; // interval for the ticking wall-clock timestamp

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
export const SNAPSHOT_TYPE = "pi-pulse/snapshot";
