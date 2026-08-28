import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
	App,
	applyDesktopWindowShellState,
	buildDesktopLyricsPayloadPatch,
	desktopLyricsBeatMapKey,
	isCollectSupportedTrack,
	isHomeBlankDismissElement,
	isNeteaseLikeSupported,
	mergeProviderPlaylists,
	shouldUseSecondaryLeftDisplaySeamGuard,
	shouldShowEmptyHome,
	shouldUseCachedHomeDiscoverPlaylist,
} from "./App";
import type { SplashHostProps } from "../visual/SplashHost";
import type { RuntimeConfig } from "../tauri/runtime";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useSearchStore } from "../stores/search-store";
import { useShelfStore } from "../stores/shelf-store";
import { useVisualStore } from "../stores/visual-store";
import { CUSTOM_LYRIC_PREF_STORE_KEY, CUSTOM_LYRIC_STORE_KEY } from "../lyrics/custom-lyrics";
import { SidecarClientError, type SidecarClient } from "../api/sidecar-client";
import { createLegacyApplicationRuntime } from "../adapters/sidecar/legacy-application-runtime";
import type { ApplicationRuntimePort } from "../ports/application-runtime-port";
import type { VisualEngineHostProps } from "../visual/VisualEngineHost";
import { cloneFxState } from "@mineradio/visual-engine";
import type { DiscoverHomeResponse, LyricPayload, Track } from "@mineradio/shared";
import type { UpdateRuntimePort, UpdateSnapshot } from "../ports/update-runtime-port";
import { createUpdateExperienceController } from "../features/updater/update-experience-controller";

const APP_UPDATE_SNAPSHOT: UpdateSnapshot = Object.freeze({
	revision: 0,
	phase: "disabled",
	currentVersion: "0.0.0-test",
	candidate: null,
	operation: null,
	fault: null,
	checkedAt: null,
	remindAfter: null,
	skippedVersion: null,
});

const APP_UPDATE_RUNTIME: UpdateRuntimePort = {
	getSnapshot: () => APP_UPDATE_SNAPSHOT,
	subscribe: () => () => {},
	dispatch: async () => "runtime-unavailable",
};

const APP_UPDATE_CONTROLLER = createUpdateExperienceController(APP_UPDATE_RUNTIME);

test("web index preloads the baseline simple or DIY mode class before React mounts", async () => {
	const html = await fetch(new URL("../../index.html", import.meta.url)).then((response) => response.text());
	expect(html).toContain("mineradio-diy-player-mode-v1");
	expect(html).toContain("diy-mode-preload");
	expect(html).toContain("simple-mode-preload");
});

test("mergeProviderPlaylists replaces only the refreshed provider playlists", () => {
	const merged = mergeProviderPlaylists([
		{ provider: "netease", id: "ne-old", name: "旧网易歌单", coverUrl: "", trackCount: 1, trackIds: [], subscribed: false },
		{ provider: "qq", id: "qq-old", name: "旧QQ歌单", coverUrl: "", trackCount: 2, trackIds: [], subscribed: false },
		{ provider: "soda", id: "soda-old", name: "旧汽水歌单", coverUrl: "", trackCount: 3, trackIds: [], subscribed: false },
	], "qq", [
		{ provider: "qq", id: "qq-new", name: "新QQ歌单", coverUrl: "", trackCount: 4, trackIds: [], subscribed: false },
		{ provider: "netease", id: "ne-noise", name: "错误供应商噪声", coverUrl: "", trackCount: 5, trackIds: [], subscribed: false },
		{ provider: "qq", id: "qq-new", name: "重复QQ歌单", coverUrl: "", trackCount: 4, trackIds: [], subscribed: false },
	]);

	expect(merged.map((playlist) => `${playlist.provider}:${playlist.id}`)).toEqual([
		"netease:ne-old",
		"soda:soda-old",
		"qq:qq-new",
	]);
});

test("shouldUseCachedHomeDiscoverPlaylist refreshes stale logged-out discover after provider login", () => {
	const loggedOutWithPublicPlaylists: DiscoverHomeResponse = {
		loggedIn: false,
		user: null,
		mode: "starter",
		dailySongs: [],
		playlists: [{ provider: "netease" as const, id: "pub-1", name: "公开推荐", coverUrl: "", trackCount: 12, trackIds: [], subscribed: false }],
		podcasts: [],
		updatedAt: 1,
	};
	const loggedInDiscover: DiscoverHomeResponse = {
		...loggedOutWithPublicPlaylists,
		loggedIn: true,
		user: { provider: "qq" as const, userId: "q1", nickname: "QQ User", avatarUrl: "" },
		mode: "member",
	};

	expect(shouldUseCachedHomeDiscoverPlaylist(loggedOutWithPublicPlaylists, false)).toBe(true);
	expect(shouldUseCachedHomeDiscoverPlaylist(loggedOutWithPublicPlaylists, true)).toBe(false);
	expect(shouldUseCachedHomeDiscoverPlaylist(loggedInDiscover, true)).toBe(true);
});

test("App mounts the baseline guide particle canvas host", async () => {
	const source = await fetch(new URL("../features/visual/VisualSurface.tsx", import.meta.url)).then((response) => response.text());
	expect(source).toContain("GuideParticlesHost");
});

class AppStubAudioElement extends EventTarget {
	currentTime = 0;
	duration = Number.NaN;
	src = "";
	volume = 1;
	preload = "";
	loadCalled = 0;
	playCalled = 0;
	pauseCalled = 0;
	error: MediaError | null = null;
	load(): void {
		this.loadCalled += 1;
	}
	async play(): Promise<void> {
		this.playCalled += 1;
		this.dispatchEvent(new Event("play"));
	}
	pause(): void {
		this.pauseCalled += 1;
		this.dispatchEvent(new Event("pause"));
	}
}

const appStubAudioInstances: AppStubAudioElement[] = [];

function installAppStubAudio(): () => void {
	const previousWindowAudio = (window as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalAudio = "Audio" in globalThis;
	const previousGlobalAudio = (globalThis as unknown as { Audio?: typeof Audio }).Audio;
	const hadGlobalHtmlAudioElement = "HTMLAudioElement" in globalThis;
	const previousGlobalHtmlAudioElement = (globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement;
	const TrackingAudio = class extends AppStubAudioElement {
		constructor() {
			super();
			appStubAudioInstances.push(this);
		}
	} as unknown as typeof Audio;
	appStubAudioInstances.length = 0;
	(window as unknown as { Audio?: typeof Audio }).Audio = TrackingAudio;
	(globalThis as unknown as { Audio?: typeof Audio }).Audio = TrackingAudio;
	(globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement = AppStubAudioElement as unknown as typeof HTMLAudioElement;
	return () => {
		appStubAudioInstances.length = 0;
		(window as unknown as { Audio?: typeof Audio }).Audio = previousWindowAudio;
		if (hadGlobalAudio) {
			(globalThis as unknown as { Audio?: typeof Audio }).Audio = previousGlobalAudio;
		} else {
			delete (globalThis as unknown as { Audio?: typeof Audio }).Audio;
		}
		if (hadGlobalHtmlAudioElement) {
			(globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement = previousGlobalHtmlAudioElement;
		} else {
			delete (globalThis as unknown as { HTMLAudioElement?: typeof HTMLAudioElement }).HTMLAudioElement;
		}
	};
}

function playbackSidecarClientStubs() {
	return {
		async resolveSongUrl(track: Track) {
			return { url: `https://example.com/${track.id}.mp3`, quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric(track: Track) {
			return {
				provider: track.provider,
				trackId: track.id,
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	};
}

function legacyRuntimeForTest(
	config: RuntimeConfig,
	client?: SidecarClient,
): ApplicationRuntimePort {
	return createLegacyApplicationRuntime({
		initialRuntimeConfig: config,
		...(client ? { createClient: () => client } : {}),
	});
}

test("App keeps the empty-home music page mounted behind the splash gate", () => {
	const html = renderToStaticMarkup(React.createElement(App, {
		updateController: APP_UPDATE_CONTROLLER,
	}));
	const visualGuideButtonCount = html.match(/id="visual-guide-btn"/g)?.length ?? 0;
	expect(html).toContain('id="desktop-window-shell"');
	expect(html).toContain('id="desktop-titlebar"');
	expect(html).toContain('class="desktop-window-controls"');
	expect(html).toContain('id="diy-mode-btn"');
	expect(html).toContain('class="desktop-window-btn close"');
	expect(html).toContain('class="visual-splash-root"');
	expect(html).toContain('id="visual-host"');
	expect(html).toContain('id="empty-home"');
	expect(html).toContain('id="search-area"');
	expect(html).toContain('id="top-right"');
	expect(visualGuideButtonCount).toBe(1);
	expect(html).toContain('id="visual-guide"');
	expect(html).toContain('id="fx-fab"');
	expect(html).toContain('id="fx-panel"');
	expect(html).toContain('id="bottom-handle"');
	expect(html).toContain('id="bottom-bar"');
	expect(html).toContain('id="user-btn"');
	expect(html).toContain('class="home-hero-inner daily-review-card"');
	expect(html).toContain("换一条");
	expect(html).toContain("选择 MP4");
	expect(html).not.toContain("🚧此处施工，敬请期待🚧");
	expect(html).not.toContain('id="home-weather-kicker"');
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain("每日推荐");
});

test("App keeps hidden wallpaper capability placeholder copy out of the product shell", () => {
	const html = renderToStaticMarkup(React.createElement(App, {
		updateController: APP_UPDATE_CONTROLLER,
	}));
	expect(html).not.toContain("壁纸模式开发中");
	expect(html).not.toContain('id="t-wallpaperMode"');
});

test("App provider mutation guards reject import-only tracks", () => {
	const importedById: Track = {
		provider: "netease",
		id: "import:apple-music:1",
		sourceId: "import:apple-music:1",
		title: "Imported Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "unknown",
	};
	const importedBySource: Track = {
		...importedById,
		id: "apple-shadow-1",
		sourceId: "import:apple-music:1",
	};
	const neteaseTrack: Track = {
		...importedById,
		id: "song-1",
		sourceId: "song-1",
		playableState: "playable",
	};
	const qqTrack: Track = {
		...neteaseTrack,
		provider: "qq",
		id: "qq-song-1",
		sourceId: "qq-song-1",
	};

	expect(isNeteaseLikeSupported(importedById)).toBe(false);
	expect(isNeteaseLikeSupported(importedBySource)).toBe(false);
	expect(isCollectSupportedTrack(importedById)).toBe(false);
	expect(isCollectSupportedTrack(importedBySource)).toBe(false);
	expect(isNeteaseLikeSupported(neteaseTrack)).toBe(true);
	expect(isCollectSupportedTrack(neteaseTrack)).toBe(true);
	expect(isCollectSupportedTrack(qqTrack)).toBe(true);
});

test("compatibility client startup uses native invoke without HTTP health polling", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const previousFetch = globalThis.fetch;
	const seen: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		seen.push(url);
		throw new Error(`生产启动不应发起 HTTP 请求: ${url}`);
	}) as typeof fetch;

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig)} />));
		for (let i = 0; i < 8; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(seen).toEqual([]);
	} finally {
		root.unmount();
		host.remove();
		globalThis.fetch = previousFetch;
		useSearchStore.getState().reset();
	}
}, 15_000);

test("DIY desktop lyrics toggle drives the desktop lyrics window lifecycle", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const restoreAudio = installAppStubAudio();
	const calls: string[] = [];
	const runtimeConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const resetVisualStore = () => {
		const fx = cloneFxState();
		useVisualStore.setState({
			fx,
			preset: fx.preset,
			intensity: fx.intensity,
			custom: {},
		});
	};
	try {
		resetVisualStore();
		flushSync(() => root.render(
			<App updateController={APP_UPDATE_CONTROLLER}
				SplashComponent={() => null}
				VisualComponent={() => <div id="visual-host" />}
				applicationRuntime={legacyRuntimeForTest(runtimeConfig)}
				desktopLyricsRuntime={{
					showWindow: async () => { calls.push("show"); },
					closeWindow: async () => { calls.push("close"); },
					updatePayload: async (payload) => {
						calls.push(`payload:${String((payload as { enabled?: unknown }).enabled)}`);
					},
				}}
			/>,
		));
		await new Promise((resolve) => setTimeout(resolve, 0));

		(host.querySelector("#fx-fab") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		(host.querySelector("#t-desktopLyrics") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["payload:true", "show"]);

		(host.querySelector("#t-desktopLyrics") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["payload:true", "show", "close"]);
	} finally {
		root.unmount();
		host.remove();
		restoreAudio();
		resetVisualStore();
	}
});

test("desktop shell CSS keeps the rounded shell transparent while album and WebGL layers mirror baseline", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());
	expect(/body\.desktop-shell #desktop-window-shell\s*{[\s\S]*border-radius: 34px;[\s\S]*clip-path: inset\(0 round 34px\);[\s\S]*background: transparent;/.test(css)).toBe(true);
	expect(/#visual-host\s*{[\s\S]*background: transparent;/.test(css)).toBe(true);
	expect(/#album-bg\s*{[\s\S]*filter: blur\(120px\) brightness\(0\.18\) saturate\(1\.5\);/.test(css)).toBe(true);
	expect(css).not.toContain("clip-path: inset(0 round 18px);");
});

test("Home shell CSS includes the baseline stable panel glass final overrides", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());
	expect(css).toContain("--home-accent-rgb: 0, 245, 212;");
	expect(css).toContain(".home-card[data-home-tone],\n.home-tile[data-home-tone]");
	expect(css).toContain("--tone-a: var(--home-accent);");
	expect(css).toContain("conic-gradient(from 210deg, var(--home-accent)");
	expect(css).toContain("--panel-glass-filter: blur(22px) saturate(1.22) brightness(1.04);");
	expect(css).toContain("background: var(--panel-glass-bg) !important;");
	expect(css).toContain("html.control-glass-svg-ok .home-hero");
	expect(css).toContain("backdrop-filter: blur(22px) saturate(1.16) !important;");
	expect(css).toContain("background: rgba(0, 0, 0, .72) !important;");
});

