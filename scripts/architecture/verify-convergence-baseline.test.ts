import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	extractTopLevelSymbols,
	validateConvergenceBaseline,
} from "./convergence-baseline.mjs";

const readRepositoryFile = (relativePath: string) =>
	readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
const upstreamSourceMapDocument = readRepositoryFile("docs/parity/upstream-source-map.md");

const legacyCapabilityHeader = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const expandedCapabilityHeader = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | convergence_mode | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const capabilityRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
const legacyCapabilityDelimiter = capabilityRow(Array(13).fill("---"));
const expandedCapabilityDelimiter = capabilityRow(Array(14).fill("---"));
const expandedCapabilityColumns = expandedCapabilityHeader
	.slice(1, -1)
	.split("|")
	.map((column) => column.trim());
const renderCapability = (capability: Record<string, string>) => capabilityRow(
	expandedCapabilityColumns.map((column) => capability[column] ?? ""),
);
const legacyCapabilityRow = capabilityRow([
	"app.example", "app", "upstream", "target", "baseline", "P0", "app",
	"none", "none", "tests", "none", "none", "bounded",
]);
const exampleCapability = {
	capability_id: "app.example",
	domain: "app",
	upstream_source: "upstream",
	target_module: "target",
	current_tauri: "baseline",
	parity_level: "P0",
	convergence_mode: "parity",
	owner_layer: "app",
	api_dependency: "none",
	state_migration: "none",
	verification: "tests",
	feature_gate: "none",
	blocked_by: "none",
	performance_budget: "bounded",
};
const expandedCapabilityRow = renderCapability(exampleCapability);
const updaterCapability = {
	capability_id: "updater.github-release",
	domain: "updater",
	upstream_source: "2.0.3 external HTTPS download pages",
	target_module: "GitHub Release + signed Update Runtime",
	current_tauri: "implemented",
	parity_level: "P1",
	convergence_mode: "architecture-replacement",
	owner_layer: "Rust/Tauri adapter",
	api_dependency: "none",
	state_migration: "none",
	verification: "Updater Interface TDD",
	feature_gate: "none",
	blocked_by: "none",
	performance_budget: "startup non-blocking",
};
const updaterCapabilityRow = renderCapability(updaterCapability);
const d0InventoryCapabilities = [
	["baseline.electron-2.1.0", "implemented", "P0", "parity", "none"],
	["lyrics.stage-v2", "implemented", "P0", "parity", "none"],
	["visual.cursor-activity", "implemented", "P0", "parity", "none"],
	["visual.shelf-cursor-layer", "implemented", "P0", "parity", "none"],
	["visual.sonic-workshop", "implemented", "P0", "parity", "none"],
	["wallpaper.idle-dispose", "implemented", "P0", "parity", "none"],
	["playback.startup-resume", "missing", "P0", "parity", "none"],
	["queue.drag-sort", "missing", "P1", "parity", "none"],
	["library.drag-sort", "missing", "P1", "parity", "none"],
	["lyrics.track-offset", "missing", "P1", "parity", "none"],
	["beatmap.local-song", "partial", "P1", "parity", "none"],
	["local-import.expanded", "partial", "P1", "parity", "none"],
	["hotkeys.editor", "missing", "P1", "parity", "none"],
	["visual.archive", "missing", "P1", "parity", "none"],
	["visual.camera-gesture", "missing", "P2", "parity", "none"],
	["wallpaper.library", "partial", "P1", "parity", "none"],
	["wallpaper.wgc", "missing", "P1", "parity", "none"],
	["accounts.provider-order", "missing", "P1", "parity", "none"],
	["search.multi-provider-offset", "partial", "P1", "parity", "none"],
] as const;
const positiveFieldValidationCapabilities = new Set([
	"playback.gapless",
	"playback.output-routing",
	"lyrics.stage-v2",
	"visual.cursor-activity",
	"visual.sonic-workshop",
	"home.dashboard",
	"desktop.tray-close",
	"desktop.lyrics",
	"desktop.window",
	"desktop.cache",
	"desktop.diagnostics",
	"desktop.memory-governance",
	"desktop.full-mode",
	"desktop.native-icons",
	"wallpaper.engine",
	"persistence.preferences",
	"performance.m8-gate",
]);
const d0InventoryRows = d0InventoryCapabilities.map(([
	capabilityId,
	currentTauri,
	parityLevel,
	convergenceMode,
	blockedBy,
]) => renderCapability({
	...exampleCapability,
	...(capabilityId === "visual.sonic-workshop" ? {
		target_module: "`packages/visual-engine/src/sonic-workshop`",
		owner_layer: "visual-engine Module",
		state_migration: "legacy `visual.fx` numeric 8 始终迁为 Sonic Topography 7；`visual.workshop.v1` 以 activation id 恢复当前 Workshop preset 8",
		verification: "独立 Module、动态冷加载、独立 render lane、typed audio/media/theme 输入、160×160 有界实例网格、9 主题/六色、封面与有界标题/作者叠层、资源归零、偏好事务与独立性守卫均有自动化证据；Windows/WebView2 观感、CPU/GPU timing 及 frame regression 为 Field Validation Pending (non-blocking)",
		performance_budget: "disabled cost=0；high hard caps：mesh/draw 8、geometry 8 MiB、texture/cache 16 MiB、queued task cost 32、CPU p95 1.5 ms、GPU delta p95 5 ms、frame +10%",
	} : {}),
	capability_id: capabilityId,
	current_tauri: currentTauri,
	parity_level: parityLevel,
	convergence_mode: convergenceMode,
	blocked_by: blockedBy,
	verification: positiveFieldValidationCapabilities.has(capabilityId)
		&& capabilityId !== "visual.sonic-workshop"
		? "automated evidence; Field Validation Pending (non-blocking)"
		: capabilityId === "visual.sonic-workshop"
		? "独立 Module、动态冷加载、独立 render lane、typed audio/media/theme 输入、160×160 有界实例网格、9 主题/六色、封面与有界标题/作者叠层、资源归零、偏好事务与独立性守卫均有自动化证据；Windows/WebView2 观感、CPU/GPU timing 及 frame regression 为 Field Validation Pending (non-blocking)"
			: "tests",
}));
const blockedApiCapabilities = [
	["provider.kugou", "MineRadio-api"],
	["provider.spotify", "MineRadio-api"],
] as const;
const blockedApiRows = blockedApiCapabilities.map(([capabilityId, blockedBy]) =>
	renderCapability({
		...exampleCapability,
		capability_id: capabilityId,
		current_tauri: "blocked",
		parity_level: "P2",
		blocked_by: blockedBy,
	}));
