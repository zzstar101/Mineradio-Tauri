import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import {
	ensureLyricFallbackPayload,
	type LyricPayload,
	type PlaybackQualityRequest,
	type ProviderId,
	type SongUrlResult,
	type Track,
	type TrackQualityOption,
} from "@mineradio/shared";
import type {
	ErrorPayload,
	MediaEventPayload,
	OwnerChangePayload,
	PlayerController,
	PlaybackReadinessPayload,
	TimeUpdatePayload,
} from "../../audio/player-controller";
import type { AppServices } from "../../app/app-services";
import { getCustomLyricTextForTrack, resolveLyricsForTrack } from "../../lyrics/custom-lyrics";
import type {
	ConsumePlaybackCheckpointAutoplayRequest,
	PlaybackCheckpointRestoreAuthority,
} from "../../stores/playback-store";
import { usePlaybackStore } from "../../stores/playback-store";
import type { JsonValue } from "../../tauri/runtime";
import {
	PlaybackSessionCoordinator,
	type PlaybackLoadHandle,
	type PlaybackReloadReason,
} from "./playback-session-coordinator";
import { resolvePlayableAudio } from "./resolve-playable-audio";
import {
	buildTrialBanner,
	crossSourceFailureBannerText,
	evaluatePreviewResult,
} from "./preview-trial";
import {
	GaplessPlaybackController,
	type GaplessPreparedHandle,
} from "./gapless-playback-controller";

export interface CurrentBeatMapState {
	key: string;
	map: JsonValue;
}

export type { TrialBannerState } from "../../stores/playback-store";
import type { TrialBannerState } from "../../stores/playback-store";

export interface PlaybackSessionSnapshot {
	currentTrack: Track | null;
	positionMs: number;
	durationMs: number | null;
	isPlaying: boolean;
}

/**
 * Persistent local-library bridge (Tauri only). Session blob URLs always win;
 * the library registry resolves protocol URLs and on-demand lyrics.
 */
export interface LocalLibraryPlaybackBridge {
	getLocalAudioUrl(key: string): string | null;
	getLocalMeta(key: string): { localFileId: string; hasLyric: boolean } | null;
	isLibraryTrackKey(key: string): boolean;
	cachedLyric(key: string): LyricPayload | null;
	loadLyric(
		key: string,
		guards: {
			expectedQueueKey: string;
			currentQueueKey(): string;
			isCurrent(): boolean;
		},
	): Promise<{ payload: LyricPayload | null; rejected: boolean }>;
}

export interface PlaybackSessionRuntimeOptions {
	appServices: AppServices | null;
	coordinator?: PlaybackSessionCoordinator;
	controllerRef: RefObject<PlayerController | null>;
	localAudioUrlsRef: RefObject<Map<string, string>>;
	localLibrary?: LocalLibraryPlaybackBridge | null;
	currentTrack: Track | null;
	playbackIntentId: number;
	positionMs: number;
	checkpointRestore?: PlaybackCheckpointRestoreAuthority | null;
	consumeCheckpointAutoplay?(
		request: ConsumePlaybackCheckpointAutoplayRequest,
	): boolean;
	queue?: readonly Track[];
	playbackMode?: string;
	gaplessEnabled?: boolean;
	crossfadeEnabled?: boolean;
	commitPreparedHandoff?(request: {
		candidate: Track;
		expectedPlaybackIntentId: number;
		expectedOutgoingTrackRef: string;
	}): boolean;
	getPlaybackSnapshot(): PlaybackSessionSnapshot;
	setPlaying(playing: boolean): void;
	setPositionMs(positionMs: number): void;
	togglePlayFallback(): void;
	setSearchError(message: string): void;
	showToast(message: string): void;
	setHomeForcedOpen(open: boolean): void;
	setHomeSuppressed(suppressed: boolean): void;
	setLyricsPayload(payload: LyricPayload): void;
	setLyricsLoading(loading: boolean): void;
	setLyricsError(message: string): void;
	resetLyrics(): void;
	beatMapKeyForMap(map: JsonValue, source: string): string;
	initialLyricsPayload: LyricPayload | null;
	initialPlaybackQuality: PlaybackQualityRequest;
	persistPlaybackQuality(
		quality: PlaybackQualityRequest,
	): Promise<void> | void;
	now?: () => number;
	onRuntimePause?: () => void;
	onRuntimeTimeUpdate?(payload: TimeUpdatePayload): void;
	onRuntimeDurationChange?(payload: TimeUpdatePayload): void;
	onRuntimeEnded?(): void;
	onPlaybackReady?(track: Track, playbackIntentId: number): void;
	onPlaybackFailed?(track: Track, playbackIntentId: number, message: string): void;
}

export interface PlaybackSessionRuntimeResult {
	playbackQuality: PlaybackQualityRequest;
	trackQualityOptions: TrackQualityOption[];
	trialBanner: TrialBannerState | null;
	setTrialBanner(banner: TrialBannerState | null): void;
	currentBeatMapState: CurrentBeatMapState | null;
	originalLyricsPayloadRef: RefObject<LyricPayload | null>;
	clearCurrentBeatMap(): void;
	dismissTrialBanner(): void;
	setPlaybackQuality(quality: PlaybackQualityRequest): Promise<void> | void;
	togglePlayback(): void;
	handleRuntimeTimeUpdate(payload: TimeUpdatePayload): void;
	handleRuntimeDurationChange(payload: TimeUpdatePayload): void;
	handleRuntimeOwnerChange(payload: OwnerChangePayload): void;
	handleRuntimePlay(payload: MediaEventPayload): void;
	handleRuntimePause(payload: MediaEventPayload): void;
	handleRuntimeEnded(payload: MediaEventPayload): void;
	handleRuntimeError(payload: ErrorPayload): void;
	handleRuntimeStalled(payload: PlaybackReadinessPayload): void;
}

