import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dir, "../..");

const productionExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

function extensionOf(path: string): string {
	const match = path.match(/(\.[^.\\/]+)$/);
	return match?.[1] ?? "";
}

function productionSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...productionSourceFiles(path));
			continue;
		}
		if (!productionExtensions.has(extensionOf(path))) continue;
		if (/\.(?:test|spec)\.[^.]+$/.test(path)) continue;
		files.push(path);
	}
	return files;
}

function repositoryPath(path: string): string {
	return relative(repositoryRoot, path).replaceAll("\\", "/");
}

test("M9 keeps concrete Sidecar transport inside api and legacy adapters", () => {
	const webRoot = resolve(repositoryRoot, "apps/web/src");
	const allowedPrefixes = [
		"apps/web/src/api/",
		"apps/web/src/adapters/sidecar/",
	];
	const violations = productionSourceFiles(webRoot).flatMap((path) => {
		const file = repositoryPath(path);
		if (allowedPrefixes.some((prefix) => file.startsWith(prefix))) return [];
		const source = readFileSync(path, "utf8");
		return /\bSidecarClient\b|\bsidecarClient\b/.test(source)
			? [`${file}: concrete Sidecar client`]
			: [];
	});

	expect(violations).toEqual([]);
});

test("M9 business and visual modules do not receive sidecar base addresses", () => {
	const guardedRoots = [
		"apps/web/src/app",
		"apps/web/src/features",
		"apps/web/src/components",
		"apps/web/src/visual",
		"apps/web/src/ports",
	];
	const violations = guardedRoots.flatMap((root) => (
		productionSourceFiles(resolve(repositoryRoot, root)).flatMap((path) => {
			const source = readFileSync(path, "utf8");
			return /\bsidecarBaseUrl\b/.test(source)
				? [`${repositoryPath(path)}: sidecarBaseUrl`]
				: [];
		})
	));

	expect(violations).toEqual([]);
});

test("M9 visual modules treat media URIs as opaque values", () => {
	const visualRoots = [
		"apps/web/src/visual",
		"packages/visual-engine/src",
	];
	const forbidden = /\bsidecarBaseUrl\b|\/(?:audio|image)-proxy\b|searchParams\s*\.\s*(?:get|has)\s*\(\s*["']url["']/;
	const violations = visualRoots.flatMap((root) => (
		productionSourceFiles(resolve(repositoryRoot, root)).flatMap((path) => {
			const source = readFileSync(path, "utf8");
			return forbidden.test(source) ? [repositoryPath(path)] : [];
		})
	));

	expect(violations).toEqual([]);
});

test("M9 media image source is consumed by production code", () => {
	const portPath = resolve(repositoryRoot, "apps/web/src/ports/media-url-port.ts");
	const portSource = readFileSync(portPath, "utf8");
	const consumerRoots = [
		"apps/web/src/app",
		"apps/web/src/features",
		"apps/web/src/components",
		"apps/web/src/visual",
	];
	const consumers = consumerRoots.flatMap((root) => (
		productionSourceFiles(resolve(repositoryRoot, root)).filter((path) => (
			/\.imageSource\s*\(/.test(readFileSync(path, "utf8"))
		))
	)).map(repositoryPath);

	expect(portSource).toContain("export interface MediaImageSource");
	expect(portSource).toMatch(/\bimageSource\s*\(/);
	expect(consumers.length).toBeGreaterThan(0);
});

test("M9 keeps the Sidecar HTTP runtime retired after the rust-crate cutover", () => {
	// Sidecar HTTP 服务已迁移进 mineradio_api crate：旧工件必须保持删除，
	// 防止意外复活旧架构；tauri 打包的 externalBin 也必须保持为空。
	const retiredPaths = [
		"sidecars/api",
		"apps/desktop/src-tauri/src/sidecar.rs",
		"apps/desktop/scripts/build-sidecar-binary.mjs",
	];
	for (const target of retiredPaths) {
		const probe = spawnSync(
			"git",
			["cat-file", "-e", `HEAD:${target}`],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		expect(probe.status).not.toBe(0);
	}

	const tauriConfig = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"),
			"utf8",
		),
	) as { bundle?: { externalBin?: string[] } };
	expect(tauriConfig.bundle?.externalBin ?? []).toEqual([]);
});
