import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { usePlaybackStore } from "../../stores/playback-store";
import type { Track } from "@mineradio/shared";
import {
	ensureLocalLibraryHydrated,
	filterLocalLibraryAudioPaths,
	filterLocalLibraryCoverPaths,
	localImportBusyDecision,
	localLibraryController,
	planLocalLibraryImportToasts,
	shouldAttachDroppedCover,
	type LocalLibraryImportOutcome,
} from "./local-library-controller";
import {
	imageFileNameFromPath,
	readDroppedImageBlob,
} from "../../adapters/tauri/tauri-local-library";
import { isTauriRuntime } from "../../tauri/runtime";

export interface LocalLibraryRuntimeOptions {
	showToast(text: string): void;
	enterPlaybackSurface(): void;
	clearCurrentBeatMapRef: RefObject<() => void>;
	applyCustomCoverImageRef: RefObject<
		(file: Blob, track?: Track) => Promise<void>
	>;
	/** Browser（非 Tauri）模式沿用既有 session-only 文件选择入口。 */
	browserFallbackUpload(): void;
}

interface ImportRunOptions {
	start(): Promise<LocalLibraryImportOutcome>;
	pendingCount?: number;
	coverPath?: string | null;
}

/**
 * Tauri 持久本地库运行时入口。App 组合层只消费返回的 handlers；
 * browser（非 Tauri）模式保持既有 session-only blob 流程，本 hook 全部为 no-op。
 */