test("player console CSS hides advanced controls from the main bar", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());
	expect(css).toContain("body.simple-mode #bottom-bar");
	expect(css).toContain("body.simple-mode #search-mode-tabs");
	expect(css).toContain("body.simple-mode #upload-actions");
	expect(css).toContain("body.simple-mode #fx-fab");
	expect(css).toContain(".console-lyric-source-row,\n.console-shelf-controls,\n.console-host-chrome");
	expect(css).toContain("display: none !important;");
	expect(css).toContain("#quality-btn.quality-pill");
	expect(css).toContain("background: rgba(0, 0, 0, .10);");
	expect(css).toContain("html.control-glass-svg-ok #play-btn");
});

test("Search shell CSS uses transparent control glass for compact results", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());
	expect(css).toContain("/* 搜索下拉结果：补回播放器控制台式透明玻璃。 */");
	expect(css).toContain("#search-results.show");
	expect(css).toContain("linear-gradient(145deg, rgba(255, 255, 255, .052), rgba(6, 8, 12, .24) 48%, rgba(0, 0, 0, .14)) !important;");
	expect(css).toContain(".search-shell-action.song-action-btn,\n.search-shell-action.add-btn");
	expect(css).toContain("background: rgba(255, 255, 255, .052) !important;");
	expect(css).toContain("html.control-glass-svg-ok #search-results.show");
	expect(css).toContain("url(#mineradio-control-glass-filter) saturate(1) !important");
});

test("Search detail CSS includes the full-screen glass result surface", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());
	expect(css).toContain("[data-search-detail]");
	expect(css).toContain(".search-detail-track");
	expect(css).toContain(".search-detail-action");
	expect(css).toContain("@keyframes search-detail-stage-expand");
	expect(css).toContain("@keyframes search-detail-panel-expand");
	expect(css).toContain("animation: search-detail-stage-expand");
	expect(css).toContain("transform-origin: top center;");
	expect(css).toContain("@media (prefers-reduced-motion: reduce)");
	expect(css).toContain("grid-template-columns: 52px minmax(0, 1.30fr) minmax(152px, .56fr) 188px;");
	expect(css).toContain(".search-detail-track:hover .search-detail-actions");
	expect(css).toContain("opacity: .72;");
	expect(css).toContain("scrollbar-width: none;");
	expect(css).toContain("-ms-overflow-style: none;");
	expect(css).toContain("#search-results::-webkit-scrollbar");
	expect(css).toContain(".search-detail-list::-webkit-scrollbar");
	expect(css).toContain("width: 0;");
	expect(css).toContain("body.search-detail-open #search-area");
	expect(css).toContain("body.search-detail-open #empty-home");
	expect(css).toContain("opacity: .12 !important;");
	expect(css).toContain("pointer-events: none !important;");
	expect(css).toContain(".search-detail-page::before");
	expect(css).toContain("isolation: isolate;");
	expect(css).toContain("linear-gradient(145deg, rgba(255, 255, 255, .055), rgba(7, 9, 13, .22) 46%, rgba(0, 0, 0, .12));");
	expect(css).toContain("backdrop-filter: blur(18px) saturate(1.8) brightness(1.16);");
	expect(css).toContain("inset 0 0 2px 1px rgba(255, 255, 255, .30)");
});

test("App opens Search detail from the compact search Enter action", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useSearchStore.getState().reset();
	useSearchStore.setState({ keyword: "晴天", mode: "song", detailOpen: false });

	const fakeClient = {
		async searchAll() {
			return [{
				provider: "netease",
				id: "song-1",
				sourceId: "song-1",
				title: "晴天",
				artists: ["周杰伦"],
				album: "叶惠美",
				coverUrl: "",
				durationMs: 269000,
				qualityHints: [],
				playableState: "playable",
			} satisfies Track];
		},
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return { ok: true, weather: null, radio: { title: "天气电台", subtitle: "", seedQueries: [], updatedAt: 1, songs: [] } };
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const input = host.querySelector<HTMLInputElement>("#search-input");
		expect(input).not.toBeNull();
		input!.focus();
		input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

		for (let i = 0; i < 16 && !host.querySelector("[data-search-detail]"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(host.querySelector("[data-search-detail]")).not.toBeNull();
		expect(host.querySelector("[data-search-detail]")?.textContent).toContain("晴天");
		expect(document.body.classList.contains("search-detail-open")).toBe(true);
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useSearchStore.getState().reset();
		localStorage.clear();
	}
});

test("App Search detail append action queues a song without starting playback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useSearchStore.getState().reset();
	useSearchStore.setState({ keyword: "晴天", mode: "song", detailOpen: false });

	const fakeClient = {
		async searchAll() {
			return [{
				provider: "netease",
				id: "song-1",
				sourceId: "song-1",
				title: "晴天",
				artists: ["周杰伦"],
				album: "叶惠美",
				coverUrl: "",
				durationMs: 269000,
				qualityHints: [],
				playableState: "playable",
			} satisfies Track];
		},
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return { ok: true, weather: null, radio: { title: "天气电台", subtitle: "", seedQueries: [], updatedAt: 1, songs: [] } };
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const input = host.querySelector<HTMLInputElement>("#search-input");
		expect(input).not.toBeNull();
		input!.focus();
		input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

		for (let i = 0; i < 16 && !host.querySelector("[data-search-detail-append]"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		host.querySelector<HTMLButtonElement>("[data-search-detail-append]")?.click();

		expect(usePlaybackStore.getState().queue.map((track) => track.id)).toContain("song-1");
		expect(usePlaybackStore.getState().currentTrack).toBeNull();
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useSearchStore.getState().reset();
		localStorage.clear();
	}
});

test("App unmounts SplashHost after splash dismissed instead of leaving hidden splash listeners alive", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const host = document.createElement("div");
	document.body.appendChild(host);
	let dismissed: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissed = () => props.onDismissed?.();
		return <div className="visual-splash-root" data-testid="splash" />;
	}
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={MockSplash} />));
	expect(host.querySelector(".visual-splash-root")).not.toBeNull();
	flushSync(() => dismissed?.());
	expect(host.querySelector(".visual-splash-root")).toBeNull();
	root.unmount();
	host.remove();
});

test("App mirrors baseline top account capsule auto-hide preference and peek hot-zone", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	document.body.className = "";
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} />));
		const toggle = host.querySelector("#user-capsule-hide-btn") as HTMLButtonElement;
		expect(toggle.textContent).toBe("‹");

		toggle.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(localStorage.getItem("mineradio-user-capsule-auto-hide-v1")).toBe("1");
		expect(document.body.classList.contains("user-capsule-auto-hide")).toBe(true);
		expect(toggle.textContent).toBe("›");
		expect(toggle.title).toBe("取消自动隐藏账号胶囊");

		const pointerMove = new Event("mousemove") as Event & { clientX: number; clientY: number };
		Object.defineProperty(pointerMove, "clientX", { value: window.innerWidth - 12 });
		Object.defineProperty(pointerMove, "clientY", { value: 30 });
		flushSync(() => window.dispatchEvent(pointerMove));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.body.classList.contains("user-capsule-peek")).toBe(true);

		toggle.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(localStorage.getItem("mineradio-user-capsule-auto-hide-v1")).toBe("0");
		expect(document.body.classList.contains("user-capsule-auto-hide")).toBe(false);
	} finally {
		root.unmount();
		host.remove();
		document.body.className = "";
		localStorage.clear();
	}
});

