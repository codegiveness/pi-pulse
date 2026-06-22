/**
 * Swap global setInterval/clearInterval with a synchronous, manually-driven
 * fake for the duration of `body`. pi-pulse only ever runs a single interval
 * (the live ticker), so the fake tracks exactly one active handle.
 *
 * `ctrl.tick(n)` fires the registered callback n times; `ctrl.active` reports
 * whether an interval is currently registered. No real wall-clock time passes,
 * so tests are fully deterministic.
 */
export async function withFakeTimers(body) {
	const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
	let handle = null;
	let callback = null;
	globalThis.setInterval = (cb) => {
		if (handle !== null) throw new Error("withFakeTimers: a timer is already active");
		callback = cb;
		handle = Symbol("fake-interval");
		return handle;
	};
	globalThis.clearInterval = (h) => {
		if (h === handle) {
			handle = null;
			callback = null;
		}
	};
	const ctrl = {
		tick(count = 1) {
			for (let i = 0; i < count; i++) callback?.();
		},
		get active() {
			return handle !== null;
		},
	};
	try {
		return await body(ctrl);
	} finally {
		globalThis.setInterval = real.setInterval;
		globalThis.clearInterval = real.clearInterval;
	}
}
