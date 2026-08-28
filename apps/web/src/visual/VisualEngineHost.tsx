import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import type { LyricPayload, LyricLine as SharedLyricLine, PlaylistSummary, PodcastCollection, Track } from "@mineradio/shared";
import {
	type AudioFrameSource,
	type FxState,
	type VisualLyricLine,
	type ShelfItem,
	type ShelfOpenDetailContentPayload,
	type ShelfPane,
	type StageLyricsLifecycle,
	type StageLyricsMotionSnapshot,
} from "@mineradio/visual-engine";
import {
	resolveRuntimeWallpaperSafe,
	useVisualEngine,
	type VisualPerformanceSnapshotReaderRef,
} from "./useVisualEngine";
import type { ShelfDetailRowClickPayload, ShelfPlayPlaylistPayload } from "./shelf-pointer-interactions";
import type { ShelfDetailContentListController } from "./shelf-detail-data";
import { resolveShelfItems } from "./shelf-items";
import type { ShelfCameraMode, ShelfMode, ShelfPresence, ShelfSettings } from "../stores/shelf-store";
import type { MediaImageSource, MediaUrlPort } from "../ports/media-url-port";
import { resolveCoverSource, coverSourceToCssBackgroundImage } from "../cover/resolved-cover-source";
import { createLegacyVisualEventBridge } from "./runtime/legacy-visual-events";
import {
	buildLyricsVisualSnapshot,
	buildPlaybackVisualSnapshot,
	buildShelfVisualSnapshot,
	buildVisualSettingsSnapshot,
} from "./runtime/visual-snapshot-builders";