test("App restores persisted Netease login state on startup", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async health() {
			return {
				ok: true,
				appVersion: "0.0.0-test",
				apiVersion: "0.1.0",
				schemaVersion: "0.1.0",
				providers: [],
			};
		},
		async capabilities() {
			return { version: "0.1.0", providers: [] };
		},
		async loginStatus(provider: string) {
			if (provider === "netease") {
				return {
					provider,
					loggedIn: true,
					nickname: "大大绫波丽",
					avatarUrl: "https://p4.music.126.net/avatar.jpg",
					userId: "1440597970",
					vipLevel: "svip",
					vipLabel: "黑胶SVIP·陆",
					vipIcon: "netease-svip",
					vipIconUrl: "https://p1.music.126.net/vip.png",
					vipTier: 6,
					vipLevelName: "陆",
				};
			}
			return { provider, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
					label: "晴",
					weatherCode: 0,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 60,
					precipitation: 0,
					cloudCover: 10,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: { key: "clear", title: "晴天电台", tagline: "把光留给旋律", energy: 0.58, warmth: 0.62, focus: 0.54, melancholy: 0.24, keywords: ["晴天"] },
				},
				radio: {
					title: "晴天电台",
					subtitle: "把光留给旋律",
					seedQueries: ["晴天"],
					updatedAt: 1,
					songs: [],
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		for (let i = 0; i < 16 && !host.querySelector("#user-avatar"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(host.querySelector("#user-avatar")?.getAttribute("src")).toBe("https://p4.music.126.net/avatar.jpg");
		expect(host.querySelector("#user-vip-tag")?.textContent).toBe("");
		expect(host.querySelector("#user-vip-tag")?.getAttribute("title")).toBe("黑胶SVIP·陆");
		expect(host.querySelector("#user-vip-tag")?.classList.contains("official-icon-only")).toBe(true);
		expect(host.querySelector("#user-vip-tag")?.classList.contains("netease-svip")).toBe(true);
		expect(host.querySelector("#user-vip-tag img")?.getAttribute("src")).toBe("https://p1.music.126.net/vip.png");
		expect(host.querySelector("#user-btn")?.textContent).toContain("大大绫波丽");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("App shows Netease avatar and VIP badge in the top account capsule", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async health() {
			return {
				ok: true,
				appVersion: "0.0.0-test",
				apiVersion: "0.1.0",
				schemaVersion: "0.1.0",
				providers: [],
			};
		},
		async capabilities() {
			return { version: "0.1.0", providers: [] };
		},
		async loginStatus(provider: string) {
			if (provider === "netease") {
				return {
					provider,
					loggedIn: true,
					nickname: "大大绫波丽",
					avatarUrl: "https://p4.music.126.net/avatar.jpg",
					userId: "1440597970",
					vipLevel: "svip",
					vipLabel: "黑胶SVIP·陆",
					vipIcon: "netease-svip",
					vipIconUrl: "https://p1.music.126.net/vip.png",
					vipTier: 6,
					vipLevelName: "陆",
				};
			}
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey(provider: string) {
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			return { provider, key, code: 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		(host.querySelector("#user-btn") as HTMLButtonElement).click();
		for (let i = 0; i < 12 && !host.querySelector("#user-avatar"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(host.querySelector("#user-avatar")?.getAttribute("src")).toBe("https://p4.music.126.net/avatar.jpg");
		expect(host.querySelector("#user-vip-tag")?.textContent).toBe("");
		expect(host.querySelector("#user-vip-tag")?.getAttribute("title")).toBe("黑胶SVIP·陆");
		expect(host.querySelector("#user-vip-tag")?.classList.contains("official-icon-only")).toBe(true);
		expect(host.querySelector("#user-vip-tag")?.classList.contains("netease-svip")).toBe(true);
		expect(host.querySelector("#user-vip-tag img")?.getAttribute("src")).toBe("https://p1.music.126.net/vip.png");
		expect(host.querySelector("#user-btn")?.textContent).toContain("大大绫波丽");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("Home blank dismiss accepts only empty Home surfaces", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.innerHTML = `
		<section id="empty-home">
			<div class="empty-home-shell" id="blank"></div>
			<button class="home-card" id="card">card</button>
			<input id="search-input" />
			<div class="home-recommendation-media" id="rec-media"></div>
			<div class="home-recommendation-card-track" id="rec-track"></div>
			<div class="home-recommendation-card-netease-mixed" id="rec-mixed"></div>
			<div class="home-detail-track" id="detail-track"></div>
			<div id="bottom-handle"></div>
			<div id="fx-panel"></div>
			<div id="playlist-panel"></div>
			<div id="mini-queue-popover"></div>
			<div id="visual-guide"></div>
			<div id="toast"></div>
		</section>
	`;
	expect(isHomeBlankDismissElement(document.getElementById("blank"))).toBe(true);
	expect(isHomeBlankDismissElement(document.getElementById("card"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("search-input"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("rec-media"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("rec-track"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("rec-mixed"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("detail-track"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("bottom-handle"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("fx-panel"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("playlist-panel"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("mini-queue-popover"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("visual-guide"))).toBe(false);
	expect(isHomeBlankDismissElement(document.getElementById("toast"))).toBe(false);
});

test("Home console chip follows baseline openHomePlayerConsole unlock and reveal path", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	usePlaybackStore.getState().clearQueue();

	let dismissSplash: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissSplash = () => props.onDismissed?.();
		return <div className="visual-splash-root" />;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={MockSplash} VisualComponent={() => <div id="visual-host" />} />));
		flushSync(() => dismissSplash?.());
		await new Promise((resolve) => setTimeout(resolve, 0));

		const homeButton = document.querySelector("#home-btn") as HTMLButtonElement;
		homeButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		homeButton.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.body.classList.contains("home-controls-locked")).toBe(true);

		(host.querySelector(".home-console-chip") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const bar = host.querySelector("#bottom-bar") as HTMLDivElement;
		expect(document.body.classList.contains("home-controls-locked")).toBe(false);
		expect(document.body.classList.contains("controls-visible")).toBe(true);
		expect(bar.classList.contains("visible")).toBe(true);
		expect(bar.classList.contains("soft-hidden")).toBe(false);
		expect(host.querySelector("#toast")?.textContent).toContain("播放器控制台已展开");
	} finally {
		root.unmount();
		host.remove();
		document.body.className = "";
	}
});

test("shouldShowEmptyHome follows baseline force/suppress/playback gates", () => {
	const base = {
		splashActive: false,
		homeForcedOpen: false,
		homeSuppressed: false,
		hasCurrentTrack: false,
		queueLength: 0,
		isPlaying: false,
	};
	expect(shouldShowEmptyHome(base)).toBe(true);
	expect(shouldShowEmptyHome({ ...base, splashActive: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, homeSuppressed: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, hasCurrentTrack: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, queueLength: 1 })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, isPlaying: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, immersiveActive: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, shelfDetailOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, shelfPinnedOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, shelfStageOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, splashActive: true, homeForcedOpen: true })).toBe(false);
	expect(shouldShowEmptyHome({ ...base, hasCurrentTrack: true, homeForcedOpen: true })).toBe(true);
});

test("App suppresses baseline Home while shelf is pinned and the Home button restores the Home pane", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	usePlaybackStore.getState().clearQueue();
	useShelfStore.setState({
		mode: "side",
		cameraMode: "static",
		presence: "always",
		showPodcasts: true,
		mergeCollections: false,
		open: true,
		selectedPlaylistId: "playlist-1",
	});

	let dismissSplash: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissSplash = () => props.onDismissed?.();
		return <div className="visual-splash-root" />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={MockSplash} VisualComponent={() => <div id="visual-host" />} />));
		flushSync(() => dismissSplash?.());
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(useShelfStore.getState().open).toBe(true);
		expect(document.body.classList.contains("empty-home-active")).toBe(false);

		(host.querySelector("#home-btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(useShelfStore.getState().open).toBe(false);
		expect(useShelfStore.getState().selectedPlaylistId).toBeNull();
		expect(document.body.classList.contains("empty-home-active")).toBe(true);
	} finally {
		root.unmount();
		host.remove();
		document.body.className = "";
		usePlaybackStore.getState().clearQueue();
		useShelfStore.setState({
			mode: "side",
			cameraMode: "static",
			presence: "always",
			showPodcasts: true,
			mergeCollections: false,
			open: false,
			selectedPlaylistId: null,
		});
	}
});

test("App suppresses baseline Home while visual shelf detail content is open", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.body.className = "";
	usePlaybackStore.getState().clearQueue();
	useShelfStore.setState({ open: false, selectedPlaylistId: null });

	let dismissSplash: (() => void) | null = null;
	let setShelfContentOpen: ((open: boolean) => void) | undefined;
	function MockSplash(props: SplashHostProps) {
		dismissSplash = () => props.onDismissed?.();
		return <div className="visual-splash-root" />;
	}
	function MockVisual(props: VisualEngineHostProps & { onShelfOpenContentChange?: (open: boolean) => void }) {
		setShelfContentOpen = props.onShelfOpenContentChange;
		return <div id="visual-host" />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={MockSplash} VisualComponent={MockVisual} />));
		flushSync(() => dismissSplash?.());
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(document.body.classList.contains("empty-home-active")).toBe(true);
		expect(typeof setShelfContentOpen).toBe("function");

		flushSync(() => setShelfContentOpen?.(true));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.body.classList.contains("empty-home-active")).toBe(false);

		flushSync(() => setShelfContentOpen?.(false));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.body.classList.contains("empty-home-active")).toBe(true);
	} finally {
		root.unmount();
		host.remove();
		document.body.className = "";
		usePlaybackStore.getState().clearQueue();
		useShelfStore.setState({ open: false, selectedPlaylistId: null });
	}
});

test("applyDesktopWindowShellState mirrors baseline desktop shell classes", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	document.documentElement.className = "";
	document.body.className = "";

	applyDesktopWindowShellState({
		isMaximized: true,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: true,
		isFullScreen: false,
		isMinimized: false,
		isVisible: true,
		isFocused: true,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: false,
		hasDisplayOnRight: false,
		displayBounds: null,
	});

	expect(document.documentElement.classList.contains("desktop-shell-root")).toBe(true);
	expect(document.body.classList.contains("desktop-shell")).toBe(true);
	expect(document.body.classList.contains("desktop-maximized")).toBe(true);
	expect(document.body.classList.contains("desktop-fullscreen")).toBe(true);

	applyDesktopWindowShellState({
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
	});

	expect(document.body.classList.contains("desktop-maximized")).toBe(false);
	expect(document.body.classList.contains("desktop-fullscreen")).toBe(false);
});

test("shouldUseSecondaryLeftDisplaySeamGuard mirrors baseline secondary display predicate", () => {
	const base = {
		isMaximized: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
		isFullScreen: false,
		isMinimized: false,
		isVisible: true,
		isFocused: true,
		hasDisplayOnRight: false,
		displayBounds: null,
	};
	expect(shouldUseSecondaryLeftDisplaySeamGuard(null)).toBe(false);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: false,
		hasDisplayOnLeft: true,
	})).toBe(true);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: true,
	})).toBe(false);
	expect(shouldUseSecondaryLeftDisplaySeamGuard({
		...base,
		isPrimaryDisplay: false,
		hasDisplayOnLeft: false,
	})).toBe(false);
});

