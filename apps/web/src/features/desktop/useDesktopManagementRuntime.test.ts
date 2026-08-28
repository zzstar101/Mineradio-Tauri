import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { VisualPerformanceSnapshot } from "@mineradio/visual-engine";
import type {
	DesktopCacheSnapshot,
	DesktopDiagnosticsSnapshot,
	DesktopRuntimePort,
	DesktopWindowRuntimeState,
} from "../../ports/desktop-runtime-port";
import {
	clearLegacyCloseBehavior,
	CLOSE_BEHAVIOR_STORE_KEY,
	describeWorkingSetTrimResult,
	loadCloseBehavior,
	normalizeCloseBehavior,
	readLegacyCloseBehavior,
	saveCloseBehavior,
	type DesktopManagementRuntimeResult,
	useDesktopManagementRuntime,
} from "./useDesktopManagementRuntime";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function installTestLocalStorage() {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		clear: () => values.clear(),
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	} as Storage;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	return {
		storage,
		restore() {
			if (previous) Object.defineProperty(globalThis, "localStorage", previous);
			else Reflect.deleteProperty(globalThis, "localStorage");
		},
	};
}

function cacheSnapshot(activeRoot: string): DesktopCacheSnapshot {
	return {
		configuredRoot: activeRoot,
		activeRoot,
		fallbackUsed: false,
		fallbackReason: null,
		restartRequired: false,
		categories: [],
		totalBytes: 0,
		fileCount: 0,
		directoryCount: 0,
		errorCount: 0,
		skippedLinkCount: 0,
		truncated: false,
	};
}

function nativeDiagnostics(capturedAtMs: number): DesktopDiagnosticsSnapshot {
	return {
		schemaVersion: 1,
		capturedAtMs,
		health: "healthy",
		probes: [],
		recentErrors: [],
	};
}

function windowRuntime(closeBehavior: "exit" | "tray"): DesktopWindowRuntimeState {
	return {
		lifecycle: { closeBehavior, phase: "running", cleanupClaimed: false },
		trayPhase: closeBehavior === "tray" ? "ready" : "unavailable",
		debounceGeneration: 0,
		debounceWorkerRunning: false,
	};
}

function visualDiagnostics(generation: number): VisualPerformanceSnapshot {
	return {
		runtime: { mode: "foreground", running: true, mounted: true, generation },
		frames: {
			rafTicks: 1,
			timerTicks: 0,
			renders: 1,
			skippedRenders: 0,
			frameCostP50Ms: 2,
			frameCostP95Ms: 4,
			longFrames: 0,
		},
		gates: {},
		resources: {
			current: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
			peak: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
			budget: { textureBytes: 0, geometryBytes: 0, meshCount: 0, queuedTaskCost: 0, cacheBytes: 0 },
			pressure: "normal",
			allocations: 0,
			releases: 0,
		},
		tasks: {
			queued: 0,
			running: 0,
			completed: 0,
			cancelled: 0,
			staleResultsDropped: 0,
			failed: 0,
			peakQueueDepth: 0,
		},
		subsystems: {},
	};
}

test("close behavior defaults to exit and only accepts the tray opt-in", () => {
	expect(normalizeCloseBehavior("tray")).toBe("tray");
	expect(normalizeCloseBehavior("exit")).toBe("exit");
	expect(normalizeCloseBehavior("unknown")).toBe("exit");
	expect(loadCloseBehavior(null)).toBe("exit");
});

test("close behavior preference round-trips through the stable storage key", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem(key: string) {
			return values.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			values.set(key, value);
		},
		removeItem(key: string) {
			values.delete(key);
		},
	};

	expect(readLegacyCloseBehavior(storage)).toBeNull();
	saveCloseBehavior(storage, "tray");
	expect(values.get(CLOSE_BEHAVIOR_STORE_KEY)).toBe("tray");
	expect(readLegacyCloseBehavior(storage)).toBe("tray");
	expect(loadCloseBehavior(storage)).toBe("tray");
	clearLegacyCloseBehavior(storage);
	expect(readLegacyCloseBehavior(storage)).toBeNull();
});

