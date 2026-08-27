import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("App delegates desktop listeners and lyric lifecycle to the desktop runtime", () => {
	const appSource = readFileSync(
		fileURLToPath(new URL("../../apps/web/src/app/App.tsx", import.meta.url)),
		"utf8",
	);
	const runtimeSource = readFileSync(
		fileURLToPath(new URL(
			"../../apps/web/src/features/desktop/useDesktopRuntime.ts",
			import.meta.url,
		)),
		"utf8",
	);

	expect(appSource).toContain("useDesktopRuntime({");
	for (const forbidden of [
		"listenWindowState(",
		"listenGlobalHotkey(",
		"configureGlobalHotkeys(",
		"desktopLyricsPushStateRef",
		"shouldPushDesktopLyricsPayload(",
	]) {
		expect(appSource).not.toContain(forbidden);
	}

	expect(runtimeSource).toContain("DesktopRuntimePort");
	expect(runtimeSource).toContain("listenWindowState(");
	expect(runtimeSource).toContain("listenGlobalHotkey(");
});

test("Rust lib only assembles desktop state and native window events", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const libSource = readFileSync(`${rustRoot}/lib.rs`, "utf8");
	const stateSource = readFileSync(`${rustRoot}/app/state.rs`, "utf8");
	const desktopRuntimeSource = readFileSync(
		`${rustRoot}/app/desktop_runtime.rs`,
		"utf8",
	);

	expect(libSource).toContain(
		".on_window_event(app::desktop_runtime::handle_window_event)",
	);
	expect(libSource).toContain("app.run(app::desktop_runtime::handle_run_event)");
	expect(libSource).toContain("pub use app::state::{");
	for (const forbidden of [
		"pub struct AppState",
		"fn cleanup_runtime_once(",
		"fn schedule_background_working_set_trim(",
		"fn show_main_window(",
	]) {
		expect(libSource).not.toContain(forbidden);
	}

	expect(stateSource).toContain("pub struct AppState");
	expect(desktopRuntimeSource).toContain("pub fn handle_window_event(");
	expect(desktopRuntimeSource).toContain("pub fn cleanup_runtime_once(");
	const cleanupStart = desktopRuntimeSource.indexOf("pub fn cleanup_runtime_once(");
	const cleanupSource = desktopRuntimeSource.slice(cleanupStart);
	const cleanupOrder = [
		// sidecar supervisor/mark 步骤已随 rust-crate 迁移移除；
		// 现行顺序：回滚 → 壁纸场景销毁 → 状态清理 → 热键/歌词/托盘
		"recover_before_exit",
		"dispose_before_exit",
		"dispose_state_emit",
		"application_runtime_running",
		"clear_global_hotkeys",
		"desktop_lyrics_stop_middle_click_poller_state",
		"close_desktop_lyrics_window_for_shutdown",
		"remove_main_tray",
	].map((token) => cleanupSource.indexOf(token));
	expect(cleanupOrder.every((index) => index >= 0)).toBe(true);
	expect(cleanupOrder).toEqual([...cleanupOrder].sort((left, right) => left - right));
	const trimStart = desktopRuntimeSource.indexOf("fn schedule_background_working_set_trim(");
	const trimSource = desktopRuntimeSource.slice(trimStart);
	expect(trimSource.indexOf("application_runtime_running.load(Ordering::Acquire)")).toBeLessThan(
		trimSource.indexOf("trim_working_set("),
	);
});

test("desktop runtime claims lifecycle permission before UI recovery and exits after cleanup", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const source = readFileSync(`${rustRoot}/app/desktop_runtime.rs`, "utf8");
	const showStart = source.indexOf("pub fn show_main_window(");
	const showSource = source.slice(showStart, source.indexOf("pub fn request_application_exit("));

	expect(showSource.indexOf("runtime.request_show()")).toBeGreaterThanOrEqual(0);
	expect(showSource.indexOf("runtime.request_show()")).toBeLessThan(
		showSource.indexOf("window.show()"),
	);
	expect(showSource).toContain("window_adapter::emit_window_state(&window)");

	const closeStart = source.indexOf("CloseDecision::Exit =>");
	const closeSource = source.slice(closeStart, source.indexOf("CloseDecision::Ignore =>", closeStart));
	expect(closeSource.indexOf("cleanup_runtime_once(window.app_handle())")).toBeGreaterThanOrEqual(0);
	expect(closeSource.indexOf("app_handle().exit(0)")).toBeGreaterThan(
		closeSource.indexOf("cleanup_runtime_once(window.app_handle())"),
	);

	const lyricsStart = source.indexOf('if window.label() == window_labels::DESKTOP_LYRICS');
	const lyricsSource = source.slice(lyricsStart, source.indexOf('if window.label() != window_labels::MAIN'));
	expect(lyricsSource).toContain("tauri::WindowEvent::CloseRequested");
	expect(lyricsSource).toContain("tauri::WindowEvent::Destroyed");
	expect(lyricsSource).toContain("stop_desktop_lyrics_input_worker");
});