const cuefieldCapability = {
	...exampleCapability,
	capability_id: "cuefield.automix",
	domain: "playback",
	upstream_source: "`05-playback/16-*` 至 `18-*`、`cuefield/**`、本机 `/api/cuefield/*` routes",
	target_module: "`apps/web/src/features/playback/cuefield` + `apps/desktop/src-tauri/src/runtime/cuefield_feedback.rs` (future)",
	current_tauri: "missing",
	parity_level: "P2",
	owner_layer: "local playback Module + Web controller；desktop persistence Adapter 仅实现 feedback repository",
	api_dependency: "none（无 MineRadio-api；只复用现有 playback/lyrics/beatmap Ports 与本地 feedback repository Port）",
	state_migration: "`mineradio-cuefield-automix-v1` preference + local feedback history migration",
	verification: "本机 planner/timeline/feedback；依赖 beatmap.local-song 收敛；deterministic audio/beatmap fixtures + Web playback handoff tests",
	feature_gate: "cuefield",
	blocked_by: "none",
	performance_budget: "disabled cost=0；planning 与 prepared audio/graph/timer ownership bounded",
};
const cuefieldCapabilityRow = renderCapability(cuefieldCapability);
const d0InventoryCapabilityIds = new Set(d0InventoryCapabilities.map(([capabilityId]) => capabilityId));
const additionalFieldValidationRows = [...positiveFieldValidationCapabilities]
	.filter((capabilityId) => !d0InventoryCapabilityIds.has(capabilityId))
	.map((capabilityId) => renderCapability({
	...exampleCapability,
	capability_id: capabilityId,
	current_tauri: "implemented",
	verification: "automated evidence; Field Validation Pending (non-blocking)",
}));
const completeCapabilityRows = [
	expandedCapabilityRow,
	updaterCapabilityRow,
	...d0InventoryRows,
	...blockedApiRows,
	cuefieldCapabilityRow,
	...additionalFieldValidationRows,
];
const activeUpstreamIdentity = [
	"| baseline_role | repository | tag | peeled_commit | tree | package_version |",
	"| --- | --- | --- | --- | --- | --- |",
	"| active | XxHuberrr/Mineradio | v2.1.0 | 96091d123b36783f5604d1acd47b00b0708cabbd | b1b9f80a72d96afcbc8b4685256c3adba9014551 | 2.1.0 |",
].join("\n");
const upstreamReleaseProvenance = [
	"| provenance_role | ref | object_id | resolved_commit | tree | package_version |",
	"| --- | --- | --- | --- | --- | --- |",
	"| release_tag | refs/tags/v2.1.0 | 37993d337c73b130e4a81da7c973b8d246fe32a3 | 96091d123b36783f5604d1acd47b00b0708cabbd | b1b9f80a72d96afcbc8b4685256c3adba9014551 | 2.1.0 |",
].join("\n");
const withActiveUpstreamIdentity = (body: string) => `${activeUpstreamIdentity}\n\n${body}`;
const sonicWorkshopDecision = readRepositoryFile("docs/parity/sonic-workshop-provenance.md");
const sonicWorkshopModuleDesign = readRepositoryFile("docs/parity/sonic-workshop-module-design.md");
const reviewedDeltaStatus = readRepositoryFile("docs/parity/reviewed-delta-status.md");

