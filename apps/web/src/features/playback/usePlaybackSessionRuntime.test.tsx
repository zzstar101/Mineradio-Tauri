import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { LyricPayload, Track } from "@mineradio/shared";
import {
	PlayerController,
	type ErrorPayload,
	type MediaEventPayload,
	type OwnerChangePayload,
	type TimeUpdatePayload,
} from "../../audio/player-controller";
import type { AppServices } from "../../app/app-services";
import { usePlaybackStore } from "../../stores/playback-store";
import type { PlaybackCheckpointRestoreAuthority } from "../../stores/playback-store";
import { PlaybackSessionCoordinator } from "./playback-session-coordinator";
import {
	usePlaybackSessionRuntime,
	type PlaybackSessionRuntimeResult,
} from "./usePlaybackSessionRuntime";
import { usePlaybackUiController } from "./usePlaybackUiController";

const TRACK: Track = {
	provider: "netease",
	id: "session-1",
	sourceId: "session-1",
	title: "Session Song",
	artists: ["Session Artist"],
	album: "",
	coverUrl: "",
	durationMs: 60_000,
	qualityHints: [],
	playableState: "unknown",
};

for (const source of ["remote", "blob"] as const) {
	test(`paused ${source} checkpoint loads without autoplay and keeps paused intent stable`, async () => {
		await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
		const loaded: string[] = [];
		const seeks: number[] = [];
		let playCount = 0;
		let checkpointConsumeCount = 0;
		let snapshotPlaying = false;
		const playingWrites: boolean[] = [];
		const coordinator = new PlaybackSessionCoordinator();
		const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
			current: null,
		};
		const controller = {
			load(url: string) {
				loaded.push(url);
			},
			seek(positionMs: number) {
				seeks.push(positionMs);
			},
			async play() {
				playCount += 1;
				snapshotPlaying = true;
			},
			pause() {
				snapshotPlaying = false;
			},
			stop() {},
		} as unknown as PlayerController;
		const remoteUrl = "https://media.example/restored-paused.mp3";
		const localUrl = "blob:https://app.example/restored-local";
		const services = source === "remote" ? {
			music: {
				playback: {
					async resolveSongUrl() {
						return {
							url: remoteUrl,
							quality: "standard",
						};
					},
				},
				lyrics: {
					async lyric() {
						return await new Promise<LyricPayload>(() => undefined);
					},
				},
				discover: {},
			},
			mediaUrl: {
				audioProxyUrl: (url: string) => url,
				playableUrl: (url: string) => url,
			},
		} as unknown as AppServices : null;
		const checkpointRestore: PlaybackCheckpointRestoreAuthority = {
			operationId: source === "remote"
				? "00000000000000000000000000000001"
				: "00000000000000000000000000000002",
			receipt: source === "remote"
				? "10000000000000000000000000000001"
				: "10000000000000000000000000000002",
			playbackIntentId: 7,
			currentTrackRef: `${TRACK.provider}:${TRACK.id}`,
			wasPlaying: false,
			sourceKind: source,
			restartRestorable: source === "remote",
			autoplayDispositionConsumed: false,
		};

		function Harness() {
			runtimeRef.current = usePlaybackSessionRuntime({
				appServices: services,
				coordinator,
				controllerRef: { current: controller },
				localAudioUrlsRef: {
					current: source === "blob"
						? new Map([[`${TRACK.provider}:${TRACK.id}`, localUrl]])
						: new Map(),
				},
				currentTrack: TRACK,
				playbackIntentId: 7,
				positionMs: 24_000,
				checkpointRestore,
				consumeCheckpointAutoplay: () => {
					checkpointConsumeCount += 1;
					return true;
				},
				getPlaybackSnapshot: () => ({
					currentTrack: TRACK,
					positionMs: 24_000,
					durationMs: 60_000,
					isPlaying: snapshotPlaying,
				}),
				setPlaying: (playing) => playingWrites.push(playing),
				setPositionMs: () => undefined,
				togglePlayFallback: () => undefined,
				setSearchError: () => undefined,
				showToast: () => undefined,
				setHomeForcedOpen: () => undefined,
				setHomeSuppressed: () => undefined,
				setLyricsPayload: () => undefined,
				setLyricsLoading: () => undefined,
				setLyricsError: () => undefined,
				resetLyrics: () => undefined,
				beatMapKeyForMap: () => "dj:test",
				initialLyricsPayload: null,
				initialPlaybackQuality: "standard",
				persistPlaybackQuality: () => undefined,
			});
			return null;
		}

		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		flushSync(() => root.render(<Harness />));
		for (let index = 0; index < 8 && loaded.length === 0; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(loaded).toEqual([source === "blob" ? localUrl : remoteUrl]);
		expect(seeks).toEqual([24_000]);
		expect(playCount).toBe(0);
		expect(checkpointConsumeCount).toBe(1);
		expect(playingWrites).toEqual([]);
		expect(coordinator.snapshot().phase).toBe("paused");
		flushSync(() => runtimeRef.current?.togglePlayback());
		await Promise.resolve();
		expect(playCount).toBe(1);
		flushSync(() => runtimeRef.current?.setPlaybackQuality("high"));
		for (let index = 0; index < 8 && loaded.length < 2; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(loaded.length).toBe(2);
		expect(playCount).toBe(2);

		root.unmount();
		host.remove();
	});
}

test("playing checkpoint is consumed once and a later paused reload stays paused", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const loaded: string[] = [];
	let playCount = 0;
	let pauseCount = 0;
	let checkpointConsumeCount = 0;
	let snapshotPlaying = true;
	const coordinator = new PlaybackSessionCoordinator();
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string) {
			loaded.push(url);
		},
		seek() {},
		async play() {
			playCount += 1;
			snapshotPlaying = true;
		},
		pause() {
			pauseCount += 1;
			snapshotPlaying = false;
		},
		stop() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/restored-playing.mp3",
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const checkpointRestore: PlaybackCheckpointRestoreAuthority = {
		operationId: "00000000000000000000000000000003",
		receipt: "10000000000000000000000000000003",
		playbackIntentId: 8,
		currentTrackRef: `${TRACK.provider}:${TRACK.id}`,
		wasPlaying: true,
		sourceKind: "remote",
		restartRestorable: true,
		autoplayDispositionConsumed: false,
	};

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 8,
			positionMs: 10_000,
			checkpointRestore,
			consumeCheckpointAutoplay: () => {
				checkpointConsumeCount += 1;
				return true;
			},
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 10_000,
				durationMs: 60_000,
				isPlaying: snapshotPlaying,
			}),
			setPlaying: (playing) => {
				snapshotPlaying = playing;
			},
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let index = 0; index < 8 && playCount === 0; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(loaded.length).toBe(1);
	expect(playCount).toBe(1);
	expect(checkpointConsumeCount).toBe(1);

	flushSync(() => runtimeRef.current?.togglePlayback());
	expect(pauseCount).toBe(1);
	expect(snapshotPlaying).toBe(false);
	flushSync(() => runtimeRef.current?.setPlaybackQuality("high"));
	for (let index = 0; index < 8 && loaded.length < 2; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(loaded.length).toBe(2);
	expect(playCount).toBe(1);
	expect(checkpointConsumeCount).toBe(1);

	root.unmount();
	host.remove();
});

