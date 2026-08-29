import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
	DesktopGlobalHotkeyBinding,
	DesktopGlobalHotkeyEventPayload,
	DesktopJsonValue,
	DesktopRuntimePort,
	DesktopWindowState,
} from "../../ports/desktop-runtime-port";
import {
	shouldExitDesktopFullscreenOnEscape,
	useDesktopRuntime,
	type DesktopRuntimeResult,
} from "./useDesktopRuntime";

const WINDOW_STATE: DesktopWindowState = {
	isMaximized: false,
	isNativeFullScreen: false,
	isHtmlFullScreen: false,
	isWindowFullScreen: false,
	isFullScreen: false,
	isMinimized: false,
	isVisible: true,
	isFocused: true,
	isPrimaryDisplay: true,
	hasDisplayOnLeft: false,
	hasDisplayOnRight: false,
	displayBounds: null,
};

test("desktop fullscreen Escape policy is scoped to active fullscreen", () => {
	expect(shouldExitDesktopFullscreenOnEscape(
		{ key: "Escape", repeat: false, isComposing: false },
		{ ...WINDOW_STATE, isNativeFullScreen: true },
	)).toBe(true);
	expect(shouldExitDesktopFullscreenOnEscape(
		{ key: "Escape", repeat: false, isComposing: false },
		WINDOW_STATE,
	)).toBe(false);
	expect(shouldExitDesktopFullscreenOnEscape(
		{ key: "Escape", repeat: true, isComposing: false },
		{ ...WINDOW_STATE, isNativeFullScreen: true },
	)).toBe(false);
});

test("desktop runtime owns lyric enable order and hotkey cleanup", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const events: string[] = [];
	let hotkeyHandler: ((payload: DesktopGlobalHotkeyEventPayload) => void) | null = null;
	const desktop = {
		async getWindowState() {
			return WINDOW_STATE;
		},
		async listenWindowState() {
			return () => events.push("window-unlisten");
		},
		async configureGlobalHotkeys(bindings: DesktopGlobalHotkeyBinding[]) {
			events.push(`hotkeys:${bindings.length}`);
			return { ok: true, results: [] };
		},
		async listenGlobalHotkey(handler: (payload: DesktopGlobalHotkeyEventPayload) => void) {
			hotkeyHandler = handler;
			return () => events.push("hotkey-unlisten");
		},
		async updateDesktopLyricsPayload(payload: DesktopJsonValue) {
			events.push(`payload:${String((payload as { force?: boolean }).force)}`);
		},
		async showDesktopLyricsWindow() {
			events.push("show");
		},
		async closeDesktopLyricsWindow() {
			events.push("close");
		},
	} as unknown as DesktopRuntimePort;
	const runtimeRef: { current: DesktopRuntimeResult | null } = { current: null };

	function Harness() {
		runtimeRef.current = useDesktopRuntime({
			desktop,
			buildLyricsPayload: (force) => ({ force }),
			lyricsPayloadVersion: 0,
			hotkeyActions: {
				togglePlay: () => events.push("toggle-play"),
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	await act(async () => {
		await runtimeRef.current!.setDesktopLyricsEnabled(true);
	});
	(hotkeyHandler as ((payload: DesktopGlobalHotkeyEventPayload) => void) | null)?.({
		action: "togglePlay",
	});
	await act(async () => {
		await runtimeRef.current!.setDesktopLyricsEnabled(false);
	});

	expect(events).toContain("payload:true");
	expect(events.indexOf("payload:true")).toBeLessThan(events.indexOf("show"));
	expect(events).toContain("toggle-play");
	expect(events).toContain("close");

	root.unmount();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(events).toContain("hotkeys:0");
	expect(events).toContain("hotkey-unlisten");
	expect(events).toContain("window-unlisten");
	host.remove();
});

test("desktop runtime commits a beat map key only after payload delivery succeeds", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let shouldFail = true;
	const sentKeys: string[] = [];
	const desktop = {
		async getWindowState() {
			return WINDOW_STATE;
		},
		async listenWindowState() {
			return () => {};
		},
		async configureGlobalHotkeys() {
			return { ok: true, results: [] };
		},
		async listenGlobalHotkey() {
			return () => {};
		},
		async updateDesktopLyricsPayload() {
			if (shouldFail) throw new Error("delivery failed");
		},
		async showDesktopLyricsWindow() {},
		async closeDesktopLyricsWindow() {},
	} as unknown as DesktopRuntimePort;
	const runtimeRef: { current: DesktopRuntimeResult | null } = { current: null };

	function Harness() {
		runtimeRef.current = useDesktopRuntime({
			desktop,
			buildLyricsPayload: () => ({ beatMapKey: "new-key", beatMap: { kicks: [1] } }),
			lyricsPayloadVersion: 0,
			hotkeyActions: {},
			onLyricsPayloadSent: (payload) => sentKeys.push(String(payload.beatMapKey)),
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	let deliveryError: unknown = null;
	try {
		await runtimeRef.current!.setDesktopLyricsEnabled(true);
	} catch (error) {
		deliveryError = error;
	}
	expect(String(deliveryError)).toContain("delivery failed");
	expect(sentKeys).toEqual([]);
	shouldFail = false;
	await act(async () => {
		await runtimeRef.current!.setDesktopLyricsEnabled(true);
	});
	expect(sentKeys).toEqual(["new-key"]);

	root.unmount();
	host.remove();
});