test("buildDesktopLyricsPayloadPatch mirrors baseline metadata typography motion and playback fields", () => {
	const fx = cloneFxState();
	fx.lyricFont = "stone-song";
	fx.lyricWeight = 750;
	fx.lyricLetterSpacing = 0.12;
	fx.lyricLineHeight = 1.24;
	fx.lyricScale = 1.4;
	fx.lyricGlow = true;
	fx.lyricGlowBeat = true;
	fx.lyricGlowStrength = 0.52;
	fx.lyricGlowParticles = true;
	fx.desktopLyricsCinema = false;
	fx.desktopLyricsHighlight = true;

	const payload = buildDesktopLyricsPayloadPatch(fx, "line", 0.42, {
		title: "Track",
		artist: "Artist",
		playing: true,
		progressSpan: 5.2,
		positionMs: 42000,
		durationMs: 210000,
		playbackRate: 1.25,
		highBloom: 0.7,
		beatGlow: 0.8,
		beatPulse: 0.9,
		bass: 0.4,
		hasNativeKaraoke: true,
		beatMapKey: "netease:42",
		beatMap: { kicks: [1.2, 2.4] },
	});

	expect(payload.title).toBe("Track");
	expect(payload.artist).toBe("Artist");
	expect(payload.playing).toBe(true);
	expect(payload.progressSpan).toBe(5.2);
	expect(payload.fontFamily).toContain("Source Han Serif SC Heavy");
	expect(payload.fontWeight).toBe(900);
	expect(payload.letterSpacing).toBe(0.12);
	expect(payload.lineHeight).toBe(1.24);
	expect(payload.lyricScale).toBe(1.4);
	expect(payload.feather).toBe(0.03);
	expect(payload.beatMapKey).toBe("netease:42");
	expect(payload.beatMap).toEqual({ kicks: [1.2, 2.4] });
	expect(payload.lyricGlowParticles).toBe(true);
	expect(payload.cinema).toBe(false);
	expect(payload.highlightFollow).toBe(true);
	expect(payload.motion.lyricGlow).toBe(true);
	expect(payload.motion.lyricGlowBeat).toBe(true);
	expect(payload.motion.lyricGlowStrength).toBe(0.52);
	expect(payload.motion.highBloom).toBe(0.7);
	expect(payload.motion.beatGlow).toBe(0.8);
	expect(payload.motion.beatPulse).toBe(0.9);
	expect(payload.motion.bass).toBe(0.4);
	expect(payload.playback.time).toBe(42);
	expect(payload.playback.duration).toBe(210);
	expect(payload.playback.rate).toBe(1.25);
});

test("buildDesktopLyricsPayloadPatch prefers runtime stage lyric palette for desktop lyric colors", () => {
	const fx = cloneFxState();
	fx.lyricColor = "#010203";
	fx.visualTintColor = "#040506";
	fx.lyricHighlightColor = "#070809";
	fx.lyricGlowColor = "#0a0b0c";
	const payload = buildDesktopLyricsPayloadPatch(fx, "line", 0.42, {
		stageLyricPalette: {
			primary: "#112233",
			secondary: "#445566",
			highlight: "#778899",
			glowColor: "#aabbcc",
		},
	});

	expect(payload.colors).toEqual({
		primary: "#112233",
		secondary: "#445566",
		background: "rgba(0, 0, 0, 0.22)",
		highlight: "#778899",
		glow: "#aabbcc",
	});
});

test("App custom lyric modal saves text and applies custom lyrics to current track", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "42",
		sourceId: "42",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});
	usePlaybackStore.getState().setPlaying(false);
	useLyricsStore.getState().setPayload({
		provider: "netease",
		trackId: "42",
		lines: [{ timeMs: 0, text: "Song - Artist", source: "fallback" }],
		hasTranslation: false,
		isWordByWord: false,
	});

	const host = document.createElement("div");
	document.body.appendChild(host);
	let dismissSplash: (() => void) | null = null;
	function MockSplash(props: SplashHostProps) {
		dismissSplash = () => props.onDismissed?.();
		return null;
	}
	function MockVisual() {
		return <div id="visual-host" />;
	}
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={MockSplash} VisualComponent={MockVisual} />));
	flushSync(() => dismissSplash?.());
	await new Promise((resolve) => setTimeout(resolve, 0));
	const customSourceButton = host.querySelector("#lyric-source-custom") as HTMLButtonElement;
	expect(customSourceButton).not.toBeNull();
	customSourceButton.click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#custom-lyric-modal.show")).not.toBeNull();
	const input = host.querySelector("#custom-lyric-input") as HTMLTextAreaElement;
	Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(input, "自定义第一句\n自定义第二句");
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
	input.dispatchEvent(new window.Event("change", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	(host.querySelector("#custom-lyric-save") as HTMLButtonElement).click();

	const saved = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_STORE_KEY) || "{}");
	expect(saved["id:42"].text).toBe("自定义第一句\n自定义第二句");
	expect(JSON.parse(localStorage.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || "{}")["id:42"]).toBe("custom");
	expect(useLyricsStore.getState().payload?.lines[0]?.text).toBe("自定义第一句");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
});