for (const restoredPlayback of [
	{ label: "paused", wasPlaying: false },
	{ label: "playing", wasPlaying: true },
] as const) {
	test(`gapless adopted owner restores an exact ${restoredPlayback.label} checkpoint disposition`, async () => {
		await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
		resetPlaybackStore();
		const first: Track = {
			...TRACK,
			id: `checkpoint-${restoredPlayback.label}-first`,
			sourceId: `checkpoint-${restoredPlayback.label}-first`,
			album: "连续专辑",
			coverUrl: "https://img.example/checkpoint-adopt.jpg",
		};
		const second: Track = {
			...TRACK,
			id: `checkpoint-${restoredPlayback.label}-second`,
			sourceId: `checkpoint-${restoredPlayback.label}-second`,
			album: "连续专辑",
			coverUrl: "https://img.example/checkpoint-adopt.jpg",
		};
		usePlaybackStore.getState().setMode("queue");
		usePlaybackStore.getState().setQueue([first, second]);
		usePlaybackStore.getState().playAt(0);

		const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
			current: null,
		};
		const loads: Array<{ url: string; context: object | null }> = [];
		let adoptedContext: object | null = null;
		let adoptedUrl = "";
		let ordinaryPlayCount = 0;
		let preparedPlayCount = 0;
		let pauseCount = 0;
		let prepareCount = 0;
		let checkpointConsumeCount = 0;
		const preparedHandle = { abort() {} };
		const controller = {
			load(url: string, context?: object) {
				loads.push({ url, context: context ?? null });
			},
			seek() {},
			async play() {
				ordinaryPlayCount += 1;
			},
			pause() {
				pauseCount += 1;
				if (adoptedContext) {
					runtimeRef.current?.handleRuntimePause(
						mediaEventPayload(adoptedContext, adoptedUrl),
					);
				}
			},
			stop() {},
			prepareNext(url: string) {
				prepareCount += 1;
				adoptedUrl = url;
				return preparedHandle;
			},
			async playPrepared() {
				preparedPlayCount += 1;
			},
			adoptPrepared(handle: object, context: object) {
				expect(handle).toBe(preparedHandle);
				adoptedContext = context;
				runtimeRef.current?.handleRuntimeOwnerChange(
					ownerChangePayload(context, adoptedUrl, "adopted"),
				);
				return true;
			},
		} as unknown as PlayerController;
		const services = {
			music: {
				playback: {
					async resolveSongUrl(track: Track) {
						return {
							url: `https://media.example/${track.id}.mp3`,
							quality: "standard",
						};
					},
				},
				lyrics: {
					async lyric() {
						return await new Promise<LyricPayload>(() => undefined);
					},
				},
				discover: {},
			},
			mediaUrl: {
				audioProxyUrl: (url: string) => url,
				playableUrl: (url: string) => url,
			},
		} as unknown as AppServices;
		const checkpointRestore: PlaybackCheckpointRestoreAuthority = {
			operationId: restoredPlayback.wasPlaying
				? "00000000000000000000000000000004"
				: "00000000000000000000000000000005",
			receipt: restoredPlayback.wasPlaying
				? "10000000000000000000000000000004"
				: "10000000000000000000000000000005",
			playbackIntentId: 2,
			currentTrackRef: `${second.provider}:${second.id}`,
			wasPlaying: restoredPlayback.wasPlaying,
			sourceKind: "remote",
			restartRestorable: true,
			autoplayDispositionConsumed: false,
		};
		const controllerRef = { current: controller };
		const localAudioUrlsRef = { current: new Map<string, string>() };
		const noop = () => undefined;

		function Harness() {
			const currentTrack = usePlaybackStore((state) => state.currentTrack);
			const playbackIntentId = usePlaybackStore((state) => state.playbackIntentId);
			const positionMs = usePlaybackStore((state) => state.positionMs);
			const queue = usePlaybackStore((state) => state.queue);
			const mode = usePlaybackStore((state) => state.mode);
			const setPlaying = usePlaybackStore((state) => state.setPlaying);
			const setPositionMs = usePlaybackStore((state) => state.setPosition);
			const commitPreparedHandoff = usePlaybackStore(
				(state) => state.commitPreparedHandoff,
			);
			runtimeRef.current = usePlaybackSessionRuntime({
				appServices: services,
				controllerRef,
				localAudioUrlsRef,
				currentTrack,
				playbackIntentId,
				positionMs,
				checkpointRestore,
				consumeCheckpointAutoplay: () => {
					checkpointConsumeCount += 1;
					return true;
				},
				queue,
				playbackMode: mode,
				gaplessEnabled: true,
				crossfadeEnabled: true,
				commitPreparedHandoff,
				getPlaybackSnapshot: () => {
					const snapshot = usePlaybackStore.getState();
					return {
						currentTrack: snapshot.currentTrack,
						positionMs: snapshot.positionMs,
						durationMs: snapshot.durationMs,
						isPlaying: snapshot.isPlaying,
					};
				},
				setPlaying,
				setPositionMs,
				togglePlayFallback: noop,
				setSearchError: noop,
				showToast: noop,
				setHomeForcedOpen: noop,
				setHomeSuppressed: noop,
				setLyricsPayload: noop,
				setLyricsLoading: noop,
				setLyricsError: noop,
				resetLyrics: noop,
				beatMapKeyForMap: () => "dj:test",
				initialLyricsPayload: null,
				initialPlaybackQuality: "standard",
				persistPlaybackQuality: noop,
			});
			return null;
		}

		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		flushSync(() => root.render(<Harness />));
		for (let index = 0; index < 12 && loads.length < 1; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const outgoing = loads[0]!;
		runtimeRef.current!.handleRuntimeOwnerChange(
			ownerChangePayload(outgoing.context, outgoing.url),
		);
		runtimeRef.current!.handleRuntimeTimeUpdate({
			loadContext: outgoing.context,
			sourceUrl: outgoing.url,
			positionMs: 52_000,
			durationMs: 60_000,
		});
		for (let index = 0; index < 12 && prepareCount < 1; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		runtimeRef.current!.handleRuntimeTimeUpdate({
			loadContext: outgoing.context,
			sourceUrl: outgoing.url,
			positionMs: 59_200,
			durationMs: 60_000,
		});
		runtimeRef.current!.handleRuntimeEnded({
			loadContext: outgoing.context,
			sourceUrl: outgoing.url,
		});
		for (
			let index = 0;
			index < 16 && (!adoptedContext || checkpointConsumeCount < 1);
			index += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(usePlaybackStore.getState().currentTrack?.id).toBe(second.id);
		expect(loads.length).toBe(1);
		expect(ordinaryPlayCount).toBe(1);
		expect(preparedPlayCount).toBe(1);
		expect(checkpointConsumeCount).toBe(1);
		expect(pauseCount).toBe(restoredPlayback.wasPlaying ? 0 : 1);
		expect(usePlaybackStore.getState().isPlaying).toBe(restoredPlayback.wasPlaying);

		root.unmount();
		host.remove();
		resetPlaybackStore();
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function mediaEventPayload(
	loadContext: object | null,
	sourceUrl = "https://media.example/test.mp3",
): MediaEventPayload {
	return { loadContext, sourceUrl };
}

function ownerChangePayload(
	loadContext: object | null,
	sourceUrl: string,
	reason: OwnerChangePayload["reason"] = "play",
): OwnerChangePayload {
	const current = mediaEventPayload(loadContext, sourceUrl);
	return {
		...current,
		previous: null,
		current,
		reason,
	};
}

function errorEventPayload(
	loadContext: object | null,
	message: string,
	sourceUrl = "https://media.example/test.mp3",
): ErrorPayload {
	return { ...mediaEventPayload(loadContext, sourceUrl), code: 2, message };
}

class RuntimeAudioElement extends EventTarget {
	currentTime = 0;
	duration = 60;
	src = "";
	currentSrc = "";
	crossOrigin: string | null = null;
	volume = 1;
	paused = true;
	error: { code: number; message: string } | null = null;
	loadCalled = 0;
	playCalled = 0;
	private resolvePendingPlay!: () => void;
	private readonly pendingPlay = new Promise<void>((resolve) => {
		this.resolvePendingPlay = resolve;
	});

	constructor(private readonly blockFirstPlay = false) {
		super();
	}

	load(): void {
		this.loadCalled += 1;
	}

	play(): Promise<void> {
		this.playCalled += 1;
		this.paused = false;
		return this.playCalled === 1 && !this.blockFirstPlay
			? Promise.resolve()
			: this.pendingPlay;
	}

	pause(): void {
		this.paused = true;
	}

	releasePendingPlay(): void {
		this.resolvePendingPlay();
	}
}

function asHtmlAudioElement(audio: RuntimeAudioElement): HTMLAudioElement {
	return audio as unknown as HTMLAudioElement;
}

function resetPlaybackStore(): void {
	usePlaybackStore.setState({
		currentTrack: null,
		playbackIntentId: 0,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
		volume: 0.84,
		muted: false,
		mode: "loop",
		queue: [],
		checkpointRestore: null,
	});
}

test("a newer playback intent for the same track rejects the stale URL result", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstUrl = deferred<{
		url: string;
		quality: string;
	}>();
	const secondUrl = deferred<{
		url: string;
		quality: string;
		previewRange?: { startMs: number; endMs: number };
	}>();
	const loadedUrls: string[] = [];
	let playCount = 0;
	let resolveCount = 0;
	let lastLoadContext: object | null = null;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loadedUrls.push(url);
			lastLoadContext = loadContext ?? null;
		},
		seek() {},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return await (resolveCount === 1 ? firstUrl.promise : secondUrl.promise);
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ playbackIntentId }: { playbackIntentId: number }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness playbackIntentId={1} />));
	for (let i = 0; i < 8 && resolveCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => root.render(<Harness playbackIntentId={2} />));
	for (let i = 0; i < 8 && resolveCount < 2; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(resolveCount).toBe(2);
	firstUrl.resolve({
		url: "https://media.example/stale-intent.mp3",
		quality: "standard",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(loadedUrls).toEqual([]);
	expect(playCount).toBe(0);
	expect(runtimeRef.current?.trialBanner).toBeNull();

	secondUrl.resolve({
		url: "https://media.example/current-intent.mp3",
		quality: "standard",
		previewRange: { startMs: 0, endMs: 30000 },
	});
	for (let i = 0; i < 8 && playCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(loadedUrls).toEqual(["https://media.example/current-intent.mp3"]);
	expect(playCount).toBe(1);

	root.unmount();
	host.remove();
});

test("a quality change claims a new load in the current playback intent", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const requestedQualities: string[] = [];
	let playCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek() {},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(_track: Track, quality: string) {
					requestedQualities.push(quality);
					return {
						url: `https://media.example/quality-${quality}.mp3`,
						quality,
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && (loads.length < 1 || playCount < 1); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => runtimeRef.current!.setPlaybackQuality("flac"));
	for (let i = 0; i < 8 && (loads.length < 2 || playCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const firstHandle = loads[0]!.loadContext as {
		playbackSessionId: number;
		playbackToken: number;
		reloadReason?: string;
	};
	const qualityHandle = loads[1]!.loadContext as {
		playbackSessionId: number;
		playbackToken: number;
		reloadReason?: string;
	};
	expect(requestedQualities).toEqual(["standard", "flac"]);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/quality-standard.mp3",
		"https://media.example/quality-flac.mp3",
	]);
	expect(qualityHandle.playbackSessionId).toBe(firstHandle.playbackSessionId);
	expect(qualityHandle.playbackToken).toBeGreaterThan(firstHandle.playbackToken);
	expect(qualityHandle.reloadReason).toBe("quality");
	expect(playCount).toBe(2);

	root.unmount();
	host.remove();
});

test("a quality change waits for canonical preference commit before changing runtime state", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const committed = deferred<void>();
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: null,
			controllerRef: { current: null },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: null,
			playbackIntentId: 0,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: null,
				positionMs: 0,
				durationMs: null,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => committed.promise,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	let pending!: Promise<void>;
	flushSync(() => {
		pending = Promise.resolve(runtimeRef.current!.setPlaybackQuality("flac"));
	});
	expect(runtimeRef.current!.playbackQuality).toBe("standard");

	committed.resolve();
	await pending;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(runtimeRef.current!.playbackQuality).toBe("flac");

	root.unmount();
	host.remove();
});

test("a rejected quality preference commit leaves runtime quality unchanged", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: null,
			controllerRef: { current: null },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: null,
			playbackIntentId: 0,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: null,
				positionMs: 0,
				durationMs: null,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: async () => {
				throw new Error("quality preference failed");
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	let message = "";
	try {
		await Promise.resolve(runtimeRef.current!.setPlaybackQuality("flac"));
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}

	expect(message).toBe("quality preference failed");
	expect(runtimeRef.current!.playbackQuality).toBe("standard");

	root.unmount();
	host.remove();
});

test("a failed newer quality choice keeps the last successfully committed quality", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstCommit = deferred<void>();
	const secondCommit = deferred<void>();
	let commitCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: null,
			controllerRef: { current: null },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: null,
			playbackIntentId: 0,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: null,
				positionMs: 0,
				durationMs: null,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => {
				commitCount += 1;
				return commitCount === 1 ? firstCommit.promise : secondCommit.promise;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	const first = Promise.resolve(runtimeRef.current!.setPlaybackQuality("lossless"));
	const second = Promise.resolve(runtimeRef.current!.setPlaybackQuality("hires"));

	firstCommit.resolve();
	await first;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(runtimeRef.current!.playbackQuality).toBe("lossless");

	secondCommit.reject(new Error("newer quality failed"));
	let rejected = "";
	try {
		await second;
	} catch (error) {
		rejected = error instanceof Error ? error.message : String(error);
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(rejected).toBe("newer quality failed");
	expect(runtimeRef.current!.playbackQuality).toBe("lossless");

	root.unmount();
	host.remove();
});

test("lifecycle handlers forward only the authoritative load and end it once", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const timeUpdates: TimeUpdatePayload[] = [];
	const durationChanges: TimeUpdatePayload[] = [];
	let endedCount = 0;
	let resolveCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/lifecycle-${resolveCount}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ playbackIntentId }: { playbackIntentId: number }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onRuntimeTimeUpdate: (payload) => timeUpdates.push(payload),
			onRuntimeDurationChange: (payload) => durationChanges.push(payload),
			onRuntimeEnded: () => {
				endedCount += 1;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness playbackIntentId={1} />));
	for (let i = 0; i < 8 && loads.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const firstHandlers = runtimeRef.current!;
	const staleLoadContext = loads[0]!.loadContext;

	flushSync(() => root.render(<Harness playbackIntentId={2} />));
	for (
		let i = 0;
		i < 8 && loads.length < 2;
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const currentHandlers = runtimeRef.current!;
	const currentLoadContext = loads[1]!.loadContext;
	const forgedLoadContext = { ...(currentLoadContext as Record<string, unknown>) };
	const currentSourceUrl = loads[1]!.url;

	expect(typeof currentHandlers.handleRuntimeTimeUpdate).toBe("function");
	expect(typeof currentHandlers.handleRuntimeDurationChange).toBe("function");
	expect(typeof currentHandlers.handleRuntimeEnded).toBe("function");
	expect(typeof currentHandlers.handleRuntimeOwnerChange).toBe("function");
	expect(currentHandlers.handleRuntimeTimeUpdate).toBe(firstHandlers.handleRuntimeTimeUpdate);
	expect(currentHandlers.handleRuntimeDurationChange).toBe(firstHandlers.handleRuntimeDurationChange);
	expect(currentHandlers.handleRuntimeEnded).toBe(firstHandlers.handleRuntimeEnded);
	expect(currentHandlers.handleRuntimeOwnerChange).toBe(firstHandlers.handleRuntimeOwnerChange);

	expect(coordinator.snapshot().phase).toBe("loading");
	currentHandlers.handleRuntimePlay(
		mediaEventPayload(currentLoadContext, currentSourceUrl),
	);
	currentHandlers.handleRuntimeOwnerChange(
		ownerChangePayload(currentLoadContext, "https://media.example/wrong-owner.mp3"),
	);
	currentHandlers.handleRuntimeOwnerChange(
		ownerChangePayload(forgedLoadContext, currentSourceUrl),
	);
	expect(coordinator.snapshot().phase).toBe("loading");
	currentHandlers.handleRuntimeOwnerChange(
		ownerChangePayload(currentLoadContext, currentSourceUrl),
	);
	expect(coordinator.snapshot().phase).toBe("playing");

	const currentTimeUpdate: TimeUpdatePayload = {
		...mediaEventPayload(currentLoadContext, currentSourceUrl),
		positionMs: 12_345,
		durationMs: 60_000,
	};
	const currentDurationChange: TimeUpdatePayload = {
		...mediaEventPayload(currentLoadContext, currentSourceUrl),
		positionMs: 12_345,
		durationMs: 61_000,
	};
	for (const loadContext of [null, staleLoadContext, forgedLoadContext]) {
		currentHandlers.handleRuntimeTimeUpdate({
			...currentTimeUpdate,
			loadContext,
		});
		currentHandlers.handleRuntimeDurationChange({
			...currentDurationChange,
			loadContext,
		});
		currentHandlers.handleRuntimeEnded(mediaEventPayload(loadContext, currentSourceUrl));
	}
	currentHandlers.handleRuntimeTimeUpdate({
		...currentTimeUpdate,
		sourceUrl: "https://media.example/wrong-event-owner.mp3",
	});
	currentHandlers.handleRuntimeDurationChange({
		...currentDurationChange,
		sourceUrl: "https://media.example/wrong-event-owner.mp3",
	});
	currentHandlers.handleRuntimeEnded(
		mediaEventPayload(
			currentLoadContext,
			"https://media.example/wrong-event-owner.mp3",
		),
	);
	currentHandlers.handleRuntimeTimeUpdate(currentTimeUpdate);
	currentHandlers.handleRuntimeDurationChange(currentDurationChange);

	expect(timeUpdates).toEqual([currentTimeUpdate]);
	expect(timeUpdates[0]).toBe(currentTimeUpdate);
	expect(durationChanges).toEqual([currentDurationChange]);
	expect(durationChanges[0]).toBe(currentDurationChange);
	expect(endedCount).toBe(0);
	expect(coordinator.snapshot().phase).toBe("playing");

	const currentEnded = mediaEventPayload(currentLoadContext, currentSourceUrl);
	currentHandlers.handleRuntimeEnded(currentEnded);
	currentHandlers.handleRuntimeEnded(currentEnded);

	expect(endedCount).toBe(1);
	expect(coordinator.snapshot().phase).toBe("ended");

	root.unmount();
	host.remove();
});

test("single-mode ended starts exactly one replacement load and play", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	resetPlaybackStore();
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([TRACK]);
	store.playAt(0);

	const loads: Array<{ url: string; loadContext: object | null }> = [];
	const seekPositions: number[] = [];
	let playCount = 0;
	let resolveCount = 0;
	let finalizedCount = 0;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loads.push({ url, loadContext: loadContext ?? null });
		},
		seek(positionMs: number) {
			seekPositions.push(positionMs);
		},
		async play() {
			playCount += 1;
		},
		pause() {},
	} as unknown as PlayerController;
	const controllerRef = { current: controller as PlayerController | null };
	const lyricsPayloadRef = { current: null as LyricPayload | null };
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/single-${resolveCount}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const noOp = () => undefined;

	function Harness() {
		const currentTrack = usePlaybackStore((state) => state.currentTrack);
		const playbackIntentId = usePlaybackStore((state) => state.playbackIntentId);
		const positionMs = usePlaybackStore((state) => state.positionMs);
		const playbackMode = usePlaybackStore((state) => state.mode);
		const setPlaying = usePlaybackStore((state) => state.setPlaying);
		const setPositionMs = usePlaybackStore((state) => state.setPosition);
		const setDurationMs = usePlaybackStore((state) => state.setDuration);
		const setPlaybackMode = usePlaybackStore((state) => state.setMode);
		const setQueue = usePlaybackStore((state) => state.setQueue);
		const clearQueue = usePlaybackStore((state) => state.clearQueue);
		const rawLifecycle = usePlaybackUiController({
			controllerRef,
			lyricsPayloadRef,
			playbackMode,
			setPositionMs,
			setDurationMs,
			setLyricsIndex: noOp,
			setMiniQueue: noOp,
			insertQueueNext: noOp,
			setPlaybackMode,
			setQueue,
			clearQueue,
			recordListenProgress: noOp,
			finalizeListenSession: () => {
				finalizedCount += 1;
			},
			enterPlaybackSurface: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			clearCurrentBeatMap: noOp,
			applyCustomCoverImage: async () => undefined,
			showToast: noOp,
		});
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef,
			localAudioUrlsRef: rawLifecycle.localAudioUrlsRef,
			currentTrack,
			playbackIntentId,
			positionMs,
			getPlaybackSnapshot: () => {
				const snapshot = usePlaybackStore.getState();
				return {
					currentTrack: snapshot.currentTrack,
					positionMs: snapshot.positionMs,
					durationMs: snapshot.durationMs,
					isPlaying: snapshot.isPlaying,
				};
			},
			setPlaying,
			setPositionMs,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
			onRuntimeTimeUpdate: rawLifecycle.handleRuntimeTimeUpdate,
			onRuntimeDurationChange: rawLifecycle.handleRuntimeDurationChange,
			onRuntimeEnded: rawLifecycle.handleRuntimeEnded,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && (loads.length < 1 || playCount < 1); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.handleRuntimeOwnerChange(
		ownerChangePayload(loads[0]!.loadContext, loads[0]!.url),
	);

	flushSync(() => {
		runtimeRef.current!.handleRuntimeEnded(
			mediaEventPayload(loads[0]!.loadContext, loads[0]!.url),
		);
	});
	for (let i = 0; i < 8 && (loads.length < 2 || playCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(finalizedCount).toBe(1);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/single-1.mp3",
		"https://media.example/single-2.mp3",
	]);
	expect(playCount).toBe(2);
	expect(seekPositions).toEqual([]);

	root.unmount();
	host.remove();
	resetPlaybackStore();
});

test("the playback session publishes fallback lyrics before loading and resuming remote audio", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const events: string[] = [];
	const lyricPayloads: LyricPayload[] = [];
	let loadedUrl = "";
	let loadedContext: object | null = null;
	const controller = {
		load(url: string, context?: object) {
			loadedUrl = url;
			loadedContext = context ?? null;
			events.push(`load:${url}`);
		},
		seek(positionMs: number) {
			events.push(`seek:${positionMs}`);
		},
		async play() {
			events.push("play");
		},
		pause() {
			events.push("pause");
		},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/session-1.mp3",
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl(url: string) {
				return `http://127.0.0.1/audio-proxy?url=${encodeURIComponent(url)}`;
			},
			playableUrl(url: string) {
				return url;
			},
		},
	} as unknown as AppServices;
	let latest: PlaybackSessionRuntimeResult | null = null;

	function Harness() {
		latest = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 1_234,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 1_234,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: (open) => events.push(`home-forced:${open}`),
			setHomeSuppressed: (suppressed) => events.push(`home-suppressed:${suppressed}`),
			setLyricsPayload: (payload) => lyricPayloads.push(payload),
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));

	for (let i = 0; i < 12 && !events.includes("play"); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	latest!.handleRuntimeOwnerChange(
		ownerChangePayload(loadedContext, loadedUrl),
	);

	expect(latest).not.toBeNull();
	expect(lyricPayloads[0]?.trackId).toBe("session-1");
	expect(lyricPayloads[0]?.lines[0]?.text).toBe("Session Song - Session Artist");
	expect(events).toEqual([
		"load:https://media.example/session-1.mp3",
		"seek:1234",
		"play",
		"home-forced:false",
		"home-suppressed:true",
	]);

	root.unmount();
	host.remove();
});

