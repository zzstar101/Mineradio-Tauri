import { expect, test } from "bun:test";
import {
	LOCAL_AUDIO_ACCEPT,
	LOCAL_AUDIO_IMPORT_LIMIT,
	createLocalAudioTrack,
	firstLocalAudioFile,
	localAudioFiles,
  firstLocalCoverFile,
  isLocalAudioFile,
  isLocalCoverFile,
  readLocalFileAsDataUrl
} from "./local-audio-import";

test("isLocalAudioFile accepts the baseline audio extensions and MIME types", () => {
  expect(LOCAL_AUDIO_ACCEPT).toBe(".mp3,.flac,.wav,.ogg,.m4a,.jpg,.jpeg,.png,.webp");
  expect(isLocalAudioFile({ name: "song.MP3", type: "" })).toBe(true);
  expect(isLocalAudioFile({ name: "song", type: "audio/flac" })).toBe(true);
  expect(isLocalAudioFile({ name: "cover.png", type: "image/png" })).toBe(false);
});

test("firstLocalAudioFile picks the first audio file from a mixed import selection", () => {
  const files = [
    { name: "cover.jpg", type: "image/jpeg" },
    { name: "live.m4a", type: "" },
    { name: "other.mp3", type: "" }
  ];

  expect(firstLocalAudioFile(files)?.name).toBe("live.m4a");
});

test("localAudioFiles deduplicates exact file identity and caps large selections", () => {
	const files = [
		{ name: "a.mp3", size: 1, lastModified: 2 },
		{ name: "a.mp3", size: 1, lastModified: 2 },
		{ name: "b.flac", size: 2, lastModified: 3 },
	];
	expect(localAudioFiles(files).map((file) => file.name)).toEqual(["a.mp3", "b.flac"]);
	expect(LOCAL_AUDIO_IMPORT_LIMIT).toBe(5000);
});

test("local cover helpers pick image files and preserve image MIME in data URLs", async () => {
  const files = [
    { name: "notes.txt", type: "text/plain" },
    new File(["cover"], "Cover.JPG", { type: "" })
  ];

  expect(isLocalCoverFile({ name: "folder.png", type: "" })).toBe(true);
  expect(isLocalCoverFile({ name: "song.mp3", type: "audio/mpeg" })).toBe(false);
  expect(firstLocalCoverFile(files)?.name).toBe("Cover.JPG");
  expect(await readLocalFileAsDataUrl(files[1] as File)).toBe("data:image/jpeg;base64,Y292ZXI=");
});

test("createLocalAudioTrack maps a local file into a playback-compatible track", () => {
  const track = createLocalAudioTrack({
    name: "My Song.flac",
    type: "audio/flac",
    size: 1234,
    lastModified: 5678
  });

  expect(track).toEqual({
    provider: "netease",
    id: "local:My Song.flac:1234:5678",
    sourceId: "local:My Song.flac:1234:5678",
    title: "My Song",
    artists: ["本地文件"],
    album: "",
    coverUrl: "",
    durationMs: undefined,
    qualityHints: ["local"],
    playableState: "playable"
  });
});
