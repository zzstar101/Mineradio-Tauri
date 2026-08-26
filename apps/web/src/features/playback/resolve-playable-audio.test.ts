import { expect, test } from "bun:test";
import type { PlaybackQualityRequest, SongUrlResult, Track } from "@mineradio/shared";
import type { MediaUrlPort } from "../../ports/media-url-port";
import type { PlaybackPort } from "../../ports/music/playback-port";
import { resolvePlayableAudio } from "./resolve-playable-audio";

const track: Track = {
	provider: "netease",
	id: "track-1",
	sourceId: "track-1",
	title: "测试歌曲",
	artists: ["测试歌手"],
	album: "",
	coverUrl: "",
	qualityHints: [],
	playableState: "playable",
};

function createFixture(result: SongUrlResult) {
	const calls: string[] = [];
	const playback = {
		async songUrl() { return result; },
		async resolveSongUrl(nextTrack: Track, quality?: PlaybackQualityRequest) {
			calls.push(`resolve:${nextTrack.id}:${quality ?? "default"}`);
			return result;
		},
		async trackQualities() {
			return { provider: track.provider, trackId: track.id, qualities: [] };
		},
	} satisfies PlaybackPort;
	const mediaUrl = {
		audioProxyUrl(url: string) {
			calls.push(`audio:${url}`);
			return `audio-proxy:${url}`;
		},
		playableUrl(url: string) {
			calls.push(`playable:${url}`);
			return `playable:${url}`;
		},
		imageSource(url: string) { return { uri: url }; },
		imageUrl(url: string) { return url; },
	} satisfies MediaUrlPort;
	return { calls, playback, mediaUrl };
}

test("resolvePlayableAudio routes ordinary remote URLs through playableUrl", async () => {
	const fixture = createFixture({
		url: "https://example.com/audio.flac",
		quality: "lossless",
	});

	const resolved = await resolvePlayableAudio({
		playback: fixture.playback,
		mediaUrl: fixture.mediaUrl,
		track,
		quality: "lossless",
	});

	expect(resolved.audioUrl).toBe("playable:https://example.com/audio.flac");
	expect(resolved.result.quality).toBe("lossless");
	expect(fixture.calls).toEqual([
		"resolve:track-1:lossless",
		"playable:https://example.com/audio.flac",
	]);
});

test("resolvePlayableAudio routes provider proxy paths through playableUrl", async () => {
	const fixture = createFixture({
		url: "/providers/soda/audio-proxy?id=track-1",
		quality: "standard",
	});

	const resolved = await resolvePlayableAudio({
		playback: fixture.playback,
		mediaUrl: fixture.mediaUrl,
		track,
	});

	expect(resolved.audioUrl).toBe(
		"playable:/providers/soda/audio-proxy?id=track-1",
	);
	expect(fixture.calls).toEqual([
		"resolve:track-1:default",
		"playable:/providers/soda/audio-proxy?id=track-1",
	]);
});

test("resolvePlayableAudio preserves the current unavailable URL message", async () => {
	const fixture = createFixture({
		url: "",
		quality: "standard",
		message: "当前音源不可用",
	});

	let message = "";
	try {
		await resolvePlayableAudio({
			playback: fixture.playback,
			mediaUrl: fixture.mediaUrl,
			track,
		});
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toBe("当前音源不可用");
	expect(fixture.calls).toEqual(["resolve:track-1:default"]);
});
