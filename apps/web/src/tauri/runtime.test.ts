import { expect, test } from "bun:test";
import {
	closeDesktopLyricsWindow,
	configureGlobalHotkeys,
	exportJsonFile,
	getRuntimeConfig,
	getFullDesktopRuntimeState,
	getWindowState,
	importJsonFile,
	isTauriRuntime,
	listenGlobalHotkey,
	listenWindowState,
	closeWindow,
	minimizeWindow,
	openExternalUrl,
	openProviderLoginWindow,
	recoverFullDesktopRuntime,
	setDesktopIconsVisible,
	setFullDesktopInteractionLocked,
	setFullDesktopMode,
	showDesktopLyricsWindow,
	toggleWindowMaximize,
	toggleWindowFullscreen,
	updateDesktopLyricsPayload
} from "./runtime";

test("isTauriRuntime is false outside the Tauri webview", () => {
	expect(isTauriRuntime()).toBe(false);
});

test("getRuntimeConfig resolves to a non-crashing placeholder outside Tauri", async () => {
	const cfg = await getRuntimeConfig();
	expect(typeof cfg.mediaProxyBase).toBe("string");
	expect(cfg.mediaProxyBase).toBe("mineradio-tauri://localhost");
	expect(typeof cfg.appVersion).toBe("string");
	expect(cfg.appVersion.length).toBeGreaterThan(0);
});

test("getWindowState resolves to an Electron-compatible default outside Tauri", async () => {
	const state = await getWindowState();
	expect(state).toEqual({
		isMaximized: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
		isFullScreen: false,
		isMinimized: false,
		isVisible: false,
		isFocused: false,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: false,
		hasDisplayOnRight: false,
		displayBounds: null,
	});
});

test("window state listener is inert outside Tauri", async () => {
	let called = false;
	const unlisten = await listenWindowState(() => {
		called = true;
	});
	unlisten();
	expect(called).toBe(false);
});

test("JSON file helpers return cancelled placeholders outside Tauri", async () => {
	const exported = await exportJsonFile("preset.json", { enabled: true });
	expect(exported).toEqual({
		cancelled: true,
		path: null,
	});
	const imported = await importJsonFile();
	expect(imported).toEqual({
		cancelled: true,
		path: null,
		data: null,
	});
});

test("global hotkey helpers are inert outside Tauri", async () => {
	const configured = await configureGlobalHotkeys([
		{ action: "togglePlay", accelerator: "Control+Alt+Space" },
	]);
	expect(configured).toEqual({
		ok: true,
		results: [],
	});
	let called = false;
	const unlisten = await listenGlobalHotkey(() => {
		called = true;
	});
	unlisten();
	expect(called).toBe(false);
});

test("window fullscreen helper is inert outside Tauri", async () => {
	expect(await toggleWindowFullscreen()).toBe(undefined);
});

test("window chrome helpers are inert outside Tauri", async () => {
	expect(await minimizeWindow()).toBe(undefined);
	expect(await toggleWindowMaximize()).toBe(undefined);
	expect(await closeWindow()).toBe(undefined);
});

test("external URL helper is inert outside Tauri", async () => {
	expect(await openExternalUrl("https://example.com/release")).toBe(false);
});

test("desktop lyrics window helpers are inert outside Tauri", async () => {
	expect(await showDesktopLyricsWindow()).toBe(undefined);
	expect(await updateDesktopLyricsPayload({ enabled: true, text: "line" })).toBe(undefined);
	expect(await closeDesktopLyricsWindow()).toBe(undefined);
});

test("provider login helper returns a no-cookie placeholder outside Tauri", async () => {
	const result = await openProviderLoginWindow("netease");
	expect(result).toEqual({
		provider: "netease",
		stored: false,
		reused: false,
		partial: false,
	});
});

test("full desktop helpers preserve the disabled contract outside Tauri", async () => {
	const expected = {
		phase: "disabled",
		requestedMode: "disabled",
		effectiveMode: "disabled",
		iconsVisible: true,
		interactionLocked: false,
		recoveryRequired: false,
		autoResumeSuppressed: false,
		explorerGeneration: 0,
	};
	expect(await getFullDesktopRuntimeState()).toEqual(expected);
	expect(await setFullDesktopMode("passive")).toEqual(expected);
	expect(await setDesktopIconsVisible(false)).toEqual(expected);
	expect(await setFullDesktopInteractionLocked(true)).toEqual(expected);
	expect(await recoverFullDesktopRuntime()).toEqual(expected);
});
