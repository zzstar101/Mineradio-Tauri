import { expect, test } from "bun:test";
import type { ProviderId, SongUrlResult, Track } from "@mineradio/shared";
import { SourceSwitchController } from "./source-switch-controller";

const ORIGINAL: Track = {
	provider: "netease",
	id: "origin",
	sourceId: "origin",
	title: "晴天",
	artists: ["周杰伦"],
	album: "叶惠美",
	coverUrl: "",
	durationMs: 240_000,
	qualityHints: [],
	playableState: "playable",
};

const QQ: Track = { ...ORIGINAL, provider: "qq", id: "qq", sourceId: "qq" };

test("匹配期间播放 intent 变化时旧音源结果不能修改队列", async () => {
	let intent = 7;
	let resolveSearch: ((tracks: Track[]) => void) | null = null;
	const commits: string[] = [];
	const controller = new SourceSwitchController({
		search: {
			search: () => new Promise<Track[]>((resolve) => {
				resolveSearch = resolve;
			}),
			searchAll: async () => [],
		},
		playback: {
			async songUrl() { return { url: null }; },
			async resolveSongUrl(): Promise<SongUrlResult> {
				return { url: "https://audio.example/qq", provider: "qq" };
			},
			async trackQualities() {
				return { provider: "qq", trackId: "qq", qualities: [] };
			},
		},
		getPlaybackSnapshot: () => ({
			track: ORIGINAL,
			playbackIntentId: intent,
			positionMs: 42_000,
		}),
		commit: ({ candidate, expectedPlaybackIntentId }) => {
			commits.push(`${candidate.provider}:${expectedPlaybackIntentId}`);
			return true;
		},
	});

	const switching = controller.switchTo("qq" satisfies ProviderId);
	intent = 8;
	(resolveSearch as ((tracks: Track[]) => void) | null)?.([QQ]);
	const result = await switching;

	expect(result.status).toBe("stale");
	expect(commits).toEqual([]);
});

test("成功切换会保留位置并提交解析确认后的实际 provider", async () => {
	const commits: Array<Record<string, unknown>> = [];
	const controller = new SourceSwitchController({
		search: {
			async search() { return [QQ]; },
			async searchAll() { return []; },
		},
		playback: {
			async songUrl() { return { url: null }; },
			async resolveSongUrl() {
				return {
					url: "https://audio.example/qq",
					proxied: false,
					provider: "qq",
					playable: true,
				};
			},
			async trackQualities() {
				return { provider: "qq", trackId: "qq", qualities: [] };
			},
		},
		getPlaybackSnapshot: () => ({
			track: ORIGINAL,
			playbackIntentId: 11,
			positionMs: 61_234,
		}),
		commit: (request) => {
			commits.push(request as unknown as Record<string, unknown>);
			return true;
		},
	});

	const result = await controller.switchTo("qq");

	expect(result.status).toBe("success");
	expect(commits.length).toBe(1);
	expect(commits[0]?.expectedPlaybackIntentId).toBe(11);
	expect(commits[0]?.preservePositionMs).toBe(61_234);
	expect(commits[0]?.resolvedProvider).toBe("qq");
});

test("新音源实际加载失败时会原子恢复原曲目和播放位置", async () => {
	let snapshot = {
		track: ORIGINAL as Track | null,
		playbackIntentId: 21,
		positionMs: 88_000,
	};
	const controller = new SourceSwitchController({
		search: {
			async search() { return [QQ]; },
			async searchAll() { return []; },
		},
		playback: {
			async songUrl() { return { url: null }; },
			async resolveSongUrl() {
				return {
					url: "https://audio.example/qq",
					proxied: false,
					provider: "qq" as const,
					playable: true,
				};
			},
			async trackQualities() {
				return { provider: "qq", trackId: "qq", qualities: [] };
			},
		},
		getPlaybackSnapshot: () => snapshot,
		commit: (request) => {
			if (snapshot.playbackIntentId !== request.expectedPlaybackIntentId) return false;
			snapshot = {
				track: request.candidate,
				playbackIntentId: snapshot.playbackIntentId + 1,
				positionMs: request.preservePositionMs,
			};
			return true;
		},
	});

	expect((await controller.switchTo("qq")).status).toBe("success");
	expect(snapshot.track?.provider).toBe("qq");
	expect(await controller.handlePlaybackFailure()).toBe(true);
	expect(snapshot.track).toEqual(ORIGINAL);
	expect(snapshot.positionMs).toBe(88_000);
	expect(snapshot.playbackIntentId).toBe(23);
});

test("新音源开始播放后不会把后续普通媒体错误误判为切换失败", async () => {
	let snapshot = {
		track: ORIGINAL as Track | null,
		playbackIntentId: 31,
		positionMs: 12_000,
	};
	const controller = new SourceSwitchController({
		search: {
			async search() { return [QQ]; },
			async searchAll() { return []; },
		},
		playback: {
			async songUrl() { return { url: null }; },
			async resolveSongUrl() {
				return { url: "https://audio.example/qq", provider: "qq" };
			},
			async trackQualities() {
				return { provider: "qq", trackId: "qq", qualities: [] };
			},
		},
		getPlaybackSnapshot: () => snapshot,
		commit: (request) => {
			if (snapshot.playbackIntentId !== request.expectedPlaybackIntentId) return false;
			snapshot = {
				track: request.candidate,
				playbackIntentId: snapshot.playbackIntentId + 1,
				positionMs: request.preservePositionMs,
			};
			return true;
		},
	});

	expect((await controller.switchTo("qq")).status).toBe("success");
	expect(controller.handlePlaybackReady()).toBe(true);
	expect(await controller.handlePlaybackFailure()).toBe(false);
	expect(snapshot.track).toEqual(QQ);
});
