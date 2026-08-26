import { expect, test } from "bun:test";
import {
	loadPlaybackSessionCheckpoint,
	savePlaybackSessionCheckpoint,
	TAURI_PLAYBACK_SESSION_LOAD_COMMAND,
	TAURI_PLAYBACK_SESSION_SAVE_COMMAND,
} from "./tauri-playback-session";

// 测试环境无 __TAURI_INTERNALS__ → 两个 wrapper 都走占位分支。
test("save wrapper is a no-op success outside the Tauri runtime", async () => {
	expect(await savePlaybackSessionCheckpoint({ schema: "playback-session-persist-v1" })).toEqual({
		ok: true,
	});
});

test("load wrapper degrades to no persisted session outside the Tauri runtime", async () => {
	expect(await loadPlaybackSessionCheckpoint()).toBeNull();
});

test("command name constants stay aligned with the desktop manifest", () => {
	expect(TAURI_PLAYBACK_SESSION_SAVE_COMMAND).toBe("playback_session_checkpoint_save");
	expect(TAURI_PLAYBACK_SESSION_LOAD_COMMAND).toBe("playback_session_checkpoint_load");
});
