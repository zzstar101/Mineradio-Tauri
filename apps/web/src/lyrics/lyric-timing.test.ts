import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import {
	applyLyricOffsetToClock,
	formatLyricOffset,
	lyricOffsetToastText,
	lyricTimingOffsetForTrack,
	lyricTimingSongKey,
	normalizeLyricOffsetSeconds,
	setLyricTimingOffsetInMap,
	trimLyricOffsetMap,
} from "./lyric-timing";

function makeTrack(id: string, provider: Track["provider"] = "netease"): Track {
	return {
		provider,
		id,
		sourceId: id,
		title: `Song ${id}`,
		artists: ["Alice"],
		album: "Album",
		coverUrl: "",
		durationMs: 1000,
		qualityHints: [],
		playableState: "playable",
	};
}

test("lyricTimingSongKey namespaces remote/local/podcast identities", () => {
	expect(lyricTimingSongKey(makeTrack("abc"))).toBe("netease:abc");
	expect(lyricTimingSongKey(makeTrack("local:xyz"))).toBe("local:local:xyz");
	expect(lyricTimingSongKey(null)).toBe("");
	const podcast = makeTrack("p");
	expect(lyricTimingSongKey(({ ...podcast, type: "podcast" }) as unknown as Track)).toBe("podcast:p");
});

test("normalizeLyricOffsetSeconds clamps to ±5s and rounds to 0.1", () => {
	expect(normalizeLyricOffsetSeconds(0)).toBe(0);
	expect(normalizeLyricOffsetSeconds(0.12)).toBe(0.1);
	expect(normalizeLyricOffsetSeconds(-0.14)).toBe(-0.1);
	expect(normalizeLyricOffsetSeconds(12)).toBe(5);
	expect(normalizeLyricOffsetSeconds(-12)).toBe(-5);
	expect(normalizeLyricOffsetSeconds(Number.NaN)).toBe(0);
});

test("formatLyricOffset renders upstream labels", () => {
	expect(formatLyricOffset(0)).toBe("0.0s");
	expect(formatLyricOffset(0.1)).toBe("+0.1s");
	expect(formatLyricOffset(-0.2)).toBe("-0.2s");
});

test("lyricOffsetToastText uses 提前/延后/已重置", () => {
	expect(lyricOffsetToastText(0)).toBe("歌词校准已重置");
	expect(lyricOffsetToastText(0.1)).toBe("歌词提前 0.1s");
	expect(lyricOffsetToastText(-0.1)).toBe("歌词延后 0.1s");
});

test("setLyricTimingOffsetInMap stores/resets per-track and trims LRU", () => {
	const track = makeTrack("abc");
	const first = setLyricTimingOffsetInMap({}, track, 0.3, 100);
	expect(lyricTimingOffsetForTrack(first.map, track)).toBe(0.3);
	expect(first.map["netease:abc"]?.title).toBe("Song abc");

	const reset = setLyricTimingOffsetInMap(first.map, track, 0, 200);
	expect(Object.keys(reset.map).length).toBe(0);

	// LRU 裁剪
	let map = {};
	for (let index = 0; index < 12; index += 1) {
		map = setLyricTimingOffsetInMap(map, makeTrack(`t${index}`), 0.1, index).map;
	}
	expect(Object.keys(trimLyricOffsetMap(map, 10)).length).toBe(10);
	expect(trimLyricOffsetMap(map, 10)).not.toBeNull();
});

test("applyLyricOffsetToClock shifts the lyric view clock only", () => {
	expect(applyLyricOffsetToClock(1000, 0.1)).toBe(1100);
	expect(applyLyricOffsetToClock(100, -0.2)).toBe(0);
	expect(applyLyricOffsetToClock(Number.NaN, 0.1)).toBe(0);
});