import { expect, test } from "bun:test";
import type { RecommendationCard, RecommendationPage } from "@mineradio/shared";
import {
	buildTrackFromRecommendationCard,
	chunkIntoColumns,
	flattenRecommendationFeed,
	resolveRecommendationCardDisplay,
} from "./recommendation-page-policy";

function page(
	provider: RecommendationPage["provider"],
	modules: Array<{ title: string; count: number }>,
): RecommendationPage {
	return {
		provider,
		list: modules.map(({ title, count }) => ({
			title,
			kind: "Mixed",
			list: Array.from({ length: count }, (_, index) => ({
				id: `${provider}-${index}`,
				title: `歌曲 ${index + 1}`,
				subtitle: "",
				kind: "Track",
				coverUrl: "",
			})),
		})),
	};
}

test("flattens pages into segments preserving API return order", () => {
	const segments = flattenRecommendationFeed([
		page("qq", [{ title: "QQ 模块一", count: 2 }, { title: "QQ 模块二", count: 1 }]),
		page("netease", [{ title: "网易模块", count: 3 }]),
	]);

	expect(
		segments.map((segment) => `${segment.provider}:${segment.module.title}`),
	).toEqual(["qq:QQ 模块一", "qq:QQ 模块二", "netease:网易模块"]);
});

test("skips empty modules but keeps later ones in order", () => {
	const segments = flattenRecommendationFeed([
		page("netease", [{ title: "空模块", count: 0 }, { title: "有内容", count: 2 }]),
	]);

	expect(segments.length).toBe(1);
	expect(segments[0].provider).toBe("netease");
	expect(segments[0].module.title).toBe("有内容");
});

test("returns empty feed for no pages or all-empty modules", () => {
	expect(flattenRecommendationFeed([]).length).toBe(0);
	expect(flattenRecommendationFeed([page("qq", [{ title: "空", count: 0 }])]).length).toBe(
		0,
	);
});

test("chunkIntoColumns splits items into fixed-size columns", () => {
	const items = Array.from({ length: 7 }, (_, i) => i);
	expect(chunkIntoColumns(items, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
	expect(chunkIntoColumns(items, 7)).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
	expect(chunkIntoColumns([], 3)).toEqual([]);
});

test("resolveRecommendationCardDisplay applies title fallback rules", () => {
	expect(resolveRecommendationCardDisplay({ title: "歌名", subtitle: "歌手", id: "1", kind: "Track" } as RecommendationCard)).toEqual({
		title: "歌名",
		subtitle: "歌手",
	});
	expect(
		resolveRecommendationCardDisplay({ title: "", subtitle: "只有副标题", id: "2", kind: "Playlist" } as RecommendationCard),
	).toEqual({ title: "只有副标题", subtitle: "" });
	expect(resolveRecommendationCardDisplay({ title: "", subtitle: "", id: "3", kind: "Unknown" } as RecommendationCard)).toEqual({
		title: "",
		subtitle: "",
	});
});

test("buildTrackFromRecommendationCard synthesizes a playable track", () => {
	const track = buildTrackFromRecommendationCard("qq", {
		id: "0039MnYb0qxYhV",
		title: "晴天",
		subtitle: "周杰伦 / 杨瑞代",
		kind: "Track",
		coverUrl: "https://example.com/cover.jpg",
	} as RecommendationCard);

	expect(track).toEqual({
		provider: "qq",
		id: "0039MnYb0qxYhV",
		sourceId: "0039MnYb0qxYhV",
		title: "晴天",
		artists: ["周杰伦", "杨瑞代"],
		album: "",
		coverUrl: "https://example.com/cover.jpg",
		qualityHints: [],
		playableState: "playable",
	});
});

test("buildTrackFromRecommendationCard falls back to subtitle as title without artists", () => {
	const track = buildTrackFromRecommendationCard("netease", {
		id: "42",
		title: "",
		subtitle: "只有副标题的歌",
		kind: "Track",
		coverUrl: "",
	} as RecommendationCard);

	expect(track.title).toBe("只有副标题的歌");
	expect(track.artists).toEqual([]);
});

test("buildTrackFromRecommendationCard tolerates empty card text", () => {
	const track = buildTrackFromRecommendationCard("kugou", {
		id: "x-1",
		title: "",
		subtitle: "",
		kind: "Track",
		coverUrl: "",
	} as RecommendationCard);

	expect(track.id).toBe("x-1");
	expect(track.sourceId).toBe("x-1");
	expect(track.title).toBe("");
	expect(track.artists).toEqual([]);
});
