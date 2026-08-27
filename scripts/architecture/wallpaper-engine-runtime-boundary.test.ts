import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rustRoot = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));
const read = (relative: string) => readFileSync(`${rustRoot}/${relative}`, "utf8");

test("M7 keeps command, core and Windows implementation on explicit seams", () => {
	expect(existsSync(`${rustRoot}/commands/wallpaper_engine.rs`)).toBe(true);
	expect(existsSync(`${rustRoot}/app/wallpaper_engine_runtime.rs`)).toBe(true);
	expect(existsSync(`${rustRoot}/runtime/wallpaper_engine/mod.rs`)).toBe(true);
	expect(existsSync(`${rustRoot}/platform/windows/wallpaper_engine/mod.rs`)).toBe(true);
	const command = read("commands/wallpaper_engine.rs");
	const app = read("app/wallpaper_engine_runtime.rs");
	const core = [
		"mod.rs", "library.rs", "project.rs", "ownership.rs", "journal.rs", "policy.rs",
	].map((file) => read(`runtime/wallpaper_engine/${file}`)).join("\n");
	expect(command).toContain("app::wallpaper_engine_runtime");
	for (const forbidden of ["windows_sys", "DwmRegisterThumbnail", "std::process::Command", "TcpListener"]) {
		expect(command).not.toContain(forbidden);
	}
	expect(app).toContain("WallpaperEngineRuntime");
	for (const forbidden of ["DwmRegisterThumbnail", "WinVerifyTrust", "TcpListener"]) {
		expect(app).not.toContain(forbidden);
	}
	for (const forbidden of ["tauri::", "windows_sys", "TcpListener", "axum::"]) {
		expect(core).not.toContain(forbidden);
	}
});

test("M7 native implementation has no helper process, TCP transport or synthetic cursor path", () => {
	const platformFiles = [
		"mod.rs", "discovery.rs", "trust.rs", "identity.rs", "scene.rs", "dwm_surface.rs", "wgc_sampler.rs",
	];
	const source = platformFiles.map((file) => read(`platform/windows/wallpaper_engine/${file}`)).join("\n");
	expect(source).toContain("DwmRegisterThumbnail");
	for (const forbidden of [
		"powershell", "PowerShell", "Add-Type", "CSharp", "TcpListener", "axum::",
		"SendInput", "WM_MOUSEMOVE", "mouse_event", "SetParent", "taskkill",
	]) {
		expect(source).not.toContain(forbidden);
	}
});

test("M7 shutdown and passive mode stop Wallpaper Engine after Full Desktop rollback", () => {
	const desktop = read("app/desktop_runtime.rs");
	const fullDesktop = read("app/full_desktop_runtime.rs");
	const cleanup = desktop.slice(desktop.indexOf("pub fn cleanup_runtime_once"));
	const fullDesktopIndex = cleanup.indexOf("recover_before_exit");
	const wallpaperIndex = cleanup.indexOf("dispose_before_exit");
	// sidecar 清理已随 rust-crate 迁移移除；壁纸销毁仍必须晚于 Full Desktop 回滚
	expect(fullDesktopIndex).toBeGreaterThanOrEqual(0);
	expect(wallpaperIndex).toBeGreaterThan(fullDesktopIndex);
	const setMode = fullDesktop.slice(fullDesktop.indexOf("pub fn set_mode_and_persist"));
	expect(setMode).toContain("prepare_full_desktop_transition");
});

test("M7 main WebView navigation, renderer failure and destruction share native Scene cleanup", () => {
	const mainWindow = read("app/main_window.rs");
	const wallpaperApp = read("app/wallpaper_engine_runtime.rs");
	const desktop = read("app/desktop_runtime.rs");
	const cargo = read("../Cargo.toml");
	expect(mainWindow).toContain(".on_navigation");
	expect(mainWindow).toContain("install_main_webview_process_failed_handler");
	expect(wallpaperApp).toContain("ProcessFailedEventHandler");
	expect(wallpaperApp).toContain("add_ProcessFailed");
	expect(wallpaperApp).toContain("stop_for_window_deactivation");
	expect(desktop).toContain("tauri::WindowEvent::Destroyed");
	expect(desktop).toContain("schedule_stop_for_webview_failure");
	expect(cargo).toContain('webview2-com = "=0.38.2"');
});

test("M7 serializes Full Desktop policy with Scene start and rejects stale lifecycle stops", () => {
	const state = read("app/state.rs");
	const command = read("commands/wallpaper_engine.rs");
	const fullDesktop = read("app/full_desktop_runtime.rs");
	const wallpaperApp = read("app/wallpaper_engine_runtime.rs");
	expect(state).toContain("desktop_wallpaper_transition: Arc<Mutex<()>>");
	expect(state).toContain("wallpaper_scene_epoch: AtomicU64");

	const start = command.slice(
		command.indexOf("pub async fn start_wallpaper_engine_scene"),
		command.indexOf("pub async fn stop_wallpaper_engine_scene"),
	);
	const transitionLockIndex = start.indexOf("let _transition = transition");
	const boundsReadIndex = start.indexOf("main_window_physical_bounds");
	const modeReadIndex = start.indexOf("full_desktop_mode");
	const startSceneIndex = start.lastIndexOf("start_scene");
	expect(transitionLockIndex).toBeGreaterThanOrEqual(0);
	expect(boundsReadIndex).toBeGreaterThanOrEqual(0);
	expect(transitionLockIndex).toBeGreaterThan(boundsReadIndex);
	expect(modeReadIndex).toBeGreaterThan(transitionLockIndex);
	expect(startSceneIndex).toBeGreaterThan(modeReadIndex);
	expect(fullDesktop).toContain("try_lock_desktop_wallpaper_transition");
	expect(fullDesktop).toContain("DESKTOP_WALLPAPER_TRANSITION_BUSY");
	const setMode = fullDesktop.slice(
		fullDesktop.indexOf("pub fn set_mode_and_persist"),
		fullDesktop.indexOf("pub fn recover_explicitly"),
	);
	expect(setMode.match(/rollback_full_desktop_transition/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	const recover = fullDesktop.slice(
		fullDesktop.indexOf("pub fn recover_explicitly"),
		fullDesktop.indexOf("pub fn set_icons_visible"),
	);
	expect(recover).toContain("FullDesktopMode::Disabled");
	const minimize = fullDesktop.slice(
		fullDesktop.indexOf("pub fn transition_to_passive_for_minimize"),
		fullDesktop.indexOf("pub fn sync_native_recovery_surfaces"),
	);
	expect(minimize).toContain("rollback_full_desktop_transition");
	const appStart = wallpaperApp.slice(
		wallpaperApp.indexOf("pub fn start_scene"),
		wallpaperApp.indexOf("pub fn stop_scene"),
	);
	expect(appStart.indexOf("wallpaper_scene_epoch")).toBeGreaterThan(appStart.indexOf(".start_scene("));
	expect(wallpaperApp).toContain("stop_for_window_deactivation_locked(state.inner(), Some(expected_epoch))");
});