function playbackKeyForTrack(track: Track | null | undefined): string {
	return track ? `${track.provider}:${track.id}` : "";
}

function buildTrackLyricFallback(track: Track): LyricPayload {
	return ensureLyricFallbackPayload({
		provider: track.provider,
		trackId: track.id,
		lines: [],
		hasTranslation: false,
		isWordByWord: false,
	}, track);
}

function toJsonValue(value: unknown): JsonValue | null {
	if (value == null) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue;
	} catch {
		return null;
	}
}

function isPodcastTrack(track: Track | null | undefined): boolean {
	const record = track as unknown as Record<string, unknown> | null | undefined;
	return record?.type === "podcast" || record?.source === "podcast";
}

export function shouldAutoplayPlaybackLoad(
	checkpointRestore: PlaybackCheckpointRestoreAuthority | null | undefined,
	track: Track | null | undefined,
	playbackIntentId: number,
	consumedLocally = false,
	currentIsPlaying = true,
): boolean {
	if (!checkpointRestore) return true;
	const exact = checkpointRestore.playbackIntentId === playbackIntentId
		&& checkpointRestore.currentTrackRef === playbackKeyForTrack(track);
	if (!exact) return true;
	if (checkpointRestore.autoplayDispositionConsumed || consumedLocally) {
		return currentIsPlaying;
	}
	return checkpointRestore.wasPlaying;
}

function exactCheckpointAutoplayKey(
	checkpointRestore: PlaybackCheckpointRestoreAuthority | null | undefined,
	track: Track | null | undefined,
	playbackIntentId: number,
): string | null {
	if (
		!checkpointRestore
		|| checkpointRestore.playbackIntentId !== playbackIntentId
		|| checkpointRestore.currentTrackRef !== playbackKeyForTrack(track)
	) return null;
	return [
		checkpointRestore.operationId,
		checkpointRestore.receipt,
		String(playbackIntentId),
		checkpointRestore.currentTrackRef,
	].join("\u0000");
}

interface GaplessCapablePlayerController {
	prepareNext(url: string, loadContext?: object): GaplessPreparedHandle;
	prerollPrepared?(
		handle: GaplessPreparedHandle,
		options?: { isCurrent?: () => boolean },
	): Promise<void>;
	playPrepared(
		handle: GaplessPreparedHandle,
		options?: {
			crossfade?: boolean;
			durationMs?: number;
			isCurrent?: () => boolean;
		},
	): Promise<void>;
	adoptPrepared(handle: GaplessPreparedHandle, loadContext: object): boolean;
}

function gaplessCapableController(
	controller: PlayerController | null,
): GaplessCapablePlayerController | null {
	if (!controller) return null;
	const candidate = controller as unknown as Partial<GaplessCapablePlayerController>;
	if (
		typeof candidate.prepareNext !== "function" ||
		typeof candidate.playPrepared !== "function" ||
		typeof candidate.adoptPrepared !== "function"
	) {
		return null;
	}
	return candidate as GaplessCapablePlayerController;
}

