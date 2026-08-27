import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rustRoot = fileURLToPath(new URL(
	"../../apps/desktop/src-tauri/src/",
	import.meta.url,
));
const tauriConfigPath = fileURLToPath(new URL(
	"../../apps/desktop/src-tauri/tauri.conf.json",
	import.meta.url,
));

test("M6 creates the main window in Rust so recovery can run first", () => {
	const config = JSON.parse(readFileSync(tauriConfigPath, "utf8")) as {
		app?: { windows?: unknown[] };
	};
	const mainWindowPath = `${rustRoot}/app/main_window.rs`;
	const libSource = readFileSync(`${rustRoot}/lib.rs`, "utf8");

	expect(config.app?.windows ?? []).toEqual([]);
	// sidecar HTTP 服务退役后 externalBin 保持为空
	expect((config as { bundle?: { externalBin?: unknown } }).bundle?.externalBin)
		.toEqual([]);
	expect(existsSync(mainWindowPath)).toBe(true);
	const mainWindowSource = readFileSync(mainWindowPath, "utf8");
	expect(mainWindowSource).toContain("WebviewWindowBuilder::new(");
	expect(mainWindowSource).toContain("window_labels::MAIN");
	expect(mainWindowSource).toContain(".inner_size(1440.0, 1080.0)");
	expect(mainWindowSource).toContain(".min_inner_size(960.0, 540.0)");
	expect(mainWindowSource).toContain(".decorations(false)");
	expect(mainWindowSource).toContain(".transparent(true)");
	expect(mainWindowSource).toContain(".shadow(false)");
	expect(libSource).toContain("app::main_window::create_main_window(app.handle())");
});

test("M6 recovers a stale full-desktop journal before creating the main window", () => {
	const libSource = readFileSync(`${rustRoot}/lib.rs`, "utf8");
	const recoverCall =
		"app::full_desktop_runtime::recover_before_main_window(app.handle())?";
	const createCall = "app::main_window::create_main_window(app.handle())?";
	const recoverIndex = libSource.indexOf(recoverCall);
	const createIndex = libSource.indexOf(createCall);

	expect(recoverIndex).toBeGreaterThanOrEqual(0);
	expect(createIndex).toBeGreaterThan(recoverIndex);
});

test("M6 shutdown stops the Explorer watcher and rolls back before wallpaper scene dispose", () => {
	const fullDesktopSource = readFileSync(`${rustRoot}/app/full_desktop_runtime.rs`, "utf8");
	const desktopRuntimeSource = readFileSync(`${rustRoot}/app/desktop_runtime.rs`, "utf8");
	const recoverFunction = fullDesktopSource.slice(
		fullDesktopSource.indexOf("pub fn recover_before_exit"),
	);
	expect(recoverFunction.indexOf("stop_explorer_watcher_for_shutdown"))
		.toBeLessThan(recoverFunction.indexOf("recover_for_shutdown"));
	// sidecar 清理步骤已随 rust-crate 迁移移除；回滚必须先于壁纸场景销毁
	const cleanupFunction = desktopRuntimeSource.slice(
		desktopRuntimeSource.indexOf("pub fn cleanup_runtime_once"),
	);
	expect(cleanupFunction.indexOf("recover_before_exit"))
		.toBeLessThan(cleanupFunction.indexOf("wallpaper_engine_runtime::dispose_before_exit"));
});

test("M6 keeps native recovery surfaces and queues Explorer mutation on the main thread", () => {
	const fullDesktopSource = readFileSync(`${rustRoot}/app/full_desktop_runtime.rs`, "utf8");
	const traySource = readFileSync(`${rustRoot}/app/tray.rs`, "utf8");
	const hotkeysSource = readFileSync(`${rustRoot}/runtime/hotkeys.rs`, "utf8");
	expect(fullDesktopSource).toContain("run_on_main_thread");
	expect(fullDesktopSource).toContain("wake_explorer_watcher");
	expect(fullDesktopSource).not.toContain("saturating_sub(now_ms).min(500)");
	expect(traySource).toContain("RECOVER_DESKTOP_MENU_ID");
	expect(traySource).toContain("PASSIVE_DESKTOP_MENU_ID");
	expect(traySource).toContain("INTERACTIVE_DESKTOP_MENU_ID");
	expect(hotkeysSource).toContain("reserve_full_desktop_escape");
	expect(hotkeysSource).toContain("release_full_desktop_escape");
});
