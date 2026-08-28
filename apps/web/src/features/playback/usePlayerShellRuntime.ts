import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProviderId, Track } from "@mineradio/shared";
import type { PreferencesRepository } from "../../ports/preferences-repository";
import {
	CONTROLS_AUTO_HIDE_PREFERENCE,
	LYRIC_TIMING_OFFSETS_PREFERENCE,
	PLAYER_IMMERSIVE_PREFERENCE,
} from "../../preferences/keys";
import { usePlayerShellStore } from "../../stores/player-shell-store";
import type { LyricTimingOffsetMap } from "../../lyrics/lyric-timing";
import {
	applyLyricOffsetToClock,
	formatLyricOffset,
	lyricOffsetToastText,
	lyricTimingOffsetForTrack,
	lyricTimingSongKey,
	setLyricTimingOffsetInMap,
} from "../../lyrics/lyric-timing";

export interface PlayerShellRuntimeOptions {
	preferences?: PreferencesRepository | null;
	currentTrack: Track | null;
	showToast(message: string): void;
	/** 沉浸式进入时是否需要同时收起 mini queue 等浮层 */
	onEnterImmersive?(): void;
	/** 歌词视图时钟（秒）实际来源：读取已应用 offset 的时钟供视觉消费 */
	onLyricViewOffsetChange?(offsetSeconds: number): void;
	/** IMMERSIVE_PARTICLE_LYRICS_2_1_SCOPE=IN：进入沉浸式强制 particle lyrics。 */
	readImmersiveLyricsEnabled?(): boolean;
	onImmersiveLyricsEnabledChange?(enabled: boolean): void;
}

export interface PlayerShellRuntimeResult {
	controlsAutoHide: boolean;
	immersiveMode: boolean;
	toggleControlsAutoHide(): void;
	toggleImmersiveMove(): void;
	toggleImmersiveMode(): void;
	currentLyricOffsetMs: number;
	currentLyricOffsetKey: string;
	currentLyricOffsetLabel: string;
	lyricTimingDisabled: boolean;
	adjustLyricOffset(stepSeconds: number): void;
	resetLyricOffset(): void;
	/** 供 stage-lyric view clock 使用：raw positionMs + offset */
	lyricViewClockMs(rawPositionMs: number): number;
}

function safeRead<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