test("native close behavior is authoritative after legacy localStorage has been migrated", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const local = installTestLocalStorage();
	local.storage.removeItem(CLOSE_BEHAVIOR_STORE_KEY);
	const setCalls: string[] = [];
	const desktop = {
		getWindowRuntimeState: async () => windowRuntime("tray"),
		setCloseBehavior: async (behavior: "exit" | "tray") => {
			setCalls.push(behavior);
			return windowRuntime(behavior);
		},
		getCacheSnapshot: async () => null,
		getDesktopDiagnostics: async () => null,
	} as unknown as DesktopRuntimePort;
	const controllerRef: { current: DesktopManagementRuntimeResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useDesktopManagementRuntime(desktop);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(controllerRef.current?.closeBehavior).toBe("tray");
	expect(setCalls).toEqual([]);

	await act(async () => root.unmount());
	host.remove();
	local.restore();
});

test("legacy close behavior migrates once into native settings and is then removed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const local = installTestLocalStorage();
	local.storage.setItem(CLOSE_BEHAVIOR_STORE_KEY, "tray");
	const setCalls: string[] = [];
	const desktop = {
		getWindowRuntimeState: async () => windowRuntime("exit"),
		setCloseBehavior: async (behavior: "exit" | "tray") => {
			setCalls.push(behavior);
			return windowRuntime(behavior);
		},
		getCacheSnapshot: async () => null,
		getDesktopDiagnostics: async () => null,
	} as unknown as DesktopRuntimePort;
	const controllerRef: { current: DesktopManagementRuntimeResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useDesktopManagementRuntime(desktop);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(controllerRef.current?.closeBehavior).toBe("tray");
	expect(setCalls).toEqual(["tray"]);
	expect(local.storage.getItem(CLOSE_BEHAVIOR_STORE_KEY)).toBeNull();

	await act(async () => root.unmount());
	host.remove();
	local.restore();
});

test("a late bootstrap snapshot cannot overwrite an explicit close behavior change", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const local = installTestLocalStorage();
	const runtimeRequest = deferred<DesktopWindowRuntimeState | null>();
	const setCalls: string[] = [];
	const desktop = {
		getWindowRuntimeState: () => runtimeRequest.promise,
		setCloseBehavior: async (behavior: "exit" | "tray") => {
			setCalls.push(behavior);
			return windowRuntime(behavior);
		},
		getCacheSnapshot: async () => null,
		getDesktopDiagnostics: async () => null,
	} as unknown as DesktopRuntimePort;
	const controllerRef: { current: DesktopManagementRuntimeResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useDesktopManagementRuntime(desktop);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	await act(async () => {
		await controllerRef.current!.setCloseBehavior("tray");
	});
	runtimeRequest.resolve(windowRuntime("exit"));
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(controllerRef.current?.closeBehavior).toBe("tray");
	expect(setCalls).toEqual(["tray"]);

	await act(async () => root.unmount());
	host.remove();
	local.restore();
});

test("working-set result feedback distinguishes completed skipped and failed outcomes", () => {
	expect(describeWorkingSetTrimResult({
		status: "completed",
		reclaimedWorkingSetBytes: 4096,
		before: { pid: 7, workingSetBytes: 8192 },
		after: { pid: 7, workingSetBytes: 4096 },
	})).toEqual({
		phase: "completed",
		message: "应用工作集已整理",
		reclaimedBytes: 4096,
	});
	expect(describeWorkingSetTrimResult({
		status: "skipped",
		reason: { kind: "foreground" },
	})).toEqual({
		phase: "skipped",
		message: "窗口位于前台，未整理工作集",
		reclaimedBytes: null,
	});
	expect(describeWorkingSetTrimResult({
		status: "failed",
		error: { message: "access denied" },
	})).toEqual({
		phase: "failed",
		message: "access denied",
		reclaimedBytes: null,
	});
});

