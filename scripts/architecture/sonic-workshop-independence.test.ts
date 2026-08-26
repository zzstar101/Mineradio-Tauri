import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { SONIC_DERIVED_SOURCE_PATHS } from "./sonic-origin-attribution.mjs";

const repositoryRoot = resolve(import.meta.dir, "../..");
const visualEngineSourceRoot = resolve(repositoryRoot, "packages/visual-engine/src");
const workshopRoot = resolve(visualEngineSourceRoot, "sonic-workshop");
const visualEngineRequire = createRequire(
	resolve(repositoryRoot, "packages/visual-engine/package.json"),
);
const ts: typeof import("typescript") = visualEngineRequire("typescript");

const WORKSHOP_ENTRYPOINT = "@mineradio/visual-engine/sonic-workshop";
const COMPOSITION_PATH = "apps/web/src/visual/runtime/create-legacy-visual-composition.ts";

const WIRING_PATHS = Object.freeze([
	COMPOSITION_PATH,
	"apps/web/src/visual/runtime/sonic-workshop-runtime-loader.ts",
	"apps/web/src/preferences/keys.ts",
	"apps/web/src/preferences/legacy-preferences.ts",
	"apps/web/src/stores/visual-store.ts",
	"packages/visual-engine/package.json",
	"packages/visual-engine/src/index.ts",
	"packages/visual-engine/src/home-visual/preset-state.ts",
	"packages/visual-engine/src/runtime/render-step-slot.ts",
]);

const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
	"AudioContext",
	"OfflineAudioContext",
	"Worker",
	"SharedWorker",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"addEventListener",
	"removeEventListener",
	"document",
	"window",
	"navigator",
	"HTMLElement",
	"HTMLCanvasElement",
	"Document",
	"React",
]);

const INGRESS_PATTERNS = Object.freeze([
	{
		kind: "vendor-reference",
		pattern: /(?:public[\\/]+)?vendor[\\/]+sonic-workshop/i,
		detail: "public/vendor/sonic-workshop",
	},
	{
		kind: "vendor-hash",
		pattern: /\b(?:md5|sha(?:1|224|256|384|512)|content[-_]?hash|[a-f\d]{32}|[a-f\d]{40}|[a-f\d]{64})\b/i,
		detail: "vendor hash or digest",
	},
	{
		kind: "blob-transport",
		pattern: /\b(?:Blob|createObjectURL|revokeObjectURL)\b|blob:/i,
		detail: "Blob/blob URL transport",
	},
	{
		kind: "iframe-transport",
		pattern: /\biframe\b/i,
		detail: "iframe transport",
	},
	{
		kind: "network-loader",
		pattern: /\bfetch\s*\(/i,
		detail: "fetch loader",
	},
	{
		kind: "remote-url",
		pattern: /https?:\/\//i,
		detail: "HTTP URL",
	},
]);

interface SourceRecord {
	readonly path: string;
	readonly content: string;
}

interface Violation {
	readonly path: string;
	readonly kind: string;
	readonly detail: string;
}

interface ModuleReference {
	readonly specifier: string;
	readonly kind: "static" | "dynamic" | "require";
}

interface IndependenceRecords {
	readonly workshop: readonly SourceRecord[];
	readonly wiring: readonly SourceRecord[];
	readonly appProduction: readonly SourceRecord[];
	readonly sidecars: readonly SourceRecord[];
}

function normalizePath(path: string): string {
	return path.split(sep).join("/");
}

function readRecord(path: string): SourceRecord {
	return {
		path,
		content: readFileSync(resolve(repositoryRoot, path), "utf8"),
	};
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		// sidecars/ 已随 rust-crate 迁移整体删除：视为空集，
		// 边界断言继续守卫"不得引用 sidecars 路径"
		return files;
	}
	for (const entry of entries) {
		if (["node_modules", "dist", "target", ".turbo"].includes(entry.name)) continue;
		const absolutePath = resolve(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFiles(absolutePath));
			continue;
		}
		files.push(absolutePath);
	}
	return files.sort();
}

function toRecord(absolutePath: string): SourceRecord {
	return {
		path: normalizePath(relative(repositoryRoot, absolutePath)),
		content: readFileSync(absolutePath, "utf8"),
	};
}

