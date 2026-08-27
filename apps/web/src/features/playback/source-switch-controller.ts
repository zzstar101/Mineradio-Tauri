import type { ProviderId, Track } from "@mineradio/shared";
import type { PlaybackPort } from "../../ports/music/playback-port";
import type { SearchPort } from "../../ports/music/search-port";
import { selectStrictSourceCandidate } from "./source-switch-policy";

export interface SourceSwitchPlaybackSnapshot {
	track: Track | null;
	playbackIntentId: number;
	positionMs: number;
}

export interface SourceSwitchCommitRequest {
	candidate: Track;
	expectedPlaybackIntentId: number;
	preservePositionMs: number;
	resolvedProvider: ProviderId;
}

export type SourceSwitchResult =
	| { status: "success"; track: Track; resolvedProvider: ProviderId }
	| { status: "stale" }
	| { status: "not-found" }
	| { status: "unavailable"; message: string }
	| { status: "unsupported"; message: string }
	| { status: "failed"; message: string };

export interface SourceSwitchControllerDependencies {
	search: SearchPort;
	playback: PlaybackPort;
	getPlaybackSnapshot(): SourceSwitchPlaybackSnapshot;
	commit(request: SourceSwitchCommitRequest): boolean | Promise<boolean>;
}

interface PendingSourceRollback {
	original: SourceSwitchPlaybackSnapshot & { track: Track };
	committed: SourceSwitchPlaybackSnapshot & { track: Track };
}

const PROVIDERS = new Set<ProviderId>(["netease", "qq", "soda"]);

function samePlaybackAuthority(
	expected: SourceSwitchPlaybackSnapshot,
	actual: SourceSwitchPlaybackSnapshot,
): boolean {
	return (
		expected.playbackIntentId === actual.playbackIntentId &&
		expected.track?.provider === actual.track?.provider &&
		expected.track?.id === actual.track?.id
	);
}

function sameTrack(left: Track | null, right: Track | null): boolean {
	return Boolean(
		left &&
			right &&
			left.provider === right.provider &&
			left.id === right.id,
	);
}

export class SourceSwitchController {
	private generation = 0;
	private pendingRollback: PendingSourceRollback | null = null;

	constructor(private readonly dependencies: SourceSwitchControllerDependencies) {}

	async switchTo(provider: ProviderId): Promise<SourceSwitchResult> {
		const generation = ++this.generation;
		this.pendingRollback = null;
		const expected = this.dependencies.getPlaybackSnapshot();
		const original = expected.track;
		if (!original) {
			return { status: "unsupported", message: "当前没有可切换的歌曲" };
		}
		if (original.provider === provider) {
			return { status: "unsupported", message: "当前已在使用该音源" };
		}
		const query = [original.title, original.artists[0] ?? ""]
			.map((value) => value.trim())
			.filter(Boolean)
			.join(" ");
		try {
			const candidates = await this.dependencies.search.search(provider, query, 20);
			if (
				generation !== this.generation ||
				!samePlaybackAuthority(expected, this.dependencies.getPlaybackSnapshot())
			) {
				return { status: "stale" };
			}
			const candidate = selectStrictSourceCandidate(original, candidates);
			if (!candidate) return { status: "not-found" };
			const resolved = await this.dependencies.playback.resolveSongUrl(candidate);
			if (
				generation !== this.generation ||
				!samePlaybackAuthority(expected, this.dependencies.getPlaybackSnapshot())
			) {
				return { status: "stale" };
			}
			// 失败现在由 api_bridge 错误信封抛出（兼容错误类型仍沿用旧名），由外层统一归因；
			// 成功结果里不再携带 playable/provider/message 等整合字段
			if (!resolved.url) {
				return {
					status: "unavailable",
					message: "目标音源暂不可播放",
				};
			}
			const resolvedProvider = candidate.provider;
			if (resolvedProvider !== provider) {
				return {
					status: "unavailable",
					message: `目标音源回退到了 ${resolvedProvider}，已保留当前播放`,
				};
			}
			const committed = await this.dependencies.commit({
				candidate,
				expectedPlaybackIntentId: expected.playbackIntentId,
				preservePositionMs: expected.positionMs,
				resolvedProvider,
			});
			if (!committed) return { status: "stale" };
			const committedSnapshot = this.dependencies.getPlaybackSnapshot();
			if (
				sameTrack(committedSnapshot.track, candidate) &&
				committedSnapshot.playbackIntentId > expected.playbackIntentId
			) {
				this.pendingRollback = {
					original: { ...expected, track: original },
					committed: { ...committedSnapshot, track: candidate },
				};
			}
			return { status: "success", track: candidate, resolvedProvider };
		} catch (error) {
			if (
				generation !== this.generation ||
				!samePlaybackAuthority(expected, this.dependencies.getPlaybackSnapshot())
			) {
				return { status: "stale" };
			}
			return {
				status: "failed",
				message: error instanceof Error ? error.message : "音源切换失败",
			};
		}
	}

	async handlePlaybackFailure(): Promise<boolean> {
		const pending = this.pendingRollback;
		if (!pending) return false;
		const actual = this.dependencies.getPlaybackSnapshot();
		if (!samePlaybackAuthority(pending.committed, actual)) {
			this.pendingRollback = null;
			return false;
		}
		this.pendingRollback = null;
		return await this.dependencies.commit({
			candidate: pending.original.track,
			expectedPlaybackIntentId: actual.playbackIntentId,
			preservePositionMs: pending.original.positionMs,
			resolvedProvider: pending.original.track.provider,
		});
	}

	handlePlaybackReady(): boolean {
		const pending = this.pendingRollback;
		if (!pending) return false;
		if (!samePlaybackAuthority(pending.committed, this.dependencies.getPlaybackSnapshot())) {
			this.pendingRollback = null;
			return false;
		}
		this.pendingRollback = null;
		return true;
	}

	cancel(): void {
		this.generation += 1;
		this.pendingRollback = null;
	}
}
