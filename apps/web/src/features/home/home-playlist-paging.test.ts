import { expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import {
	applyPlaylistPageAtOffset,
	playlistHasNextPage,
} from "./home-playlist-paging";

function track(id: number, over: Partial<Track> = {}): Track {
	return {
		provider: "netease",
		id: String(id),
		sourceId: String(id),
		title: `歌曲 ${id}`,
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
		...over,
	};
}

test("applyPlaylistPageAtOffset：offset 等于长度时顺序补上", () => {
	const existing = [track(1), track(2)];
	const next = applyPlaylistPageAtOffset(existing, 2, [track(3), track(4)]);
	expect(next.map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
});

test("applyPlaylistPageAtOffset：offset 在中间时从该位置直接覆盖重写", () => {
	const existing = [track(1), track(2), track(9), track(9)];
	const next = applyPlaylistPageAtOffset(existing, 2, [track(3)]);
	expect(next.map((t) => t.id)).toEqual(["1", "2", "3"]);
});

test("applyPlaylistPageAtOffset：重复页只是覆盖同区间，不产生任何特殊状态", () => {
	const existing = [track(1), track(2), track(3), track(4)];
	const again = applyPlaylistPageAtOffset(existing, 2, [track(3), track(4)]);
	expect(again.map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
});

test("applyPlaylistPageAtOffset：空页原样返回、越界 offset 收敛到末尾", () => {
	const existing = [track(1)];
	expect(applyPlaylistPageAtOffset(existing, 5, [])).toBe(existing);
	const clamped = applyPlaylistPageAtOffset(existing, 9, [track(2)]);
	expect(clamped.map((t) => t.id)).toEqual(["1", "2"]);
});

test("playlistHasNextPage 判定", () => {
	const full = { loadedCount: 20, pageCount: 20, pageSize: 20, totalCount: null };
	expect(playlistHasNextPage(full)).toBe(true);
	expect(playlistHasNextPage({ ...full, pageCount: 0 })).toBe(false);
	expect(playlistHasNextPage({ ...full, pageCount: 7 })).toBe(false);
	expect(playlistHasNextPage({ ...full, totalCount: 20 })).toBe(false);
	expect(playlistHasNextPage({ ...full, totalCount: 100 })).toBe(true);
});