const validDocuments = {
	capabilityMatrix: withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		...completeCapabilityRows,
	].join("\n")),
	upstreamSourceMap: upstreamSourceMapDocument,
	appExtractionMap: "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |\n| --- | --- | --- | --- | --- | --- | --- | --- |",
	apiFreeze: [
		"SidecarClient",
		"Bun sidecar",
		"RuntimeConfig.sidecarBaseUrl",
		"get_sidecar_status",
		"SidecarRecoveryNotice",
		"apps/desktop/scripts/build-sidecar-binary.mjs",
		"externalBin",
		"ApiError",
	].join("\n"),
	sonicWorkshopProvenance: sonicWorkshopDecision,
	sonicWorkshopModuleDesign,
	reviewedDeltaStatus,
};

test("M10 baseline accepts the active Mineradio v2.1.0 release identity", () => {
	expect(validateConvergenceBaseline(validDocuments)).toEqual([]);
});

test("policy snapshot lock normalizes line endings and rejects every unreviewed prose mutation", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: validDocuments.upstreamSourceMap.replaceAll("\n", "\r\n"),
		sonicWorkshopProvenance: sonicWorkshopDecision.replaceAll("\n", "\r\n"),
		sonicWorkshopModuleDesign: sonicWorkshopModuleDesign.replaceAll("\n", "\r\n"),
		reviewedDeltaStatus: reviewedDeltaStatus.replaceAll("\n", "\r\n"),
	})).toEqual([]);

	for (const [key, documentName, prose] of [
		["sonicWorkshopProvenance", "sonic-workshop-provenance", "本设计只接受有效的 GPU timer-query samples。"],
		["sonicWorkshopModuleDesign", "sonic-workshop-module-design", "本设计要求替代材质仍受相同资源预算约束。"],
		["reviewedDeltaStatus", "reviewed-delta-status", "本文件补充排版说明。"],
		["upstreamSourceMap", "upstream-source-map", "补充：所有提交身份仍以结构化表为准。"],
	] as const) {
		const source = validDocuments[key];
		const errors = validateConvergenceBaseline({
			...validDocuments,
			[key]: `${source}\n${prose}`,
		});
		expect(errors.some((error) =>
			error.startsWith(`${documentName}: policy snapshot digest must be`))).toBe(true);
	}
});

test("M0 baseline rejects the legacy Mineradio v2.0.2 active identity", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: [
			legacyCapabilityHeader,
			legacyCapabilityDelimiter,
			legacyCapabilityRow,
		].join("\n"),
		upstreamSourceMap: "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
	})).toContain("capability-matrix: missing active upstream identity");
});

test("M10 baseline rejects the annotated tag object used as the peeled identity", () => {
	const branchCommit = "37993d337c73b130e4a81da7c973b8d246fe32a3";
	const mismatchedIdentity = activeUpstreamIdentity.replace(
		"96091d123b36783f5604d1acd47b00b0708cabbd",
		branchCommit,
	);
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			activeUpstreamIdentity,
			mismatchedIdentity,
		),
		upstreamSourceMap: `${mismatchedIdentity}\n\n${upstreamReleaseProvenance}`,
	});
	expect(errors).toContain(
		`capability-matrix: active upstream identity line 3 field peeled_commit must be 96091d123b36783f5604d1acd47b00b0708cabbd; received ${branchCommit}`,
	);
	expect(errors).toContain(
		`upstream-source-map: active upstream identity line 3 field peeled_commit must be 96091d123b36783f5604d1acd47b00b0708cabbd; received ${branchCommit}`,
	);
});

test("M10 baseline requires annotated tag provenance", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: activeUpstreamIdentity,
	})).toContain("upstream-source-map: missing release provenance");
});

test("M0 baseline rejects duplicate release provenance tables", () => {
	const duplicateProvenance = upstreamReleaseProvenance.replace(
		"37993d337c73b130e4a81da7c973b8d246fe32a3",
		"1111111111111111111111111111111111111111",
	);
	const errors = validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\n${duplicateProvenance}`,
	});
	expect(errors.some((error) =>
		error.startsWith("upstream-source-map: duplicate release provenance headers at lines "))).toBe(true);
});

test("M10 baseline rejects legacy active markers beside the v2.1.0 identity", () => {
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n上游行为基线：\`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224\`。`,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\nElectron baseline: \`4abaa190de42c632365ae4244e041bad16443224\``,
	});
	expect(errors).toContain("capability-matrix: legacy Mineradio v2.0.2 active baseline marker remains");
	expect(errors).toContain("upstream-source-map: legacy Mineradio v2.0.2 active baseline marker remains");
});

