import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import React from "react";
import type { Track } from "@mineradio/shared";
import { PlayerConsoleHost } from "./PlayerConsoleHost";
import { assertPlayerShellStructure } from "./player-shell-golden";

function makeTrack(id: string, provider: Track["provider"] = "netease"): Track {
	return {
		provider,
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

test("PlayerConsoleHost server-renders the canonical upstream bottom-bar markup", () => {
	const html = renderToStaticMarkup(React.createElement(PlayerConsoleHost, {}));
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="play-btn"');
	expect(html).toContain('id="play-mode-btn"');
	expect(html).toContain('id="control-cover"');
	expect(html).toContain('id="time-display"');
	// Quality chip is a sibling of title badges inside the title row (upstream).
	expect(html.indexOf('id="quality-control"')).toBeGreaterThan(html.indexOf('id="control-title-badges"'));
	expect(html.indexOf('id="quality-control"')).toBeLessThan(html.indexOf('id="control-artist"'));
	// Mini queue precedes progress (upstream).
	expect(html.indexOf('id="mini-queue-popover"')).toBeLessThan(html.indexOf('id="progress-bar"'));
	// Window chrome moved to titlebar.
	expect(html).not.toContain("console-host-minimize");
	expect(html).not.toContain("volume-panel-extras");
	// Lyric timing control present with -0.1 / 0 / +0.1.
	expect(html).toContain('id="lyric-timing-control"');
	expect(html).toContain('data-lyric-offset-step="-0.1"');
	expect(html).toContain('data-lyric-offset-reset');
	expect(html).toContain('data-lyric-offset-step="0.1"');
	// Immersive + auto-hide toggles present.
	expect(html).toContain('id="immersive-btn"');
	expect(html).toContain('id="controls-hide-btn"');
});

test("PlayerConsoleHost passes the canonical golden structure assertion", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const html = renderToStaticMarkup(React.createElement(PlayerConsoleHost, {
		miniQueueOpen: true,
		queue: [makeTrack("golden")],
	}));
	const container = document.createElement("div");
	// PlayerConsoleHost 只渲染底栏；标准把手由 BottomControlsHost 渲染，这里补上
	// 让 golden 结构断言覆盖完整 shell（与真实 BottomControlsHost 输出一致）。
	container.innerHTML = `<button id="bottom-handle" type="button" aria-label="展开播放器控制台" title="展开播放器控制台"><span/></button>${html}`;
	const result = assertPlayerShellStructure(container);
	expect(result.passed).toBe(true);
	for (const check of result.checks) {
		if (!check.ok) throw new Error(check.detail ?? check.label);
		expect(check.ok).toBe(true);
	}
});

test("PlayerConsoleHost renders baseline playback quality options inside metadata badges", () => {
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, { playbackQuality: "lossless" }),
	);
	expect(html).toContain('id="quality-btn-label"');
	expect(html).toContain(">SQ<");
	expect(html).toContain('data-quality="jymaster"');
	expect(html).toContain("超清母带");
	expect(html).toContain('data-quality="standard"');
});

test("PlayerConsoleHost renders provider-reported quality options when supplied", () => {
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, {
			playbackQuality: "320",
			qualityOptions: [
				{ provider: "qq", id: "flac", label: "FLAC", short: "FLAC", detail: "42MB", requestQuality: "flac", source: "declared" },
				{ provider: "qq", id: "320", label: "320k MP3", short: "320", detail: "9MB", requestQuality: "320", source: "declared" },
			],
		}),
	);
	expect(html).toContain(">320<");
	expect(html).toContain('data-quality="flac"');
	expect(html).not.toContain('data-quality="jymaster"');
	expect(html).not.toContain('data-quality="standard"');
});

