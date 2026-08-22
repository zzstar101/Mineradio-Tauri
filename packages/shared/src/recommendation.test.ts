import { expect, test } from "bun:test";
import { RecommendationPageArraySchema } from "./recommendation";

test("RecommendationPageArraySchema accepts provider recommendation pages", () => {
	const pages = RecommendationPageArraySchema.parse([
		{
			provider: "netease",
			list: [
				{
					title: "每日推荐",
					kind: "Mixed",
					list: [
						{
							id: "track-1",
							kind: "Track",
							coverUrl: "https://example.com/cover.jpg",
						},
					],
				},
			],
		},
		{
			provider: "qq",
			list: [{
				title: "歌单",
				kind: "Playlist",
				list: [],
			}],
		},
	]);

	expect(pages.length).toBe(2);
	expect(pages[0].list[0].list[0]).toEqual({
		id: "track-1",
		title: "",
		subtitle: "",
		kind: "Track",
		coverUrl: "https://example.com/cover.jpg",
		collected: undefined,
	});
	expect(pages[1].provider).toBe("qq");
});

test("RecommendationPageArraySchema rejects invalid providers", () => {
	const result = RecommendationPageArraySchema.safeParse([
		{ provider: "spotify", list: [] },
	]);

	expect(result.success).toBe(false);
});
