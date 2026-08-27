import { expect, test } from "bun:test";
import {
	PlaybackQualitySchema,
	SongUrlRequestSchema,
	SongUrlResultSchema,
	TrackQualityAvailabilitySchema,
} from "./song-url";

test("SongUrlResultSchema parses the slimmed url result", () => {
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/audio.mp3",
		quality: "高清臻音",
		expiresAt: "2026-08-26T12:00:00Z",
		previewRange: { startMs: 0, endMs: 30_000 },
	});
	expect(parsed.url).toBe("https://example.com/audio.mp3");
	expect(parsed.quality).toBe("高清臻音");
	expect(parsed.previewRange?.endMs).toBe(30_000);
});

test("SongUrlResultSchema accepts url without optional fields", () => {
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/audio.flac",
	});
	expect(parsed.url).toBe("https://example.com/audio.flac");
	expect(parsed.previewRange).toBeUndefined();
	expect(parsed.expiresAt).toBeUndefined();
});

test("SongUrlResultSchema rejects missing url", () => {
	const result = SongUrlResultSchema.safeParse({});
	expect(result.success).toBe(false);
});

test("SongUrlResultSchema rejects wrong previewRange shape", () => {
	expect(
		SongUrlResultSchema.safeParse({
			url: "https://example.com/a.mp3",
			previewRange: { startMs: "0", endMs: 30_000 },
		}).success,
	).toBe(false);
	expect(
		SongUrlResultSchema.safeParse({
			url: "https://example.com/a.mp3",
			previewRange: { startMs: 0, duration: 30_000 },
		}).success,
	).toBe(false);
});

test("SongUrlResultSchema strips unexpected provider fields at the API boundary", () => {
	// 安全性：上游塞进来的多余字段（含敏感内容）必须在边界剥离
	const parsed = SongUrlResultSchema.parse({
		url: "https://example.com/a.mp3",
		cookie: "qqmusic_key=secret",
		vipLevel: "svip",
		message: "internal detail",
	});

	expect(JSON.stringify(parsed)).not.toContain("qqmusic_key");
	expect(JSON.stringify(parsed)).not.toContain("secret");
	expect(JSON.stringify(parsed)).not.toContain("vipLevel");
});

test("PlaybackQualitySchema normalizes baseline aliases and rejects unknown quality", () => {
	expect(PlaybackQualitySchema.parse("hi-res")).toBe("hires");
	expect(PlaybackQualitySchema.parse("320k")).toBe("exhigh");
	expect(PlaybackQualitySchema.parse("sq")).toBe("lossless");
	expect(PlaybackQualitySchema.safeParse("bad").success).toBe(false);
});

test("SongUrlRequestSchema carries track plus requested playback quality", () => {
	const parsed = SongUrlRequestSchema.parse({
		track: {
			provider: "netease",
			id: "1",
			sourceId: "1",
			title: "Song",
			artists: [],
			album: "",
			coverUrl: "",
			qualityHints: [],
			playableState: "playable",
		},
		quality: "lossless",
	});
	expect(parsed.quality).toBe("lossless");
	expect(parsed.track.id).toBe("1");
});

test("SongUrlRequestSchema accepts provider-native quality ids while normalizing legacy aliases", () => {
	const baseTrack = {
		provider: "qq",
		id: "1",
		sourceId: "1",
		title: "Song",
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "playable",
	};

	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "320" }).quality).toBe("320");
	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "higher" }).quality).toBe("higher");
	expect(SongUrlRequestSchema.parse({ track: baseTrack, quality: "hi-res" }).quality).toBe("hires");
});

test("TrackQualityAvailabilitySchema parses actual per-track quality options", () => {
	const parsed = TrackQualityAvailabilitySchema.parse({
		provider: "qq",
		trackId: "q1",
		defaultQuality: "flac",
		qualities: [
			{
				provider: "qq",
				id: "flac",
				label: "FLAC",
				short: "FLAC",
				requestQuality: "flac",
				type: "flac",
				size: 1024,
				source: "declared",
			},
		],
	});

	expect(parsed.qualities[0].requestQuality).toBe("flac");
	expect(parsed.qualities[0].source).toBe("declared");
});