test("M0 parser ignores fenced legacy history while the policy snapshot still rejects mutation", () => {
	const capabilityHistory = [
		"```md",
		"上游行为基线：`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224`。",
		"```",
	].join("\n");
	const sourceMapHistory = [
		"```md",
		"Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
		"```",
	].join("\n");
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n${capabilityHistory}`,
		upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n\n${sourceMapHistory}`,
	});
	expect(errors).not.toContain("capability-matrix: legacy Mineradio v2.0.2 active baseline marker remains");
	expect(errors).not.toContain("upstream-source-map: legacy Mineradio v2.0.2 active baseline marker remains");
	expect(errors.some((error) =>
		error.startsWith("upstream-source-map: policy snapshot digest must be"))).toBe(true);
});

test("D0 inventory reports missing reviewed v2.1.0 and inherited gaps", () => {
	const missingCapabilityIds = new Set([
		"baseline.electron-2.1.0",
		"visual.cursor-activity",
		"playback.startup-resume",
	]);
	const missingInventory = d0InventoryRows.filter((_, index) =>
		!missingCapabilityIds.has(d0InventoryCapabilities[index][0])).join("\n");
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			d0InventoryRows.join("\n"),
			missingInventory,
		),
	});
	expect(errors).toContain("capability-matrix: missing D0 inventory capability baseline.electron-2.1.0");
	expect(errors).toContain("capability-matrix: missing D0 inventory capability visual.cursor-activity");
	expect(errors).toContain("capability-matrix: missing D0 inventory capability playback.startup-resume");
});

test("D0 source map requires every inherited reviewed delta", () => {
	const errors = validateConvergenceBaseline({
		...validDocuments,
		upstreamSourceMap: validDocuments.upstreamSourceMap
			.split(/\r?\n/)
			.filter((line) => !line.startsWith("| visual.sonic-workshop |"))
			.join("\n"),
	});
	expect(errors).toContain("upstream-source-map: missing D0 delta visual.sonic-workshop");
});