export interface VisualEngineHostProps {
	audioFrameSource: AudioFrameSource;
	lyricsPayload: LyricPayload | null;
	positionMs: number;
	durationMs?: number | null;
	isPlaying: boolean;
	playbackVolume: number;
	queue?: Track[];
	playlists?: PlaylistSummary[];
	podcastCollections?: PodcastCollection[];
	currentTrack?: Track | null;
	currentCoverUrl?: string | null;
	beatMapKey?: string | null;
	beatMap?: unknown;
	/** Wave 3: stage lyric 视图时钟偏移（秒），仅影响歌词 index。 */
	lyricOffsetSeconds?: number;
	mediaUrl?: Pick<MediaUrlPort, "imageSource">;
	coverResolution?: number;
	fxDefaults?: Partial<FxState>;
	fxState?: Partial<FxState>;
	shelfSettings?: Pick<ShelfSettings, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections"> | null;
	splashActive?: boolean;
	homeActive?: boolean;
	secondaryLeftDisplaySeamGuardActive?: boolean;
	onShelfModeChange?: (mode: ShelfMode) => void;
	onShelfPlayQueueIndex?: (index: number) => void;
	onShelfPlayPlaylist?: (payload: ShelfPlayPlaylistPayload) => void;
	onShelfDetailRowClick?: (payload: ShelfDetailRowClickPayload) => void;
	onShelfOpenDetailContent?: (payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void;
	onShelfOpenContentChange?: (open: boolean) => void;
	desktopLyricsMotionRef?: RefObject<DesktopLyricsMotionSnapshot>;
	performanceSnapshotReaderRef?: VisualPerformanceSnapshotReaderRef;
}

export type DesktopLyricsMotionSnapshot = StageLyricsMotionSnapshot;

export { createStageLyricsHostSuppliers } from "./useVisualEngine";

export function resolveVisualShelfSettings(
	fxDefaults: Partial<FxState> | undefined,
	settings: Pick<ShelfSettings, "mode" | "cameraMode" | "presence" | "showPodcasts" | "mergeCollections"> | null | undefined,
): { mode: ShelfMode; cameraMode: ShelfCameraMode; presence: ShelfPresence; showPodcasts: boolean; mergeCollections: boolean } {
	return {
		mode: settings?.mode ?? (fxDefaults?.shelf as ShelfMode | undefined) ?? "side",
		cameraMode: settings?.cameraMode ?? (fxDefaults?.shelfCameraMode as ShelfCameraMode | undefined) ?? "dynamic",
		presence: settings?.presence ?? (fxDefaults?.shelfPresence as ShelfPresence | undefined) ?? "always",
		showPodcasts: settings?.showPodcasts ?? (fxDefaults?.shelfShowPodcasts !== false),
		mergeCollections: settings?.mergeCollections ?? (fxDefaults?.shelfMergeCollections === true),
	};
}

export function resolveVisualWallpaperSafe(
	fxDefaults: Partial<FxState> | undefined,
	fxState: Partial<FxState> | undefined,
): boolean {
	return resolveRuntimeWallpaperSafe({
		fxDefaults,
		fxRef: { current: fxState },
	});
}

export function mapLyricPayload(payload: LyricPayload | null): VisualLyricLine[] {
	if (!payload || !Array.isArray(payload.lines)) return [];
	return payload.lines
		.map((line: SharedLyricLine, originalIndex): VisualLyricLine & { originalIndex: number } => ({
			t: Math.max(0, line.timeMs) / 1000,
			text: line.text ?? "",
			translation: line.translation,
			duration: typeof line.durationMs === "number" ? Math.max(0, line.durationMs) / 1000 : undefined,
			charCount: line.charCount,
			words: Array.isArray(line.words)
				? line.words
						.map((word, wordIndex) => ({
							text: word.text,
							t: Math.max(0, word.timeMs) / 1000,
							d: typeof word.durationMs === "number" ? Math.max(0, word.durationMs) / 1000 : undefined,
							c0: word.c0,
							c1: word.c1,
							wordIndex,
						}))
						.sort((a, b) => a.t - b.t || a.wordIndex - b.wordIndex)
						.map((word) => ({
							text: word.text,
							t: word.t,
							d: word.d,
							c0: word.c0,
							c1: word.c1,
						}))
				: undefined,
			originalIndex,
		}))
		.sort((a, b) => a.t - b.t || a.originalIndex - b.originalIndex)
		.map((line) => ({
			t: line.t,
			text: line.text,
			translation: line.translation,
			duration: line.duration,
			charCount: line.charCount,
			words: line.words,
		}));
}

export function resolveRuntimeShelfMode(
	defaultMode: string | null | undefined,
	runtimeOverride: string | null | undefined,
): string {
	if (runtimeOverride && (!defaultMode || defaultMode === "off")) return runtimeOverride;
	return defaultMode ?? "side";
}

export function syncRuntimeShelfModeOverride(
	previousDefaultRef: { current: string | undefined },
	runtimeOverrideRef: { current: string | null },
	defaultMode: string | undefined,
): void {
	if (previousDefaultRef.current !== defaultMode) {
		runtimeOverrideRef.current = null;
		previousDefaultRef.current = defaultMode;
	}
}

export function resolveVisualCoverUrl(currentCoverUrl: string | null | undefined, currentTrack: Track | null | undefined): string {
	return currentCoverUrl ?? currentTrack?.coverUrl ?? "";
}

export function resolveVisualTrackKey(currentTrack: Track | null | undefined): string {
	return currentTrack ? `${currentTrack.provider}:${currentTrack.id}` : "";
}

export function normalizeVisualCoverUrl(coverUrl: string): string {
	return resolveCoverSource(coverUrl, undefined).logicalSource;
}

export function resolveVisualImageSource(
	coverUrl: string,
	mediaUrl: Pick<MediaUrlPort, "imageSource"> | null | undefined,
): MediaImageSource {
	const resolved = resolveCoverSource(coverUrl, mediaUrl);
	return { uri: resolved.uri, logicalSource: resolved.logicalSource };
}

export function coverUrlToCssBackgroundImage(coverUrl: string): string | undefined {
	return coverSourceToCssBackgroundImage(coverUrl);
}

export function mapShelfItemCoverSources(
	items: ShelfItem[],
	mediaUrl: Pick<MediaUrlPort, "imageSource"> | null | undefined,
): ShelfItem[] {
	return items.map((item) => {
		if (!item.cover) return item;
		const cover = resolveVisualImageSource(item.cover, mediaUrl).uri;
		return cover === item.cover ? item : { ...item, cover };
	});
}

export function countShelfPanePlaylists(playlists: PlaylistSummary[]): { mineCount: number; favCount: number } {
	let mineCount = 0;
	let favCount = 0;
	for (const playlist of playlists) {
		if (playlist.subscribed === true) favCount += 1;
		else mineCount += 1;
	}
	return { mineCount, favCount };
}

export function syncDesktopLyricsMotionRef(
	target: RefObject<DesktopLyricsMotionSnapshot> | undefined,
	lifecycle: Pick<StageLyricsLifecycle, "getMotionSnapshot"> | null,
): void {
	if (!target || !lifecycle) return;
	target.current = lifecycle.getMotionSnapshot();
}

function trackFallbackText(track: Track | null | undefined): string {
	if (!track) return "";
	const title = String(track.title || "").trim();
	const artist = (track.artists ?? []).map((name) => String(name || "").trim()).filter(Boolean).join(" / ");
	if (title && artist) return `${title} - ${artist}`;
	return title || artist;
}

function readInitialPrefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
	} catch {
		return false;
	}
}

