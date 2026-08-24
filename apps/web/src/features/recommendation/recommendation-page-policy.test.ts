import { expect, test } from "bun:test";
import type { RecommendationPage } from "@mineradio/shared";
import {
	chunkIntoColumns,
	flattenRecommendationFeed,
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