export function useLocalLibraryRuntime(options: LocalLibraryRuntimeOptions): {
	handleUploadAction(): void;
	uploadFolderHandler: (() => void) | undefined;
} {
	const { showToast, enterPlaybackSurface } = options;
	const localImportBusyRef = useRef(false);
	const finishTauriLocalLibraryImport = useCallback(
		(outcome: LocalLibraryImportOutcome, coverFile?: Blob | null) => {
			localImportBusyRef.current = false;
			if (!outcome.ok) {
				for (const entry of planLocalLibraryImportToasts(outcome))
					showToast(entry.text);
				return;
			}
			if (outcome.tracks.length > 0) {
				usePlaybackStore.getState().setQueue(outcome.tracks);
				usePlaybackStore.getState().playAt(0);
				enterPlaybackSurface();
				options.clearCurrentBeatMapRef.current();
			}
			for (const entry of planLocalLibraryImportToasts(outcome)) {
				if (entry.delayMs > 0) {
					globalThis.setTimeout(() => showToast(entry.text), entry.delayMs);
				} else {
					showToast(entry.text);
				}
			}
			if (coverFile && outcome.tracks.length > 0) {
				void options.applyCustomCoverImageRef.current(
					coverFile,
					outcome.tracks[0],
				);
			}
		},
		[enterPlaybackSurface, options.applyCustomCoverImageRef, options.clearCurrentBeatMapRef, showToast],
	);
	const runTauriLocalLibraryImport = useCallback(
		(runOptions: ImportRunOptions) => {
			if (localImportBusyDecision(localImportBusyRef.current) === "reject")
				return;
			localImportBusyRef.current = true;
			showToast(
				runOptions.pendingCount
					? `正在读取 ${runOptions.pendingCount} 首本地音乐的标签与歌词…`
					: "正在读取本地音乐的标签与歌词…",
			);
			const coverPath = runOptions.coverPath ?? null;
			void Promise.resolve()
				.then(runOptions.start)
				.then(async (outcome) => {
					let coverFile: Blob | null = null;
					if (coverPath && outcome.ok && outcome.tracks.length === 1) {
						const blob = await readDroppedImageBlob(coverPath);
						if (blob) {
							const meta = imageFileNameFromPath(coverPath);
							coverFile = new File([blob], meta.name, { type: meta.type });
						}
					}
					finishTauriLocalLibraryImport(outcome, coverFile);
				})
				.catch(() => {
					localImportBusyRef.current = false;
					showToast("本地音乐导入失败，请重试");
				});
		},
		[finishTauriLocalLibraryImport, showToast],
	);
	const openTauriLocalFileDialog = useCallback(() => {
		runTauriLocalLibraryImport({
			start: () => localLibraryController.importViaDialog(false),
		});
	}, [runTauriLocalLibraryImport]);
	const openTauriLocalFolderDialog = useCallback(() => {
		runTauriLocalLibraryImport({
			start: () => localLibraryController.importViaDialog(true),
		});
	}, [runTauriLocalLibraryImport]);
	const handleUploadAction = useCallback(() => {
		if (!isTauriRuntime()) {
			options.browserFallbackUpload();
			return;
		}
		openTauriLocalFileDialog();
	}, [openTauriLocalFileDialog, options.browserFallbackUpload]);

	// ---------------------------------------------------------------------------
	// Tauri native drag-drop: OS paths → persistent library import. Browser mode
	// never registers the listener.
	// ---------------------------------------------------------------------------
	useEffect(() => {
		if (!isTauriRuntime()) return undefined;
		let disposed = false;
		let unlisten: (() => void) | null = null;
		const setDropActive = (active: boolean) => {
			if (typeof document === "undefined") return;
			document.body.classList.toggle("local-library-drop-active", active);
		};
		void (async () => {
			try {
				const webview = await import("@tauri-apps/api/webview");
				if (disposed) return;
				const un = await webview
					.getCurrentWebview()
					.onDragDropEvent((event) => {
						if (
							event.payload.type === "enter" ||
							event.payload.type === "over"
						) {
							setDropActive(true);
							return;
						}
						if (event.payload.type === "leave") {
							setDropActive(false);
							return;
						}
						setDropActive(false);
						const paths = Array.isArray(event.payload.paths)
							? event.payload.paths
							: [];
						const audioPaths = filterLocalLibraryAudioPaths(paths);
						const coverPaths = filterLocalLibraryCoverPaths(paths);
						if (audioPaths.length === 0 && coverPaths.length === 0) return;
						if (audioPaths.length === 0) {
							// Image-only drop → existing customization flow on the current track.
							const coverPath = coverPaths[0];
							if (!coverPath) return;
							void readDroppedImageBlob(coverPath).then((blob) => {
								if (!blob) return;
								const meta = imageFileNameFromPath(coverPath);
								void options.applyCustomCoverImageRef.current(
									new File([blob], meta.name, { type: meta.type }),
								);
							});
							return;
						}
						runTauriLocalLibraryImport({
							start: () => localLibraryController.importPaths(audioPaths),
							pendingCount: audioPaths.length,
							coverPath: shouldAttachDroppedCover(audioPaths, coverPaths)
								? coverPaths[0]
								: null,
						});
					});
				if (disposed) {
					un();
					return;
				}
				unlisten = un;
			} catch {
				// 拖放桥不可用（旧 webview / 权限缺失）→ 静默跳过，对话框入口仍可用。
			}
		})();
		return () => {
			disposed = true;
			unlisten?.();
			setDropActive(false);
		};
	}, [options.applyCustomCoverImageRef, runTauriLocalLibraryImport]);

	// ---------------------------------------------------------------------------
	// Startup hydration（one-shot）：持久本地库并入恢复的会话队列。
	// stale-guard：await 前后都用 usePlaybackStore.getState() 现读现用，
	// 不依赖 React 闭包快照。缺曲目标记（localMissing）当前 runtime 无此
	// authority，按规范静默跳过；-1 未命中清理由下一里程碑处理。
	// ---------------------------------------------------------------------------
	const localHydrationStartedRef = useRef(false);
	useEffect(() => {
		if (localHydrationStartedRef.current) return;
		localHydrationStartedRef.current = true;
		let cancelled = false;
		void (async () => {
			const preQueue = usePlaybackStore.getState().queue;
			const preCurrentTrack = usePlaybackStore.getState().currentTrack;
			await ensureLocalLibraryHydrated();
			if (cancelled || !localLibraryController.isHydrated()) return;
			if (
				localLibraryController.snapshotTracks().length === 0 ||
				!isTauriRuntime()
			)
				return;
			const state = usePlaybackStore.getState();
			const queueChanged =
				state.queue !== preQueue || state.currentTrack !== preCurrentTrack;
			// 恢复队列非空：仅补全本地条目的库元数据（封面/时长），current track 保持
			// 对象身份不变以免重触发加载链路。
			if (state.queue.length > 0) {
				const libraryTracks = localLibraryController.snapshotTracks();
				const enrichedQueue = state.queue.map((track, index) => {
					if (!track.id.startsWith("local:")) return track;
					if (
						state.currentTrack &&
						index === state.queue.indexOf(state.currentTrack)
					)
						return track;
					const enriched = libraryTracks.find(
						(libraryTrack) => libraryTrack.id === track.id,
					);
					if (!enriched) return track;
					if (
						enriched.coverUrl === track.coverUrl &&
						enriched.durationMs === track.durationMs
					)
						return track;
					return {
						...track,
						coverUrl: enriched.coverUrl,
						durationMs: enriched.durationMs ?? track.durationMs,
					};
				});
				const changed = enrichedQueue.some(
					(track, index) => track !== state.queue[index],
				);
				if (changed || queueChanged) {
					usePlaybackStore.getState().setQueue(enrichedQueue);
				}
			}
			// 恢复队列为空且 checkpoint 指向本地曲目：按 upstream restoredLocalTrackIndex
			// 语义以库重建队列；未命中（-1）的清理由下一里程碑处理。
			if (state.queue.length > 0) return;
			const authority = state.checkpointRestore;
			const ref = authority?.currentTrackRef ?? "";
			if (!authority || !ref.startsWith("netease:local:")) return;
			const tracks = localLibraryController.snapshotTracks();
			const matchIndex = tracks.findIndex(
				(track) => `${track.provider}:${track.id}` === ref,
			);
			if (matchIndex < 0) return; // -1 → clear handled next milestone
			const matched = tracks[matchIndex];
			if (!matched) return;
			const ordered = [
				matched,
				...tracks.filter((_track, index) => index !== matchIndex),
			];
			usePlaybackStore.getState().setQueue(ordered);
			if (authority.wasPlaying) {
				usePlaybackStore.getState().setCurrentTrack(matched);
			}
		})().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return {
		handleUploadAction,
		uploadFolderHandler: isTauriRuntime()
			? openTauriLocalFolderDialog
			: undefined,
	};
}
