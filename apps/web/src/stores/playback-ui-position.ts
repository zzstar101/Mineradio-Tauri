import { useEffect, useState } from "react";
import { usePlaybackStore } from "./playback-store";

export const PLAYBACK_UI_POSITION_INTERVAL_MS = 125;
export const PLAYBACK_UI_POSITION_JUMP_MS = 1_000;

export interface PlaybackUiPositionGate {
	shouldPublish(positionMs: number, nowMs: number): boolean;
	markPublished(positionMs: number, nowMs: number): void;
	delayUntilPublish(nowMs: number): number;
}

/**
 * 播放 Runtime 保留原始媒体时钟；该 gate 只限制 React UI 快照频率。
 * seek/切歌等明显跳变立即发布，连续 timeupdate 最多约 8Hz。
 */
export function createPlaybackUiPositionGate(
	initialPositionMs: number,
	intervalMs = PLAYBACK_UI_POSITION_INTERVAL_MS,
): PlaybackUiPositionGate {
	let publishedPositionMs = initialPositionMs;
	let publishedAtMs = Number.NEGATIVE_INFINITY;
	return {
		shouldPublish(positionMs, nowMs) {
			return Math.abs(positionMs - publishedPositionMs) >= PLAYBACK_UI_POSITION_JUMP_MS
				|| nowMs - publishedAtMs >= intervalMs;
		},
		markPublished(positionMs, nowMs) {
			publishedPositionMs = positionMs;
			publishedAtMs = nowMs;
		},
		delayUntilPublish(nowMs) {
			return Math.max(0, intervalMs - (nowMs - publishedAtMs));
		},
	};
}

function clockNow(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function usePlaybackUiPosition(): number {
	const [positionMs, setPositionMs] = useState(
		() => usePlaybackStore.getState().positionMs,
	);

	useEffect(() => {
		const gate = createPlaybackUiPositionGate(
			usePlaybackStore.getState().positionMs,
		);
		let timer: ReturnType<typeof setTimeout> | null = null;

		const publish = () => {
			timer = null;
			const next = usePlaybackStore.getState().positionMs;
			const nowMs = clockNow();
			gate.markPublished(next, nowMs);
			setPositionMs(next);
		};

		const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
			if (state.positionMs === previous.positionMs) return;
			const nowMs = clockNow();
			if (gate.shouldPublish(state.positionMs, nowMs)) {
				if (timer !== null) clearTimeout(timer);
				publish();
				return;
			}
			if (timer === null) {
				timer = setTimeout(publish, gate.delayUntilPublish(nowMs));
			}
		});

		return () => {
			unsubscribe();
			if (timer !== null) clearTimeout(timer);
		};
	}, []);

	return positionMs;
}
