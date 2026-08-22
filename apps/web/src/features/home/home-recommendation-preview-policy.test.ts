import { expect, test } from "bun:test";
import type { RecommendationPage } from "@mineradio/shared";
import { buildHomeRecommendationPreviews } from "./home-recommendation-preview-policy";

function page(provider: RecommendationPage["provider"], title: string, count = 1): RecommendationPage {
	return {
		provider,
		list: [
			{
				title,
				kind: "Mixed",
				list: Array.from({ length: count }, (_, index) => ({
					id: `${provider}-${index}`,
					title: `歌曲 ${index + 1}`,
					subtitle: "",
					kind: "Track",
					coverUrl: "",
				})),
			},
			{ title: "第二个模块", kind: "Mixed", list: [{ id: "second", title: "", subtitle: "", kind: "Track", coverUrl: "" }] },
		],
	};
}

test("builds one first-module preview per provider in canonical order", () => {
	const previews = buildHomeRecommendationPreviews([
		page("qq", "QQ 推荐"),
		page("netease", "网易云推荐"),
	]);

	expect(previews.map((preview) => preview.provider)).toEqual(["netease", "qq"]);
	expect(previews[0].title).toBe("网易云推荐");
	expect(previews[0].cards[0].id).toBe("netease-0");
	expect(previews[0].cards.length).toBe(1);
});

test("limits preview cards", () => {
	const previews = buildHomeRecommendationPreviews([
		page("netease", "", 3),
		page("qq", "QQ 推荐", 12),
	]);

	expect(previews.length).toBe(2);
	expect(previews[0].provider).toBe("netease");
	expect(previews[0].title).toBe("");
	expect(previews[0].cards.length).toBe(3);
	expect(previews[0].cards.at(-1)?.id).toBe("netease-2");
	expect(previews[1].provider).toBe("qq");
	expect(previews[1].cards.length).toBe(8);
	expect(previews[1].cards.at(-1)?.id).toBe("qq-7");
});