test("mounting desktop management does not scan cache or probe raw diagnostics by default", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const local = installTestLocalStorage();
	let cacheCalls = 0;
	let diagnosticsCalls = 0;
	const desktop = {
		getWindowRuntimeState: async () => windowRuntime("exit"),
		setCloseBehavior: async () => windowRuntime("exit"),
		getCacheSnapshot: async () => {
			cacheCalls += 1;
			return cacheSnapshot("resource-control");
		},
		getDesktopDiagnostics: async () => {
			diagnosticsCalls += 1;
			return nativeDiagnostics(1);
		},
	} as unknown as DesktopRuntimePort;
	const controllerRef: { current: DesktopManagementRuntimeResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useDesktopManagementRuntime(desktop);
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});

	expect(cacheCalls).toBe(0);
	expect(diagnosticsCalls).toBe(0);
	expect(controllerRef.current?.cache).toBeNull();
	expect(controllerRef.current?.diagnostics).toBeNull();

	await act(async () => {
		await controllerRef.current!.refreshCache();
	});

	expect(cacheCalls).toBe(1);
	expect(controllerRef.current?.cache?.activeRoot).toBe("resource-control");

	await act(async () => root.unmount());
	host.remove();
	local.restore();
});

test("cache and composed diagnostics ignore older refreshes that resolve last", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const oldCache = deferred<DesktopCacheSnapshot | null>();
	const newCache = deferred<DesktopCacheSnapshot | null>();
	const oldDiagnostics = deferred<DesktopDiagnosticsSnapshot | null>();
	const newDiagnostics = deferred<DesktopDiagnosticsSnapshot | null>();
	let cacheCalls = 0;
	let diagnosticsCalls = 0;
	let visualGeneration = 0;
	const desktop = {
		getWindowRuntimeState: async () => null,
		setCloseBehavior: async () => null,
		getCacheSnapshot: () => {
			cacheCalls += 1;
			return cacheCalls === 1 ? oldCache.promise : newCache.promise;
		},
		getDesktopDiagnostics: () => {
			diagnosticsCalls += 1;
			return diagnosticsCalls === 1 ? oldDiagnostics.promise : newDiagnostics.promise;
		},
	} as unknown as DesktopRuntimePort;
	const controllerRef: { current: DesktopManagementRuntimeResult | null } = { current: null };

	function Harness() {
		controllerRef.current = useDesktopManagementRuntime(desktop, {
			getVisualPerformanceSnapshot: () => visualDiagnostics(++visualGeneration),
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
		await Promise.resolve();
	});

	const oldCacheRequest = controllerRef.current!.refreshCache();
	const newCacheRequest = controllerRef.current!.refreshCache();
	const oldDiagnosticsRequest = controllerRef.current!.refreshDiagnostics();
	const newDiagnosticsRequest = controllerRef.current!.refreshDiagnostics();
	newCache.resolve(cacheSnapshot("new"));
	newDiagnostics.resolve(nativeDiagnostics(2));
	await act(async () => {
		await Promise.all([newCacheRequest, newDiagnosticsRequest]);
	});
	oldCache.resolve(cacheSnapshot("old"));
	oldDiagnostics.resolve(nativeDiagnostics(1));
	await act(async () => {
		await Promise.all([oldCacheRequest, oldDiagnosticsRequest]);
	});

	expect(controllerRef.current?.cache?.activeRoot).toBe("new");
	expect(controllerRef.current?.diagnostics?.native?.capturedAtMs).toBe(2);
	expect(controllerRef.current?.diagnostics?.visual?.runtime.generation).toBeGreaterThan(0);

	await act(async () => root.unmount());
	host.remove();
});
