import { expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import React from "react";
import type { Track } from "@mineradio/shared";
import { BottomControlsHost } from "./BottomControlsHost";

function neteaseTrack(id: string): Track {
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

test("BottomControlsHost exposes the fullscreen callback; window chrome stays in the titlebar", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => calls.push("reveal"),
			onMinimize: () => calls.push("minimize"),
			onToggleMaximize: () => calls.push("maximize"),
			onToggleFullscreen: () => calls.push("fullscreen"),
			onClose: () => calls.push("close"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	// Wave 3: window min/max/close belong to the titlebar, not the bottom bar.
	expect(container.querySelector(".console-host-minimize")).toBeNull();

	(container.querySelector(".fullscreen-toggle-btn") as HTMLButtonElement).click();
	expect(calls).toEqual(["fullscreen"]);
	root.unmount();
	container.remove();
});

test("BottomControlsHost forwards current heart state and click callback for supported provider", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => calls.push("reveal"),
			currentTrack: neteaseTrack("s"),
			currentLiked: true,
			onToggleLikeCurrent: () => calls.push("like"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const button = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(button.className).toContain("liked");
	expect(button.getAttribute("aria-pressed")).toBe("true");
	expect(button.disabled).toBe(false);
	button.click();
	expect(calls).toEqual(["like"]);
	root.unmount();
	container.remove();
});

test("BottomControlsHost gates like/collect for unsupported provider without a dead silent button", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => undefined,
			currentTrack: neteaseTrack("s"),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	// Netease supports like + collect → enabled affordances with upstream labels.
	const heart = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(heart.disabled).toBe(false);
	expect(heart.title).toBe("红心喜欢");
	const collect = container.querySelector("#collect-btn") as HTMLButtonElement;
	expect(collect.disabled).toBe(false);
	expect(collect.title).toBe("收藏到歌单");

	// QQ: like unsupported → button stays enabled (upstream renders always) but
	// its title carries the capability message; App controller shows the toast
	// without calling the mutation.
	root.unmount();
	container.innerHTML = "";
	const root2 = createRoot(container);
	root2.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => undefined,
			currentTrack: { ...neteaseTrack("s"), provider: "qq" as const },
			onToggleLikeCurrent: () => {},
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const qqHeart = container.querySelector("#heart-btn") as HTMLButtonElement;
	expect(qqHeart.disabled).toBe(false);
	expect(qqHeart.title).not.toBe("红心喜欢");
	expect(qqHeart.title).toContain("QQ");
	root2.unmount();
	container.remove();
});

test("BottomControlsHost renders the compact upstream volume/fade popover without Playback 2.0 extras", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => undefined,
			fadeInMs: 460,
			fadeOutMs: 420,
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(container.querySelector("#volume-slider")).not.toBeNull();
	expect(container.querySelector("#fade-in-slider")).not.toBeNull();
	expect(container.querySelector("#fade-out-slider")).not.toBeNull();
	// Playback 2.0 / output routing must NOT hijack the bottom bar volume popover.
	expect(container.querySelector(".volume-panel-extras, .audio-output-section")).toBeNull();
	root.unmount();
	container.remove();
});

test("BottomControlsHost mirrors baseline bottom handle wake and auto-hide hover timing", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	const calls: string[] = [];
	const timers: Array<{ callback: () => void; delay?: number }> = [];
	const cleared: number[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(
		React.createElement(BottomControlsHost, {
			visible: false,
			onReveal: () => calls.push("reveal"),
			onHide: () => calls.push("hide"),
			deps: {
				setTimeoutRef: ((callback: () => void, delay?: number) => {
					timers.push({ callback, delay });
					return timers.length;
				}) as typeof window.setTimeout,
				clearTimeoutRef: ((id: number) => {
					cleared.push(id);
				}) as typeof window.clearTimeout,
			},
		}),
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const handle = container.querySelector("#bottom-handle") as HTMLButtonElement;
	const bar = container.querySelector("#bottom-bar") as HTMLDivElement;
	handle.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	expect(calls).toEqual(["reveal"]);
	expect(document.body.classList.contains("controls-handle-awake")).toBe(true);

	handle.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: true }));
	expect(timers.length).toBeGreaterThanOrEqual(2);
	expect(timers[timers.length - 2]?.delay).toBe(480);
	timers[timers.length - 2]?.callback();
	expect(calls).toEqual(["reveal", "hide"]);
	timers[timers.length - 1]?.callback();
	expect(document.body.classList.contains("controls-handle-awake")).toBe(false);

	bar.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	expect(document.body.classList.contains("controls-handle-awake")).toBe(true);
	expect(cleared.length).toBeGreaterThan(0);
	bar.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: true }));
	expect(timers[timers.length - 2]?.delay).toBe(480);
	timers[timers.length - 2]?.callback();
	expect(calls).toEqual(["reveal", "hide", "reveal", "hide"]);

	root.unmount();
	container.remove();
	document.body.className = "";
});

test("BottomControlsHost keeps the visible console open while the pointer is over the bar", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	flushSync(() => root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			miniQueueOpen: false,
			onReveal: () => {},
			onHide: () => {},
		}),
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	const bar = container.querySelector("#bottom-bar") as HTMLDivElement;
	expect(bar.classList.contains("visible")).toBe(true);
	expect(bar.classList.contains("soft-hidden")).toBe(false);

	bar.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
	bar.dispatchEvent(new window.Event("pointerenter", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 560));

	expect(bar.classList.contains("visible")).toBe(true);
	expect(bar.classList.contains("soft-hidden")).toBe(false);

	root.unmount();
	container.remove();
	document.body.className = "";
});

test("BottomControlsHost routes trail-detail affordances (album/song/artist) to callbacks", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		React.createElement(BottomControlsHost, {
			visible: true,
			onReveal: () => undefined,
			onTrackDetail: (kind) => calls.push(kind),
		}),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));

	(container.querySelector("#control-cover") as HTMLButtonElement).click();
	(container.querySelector("#control-title") as HTMLElement).click();
	(container.querySelector("#control-artist") as HTMLElement).click();
	expect(calls).toEqual(["album", "song", "artist"]);
	root.unmount();
	container.remove();
});