function isProductionTypeScript(path: string): boolean {
	return /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function sourceFile(record: SourceRecord): import("typescript").SourceFile {
	return ts.createSourceFile(
		record.path,
		record.content,
		ts.ScriptTarget.Latest,
		true,
		record.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function collectModuleReferences(record: SourceRecord): ModuleReference[] {
	const references: ModuleReference[] = [];
	const visit = (node: import("typescript").Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			references.push({ specifier: node.moduleSpecifier.text, kind: "static" });
		} else if (
			ts.isExportDeclaration(node)
			&& node.moduleSpecifier
			&& ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			references.push({ specifier: node.moduleSpecifier.text, kind: "static" });
		} else if (
			ts.isCallExpression(node)
			&& node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& ts.isStringLiteralLike(node.arguments[0])
		) {
			references.push({ specifier: node.arguments[0].text, kind: "dynamic" });
		} else if (
			ts.isCallExpression(node)
			&& ts.isIdentifier(node.expression)
			&& node.expression.text === "require"
			&& ts.isStringLiteralLike(node.arguments[0])
		) {
			references.push({ specifier: node.arguments[0].text, kind: "require" });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile(record));
	return references;
}

function auditIngress(record: SourceRecord): Violation[] {
	return INGRESS_PATTERNS.flatMap(({ kind, pattern, detail }) => (
		pattern.test(record.content) ? [{ path: record.path, kind, detail }] : []
	));
}

function auditWorkshopModule(record: SourceRecord): Violation[] {
	const violations = auditIngress(record);
	const parsed = sourceFile(record);
	for (const reference of collectModuleReferences(record)) {
		if (reference.specifier === "three") continue;
		if (reference.specifier.startsWith(".")) {
			const target = resolve(dirname(resolve(repositoryRoot, record.path)), reference.specifier);
			const outsideVisualEngine = relative(visualEngineSourceRoot, target).startsWith("..");
			if (!outsideVisualEngine) continue;
		}
		violations.push({
			path: record.path,
			kind: "forbidden-dependency",
			detail: `${reference.kind}:${reference.specifier}`,
		});
	}

	const visit = (node: import("typescript").Node): void => {
		if (
			ts.isIdentifier(node)
			&& FORBIDDEN_RUNTIME_IDENTIFIERS.has(node.text)
		) {
			violations.push({
				path: record.path,
				kind: "forbidden-runtime",
				detail: node.text,
			});
		}
		if (
			ts.isStringLiteralLike(node)
			&& /(?:@tauri|sidecars?[\\/]|react(?:-dom)?(?:[\\/]|$))/i.test(node.text)
		) {
			violations.push({
				path: record.path,
				kind: "forbidden-boundary",
				detail: node.text,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);

	for (const marker of [
		"SONIC_DERIVED_SOURCE_PATHS",
		"Non-Commercial Learning License",
		"sonic-topography",
		"Ajin",
	]) {
		if (!record.content.includes(marker)) continue;
		violations.push({
			path: record.path,
			kind: "topography-attribution-leak",
			detail: marker,
		});
	}
	return violations;
}

function requireMarker(
	record: SourceRecord | undefined,
	marker: string | RegExp,
	detail: string,
): Violation[] {
	if (!record) return [{ path: detail, kind: "missing-wiring", detail }];
	const found = typeof marker === "string"
		? record.content.includes(marker)
		: marker.test(record.content);
	return found ? [] : [{ path: record.path, kind: "missing-wiring", detail }];
}

function auditSonicWorkshopIndependence(records: IndependenceRecords): Violation[] {
	const violations = records.workshop.flatMap(auditWorkshopModule);
	violations.push(...records.wiring.flatMap(auditIngress));

	for (const path of SONIC_DERIVED_SOURCE_PATHS) {
		if (!normalizePath(path).includes("/sonic-workshop/")) continue;
		violations.push({
			path,
			kind: "topography-attribution-leak",
			detail: "Workshop must not enter SONIC_DERIVED_SOURCE_PATHS",
		});
	}

	for (const record of records.sidecars) {
		const match = record.content.match(/sonic[-_ ]?workshop|SonicWorkshop|SONIC_WORKSHOP/i);
		if (!match) continue;
		violations.push({
			path: record.path,
			kind: "sidecar-boundary",
			detail: match[0],
		});
	}

	const entrypointReferences = records.appProduction.flatMap((record) => (
		collectModuleReferences(record)
			.filter((reference) => reference.specifier === WORKSHOP_ENTRYPOINT)
			.map((reference) => ({ record, reference }))
	));
	if (
		entrypointReferences.length !== 1
		|| entrypointReferences[0]?.record.path !== COMPOSITION_PATH
		|| entrypointReferences[0]?.reference.kind !== "dynamic"
	) {
		violations.push({
			path: COMPOSITION_PATH,
			kind: "dynamic-import-boundary",
			detail: "Workshop runtime must have exactly one composition-root dynamic import",
		});
	}

	const byPath = new Map(records.wiring.map((record) => [record.path, record]));
	violations.push(...requireMarker(
		byPath.get(COMPOSITION_PATH),
		'load: () => import("@mineradio/visual-engine/sonic-workshop")',
		"exact Workshop dynamic import",
	));
	violations.push(...requireMarker(
		byPath.get(COMPOSITION_PATH),
		/registerStep\(\s*RenderStepSlot\.SonicWorkshop,/,
		"Workshop render-lane registration",
	));
	violations.push(...requireMarker(
		byPath.get("packages/visual-engine/src/runtime/render-step-slot.ts"),
		'SonicWorkshop: "sonic-workshop"',
		"dedicated RenderStepSlot.SonicWorkshop",
	));
	violations.push(...requireMarker(
		byPath.get("packages/visual-engine/package.json"),
		'"./sonic-workshop": "./src/sonic-workshop/index.ts"',
		"cold Workshop package entrypoint",
	));

	const presetState = byPath.get("packages/visual-engine/src/home-visual/preset-state.ts");
	violations.push(...requireMarker(
		presetState,
		"export const SONIC_WORKSHOP_PRESET_INDEX = 8",
		"current Workshop preset 8 symbol",
	));
	violations.push(...requireMarker(
		presetState,
		/function migrateLegacyPreset[\s\S]*Math\.min\(SONIC_PRESET_INDEX/,
		"legacy numeric 8 migration to Topography 7",
	));
	violations.push(...requireMarker(
		byPath.get("apps/web/src/preferences/keys.ts"),
		'name: "visual.workshop.v1"',
		"independent Workshop preference schema",
	));
	violations.push(...requireMarker(
		byPath.get("apps/web/src/preferences/keys.ts"),
		"SONIC_WORKSHOP_ACTIVATION_ID",
		"stable Workshop activation id",
	));
	violations.push(...requireMarker(
		byPath.get("apps/web/src/preferences/legacy-preferences.ts"),
		"migrateLegacyPreset(Number(visualFx.preset))",
		"legacy visual.fx migration call",
	));

	return violations;
}

function repositoryRecords(): IndependenceRecords {
	return {
		workshop: listFiles(workshopRoot)
			.filter((path) => isProductionTypeScript(path))
			.map(toRecord),
		wiring: WIRING_PATHS.map(readRecord),
		appProduction: listFiles(resolve(repositoryRoot, "apps/web/src"))
			.filter((path) => isProductionTypeScript(path))
			.map(toRecord),
		sidecars: listFiles(resolve(repositoryRoot, "sidecars"))
			.filter((path) => /\.(?:[cm]?[jt]sx?|json|toml|md|ya?ml)$/.test(path))
			.map(toRecord),
	};
}

function cleanFixture(overrides: Partial<IndependenceRecords> = {}): IndependenceRecords {
	const presetState = `
		export const SONIC_PRESET_INDEX = 7;
		export const SONIC_WORKSHOP_PRESET_INDEX = 8;
		export function migrateLegacyPreset(value: number) {
			if (Math.round(value) === 8) return SONIC_PRESET_INDEX;
			return value;
		}
	`;
	const wiring = [
		{
			path: COMPOSITION_PATH,
			content: `
				const loader = {
					load: () => import("@mineradio/visual-engine/sonic-workshop"),
				};
				registerStep(RenderStepSlot.SonicWorkshop, run);
			`,
		},
		{
			path: "apps/web/src/visual/runtime/sonic-workshop-runtime-loader.ts",
			content: "export interface SonicWorkshopRuntimeLoader {}",
		},
		{
			path: "apps/web/src/preferences/keys.ts",
			content: 'const activationId = "sonic-workshop-v1"; const key = { name: "visual.workshop.v1" };',
		},
		{
			path: "apps/web/src/preferences/legacy-preferences.ts",
			content: "migrateLegacyPreset(Number(visualFx.preset));",
		},
		{ path: "apps/web/src/stores/visual-store.ts", content: "export {};" },
		{
			path: "packages/visual-engine/package.json",
			content: '{"exports":{"./sonic-workshop": "./src/sonic-workshop/index.ts"}}',
		},
		{ path: "packages/visual-engine/src/index.ts", content: "export {};" },
		{
			path: "packages/visual-engine/src/home-visual/preset-state.ts",
			content: presetState,
		},
		{
			path: "packages/visual-engine/src/runtime/render-step-slot.ts",
			content: 'export const RenderStepSlot = { SonicWorkshop: "sonic-workshop" };',
		},
	];
	return {
		workshop: [{
			path: "packages/visual-engine/src/sonic-workshop/index.ts",
			content: 'import { Color } from "three"; export { build } from "./build";',
		}],
		wiring,
		appProduction: [wiring[0]],
		sidecars: [{ path: "sidecars/api/src/server.ts", content: "export {};" }],
		...overrides,
	};
}

test("仓库 Workshop 是独立实现、冷加载，并与 Topography 归属及 Sidecar 隔离", () => {
	expect(auditSonicWorkshopIndependence(repositoryRecords())).toEqual([]);
});

test("旧 numeric 8 与当前 Workshop 8 使用不同入口语义", async () => {
	const preset = await import("../../packages/visual-engine/src/home-visual/preset-state");
	expect(preset.migrateLegacyPreset(8)).toBe(7);
	expect(preset.clampCurrentPreset(8)).toBe(8);
	expect(preset.SONIC_WORKSHOP_PRESET_INDEX).toBe(8);
	expect(preset.PRESET_COUNT).toBe(9);
});

test("守卫能拒绝 vendor、远程加载与隐藏二进制输入", () => {
	for (const injected of [
		'const source = "public/vendor/sonic-workshop/index.js";',
		'const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";',
		'const payload = new Blob([]);',
		'const frame = "<iframe></iframe>";',
		'fetch("/sonic-workshop.js");',
		'const source = "https://example.test/sonic-workshop.js";',
	]) {
		const fixture = cleanFixture({
			workshop: [{
				path: "packages/visual-engine/src/sonic-workshop/index.ts",
				content: injected,
			}],
		});
		expect(auditSonicWorkshopIndependence(fixture).length).toBeGreaterThan(0);
	}
});

test("守卫能拒绝 React、DOM、Tauri、Sidecar 与自建运行循环", () => {
	for (const injected of [
		'import React from "react";',
		'document.createElement("canvas");',
		'import { invoke } from "@tauri-apps/api/core";',
		'import { call } from "../../../../../sidecars/api/src/client";',
		'requestAnimationFrame(update);',
		'const audio = new AudioContext();',
		'const worker = new Worker("worker.js");',
		'window.addEventListener("resize", update);',
	]) {
		const fixture = cleanFixture({
			workshop: [{
				path: "packages/visual-engine/src/sonic-workshop/index.ts",
				content: injected,
			}],
		});
		expect(auditSonicWorkshopIndependence(fixture).length).toBeGreaterThan(0);
	}
});

test("守卫能拒绝静态 runtime import、共用 Topography 归属与 Sidecar 接线", () => {
	const clean = cleanFixture();
	const staticImportFixture: IndependenceRecords = {
		...clean,
		appProduction: [{
			path: COMPOSITION_PATH,
			content: `import { createSonicWorkshopRuntime } from "${WORKSHOP_ENTRYPOINT}";`,
		}],
	};
	expect(auditSonicWorkshopIndependence(staticImportFixture)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "dynamic-import-boundary" }),
		]),
	);

	const attributionFixture = cleanFixture({
		workshop: [{
			path: "packages/visual-engine/src/sonic-workshop/index.ts",
			content: 'const license = "Non-Commercial Learning License";',
		}],
	});
	expect(auditSonicWorkshopIndependence(attributionFixture)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "topography-attribution-leak" }),
		]),
	);

	const sidecarFixture = cleanFixture({
		sidecars: [{
			path: "sidecars/api/src/server.ts",
			content: "export function createSonicWorkshopRoute() {}",
		}],
	});
	expect(auditSonicWorkshopIndependence(sidecarFixture)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "sidecar-boundary" }),
		]),
	);
});

test("守卫能拒绝越过 visual-engine 内部边界和丢失迁移符号", () => {
	const dependencyFixture = cleanFixture({
		workshop: [{
			path: "packages/visual-engine/src/sonic-workshop/index.ts",
			content: 'import { useVisualStore } from "../../../../apps/web/src/stores/visual-store";',
		}],
	});
	expect(auditSonicWorkshopIndependence(dependencyFixture)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "forbidden-dependency" }),
		]),
	);

	const clean = cleanFixture();
	const missingMigration = clean.wiring.map((record) => (
		record.path === "packages/visual-engine/src/home-visual/preset-state.ts"
			? { ...record, content: "export const SONIC_WORKSHOP_PRESET_INDEX = 8;" }
			: record
	));
	expect(auditSonicWorkshopIndependence({ ...clean, wiring: missingMigration })).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "missing-wiring",
				detail: "legacy numeric 8 migration to Topography 7",
			}),
		]),
	);
});
