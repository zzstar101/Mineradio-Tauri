import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ProviderId, Track } from "@mineradio/shared";
import type { PlayerController, TimeUpdatePayload } from "../../audio/player-controller";
import {
	LOCAL_AUDIO_ACCEPT,
	createLocalAudioTrack,
	firstLocalAudioFile,
	firstLocalCoverFile,
} from "../../audio/local-audio-import";
import { withStoredCustomCover } from "../../cover/custom-cover";
import type { LyricPayload } from "@mineradio/shared";
import { selectCurrentIndex } from "../../lyrics/select-current-index";
import { usePlaybackStore } from "../../stores/playback-store";

export { LOCAL_AUDIO_ACCEPT };

export interface PlaybackUiControllerResult {
	fileInputRef: RefObject<HTMLInputElement | null>;
	localAudioUrlsRef: RefObject<Map<string, string>>;
	openLocalFileImport(): void;
	importLocalFiles(files: FileList | File[] | null): void;
	playMiniQueueIndex(index: number): void;
	insertMiniQueueNext(index: number): void;
	cyclePlaylistPanelMode(): void;
	shufflePlaylistPanelQueue(): void;
	clearPlaylistPanelQueue(): void;
	seekPlayback(position: number): void;
	handleRuntimeTimeUpdate(payload: TimeUpdatePayload): void;
	handleRuntimeDurationChange(payload: TimeUpdatePayload): void;
	handleRuntimeEnded(): void;
}