export function usePlayerShellRuntime({
	preferences,
	currentTrack,
	showToast,
	onEnterImmersive,
	onLyricViewOffsetChange,
	readImmersiveLyricsEnabled,
	onImmersiveLyricsEnabledChange,
}: PlayerShellRuntimeOptions): PlayerShellRuntimeResult {
	const controlsAutoHide = usePlayerShellStore((s) => s.controlsAutoHide);
	const immersiveMode = usePlayerShellStore((s) => s.immersiveMode);
	const lyricOffsets = usePlayerShellStore((s) => s.lyricOffsets);
	const setControlsAutoHide = usePlayerShellStore((s) => s.setControlsAutoHide);
	const setImmersiveMode = usePlayerShellStore((s) => s.setImmersiveMode);
	const setLyricOffsets = usePlayerShellStore((s) => s.setLyricOffsets);

	const preferencesRef = useRef(preferences);
	preferencesRef.current = preferences;
	const currentTrackRef = useRef(currentTrack);
	currentTrackRef.current = currentTrack;
	const showToastRef = useRef(showToast);
	showToastRef.current = showToast;
	const onEnterImmersiveRef = useRef(onEnterImmersive);
	onEnterImmersiveRef.current = onEnterImmersive;
	const onLyricViewOffsetChangeRef = useRef(onLyricViewOffsetChange);
	onLyricViewOffsetChangeRef.current = onLyricViewOffsetChange;
	const readImmersiveLyricsEnabledRef = useRef(readImmersiveLyricsEnabled);
	readImmersiveLyricsEnabledRef.current = readImmersiveLyricsEnabled;
	const onImmersiveLyricsEnabledChangeRef = useRef(onImmersiveLyricsEnabledChange);
	onImmersiveLyricsEnabledChangeRef.current = onImmersiveLyricsEnabledChange;

	const persistForce = useRef(0);

	const persistControlsAutoHide = useCallback(
		(enabled: boolean) => {
			if (preferencesRef.current) {
				void preferencesRef.current.set(CONTROLS_AUTO_HIDE_PREFERENCE, !!enabled).catch(() => undefined);
			}
		},
		[],
	);
	const persistImmersive = useCallback(
		(enabled: boolean) => {
			if (preferencesRef.current) {
				void preferencesRef.current.set(PLAYER_IMMERSIVE_PREFERENCE, !!enabled).catch(() => undefined);
			}
		},
		[],
	);
	const persistLyricOffsets = useCallback((map: LyricTimingOffsetMap) => {
		if (preferencesRef.current) {
			void preferencesRef.current.set(LYRIC_TIMING_OFFSETS_PREFERENCE, map).catch(() => undefined);
		}
	}, []);

	// 启动水合：从 preferences / 本地回退读取持久化状态。
	useEffect(() => {
		if (!preferencesRef.current) return;
		let cancelled = false;
		void preferencesRef.current
			.transaction(async (tx) => {
				const [autoHide, immersive, offsets] = await Promise.all([
					tx.get(CONTROLS_AUTO_HIDE_PREFERENCE),
					tx.get(PLAYER_IMMERSIVE_PREFERENCE),
					tx.get(LYRIC_TIMING_OFFSETS_PREFERENCE),
				]);
				return { autoHide, immersive, offsets };
			})
			.then(({ autoHide, immersive, offsets }) => {
				if (cancelled) return;
				persistForce.current += 1;
				setControlsAutoHide(autoHide);
				setImmersiveMode(immersive);
				setLyricOffsets(offsets);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [setControlsAutoHide, setImmersiveMode, setLyricOffsets]);

	// 沉浸式：body 类 + 副作用。
	const wasImmersiveRef = useRef(false);
	const previousAutoHideRef = useRef(controlsAutoHide);
	const savedParticleLyricsRef = useRef(false);
	useEffect(() => {
		if (typeof document === "undefined") return;
		document.body.classList.toggle("immersive-mode", immersiveMode);
		if (immersiveMode) {
			previousAutoHideRef.current = controlsAutoHide;
			savedParticleLyricsRef.current = readImmersiveLyricsEnabledRef.current?.() ?? false;
			setControlsAutoHide(true);
			onEnterImmersiveRef.current?.();
			onImmersiveLyricsEnabledChangeRef.current?.(true);
		} else if (wasImmersiveRef.current) {
			setControlsAutoHide(previousAutoHideRef.current);
			onImmersiveLyricsEnabledChangeRef.current?.(savedParticleLyricsRef.current);
		}
		wasImmersiveRef.current = immersiveMode;
		persistImmersive(immersiveMode);
		persistImmersive(immersiveMode);
		return () => {
			document.body.classList.remove("immersive-mode");
		};
	}, [immersiveMode, persistImmersive, setControlsAutoHide]);

	// 进入/退出沉浸式时对 auto-hide 偏好做持久化收敛。
	const lastAutoHideForPersist = useRef(controlsAutoHide);
	useEffect(() => {
		if (lastAutoHideForPersist.current === controlsAutoHide) return;
		lastAutoHideForPersist.current = controlsAutoHide;
		persistControlsAutoHide(controlsAutoHide);
	}, [controlsAutoHide, persistControlsAutoHide]);

	const currentLyricOffset = useMemo(
		() => lyricTimingOffsetForTrack(lyricOffsets, currentTrack),
		[currentTrack, lyricOffsets],
	);
	const currentLyricOffsetKey = lyricTimingSongKey(currentTrack);

	// 通知外部歌词视图时钟 offset 变化（stage lyric view 偏移）。
	useEffect(() => {
		onLyricViewOffsetChangeRef.current?.(currentLyricOffset);
	}, [currentLyricOffset]);

	const commitLyricOffset = useCallback(
		(offsetSeconds: number) => {
			const track = currentTrackRef.current;
			const result = setLyricTimingOffsetInMap(lyricOffsets, track, offsetSeconds);
			if (!result.key) {
				if (!track) showToastRef.current("请先播放歌曲");
				return;
			}
			setLyricOffsets(result.map);
			persistLyricOffsets(result.map);
			showToastRef.current(lyricOffsetToastText(offsetSeconds));
		},
		[lyricOffsets, persistLyricOffsets, setLyricOffsets],
	);

	const adjustLyricOffset = useCallback(
		(stepSeconds: number) => {
			const next = Math.round((currentLyricOffset + stepSeconds) * 10) / 10;
			commitLyricOffset(next);
		},
		[commitLyricOffset, currentLyricOffset],
	);
	const resetLyricOffset = useCallback(() => {
		commitLyricOffset(0);
	}, [commitLyricOffset]);

	const lyricViewClockMs = useCallback(
		(rawPositionMs: number) => applyLyricOffsetToClock(rawPositionMs, currentLyricOffset),
		[currentLyricOffset],
	);

	const toggleControlsAutoHide = useCallback(() => {
		setControlsAutoHide(!usePlayerShellStore.getState().controlsAutoHide);
	}, [setControlsAutoHide]);

	const toggleImmersiveMove = useCallback(() => {
		const next = !usePlayerShellStore.getState().immersiveMode;
		if (next) previousAutoHideRef.current = usePlayerShellStore.getState().controlsAutoHide;
		setImmersiveMode(next);
		if (!next) showToastRef.current("已退出全沉浸式");
	}, [setImmersiveMode]);

	// 向后兼容别名：稳妥调用 toggleImmersiveMove。
	const toggleImmersiveMode = toggleImmersiveMove;

	return {
		controlsAutoHide,
		immersiveMode,
		toggleControlsAutoHide,
		toggleImmersiveMove,
		toggleImmersiveMode,
		currentLyricOffsetMs: Math.round(currentLyricOffset * 1000),
		currentLyricOffsetKey,
		currentLyricOffsetLabel: formatLyricOffset(currentLyricOffset),
		lyricTimingDisabled: !currentLyricOffsetKey,
		adjustLyricOffset,
		resetLyricOffset,
		lyricViewClockMs,
	};
}

export type { ProviderId };