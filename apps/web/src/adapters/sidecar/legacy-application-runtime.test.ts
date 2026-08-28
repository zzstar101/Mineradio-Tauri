import { expect, test } from "bun:test";
import type { SidecarClient } from "../../api/sidecar-client";
import type { DesktopRuntimePort } from "../../ports/desktop-runtime-port";
import { createLegacyApplicationRuntime } from "./legacy-application-runtime";

test("legacy application runtime creates one client and publishes one complete Port generation", async () => {
	const calls: string[] = [];
	const client = {
		imageProxyUrl(url: string) {
			calls.push(`image:${url}`);
			return `proxy:${url}`;
		},
		async search(provider: string, keyword: string, limit: number) {
			calls.push(`search:${provider}:${keyword}:${limit}`);
			return [];
		},
	} as unknown as SidecarClient;
	const desktop = { marker: "desktop" } as unknown as DesktopRuntimePort;
	let clientCreations = 0;
	const runtime = createLegacyApplicationRuntime({
		initialRuntimeConfig: {
			mediaProxyBase: "mineradio-tauri://localhost",
			appDataDir: "D:/app-data",
			appVersion: "0.1.0",
			schemaVersion: "1",
			updaterPublicKeyConfigured: false,
		},
		createClient: () => {
			clientCreations += 1;
			return client;
		},
		createDesktopRuntime: () => desktop,
	});

	const ports = await runtime.connect();

	expect(ports).not.toBeNull();
	expect(clientCreations).toBe(1);
	expect(ports?.desktop).toBe(desktop);
	await ports?.music.search.search("netease", "测试", 12);
	expect(ports?.mediaUrl.imageUrl("https://example.com/cover.jpg"))
		.toBe("proxy:https://example.com/cover.jpg");
	expect(calls).toEqual([
		"search:netease:测试:12",
		"image:https://example.com/cover.jpg",
	]);
});

test("legacy application runtime publishes no Ports outside the native Tauri runtime", async () => {
	let configLoads = 0;
	const runtime = createLegacyApplicationRuntime({
		runtimeAvailable: () => false,
		loadRuntimeConfig: async () => {
			configLoads += 1;
			throw new Error("must not load");
		},
	});

	expect(await runtime.connect()).toBeNull();
	expect(configLoads).toBe(0);
});

test("legacy application runtime publishes no Ports when runtime configuration cannot be loaded", async () => {
	let clientCreations = 0;
	const runtime = createLegacyApplicationRuntime({
		runtimeAvailable: () => true,
		loadRuntimeConfig: async () => {
			throw new Error("runtime config unavailable");
		},
		createClient: () => {
			clientCreations += 1;
			return {} as SidecarClient;
		},
	});

	expect(await runtime.connect()).toBeNull();
	expect(clientCreations).toBe(0);
});