test("D3 guard requires the active Sonic Workshop independent implementation decision", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopProvenance: undefined,
	})).toContain("sonic-workshop-provenance: missing decision document");

	for (const marker of [
		"CmzYa",
		"`3747222633`",
		"legacy `visual.fx` numeric preset `8` 继续迁移到 Sonic Topography `7`",
	]) {
		const errors = validateConvergenceBaseline({
			...validDocuments,
			sonicWorkshopProvenance: sonicWorkshopDecision.replaceAll(marker, ""),
		});
		expect(errors).toContain(`sonic-workshop-provenance: missing ${marker}`);
	}

	for (const [active, replacement] of [
		[
			"- 将代码完成状态宣称为已经通过 Windows/WebView2 实机验证、`Field Validated` 或 `Release Verified`。",
			"- 将代码完成状态视为已经通过全部实机验证。",
		],
		[
			"- 从 Electron 上游复制 `public/vendor/sonic-workshop/**` 到 Tauri 发布物；",
			"- 无需遵守‘不导入上述 vendor bundle’约束。",
		],
	] as const) {
		const errors = validateConvergenceBaseline({
			...validDocuments,
			sonicWorkshopProvenance: sonicWorkshopDecision.replace(active, replacement),
		});
		expect(errors.some((error) =>
			error.includes("missing exact policy line")
			|| error.includes("contradictory policy"))).toBe(true);
	}

	const reversedDecision = sonicWorkshopDecision.replace(
		"independent-visual-module | no-vendor-bundle-import-or-redistribution",
		"app-tsx-inline-bridge | vendor-bundle-import-allowed",
	);
	let errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopProvenance: reversedDecision,
	});
	expect(errors.some((error) =>
		error.includes("decision")
		&& error.includes("independent-visual-module"))).toBe(true);

	const reversedMatrix = validDocuments.capabilityMatrix
		.replace("`packages/visual-engine/src/sonic-workshop`", "App.tsx inline bridge")
		.replace(
			"legacy `visual.fx` numeric 8 始终迁为 Sonic Topography 7；`visual.workshop.v1` 以 activation id 恢复当前 Workshop preset 8",
			"legacy numeric 8 直接复用为 Workshop preset 8",
		);
	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: reversedMatrix,
	});
	expect(errors.some((error) =>
		error.includes("visual.sonic-workshop target_module"))).toBe(true);
	expect(errors.some((error) =>
		error.includes("visual.sonic-workshop state_migration"))).toBe(true);

	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			"disabled cost=0；high hard caps：mesh/draw 8、geometry 8 MiB、texture/cache 16 MiB、queued task cost 32、CPU p95 1.5 ms、GPU delta p95 5 ms、frame +10%",
			"budget to be decided",
		),
	});
	expect(errors.some((error) =>
		error.includes("visual.sonic-workshop performance_budget"))).toBe(true);

	expect(validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopModuleDesign: undefined,
	})).toContain("sonic-workshop-module-design: missing design document");

	errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopModuleDesign: sonicWorkshopModuleDesign
			.replace("visual.workshop.v1", "visual.fx")
			.replace("| high | 8 | 8 | 8 | 16 | 16 | 32 | 1.5 | 5 | <=10% |",
				"| high | 16 | 16 | 32 | 64 | 64 | 128 | 4 | 12 | <=30% |"),
	});
	expect(errors.some((error) =>
		error.includes("module design")
		&& error.includes("visual.workshop.v1"))).toBe(true);
	expect(errors.some((error) =>
		error.includes("resource budget")
		&& error.includes("8 / 8 / 8 / 16 / 16 / 32 / 1.5 / 5 / <=10%"))).toBe(true);

	for (const documents of [
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n当前已完成独立实现，因此全部视觉能力一致。`,
		},
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n当前已实现视觉完整对齐。`,
		},
		{
			...validDocuments,
			upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n当前已经实现视觉完整对齐。`,
		},
		{
			...validDocuments,
			upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n当前已完整复现 Mineradio 2.0.3。`,
		},
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n当前已 100% 覆盖 Mineradio 2.0.3。`,
		},
		{
			...validDocuments,
			upstreamSourceMap: `${validDocuments.upstreamSourceMap}\nFull parity achieved.`,
		},
		{
			...validDocuments,
			upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n当前已经完全对齐 Mineradio 2.0.3。`,
		},
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n当前已经全量复现 Mineradio 2.0.3。`,
		},
		{
			...validDocuments,
			upstreamSourceMap: `${validDocuments.upstreamSourceMap}\n当前已经百分百覆盖 Mineradio 2.0.3。`,
		},
	]) {
		const claimErrors = validateConvergenceBaseline(documents);
		expect(claimErrors.some((error) =>
			error.includes("policy snapshot digest must be"))).toBe(true);
	}

	errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopProvenance: `${sonicWorkshopDecision}\n结构化决策表只供参考，不具约束力。`,
	});
	expect(errors.some((error) =>
		error.includes("sonic-workshop-provenance: policy snapshot digest must be"))).toBe(true);

	errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopModuleDesign: `${sonicWorkshopModuleDesign}\n以上设计已废止。`,
	});
	expect(errors.some((error) =>
		error.includes("sonic-workshop-module-design: policy snapshot digest must be"))).toBe(true);

	for (const documents of [
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n本决策不再有效。`,
		},
		{
			...validDocuments,
			sonicWorkshopModuleDesign: `${sonicWorkshopModuleDesign}\n本设计不再有效。`,
		},
		{
			...validDocuments,
			sonicWorkshopProvenance: `${sonicWorkshopDecision}\n本决策仅供参考。`,
		},
		{
			...validDocuments,
			sonicWorkshopModuleDesign: `${sonicWorkshopModuleDesign}\n本设计已失效。`,
		},
		{
			...validDocuments,
			sonicWorkshopModuleDesign: `${sonicWorkshopModuleDesign}\n本设计已由后续文件取代。`,
		},
	]) {
		const authorityErrors = validateConvergenceBaseline(documents);
		expect(authorityErrors.some((error) =>
			error.includes("policy snapshot digest must be"))).toBe(true);
	}

	errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopProvenance: sonicWorkshopDecision.replace("| active |", "| advisory |"),
		sonicWorkshopModuleDesign: sonicWorkshopModuleDesign.replace("| active |", "| superseded |"),
	});
	expect(errors.some((error) =>
		error.includes("decision") && error.includes("active"))).toBe(true);
	expect(errors.some((error) =>
		error.includes("module design") && error.includes("active"))).toBe(true);

	errors = validateConvergenceBaseline({
		...validDocuments,
		sonicWorkshopProvenance: `${sonicWorkshopDecision}\n不允许直接复制 sonic-workshop vendor bundle。`,
	});
	expect(errors.some((error) =>
		error.includes("contradictory policy"))).toBe(false);
});

test("#59 guard requires an open reviewed-delta status document", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: undefined,
	})).toContain("reviewed-delta-status: missing status document");

	for (const [active, replacement, expected] of [
		["| reviewed_delta | open |", "| reviewed_delta | closed |", "open"],
		["| full_parity | false |", "| full_parity | true |", "false"],
		["| release_evidence | absent |", "| release_evidence | present |", "absent"],
		["| sidecar_api | legacy-frozen |", "| sidecar_api | migrated |", "legacy-frozen"],
	] as const) {
		const errors = validateConvergenceBaseline({
			...validDocuments,
			reviewedDeltaStatus: reviewedDeltaStatus.replace(active, replacement),
		});
			expect(errors.some((error) =>
				error.startsWith("reviewed-delta-status: summary")
				&& error.includes(`must be ${expected}`))).toBe(true);
	}

	for (const affirmativeClaim of [
		"本项目已经完整复现、完整对齐并 100% 覆盖 Mineradio 2.0.3。",
		"本次交付达到了 Mineradio 2.0.3 的 100% 覆盖。",
		"| claim | MineRadio-Tauri complete parity achieved |",
	]) {
		const errors = validateConvergenceBaseline({
			...validDocuments,
			reviewedDeltaStatus: `${reviewedDeltaStatus}\n\n${affirmativeClaim}`,
		});
		expect(errors.some((error) =>
			error.includes("reviewed-delta-status: policy snapshot digest must be"))).toBe(true);
	}
});