test("App applies baseline lyric fallback when provider lyric fetch rejects", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "lyric-fail-1",
		sourceId: "lyric-fail-1",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 12 && useLyricsStore.getState().error !== "lyric api failed"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(useLyricsStore.getState().payload?.lines[0]).toEqual({
		timeMs: 0,
		text: "Song - Artist",
		source: "fallback",
		durationMs: 9999000,
		charCount: 13,
	});
	expect(useLyricsStore.getState().error).toBe("lyric api failed");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App replaces stale lyrics with current track fallback while provider lyric fetch is pending", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	useLyricsStore.getState().setPayload({
		provider: "netease",
		trackId: "old-track",
		lines: [{ timeMs: 0, text: "Old lyric", source: "lrc" }],
		hasTranslation: false,
		isWordByWord: false,
	});
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "pending-lyric-1",
		sourceId: "pending-lyric-1",
		title: "Pending Song",
		artists: ["Pending Artist"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "unknown",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return await new Promise(() => undefined);
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 8 && useLyricsStore.getState().payload?.trackId === "old-track"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(useLyricsStore.getState().payload?.trackId).toBe("pending-lyric-1");
	expect(useLyricsStore.getState().payload?.lines[0]).toEqual({
		timeMs: 0,
		text: "Pending Song - Pending Artist",
		source: "fallback",
		durationMs: 9999000,
		charCount: 29,
	});

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App loads sidecar audio-proxy URL into the audio element for raw provider song URLs", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	const host = document.createElement("div");
	let root: ReturnType<typeof createRoot> | null = null;
	try {
		localStorage.clear();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		const rawProviderUrl = "https://media.example.test/song.mp3?token=raw-provider";
		usePlaybackStore.getState().setCurrentTrack({
			provider: "netease",
			id: "proxy-audio-1",
			sourceId: "proxy-audio-1",
			title: "Proxy Song",
			artists: ["Artist"],
			album: "",
			coverUrl: "",
			durationMs: 60000,
			qualityHints: [],
			playableState: "unknown",
		});

		let resolveCount = 0;
		const fakeClient = {
			async resolveSongUrl() {
				resolveCount += 1;
				return { url: rawProviderUrl, quality: "standard" };
			},
			async lyric() {
				return {
					provider: "netease",
					trackId: "proxy-audio-1",
					lines: [],
					hasTranslation: false,
					isWordByWord: false,
				};
			},
		} as unknown as SidecarClient;
		const rootConfig: RuntimeConfig = {
			mediaProxyBase: "mineradio-tauri://localhost",
			appDataDir: "",
			appVersion: "0.0.0-test",
			schemaVersion: "0.1.0",
			updaterPublicKeyConfigured: false,
		};
		document.body.appendChild(host);
		root = createRoot(host);
		flushSync(() => root?.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

		for (let i = 0; i < 12 && appStubAudioInstances[0]?.src !== rawProviderUrl; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(resolveCount).toBe(1);
		// 代理统一由 Rust 侧完成：直链地址原样进 audio 元素
		expect(appStubAudioInstances[0]?.src).toBe(rawProviderUrl);
		expect(appStubAudioInstances[0]?.loadCalled).toBeGreaterThan(0);
	} finally {
		root?.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("App resolves proxied Soda URLs against the sidecar base when reloading after media errors", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	const host = document.createElement("div");
	let root: ReturnType<typeof createRoot> | null = null;
	try {
		localStorage.clear();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		usePlaybackStore.getState().setCurrentTrack({
			provider: "soda",
			id: "soda-reload-1",
			sourceId: "soda-reload-1",
			title: "Soda Reload Song",
			artists: ["Artist"],
			album: "",
			coverUrl: "",
			durationMs: 60000,
			qualityHints: [],
			playableState: "unknown",
		});

		const baseUrl = "http://127.0.0.1:39999";
		let resolveCount = 0;
		const relativeUrls = [
			"/providers/soda/audio-proxy?url=https%3A%2F%2Fmedia.example.test%2Fsoda-1.m4a&playAuth=auth-1",
			"/providers/soda/audio-proxy?url=https%3A%2F%2Fmedia.example.test%2Fsoda-2.m4a&playAuth=auth-2",
		];
		const fakeClient = {
			async resolveSongUrl() {
				const url = relativeUrls[Math.min(resolveCount, relativeUrls.length - 1)];
				resolveCount += 1;
				return { url, quality: "标准音质", proxied: true, provider: "soda", trial: false, playable: true };
			},
			proxiedUrl(url: string) {
				return `${baseUrl}${url}`;
			},
			audioProxyUrl() {
				throw new Error("Soda proxied URLs should not use the generic audio proxy");
			},
			async lyric() {
				return {
					provider: "soda",
					trackId: "soda-reload-1",
					lines: [],
					hasTranslation: false,
					isWordByWord: false,
				};
			},
		} as unknown as SidecarClient;
		const rootConfig: RuntimeConfig = {
			mediaProxyBase: "mineradio-tauri://localhost",
			appDataDir: "",
			appVersion: "0.0.0-test",
			schemaVersion: "0.1.0",
			updaterPublicKeyConfigured: false,
		};
		document.body.appendChild(host);
		root = createRoot(host);
		flushSync(() => root?.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

		const firstExpected = `${baseUrl}${relativeUrls[0]}`;
		for (let i = 0; i < 12 && appStubAudioInstances[0]?.src !== firstExpected; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(appStubAudioInstances[0]?.src).toBe(firstExpected);

		appStubAudioInstances[0]?.dispatchEvent(new Event("error"));
		const secondExpected = `${baseUrl}${relativeUrls[1]}`;
		for (
			let i = 0;
			i < 12 && !appStubAudioInstances.some((audio) => audio.src === secondExpected);
			i += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(resolveCount).toBe(2);
		// M2 在备用 deck 成功播放后才提交 owner；旧 deck 仍保留旧 src。
		expect(appStubAudioInstances.some((audio) => audio.src === secondExpected)).toBe(true);
	} finally {
		root?.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("App retries playback after applying an automatic quality fallback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	const host = document.createElement("div");
	let root: ReturnType<typeof createRoot> | null = null;
	try {
		localStorage.clear();
		localStorage.setItem("mineradio-playback-quality-v1", "m4a");
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		useSearchStore.getState().reset();
		usePlaybackStore.getState().setCurrentTrack({
			provider: "qq",
			id: "fallback-quality-1",
			sourceId: "fallback-quality-1",
			title: "Fallback Quality Song",
			artists: ["Artist"],
			album: "",
			coverUrl: "",
			durationMs: 60000,
			qualityHints: [],
			playableState: "unknown",
		});

		const resolveQualities: string[] = [];
		const fakeClient = {
			async trackQualities() {
				return {
					provider: "qq",
					trackId: "fallback-quality-1",
					defaultQuality: "flac",
					qualities: [
						{
							provider: "qq",
							id: "flac",
							label: "FLAC",
							short: "FLAC",
							detail: "42MB",
							requestQuality: "flac",
							source: "declared",
						},
					],
				};
			},
			async resolveSongUrl(_track: Track, quality: string) {
				resolveQualities.push(quality);
				if (quality === "m4a") {
					return { url: "", quality, proxied: false, message: "quality unavailable" };
				}
				return { url: "https://media.example.test/fallback-flac.mp3", quality, };
			},
			audioProxyUrl(url: string) {
				return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
			},
			async lyric() {
				return {
					provider: "qq",
					trackId: "fallback-quality-1",
					lines: [],
					hasTranslation: false,
					isWordByWord: false,
				};
			},
		} as unknown as SidecarClient;
		const rootConfig: RuntimeConfig = {
			mediaProxyBase: "mineradio-tauri://localhost",
			appDataDir: "",
			appVersion: "0.0.0-test",
			schemaVersion: "0.1.0",
			updaterPublicKeyConfigured: false,
		};
		document.body.appendChild(host);
		root = createRoot(host);
		flushSync(() => root?.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

		const audio = appStubAudioInstances[0];
		for (let i = 0; i < 16 && !audio?.src.includes("fallback-flac"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(resolveQualities).toEqual(["m4a", "flac"]);
		// 代理统一由 Rust 侧完成：直链地址不再被前端 audio-proxy 包装
		expect(audio?.src).toBe("https://media.example.test/fallback-flac.mp3");
		expect(localStorage.getItem("mineradio-playback-quality-v1")).toBe("flac");
	} finally {
		root?.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		useSearchStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("App shows the baseline trial banner when provider returns a trial-only URL", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "trial-1",
		sourceId: "trial-1",
		title: "Trial Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 60000,
		qualityHints: [],
		playableState: "trial_only",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return {
				url: "https://example.com/trial.mp3",
				quality: "标准",
				previewRange: { startMs: 0, endMs: 60_000 },
			};
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "trial-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	// 试听确认依赖时长测量：让 deck 的音频元素报出与区间一致的时长
	let trialAudioEl: AppStubAudioElement | null = null;
	for (let i = 0; i < 12 && !trialAudioEl; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		trialAudioEl = appStubAudioInstances.find((el) => el.src.includes("trial.mp3")) ?? null;
	}
	if (trialAudioEl) {
		trialAudioEl.duration = 60;
		trialAudioEl.dispatchEvent(new Event("durationchange"));
		// 测量挂在 timeupdate 的首帧时长分支上，补发一次驱动
		trialAudioEl.dispatchEvent(new Event("timeupdate"));
	}

	for (let i = 0; i < 12 && !host.querySelector("#trial-banner.show"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const banner = host.querySelector("#trial-banner");
	expect(banner?.classList.contains("show")).toBe(true);
	expect(host.querySelector("#trial-text")?.textContent).toBe("需要 VIP · 当前歌曲试听中");
	const loginButton = host.querySelector("#trial-login-btn") as HTMLButtonElement | null;
	// 试听判定不再推断登录态：登录按钮隐藏，横幅只提示试听
	expect(loginButton?.style.display).toBe("none");
	loginButton?.click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(host.querySelector("#login-modal")).not.toBeNull();

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App renders upstream-style Netease QR login inside the login modal", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async loginStatus(provider: string) {
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey() {
			return { provider: "netease", key: "qr-key-1" };
		},
		async createProviderLoginQrImage() {
			return { provider: "netease", key: "qr-key-1", img: "data:image/png;base64,abc" };
		},
		async checkProviderLoginQr() {
			return { provider: "netease", key: "qr-key-1", code: 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#qr-img")?.getAttribute("src"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#login-modal")).not.toBeNull();
	expect(host.querySelector("#login-provider-netease")?.className).toContain("active");
	expect(host.querySelector("#login-provider-qq")).not.toBeNull();
	expect(host.querySelector("#login-modal-title")?.textContent).toContain("扫码登录网易云音乐");
	expect(host.querySelector("#qr-img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
	expect(host.querySelector("#qr-status")?.textContent).toContain("网易云音乐 App");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App renders direct QQ QR login inside the login modal", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async loginStatus(provider: string) {
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey(provider: string) {
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			return { provider, key, code: provider === "qq" ? 66 : 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#login-modal"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	(host.querySelector("#login-provider-qq") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && host.querySelector("#qr-img")?.getAttribute("src") !== "data:image/png;base64,qq-img"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#login-provider-qq")?.className).toContain("active");
	expect(host.querySelector("#login-modal-title")?.textContent).toContain("扫码登录 QQ");
	expect(host.querySelector("#qr-img")?.getAttribute("src")).toBe("data:image/png;base64,qq-img");
	expect(host.querySelector("#qq-web-login-card")).toBeNull();
	expect(host.querySelector("#qr-status")?.textContent).toContain("QQ App");

	expect(host.querySelector("#login-method-tabs")).not.toBeNull();
	expect(host.querySelector("#login-method-qq")?.className).toContain("active");
	expect(host.querySelector("#login-method-qq_music")).not.toBeNull();
	expect(host.querySelector("#login-method-wechat")).not.toBeNull();
	(host.querySelector("#login-method-qq_music") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !(host.querySelector("#login-method-qq_music")?.className ?? "").includes("active"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#login-method-qq_music")?.className).toContain("active");
	expect(host.querySelector("#login-provider-qq")?.className).toContain("active");
	expect(host.querySelector("#login-modal-title")?.textContent).toContain("扫码登录 QQ 音乐");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App renders Soda QR login as a first-class provider in the login modal", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async loginStatus(provider: string) {
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey(provider: string) {
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			return { provider, key, code: 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#login-modal"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#login-provider-soda")).not.toBeNull();
	(host.querySelector("#login-provider-soda") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && host.querySelector("#qr-img")?.getAttribute("src") !== "data:image/png;base64,soda-img"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#login-provider-soda")?.className).toContain("active");
	expect(host.querySelector("#login-modal-title")?.textContent).toContain("扫码登录汽水音乐");
	expect(host.querySelector("#login-modal-desc")?.textContent).toContain("汽水音乐 App");
	expect(host.querySelector("#qr-img")?.getAttribute("src")).toBe("data:image/png;base64,soda-img");
	expect(host.querySelector("#qr-status")?.textContent).toContain("汽水音乐 App");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App opens account dropdown from a single logged-in account and launches only the selected provider login", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const qrProviders: string[] = [];
	const fakeClient = {
		async health() {
			return {
				ok: true,
				appVersion: "0.0.0-test",
				apiVersion: "0.1.0",
				schemaVersion: "0.1.0",
				providers: [],
			};
		},
		async capabilities() {
			return { version: "0.1.0", providers: [] };
		},
		async loginStatus(provider: string) {
			if (provider === "netease") {
				return {
					provider,
					loggedIn: true,
					nickname: "网易账号",
					avatarUrl: "https://p4.music.126.net/avatar.jpg",
					userId: "1440597970",
					vipLevel: "svip",
					vipLabel: "黑胶SVIP·陆",
					vipIcon: "netease-svip",
				};
			}
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey(provider: string) {
			qrProviders.push(provider);
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			return { provider, key, code: provider === "qq" ? 66 : 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
					label: "晴",
					weatherCode: 0,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 60,
					precipitation: 0,
					cloudCover: 10,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: { key: "clear", title: "晴天电台", tagline: "把光留给旋律", energy: 0.58, warmth: 0.62, focus: 0.54, melancholy: 0.24, keywords: ["晴天"] },
				},
				radio: {
					title: "晴天电台",
					subtitle: "把光留给旋律",
					seedQueries: ["晴天"],
					updatedAt: 1,
					songs: [],
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	for (let i = 0; i < 16 && !host.querySelector("#user-avatar"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#account-dropdown"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#account-dropdown")).not.toBeNull();
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("网易账号");
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("黑胶SVIP·陆");
	expect(host.querySelector("#account-add-provider-qq")).not.toBeNull();
	expect(host.querySelector("#account-add-provider-qq")?.textContent).toContain("登录已失效");
	expect(host.querySelector("#account-add-provider-netease")).toBeNull();
	expect(host.querySelector("#login-modal")).toBeNull();
	expect(host.querySelector("#qr-img")).toBeNull();
	expect(qrProviders).toEqual([]);

	(host.querySelector("#account-add-provider-qq") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && host.querySelector("#qr-img")?.getAttribute("src") !== "data:image/png;base64,qq-img"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#account-dropdown")).toBeNull();
	expect(host.querySelector("#login-provider-netease")).not.toBeNull();
	expect(host.querySelector("#login-provider-qq")?.className).toContain("active");
	expect(host.querySelector("#login-modal-title")?.textContent).toContain("扫码登录 QQ");
	expect(host.querySelector("#qr-img")?.getAttribute("src")).toBe("data:image/png;base64,qq-img");
	expect(qrProviders).toEqual(["qq"]);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App uses Soda's own login status for the add-account hint", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async health() {
			return {
				ok: true,
				appVersion: "0.0.0-test",
				apiVersion: "0.1.0",
				schemaVersion: "0.1.0",
				providers: [],
			};
		},
		async capabilities() {
			return { version: "0.1.0", providers: [] };
		},
		async loginStatus(provider: string) {
			if (provider === "soda") return { provider, loggedIn: false };
			return {
				provider,
				loggedIn: true,
				nickname: provider === "netease" ? "网易账号" : "QQ 账号",
				userId: `${provider}-user`,
			};
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
		async discoverHome() {
			return { loggedIn: true, user: { provider: "netease", userId: "netease-user", nickname: "网易账号", avatarUrl: "" }, dailySongs: [], playlists: [], podcasts: [], mode: "member", updatedAt: 1 };
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
					label: "晴",
					weatherCode: 0,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 60,
					precipitation: 0,
					cloudCover: 10,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: { key: "clear", title: "晴天电台", tagline: "把光留给旋律", energy: 0.58, warmth: 0.62, focus: 0.54, melancholy: 0.24, keywords: ["晴天"] },
				},
				radio: {
					title: "晴天电台",
					subtitle: "把光留给旋律",
					seedQueries: ["晴天"],
					updatedAt: 1,
					songs: [],
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	for (let i = 0; i < 16 && !host.querySelector("#user-avatar"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#account-dropdown"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#account-add-provider-soda")).not.toBeNull();
	expect(host.querySelector("#account-add-provider-soda")?.textContent).toContain("登录已失效");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App opens account dropdown instead of QR login when both providers are already logged in", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const qrProviders: string[] = [];
	const fakeClient = {
		async health() {
			return {
				ok: true,
				appVersion: "0.0.0-test",
				apiVersion: "0.1.0",
				schemaVersion: "0.1.0",
				providers: [],
			};
		},
		async capabilities() {
			return { version: "0.1.0", providers: [] };
		},
		async loginStatus(provider: string) {
			if (provider === "netease") {
				return {
					provider,
					loggedIn: true,
					nickname: "网易账号",
					avatarUrl: "https://p4.music.126.net/avatar.jpg",
					userId: "1440597970",
					vipLevel: "svip",
					vipLabel: "黑胶SVIP·陆",
					vipIcon: "netease-svip",
				};
			}
			return {
				provider,
				loggedIn: true,
				nickname: "QQ 账号",
				userId: "10001",
				vipLevel: "vip",
				vipLabel: "豪华绿钻·叁",
				vipIcon: "qq-green-vip",
			};
		},
		async createProviderLoginQrKey(provider: string) {
			qrProviders.push(provider);
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			return { provider, key, code: provider === "qq" ? 66 : 801, loggedIn: false };
		},
		async playlistList() {
			return [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
					label: "晴",
					weatherCode: 0,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 60,
					precipitation: 0,
					cloudCover: 10,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: { key: "clear", title: "晴天电台", tagline: "把光留给旋律", energy: 0.58, warmth: 0.62, focus: 0.54, melancholy: 0.24, keywords: ["晴天"] },
				},
				radio: {
					title: "晴天电台",
					subtitle: "把光留给旋律",
					seedQueries: ["晴天"],
					updatedAt: 1,
					songs: [],
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	for (let i = 0; i < 16 && !host.querySelector("#user-avatar"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#account-dropdown"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#account-dropdown")).not.toBeNull();
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("网易账号");
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("QQ 账号");
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("黑胶SVIP·陆");
	expect(host.querySelector("#account-dropdown")?.textContent).toContain("豪华绿钻·叁");
	expect(host.querySelector("#account-add-provider-netease")).toBeNull();
	expect(host.querySelector("#account-add-provider-qq")).toBeNull();
	expect(host.querySelector("#login-modal")).toBeNull();
	expect(host.querySelector("#login-provider-netease")).toBeNull();
	expect(host.querySelector("#login-provider-qq")).toBeNull();
	expect(host.querySelector("#qr-img")).toBeNull();
	expect(qrProviders).toEqual([]);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App syncs QQ account status after direct QR login succeeds", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	let qqQrConfirmed = false;
	const playlistCalls: string[] = [];
	let discoverHomeCalls = 0;
	let resolveSyncedQqStatus = (_status: { provider: string; loggedIn: boolean; userId: string }) => {};
	const syncedQqStatus = new Promise<{ provider: string; loggedIn: boolean; userId: string }>((resolve) => {
		resolveSyncedQqStatus = resolve;
	});
	const fakeClient = {
		async loginStatus(provider: string) {
			if (provider === "qq" && qqQrConfirmed) {
				return syncedQqStatus;
			}
			return { provider, loggedIn: false };
		},
		async createProviderLoginQrKey(provider: string) {
			return { provider, key: `${provider}-qr-key-1` };
		},
		async createProviderLoginQrImage(provider: string, key: string) {
			return { provider, key, img: `data:image/png;base64,${provider}-img` };
		},
		async checkProviderLoginQr(provider: string, key: string) {
			if (provider === "qq") {
				qqQrConfirmed = true;
				return { provider, key, code: 0, loggedIn: true, stored: true };
			}
			return { provider, key, code: 801, loggedIn: false };
		},
		async playlistList(provider: string) {
			playlistCalls.push(provider);
			return provider === "qq"
				? [{ provider: "qq", id: "qq-auto-1", name: "登录后自动同步QQ歌单", coverUrl: "", trackCount: 1, trackIds: [], subscribed: false }]
				: [];
		},
		async podcastMy() {
			return { loggedIn: false, collections: [] };
		},
		async discoverHome() {
			discoverHomeCalls += 1;
			return {
				loggedIn: true,
				user: { provider: "qq", userId: "10001", nickname: "", avatarUrl: "" },
				dailySongs: [],
				playlists: [{ provider: "qq", id: "qq-auto-1", name: "登录后自动同步QQ歌单", coverUrl: "", trackCount: 1, trackIds: [], subscribed: false }],
				podcasts: [],
				mode: "member",
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#user-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && !host.querySelector("#login-modal"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	(host.querySelector("#login-provider-qq") as HTMLButtonElement).click();
	for (let i = 0; i < 12 && host.querySelector("#qr-img")?.getAttribute("src") !== "data:image/png;base64,qq-img"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (let i = 0; i < 12 && !host.querySelector("#qr-status")?.textContent?.includes("正在同步账号状态"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#qr-status")?.textContent).toContain("正在同步账号状态");
	await new Promise((resolve) => setTimeout(resolve, 0));
	resolveSyncedQqStatus({ provider: "qq", loggedIn: true, userId: "10001" });
	for (let i = 0; i < 12 && !host.querySelector(".account-status-line")?.textContent?.includes("已登录"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#qr-status")?.textContent).toContain("登录成功");
	expect(host.querySelector(".account-status-line")?.textContent).toContain("已登录 10001");
	expect(playlistCalls.filter((provider) => provider === "qq").length).toBeGreaterThan(0);
	expect(discoverHomeCalls).toBeGreaterThan(0);
	expect(host.textContent).toContain("登录后自动同步QQ歌单");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App clears the trial banner when the audio element reports a playback error", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "trial-error-1",
		sourceId: "trial-error-1",
		title: "Trial Error Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 60000,
		qualityHints: [],
		playableState: "trial_only",
	});

	const fakeClient = {
		async resolveSongUrl() {
			return {
				url: "https://example.com/trial-error.mp3",
				quality: "标准",
				previewRange: { startMs: 0, endMs: 60_000 },
			};
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "trial-error-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	// 试听确认依赖时长测量：等真实 deck 的音频元素挂上 src 后，
	// 让它报出与 previewRange.endMs 一致的时长
	let trialAudioEl: AppStubAudioElement | null = null;
	for (let i = 0; i < 12 && !trialAudioEl; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		trialAudioEl = appStubAudioInstances.find((el) => el.src.includes("trial-error.mp3")) ?? null;
	}
	if (trialAudioEl) {
		trialAudioEl.duration = 60;
		trialAudioEl.dispatchEvent(new Event("durationchange"));
		// 测量挂在 timeupdate 的首帧时长分支上，补发一次驱动
		trialAudioEl.dispatchEvent(new Event("timeupdate"));
	}

	for (let i = 0; i < 12 && !host.querySelector("#trial-banner.show"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#trial-banner")?.classList.contains("show")).toBe(true);

	appStubAudioInstances[0]?.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#trial-banner")?.classList.contains("show")).toBe(false);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App resolves playback beatmap and forwards it to visual host", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "beat-1",
		sourceId: "beat-1",
		title: "Beat Song",
		artists: ["Beat Artist"],
		album: "",
		coverUrl: "",
		durationMs: 120000,
		qualityHints: [],
		playableState: "unknown",
		type: "podcast",
		programId: "program-1",
	} as unknown as Track);

	const beatmapCalls: unknown[] = [];
	const map = { cameraBeats: [{ t: 1.2, strength: 0.8 }], analyzedAt: 123, duration: 120, tempoSource: "podcast-dj-offline" };
	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/beat.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return `http://127.0.0.1:39999/audio-proxy?url=${encodeURIComponent(url)}`;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "beat-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
		async podcastDjBeatmap(url: string, durationSec: number, introSec: number) {
			beatmapCalls.push({ url, durationSec, introSec });
			return { ok: true, map };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	let latestVisualProps: VisualEngineHostProps | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		latestVisualProps = props;
		return <div id="visual-host" />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={MockVisual} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 12 && beatmapCalls.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (let i = 0; i < 12 && !(latestVisualProps as unknown as { beatMap?: unknown } | null)?.beatMap; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(beatmapCalls).toEqual([
		{ url: "https://example.com/beat.mp3", durationSec: 120, introSec: 0 },
	]);
	expect((latestVisualProps as unknown as { beatMapKey?: string })?.beatMapKey).toBe(desktopLyricsBeatMapKey(map, "dj"));
	expect((latestVisualProps as unknown as { beatMap?: unknown })?.beatMap).toEqual(map);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App does not run the podcast DJ beatmap analyzer for ordinary songs", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "song-1",
		sourceId: "song-1",
		title: "Song",
		artists: ["Artist"],
		album: "",
		coverUrl: "",
		durationMs: 120000,
		qualityHints: [],
		playableState: "unknown",
	});

	const beatmapCalls: unknown[] = [];
	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/song.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "song-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
		async podcastDjBeatmap(url: string) {
			beatmapCalls.push(url);
			return { ok: true, map: { cameraBeats: [1] } };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 8; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(beatmapCalls).toEqual([]);

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App starts baseline Home private radar from discover songs", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const fakeClient = {
		async resolveSongUrl() {
			return { url: "https://example.com/rain.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return { provider: "netease", trackId: "rain-2", lines: [], hasTranslation: false, isWordByWord: false };
		},
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: true,
				user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
				mode: "member",
				dailySongs: [
					{
						provider: "netease",
						id: "home-1",
						sourceId: "home-1",
						title: "Home One",
						artists: ["Alice"],
						album: "",
						coverUrl: "",
						durationMs: 1000,
						qualityHints: [],
						playableState: "playable",
					},
					{
						provider: "qq",
						id: "home-2",
						sourceId: "home-2",
						title: "Home Two",
						artists: ["Bob"],
						album: "",
						coverUrl: "",
						durationMs: 2000,
						qualityHints: [],
						playableState: "unknown",
					},
				],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	(host.querySelector('[data-home-card="private"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["home-1", "home-2"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("home-1");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	localStorage.clear();
});

test("App derives Home Continue and Next Up from the live queue before recent history", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useSearchStore.getState().setKeyword("");

	const tracks: Track[] = [
		{
			provider: "netease",
			id: "recent-1",
			sourceId: "recent-1",
			title: "Earlier Song",
			artists: ["Alice"],
			album: "",
			coverUrl: "",
			durationMs: 1000,
			qualityHints: [],
			playableState: "playable",
		},
		{
			provider: "qq",
			id: "recent-2",
			sourceId: "recent-2",
			title: "Recent Song",
			artists: ["Alice"],
			album: "",
			coverUrl: "",
			durationMs: 2000,
			qualityHints: [],
			playableState: "playable",
		},
	];
	const fakeClient = {
		...playbackSidecarClientStubs(),
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		usePlaybackStore.getState().setQueue(tracks);
		usePlaybackStore.getState().playAt(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const audio = appStubAudioInstances[0];
		audio.duration = 2;
		audio.currentTime = 1.2;
		audio.dispatchEvent(new Event("timeupdate"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		usePlaybackStore.getState().playAt(1);
		for (
			let i = 0;
			i < 12 && !appStubAudioInstances.some(
				(instance) => instance !== audio && instance.playCalled > 0,
			);
			i += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const secondAudio = appStubAudioInstances.find(
			(instance) => instance !== audio && instance.playCalled > 0,
		) ?? audio;
		secondAudio.duration = 4;
		secondAudio.currentTime = 2.2;
		secondAudio.dispatchEvent(new Event("timeupdate"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		secondAudio.dispatchEvent(new Event("ended"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		(host.querySelector("#home-btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(host.querySelector("#home-continue-title")?.textContent).toBe("Earlier Song");
		expect(host.querySelector("#home-profile-title")?.textContent).toBe("Recent Song");
		expect(localStorage.getItem("mineradio-listen-stats-v1")).toContain("Recent Song");

		(host.querySelector('[data-home-card="profile"]') as HTMLButtonElement).click();
		expect(useSearchStore.getState().keyword).toBe("");
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("recent-2");
		expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual([
			"recent-1",
			"recent-2",
		]);

		(host.querySelector('[data-home-card="continue"]') as HTMLButtonElement).click();
		expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual([
			"recent-1",
			"recent-2",
		]);
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("recent-2");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useSearchStore.getState().setKeyword("");
		localStorage.clear();
		restoreAudio();
	}
});

test("App starts baseline Home weather radio from a weather rail song", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	const restoreAudio = installAppStubAudio();

	const fakeClient = {
		...playbackSidecarClientStubs(),
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: {
						name: "上海",
						country: "中国",
						admin1: "",
						latitude: 31.23,
						longitude: 121.47,
						timezone: "Asia/Shanghai",
						fallback: false,
					},
					label: "雨",
					weatherCode: 61,
					temperature: 22,
					apparentTemperature: 21,
					humidity: 88,
					precipitation: 1,
					cloudCover: 90,
					windSpeed: 6,
					windGusts: 10,
					isDay: 1,
					time: "",
					updatedAt: 1,
					error: "",
					mood: {
						key: "rain",
						title: "雨天电台",
						tagline: "留一点潮湿的空间给旋律",
						energy: 0.38,
						warmth: 0.42,
						focus: 0.64,
						melancholy: 0.66,
						keywords: ["雨天 R&B"],
					},
				},
				radio: {
					title: "雨天电台",
					subtitle: "留一点潮湿的空间给旋律",
					seedQueries: ["雨天 R&B"],
					songs: [
						{
							provider: "netease",
							id: "rain-1",
							sourceId: "rain-1",
							title: "Rain One",
							artists: ["Alice"],
							album: "",
							coverUrl: "",
							durationMs: 1000,
							qualityHints: [],
							playableState: "playable",
						},
						{
							provider: "qq",
							id: "rain-2",
							sourceId: "rain-2",
							title: "Rain Two",
							artists: ["Bob"],
							album: "",
							coverUrl: "",
							durationMs: 2000,
							qualityHints: [],
							playableState: "unknown",
						},
					],
					updatedAt: 1,
				},
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const weatherTile = Array.from(host.querySelectorAll(".home-tile"))
			.find((button) => button.textContent?.includes("Rain Two")) as HTMLButtonElement;
		weatherTile.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["rain-1", "rain-2"]);
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("rain-2");
		expect(host.querySelector("#toast.show")?.textContent).toContain("雨天电台 · 2 首");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		localStorage.clear();
		restoreAudio();
	}
});

test("App opens Home playlist tiles as a full-screen detail page before playback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	const restoreAudio = installAppStubAudio();

	const playlistCalls: unknown[] = [];
	const tracks: Track[] = [
		{ provider: "qq", id: "qq-song-1", sourceId: "qq-song-1", title: "QQ Song One", artists: ["Alice"], album: "", coverUrl: "", durationMs: 1000, qualityHints: [], playableState: "playable" },
		{ provider: "qq", id: "qq-song-2", sourceId: "qq-song-2", title: "QQ Song Two", artists: ["Bob"], album: "", coverUrl: "", durationMs: 2000, qualityHints: [], playableState: "playable" },
	];
	const fakeClient = {
		...playbackSidecarClientStubs(),
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: true,
				user: { provider: "qq", userId: "q1", nickname: "QQ User", avatarUrl: "" },
				mode: "member",
				dailySongs: [],
				playlists: [{ provider: "qq", id: "qq-pl-1", name: "QQ 深夜歌单", coverUrl: "https://img.example/q.jpg", trackCount: 2, trackIds: [], subscribed: false }],
				podcasts: [],
				updatedAt: 1,
			};
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: null,
				radio: { title: "天气电台", subtitle: "", seedQueries: [], updatedAt: 1, songs: [] },
			};
		},
		async playlistDetail(provider: string, id: string) {
			playlistCalls.push({ provider, id });
			return { provider, id, name: "QQ 深夜歌单", coverUrl: "https://img.example/q.jpg", trackCount: 2, trackIds: [], subscribed: false, tracks };
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		for (let i = 0; i < 16 && !host.textContent?.includes("QQ 深夜歌单"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const playlistTile = Array.from(host.querySelectorAll(".home-tile"))
			.find((button) => button.textContent?.includes("QQ 深夜歌单")) as HTMLButtonElement;
		playlistTile.click();
		for (let i = 0; i < 16 && !host.querySelector("[data-home-playlist-detail]"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(playlistCalls).toEqual([{ provider: "qq", id: "qq-pl-1" }]);
		expect(host.querySelector("[data-home-playlist-detail]")?.textContent).toContain("QQ Song One");
		expect(usePlaybackStore.getState().queue).toEqual([]);
		expect(usePlaybackStore.getState().currentTrack).toBeNull();

		(host.querySelector(".home-detail-play") as HTMLButtonElement).click();
		for (let i = 0; i < 8 && usePlaybackStore.getState().queue.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(usePlaybackStore.getState().queue.map((track) => track.id)).toEqual(["qq-song-1", "qq-song-2"]);
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("qq-song-1");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		localStorage.clear();
		restoreAudio();
	}
});

test("App imports a local audio file from the baseline Home import tile", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const oldCreateObjectUrl = URL.createObjectURL;
	const created: unknown[] = [];
	URL.createObjectURL = ((file: unknown) => {
		created.push(file);
		return "blob:local-song";
	}) as typeof URL.createObjectURL;

	const fakeClient = {
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const tile = Array.from(host.querySelectorAll(".home-tile"))
			.find((button) => button.textContent?.includes("导入本地音乐")) as HTMLButtonElement;
		tile.click();
		const input = host.querySelector("#file-input") as HTMLInputElement;
		expect(input.accept).toBe(".mp3,.flac,.wav,.ogg,.m4a,.jpg,.jpeg,.png,.webp");

		const file = new File(["audio"], "Local Song.mp3", { type: "audio/mpeg", lastModified: 123 });
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		input.dispatchEvent(new window.Event("change", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(created).toEqual([file]);
		expect(usePlaybackStore.getState().queue.map((track) => track.title)).toEqual(["Local Song"]);
		expect(usePlaybackStore.getState().currentTrack?.title).toBe("Local Song");
		expect(usePlaybackStore.getState().currentTrack?.artists).toEqual(["本地文件"]);
	} finally {
		URL.createObjectURL = oldCreateObjectUrl;
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		localStorage.clear();
	}
});

test("App applies and clears a custom cover image from the baseline import controls", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	const coverTrack: Track = {
		provider: "netease",
		id: "cover-song-1",
		sourceId: "cover-song-1",
		title: "Cover Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "https://img.example/default.jpg",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	};
	usePlaybackStore.getState().setQueue([coverTrack]);
	usePlaybackStore.getState().playAt(0);

	const fakeClient = {
		async playlistList() {
			return [];
		},
		async discoverHome() {
			return {
				loggedIn: false,
				user: null,
				mode: "starter",
				dailySongs: [],
				playlists: [],
				podcasts: [],
				updatedAt: 1,
			};
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			return {
				provider: "netease",
				trackId: "cover-song-1",
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const input = host.querySelector("#file-input") as HTMLInputElement;
		const imageFile = new File(["cover"], "Cover.png", { type: "image/png", lastModified: 456 });
		Object.defineProperty(input, "files", { value: [imageFile], configurable: true });
		input.dispatchEvent(new window.Event("change", { bubbles: true }));

		for (let i = 0; i < 12 && !usePlaybackStore.getState().currentTrack?.coverUrl?.startsWith("data:image/"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(usePlaybackStore.getState().currentTrack?.coverUrl?.startsWith("data:image/")).toBe(true);
		expect(usePlaybackStore.getState().queue[0]?.coverUrl?.startsWith("data:image/")).toBe(true);
		expect(host.querySelector("#clear-cover-btn")?.className).toContain("has-cover");

		(host.querySelector("#clear-cover-btn") as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(usePlaybackStore.getState().currentTrack?.coverUrl).toBe("https://img.example/default.jpg");
		expect(host.querySelector("#clear-cover-btn")?.className).not.toContain("has-cover");
		expect(host.querySelector("#toast.show")?.textContent).toContain("已恢复默认封面");
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		localStorage.clear();
		restoreAudio();
	}
});

test("App plays centered shelf playlist hotspots by loading the playlist into the queue", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const playlistCalls: unknown[] = [];
	const tracks: Track[] = [
		{
			provider: "netease",
			id: "song-1",
			sourceId: "song-1",
			title: "Shelf Song",
			artists: ["Alice"],
			album: "Shelf Mix",
			coverUrl: "",
			durationMs: 100000,
			qualityHints: [],
			playableState: "playable",
		},
	];
	const fakeClient = {
		async playlistDetail(provider: string, id: string) {
			playlistCalls.push({ provider, id });
			return { provider, id, name: "Shelf Mix", coverUrl: "", trackCount: tracks.length, tracks };
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric(track: Track) {
			return {
				provider: track.provider,
				trackId: track.id,
				lines: [],
				hasTranslation: false,
				isWordByWord: false,
			};
		},
	} as unknown as SidecarClient;

	let triggerShelfPlaylist: (() => void) | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		triggerShelfPlaylist = () => props.onShelfPlayPlaylist?.({
			index: 2,
			provider: "netease",
			playlistId: "pl-1",
			title: "Card Mix",
			action: { kind: "loadPlaylist", provider: "netease", playlistId: "pl-1", title: "Card Mix" },
		});
		return <div id="visual-host" />;
	}
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={MockVisual} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync(() => triggerShelfPlaylist?.());
		for (let i = 0; i < 12 && usePlaybackStore.getState().queue.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(playlistCalls).toEqual([{ provider: "netease", id: "pl-1" }]);
		expect(usePlaybackStore.getState().queue).toEqual(tracks);
		expect(usePlaybackStore.getState().currentTrack).toBe(tracks[0]);
		expect(usePlaybackStore.getState().isPlaying).toBe(true);
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
		restoreAudio();
	}
});

test("App routes the logged-out Home library card to local audio import", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();

	const fakeClient = {
		async discoverHome() {
			return { loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 };
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: null,
				radio: { title: "天气电台", subtitle: "", seedQueries: [], updatedAt: 1, songs: [] },
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		await new Promise((resolve) => setTimeout(resolve, 0));
		let fileDialogClicks = 0;
		host.querySelector("#file-input")?.addEventListener("click", () => {
			fileDialogClicks += 1;
		});
		(host.querySelector('[data-home-card="library"]') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(host.querySelector("#login-modal")).toBeNull();
		expect(fileDialogClicks).toBe(1);
		expect(host.querySelector("#visual-guide")?.classList.contains("show")).toBe(false);
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useLyricsStore.getState().reset();
		localStorage.clear();
	}
});

test("App routes the logged-in Home library card to the baseline left playlist panel", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useShelfStore.setState({ open: false, selectedPlaylistId: null });

	const fakeClient = {
		async discoverHome() {
			return {
				loggedIn: true,
				user: { provider: "netease", userId: "u1", nickname: "Alice", avatarUrl: "" },
				dailySongs: [],
				playlists: [{ provider: "netease", id: "pl-1", name: "我的歌单", coverUrl: "", trackCount: 2, trackIds: [], subscribed: false }],
				podcasts: [],
				mode: "member",
				updatedAt: 1,
			};
		},
		async playlistList(provider: string) {
			if (provider === "qq") return [];
			return [{ provider: "netease", id: "pl-1", name: "我的歌单", coverUrl: "", trackCount: 2, trackIds: [], subscribed: false }];
		},
		async weatherRadio() {
			return {
				ok: true,
				weather: null,
				radio: { title: "天气电台", subtitle: "", seedQueries: [], updatedAt: 1, songs: [] },
			};
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
		for (let i = 0; i < 16 && !host.querySelector("#home-weather-card-sub")?.textContent?.includes("2 首"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(host.querySelector("#home-weather-card-sub")?.textContent).toContain("2 首");
		(host.querySelector('[data-home-card="library"]') as HTMLButtonElement).click();
		for (let i = 0; i < 8 && !host.querySelector("#playlist-panel.show"); i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(host.querySelector("#playlist-panel.show")).not.toBeNull();
		expect(host.querySelector("#tab-pl")?.className).toContain("active");
		expect(host.querySelector("#pl-list")?.textContent).toContain("我的歌单");
		expect(useShelfStore.getState().open).toBe(false);
		expect(document.body.classList.contains("empty-home-active")).toBe(false);
	} finally {
		root.unmount();
		host.remove();
		usePlaybackStore.getState().clearQueue();
		useShelfStore.setState({ open: false, selectedPlaylistId: null });
		localStorage.clear();
	}
});

test("App opens the baseline collect picker for shelf detail collect and adds only after a playlist is chosen", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const added: unknown[] = [];
	const fakeClient = {
		async playlistList(provider: string) {
			if (provider === "netease") {
				return [
					{ provider: "netease", id: "mine-1", name: "我的歌单", coverUrl: "https://example.invalid/mine.jpg", trackCount: 12, trackIds: [] },
					{ provider: "netease", id: "sub-1", name: "收藏来的歌单", coverUrl: "", trackCount: 4, trackIds: [], subscribed: true },
				];
			}
			return [
				{ provider: "qq", id: "qq-1", name: "QQ 收藏", coverUrl: "", trackCount: 2, trackIds: [] },
			];
		},
		async addSongToPlaylist(provider: string, playlistId: string, trackId: string) {
			added.push({ provider, playlistId, trackId });
			return { provider, playlistId, trackId, code: 200 };
		},
	} as unknown as SidecarClient;

	let triggerCollect: (() => void) | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		triggerCollect = () => props.onShelfDetailRowClick?.({
			index: 0,
			action: "collect",
			row: {
				id: "song-1",
				name: "First Song",
				artist: "Alice",
				cover: "https://example.invalid/cover.jpg",
				provider: "netease",
				type: "playable",
				sourceId: "song-1",
				title: "First Song",
				artists: ["Alice"],
				album: "",
				coverUrl: "https://example.invalid/cover.jpg",
				playableState: "playable",
				qualityHints: [],
			},
		});
		return <div id="visual-host" />;
	}
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={MockVisual} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	flushSync(() => triggerCollect?.());
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#collect-modal.show")).not.toBeNull();
	expect(host.querySelector("#collect-current")?.textContent).toContain("First Song");
	expect(host.querySelector("#collect-list")?.textContent).toContain("我的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("收藏来的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("QQ 收藏");
	expect(added).toEqual([]);

	(host.querySelector('[data-collect-pid="mine-1"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(added).toEqual([{ provider: "netease", playlistId: "mine-1", trackId: "song-1" }]);
	expect(host.querySelector("#collect-modal.show")).toBeNull();

	root.unmount();
	host.remove();
	localStorage.clear();
});

test("App opens the collect picker for QQ detail rows and filters to writable QQ playlists", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();

	const added: unknown[] = [];
	const fakeClient = {
		async playlistList(provider: string) {
			if (provider === "netease") {
				return [
					{ provider: "netease", id: "ne-1", name: "网易云歌单", coverUrl: "", trackCount: 1, trackIds: [] },
				];
			}
			return [
				{ provider: "qq", id: "qq-mine", name: "QQ 自建", coverUrl: "", trackCount: 5, trackIds: [] },
				{ provider: "qq", id: "qq-sub", name: "QQ 收藏来的歌单", coverUrl: "", trackCount: 7, trackIds: [], subscribed: true },
			];
		},
		async addSongToPlaylist(provider: string, playlistId: string, trackId: string) {
			added.push({ provider, playlistId, trackId });
			return { provider, playlistId, trackId, code: 100, success: true };
		},
	} as unknown as SidecarClient;

	let triggerCollect: (() => void) | null = null;
	function MockVisual(props: VisualEngineHostProps) {
		triggerCollect = () => props.onShelfDetailRowClick?.({
			index: 0,
			action: "collect",
			row: {
				id: "qq-song-1",
				name: "QQ Song",
				artist: "Bob",
				cover: "",
				provider: "qq",
				type: "playable",
				sourceId: "qq-song-1",
				title: "QQ Song",
				artists: ["Bob"],
				album: "",
				coverUrl: "",
				playableState: "playable",
				qualityHints: [],
			},
		});
		return <div id="visual-host" />;
	}
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={MockVisual} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	flushSync(() => triggerCollect?.());
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.querySelector("#collect-modal.show")).not.toBeNull();
	expect(host.querySelector("#collect-current")?.textContent).toContain("QQ Song");
	expect(host.querySelector("#collect-list")?.textContent).toContain("QQ 自建");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("QQ 收藏来的歌单");
	expect(host.querySelector("#collect-list")?.textContent).not.toContain("网易云歌单");
	expect(added).toEqual([]);

	(host.querySelector('[data-collect-pid="qq-mine"]') as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(added).toEqual([{ provider: "qq", playlistId: "qq-mine", trackId: "qq-song-1" }]);
	expect(host.querySelector("#collect-modal.show")).toBeNull();

	root.unmount();
	host.remove();
	localStorage.clear();
});

test("App checks current Netease like state and wires bottom heart mutations through sidecar", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-current-1",
		sourceId: "like-current-1",
		title: "Like Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const checked: string[][] = [];
	const likedCalls: Array<{ provider: string; id: string; liked: boolean }> = [];
	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			checked.push(ids);
			return { provider: "netease", ids, liked: { "like-current-1": true } };
		},
		async likeSong(provider: string, id: string, liked: boolean) {
			likedCalls.push({ provider, id, liked });
			return { provider, id, liked, code: 200 };
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 8 && checked.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(checked).toEqual([["like-current-1"]]);
	for (let i = 0; i < 8 && !host.querySelector("#heart-btn")?.className.includes("liked"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const heart = host.querySelector("#heart-btn") as HTMLButtonElement;
	expect(heart.className).toContain("liked");
	expect(heart.getAttribute("aria-pressed")).toBe("true");

	heart.click();
	for (let i = 0; i < 8 && likedCalls.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(likedCalls).toEqual([{ provider: "netease", id: "like-current-1", liked: false }]);
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("已取消红心"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(host.querySelector("#toast.show")?.textContent).toContain("已取消红心");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App shows QQ unsupported notice for bottom heart without calling like mutation", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "qq",
		id: "qq-like-unsupported",
		sourceId: "qq-like-unsupported",
		title: "QQ Song",
		artists: ["Bob"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	let likeCalled = 0;
	const fakeClient = {
		async checkSongLikes() {
			throw new Error("QQ should not run like check");
		},
		async likeSong() {
			likeCalled += 1;
			throw new Error("QQ should not run like mutation");
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("QQ 音乐红心同步待登录接口接入"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(likeCalled).toBe(0);
	expect(host.querySelector("#toast.show")?.textContent).toContain("QQ 音乐红心同步待登录接口接入");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App checks current Soda like state and wires bottom heart mutations through sidecar", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "soda",
		id: "ui-row-id",
		sourceId: "soda-track-1",
		title: "Soda Like Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const checked: Array<{ provider: string; ids: string[] }> = [];
	const likedCalls: Array<{ provider: string; id: string; liked: boolean }> = [];
	const fakeClient = {
		async checkSongLikes(provider: string, ids: string[]) {
			checked.push({ provider, ids });
			return { provider, ids, liked: { "soda-track-1": true } };
		},
		async likeSong(provider: string, id: string, liked: boolean) {
			likedCalls.push({ provider, id, liked });
			return { provider, id, liked, code: 200 };
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));

	for (let i = 0; i < 8 && checked.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(checked).toEqual([{ provider: "soda", ids: ["soda-track-1"] }]);
	for (let i = 0; i < 8 && !host.querySelector("#heart-btn")?.className.includes("liked"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const heart = host.querySelector("#heart-btn") as HTMLButtonElement;
	expect(heart.className).toContain("liked");
	expect(heart.getAttribute("aria-pressed")).toBe("true");

	heart.click();
	for (let i = 0; i < 8 && likedCalls.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(likedCalls).toEqual([{ provider: "soda", id: "soda-track-1", liked: false }]);
	expect(host.querySelector("#toast.show")?.textContent).not.toContain("本地文件暂不支持红心同步");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App rolls back bottom heart state and shows baseline failure copy when Netease like fails", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-fail-1",
		sourceId: "like-fail-1",
		title: "Fail Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			return { provider: "netease", ids, liked: { "like-fail-1": false } };
		},
		async likeSong() {
			throw new Error("like failed");
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#toast.show")?.textContent?.includes("红心操作失败"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const heart = host.querySelector("#heart-btn") as HTMLButtonElement;
	expect(host.querySelector("#toast.show")?.textContent).toContain("红心操作失败");
	expect(heart.getAttribute("aria-pressed")).toBe("false");
	expect(heart.className).not.toContain("liked");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});

test("App opens login modal when Netease heart mutation requires login", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
	const restoreAudio = installAppStubAudio();
	localStorage.clear();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	usePlaybackStore.getState().setCurrentTrack({
		provider: "netease",
		id: "like-login-required",
		sourceId: "like-login-required",
		title: "Login Song",
		artists: ["Alice"],
		album: "",
		coverUrl: "",
		durationMs: 10000,
		qualityHints: [],
		playableState: "playable",
	});

	const fakeClient = {
		async checkSongLikes(_provider: string, ids: string[]) {
			return { provider: "netease", ids, liked: { "like-login-required": false } };
		},
		async likeSong() {
			throw new SidecarClientError({
				code: "LOGIN_REQUIRED",
				message: "login required",
				provider: "netease",
				retryable: false,
				action: "login",
			});
		},
		async resolveSongUrl() {
			return { url: "https://example.com/audio.mp3", quality: "standard", };
		},
		audioProxyUrl(url: string) {
			return url;
		},
		async lyric() {
			throw new Error("lyric api failed");
		},
	} as unknown as SidecarClient;
	const rootConfig: RuntimeConfig = {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-test",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<App updateController={APP_UPDATE_CONTROLLER} SplashComponent={() => null} VisualComponent={() => <div id="visual-host" />} applicationRuntime={legacyRuntimeForTest(rootConfig, fakeClient)} />));
	await new Promise((resolve) => setTimeout(resolve, 0));

	(host.querySelector("#heart-btn") as HTMLButtonElement).click();
	for (let i = 0; i < 8 && !host.querySelector("#login-modal"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(host.querySelector("#toast.show")?.textContent).toContain("登录后可同步到网易云");
	expect(host.querySelector("#login-modal")).not.toBeNull();
	expect(host.querySelector("#heart-btn")?.className).not.toContain("liked");

	root.unmount();
	host.remove();
	usePlaybackStore.getState().clearQueue();
	useLyricsStore.getState().reset();
	localStorage.clear();
	restoreAudio();
});
