import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopRuntimeControls } from "./DesktopRuntimeControls";
import type { DesktopManagementRuntimeResult } from "./useDesktopManagementRuntime";

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
			visual: null,
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

test("DesktopRuntimeControls exposes resource controls without raw diagnostics UI", () => {
	const html = renderToStaticMarkup(React.createElement(DesktopRuntimeControls, runtimeResult()));

	expect(html).toContain("整理应用工作集");
	expect(html).toContain("应用工作集已整理 · 释放 4.0 KB");
	expect(html).toContain("D:/MineRadio/cache");
	expect(html).toContain("C:/MineRadio/cache-fallback");
	expect(html).not.toContain("Native 诊断");
	expect(html).not.toContain("Visual 诊断");
	expect(html).not.toContain("刷新诊断");
	expect(html).not.toContain("probes");
});