test("a controller load failure marks the accepted source as terminally failed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	const terminalFailures: string[] = [];
	const playing: boolean[] = [];
	const controller = {
		load() {
			throw new Error("controller load failed");
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/load-failure.mp3",
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onPlaybackFailed: (track, intentId, message) => {
				terminalFailures.push(`${track.provider}:${track.id}:${intentId}:${message}`);
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "failed"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().failureReason).toBe("controller load failed");
	expect(playing.at(-1)).toBe(false);
	expect(searchErrors).toEqual(["controller load failed"]);
	expect(toasts).toEqual(["controller load failed"]);
	expect(terminalFailures).toEqual([
		"netease:session-1:1:controller load failed",
	]);

	root.unmount();
	host.remove();
});

test("a controller play rejection marks the accepted source as terminally failed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	const controller = {
		load() {},
		seek() {},
		async play() {
			throw new Error("controller play failed");
		},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					return {
						url: "https://media.example/play-failure.mp3",
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "failed"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(coordinator.snapshot().phase).toBe("failed");
	expect(coordinator.snapshot().failureReason).toBe("controller play failed");
	expect(searchErrors).toEqual(["controller play failed"]);
	expect(toasts).toEqual(["controller play failed"]);

	root.unmount();
	host.remove();
});

test("a stale lyric response cannot replace the next track fallback", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstLyric = deferred<LyricPayload>();
	const lyricPayloads: LyricPayload[] = [];
	const secondTrack: Track = {
		...TRACK,
		id: "session-2",
		sourceId: "session-2",
		title: "Second Song",
		artists: ["Second Artist"],
	};
	const controller = {
		load() {},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					if (track.id === TRACK.id) return await firstLyric.promise;
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	let activeTrack = TRACK;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: (payload) => lyricPayloads.push(payload),
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

	firstLyric.resolve({
		provider: "netease",
		trackId: TRACK.id,
		lines: [{ timeMs: 0, text: "Stale lyric", source: "lrc" }],
		hasTranslation: false,
		isWordByWord: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(lyricPayloads.at(-1)?.trackId).toBe(secondTrack.id);
	expect(lyricPayloads.at(-1)?.lines[0]?.text).toBe("Second Song - Second Artist");

	root.unmount();
	host.remove();
});

test("old controller events stay silent while the next track URL is pending", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const pendingSecondUrl = deferred<{
		url: string;
		quality: string;
	}>();
	const secondTrack: Track = {
		...TRACK,
		id: "session-pending",
		sourceId: "session-pending",
		title: "Pending Song",
	};
	const playing: boolean[] = [];
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	let runtimePauseCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	let secondResolveStarted = false;
	let activeTrack = TRACK;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					if (track.id === secondTrack.id) {
						secondResolveStarted = true;
						return await pendingSecondUrl.promise;
					}
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					return {
						provider: track.provider,
						trackId: track.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onRuntimePause: () => {
				runtimePauseCount += 1;
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "playing"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const firstSessionId = coordinator.snapshot().playbackSessionId;
	const oldEvents = {
		play: runtimeRef.current!.handleRuntimePlay,
		pause: runtimeRef.current!.handleRuntimePause,
		error: runtimeRef.current!.handleRuntimeError,
	};
	const oldLoadContext = loadedContext;
	const oldSourceUrl = loadedSourceUrl;
	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (
		let i = 0;
		i < 12 &&
		(!secondResolveStarted ||
			coordinator.snapshot().playbackSessionId === firstSessionId);
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const resolving = coordinator.snapshot();
	const playingCount = playing.length;
	expect(resolving.phase).toBe("resolving");
	expect(resolving.trackKey).toBe(`${secondTrack.provider}:${secondTrack.id}`);
	expect(secondResolveStarted).toBe(true);
	expect(loadCount).toBe(1);

	oldEvents.play(mediaEventPayload(oldLoadContext, oldSourceUrl));
	oldEvents.pause(mediaEventPayload(oldLoadContext, oldSourceUrl));
	oldEvents.error(errorEventPayload(oldLoadContext, "old media failed", oldSourceUrl));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(coordinator.snapshot()).toBe(resolving);
	expect(loadCount).toBe(1);
	expect(playing.length).toBe(playingCount);
	expect(runtimePauseCount).toBe(0);
	expect(searchErrors).toEqual([]);
	expect(toasts).toEqual([]);

	root.unmount();
	host.remove();
});

test("native events are accepted only after currentSrc matches the newly loaded source", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const coordinator = new PlaybackSessionCoordinator();
	const audio = new RuntimeAudioElement();
	const nextAudio = new RuntimeAudioElement(true);
	const controller = new PlayerController(asHtmlAudioElement(audio), {
		createAudioElement: () => asHtmlAudioElement(nextAudio),
	});
	const controllerRef = { current: controller as PlayerController | null };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const recoveryUrl = deferred<{
		url: string;
		quality: string;
	}>();
	const secondTrack: Track = {
		...TRACK,
		id: "session-bound",
		sourceId: "session-bound",
		title: "Bound Song",
	};
	const playing: boolean[] = [];
	const searchErrors: string[] = [];
	const toasts: string[] = [];
	let resolveCount = 0;
	let activeTrack = TRACK;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					resolveCount += 1;
					if (resolveCount >= 3) return await recoveryUrl.promise;
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return await new Promise<LyricPayload>(() => undefined);
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness({ track }: { track: Track }) {
		activeTrack = track;
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			coordinator,
			controllerRef,
			localAudioUrlsRef,
			currentTrack: track,
			playbackIntentId: track.id === TRACK.id ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: activeTrack,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: (value) => playing.push(value),
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: (message) => searchErrors.push(message),
			showToast: (message) => toasts.push(message),
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const unsubscribe = [
		controller.on("ownerchange", (payload) =>
			runtimeRef.current?.handleRuntimeOwnerChange(payload)),
		controller.on("play", (payload) =>
			runtimeRef.current?.handleRuntimePlay(payload)),
		controller.on("error", (payload) =>
			runtimeRef.current?.handleRuntimeError(payload)),
	];
	flushSync(() => root.render(<Harness track={TRACK} />));
	for (let i = 0; i < 12 && coordinator.snapshot().phase !== "playing"; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	audio.currentSrc = audio.src;
	const firstSourceUrl = audio.currentSrc;

	flushSync(() => root.render(<Harness track={secondTrack} />));
	for (
		let i = 0;
		i < 12 &&
		(nextAudio.playCalled < 1 ||
			nextAudio.src === firstSourceUrl ||
			coordinator.snapshot().phase !== "loading");
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const newSourceUrl = nextAudio.src;
	const loading = coordinator.snapshot();
	const playingCount = playing.length;
	const resolveCountBeforeOldEvents = resolveCount;
	audio.error = { code: 2, message: "late old source event" };

	audio.dispatchEvent(new Event("play"));
	audio.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(audio.currentSrc).toBe(firstSourceUrl);
	expect(newSourceUrl).not.toBe(firstSourceUrl);
	expect(coordinator.snapshot()).toBe(loading);
	expect(playing.length).toBe(playingCount);
	expect(resolveCount).toBe(resolveCountBeforeOldEvents);
	expect(searchErrors).toEqual([]);
	expect(toasts).toEqual([]);

	nextAudio.currentSrc = newSourceUrl;
	nextAudio.dispatchEvent(new Event("play"));
	nextAudio.releasePendingPlay();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(coordinator.snapshot().phase).toBe("playing");
	expect(playing.at(-1)).toBe(true);
	const acceptedPlaying = coordinator.snapshot();

	nextAudio.error = { code: 2, message: "current source event" };
	nextAudio.dispatchEvent(new Event("error"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(resolveCount).toBe(3);
	expect(coordinator.snapshot()).not.toBe(acceptedPlaying);
	expect(coordinator.snapshot().phase).toBe("recovering");

	audio.releasePendingPlay();
	recoveryUrl.resolve({
		url: "https://media.example/session-bound-recovery.mp3",
		quality: "standard",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const off of unsubscribe) off();
	root.unmount();
	host.remove();
});

test("media error 与 stalled 共用一次 fresh URL recovery 预算", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let resolveCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	const terminalFailures: string[] = [];
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = { current: null };
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: `https://media.example/recovery-${resolveCount}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric() {
					return {
						provider: TRACK.provider,
						trackId: TRACK.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 5_000,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 5_000,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
			onPlaybackFailed: (track, intentId, message) => {
				terminalFailures.push(`${track.id}:${intentId}:${message}`);
			},
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && loadCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const firstLoadContext = loadedContext;
	const firstSourceUrl = loadedSourceUrl;
	runtimeRef.current!.handleRuntimeError(
		errorEventPayload(firstLoadContext, "media failed", firstSourceUrl),
	);
	runtimeRef.current!.handleRuntimeError(
		errorEventPayload(firstLoadContext, "media failed again", firstSourceUrl),
	);
	runtimeRef.current!.handleRuntimeStalled({
		loadContext: firstLoadContext,
		sourceUrl: firstSourceUrl,
		probe: "late",
	});
	for (let i = 0; i < 8 && (resolveCount < 2 || loadCount < 2); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.handleRuntimeStalled({
		loadContext: loadedContext,
		sourceUrl: loadedSourceUrl,
		probe: "late",
	});
	for (let i = 0; i < 4; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(resolveCount).toBe(2);
	expect(terminalFailures).toEqual([
		"session-1:1:音频加载停滞",
	]);

	root.unmount();
	host.remove();
});

test("a trial media error clears the banner without resolving another source", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let resolveCount = 0;
	let loadCount = 0;
	let loadedContext: object | null = null;
	let loadedSourceUrl = "";
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = { current: null };
	const controller = {
		load(url: string, loadContext?: object) {
			loadCount += 1;
			loadedContext = loadContext ?? null;
			loadedSourceUrl = url;
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					return {
						url: "https://media.example/trial.mp3",
						quality: "standard",
						previewRange: { startMs: 0, endMs: 30_000 },
					};
				},
			},
			lyrics: {
				async lyric() {
					return {
						provider: TRACK.provider,
						trackId: TRACK.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;

	function Harness() {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && loadCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	// 预置一个横幅（模拟测量确认后的状态），验证媒体错误会清掉它
	runtimeRef.current?.setTrialBanner({
		text: "此歌曲为试听片段 · 完整版需要会员",
		provider: "netease",
		showLogin: false,
	});

	runtimeRef.current!.handleRuntimeError(errorEventPayload(
		loadedContext,
		"trial media failed",
		loadedSourceUrl,
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(resolveCount).toBe(1);
	expect(runtimeRef.current?.trialBanner).toBeNull();

	root.unmount();
	host.remove();
});

test("a local track loads its blob URL without calling playback or media ports", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const loadedUrls: string[] = [];
	let resolveCount = 0;
	const controller = {
		load(url: string) {
			loadedUrls.push(url);
		},
		seek() {},
		async play() {},
		pause() {},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl() {
					resolveCount += 1;
					throw new Error("local audio must not resolve remotely");
				},
			},
			lyrics: {},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl() {
				throw new Error("local audio must not use media ports");
			},
			playableUrl() {
				throw new Error("local audio must not use media ports");
			},
		},
	} as unknown as AppServices;

	function Harness() {
		usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: {
				current: new Map([[`${TRACK.provider}:${TRACK.id}`, "blob:session-1"]]),
			},
			currentTrack: TRACK,
			playbackIntentId: 1,
			positionMs: 0,
			getPlaybackSnapshot: () => ({
				currentTrack: TRACK,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: false,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && loadedUrls.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(loadedUrls).toEqual(["blob:session-1"]);
	expect(resolveCount).toBe(0);

	root.unmount();
	host.remove();
});

test("clearing the current track stops the physical runtime instead of only pausing it", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	let stopCount = 0;
	let pauseCount = 0;
	const controller = {
		stop() {
			stopCount += 1;
		},
		pause() {
			pauseCount += 1;
		},
	} as unknown as PlayerController;
	const controllerRef = { current: controller };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const noOp = () => undefined;
	const getPlaybackSnapshot = () => ({
		currentTrack: null,
		positionMs: 0,
		durationMs: null,
		isPlaying: false,
	});

	function Harness({ track }: { track: Track | null }) {
		usePlaybackSessionRuntime({
			appServices: null,
			controllerRef,
			localAudioUrlsRef,
			currentTrack: track,
			playbackIntentId: track ? 1 : 2,
			positionMs: 0,
			getPlaybackSnapshot,
			setPlaying: noOp,
			setPositionMs: noOp,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness track={TRACK} />));
	flushSync(() => root.render(<Harness track={null} />));

	expect(stopCount).toBe(1);
	expect(pauseCount).toBe(0);

	root.unmount();
	host.remove();
});

test("runtime event handlers keep stable identities when application services connect", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const results: PlaybackSessionRuntimeResult[] = [];
	const controllerRef = { current: null as PlayerController | null };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const getPlaybackSnapshot = () => ({
		currentTrack: null,
		positionMs: 0,
		durationMs: null,
		isPlaying: false,
	});
	const noOp = () => undefined;
	const services = {
		music: {},
		mediaUrl: {},
	} as unknown as AppServices;

	function Harness({ appServices }: { appServices: AppServices | null }) {
		results.push(usePlaybackSessionRuntime({
			appServices,
			controllerRef,
			localAudioUrlsRef,
			currentTrack: null,
			playbackIntentId: 0,
			positionMs: 0,
			getPlaybackSnapshot,
			setPlaying: noOp,
			setPositionMs: noOp,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap: () => "none",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
		}));
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness appServices={null} />));
	const before = results.at(-1)!;
	flushSync(() => root.render(<Harness appServices={services} />));
	const after = results.at(-1)!;

	expect(after.handleRuntimePlay).toBe(before.handleRuntimePlay);
	expect(after.handleRuntimePause).toBe(before.handleRuntimePause);
	expect(after.handleRuntimeTimeUpdate).toBe(before.handleRuntimeTimeUpdate);
	expect(after.handleRuntimeDurationChange).toBe(before.handleRuntimeDurationChange);
	expect(after.handleRuntimeOwnerChange).toBe(before.handleRuntimeOwnerChange);
	expect(after.handleRuntimeEnded).toBe(before.handleRuntimeEnded);
	expect(after.handleRuntimeError).toBe(before.handleRuntimeError);

	root.unmount();
	host.remove();
});

test("gapless 预加载只准备下一 deck，queue 变化立即收回且不改当前播放 UI", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const currentTrack: Track = {
		...TRACK,
		id: "album-first",
		sourceId: "album-first",
		album: "同一专辑",
		coverUrl: "https://img.example/album.jpg",
	};
	const nextTrack: Track = {
		...TRACK,
		id: "album-second",
		sourceId: "album-second",
		album: "同一专辑",
		coverUrl: "https://img.example/album.jpg",
	};
	const loads: Array<{ url: string; context: object | null }> = [];
	const preparedUrls: string[] = [];
	let playCount = 0;
	let readyCount = 0;
	let resolveCount = 0;
	let preparedAbortCount = 0;
	const preparedHandle = {
		abort() {
			preparedAbortCount += 1;
		},
	};
	const controller = {
		load(url: string, context?: object) {
			loads.push({ url, context: context ?? null });
		},
		seek() {},
		async play() {
			playCount += 1;
		},
		pause() {},
		prepareNext(url: string) {
			preparedUrls.push(url);
			return preparedHandle;
		},
		async playPrepared() {},
		adoptPrepared() {
			return true;
		},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					resolveCount += 1;
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					return {
						provider: track.provider,
						trackId: track.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controllerRef = { current: controller };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const getPlaybackSnapshot = () => ({
		currentTrack,
		positionMs: 0,
		durationMs: 60_000,
		isPlaying: true,
	});
	const noop = () => undefined;
	const commitPreparedHandoff = () => true;
	const beatMapKeyForMap = () => "dj:test";
	const onPlaybackReady = () => {
		readyCount += 1;
	};

	function Harness({ queue }: { queue: readonly Track[] }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef,
			localAudioUrlsRef,
			currentTrack,
			playbackIntentId: 1,
			positionMs: 0,
			queue,
			playbackMode: "queue",
			gaplessEnabled: true,
			crossfadeEnabled: true,
			commitPreparedHandoff,
			getPlaybackSnapshot,
			setPlaying: noop,
			setPositionMs: noop,
			togglePlayFallback: noop,
			setSearchError: noop,
			showToast: noop,
			setHomeForcedOpen: noop,
			setHomeSuppressed: noop,
			setLyricsPayload: noop,
			setLyricsLoading: noop,
			setLyricsError: noop,
			resetLyrics: noop,
			beatMapKeyForMap,
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noop,
			onPlaybackReady,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const initialQueue = [currentTrack, nextTrack];
	flushSync(() => root.render(<Harness queue={initialQueue} />));
	for (let i = 0; i < 12 && (loads.length < 1 || playCount < 1); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.handleRuntimeOwnerChange(
		ownerChangePayload(loads[0]!.context, loads[0]!.url),
	);
	expect(resolveCount).toBe(1);
	expect(readyCount).toBe(1);

	runtimeRef.current!.handleRuntimeTimeUpdate({
		loadContext: loads[0]!.context,
		sourceUrl: loads[0]!.url,
		positionMs: 52_000,
		durationMs: 60_000,
	});
	for (let i = 0; i < 12 && preparedUrls.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(resolveCount).toBe(2);
	expect(preparedUrls).toEqual(["https://media.example/album-second.mp3"]);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/album-first.mp3",
	]);
	expect(playCount).toBe(1);
	expect(readyCount).toBe(1);

	flushSync(() => root.render(
		<Harness
			queue={[
				currentTrack,
				{ ...nextTrack, id: "album-replacement", sourceId: "album-replacement" },
			]}
		/>,
	));
	for (let i = 0; i < 8 && preparedAbortCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(preparedAbortCount).toBe(1);

	root.unmount();
	host.remove();
});

test("prepared handoff 采用已播放 deck 且不二次 songUrl、load 或 play", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	resetPlaybackStore();
	const first: Track = {
		...TRACK,
		id: "adopt-first",
		sourceId: "adopt-first",
		album: "连续专辑",
		coverUrl: "https://img.example/adopt.jpg",
	};
	const second: Track = {
		...TRACK,
		id: "adopt-second",
		sourceId: "adopt-second",
		album: "连续专辑",
		coverUrl: "https://img.example/adopt.jpg",
	};
	usePlaybackStore.getState().setMode("queue");
	usePlaybackStore.getState().setQueue([first, second]);
	usePlaybackStore.getState().playAt(0);

	const loads: Array<{ url: string; context: object | null }> = [];
	const adoptedContexts: object[] = [];
	let resolveCount = 0;
	let ordinaryPlayCount = 0;
	let preparedPlayCount = 0;
	let prepareCount = 0;
	let readyCount = 0;
	let runtimeEndedCount = 0;
	let preparedUrl = "";
	const preparedHandle = { abort() {} };
	const controller = {
		load(url: string, context?: object) {
			loads.push({ url, context: context ?? null });
		},
		seek() {},
		async play() {
			ordinaryPlayCount += 1;
		},
		pause() {},
		prepareNext(url: string) {
			prepareCount += 1;
			preparedUrl = url;
			return preparedHandle;
		},
		async playPrepared() {
			preparedPlayCount += 1;
		},
		adoptPrepared(handle: object, context: object) {
			expect(handle).toBe(preparedHandle);
			adoptedContexts.push(context);
			runtimeRef.current?.handleRuntimeOwnerChange(
				ownerChangePayload(context, preparedUrl, "prepared"),
			);
			return true;
		},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					resolveCount += 1;
					return {
						url: `https://media.example/${track.id}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					return {
						provider: track.provider,
						trackId: track.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};
	const controllerRef = { current: controller };
	const localAudioUrlsRef = { current: new Map<string, string>() };
	const noOp = () => undefined;
	const getPlaybackSnapshot = () => {
		const snapshot = usePlaybackStore.getState();
		return {
			currentTrack: snapshot.currentTrack,
			positionMs: snapshot.positionMs,
			durationMs: snapshot.durationMs,
			isPlaying: snapshot.isPlaying,
		};
	};
	const beatMapKeyForMap = () => "dj:test";
	const onPlaybackReady = () => {
		readyCount += 1;
	};
	const onRuntimeEnded = () => {
		runtimeEndedCount += 1;
	};

	function Harness() {
		const currentTrack = usePlaybackStore((state) => state.currentTrack);
		const playbackIntentId = usePlaybackStore((state) => state.playbackIntentId);
		const queue = usePlaybackStore((state) => state.queue);
		const mode = usePlaybackStore((state) => state.mode);
		const positionMs = usePlaybackStore((state) => state.positionMs);
		const setPlaying = usePlaybackStore((state) => state.setPlaying);
		const setPositionMs = usePlaybackStore((state) => state.setPosition);
		const commitPreparedHandoff = usePlaybackStore(
			(state) => state.commitPreparedHandoff,
		);
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef,
			localAudioUrlsRef,
			currentTrack,
			playbackIntentId,
			positionMs,
			queue,
			playbackMode: mode,
			gaplessEnabled: true,
			crossfadeEnabled: true,
			commitPreparedHandoff,
			getPlaybackSnapshot,
			setPlaying,
			setPositionMs,
			togglePlayFallback: noOp,
			setSearchError: noOp,
			showToast: noOp,
			setHomeForcedOpen: noOp,
			setHomeSuppressed: noOp,
			setLyricsPayload: noOp,
			setLyricsLoading: noOp,
			setLyricsError: noOp,
			resetLyrics: noOp,
			beatMapKeyForMap,
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: noOp,
			onPlaybackReady,
			onRuntimeEnded,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 12 && loads.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const outgoing = loads[0]!;
	runtimeRef.current!.handleRuntimeOwnerChange(
		ownerChangePayload(outgoing.context, outgoing.url),
	);
	runtimeRef.current!.handleRuntimeTimeUpdate({
		loadContext: outgoing.context,
		sourceUrl: outgoing.url,
		positionMs: 52_000,
		durationMs: 60_000,
	});
	for (let i = 0; i < 12 && prepareCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.handleRuntimeTimeUpdate({
		loadContext: outgoing.context,
		sourceUrl: outgoing.url,
		positionMs: 59_200,
		durationMs: 60_000,
	});
	runtimeRef.current!.handleRuntimeEnded({
		loadContext: outgoing.context,
		sourceUrl: outgoing.url,
	});
	for (
		let i = 0;
		i < 16 && usePlaybackStore.getState().currentTrack?.id !== second.id;
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (let i = 0; i < 8 && adoptedContexts.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(usePlaybackStore.getState().currentTrack?.id).toBe(second.id);
	expect(resolveCount).toBe(2);
	expect(loads.map((load) => load.url)).toEqual([
		"https://media.example/adopt-first.mp3",
	]);
	expect(ordinaryPlayCount).toBe(1);
	expect(preparedPlayCount).toBe(1);
	expect(adoptedContexts.length).toBe(1);
	expect(readyCount).toBe(2);
	expect(runtimeEndedCount).toBe(0);

	root.unmount();
	host.remove();
	resetPlaybackStore();
});

test("新手动 intent 会取消迟到的 gapless candidate 预加载", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const first: Track = {
		...TRACK,
		id: "manual-first",
		sourceId: "manual-first",
		album: "手动切换专辑",
		coverUrl: "https://img.example/manual.jpg",
	};
	const second: Track = {
		...TRACK,
		id: "manual-second",
		sourceId: "manual-second",
		album: "手动切换专辑",
		coverUrl: "https://img.example/manual.jpg",
	};
	const pendingCandidate = deferred<{
		url: string;
		quality: string;
	}>();
	const loads: string[] = [];
	let firstResolveCount = 0;
	let candidateResolveCount = 0;
	let prepareCount = 0;
	let currentLoadContext: object | null = null;
	const controller = {
		load(url: string, context?: object) {
			loads.push(url);
			currentLoadContext = context ?? null;
		},
		seek() {},
		async play() {},
		pause() {},
		prepareNext() {
			prepareCount += 1;
			return { abort() {} };
		},
		async playPrepared() {},
		adoptPrepared() {
			return true;
		},
	} as unknown as PlayerController;
	const services = {
		music: {
			playback: {
				async resolveSongUrl(track: Track) {
					if (track.id === second.id) {
						candidateResolveCount += 1;
						return pendingCandidate.promise;
					}
					firstResolveCount += 1;
					return {
						url: `https://media.example/manual-first-${firstResolveCount}.mp3`,
						quality: "standard",
					};
				},
			},
			lyrics: {
				async lyric(track: Track) {
					return {
						provider: track.provider,
						trackId: track.id,
						lines: [],
						hasTranslation: false,
						isWordByWord: false,
					};
				},
			},
			discover: {},
		},
		mediaUrl: {
			audioProxyUrl: (url: string) => url,
			playableUrl: (url: string) => url,
		},
	} as unknown as AppServices;
	const runtimeRef: { current: PlaybackSessionRuntimeResult | null } = {
		current: null,
	};

	function Harness({ intentId }: { intentId: number }) {
		runtimeRef.current = usePlaybackSessionRuntime({
			appServices: services,
			controllerRef: { current: controller },
			localAudioUrlsRef: { current: new Map() },
			currentTrack: first,
			playbackIntentId: intentId,
			positionMs: 0,
			queue: [first, second],
			playbackMode: "queue",
			gaplessEnabled: true,
			crossfadeEnabled: true,
			commitPreparedHandoff: () => true,
			getPlaybackSnapshot: () => ({
				currentTrack: first,
				positionMs: 0,
				durationMs: 60_000,
				isPlaying: true,
			}),
			setPlaying: () => undefined,
			setPositionMs: () => undefined,
			togglePlayFallback: () => undefined,
			setSearchError: () => undefined,
			showToast: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			setLyricsPayload: () => undefined,
			setLyricsLoading: () => undefined,
			setLyricsError: () => undefined,
			resetLyrics: () => undefined,
			beatMapKeyForMap: () => "dj:test",
			initialLyricsPayload: null,
			initialPlaybackQuality: "standard",
			persistPlaybackQuality: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness intentId={1} />));
	for (let i = 0; i < 12 && loads.length < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const firstSession = loads[0]!;
	const coordinator = runtimeRef.current;
	coordinator!.handleRuntimeTimeUpdate({
		loadContext: currentLoadContext,
		sourceUrl: firstSession,
		positionMs: 52_000,
		durationMs: 60_000,
	});
	for (let i = 0; i < 8 && candidateResolveCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	flushSync(() => root.render(<Harness intentId={2} />));
	pendingCandidate.resolve({
		url: "https://media.example/manual-second-late.mp3",
		quality: "standard",
	});
	for (
		let i = 0;
		i < 12 && (firstResolveCount < 2 || loads.length < 2);
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(firstResolveCount).toBe(2);
	expect(candidateResolveCount).toBe(1);
	expect(prepareCount).toBe(0);
	expect(loads).toEqual([
		"https://media.example/manual-first-1.mp3",
		"https://media.example/manual-first-2.mp3",
	]);

	root.unmount();
	host.remove();
});