test("#59 guard keeps D0-D3 truthful and cannot clear the #56 human gate", () => {
	const regressedD1 = reviewedDeltaStatus.replace(
		"| D1 | complete | none | joint-gate-recorded |",
		"| D1 | pending | #43 | implementation-present |",
	);
	let errors = validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: regressedD1,
	});
	expect(errors.some((error) =>
		error.includes("D1 tuple must be complete / none / joint-gate-recorded"))).toBe(true);

	const closedGate = reviewedDeltaStatus
		.replace("| D2 | implementation-complete | #56 | external-gate-pending |",
			"| D2 | complete | none | recorded |")
		.replace("| overall_blocked_by | #56 |", "| overall_blocked_by | none |");
	errors = validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: closedGate,
	});
	expect(errors.some((error) =>
		error.includes("delta")
		&& error.includes("D2 tuple must be implementation-complete / #56 / external-gate-pending"))).toBe(true);
	expect(errors.some((error) =>
		error.includes("summary")
		&& error.includes("overall_blocked_by tuple must be #56"))).toBe(true);

	for (const closureClaim of [
		"#59 已经关闭，#56 不再构成阻塞，真实受保护发布证据已经存在。",
		"Mineradio 2.0.3 reviewed delta 已闭合。",
		"外部门禁 #56 已满足，真实升级证据已归档。",
		"#59 已结案，真实受保护发布证据已生成。",
	]) {
		errors = validateConvergenceBaseline({
			...validDocuments,
			reviewedDeltaStatus: `${reviewedDeltaStatus}\n${closureClaim}`,
		});
		expect(errors.some((error) =>
			error.includes("reviewed-delta-status: policy snapshot digest must be"))).toBe(true);
	}
});

test("#59 guard freezes all 16 unresolved capability tuples", () => {
	const missingStatusGap = reviewedDeltaStatus.replace(
		"| visual.archive | missing | P1 | parity | none |\n",
		"",
	);
	let errors = validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: missingStatusGap,
	});
	expect(errors).toContain(
		"reviewed-delta-status: expected exactly 16 unresolved capability rows; found 15",
	);
	expect(errors).toContain(
		"reviewed-delta-status: missing unresolved capability visual.archive",
	);

	const missingMatrixGap = validDocuments.capabilityMatrix.replace(
		`${blockedApiRows[0]}\n`,
		"",
	);
	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: missingMatrixGap,
	});
	expect(errors).toContain(
		"capability-matrix: expected exactly 16 unresolved capability rows; found 15",
	);
	expect(errors).toContain(
		"capability-matrix: missing unresolved capability provider.kugou",
	);
});

test("Cuefield AutoMix remains a local playback gap instead of a MineRadio-api blocker", () => {
	const legacyApiClassification = renderCapability({
		...cuefieldCapability,
		target_module: "future embedded API adapter",
		current_tauri: "blocked",
		owner_layer: "future API",
		api_dependency: "future-rust-api",
		blocked_by: "MineRadio-api",
	});
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			cuefieldCapabilityRow,
			legacyApiClassification,
		),
	});
	expect(errors).toContain(
		"capability-matrix: unresolved capability cuefield.automix tuple must be missing / P2 / parity / none; found blocked / P2 / parity / MineRadio-api",
	);
	expect(errors.some((error) =>
		error.includes("cuefield.automix target_module")
		&& error.includes("apps/desktop/src-tauri/src/runtime/cuefield_feedback.rs"))).toBe(true);
	expect(errors.some((error) =>
		error.includes("cuefield.automix api_dependency")
		&& error.includes("none（无 MineRadio-api；只复用现有 playback/lyrics/beatmap Ports 与本地 feedback repository Port）"))).toBe(true);
});

