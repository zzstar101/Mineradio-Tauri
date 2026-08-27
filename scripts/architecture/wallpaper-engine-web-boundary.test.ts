import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

test("M7 Web adapter keeps Wallpaper Engine outside Sidecar, shared DTO and TCP localhost", () => {
	const port = read("apps/web/src/ports/wallpaper-engine-runtime-port.ts");
	const adapter = read("apps/web/src/adapters/tauri/tauri-wallpaper-engine-runtime.ts");
	const media = read("apps/web/src/features/wallpaper-engine/wallpaper-engine-media-url.ts");
	expect(port).not.toContain("@mineradio/shared");
	expect(adapter).not.toContain("sidecar");
	expect(adapter).not.toContain("localhost");
	expect(media).toContain("mineradio-wallpaper.localhost");
	expect(media).not.toContain("127.0.0.1");
});

test("M7 Web transport exposes only the approved nine additive commands", () => {
	const source = read("apps/web/src/tauri/runtime.ts");
	for (const command of [
		"list_wallpaper_engine_projects", "get_wallpaper_engine_project_details",
		"choose_wallpaper_engine_directory", "choose_wallpaper_engine_project_file",
		"remove_wallpaper_engine_directory", "get_wallpaper_engine_runtime_status",
		"start_wallpaper_engine_scene", "stop_wallpaper_engine_scene", "recover_wallpaper_engine_runtime",
	]) expect(source).toContain(`"${command}"`);
	for (const forbidden of ["http://127.0.0.1", "legacy-media-url", "SendInput", "WM_MOUSEMOVE"]) {
		expect(source).not.toContain(forbidden);
	}
});

test("M7 renders direct media at the application background seam and keeps native Scene composition transparent", () => {
	const surface = read("apps/web/src/features/visual/VisualSurface.tsx");
	const background = read("apps/web/src/features/wallpaper-engine/WallpaperEngineBackground.tsx");
	const presentation = read("apps/web/src/features/wallpaper-engine/wallpaper-engine-presentation.ts");
	const styles = read("apps/web/src/styles.css");
	const renderer = read("packages/visual-engine/src/runtime/renderer-setup.ts");
	expect(surface).toContain("<WallpaperEngineBackground");
	expect(background).toContain('data-wallpaper-engine-background="scene"');
	expect(background).toContain('const className = "wallpaper-engine-background-media"');
	expect(presentation).toContain("runtime.dwmSurfaceReady");
	expect(presentation).toContain("runtime.sourceWindowAligned");
	expect(styles).toContain("[data-wallpaper-engine-background] ~ #custom-bg");
	expect(styles).toContain('[data-wallpaper-engine-background="scene"] ~ #visual-host canvas');
	expect(renderer).toContain("scene.background = null");
	expect(renderer).toContain("renderer.setClearColor(0x000000, 0)");
});

test("M7 registered media origin is admitted only by image and media CSP directives", () => {
	const config = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
	for (const key of ["csp", "devCsp"]) {
		const policy = String(config.app.security[key]);
		const imageDirective = policy.match(/img-src ([^;]+);/)?.[1] ?? "";
		const mediaDirective = policy.match(/media-src ([^;]+);/)?.[1] ?? "";
		const connectDirective = policy.match(/connect-src ([^;]+);/)?.[1] ?? "";
		expect(imageDirective).toContain("http://mineradio-wallpaper.localhost");
		expect(mediaDirective).toContain("http://mineradio-wallpaper.localhost");
		expect(connectDirective).not.toContain("mineradio-wallpaper.localhost");
	}
	// sidecar HTTP 服务退役后 externalBin 保持为空
	expect(config.bundle.externalBin).toEqual([]);
});
