import type { PlayableState, PreviewRange, ProviderId } from "@mineradio/shared";
import type { TrialBannerState } from "./usePlaybackSessionRuntime";

/** 试听测量容差：区间毫秒由秒换算而来 */
export const PREVIEW_MEASURE_TOLERANCE_MS = 5000;

/** 横幅种类：
 * - expected-trial：权限受限（需 VIP/购买），且实测音频确实只是试听区间
 * - unexpected-trial：预期外拿到了试听（用户已是 VIP，或本来是普通歌曲）
 * - full-audio：实测时长明显大于区间（服务端给了完整音频），无需横幅
 * - null：数据不足/没有区间，不作结论 */
export type PreviewOutcome = {
	kind: "expected-trial" | "unexpected-trial" | "full-audio";
	text: string;
} | null;

const NEEDS_GATE_STATES: ReadonlySet<PlayableState> = new Set([
	"vip_required",
	"paid_required",
	"login_required",
	"trial_only",
]);

/**
 * 试听结果评估（纯函数）。
 * 入参：song_url 返回的试听区间、实测音频时长、track 的 playable_state、
 *      以及客户端会话已知的该 provider 是否已有 VIP（拿不准传 undefined）。
 * 出参：{ kind, text } 或 null。kind 用于区分"正常 VIP 试听"与"异常命中试听"。
 */
export function evaluatePreviewResult(input: {
	previewRange?: PreviewRange | null;
	actualDurationMs?: number | null;
	playableState?: PlayableState;
	userIsVip?: boolean;
}): PreviewOutcome {
	if (
		!input.previewRange ||
		input.actualDurationMs == null ||
		input.actualDurationMs <= 0
	) {
		return null;
	}
	const matched =
		Math.abs(input.actualDurationMs - input.previewRange.endMs) <
		PREVIEW_MEASURE_TOLERANCE_MS;
	if (!matched) {
		return { kind: "full-audio", text: "" };
	}

	const gatedTrack = NEEDS_GATE_STATES.has(
		input.playableState ?? "unknown",
	);

	// 异常路径：本应是完整播放却拿到了试听
	if (input.userIsVip === true || (!gatedTrack && input.userIsVip !== false)) {
		// 普通 playable 轨道或已知 VIP 用户命中试听 → 异常提示
		if (input.userIsVip === true || input.playableState === "playable") {
			return {
				kind: "unexpected-trial",
				text: "检测到试听片段 · 与当前账户权限不符，音源可能异常",
			};
		}
	}
	return {
		kind: "expected-trial",
		text: "需要 VIP · 当前歌曲试听中",
	};
}

/** 跨源失败后的文案：按 track 的 playable_state 单独匹配 */
export function crossSourceFailureBannerText(state: PlayableState): string {
	switch (state) {
		case "copyright_unavailable":
			return "歌曲不可用 · 无版权音源";
		case "paid_required":
			return "此歌曲需单独付费";
		case "vip_required":
			return "跨源后仍无可用音源 · 需要 VIP";
		case "login_required":
			return "登录后可获取此歌曲的音源";
		case "unavailable":
		default:
			return "歌曲不可用 · 未找到音源";
	}
}

export type ProviderHint = ProviderId;

export function buildTrialBanner(
	outcome: NonNullable<PreviewOutcome>,
	provider: ProviderId,
): TrialBannerState {
	return { text: outcome.text, provider, showLogin: false };
}
