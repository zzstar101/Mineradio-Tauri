import { expect, test } from "bun:test";
import tauriConfig from "../../../desktop/src-tauri/tauri.conf.json";

test("dynamic main window preserves transparent frameless shell settings", async () => {
	// M6 必须先恢复完整桌面 journal，再创建主窗口；静态窗口列表应保持为空。
	expect(tauriConfig.app.windows).toEqual([]);
	const source = await fetch(new URL(
		"../../../desktop/src-tauri/src/app/main_window.rs",
		import.meta.url,
	)).then((response) => response.text());

	expect(source).toContain("window_labels::MAIN");
	expect(source).toContain(".decorations(false)");
	expect(source).toContain(".transparent(true)");
	expect(source).toContain(".shadow(false)");
});

test("production CSP allows required desktop runtime sources", () => {
	const csp = tauriConfig.app.security.csp;
	const devCsp = tauriConfig.app.security.devCsp;
	const mediaDirective = csp
		.split(";")
		.map((directive) => directive.trim())
		.find((directive) => directive.startsWith("media-src "));

	expect(csp).toContain("style-src 'self' 'unsafe-inline'");
	expect(csp).toContain("http://ipc.localhost");
	expect(csp).toContain("http://*.music.126.net");
	expect(csp).toContain("https://*.music.126.net");
	expect(csp).toContain("http://*.y.qq.com");
	expect(csp).toContain("https://*.y.qq.com");
	expect(csp).toContain("https://*.douyinpic.com");
	expect(mediaDirective).toContain("http://mineradio-wallpaper.localhost");
	// sidecar 进程已移除：媒体经 mineradio-tauri: 自定义协议，不再允许裸 127.0.0.1 回环。
	expect(mediaDirective).not.toContain("http://127.0.0.1:*");
	expect(devCsp).toContain("http://*.y.qq.com");
	expect(devCsp).toContain("https://*.y.qq.com");
	expect(devCsp).toContain("https://*.douyinpic.com");
});
