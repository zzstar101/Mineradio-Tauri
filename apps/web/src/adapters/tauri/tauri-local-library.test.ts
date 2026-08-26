import { expect, test } from "bun:test";
import {
	importLocalLibraryDialog,
	importLocalLibraryPaths,
	listLocalLibrary,
	readDroppedImageBlob,
	readLocalLibraryLyric,
	removeLocalLibraryTracks,
} from "./tauri-local-library";

// 测试环境无 __TAURI_INTERNALS__ → 全部 wrapper 走占位分支。
test("local library wrappers return safe empty results outside the Tauri runtime", async () => {
	const dialog = await importLocalLibraryDialog(false);
	expect(dialog).toEqual({ ok: true, version: null, count: 0, tracks: [] });
	const folderDialog = await importLocalLibraryDialog(true);
	expect(folderDialog.tracks).toEqual([]);
	const paths = await importLocalLibraryPaths(["C:\\Music\\a.mp3"]);
	expect(paths).toEqual({ ok: true, version: null, count: 0, tracks: [] });
	const list = await listLocalLibrary();
	expect(list.ok).toBe(true);
	expect(list.count).toBe(0);
	expect(list.version).toBeNull();
});

test("lyric and removal wrappers degrade to no-ops outside the Tauri runtime", async () => {
	const lyric = await readLocalLibraryLyric("abc123");
	expect(lyric).toEqual({ ok: false, localFileId: "abc123", lyric: null, missing: true });
	const removed = await removeLocalLibraryTracks(["local:a"]);
	expect(removed).toEqual({ removed: 0 });
});

test("dropped image blob resolution is unavailable in placeholder mode", async () => {
	expect(await readDroppedImageBlob("C:\\cover.png")).toBeNull();
});
