import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { SONIC_WORKSHOP_DEFAULTS } from "@mineradio/visual-engine";
import {
	normalizeVisualCoverUrl,
	resolveVisualCoverUrl,
	resolveVisualImageSource,
	resolveVisualTrackKey,
	resolveRuntimeShelfMode,
	resolveVisualShelfSettings,
	resolveVisualWallpaperSafe,
	syncRuntimeShelfModeOverride,
	syncDesktopLyricsMotionRef,
	createStageLyricsHostSuppliers,
	mapLyricPayload,
	mapShelfItemCoverSources,
	countShelfPanePlaylists,
	coverUrlToCssBackgroundImage,
	VisualEngineHost,
	type DesktopLyricsMotionSnapshot,
} from "./VisualEngineHost";

test("VisualEngineHost builds immutable runtime snapshots behind a read-only audio frame interface", async () => {
	const source = await fetch(new URL("./VisualEngineHost.tsx", import.meta.url)).then((response) => response.text());
	expect(source).toContain("audioFrameSource: AudioFrameSource");
	expect(source).not.toContain("PlayerController");
	expect(source).not.toContain("HTMLAudioElement");
	expect(source).toContain("buildPlaybackVisualSnapshot");
	expect(source).toContain("buildLyricsVisualSnapshot");
	expect(source).toContain("buildShelfVisualSnapshot");
	expect(source).toContain("buildVisualSettingsSnapshot");
	expect(source).toContain("useMemo");
	expect(source).toContain("playbackSnapshot");
	expect(source).toContain("lyricsSnapshot");
	expect(source).toContain("shelfSnapshot");
	expect(source).toContain("settingsSnapshot");
	expect(source).toContain("mediaUrl?: Pick<MediaUrlPort, \"imageSource\">");
	expect(source).not.toContain("sidecarBaseUrl");
	expect(source).not.toContain("/image-proxy");
	expect(source).not.toContain("URLSearchParams");
});

test("VisualEngineHost server-renders a visual-host placeholder div without invoking WebGL/AudioContext", () => {
	const html = renderToStaticMarkup(
		React.createElement(VisualEngineHost, {
			playbackVolume: 1,
			audioFrameSource: () => null,
			lyricsPayload: null,
			positionMs: 0,
			isPlaying: false,
		}),
	);
	expect(html).toContain('id="visual-host"');
	expect(html).toContain('id="custom-bg"');
	expect(html).toContain('id="custom-bg-video"');
	expect(html).toContain('id="album-bg"');
	expect(html).not.toContain("canvas");
});

test("VisualEngineHost gives DOM and WebGL the canonical resolved cover source", () => {
	const html = renderToStaticMarkup(
		React.createElement(VisualEngineHost, {
			playbackVolume: 1,
			audioFrameSource: () => null,
			lyricsPayload: null,
			positionMs: 0,
			isPlaying: false,
			currentCoverUrl: "https://img.example/a.jpg",
			mediaUrl: {
				imageSource: (url: string) => ({
					uri: "mineradio-image://cover/session-token/track-42",
					fallbackUri: url,
				}),
			},
		}),
	);
	expect(html).toContain('id="album-bg"');
	expect(html).toContain('class="visible"');
	// DOM background and WebGL consume the same opaque MediaUrlPort result.
	expect(html).toContain("mineradio-image://cover/session-token/track-42");
	expect(html).not.toContain("https://img.example/a.jpg");
});

test("Workshop replaces the album glow with an opaque visual host without intercepting UI", () => {
	const html = renderToStaticMarkup(
		React.createElement(VisualEngineHost, {
			playbackVolume: 1,
			audioFrameSource: () => null,
			lyricsPayload: null,
			positionMs: 0,
			isPlaying: false,
			currentCoverUrl: "https://img.example/a.jpg",
			currentTrack: {
				provider: "netease",
				id: "track-42",
				title: "音域回响",
				artists: ["CmzYa"],
				coverUrl: "https://img.example/a.jpg",
			} as never,
			fxState: {
				preset: 8,
				workshop: { ...SONIC_WORKSHOP_DEFAULTS, active: true },
			},
		}),
	);
	expect(html).toContain('id="album-bg"');
	expect(html).not.toContain('id="album-bg" class="visible"');
	expect(html).toContain('class="visual-host sonic-workshop-active"');
	expect(html).toContain('class="sonic-workshop-media-copy"');
	expect(html).toContain("音域回响");
	expect(html).toContain("CmzYa");
});

test("visual host keeps the WebGL canvas hit-testable for baseline stage drag and wheel controls", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((res) => res.text());
	expect(/#visual-host\s*\{[\s\S]*pointer-events:\s*auto;/.test(css)).toBe(true);
});