test("global hotkey command file is a thin Adapter over HotkeyRuntime", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const commandSource = readFileSync(`${rustRoot}/commands/hotkeys.rs`, "utf8");
	const runtimeSource = readFileSync(`${rustRoot}/runtime/hotkeys.rs`, "utf8");

	expect(commandSource.split(/\r?\n/).length).toBeLessThan(40);
	expect(commandSource).toContain("runtime::hotkeys");
	expect(commandSource).not.toContain("on_shortcut(");
	expect(runtimeSource).toContain("on_shortcut(");
	expect(runtimeSource).toContain("clear_global_hotkeys");
});

test("desktop lyrics command file is a thin Adapter over the runtime Module", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const commandSource = readFileSync(`${rustRoot}/commands/desktop_lyrics.rs`, "utf8");
	const runtimeSource = readFileSync(`${rustRoot}/runtime/desktop_lyrics.rs`, "utf8");

	expect(commandSource.split(/\r?\n/).length).toBeLessThan(100);
	expect(commandSource).toContain("runtime::desktop_lyrics");
	for (const forbidden of ["GetAsyncKeyState", "GetCursorPos", "desktop_lyrics_handle_middle_click", "#[cfg(test)]"]) {
		expect(commandSource).not.toContain(forbidden);
	}
	expect(runtimeSource).toContain("GetAsyncKeyState");
	expect(runtimeSource).toContain("desktop_lyrics_handle_middle_click");
});

test("window command file is a thin Adapter over the window runtime adapter", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const commandSource = readFileSync(`${rustRoot}/commands/window.rs`, "utf8");
	const runtimeSource = readFileSync(`${rustRoot}/runtime/window_adapter.rs`, "utf8");

	expect(commandSource.split(/\r?\n/).length).toBeLessThan(100);
	expect(commandSource).toContain("runtime::window_adapter");
	for (const forbidden of [
		"available_monitors()",
		"current_monitor()",
		"std::thread::spawn",
		"display_topology(",
	]) {
		expect(commandSource).not.toContain(forbidden);
	}
	expect(runtimeSource).toContain("available_monitors()");
	expect(runtimeSource).toContain("std::thread::spawn");
	expect(runtimeSource).not.toContain("commands::");
});

test("diagnostics command file is a thin Adapter over desktop diagnostics runtime", () => {
	const rustRoot = fileURLToPath(new URL(
		"../../apps/desktop/src-tauri/src/",
		import.meta.url,
	));
	const commandSource = readFileSync(`${rustRoot}/commands/diagnostics.rs`, "utf8");
	const runtimeSource = readFileSync(`${rustRoot}/app/desktop_diagnostics.rs`, "utf8");

	expect(commandSource.split(/\r?\n/).length).toBeLessThan(50);
	expect(commandSource).toContain("app::desktop_diagnostics");
	for (const forbidden of [
		"snapshot_verified_process_tree()",
		"latest_snapshot()",
		"hotkey_runtime_snapshot()",
		"build_database_status(",
		"record_runtime_error(",
	]) {
		expect(commandSource).not.toContain(forbidden);
	}
	expect(runtimeSource).toContain("snapshot_verified_process_tree()");
	expect(runtimeSource).toContain("latest_snapshot()");
	expect(runtimeSource).toContain("hotkey_runtime_snapshot()");
	expect(runtimeSource).toContain("build_database_status(");
	expect(runtimeSource).toContain("record_runtime_error(");
	expect(runtimeSource).not.toContain("commands::");
});