export function usePlaybackSessionRuntime({
	appServices,
	coordinator: providedCoordinator,
	controllerRef,
	localAudioUrlsRef,
	localLibrary = null,
	currentTrack,
	playbackIntentId,
	positionMs,
	checkpointRestore = null,
	consumeCheckpointAutoplay: consumeCheckpointAutoplayAuthority,
	queue = [],
	playbackMode = "queue",
	gaplessEnabled = false,
	crossfadeEnabled = true,
	commitPreparedHandoff,
	getPlaybackSnapshot,
	setPlaying,
	setPositionMs,
	togglePlayFallback,
	setSearchError,
	showToast,
	setHomeForcedOpen,
	setHomeSuppressed,
	setLyricsPayload,
	setLyricsLoading,
	setLyricsError,
	resetLyrics,
	beatMapKeyForMap,
	initialLyricsPayload,
	initialPlaybackQuality,
	persistPlaybackQuality,
	now = Date.now,
	onRuntimePause,
	onRuntimeTimeUpdate,
	onRuntimeDurationChange,
	onRuntimeEnded,
	onPlaybackReady,
	onPlaybackFailed,
}: PlaybackSessionRuntimeOptions): PlaybackSessionRuntimeResult {
	const [playbackQuality, setPlaybackQualityState] = useState(initialPlaybackQuality);
	const [playbackQualityReloadHandle, setPlaybackQualityReloadHandle] =
		useState<PlaybackLoadHandle | null>(null);
	const playbackQualityReloadAutoplayRef = useRef<boolean | null>(null);
	const [trackQualityOptions, setTrackQualityOptions] = useState<TrackQualityOption[]>([]);
	const trialBanner = usePlaybackStore((state) => state.trialBanner);
	const setTrialBanner = usePlaybackStore((state) => state.setTrialBanner);
	const [currentBeatMapState, setCurrentBeatMapState] =
		useState<CurrentBeatMapState | null>(null);
	const [gaplessRuntimeEpoch, setGaplessRuntimeEpoch] = useState(0);
	const coordinatorRef = useRef<PlaybackSessionCoordinator | null>(null);
	if (!coordinatorRef.current) {
		coordinatorRef.current = providedCoordinator ?? new PlaybackSessionCoordinator();
	}
	const coordinator = coordinatorRef.current;
	const positionRef = useRef(positionMs);
	positionRef.current = positionMs;
	const originalLyricsPayloadRef = useRef<LyricPayload | null>(initialLyricsPayload);
	const reloadCurrentTrackAndPlayRef = useRef<
		(options: { preservePosition: boolean; reason: PlaybackReloadReason }) => Promise<boolean>
	>(async () => false);
	const gaplessInputsRef = useRef({
		appServices,
		controllerRef,
		localAudioUrlsRef,
		localLibrary,
		currentTrack,
		playbackIntentId,
		queue,
		playbackMode,
		gaplessEnabled,
		crossfadeEnabled,
		commitPreparedHandoff,
		playbackQuality,
	});
	gaplessInputsRef.current = {
		appServices,
		controllerRef,
		localAudioUrlsRef,
		localLibrary,
		currentTrack,
		playbackIntentId,
		queue,
		playbackMode,
		gaplessEnabled,
		crossfadeEnabled,
		commitPreparedHandoff,
		playbackQuality,
	};
	const gaplessControllerRef = useRef<
		GaplessPlaybackController<Track, GaplessPreparedHandle> | null
	>(null);
	const createGaplessController = () =>
		new GaplessPlaybackController<Track, GaplessPreparedHandle>({
			getContext: () => {
				const inputs = gaplessInputsRef.current;
				const activeTrack = inputs.currentTrack;
				const activeKey = playbackKeyForTrack(activeTrack);
				const currentIndex = activeTrack
					? inputs.queue.findIndex(
						(track) =>
							track === activeTrack || playbackKeyForTrack(track) === activeKey,
					)
					: -1;
				return {
					enabled:
						inputs.gaplessEnabled &&
						!!activeTrack &&
						!!inputs.commitPreparedHandoff &&
						!!gaplessCapableController(inputs.controllerRef.current),
					crossfade: inputs.crossfadeEnabled,
					queue: inputs.queue,
					currentIndex,
					mode: inputs.playbackMode,
					sessionId: coordinator.snapshot().playbackSessionId,
					intentId: inputs.playbackIntentId,
				};
			},
			resolve: async (candidate) => {
				const inputs = gaplessInputsRef.current;
				if (isPodcastTrack(candidate)) {
					throw new Error("podcast 不参与 gapless 预加载");
				}
				const key = playbackKeyForTrack(candidate);
				// 解析顺序：session blob 优先，其次持久本地库协议 URL。
				const localUrl = inputs.localAudioUrlsRef.current.get(key)
					?? inputs.localLibrary?.getLocalAudioUrl(key)
					?? null;
				if (localUrl) return { audioUrl: localUrl, rawUrl: localUrl };
				const services = inputs.appServices;
				if (!services) throw new Error("gapless playback service unavailable");
				const { result, audioUrl } = await resolvePlayableAudio({
					playback: services.music.playback,
					mediaUrl: services.mediaUrl,
					track: candidate,
					quality: inputs.playbackQuality,
				});
				if (result.previewRange) {
					throw new Error("preview-range 音频降级到普通 next");
				}
				return { audioUrl, rawUrl: result.url };
			},
			prepareNext: (url, context) => {
				const controller = gaplessCapableController(
					gaplessInputsRef.current.controllerRef.current,
				);
				if (!controller) throw new Error("gapless player controller unavailable");
				return controller.prepareNext(url, context);
			},
			prerollPrepared: (handle, options) => {
				const controller = gaplessCapableController(
					gaplessInputsRef.current.controllerRef.current,
				);
				if (!controller?.prerollPrepared) return Promise.resolve();
				return controller.prerollPrepared(handle, {
					isCurrent: options.isCurrent,
				});
			},
			playPrepared: (handle, options) => {
				const controller = gaplessCapableController(
					gaplessInputsRef.current.controllerRef.current,
				);
				if (!controller) throw new Error("gapless player controller unavailable");
				return controller.playPrepared(handle, {
					crossfade: options.crossfadeMs > 0,
					durationMs: options.crossfadeMs,
					isCurrent: options.isCurrent,
				}).finally(() => {
					globalThis.setTimeout(() => {
						setGaplessRuntimeEpoch((current) => current + 1);
					}, 0);
				});
			},
			commitPreparedHandoff: (request) => {
				const commit = gaplessInputsRef.current.commitPreparedHandoff;
				if (!commit) return false;
				return commit({
					candidate: request.candidate,
					expectedPlaybackIntentId: request.expectedIntentId,
					expectedOutgoingTrackRef: request.expectedOutgoingTrackKey,
				});
			},
			onCommitted: () => {
				setGaplessRuntimeEpoch((current) => current + 1);
			},
		});
	if (
		!gaplessControllerRef.current ||
		gaplessControllerRef.current.diagnostics().disposed
	) {
		gaplessControllerRef.current = createGaplessController();
	}
	useEffect(() => {
		const runtime = gaplessControllerRef.current?.diagnostics().disposed
			? createGaplessController()
			: gaplessControllerRef.current;
		if (runtime) gaplessControllerRef.current = runtime;
		return () => runtime?.dispose();
	}, []);
	useEffect(() => {
		// queue/mode/gapless authority 在 React 状态提交后立即收回，不等待下一次媒体事件。
		gaplessControllerRef.current?.reconcileContext();
	}, [
		commitPreparedHandoff,
		controllerRef,
		currentTrack,
		gaplessEnabled,
		playbackIntentId,
		playbackMode,
		queue,
	]);

	const loadBeatMap = useCallback((
		services: AppServices,
		track: Track,
		rawUrl: string,
		loadHandle: PlaybackLoadHandle,
	) => {
		if (!isPodcastTrack(track)) return;
		void Promise.resolve().then(() => services.music.discover.podcastDjBeatmap(
			rawUrl,
			Math.max(
				0,
				Number(track.durationMs ?? getPlaybackSnapshot().durationMs ?? 0) / 1_000,
			),
			0,
		)).then((beatmap) => {
			if (!coordinator.isPlaybackCurrent(loadHandle)) return;
			const map = toJsonValue(beatmap.map);
			setCurrentBeatMapState(map ? {
				key: beatMapKeyForMap(map, "dj"),
				map,
			} : null);
		}).catch(() => {
			if (coordinator.isPlaybackCurrent(loadHandle)) {
				setCurrentBeatMapState(null);
			}
		});
	}, [beatMapKeyForMap, coordinator, getPlaybackSnapshot]);

	const reloadCurrentTrackAndPlay = useCallback(async ({
		preservePosition,
		reason,
	}: {
		preservePosition: boolean;
		reason: PlaybackReloadReason;
	}): Promise<boolean> => {
		const controller = controllerRef.current;
		const services = appServices;
		const track = getPlaybackSnapshot().currentTrack;
		if (!controller || !services || !track) return false;

		const key = playbackKeyForTrack(track);
		if (
			!key
			|| localAudioUrlsRef.current.has(key)
			|| localLibrary?.isLibraryTrackKey(key)
		) return false;

		const reload = coordinator.beginReload(reason);
		if (!reload) return false;
		setTrialBanner(null);
		usePlaybackStore.getState().setPreviewRange(null);
		const resumeAt = preservePosition
			? Math.max(0, getPlaybackSnapshot().positionMs)
			: 0;

		let sourceAccepted = false;
		try {
			const { result, audioUrl } = await resolvePlayableAudio({
				playback: services.music.playback,
				mediaUrl: services.mediaUrl,
				track,
				quality: playbackQuality,
			});
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			// 权限整合已下放客户端：结果只带 previewRange；是否真为试听由时长测量确认
			setTrialBanner(null);
			usePlaybackStore.getState().setPreviewRange(result.previewRange ?? null);
			if (!coordinator.markLoaded(reload, {
				trackKey: key,
				quality: playbackQuality,
				resolvedAtMs: now(),
				audioUrl,
				rawUrl: result.url,
				local: false,
				trial: Boolean(result.previewRange), // 疑似试听不参与 gapless
			})) {
				// 加载被拒：回滚试听区间，避免过期解析污染状态
				usePlaybackStore.getState().setPreviewRange(null);
				return false;
			}
			sourceAccepted = true;
			controller.load(audioUrl, reload);
			coordinator.completeReload(reload);
			loadBeatMap(services, track, result.url, reload);
			if (resumeAt > 0) {
				setPositionMs(resumeAt);
				controller.seek(resumeAt);
			}
			await controller.play();
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			return coordinator.snapshot().phase === "playing";
		} catch (error) {
			if (!coordinator.isPlaybackCurrent(reload)) return false;
			const message = error instanceof Error ? error.message : "playback error";
			const accepted = sourceAccepted
				? coordinator.markMediaFailed(reload, message)
				: coordinator.markResolveFailed(reload, message);
			if (!accepted) return false;
			setTrialBanner(null);
			setPlaying(false);
			setSearchError(message);
			// 跨源后仍无音源：按 track 权限状态给出明确文案横幅
			if (message.includes("试听片段")) {
				setTrialBanner({ text: message, provider: track.provider, showLogin: false });
			} else {
				setTrialBanner({
					text: crossSourceFailureBannerText(track.playableState),
					provider: track.provider,
					showLogin: false,
				});
			}
			showToast(message);
			runtimeLifecycleCallbacksRef.current.onPlaybackFailed?.(
				track,
				playbackIntentId,
				message,
			);
			return false;
		}
	}, [
		appServices,
		controllerRef,
		coordinator,
		getPlaybackSnapshot,
		loadBeatMap,
		localAudioUrlsRef,
		localLibrary,
		now,
		playbackIntentId,
		playbackQuality,
		setHomeForcedOpen,
		setHomeSuppressed,
		setPlaying,
		setPositionMs,
		setSearchError,
		showToast,
	]);
	reloadCurrentTrackAndPlayRef.current = reloadCurrentTrackAndPlay;
	const currentEventLoad = useCallback((payload: MediaEventPayload) => {
		const loadContext = payload.loadContext;
		if (!loadContext) return null;
		const handle = loadContext as PlaybackLoadHandle;
		return coordinator.isCurrentLoadedSource(handle, payload.sourceUrl)
			? handle
			: null;
	}, [coordinator]);
	const runtimeLifecycleCallbacksRef = useRef({
		onRuntimeTimeUpdate,
		onRuntimeDurationChange,
		onRuntimeEnded,
		onPlaybackReady,
		onPlaybackFailed,
	});
	const consumedCheckpointAutoplayRef = useRef(new Set<string>());
	runtimeLifecycleCallbacksRef.current = {
		onRuntimeTimeUpdate,
		onRuntimeDurationChange,
		onRuntimeEnded,
		onPlaybackReady,
		onPlaybackFailed,
	};

	const handleRuntimeTimeUpdate = useCallback((payload: TimeUpdatePayload) => {
		if (!currentEventLoad(payload)) return;
		runtimeLifecycleCallbacksRef.current.onRuntimeTimeUpdate?.(payload);
		const durationMs = payload.durationMs;
		if (durationMs == null || !Number.isFinite(durationMs)) return;
		const remainingSeconds = Math.max(0, durationMs - payload.positionMs) / 1_000;
		void gaplessControllerRef.current?.onTimeUpdate(remainingSeconds);
	}, [currentEventLoad]);

	const handleRuntimeDurationChange = useCallback((payload: TimeUpdatePayload) => {
		if (!currentEventLoad(payload)) return;
		runtimeLifecycleCallbacksRef.current.onRuntimeDurationChange?.(payload);
	}, [currentEventLoad]);

	const handleRuntimeEnded = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		const finishOrdinaryEnded = () => {
			if (!coordinator.isPlaybackCurrent(boundLoad)) return;
			if (!coordinator.markEnded(boundLoad)) return;
			runtimeLifecycleCallbacksRef.current.onRuntimeEnded?.();
		};
		if (!gaplessInputsRef.current.gaplessEnabled) {
			finishOrdinaryEnded();
			return;
		}
		const gaplessRuntime = gaplessControllerRef.current;
		if (!gaplessRuntime) {
			finishOrdinaryEnded();
			return;
		}
		void gaplessRuntime.onEnded().then((handled) => {
			if (!handled) finishOrdinaryEnded();
		}).catch(() => {
			finishOrdinaryEnded();
		});
	}, [coordinator, currentEventLoad]);

	const handleRuntimeErrorImpl = useCallback((payload: ErrorPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		const message = payload.message || "音频播放失败";
		const track = getPlaybackSnapshot().currentTrack;
		const key = playbackKeyForTrack(track);
		const previousState = coordinator.snapshot();
		if (
			coordinator.claimMediaErrorRecovery(
				boundLoad,
				key,
				!!appServices?.music.playback,
			)
		) {
			setTrialBanner(null);
			void reloadCurrentTrackAndPlayRef.current({
				preservePosition: true,
				reason: "media-error",
			});
			return;
		}
		if (coordinator.snapshot() === previousState) return;
		setTrialBanner(null);
		setSearchError(message);
		showToast(message);
		if (track) {
			runtimeLifecycleCallbacksRef.current.onPlaybackFailed?.(
				track,
				playbackIntentId,
				message,
			);
		}
	}, [
		appServices,
		coordinator,
		currentEventLoad,
		getPlaybackSnapshot,
		playbackIntentId,
		setSearchError,
		showToast,
	]);
	const handleRuntimeErrorRef = useRef(handleRuntimeErrorImpl);
	handleRuntimeErrorRef.current = handleRuntimeErrorImpl;
	const handleRuntimeError = useCallback((payload: ErrorPayload) => {
		handleRuntimeErrorRef.current(payload);
	}, []);
	const handleRuntimeStalled = useCallback((payload: PlaybackReadinessPayload) => {
		// 只有 Runtime 的 3.6s late probe 会进入这里；沿用当前 load 的
		// 单次 fresh URL 恢复预算，避免建立第二套无限 stalled retry。
		handleRuntimeErrorRef.current({
			...payload,
			code: 0,
			message: "音频加载停滞",
		});
	}, []);

	const togglePlayback = useCallback(() => {
		const snapshot = getPlaybackSnapshot();
		if (!snapshot.currentTrack) {
			showToast("先搜索或打开歌单选择一首歌");
			return;
		}
		const controller = controllerRef.current;
		if (!controller) {
			togglePlayFallback();
			return;
		}
		if (snapshot.isPlaying) {
			controller.pause();
			return;
		}
		const reason = coordinator.refreshReason(now());
		if (reason) {
			void reloadCurrentTrackAndPlayRef.current({
				preservePosition: true,
				reason,
			});
			return;
		}
		void controller.play();
	}, [controllerRef, coordinator, getPlaybackSnapshot, now, showToast, togglePlayFallback]);

	const handleRuntimePlay = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		if (coordinator.snapshot().phase !== "paused") return;
		if (!coordinator.markPlaying(boundLoad)) return;
		setPlaying(true);
	}, [coordinator, currentEventLoad, setPlaying]);

	const handleRuntimeOwnerChangeImpl = useCallback((payload: OwnerChangePayload) => {
		const current = payload.current;
		if (
			payload.loadContext !== current.loadContext ||
			payload.sourceUrl !== current.sourceUrl ||
			payload.generation !== current.generation ||
			payload.deckId !== current.deckId
		) return;
		const loadContext = current.loadContext;
		if (!loadContext) return;
		const handle = loadContext as PlaybackLoadHandle;
		if (!coordinator.markOwnerPlaying(handle, current.sourceUrl)) return;
		setPlaying(true);
		const track = getPlaybackSnapshot().currentTrack;
		if (track) {
			runtimeLifecycleCallbacksRef.current.onPlaybackReady?.(
				track,
				playbackIntentId,
			);
		}
		setHomeForcedOpen(false);
		setHomeSuppressed(true);
	}, [
		coordinator,
		getPlaybackSnapshot,
		playbackIntentId,
		setHomeForcedOpen,
		setHomeSuppressed,
		setPlaying,
	]);
	const handleRuntimeOwnerChangeRef = useRef(handleRuntimeOwnerChangeImpl);
	handleRuntimeOwnerChangeRef.current = handleRuntimeOwnerChangeImpl;
	const handleRuntimeOwnerChange = useCallback((payload: OwnerChangePayload) => {
		handleRuntimeOwnerChangeRef.current(payload);
	}, []);

	const handleRuntimePause = useCallback((payload: MediaEventPayload) => {
		const boundLoad = currentEventLoad(payload);
		if (!boundLoad) return;
		if (!coordinator.markPaused(boundLoad, now())) return;
		onRuntimePause?.();
		setPlaying(false);
	}, [coordinator, currentEventLoad, now, onRuntimePause, setPlaying]);

	const setPlaybackQuality = useCallback((quality: PlaybackQualityRequest) => {
		const applyCommittedQuality = () => {
			// Repository 串行提交；每次成功提交都成为新的权威值，失败项不发布。
			setPlaybackQualityState(quality);
			const snapshot = getPlaybackSnapshot();
			if (!snapshot.currentTrack) {
				showToast("音质偏好已保存，下次播放生效");
				return;
			}
			const resumeAt = controllerRef.current ? snapshot.positionMs : 0;
			if (resumeAt > 0) controllerRef.current?.pause();
			const qualityReload = coordinator.invalidateCurrentTrackLoad();
			if (qualityReload) {
				playbackQualityReloadAutoplayRef.current = snapshot.isPlaying;
				setPlaybackQualityReloadHandle(qualityReload);
			}
			setPositionMs(resumeAt);
			showToast("正在切换音质");
		};
		const committed = persistPlaybackQuality(quality);
		if (committed && typeof committed.then === "function") {
			return Promise.resolve(committed).then(applyCommittedQuality);
		}
		applyCommittedQuality();
	}, [
		controllerRef,
		coordinator,
		getPlaybackSnapshot,
		persistPlaybackQuality,
		setPositionMs,
		showToast,
	]);

	useEffect(() => {
		const track = currentTrack;
		const playback = appServices?.music.playback;
		const key = playbackKeyForTrack(track);
		if (
			!track
			|| !playback
			|| !key
			|| localAudioUrlsRef.current.has(key)
			|| localLibrary?.isLibraryTrackKey(key)
		) {
			setTrackQualityOptions((current) =>
				current.length > 0 ? [] : current,
			);
			return;
		}
		let cancelled = false;
		void Promise.resolve().then(() => playback.trackQualities(track)).then((availability) => {
			if (cancelled) return;
			const qualities = availability.qualities;
			setTrackQualityOptions(qualities);
			const selectedAvailable = qualities.some(
				(quality) => quality.requestQuality === playbackQuality,
			);
			const fallbackQuality = availability.defaultQuality ?? qualities[0]?.requestQuality;
			if (!selectedAvailable && fallbackQuality) setPlaybackQuality(fallbackQuality);
		}).catch(() => {
			if (!cancelled) {
				setTrackQualityOptions((current) =>
					current.length > 0 ? [] : current,
				);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [
		appServices,
		currentTrack,
		localAudioUrlsRef,
		localLibrary,
		playbackQuality,
		setPlaybackQuality,
	]);

	useEffect(() => {
		const controller = controllerRef.current;
		const services = appServices;
		if (!controller) return;
		const gaplessRuntime = gaplessControllerRef.current;
		const adopted = gaplessRuntime?.takeAdopted() ?? null;
		const abortAdopted = () => {
			if (!adopted) return;
			try {
				adopted.handle.abort();
			} catch {
				// 已提交 deck 的清理由 PlayerController 尽力完成。
			}
		};
		if (!currentTrack) {
			abortAdopted();
			gaplessRuntime?.invalidate("playback-stopped");
			coordinator.clear();
			setCurrentBeatMapState(null);
			setTrialBanner(null);
			controller.stop();
			resetLyrics();
			return;
		}

		const key = playbackKeyForTrack(currentTrack);
		const checkpointAutoplayKey = exactCheckpointAutoplayKey(
			checkpointRestore,
			currentTrack,
			playbackIntentId,
		);
		const checkpointAutoplayConsumedLocally = !!(
			checkpointAutoplayKey
			&& consumedCheckpointAutoplayRef.current.has(checkpointAutoplayKey)
		);
		const currentPlaybackIntentIsPlaying = playbackQualityReloadHandle
			? (playbackQualityReloadAutoplayRef.current
				?? getPlaybackSnapshot().isPlaying)
			: getPlaybackSnapshot().isPlaying;
		const shouldAutoplay = shouldAutoplayPlaybackLoad(
			checkpointRestore,
			currentTrack,
			playbackIntentId,
			checkpointAutoplayConsumedLocally,
			currentPlaybackIntentIsPlaying,
		);
		const consumeQualityReloadAutoplayIntent = () => {
			if (playbackQualityReloadHandle) {
				playbackQualityReloadAutoplayRef.current = null;
			}
		};
		const consumeCheckpointAutoplayDisposition = () => {
			if (
				!checkpointRestore
				|| !checkpointAutoplayKey
				|| checkpointRestore.autoplayDispositionConsumed
				|| checkpointAutoplayConsumedLocally
			) return;
			consumedCheckpointAutoplayRef.current.add(checkpointAutoplayKey);
			consumeCheckpointAutoplayAuthority?.({
				operationId: checkpointRestore.operationId,
				receipt: checkpointRestore.receipt,
				playbackIntentId,
				currentTrackRef: checkpointRestore.currentTrackRef,
			});
		};
		// 解析顺序：session blob 优先（不变），其次本地库协议 URL。
		const localAudioUrl = localAudioUrlsRef.current.get(key)
			?? localLibrary?.getLocalAudioUrl(key)
			?? null;
		if (!adopted) {
			const diagnostics = gaplessRuntime?.diagnostics();
			if (diagnostics?.phase === "handoff") {
				// store commit 会先触发 React；等待 controller 发布 adopted handle。
				return;
			}
		}
		const adoptedMatches = !!(
			adopted &&
			playbackKeyForTrack(adopted.candidate) === key &&
			playbackIntentId === adopted.expectedIntentId + 1 &&
			!playbackQualityReloadHandle
		);
		if (!adoptedMatches) {
			abortAdopted();
			gaplessRuntime?.invalidate("playback-intent-changed");
		}
		if (!adoptedMatches && !localAudioUrl && !services) return;
		const session = coordinator.beginTrack(
			key,
			playbackIntentId,
			playbackQualityReloadHandle ?? undefined,
		);
		if (!session) {
			if (adoptedMatches) {
				abortAdopted();
				gaplessRuntime?.invalidate("adopt-session-rejected");
			}
			return;
		}
		setCurrentBeatMapState(null);
		setTrialBanner(null);
		const fallbackLyric = buildTrackLyricFallback(currentTrack);
		originalLyricsPayloadRef.current = fallbackLyric;
		const resolvedFallbackLyric = resolveLyricsForTrack({
			track: currentTrack,
			original: fallbackLyric,
			durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
		});
		setLyricsPayload(resolvedFallbackLyric.payload);

		// Upstream applyLocalTrackLyricOnDemand：本地库曲目按需读歌词。
		// 本代码库里 fallback 歌词在分支前已同步落位（无 pending 定时器可取消），
		// 因此这里只需在 fallback 之后按需拉取并经现有 pathway 应用（persist=false：
		// 只写 originalLyricsPayloadRef + lyrics store，不触碰 custom-lyrics 存储）。
		const applyLocalLibraryLyricOnDemand = (
			track: Track,
			trackKey: string,
			session: PlaybackLoadHandle,
		): void => {
			if (!localLibrary) return;
			const meta = localLibrary.getLocalMeta(trackKey);
			if (!meta || !meta.hasLyric) return;
			// 用户自定义歌词优先，保持现有 pathway 已应用的结果。
			if (getCustomLyricTextForTrack(track)) return;
			const applyFetchedLyric = (payload: LyricPayload): void => {
				// 生成 token（session handle）+ 队列键身份双守卫。
				if (!coordinator.isLyricCurrent(session)) return;
				if (playbackKeyForTrack(getPlaybackSnapshot().currentTrack) !== trackKey) return;
				originalLyricsPayloadRef.current = payload;
				const resolved = resolveLyricsForTrack({
					track,
					original: payload,
					durationMs: getPlaybackSnapshot().durationMs ?? track.durationMs,
				});
				setLyricsPayload(resolved.payload);
			};
			const cached = localLibrary.cachedLyric(trackKey);
			if (cached) {
				applyFetchedLyric(cached);
				return;
			}
			void Promise.resolve()
				.then(() => localLibrary.loadLyric(trackKey, {
					expectedQueueKey: trackKey,
					currentQueueKey: () =>
						playbackKeyForTrack(getPlaybackSnapshot().currentTrack),
					isCurrent: () => coordinator.isLyricCurrent(session),
				}))
				.then((result) => {
					if (result.rejected) return; // 失败/取消 → 静默留在 fallback
					if (result.payload) applyFetchedLyric(result.payload);
				})
				.catch(() => undefined);
		};

		if (adopted && adoptedMatches) {
			const capableController = gaplessCapableController(controller);
			const adoptedIsLocal = !!(
				localAudioUrl &&
				(adopted.source.audioUrl === localAudioUrl ||
					adopted.source.rawUrl === localAudioUrl)
			);
			const adoptedSource = {
				trackKey: key,
				quality: playbackQuality,
				resolvedAtMs: now(),
				audioUrl: adopted.source.audioUrl,
				rawUrl: adopted.source.rawUrl,
				local: adoptedIsLocal,
				trial: false,
			};
			const sourceAccepted = shouldAutoplay
				? coordinator.markLoaded(session, adoptedSource)
				: coordinator.markLoadedPaused(session, adoptedSource, now());
			const mediaAdopted = !!(
				sourceAccepted &&
				capableController?.adoptPrepared(adopted.handle, session)
			);
			gaplessRuntime?.invalidate(
				mediaAdopted ? "prepared-adopted" : "prepared-adopt-failed",
			);
			if (!mediaAdopted) {
				abortAdopted();
				const message = "gapless prepared deck adoption failed";
				if (sourceAccepted) coordinator.markMediaFailed(session, message);
				setPlaying(false);
				setSearchError(message);
				showToast(message);
				runtimeLifecycleCallbacksRef.current.onPlaybackFailed?.(
					currentTrack,
					playbackIntentId,
					message,
				);
				return;
			}
			if (!shouldAutoplay) controller.pause();
			consumeQualityReloadAutoplayIntent();
			consumeCheckpointAutoplayDisposition();

			setTrialBanner(null);
			if (adoptedIsLocal) {
				setLyricsLoading(false);
				if (localAudioUrl) applyLocalLibraryLyricOnDemand(currentTrack, key, session);
				return;
			}
			if (!services) return;
			void (async () => {
				try {
					setLyricsLoading(true);
					const lyric = ensureLyricFallbackPayload(
						await services.music.lyrics.lyric(currentTrack),
						currentTrack,
					);
					if (!coordinator.isLyricCurrent(session)) return;
					originalLyricsPayloadRef.current = lyric;
					const resolvedLyric = resolveLyricsForTrack({
						track: currentTrack,
						original: lyric,
						durationMs:
							getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
					});
					setLyricsPayload(resolvedLyric.payload);
				} catch (error) {
					if (!coordinator.isLyricCurrent(session)) return;
					const message =
						error instanceof Error ? error.message : "lyrics failed";
					const fallback = buildTrackLyricFallback(currentTrack);
					originalLyricsPayloadRef.current = fallback;
					const resolvedLyric = resolveLyricsForTrack({
						track: currentTrack,
						original: fallback,
						durationMs:
							getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
					});
					setLyricsPayload(resolvedLyric.payload);
					setLyricsError(message);
				}
			})();
			return;
		}

		if (localAudioUrl) {
			void (async () => {
				let sourceAccepted = false;
				try {
					const source = {
						trackKey: key,
						quality: playbackQuality,
						resolvedAtMs: now(),
						audioUrl: localAudioUrl,
						rawUrl: localAudioUrl,
						local: true,
						trial: false,
					};
					const sourceAcceptedByCoordinator = shouldAutoplay
						? coordinator.markLoaded(session, source)
						: coordinator.markLoadedPaused(session, source, now());
					if (!sourceAcceptedByCoordinator) return;
					sourceAccepted = true;
					consumeQualityReloadAutoplayIntent();
					controller.load(localAudioUrl, session);
					if (positionRef.current > 0) controller.seek(positionRef.current);
					consumeCheckpointAutoplayDisposition();
					if (shouldAutoplay) await controller.play();
					if (!coordinator.isPlaybackCurrent(session)) return;
					setLyricsLoading(false);
					applyLocalLibraryLyricOnDemand(currentTrack, key, session);
				} catch (error) {
					if (!coordinator.isPlaybackCurrent(session)) return;
					const message = error instanceof Error ? error.message : "playback error";
					const accepted = sourceAccepted
						? coordinator.markMediaFailed(session, message)
						: coordinator.markResolveFailed(session, message);
					if (!accepted) return;
					setPlaying(false);
					setSearchError(message);
					showToast(message);
					setTrialBanner({
						text: crossSourceFailureBannerText(currentTrack?.playableState ?? "unavailable"),
						provider: currentTrack?.provider ?? "netease",
						showLogin: false,
					});
					runtimeLifecycleCallbacksRef.current.onPlaybackFailed?.(
						currentTrack,
						playbackIntentId,
						message,
					);
				}
			})();
			return;
		}

		if (!services) return;
		void (async () => {
			let sourceAccepted = false;
			try {
				const { result, audioUrl } = await resolvePlayableAudio({
					playback: services.music.playback,
					mediaUrl: services.mediaUrl,
					track: currentTrack,
					quality: playbackQuality,
				});
				if (!coordinator.isPlaybackCurrent(session)) return;
				setTrialBanner(null);
				const source = {
					trackKey: key,
					quality: playbackQuality,
					resolvedAtMs: now(),
					audioUrl,
					rawUrl: result.url,
					local: false,
					trial: Boolean(result.previewRange), // 疑似试听不参与 gapless
				};
				usePlaybackStore.getState().setPreviewRange(result.previewRange ?? null);
				const sourceAcceptedByCoordinator = shouldAutoplay
					? coordinator.markLoaded(session, source)
					: coordinator.markLoadedPaused(session, source, now());
				if (!sourceAcceptedByCoordinator) {
					// 加载被拒：回滚试听区间
					usePlaybackStore.getState().setPreviewRange(null);
					return;
				}
				sourceAccepted = true;
				consumeQualityReloadAutoplayIntent();
				controller.load(audioUrl, session);
				loadBeatMap(services, currentTrack, result.url, session);
				if (positionRef.current > 0) controller.seek(positionRef.current);
				consumeCheckpointAutoplayDisposition();
				if (shouldAutoplay) await controller.play();
				if (!coordinator.isPlaybackCurrent(session)) return;
			} catch (error) {
				if (!coordinator.isPlaybackCurrent(session)) return;
				const message = error instanceof Error ? error.message : "playback error";
				const accepted = sourceAccepted
					? coordinator.markMediaFailed(session, message)
					: coordinator.markResolveFailed(session, message);
				if (!accepted) return;
				setTrialBanner(null);
				setPlaying(false);
				setSearchError(message);
				showToast(message);
				runtimeLifecycleCallbacksRef.current.onPlaybackFailed?.(
					currentTrack,
					playbackIntentId,
					message,
				);
			}

			try {
				setLyricsLoading(true);
				const lyric = ensureLyricFallbackPayload(
					await services.music.lyrics.lyric(currentTrack),
					currentTrack,
				);
				if (!coordinator.isLyricCurrent(session)) return;
				originalLyricsPayloadRef.current = lyric;
				const resolvedLyric = resolveLyricsForTrack({
					track: currentTrack,
					original: lyric,
					durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
				});
				setLyricsPayload(resolvedLyric.payload);
			} catch (error) {
				if (!coordinator.isLyricCurrent(session)) return;
				const message = error instanceof Error ? error.message : "lyrics failed";
				const fallback = buildTrackLyricFallback(currentTrack);
				originalLyricsPayloadRef.current = fallback;
				const resolvedLyric = resolveLyricsForTrack({
					track: currentTrack,
					original: fallback,
					durationMs: getPlaybackSnapshot().durationMs ?? currentTrack.durationMs,
				});
				setLyricsPayload(resolvedLyric.payload);
				setLyricsError(message);
			}
		})();
	}, [
		appServices,
		controllerRef,
		checkpointRestore,
		consumeCheckpointAutoplayAuthority,
		coordinator,
		currentTrack,
		getPlaybackSnapshot,
		gaplessRuntimeEpoch,
		loadBeatMap,
		localAudioUrlsRef,
		localLibrary,
		now,
		playbackIntentId,
		playbackQuality,
		playbackQualityReloadHandle,
		resetLyrics,
		setHomeForcedOpen,
		setHomeSuppressed,
		setLyricsError,
		setLyricsLoading,
		setLyricsPayload,
		setPlaying,
		setSearchError,
		showToast,
	]);

	return {
		playbackQuality,
		trackQualityOptions,
		trialBanner,
		setTrialBanner,
		currentBeatMapState,
		originalLyricsPayloadRef,
		clearCurrentBeatMap: () => setCurrentBeatMapState(null),
		dismissTrialBanner: () => setTrialBanner(null),
		setPlaybackQuality,
		togglePlayback,
		handleRuntimeTimeUpdate,
		handleRuntimeDurationChange,
		handleRuntimeOwnerChange,
		handleRuntimePlay,
		handleRuntimePause,
		handleRuntimeEnded,
		handleRuntimeError,
		handleRuntimeStalled,
	};
}
