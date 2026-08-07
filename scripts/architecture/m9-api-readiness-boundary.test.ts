import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

function normalizedTauriConfigDigest(source: string): string {
	const normalizedNewlines = source.replaceAll("\r\n", "\n");
	const versionPattern = /("version"\s*:\s*)"[^"]+"/g;
	const matches = [...normalizedNewlines.matchAll(versionPattern)];
	if (matches.length !== 1) {
		throw new Error("tauri.conf.json 必须只包含一个顶层产品版本字段");
	}
	const config = JSON.parse(normalizedNewlines) as { version?: unknown };
	if (typeof config.version !== "string") {
		throw new Error("tauri.conf.json 产品版本必须是字符串");
	}
	const versionAgnostic = normalizedNewlines.replace(
		versionPattern,
		'$1"__PRODUCT_VERSION__"',
	);
	return createHash("sha256").update(versionAgnostic).digest("hex");
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

test("M9 leaves the frozen Sidecar API, shared contracts and packaging unchanged", () => {
	// 固定 D2 cutover 后的 Sidecar tree/blob 与 externalBin 组装对象；通用 Rust updater 依赖不属于 Sidecar API。
	const frozenObjects = {
		"sidecars/api": "1e1bebdabe0816830b103c2eb6d9268cb2b658cc",
		"packages/shared": "f0579e8fb63fc1974faaf2a1226b9a50a2704959",
		"apps/web/src/api/sidecar-client.ts": "64a60cfce7e8e6e622727ffb60d4a791285880be",
		"apps/desktop/src-tauri/src/sidecar.rs": "6889c8f6d8b200c1af4f7b0f05792cbe9775ddeb",
		"apps/desktop/scripts/build-sidecar-binary.mjs": "528bca986b626f52010beac6bd9f749d88a540f9",
		"apps/desktop/src-tauri/build.rs": "b1707ceaf4500df1f9467946959f40d0c732110a",
	} as const;
	const frozenTargets = Object.keys(frozenObjects);
	const committedObjects = Object.fromEntries(frozenTargets.map((target) => {
		const result = spawnSync(
			"git",
			["rev-parse", `HEAD:${target}`],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		return [target, result.status === 0 ? result.stdout.trim() : result.stderr.trim()];
	}));
	const workingTreeResult = spawnSync(
		"git",
		["diff", "--name-only", "HEAD", "--", ...frozenTargets],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	const untrackedResult = spawnSync(
		"git",
		["ls-files", "--others", "--exclude-standard", "--", ...frozenTargets],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);

	expect(committedObjects).toEqual(frozenObjects);
	expect(workingTreeResult.status).toBe(0);
	expect(workingTreeResult.stderr).toBe("");
	expect(workingTreeResult.stdout.trim()).toBe("");
	expect(untrackedResult.status).toBe(0);
	expect(untrackedResult.stderr).toBe("");
	expect(untrackedResult.stdout.trim()).toBe("");

	// 产品版本由 release-version 门禁统一管理；除该字段外，Sidecar externalBin 与打包配置逐字冻结。
	const tauriConfig = readFileSync(
		resolve(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"),
		"utf8",
	);
	expect(normalizedTauriConfigDigest(tauriConfig)).toBe(
		"7b26b1b16d952693b0406fe621614f95b6ac92506a6570f4fc322e856f5dc895",
	);
});
