/**
 * Swap global setInterval/clearInterval with a synchronous, manually-driven
 * fake for the duration of `body`. pi-pulse runs two intervals at most
 * (the streaming live ticker and the session-scoped clock ticker), so the
 * fake tracks any number of active handles.
 *
 * `ctrl.tick(n)` fires every currently-registered callback n times;
 * `ctrl.active` reports whether any interval is currently registered. No real
 * wall-clock time passes, so tests are fully deterministic.
 */
export async function withFakeTimers(body) {
	const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
	const handles = new Map();
	let nextId = 0;
	globalThis.setInterval = (cb) => {
		const handle = { id: nextId++ };
		handles.set(handle, cb);
		return handle;
	};
	globalThis.clearInterval = (h) => {
		handles.delete(h);
	};
	const ctrl = {
		tick(count = 1) {
			for (let i = 0; i < count; i++) {
				// Snapshot first so a callback clearing its own (or another)
				// handle mid-iteration does not mutate the map being iterated.
				const cbs = [...handles.values()];
				for (const cb of cbs) cb();
			}
		},
		get active() {
			return handles.size > 0;
		},
	};
	try {
		return await body(ctrl);
	} finally {
		globalThis.setInterval = real.setInterval;
		globalThis.clearInterval = real.clearInterval;
	}
}
