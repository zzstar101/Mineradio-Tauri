import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VisualPerformanceSnapshot } from "@mineradio/visual-engine";
import { DesktopRuntimeControls } from "./DesktopRuntimeControls";
import type { DesktopManagementRuntimeResult } from "./useDesktopManagementRuntime";

function visualSnapshot(): VisualPerformanceSnapshot {
	return {
		runtime: { mode: "foreground", running: true, mounted: true, generation: 12 },
		frames: {
			rafTicks: 120,
			timerTicks: 0,
			renders: 115,
			skippedRenders: 5,
			frameCostP50Ms: 3.2,
			frameCostP95Ms: 7.4,
			longFrames: 1,
		},
		gates: {},
		resources: {
			current: { textureBytes: 2048, geometryBytes: 1024, meshCount: 8, queuedTaskCost: 0, cacheBytes: 0 },
			peak: { textureBytes: 4096, geometryBytes: 2048, meshCount: 12, queuedTaskCost: 2, cacheBytes: 0 },
			budget: { textureBytes: 8192, geometryBytes: 8192, meshCount: 64, queuedTaskCost: 32, cacheBytes: 8192 },
			pressure: "normal",
			allocations: 20,
			releases: 4,
		},
		tasks: {
			queued: 1,
			running: 1,
			completed: 9,
			cancelled: 0,
			staleResultsDropped: 2,
			failed: 0,
			peakQueueDepth: 4,
		},
		subsystems: {},
	};
}

function runtimeResult(): DesktopManagementRuntimeResult {
	const noop = async () => undefined;
	return {
		closeBehavior: "tray",
		windowRuntime: null,
		cache: {
			configuredRoot: "D:/MineRadio/cache",
			activeRoot: "C:/MineRadio/cache-fallback",
			fallbackUsed: true,
			fallbackReason: "drive unavailable",
			restartRequired: true,
			categories: [{
				category: "audio",
				path: "C:/MineRadio/cache-fallback/audio",
				totalBytes: 2048,
				fileCount: 2,
				directoryCount: 1,
				errorCount: 0,
				skippedLinkCount: 0,
				truncated: false,
			}],
			totalBytes: 2048,
			fileCount: 2,
			directoryCount: 1,
			errorCount: 0,
			skippedLinkCount: 0,
			truncated: false,
		},
		diagnostics: {
			native: {
				schemaVersion: 1,
				capturedAtMs: 10,
				health: "healthy",
				probes: [
					{ kind: "native", status: "healthy", capturedAtMs: 10, value: { pid: 7, workingSetBytes: 8192, privateBytes: 4096 }, message: null, error: null },
					{ kind: "tray", status: "healthy", capturedAtMs: 10, value: { lifecycle: { phase: "running" }, trayPhase: "ready" }, message: null, error: null },
				],
				recentErrors: [],
			},
			visual: visualSnapshot(),
			visualError: null,
		},
		workingSetAction: {
			phase: "completed",
			message: "应用工作集已整理",
			reclaimedBytes: 4096,
		},
		busy: false,
		error: null,
		setCloseBehavior: async () => undefined,
		refreshCache: noop,
		refreshDiagnostics: noop,
		trimApplicationWorkingSet: noop,
		chooseCacheRoot: noop,
		resetCacheRoot: noop,
		clearCacheCategory: async () => undefined,
	};
}

test("DesktopRuntimeControls exposes cache roots trim feedback and native plus visual summaries", () => {
	const html = renderToStaticMarkup(React.createElement(DesktopRuntimeControls, runtimeResult()));

	expect(html).toContain("整理应用工作集");
	expect(html).toContain("应用工作集已整理 · 释放 4.0 KB");
	expect(html).toContain("D:/MineRadio/cache");
	expect(html).toContain("C:/MineRadio/cache-fallback");
	expect(html).toContain("Native 诊断");
	expect(html).toContain("Visual 诊断");
	expect(html).toContain("7.4 ms");
	expect(html).toContain("8 meshes");
});