test("#59 guard preserves the implemented Sonic tuple and all 17 positive Field Validation Pending rows", () => {
	let errors = validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: reviewedDeltaStatus.replace(
			"| visual.sonic-workshop | implemented | Field Validation Pending (non-blocking) |",
			"| visual.sonic-workshop | missing | Field Validation Pending (non-blocking) |",
		),
	});
	expect(errors.some((error) =>
		error.includes("visual.sonic-workshop tuple must be implemented / Field Validation Pending (non-blocking)"))).toBe(true);

	errors = validateConvergenceBaseline({
		...validDocuments,
		reviewedDeltaStatus: reviewedDeltaStatus.replace(
			"| home.dashboard | implemented | Field Validation Pending (non-blocking) |\n",
			"",
		),
	});
	expect(errors).toContain(
		"reviewed-delta-status: expected exactly 17 positive Field Validation Pending capability rows; found 16",
	);
	expect(errors).toContain(
		"reviewed-delta-status: missing positive Field Validation Pending capability home.dashboard",
	);

	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			"Field Validation Pending",
			"field validation pending",
		),
	});
	expect(errors).toContain(
		"capability-matrix: expected exactly 17 positive Field Validation Pending capability rows; found 16",
	);
	expect(errors).toContain(
		"capability-matrix: missing positive Field Validation Pending capability lyrics.stage-v2",
	);

	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			"automated evidence; Field Validation Pending (non-blocking)",
			"automated evidence; Field Validation Pending (non-blocking) 已解除；Release Verified",
		),
	});
	expect(errors).toContain(
		"capability-matrix: capability lyrics.stage-v2 uses non-canonical Field Validation clearance language",
	);

	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			"automated evidence; Field Validation Pending (non-blocking)",
			"automated evidence; 已解除：Field Validation Pending (non-blocking)",
		),
	});
	expect(errors).toContain(
		"capability-matrix: capability lyrics.stage-v2 uses non-canonical Field Validation clearance language",
	);

	errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: validDocuments.capabilityMatrix.replace(
			"automated evidence; Field Validation Pending (non-blocking)",
			"自动化已完成；Field Validation Pending (non-blocking)",
		),
	});
	expect(errors.some((error) =>
		error.includes("non-canonical Field Validation clearance language"))).toBe(false);
});

test("convergence guard rejects the legacy capability matrix schema", () => {
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: withActiveUpstreamIdentity([
			legacyCapabilityHeader,
			legacyCapabilityDelimiter,
			legacyCapabilityRow,
		].join("\n")),
	})).toContain("capability-matrix: header line 5 has 13 columns; expected 14");
});

test("convergence guard rejects invalid capability taxonomy values", () => {
	const cases = [
		{ column: "current_tauri", value: "done" },
		{ column: "parity_level", value: "X" },
		{ column: "parity_level", value: "P3" },
		{ column: "convergence_mode", value: "unknown" },
		{ column: "convergence_mode", value: "" },
	];
	for (const testCase of cases) {
		const capabilityMatrix = withActiveUpstreamIdentity([
			expandedCapabilityHeader,
			expandedCapabilityDelimiter,
			renderCapability({
				...exampleCapability,
				[testCase.column]: testCase.value,
			}),
		].join("\n"));
		const renderedValue = testCase.value || "<empty>";
		expect(validateConvergenceBaseline({
			...validDocuments,
			capabilityMatrix,
		})).toContain(
			`capability-matrix: line 7 capability "app.example" column ${testCase.column} has invalid value "${renderedValue}"`,
		);
	}
});

test("convergence guard requires blocked capabilities to name a blocker", () => {
	const blockedCapability = {
		...exampleCapability,
		current_tauri: "blocked",
	};
	const blockedWithoutOwner = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		renderCapability(blockedCapability),
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: blockedWithoutOwner,
	})).toContain(
		'capability-matrix: line 7 capability "app.example" column blocked_by must name a blocker for blocked state',
	);

	const blockedWithOwner = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		renderCapability({
			...blockedCapability,
			blocked_by: "MineRadio-api",
		}),
		updaterCapabilityRow,
		...d0InventoryRows,
	].join("\n"));
	const blockedWithOwnerErrors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: blockedWithOwner,
	});
	expect(blockedWithOwnerErrors).not.toContain(
		'capability-matrix: line 7 capability "app.example" column blocked_by must name a blocker for blocked state',
	);
});

test("convergence guard requires exactly one updater authority", () => {
	const missingUpdaterMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: missingUpdaterMatrix,
	})).toContain("capability-matrix: expected exactly one updater authority; found 0");

	const duplicateUpdaterMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		updaterCapabilityRow,
		updaterCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: duplicateUpdaterMatrix,
	})).toContain("capability-matrix: expected exactly one updater authority; found 2 at lines 8, 9");
});

test("convergence guard freezes the GitHub Release updater authority tuple", () => {
	const cases = [
		{ field: "capability_id", value: "updater.signed" },
		{ field: "domain", value: "desktop" },
		{ field: "current_tauri", value: "baseline" },
		{ field: "parity_level", value: "P0" },
		{ field: "convergence_mode", value: "parity" },
	];
	const authorityFields = [
		"capability_id",
		"domain",
		"current_tauri",
		"parity_level",
		"convergence_mode",
	];
	for (const testCase of cases) {
		const changedUpdater = {
			...updaterCapability,
			[testCase.field]: testCase.value,
		};
		const capabilityMatrix = withActiveUpstreamIdentity([
			expandedCapabilityHeader,
			expandedCapabilityDelimiter,
			expandedCapabilityRow,
			renderCapability(changedUpdater),
		].join("\n"));
		const actualAuthority = authorityFields
			.map((field) => changedUpdater[field as keyof typeof changedUpdater])
			.join(" / ");
		expect(validateConvergenceBaseline({
			...validDocuments,
			capabilityMatrix,
		})).toContain(
			`capability-matrix: line 8 updater authority must be updater.github-release / updater / implemented / P1 / architecture-replacement; found ${actualAuthority}`,
		);
	}
});