export function usePlaybackUiController({
	controllerRef,
	lyricsPayloadRef,
	playbackMode,
	setPositionMs,
	setDurationMs,
	setLyricsIndex,
	setMiniQueue,
	insertQueueNext,
	setPlaybackMode,
	setQueue,
	clearQueue,
	recordListenProgress,
	finalizeListenSession,
	enterPlaybackSurface,
	setHomeForcedOpen,
	setHomeSuppressed,
	clearCurrentBeatMap,
	applyCustomCoverImage,
	showToast,
	streamNext,
}: {
	controllerRef: RefObject<PlayerController | null>;
	lyricsPayloadRef: RefObject<LyricPayload | null>;
	playbackMode: "queue" | "loop" | "single" | "shuffle";
	setPositionMs(position: number): void;
	setDurationMs(duration: number | null): void;
	setLyricsIndex(index: number): void;
	setMiniQueue(open: boolean): void;
	insertQueueNext(track: Track): void;
	setPlaybackMode(mode: "queue" | "loop" | "single" | "shuffle"): void;
	setQueue(tracks: Track[]): void;
	clearQueue(): void;
	recordListenProgress(positionMs: number, durationMs: number | null): void;
	finalizeListenSession(completed?: boolean): void;
	enterPlaybackSurface(): void;
	setHomeForcedOpen(open: boolean): void;
	setHomeSuppressed(suppressed: boolean): void;
	clearCurrentBeatMap(): void;
	applyCustomCoverImage(file: Blob, track?: Track): Promise<void>;
	showToast(message: string): void;
	/** 缺省时视为不支持流式续播，ended 直接走普通队列前进 */
	streamNext?(provider: ProviderId, id: string): Promise<Track>;
}): PlaybackUiControllerResult {
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const localAudioUrlsRef = useRef(new Map<string, string>());
	const lastRuntimeDurationRef = useRef<number | null>(null);
	/** 流式电台续拉单飞闸门：ended 事件可能连发，进行中忽略重入 */
	const streamFetchInFlightRef = useRef(false);
	const dependenciesRef = useRef({
		playbackMode,
		setPositionMs,
		setDurationMs,
		setLyricsIndex,
		setMiniQueue,
		insertQueueNext,
		setPlaybackMode,
		setQueue,
		clearQueue,
		recordListenProgress,
		finalizeListenSession,
		enterPlaybackSurface,
		setHomeForcedOpen,
		setHomeSuppressed,
		clearCurrentBeatMap,
		applyCustomCoverImage,
		showToast,
		streamNext,
	});
	dependenciesRef.current = {
		playbackMode,
		setPositionMs,
		setDurationMs,
		setLyricsIndex,
		setMiniQueue,
		insertQueueNext,
		setPlaybackMode,
		setQueue,
		clearQueue,
		recordListenProgress,
		finalizeListenSession,
		enterPlaybackSurface,
		setHomeForcedOpen,
		setHomeSuppressed,
		clearCurrentBeatMap,
		applyCustomCoverImage,
		showToast,
		streamNext,
	};

	const openLocalFileImport = useCallback(() => {
		const current = dependenciesRef.current;
		current.setHomeForcedOpen(false);
		current.setHomeSuppressed(false);
		fileInputRef.current?.click();
	}, []);

	const importLocalFiles = useCallback((files: FileList | File[] | null) => {
		if (!files) return;
		const current = dependenciesRef.current;
		const file = firstLocalAudioFile(files);
		const coverFile = firstLocalCoverFile(files);
		if (!file && !coverFile) {
			current.showToast("请选择音频或图片文件");
			return;
		}
		if (file) {
			const url = URL.createObjectURL(file);
			const track = withStoredCustomCover(createLocalAudioTrack(file));
			const key = `${track.provider}:${track.id}`;
			const previousUrl = localAudioUrlsRef.current.get(key);
			if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
			localAudioUrlsRef.current.set(key, url);
			usePlaybackStore.getState().setQueue([track]);
			usePlaybackStore.getState().playAt(0);
			current.enterPlaybackSurface();
			current.clearCurrentBeatMap();
			current.showToast(track.title);
			if (coverFile) void current.applyCustomCoverImage(coverFile, track);
			return;
		}
		if (coverFile) void current.applyCustomCoverImage(coverFile);
	}, []);

	const playMiniQueueIndex = useCallback((index: number) => {
		usePlaybackStore.getState().playAt(index);
		dependenciesRef.current.setMiniQueue(false);
	}, []);

	const insertMiniQueueNext = useCallback((index: number) => {
		const current = dependenciesRef.current;
		const track = usePlaybackStore.getState().queue[index];
		if (!track) return;
		current.insertQueueNext(track);
		current.showToast(`已设为下一首: ${track.title}`);
	}, []);

	const cyclePlaylistPanelMode = useCallback(() => {
		const current = dependenciesRef.current;
		const order: Array<typeof current.playbackMode> = [
			"queue",
			"loop",
			"single",
			"shuffle",
		];
		const next =
			order[(order.indexOf(current.playbackMode) + 1) % order.length] ?? "queue";
		current.setPlaybackMode(next);
	}, []);

	const shufflePlaylistPanelQueue = useCallback(() => {
		const current = dependenciesRef.current;
		const tracks = usePlaybackStore.getState().queue;
		if (tracks.length < 2) {
			current.showToast("队列歌曲不足");
			return;
		}
		const shuffled = [...tracks];
		for (let index = shuffled.length - 1; index > 0; index -= 1) {
			const target = Math.floor(Math.random() * (index + 1));
			[shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
		}
		current.setQueue(shuffled);
		current.showToast("队列已随机排序");
	}, []);

	const clearPlaylistPanelQueue = useCallback(() => {
		const current = dependenciesRef.current;
		current.clearQueue();
		current.showToast("队列已清空");
	}, []);

	const seekPlayback = useCallback(
		(position: number) => {
			controllerRef.current?.seek(position);
			dependenciesRef.current.setPositionMs(position);
		},
		[controllerRef],
	);

	const handleRuntimeTimeUpdate = useCallback(
		(payload: TimeUpdatePayload) => {
			const current = dependenciesRef.current;
			current.setPositionMs(payload.positionMs);
			if (
				payload.durationMs !== null &&
				payload.durationMs !== lastRuntimeDurationRef.current
			) {
				lastRuntimeDurationRef.current = payload.durationMs;
				current.setDurationMs(payload.durationMs);
			}
			current.recordListenProgress(payload.positionMs, payload.durationMs);
			current.setLyricsIndex(
				selectCurrentIndex(payload.positionMs, lyricsPayloadRef.current),
			);
		},
		[lyricsPayloadRef],
	);

	const handleRuntimeDurationChange = useCallback((payload: TimeUpdatePayload) => {
		if (payload.durationMs !== null) {
			dependenciesRef.current.setDurationMs(payload.durationMs);
		}
	}, []);

	const handleRuntimeEnded = useCallback(() => {
		const current = dependenciesRef.current;
		current.finalizeListenSession(true);
		current.setPositionMs(0);

		// 流式电台续播：当前曲已是队尾且 streamSource 激活 → 先续拉再前进。
		// 到尽头/失败都吞掉本次事件并降级为普通队列行为，页面不越轨。
		const state = usePlaybackStore.getState();
		const source = state.streamSource;
		const queueTail = state.queue[state.queue.length - 1] ?? null;
		const atStreamTail =
			source !== null &&
			state.currentTrack !== null &&
			queueTail !== null &&
			`${state.currentTrack.provider}:${state.currentTrack.id}` ===
				`${queueTail.provider}:${queueTail.id}`;
		const { streamNext } = current;
		if (
			source &&
			atStreamTail &&
			typeof streamNext === "function"
		) {
			if (streamFetchInFlightRef.current) return; // 单飞：进行中忽略重入
			streamFetchInFlightRef.current = true;
			void (async () => {
				try {
					const track = await streamNext(source.provider, source.id);
					const latest = usePlaybackStore.getState();
					if (
						!latest.streamSource ||
						latest.streamSource.id !== source.id
					) {
						// 期间源已被切换/清空：静默丢弃，走普通前进
						return;
					}
					latest.enqueue(track);
					latest.ended();
				} catch {
					const latest = usePlaybackStore.getState();
					latest.setStreamSource(null);
					current.showToast("流式续播失败");
					usePlaybackStore.getState().ended();
				} finally {
					streamFetchInFlightRef.current = false;
				}
			})();
			return;
		}

		usePlaybackStore.getState().ended();
	}, []);

	useEffect(
		() => () => {
			for (const url of localAudioUrlsRef.current.values()) URL.revokeObjectURL(url);
			localAudioUrlsRef.current.clear();
		},
		[],
	);

	return {
		fileInputRef,
		localAudioUrlsRef,
		openLocalFileImport,
		importLocalFiles,
		playMiniQueueIndex,
		insertMiniQueueNext,
		cyclePlaylistPanelMode,
		shufflePlaylistPanelQueue,
		clearPlaylistPanelQueue,
		seekPlayback,
		handleRuntimeTimeUpdate,
		handleRuntimeDurationChange,
		handleRuntimeEnded,
	};
}