test("album background CSS matches the Electron baseline cover glow layer", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((res) => res.text());
	expect(/#custom-bg\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*0;[\s\S]*background:\s*var\(--custom-bg-color,#000\);/.test(css)).toBe(true);
	expect(/#custom-bg::before\s*\{[\s\S]*background-image:\s*var\(--custom-bg-image,none\);[\s\S]*opacity:\s*var\(--custom-bg-image-opacity,0\);/.test(css)).toBe(true);
	expect(/#visual-host\s*\{[\s\S]*z-index:\s*1;[\s\S]*background:\s*transparent;/.test(css)).toBe(true);
	expect(/#album-bg\s*\{[\s\S]*position:\s*fixed;[\s\S]*z-index:\s*0;[\s\S]*filter:\s*blur\(120px\) brightness\(0\.18\) saturate\(1\.5\);[\s\S]*transform:\s*scale\(1\.4\);[\s\S]*transition:\s*background-image 1\.5s ease, opacity 1\.5s ease;/.test(css)).toBe(true);
	expect(/#visual-host canvas\s*\{[\s\S]*z-index:\s*1;/.test(css)).toBe(true);
	expect(/#visual-host\.sonic-workshop-active\s*\{[\s\S]*background:\s*#000;/.test(css)).toBe(true);
});

test("resolveRuntimeShelfMode keeps runtime side promotion across default off rerenders", () => {
	expect(resolveRuntimeShelfMode("off", "side")).toBe("side");
	expect(resolveRuntimeShelfMode("off", null)).toBe("off");
	expect(resolveRuntimeShelfMode(undefined, "side")).toBe("side");
});

test("syncRuntimeShelfModeOverride clears runtime override when default shelf prop changes", () => {
	const previousDefaultRef = { current: "off" as string | undefined };
	const overrideRef = { current: "side" as string | null };
	syncRuntimeShelfModeOverride(previousDefaultRef, overrideRef, "off");
	expect(overrideRef.current).toBe("side");
	syncRuntimeShelfModeOverride(previousDefaultRef, overrideRef, "stage");
	expect(overrideRef.current).toBeNull();
	expect(previousDefaultRef.current).toBe("stage");
});

test("resolveVisualShelfSettings prefers explicit shelf store settings over fx defaults", () => {
	expect(resolveVisualShelfSettings(
		{ shelf: "off", shelfCameraMode: "dynamic", shelfPresence: "auto" },
		{ mode: "stage", cameraMode: "static", presence: "always", showPodcasts: false, mergeCollections: true },
	)).toEqual({
		mode: "stage",
		cameraMode: "static",
		presence: "always",
		showPodcasts: false,
		mergeCollections: true,
	});
	expect(resolveVisualShelfSettings({ shelf: "off" }, null)).toEqual({
		mode: "off",
		cameraMode: "dynamic",
		presence: "always",
		showPodcasts: true,
		mergeCollections: false,
	});
});

test("resolveVisualWallpaperSafe follows runtime fx preset ahead of defaults", () => {
	expect(resolveVisualWallpaperSafe({ preset: 0 }, { preset: 5 })).toBe(true);
	expect(resolveVisualWallpaperSafe({ preset: 5 }, { preset: 6 })).toBe(false);
});

test("countShelfPanePlaylists follows baseline mine and favorite split", () => {
	expect(countShelfPanePlaylists([
		{ subscribed: false },
		{ subscribed: true },
		{},
	] as never)).toEqual({ mineCount: 2, favCount: 1 });
});

test("resolveVisualCoverUrl prefers explicit currentCoverUrl and falls back to currentTrack.coverUrl", () => {
	expect(resolveVisualCoverUrl("override.jpg", { coverUrl: "track.jpg" } as never)).toBe("override.jpg");
	expect(resolveVisualCoverUrl(undefined, { coverUrl: "track.jpg" } as never)).toBe("track.jpg");
	expect(resolveVisualCoverUrl(null, null)).toBe("");
});

test("resolveVisualTrackKey uses the frozen provider and id identity", () => {
	expect(resolveVisualTrackKey({ provider: "netease", id: "42" } as never)).toBe("netease:42");
	expect(resolveVisualTrackKey(null)).toBe("");
});

test("coverUrlToCssBackgroundImage preserves quoted baseline url syntax safely", () => {
	expect(coverUrlToCssBackgroundImage("https://img.example/a.jpg")).toBe('url("https://img.example/a.jpg")');
	expect(coverUrlToCssBackgroundImage('https://img.example/a"b.jpg')).toBe('url("https://img.example/a\\"b.jpg")');
	expect(coverUrlToCssBackgroundImage("")).toBe(undefined);
});

test("resolveVisualImageSource delegates normalized covers to the media URL port without inspecting the URI", () => {
	const calls: string[] = [];
	const mediaUrl = {
		imageSource(url: string) {
			calls.push(url);
			return {
				uri: "mineradio-image://cover/session-token/track-42",
				fallbackUri: url,
			};
		},
	};

	expect(resolveVisualImageSource("//p3.music.126.net/cover.jpg", mediaUrl)).toEqual({
		uri: "mineradio-image://cover/session-token/track-42",
		logicalSource: "https://p3.music.126.net/cover.jpg",
	});
	expect(calls).toEqual(["https://p3.music.126.net/cover.jpg"]);
});

test("normalizeVisualCoverUrl keeps baseline protocol-relative provider covers usable for WebGL", () => {
	expect(normalizeVisualCoverUrl("//p4.music.126.net/a.jpg")).toBe("https://p4.music.126.net/a.jpg");
	expect(normalizeVisualCoverUrl(" https://img.example/a.jpg ")).toBe("https://img.example/a.jpg");
	expect(normalizeVisualCoverUrl("")).toBe("");
});

test("mapLyricPayload preserves native karaoke timing for stage lyrics", () => {
	const lines = mapLyricPayload({
		provider: "netease",
		trackId: "42",
		hasTranslation: false,
		isWordByWord: true,
		lines: [
			{
				timeMs: 1000,
				durationMs: 2000,
				text: "你好",
				charCount: 2,
				words: [
					{ text: "你", timeMs: 1000, durationMs: 500, c0: 0, c1: 1 },
					{ text: "好", timeMs: 1500, durationMs: 500, c0: 1, c1: 2 },
				],
			},
		],
	});

	expect(lines).toEqual([
		{
			t: 1,
			duration: 2,
			text: "你好",
			charCount: 2,
			words: [
				{ text: "你", t: 1, d: 0.5, c0: 0, c1: 1 },
				{ text: "好", t: 1.5, d: 0.5, c0: 1, c1: 2 },
			],
		},
	]);
});

test("mapLyricPayload preserves translation for the visual-engine contract", () => {
	const lines = mapLyricPayload({
		provider: "netease",
		trackId: "42",
		hasTranslation: true,
		isWordByWord: false,
		lines: [
			{
				timeMs: 1000,
				text: "你好",
				translation: "Hello",
			},
		],
	});

	expect(lines.length).toBe(1);
	expect(lines[0]?.translation).toBe("Hello");
});

test("mapLyricPayload sorts stage lyrics and native words like the Electron baseline parser", () => {
	const lines = mapLyricPayload({
		provider: "netease",
		trackId: "42",
		hasTranslation: false,
		isWordByWord: true,
		lines: [
			{
				timeMs: 2000,
				text: "C",
				words: [{ text: "later", timeMs: 2200, c0: 0, c1: 1 }],
			},
			{
				timeMs: 0,
				text: "A",
				words: [
					{ text: "second", timeMs: 500, c0: 1, c1: 2 },
					{ text: "first", timeMs: 0, c0: 0, c1: 1 },
				],
			},
			{ timeMs: 1000, text: "B" },
		],
	});

	expect(lines.map((line) => line.text)).toEqual(["A", "B", "C"]);
	expect(lines[0].words?.map((word) => word.text)).toEqual(["first", "second"]);
});

test("mapShelfItemCoverSources resolves shelf textures through the media URL port", () => {
	const mediaUrl = {
		imageSource: (url: string) => ({ uri: url.startsWith("data:") ? url : `mineradio-image://cover/${encodeURIComponent(url)}` }),
	};
	expect(mapShelfItemCoverSources([
		{ type: "playlist", title: "A", cover: "https://img.example/a.jpg" },
		{ type: "queue", title: "B", cover: "data:image/png;base64,abc" },
		{ type: "queue", title: "C" },
	], mediaUrl)).toEqual([
		{ type: "playlist", title: "A", cover: "mineradio-image://cover/https%3A%2F%2Fimg.example%2Fa.jpg" },
		{ type: "queue", title: "B", cover: "data:image/png;base64,abc" },
		{ type: "queue", title: "C" },
	]);
});

test("syncDesktopLyricsMotionRef copies lifecycle motion snapshot into a mutable ref", () => {
	const target = {
		current: {
			highBloom: 0,
			beatGlow: 0,
			beatPulse: 0,
			bass: 0,
		} satisfies DesktopLyricsMotionSnapshot,
	};
	const lifecycle = {
		getMotionSnapshot: () => ({
			highBloom: 0.42,
			beatGlow: 0.73,
			beatPulse: 1.1,
			bass: 0.64,
		}),
	};

	syncDesktopLyricsMotionRef(target, lifecycle);

	expect(target.current).toEqual({
		highBloom: 0.42,
		beatGlow: 0.73,
		beatPulse: 1.1,
		bass: 0.64,
	});
});

test("createStageLyricsHostSuppliers bridges baseline duration, fallback, particles and native karaoke flags", () => {
	const suppliers = createStageLyricsHostSuppliers({
		durationMsRef: { current: 210000 },
		fallbackTextRef: { current: "Song A - Artist" },
		lyricsHasNativeKaraokeRef: { current: true },
		fxDefaults: { particleLyrics: true, lyricGlowParticles: false },
		fxRef: { current: { particleLyrics: false, lyricGlowParticles: true } },
	});

	expect(suppliers.audioDurationSupplier()).toBe(210);
	expect(suppliers.fallbackTextSupplier()).toBe("Song A - Artist");
	expect(suppliers.particleLyricsFlagSupplier()).toBe(false);
	expect(suppliers.lyricGlowParticlesSupplier()).toBe(true);
	expect(suppliers.lyricsHasNativeKaraokeSupplier()).toBe(true);
});
