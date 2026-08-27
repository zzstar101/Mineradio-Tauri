import { expect, test } from "bun:test";
import { SidecarClient } from "../../api/sidecar-client";
import { createLegacyMediaUrl } from "./legacy-media-url";

test("legacy media adapter returns byte-for-byte current SidecarClient URLs", () => {
	const client = new SidecarClient();
	const media = createLegacyMediaUrl(client);
	const remoteAudio = "https://example.com/audio.mp3?token=测试";
	const relativeAudio = "/providers/soda/audio-proxy?id=track-1";
	const image = "https://example.com/cover.jpg?size=640";

	expect(media.audioProxyUrl(remoteAudio)).toBe(client.audioProxyUrl(remoteAudio));
	expect(media.playableUrl(relativeAudio)).toBe(client.proxiedUrl(relativeAudio));
	expect(media.playableUrl(remoteAudio)).toBe(client.proxiedUrl(remoteAudio));
	expect(media.imageUrl(image)).toBe(client.imageProxyUrl(image));
	expect(media.imageUrl(image, { cacheBust: true, now: 1234 }))
		.toBe(client.imageProxyUrl(image, true, 1234));
	expect(media.imageSource(image)).toEqual({
		uri: client.imageProxyUrl(image),
		fallbackUri: image,
	});
	expect(media.imageSource(image, { cacheBust: true, now: 1234 })).toEqual({
		uri: client.imageProxyUrl(image, true, 1234),
		fallbackUri: image,
	});
});

test("legacy media adapter keeps inline images opaque and rejects unsupported sources", () => {
	const client = new SidecarClient();
	const media = createLegacyMediaUrl(client);

	expect(media.imageSource("data:image/png;base64,abc")).toEqual({
		uri: "data:image/png;base64,abc",
	});
	expect(media.imageSource("blob:http://local/cover")).toEqual({
		uri: "blob:http://local/cover",
	});
	expect(media.imageSource("file:///tmp/cover.jpg")).toEqual({
		uri: "",
	});
	expect(media.imageSource("")).toEqual({ uri: "" });
});

test("legacy media adapter preserves the App fallback when proxiedUrl is unavailable", () => {
	const client = {
		audioProxyUrl: (url: string) => `audio:${url}`,
		imageProxyUrl: (url: string) => `image:${url}`,
	};
	const media = createLegacyMediaUrl(client);
	const providerProxyPath = "/providers/soda/audio-proxy?id=track-1";

	expect(media.playableUrl(providerProxyPath)).toBe(providerProxyPath);
});
