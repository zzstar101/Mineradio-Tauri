import { invokeTauriCommand, isTauriRuntime } from "../../tauri/runtime";

export const TAURI_PLAYBACK_SESSION_SAVE_COMMAND =
	"playback_session_checkpoint_save" as const;
export const TAURI_PLAYBACK_SESSION_LOAD_COMMAND =
	"playback_session_checkpoint_load" as const;

/**
 * Wire 类型刻意保持宽松：payload 是不透明 envelope，深度校验属于 playback store
 * 的 `restorePlaybackExitCheckpoint`。Rust 侧只做 256 KiB 字节上限校验。
 */
export type PlaybackSessionCheckpointSaveResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

const SAVE_OK: PlaybackSessionCheckpointSaveResult = Object.freeze({ ok: true });

function failedSave(reason: string): PlaybackSessionCheckpointSaveResult {
	return Object.freeze({ ok: false, reason });
}

/** Tauri 外为 no-op 成功：浏览器构建没有会话 checkpoint 文件。 */
export async function savePlaybackSessionCheckpoint(
	payload: unknown,
): Promise<PlaybackSessionCheckpointSaveResult> {
	if (!isTauriRuntime()) return SAVE_OK;
	try {
		const result = await invokeTauriCommand<{ ok?: unknown }>(
			TAURI_PLAYBACK_SESSION_SAVE_COMMAND,
			{ request: payload },
		);
		return result && result.ok === true
			? SAVE_OK
			: failedSave("PLAYBACK_SESSION_SAVE_REJECTED");
	} catch (error) {
		// Tauri command Err(String) 会以字符串 reject；TOO_LARGE 等 stable code 原样透出。
		return failedSave(
			typeof error === "string" ? error : "PLAYBACK_SESSION_SAVE_FAILED",
		);
	}
}

/** Tauri 外返回 null（无持久会话）；读取失败按无 checkpoint 处理并仅 console.warn。 */
export async function loadPlaybackSessionCheckpoint(): Promise<unknown | null> {
	if (!isTauriRuntime()) return null;
	try {
		return await invokeTauriCommand(TAURI_PLAYBACK_SESSION_LOAD_COMMAND);
	} catch (error) {
		console.warn("playback session checkpoint load failed", error);
		return null;
	}
}
