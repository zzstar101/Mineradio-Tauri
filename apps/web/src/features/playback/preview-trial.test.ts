import { expect, test } from "bun:test";
import { crossSourceFailureBannerText, evaluatePreviewResult } from "./preview-trial";

test("非 VIP + 受限轨 + 命中区间 → expected-trial", () => {
	const outcome = evaluatePreviewResult({
		previewRange: { startMs: 0, endMs: 30_000 },
		actualDurationMs: 30_400,
		playableState: "vip_required",
		userIsVip: false,
	});
	expect(outcome?.kind).toBe("expected-trial");
	expect(outcome?.text).toContain("需要 VIP");
});

test("普通歌曲却命中区间 → unexpected-trial", () => {
	const outcome = evaluatePreviewResult({
		previewRange: { startMs: 0, endMs: 30_000 },
		actualDurationMs: 30_400,
		playableState: "playable",
	});
	expect(outcome?.kind).toBe("unexpected-trial");
});

test("已知 VIP 用户命中区间 → unexpected-trial", () => {
	const outcome = evaluatePreviewResult({
		previewRange: { startMs: 0, endMs: 30_000 },
		actualDurationMs: 30_400,
		playableState: "vip_required",
		userIsVip: true,
	});
	expect(outcome?.kind).toBe("unexpected-trial");
});

test("实测时长明显大于区间 → full-audio（无横幅文本）", () => {
	const outcome = evaluatePreviewResult({
		previewRange: { startMs: 0, endMs: 30_000 },
		actualDurationMs: 180_000,
		playableState: "vip_required",
	});
	expect(outcome?.kind).toBe("full-audio");
});

test("缺数据 → null", () => {
	expect(evaluatePreviewResult({ previewRange: null, actualDurationMs: 30_000, playableState: "playable" })).toBeNull();
	expect(
		evaluatePreviewResult({ previewRange: { startMs: 0, endMs: 30_000 }, actualDurationMs: null, playableState: "playable" }),
	).toBeNull();
});

test("跨源失败文案按状态匹配", () => {
	expect(crossSourceFailureBannerText("copyright_unavailable")).toContain("无版权");
	expect(crossSourceFailureBannerText("vip_required")).toContain("需要 VIP");
	expect(crossSourceFailureBannerText("unavailable")).toContain("未找到音源");
});