export function VisualEngineHost(props: VisualEngineHostProps): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const [shelfPane, setShelfPane] = useState<ShelfPane>("mine");
	const visualShelfSettings = useMemo(
		() => resolveVisualShelfSettings(props.fxDefaults, props.shelfSettings),
		[props.fxDefaults, props.shelfSettings],
	);
	const runtimeShelfModeOverrideRef = useRef<string | null>(null);
	const previousDefaultShelfModeRef = useRef<string | undefined>(visualShelfSettings.mode);
	const [, bumpRuntimeShelfModeRevision] = useState(0);
	syncRuntimeShelfModeOverride(
		previousDefaultShelfModeRef,
		runtimeShelfModeOverrideRef,
		visualShelfSettings.mode,
	);
	const runtimeShelfMode = resolveRuntimeShelfMode(
		visualShelfSettings.mode,
		runtimeShelfModeOverrideRef.current,
	);

	useEffect(() => {
		if (visualShelfSettings.mergeCollections) setShelfPane("mine");
	}, [visualShelfSettings.mergeCollections]);
	const rawCoverUrl = useMemo(
		() => resolveVisualCoverUrl(props.currentCoverUrl, props.currentTrack),
		[props.currentCoverUrl, props.currentTrack],
	);
	const resolvedCoverSource = useMemo(
		() => resolveCoverSource(rawCoverUrl, props.mediaUrl),
		[rawCoverUrl, props.mediaUrl],
	);
	const albumBgStyle = resolvedCoverSource.uri
		? { backgroundImage: coverUrlToCssBackgroundImage(resolvedCoverSource.uri) }
		: undefined;
	const webglCoverSource: MediaImageSource = resolvedCoverSource;

	const handleShelfModeChange = useCallback((mode: "side") => {
		runtimeShelfModeOverrideRef.current = mode;
		bumpRuntimeShelfModeRevision((revision) => revision + 1);
		props.onShelfModeChange?.(mode);
	}, [props.onShelfModeChange]);

	const shelfPaneCounts = useMemo(
		() => countShelfPanePlaylists(props.playlists ?? []),
		[props.playlists],
	);
	const shelfItems = useMemo(
		() => mapShelfItemCoverSources(
			resolveShelfItems({
				playlists: props.playlists ?? [],
				podcastCollections: props.podcastCollections ?? [],
				queue: props.queue ?? [],
				currentTrack: props.currentTrack ?? null,
				settings: {
					showPodcasts: visualShelfSettings.showPodcasts,
					mergeCollections: visualShelfSettings.mergeCollections,
					pane: shelfPane,
				},
			}),
			props.mediaUrl,
		),
		[props.playlists, props.podcastCollections, props.queue, props.currentTrack, props.mediaUrl, visualShelfSettings.showPodcasts, visualShelfSettings.mergeCollections, shelfPane],
	);
	const lyricLines = useMemo(() => mapLyricPayload(props.lyricsPayload), [props.lyricsPayload]);
	const fallbackText = useMemo(() => trackFallbackText(props.currentTrack), [props.currentTrack]);
	const durationMs = props.durationMs ?? props.currentTrack?.durationMs ?? null;
	const trackKey = resolveVisualTrackKey(props.currentTrack);
	const workshopPreset = props.fxState?.preset ?? props.fxDefaults?.preset;
	const workshopSettings = props.fxState?.workshop ?? props.fxDefaults?.workshop;
	const workshopActive = Number(workshopPreset) === 8 && workshopSettings?.active === true;
	const wallpaperSafe = useMemo(
		() => resolveVisualWallpaperSafe(props.fxDefaults, props.fxState),
		[props.fxDefaults, props.fxState],
	);
	const initialReducedMotionRef = useRef<boolean | null>(null);
	if (initialReducedMotionRef.current === null) {
		initialReducedMotionRef.current = readInitialPrefersReducedMotion();
	}

	const playbackSnapshot = useMemo(() => buildPlaybackVisualSnapshot({
		trackKey,
		title: props.currentTrack?.title ?? "",
		artist: props.currentTrack?.artists.join(" / ") ?? "",
		playing: props.isPlaying,
		durationMs,
		coverUrl: webglCoverSource.uri,
		coverFallbackUrl: webglCoverSource.fallbackUri ?? "",
		beatMapKey: props.beatMapKey ?? "",
		beatMap: props.beatMap ?? null,
		splashActive: props.splashActive ?? false,
		homeActive: props.homeActive ?? false,
	}), [trackKey, props.currentTrack?.title, props.currentTrack?.artists, props.isPlaying, durationMs, webglCoverSource, props.beatMapKey, props.beatMap, props.splashActive, props.homeActive]);
	const lyricsSnapshot = useMemo(() => buildLyricsVisualSnapshot({
		lines: lyricLines,
		fallbackText,
		hasNativeKaraoke: props.lyricsPayload?.isWordByWord === true,
	}), [lyricLines, fallbackText, props.lyricsPayload?.isWordByWord]);
	const shelfSnapshot = useMemo(() => buildShelfVisualSnapshot({
		items: shelfItems,
		pane: shelfPane,
		mode: runtimeShelfMode,
		cameraMode: visualShelfSettings.cameraMode,
		presence: visualShelfSettings.presence,
		mergeCollections: visualShelfSettings.mergeCollections,
		mineCount: shelfPaneCounts.mineCount,
		favCount: shelfPaneCounts.favCount,
		secondaryLeftDisplaySeamGuard: props.secondaryLeftDisplaySeamGuardActive ?? false,
	}), [shelfItems, shelfPane, runtimeShelfMode, visualShelfSettings.cameraMode, visualShelfSettings.presence, visualShelfSettings.mergeCollections, shelfPaneCounts.mineCount, shelfPaneCounts.favCount, props.secondaryLeftDisplaySeamGuardActive]);
	const settingsSnapshot = useMemo(() => buildVisualSettingsSnapshot({
		fxDefaults: props.fxDefaults,
		fxState: props.fxState,
		coverResolution: props.coverResolution ?? 1.55,
		wallpaperSafe,
		prefersReducedMotion: initialReducedMotionRef.current ?? false,
	}), [props.fxDefaults, props.fxState, props.coverResolution, wallpaperSafe]);

	const eventsRef = useRef<ReturnType<typeof createLegacyVisualEventBridge> | null>(null);
	if (!eventsRef.current) eventsRef.current = createLegacyVisualEventBridge();
	useEffect(() => {
		eventsRef.current?.update({
			onShelfModeChange: handleShelfModeChange,
			onShelfPlayQueueIndex: props.onShelfPlayQueueIndex,
			onShelfPlayPlaylist: props.onShelfPlayPlaylist,
			onShelfDetailRowClick: props.onShelfDetailRowClick,
			onShelfOpenDetailContent: props.onShelfOpenDetailContent,
			onShelfOpenContentChange: props.onShelfOpenContentChange,
			onShelfPaneChange: setShelfPane,
			desktopLyricsMotionRef: props.desktopLyricsMotionRef,
		});
	}, [
		handleShelfModeChange,
		props.onShelfPlayQueueIndex,
		props.onShelfPlayPlaylist,
		props.onShelfDetailRowClick,
		props.onShelfOpenDetailContent,
		props.onShelfOpenContentChange,
		props.desktopLyricsMotionRef,
	]);

	useVisualEngine({
		hostRef,
		audioFrameSource: props.audioFrameSource,
		positionMs: props.positionMs,
		playbackVolume: props.playbackVolume,
		playbackSnapshot,
		lyricsSnapshot,
		shelfSnapshot,
		settingsSnapshot,
		events: eventsRef.current,
		lyricOffsetSeconds: props.lyricOffsetSeconds,
		performanceSnapshotReaderRef: props.performanceSnapshotReaderRef,
	});

	return (
		<>
			<div id="custom-bg" aria-hidden="true">
				<video id="custom-bg-video" muted loop playsInline preload="metadata" />
			</div>
			<div id="album-bg" className={resolvedCoverSource.uri && !workshopActive ? "visible" : undefined} style={albumBgStyle} aria-hidden="true" />
			<div
				id="visual-host"
				className={workshopActive ? "visual-host sonic-workshop-active" : "visual-host"}
				ref={hostRef}
			/>
			{workshopActive && props.currentTrack ? (
				<div className="sonic-workshop-media-copy" aria-hidden="true">
					<div className="sonic-workshop-media-title">{props.currentTrack.title}</div>
					<div className="sonic-workshop-media-artist">
						{props.currentTrack.artists.join(" / ")}
					</div>
				</div>
			) : null}
		</>
	);
}