test("PlayerConsoleHost renders capability-driven source switching inside title badges", () => {
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, {
			currentTrack: makeTrack("source"),
			sourceProviders: ["netease", "qq", "soda"],
			sourceSwitchBusy: null,
			onSourceSwitch: () => {},
		}),
	);
	expect(html).toContain('data-source-provider="qq"');
	expect(html).toContain('data-source-provider="soda"');
	expect(html).not.toContain('data-source-provider="netease"');
	expect(html.indexOf('id="control-title-badges"')).toBeLessThan(html.indexOf('class="source-switcher"'));
});

test("PlayerConsoleHost virtualizes the mini queue popover and renders explicit close", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const queue = Array.from({ length: 240 }, (_, index) => makeTrack(String(index)));
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			miniQueueOpen: true,
			queue,
			currentTrack: queue[0],
			onCloseMiniQueue: () => calls.push("close"),
			onPlayQueueIndex: (index: number) => calls.push(`play:${index}`),
			onInsertQueueNext: (index: number) => calls.push(`next:${index}`),
			onRemoveQueueIndex: (index: number) => calls.push(`remove:${index}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#mini-queue-list")?.getAttribute("data-virtualized")).toBe("true");
	expect(container.querySelectorAll(".mini-queue-item").length).toBeLessThan(60);
	const closeBtn = container.querySelector(".mini-queue-head button") as HTMLButtonElement;
	expect(closeBtn.textContent?.trim()).toBe("×");
	closeBtn.click();
	expect(calls[0]).toBe("close");
	(container.querySelector(".mini-queue-main") as HTMLButtonElement).click();
	(container.querySelector(".mini-queue-next") as HTMLButtonElement).click();
	(container.querySelector(".mini-queue-remove:last-child") as HTMLButtonElement).click();
	expect(calls).toEqual(["close", "play:0", "next:0", "remove:0"]);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost mini queue long-press drag reorders via onMoveQueueIndex", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const moves: Array<[number, number]> = [];
	const queue = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	const container = document.createElement("div");
	document.body.appendChild(container);
	// Give the list a layout so elementFromPoint resolves on drop.
	container.style.position = "absolute";
	document.body.appendChild(container);

	// Deterministic timers so the 520ms long-press fires fast in tests.
	const timerSlot: { fn: (() => void) | null } = { fn: null };
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			miniQueueOpen: true,
			queue,
			onMoveQueueIndex: (from, to) => moves.push([from, to]),
			timers: {
				setTimeout: ((fn: () => void) => { timerSlot.fn = fn; return 1; }) as typeof window.setTimeout,
				clearTimeout: (() => {}) as typeof window.clearTimeout,
			},
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const rows = container.querySelectorAll('.mini-queue-item[data-queue-index]');
	const first = rows[0] as HTMLElement;
	const rect = first.getBoundingClientRect();
	const down = new window.PointerEvent("pointerdown", {
		bubbles: true, clientX: rect.left + 5, clientY: rect.top + 5, pointerId: 7, isPrimary: true,
	});
	first.dispatchEvent(down);
	expect(timerSlot.fn).not.toBeNull();
	// Complete the long-press lift.
	if (timerSlot.fn) timerSlot.fn();
	expect(document.body.classList.contains("panel-reordering")).toBe(true);

	// Drop on the last row's center.
	const last = rows[2] as HTMLElement;
	// happy-dom cannot do elementFromPoint with layout; simulate target row directly.
	Object.defineProperty(document, "elementFromPoint", {
		value: () => last, configurable: true, writable: true,
	});
	window.dispatchEvent(new window.PointerEvent("pointerup", {
		bubbles: true, clientX: 0, clientY: 0, pointerId: 7,
	}));

	expect(moves).toEqual([[0, 2]]);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost mini queue long-press survives playback-style rerenders", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const queue = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const render = (positionMs: number) => root.render(
		React.createElement(PlayerConsoleHost, {
			miniQueueOpen: true,
			queue,
			positionMs,
			onMoveQueueIndex: () => {},
		}),
	);
	render(0);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const first = container.querySelector('.mini-queue-item[data-queue-index="0"]') as HTMLElement;
	first.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		clientX: 1,
		clientY: 1,
		pointerId: 9,
		isPrimary: true,
	}));
	// The playback clock rerenders PlayerConsoleHost while the pointer is held.
	render(100);
	await new Promise((resolve) => setTimeout(resolve, 560));
	expect(document.body.classList.contains("panel-reordering")).toBe(true);

	window.dispatchEvent(new window.PointerEvent("pointercancel", {
		bubbles: true,
		pointerId: 9,
		isPrimary: true,
	}));
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost lyric timing adjust/reset route to callbacks and gate on track key", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: Array<[string, number | undefined]> = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			currentTrack: makeTrack("ly"),
			lyricOffsetLabel: "0.0s",
			lyricTimingDisabled: false,
			onLyricOffsetAdjust: (step) => calls.push(["adjust", step]),
			onLyricOffsetReset: () => calls.push(["reset", undefined]),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const containerEl = container.querySelector("#lyric-timing-control") as HTMLElement;
	containerEl.querySelector("[data-lyric-offset-step='-0.1']")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	containerEl.querySelector("[data-lyric-offset-step='0.1']")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	containerEl.querySelector("[data-lyric-offset-reset]")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	expect(calls).toEqual([["adjust", -0.1], ["adjust", 0.1], ["reset", undefined]]);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost lyric timing buttons disable without a track key", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, { lyricTimingDisabled: true }),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const buttons = container.querySelectorAll("[data-lyric-offset-step], [data-lyric-offset-reset]");
	expect(buttons.length).toBe(3);
	for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost immersive + auto-hide toggles forward callbacks and aria state", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			controlsAutoHide: true,
			immersiveMode: false,
			onToggleControlsAutoHide: () => calls.push("hide"),
			onToggleImmersive: () => calls.push("immersive"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const hideBtn = container.querySelector("#controls-hide-btn") as HTMLButtonElement;
	expect(hideBtn.getAttribute("aria-pressed")).toBe("true");
	hideBtn.click();
	const immersiveBtn = container.querySelector("#immersive-btn") as HTMLButtonElement;
	expect(immersiveBtn.getAttribute("aria-pressed")).toBe("false");
	immersiveBtn.click();
	expect(calls).toEqual(["hide", "immersive"]);

	root.unmount();
	container.remove();
});

test("PlayerConsoleHost routes the collect button to the baseline collect picker callback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let opened = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			currentTrack: makeTrack("c"),
			onCollectCurrent: () => { opened += 1; },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	(container.querySelector("#collect-btn") as HTMLButtonElement).click();
	expect(opened).toBe(1);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost renderMdVolumeFade empty-quality state stays generic", () => {
	const html = renderToStaticMarkup(
		React.createElement(PlayerConsoleHost, { playbackQuality: "lossless", qualityOptions: [] }),
	);
	expect(html).toContain('id="quality-btn"');
	expect(html).toContain('data-quality="lossless"');
	expect(html).toContain('data-quality="standard"');
});

test("PlayerConsoleHost like button disables while like mutation is busy", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let toggles = 0;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			currentTrack: makeTrack("b"),
			currentLikeBusy: true,
			onToggleLikeCurrent: () => { toggles += 1; },
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const button = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	expect(button.className).toContain("busy");
	button.click();
	expect(toggles).toBe(0);
	root.unmount();
	container.remove();
});

test("PlayerConsoleHost fullscreen button emits callback without stale placeholder notice", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(PlayerConsoleHost, {
			onToggleFullscreen: () => calls.push("fullscreen"),
			onNotice: (message) => calls.push(`notice:${message}`),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const button = container.querySelector(".fullscreen-toggle-btn") as HTMLButtonElement;
	button.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
	button.click();
	expect(calls).toEqual(["fullscreen"]);
	root.unmount();
	container.remove();
});