test("convergence guard rejects a hidden second capability table", () => {
	const legacyTable = [
		legacyCapabilityHeader,
		legacyCapabilityDelimiter,
		legacyCapabilityRow,
	].join("\n");
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix: `${validDocuments.capabilityMatrix}\n\n${legacyTable}`,
	});
	expect(errors.some((error) =>
		error.startsWith("capability-matrix: duplicate capability headers at lines 5, "))).toBe(true);
});

test("convergence guard identifies capability headers by parsed column names", () => {
	const compactHeader = expandedCapabilityHeader.replaceAll(" | ", "|");
	const capabilityMatrix = withActiveUpstreamIdentity([
		compactHeader,
		expandedCapabilityDelimiter,
		...completeCapabilityRows,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows with the wrong column count", () => {
	const capabilityMatrix = `${validDocuments.capabilityMatrix}\n| visual.example | visual | incomplete |`;
	const errors = validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	});
	expect(errors.some((error) =>
		error.includes('capability "visual.example" has 3 columns; expected 14'))).toBe(true);
});

test("convergence guard reports malformed capability headers by line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(
		expandedCapabilityHeader.replace(" | convergence_mode", ""),
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has 13 columns; expected 14");
});

test("convergence guard reports unsupported capability columns by header line", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(
		expandedCapabilityHeader.replace("target_module", "unexpected_target"),
	);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has unsupported columns");
});

test("convergence guard rejects arbitrary columns appended to the legacy schema", () => {
	const unsupportedHeader = expandedCapabilityHeader.replace(
		"performance_budget |",
		"performance_budget | unexpected |",
	);
	const capabilityMatrix = withActiveUpstreamIdentity([
		unsupportedHeader,
		capabilityRow(Array(15).fill("---")),
		capabilityRow([...Array(14).fill("value"), "unexpected"]),
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: header line 5 has 15 columns; expected 14");
});

test("convergence guard rejects capability delimiters with the wrong width", () => {
	const capabilityMatrix = withActiveUpstreamIdentity(`${expandedCapabilityHeader}\n| --- |`);
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: delimiter line 6 has 1 columns; expected 14");
});

test("convergence guard reports empty capability identifiers by line", () => {
	const emptyCapabilityRow = renderCapability({
		...exampleCapability,
		capability_id: "   ",
	});
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		emptyCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 has empty capability_id");
});

test("convergence guard reports duplicate capability identifiers with both lines", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		expandedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain('capability-matrix: line 8 capability "app.example" duplicates line 7');
});

test("convergence guard ignores capability tables inside fenced examples", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		"```md",
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		"```",
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard ignores capability tables inside HTML comments", () => {
	const capabilityMatrix = withActiveUpstreamIdentity([
		"<!--",
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		expandedCapabilityRow,
		"-->",
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: missing required header");
});

test("convergence guard treats escaped pipes as capability cell content", () => {
	const escapedPipeRow = renderCapability({
		...exampleCapability,
		upstream_source: "upstream \\| source",
	});
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		escapedPipeRow,
		...completeCapabilityRows.slice(1),
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toEqual([]);
});

test("convergence guard reports capability rows missing the closing pipe", () => {
	const malformedCapabilityRow = expandedCapabilityRow.slice(0, -1);
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 is malformed");
});

test("convergence guard reports non-canonical rows without outer pipes", () => {
	const malformedCapabilityRow = expandedCapabilityRow.slice(1, -1).trim();
	const capabilityMatrix = withActiveUpstreamIdentity([
		expandedCapabilityHeader,
		expandedCapabilityDelimiter,
		malformedCapabilityRow,
	].join("\n"));
	expect(validateConvergenceBaseline({
		...validDocuments,
		capabilityMatrix,
	})).toContain("capability-matrix: line 7 is malformed");
});

test("M0 baseline reports missing API freeze markers", () => {
	expect(validateConvergenceBaseline({ ...validDocuments, apiFreeze: "SidecarClient" }))
		.toContain("api-freeze: missing Bun sidecar");
});

test("M0 baseline extracts and verifies App top-level symbols", () => {
	const appSource = [
		"const FIRST = 1;",
		"export interface ExampleInput {}",
		"export function createExample() {}",
	].join("\n");
	expect(extractTopLevelSymbols(appSource)).toEqual([
		"FIRST",
		"ExampleInput",
		"createExample",
	]);
	expect(validateConvergenceBaseline({
		...validDocuments,
		appSource,
		appExtractionMap: `${validDocuments.appExtractionMap}\n\`FIRST\`\n\`ExampleInput\``,
	})).toContain("app-extraction-map: missing symbol createExample");
});
