import type { Track } from "@mineradio/shared";

/**
 * Track-scoped lyric timing offset (Wave 3, upstream S042).
 *
 * Mirrors upstream `06-lyric-timing-offset.js` semantics:
 * - offset is applied to the lyric *view clock* only (never mutates LyricPayload);
 * - stored per track identity (provider+id / local key);
 * - steps -0.1 / 0 / +0.1 clamped to [-5, 5] seconds;
 * - map capped at LYRIC_TIMING_OFFSET_LIMIT entries, LRU by updatedAt.
 */

export const LYRIC_TIMING_OFFSET_MIN_SECONDS = -5;
export const LYRIC_TIMING_OFFSET_MAX_SECONDS = 5;
export const LYRIC_TIMING_OFFSET_STEP_SECONDS = 0.1;
export const LYRIC_TIMING_OFFSET_LIMIT = 500;

export function normalizeLyricOffsetSeconds(value: number): number {
	const raw = Number(value);
	if (!Number.isFinite(raw)) return 0;
	const rounded = Math.round(raw * 10) / 10;
	return Math.max(
		LYRIC_TIMING_OFFSET_MIN_SECONDS,
		Math.min(LYRIC_TIMING_OFFSET_MAX_SECONDS, rounded),
	);
}

/**
 * 稳定 track 身份键。local/podcast/remote 分开命名空间，避免与远端曲目碰撞。
 */
export function lyricTimingSongKey(track: Track | null | undefined): string {
	if (!track) return "";
	const record = track as unknown as Record<string, unknown>;
	if (track.id.startsWith("local:")) return `local:${track.id}`;
	if (record.type === "podcast" || record.source === "podcast") {
		const programId = record.programId ?? track.sourceId ?? track.id;
		return `podcast:${String(programId)}`;
	}
	const id = track.sourceId || track.id || "";
	return track.provider && id ? `${track.provider}:${id}` : "";
}

export function formatLyricOffset(offsetSeconds: number): string {
	const offset = normalizeLyricOffsetSeconds(offsetSeconds);
	if (offset === 0) return "0.0s";
	return `${offset > 0 ? "+" : "-"}${Math.abs(offset).toFixed(1)}s`;
}

export function lyricOffsetToastText(offsetSeconds: number): string {
	const offset = normalizeLyricOffsetSeconds(offsetSeconds);
	if (offset === 0) return "歌词校准已重置";
	return offset > 0
		? `歌词提前 ${Math.abs(offset).toFixed(1)}s`
		: `歌词延后 ${Math.abs(offset).toFixed(1)}s`;
}

export interface LyricTimingOffsetEntry {
	readonly offset: number;
	readonly updatedAt: number;
	readonly title: string;
	readonly artist: string;
}

export type LyricTimingOffsetMap = Record<string, LyricTimingOffsetEntry>;

/**
 * 按更新时间 LRU 裁剪到上限（与上游 writeLyricTimingOffsetMap 一致）。
 */
export function trimLyricOffsetMap(
	map: LyricTimingOffsetMap,
	limit = LYRIC_TIMING_OFFSET_LIMIT,
): LyricTimingOffsetMap {
	const keys = Object.keys(map)
		.sort((a, b) => {
			const updatedAtA = map[a]?.updatedAt ?? 0;
			const updatedAtB = map[b]?.updatedAt ?? 0;
			return updatedAtB - updatedAtA;
		})
		.slice(0, limit);
	const out: LyricTimingOffsetMap = {};
	for (const key of keys) out[key] = map[key];
	return out;
}

export function lyricTimingOffsetForTrack(
	map: LyricTimingOffsetMap,
	track: Track | null | undefined,
): number {
	const key = lyricTimingSongKey(track);
	if (!key) return 0;
	const entry = map[key];
	return entry ? normalizeLyricOffsetSeconds(entry.offset) : 0;
}

export function setLyricTimingOffsetInMap(
	map: LyricTimingOffsetMap,
	track: Track | null | undefined,
	offsetSeconds: number,
	now = Date.now(),
): { map: LyricTimingOffsetMap; key: string } {
	const key = lyricTimingSongKey(track);
	if (!key) return { map, key: "" };
	const offset = normalizeLyricOffsetSeconds(offsetSeconds);
	if (offset === 0) {
		if (!map[key]) return { map, key };
		const next = { ...map };
		delete next[key];
		return { map: trimLyricOffsetMap(next), key };
	}
	const next = {
		...map,
		[key]: {
			offset,
			updatedAt: now,
			title: (track?.title ?? "").slice(0, 80),
			artist: (track?.artists.join(" / ") ?? "").slice(0, 80),
		},
	};
	return { map: trimLyricOffsetMap(next), key };
}

/** 应用到歌词视图时钟：rawTimeMs + offsetSeconds*1000，不小于 0。 */
export function applyLyricOffsetToClock(
	rawTimeMs: number,
	offsetSeconds: number,
): number {
	const t = Number(rawTimeMs);
	if (!Number.isFinite(t)) return 0;
	return Math.max(0, t + normalizeLyricOffsetSeconds(offsetSeconds) * 1000);
}