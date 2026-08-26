import {
	cloneFxState,
	type AudioFrameBytes,
	type FxState,
	type ForegroundFramePolicy,
	type LyricsVisualSnapshot,
	type PlaybackVisualSnapshot,
	type ShelfVisualSnapshot,
	type VisualBackgroundPolicy,
	type VisualLyricLine,
	type VisualMediaClock,
	type VisualSettingsSnapshot,
	type VisualShelfItem,
} from "@mineradio/visual-engine";

function freezeLyricLine(line: VisualLyricLine): VisualLyricLine {
	const words = line.words?.map((word) => Object.freeze({ ...word }));
	return Object.freeze({
		...line,
		...(words ? { words: Object.freeze(words) } : {}),
	});
}

function freezeShelfItem(item: VisualShelfItem): VisualShelfItem {
	return Object.freeze({ ...item });
}

function mergeFxState(
	fxDefaults: Partial<FxState> | undefined,
	fxState: Partial<FxState> | undefined,
): Readonly<FxState> {
	const merged = Object.assign(cloneFxState(), fxDefaults, fxState);
	merged.mouseXy = {
		...cloneFxState().mouseXy,
		...fxDefaults?.mouseXy,
		...fxState?.mouseXy,
	};
	Object.freeze(merged.mouseXy);
	return Object.freeze(merged);
}

function resolveBackgroundPolicy(value: unknown): VisualBackgroundPolicy {
	return value === "keep" || value === "release" ? value : "auto";
}

export function resolveForegroundFramePolicy(
	quality: unknown,
): ForegroundFramePolicy {
	if (quality === "eco") return Object.freeze({ mode: "fixed", fps: 30 });
	if (quality === "balanced") return Object.freeze({ mode: "fixed", fps: 45 });
	if (quality === "ultra" || quality === "high" || quality == null) {
		return Object.freeze({ mode: "vsync" });
	}
	return Object.freeze({ mode: "vsync" });
}

export function buildPlaybackVisualSnapshot(
	input: PlaybackVisualSnapshot,
): PlaybackVisualSnapshot {
	return Object.freeze({
		trackKey: input.trackKey,
		title: input.title ?? "",
		artist: input.artist ?? "",
		playing: input.playing,
		durationMs: input.durationMs,
		coverUrl: input.coverUrl,
		coverFallbackUrl: input.coverFallbackUrl,
		beatMapKey: input.beatMapKey,
		beatMap: input.beatMap,
		splashActive: input.splashActive,
		homeActive: input.homeActive,
	});
}

export function buildLyricsVisualSnapshot(
	input: LyricsVisualSnapshot,
): LyricsVisualSnapshot {
	const lines = input.lines.map(freezeLyricLine);
	return Object.freeze({
		lines: Object.freeze(lines),
		fallbackText: input.fallbackText,
		hasNativeKaraoke: input.hasNativeKaraoke,
	});
}

export function buildShelfVisualSnapshot(
	input: ShelfVisualSnapshot,
): ShelfVisualSnapshot {
	const items = input.items.map(freezeShelfItem);
	return Object.freeze({
		items: Object.freeze(items),
		pane: input.pane,
		mode: input.mode,
		cameraMode: input.cameraMode,
		presence: input.presence,
		mergeCollections: input.mergeCollections,
		mineCount: input.mineCount,
		favCount: input.favCount,
		secondaryLeftDisplaySeamGuard: input.secondaryLeftDisplaySeamGuard,
	});
}

export interface BuildVisualSettingsSnapshotInput {
	readonly fxDefaults?: Partial<FxState>;
	readonly fxState?: Partial<FxState>;
	readonly coverResolution: number;
	readonly wallpaperSafe: boolean;
	readonly prefersReducedMotion: boolean;
}

export function buildVisualSettingsSnapshot(
	input: BuildVisualSettingsSnapshotInput,
): VisualSettingsSnapshot {
	const fx = mergeFxState(input.fxDefaults, input.fxState);
	return Object.freeze({
		fx,
		coverResolution: input.coverResolution,
		wallpaperSafe: input.wallpaperSafe,
		backgroundPolicy: resolveBackgroundPolicy(fx.performanceBackground),
		foregroundFramePolicy: resolveForegroundFramePolicy(fx.performanceQuality),
		prefersReducedMotion: input.prefersReducedMotion,
	});
}

export interface CreateVisualMediaClockInput {
	readonly getAudioFrame: () => AudioFrameBytes | null;
	readonly getPositionMs: () => number;
	readonly getPlaybackSnapshot: () => PlaybackVisualSnapshot;
}

export function createVisualMediaClock(
	input: CreateVisualMediaClockInput,
): VisualMediaClock {
	return {
		currentTimeSeconds() {
			const audioTime = Number(input.getAudioFrame()?.currentTimeSeconds);
			if (Number.isFinite(audioTime) && audioTime >= 0) return audioTime;
			const fallback = Number(input.getPositionMs());
			return Number.isFinite(fallback) && fallback > 0 ? fallback / 1000 : 0;
		},
		durationSeconds() {
			const durationMs = input.getPlaybackSnapshot().durationMs;
			return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
				? durationMs / 1000
				: null;
		},
		isPlaying() {
			const audioFrame = input.getAudioFrame();
			if (audioFrame) return audioFrame.playing;
			return input.getPlaybackSnapshot().playing;
		},
	};
}
