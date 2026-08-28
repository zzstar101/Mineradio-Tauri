import { beforeEach, expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import React from "react";
import type { Track } from "@mineradio/shared";
import { usePlayerShellRuntime } from "./usePlayerShellRuntime";
import { usePlayerShellStore } from "../../stores/player-shell-store";

await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Alice"],
		album: "Album",
		coverUrl: "",
		durationMs: 1000,
		qualityHints: [],
		playableState: "playable",
	};
}

interface Mount {
	root: ReturnType<typeof createRoot>;
	container: HTMLDivElement;
	setImmersive(on: boolean): void;
	lyricsCalls: boolean[];
	lyricsState: () => boolean;
}

function mountHarness(initialLyrics = false): Mount {
	const lyricsCalls: boolean[] = [];
	let lyricsEnabled = initialLyrics;
	let enters = 0;

	function Harness() {
		usePlayerShellRuntime({
			preferences: null,
			currentTrack: makeTrack("t"),
			showToast: () => undefined,
			onEnterImmersive: () => { enters += 1; },
			readImmersiveLyricsEnabled: () => lyricsEnabled,
			onImmersiveLyricsEnabledChange: (enabled) => {
				lyricsCalls.push(enabled);
				lyricsEnabled = enabled;
			},
		});
		return null;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(React.createElement(Harness));
	return {
		root,
		container,
		setImmersive: (on) => usePlayerShellStore.getState().setImmersiveMode(on),
		lyricsCalls,
		lyricsState: () => lyricsEnabled,
	} as Mount;
}

beforeEach(() => {
	usePlayerShellStore.setState({ controlsAutoHide: true, immersiveMode: false, lyricOffsets: {} });
});

test("IMMERSIVE_PARTICLE_LYRICS=IN: enter forces particle lyrics true, exit restores", async () => {
	const mounted = mountHarness();
	await new Promise((resolve) => setTimeout(resolve, 0));

	// 初始粒子歌词关闭。
	expect(mounted.lyricsState()).toBe(false);

	// 进入沉浸式：读取前值(false) → 强制 true。
	mounted.setImmersive(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(usePlayerShellStore.getState().immersiveMode).toBe(true);
	expect(mounted.lyricsCalls.at(-1)).toBe(true);
	expect(mounted.lyricsState()).toBe(true);

	// 退出沉浸式：恢复前值(false)。
	mounted.setImmersive(false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mounted.lyricsCalls.at(-1)).toBe(false);
	expect(mounted.lyricsState()).toBe(false);

	mounted.root.unmount();
	mounted.container.remove();
});

test("immersive enter with particle lyrics already enabled restores the same true value", async () => {
	const mounted = mountHarness(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mounted.lyricsState()).toBe(true);

	mounted.setImmersive(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mounted.lyricsCalls.at(-1)).toBe(true);

	mounted.setImmersive(false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	// 进入前粒子歌词就是 true，退出后应恢复 true。
	expect(mounted.lyricsCalls.at(-1)).toBe(true);
	expect(mounted.lyricsState()).toBe(true);

	mounted.root.unmount();
	mounted.container.remove();
});