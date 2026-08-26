import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CAPABILITY_HEADER = "| capability_id | domain | upstream_source | target_module | current_tauri | parity_level | convergence_mode | owner_layer | api_dependency | state_migration | verification | feature_gate | blocked_by | performance_budget |";
const CAPABILITY_ENUMS = {
	current_tauri: new Set(["baseline", "implemented", "partial", "missing", "blocked"]),
	parity_level: new Set(["P0", "P1", "P2"]),
	convergence_mode: new Set(["parity", "architecture-replacement", "intentional-exclusion"]),
};
const UPDATER_AUTHORITY_FIELDS = [
	"capability_id",
	"domain",
	"current_tauri",
	"parity_level",
	"convergence_mode",
];
const EXPECTED_UPDATER_AUTHORITY = {
	capability_id: "updater.github-release",
	domain: "updater",
	current_tauri: "implemented",
	parity_level: "P1",
	convergence_mode: "architecture-replacement",
};
const D0_INVENTORY_CAPABILITIES = new Map([
	["baseline.electron-2.1.0", ["implemented", "P0", "parity", "none"]],
	["lyrics.stage-v2", ["implemented", "P0", "parity", "none"]],
	["visual.cursor-activity", ["implemented", "P0", "parity", "none"]],
	["visual.shelf-cursor-layer", ["implemented", "P0", "parity", "none"]],
	["visual.sonic-workshop", ["implemented", "P0", "parity", "none"]],
	["wallpaper.idle-dispose", ["implemented", "P0", "parity", "none"]],
	["playback.startup-resume", ["missing", "P0", "parity", "none"]],
	["queue.drag-sort", ["missing", "P1", "parity", "none"]],
	["library.drag-sort", ["missing", "P1", "parity", "none"]],
	["lyrics.track-offset", ["missing", "P1", "parity", "none"]],
	["beatmap.local-song", ["partial", "P1", "parity", "none"]],
	["local-import.expanded", ["partial", "P1", "parity", "none"]],
	["hotkeys.editor", ["missing", "P1", "parity", "none"]],
	["visual.archive", ["missing", "P1", "parity", "none"]],
	["visual.camera-gesture", ["missing", "P2", "parity", "none"]],
	["wallpaper.library", ["partial", "P1", "parity", "none"]],
	["wallpaper.wgc", ["missing", "P1", "parity", "none"]],
	["accounts.provider-order", ["missing", "P1", "parity", "none"]],
	["search.multi-provider-offset", ["partial", "P1", "parity", "none"]],
]);
const D0_INVENTORY_FIELDS = [
	"current_tauri",
	"parity_level",
	"convergence_mode",
	"blocked_by",
];
const D0_SOURCE_MAP_DELTAS = new Map([
	["lyrics.nested-render-base", ["implemented", "parity"]],
	["visual.cursor-shelf-layer", ["implemented", "parity"]],
	["updater.github-release", ["implemented", "architecture-replacement"]],
	["visual.sonic-workshop", ["implemented", "parity"]],
	["wallpaper.idle-dispose", ["implemented", "parity"]],
]);
const D0_SOURCE_MAP_COLUMNS = [
	"delta_id",
	"current_tauri",
	"convergence_mode",
	"evidence",
];
const EXTRACTION_HEADER = "| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |";
const ACTIVE_UPSTREAM_IDENTITY = {
	repository: "XxHuberrr/Mineradio",
	tag: "v2.1.0",
	peeled_commit: "96091d123b36783f5604d1acd47b00b0708cabbd",
	tree: "b1b9f80a72d96afcbc8b4685256c3adba9014551",
	package_version: "2.1.0",
};
const ACTIVE_UPSTREAM_IDENTITY_COLUMNS = [
	"baseline_role",
	...Object.keys(ACTIVE_UPSTREAM_IDENTITY),
];
const UPSTREAM_PROVENANCE_COLUMNS = [
	"provenance_role",
	"ref",
	"object_id",
	"resolved_commit",
	"tree",
	"package_version",
];
const EXPECTED_UPSTREAM_PROVENANCE = {
	release_tag: {
		ref: "refs/tags/v2.1.0",
		object_id: "37993d337c73b130e4a81da7c973b8d246fe32a3",
		resolved_commit: ACTIVE_UPSTREAM_IDENTITY.peeled_commit,
		tree: ACTIVE_UPSTREAM_IDENTITY.tree,
		package_version: ACTIVE_UPSTREAM_IDENTITY.package_version,
	},
};
const LEGACY_ACTIVE_BASELINE_MARKERS = {
	"capability-matrix": "上游行为基线：`XxHuberrr/Mineradio@4abaa190de42c632365ae4244e041bad16443224`。",
	"upstream-source-map": "Electron baseline: `4abaa190de42c632365ae4244e041bad16443224`",
};
const API_FREEZE_MARKERS = [
	"SidecarClient",
	"Bun sidecar",
	"RuntimeConfig.sidecarBaseUrl",
	"get_sidecar_status",
	"SidecarRecoveryNotice",
	"apps/desktop/scripts/build-sidecar-binary.mjs",
	"externalBin",
	"ApiError",
];
const SONIC_WORKSHOP_DECISION_MARKERS = [
	"# Sonic Workshop preset 8 来源与处置",
	"迁移该能力，但只允许独立重实现",
	"`independent-implementation-complete`",
	"`visual.sonic-workshop` 为 `implemented / P0 / parity`",
	"`blocked_by=none`",
	"CmzYa",
	"`3747222633`",
	"legacy `visual.fx` numeric preset `8` 继续迁移到 Sonic Topography `7`",
];
const SONIC_WORKSHOP_REQUIRED_POLICY_LINES = [
	"- 当前 Workshop preset 8 只通过新的 `visual.workshop.v1` preference schema 与 `sonic-workshop-v1` activation id 恢复。",
	"因此禁止：",
	"- 从 Electron 上游复制 `public/vendor/sonic-workshop/**` 到 Tauri 发布物；",
	"- 将代码完成状态宣称为已经通过 Windows/WebView2 实机验证、`Field Validated` 或 `Release Verified`。",
];
// 这些文档共同定义当前收口事实，整篇锁定可避免用正则猜测自由文本的语义。
const CONVERGENCE_POLICY_SNAPSHOT_DIGESTS = new Map([
	["upstream-source-map", "41c3ca99cdfb7cc38864938c52624a64ecb3bf92d873d06b1167b6145d51be8d"],
	["sonic-workshop-provenance", "ec07b553add89d5549e6ca5c0a12d1607228d4d83a7c117f2efdf74cd3841c89"],
	["sonic-workshop-module-design", "c0eff31bb364fa9f42247741ec914e5851ddd219b7da93ed496d07fb33da5c1e"],
	["reviewed-delta-status", "e6f9a177a8ee6c0ec3e5b15574559bd698786360f5af5392797fd98f280d5c77"],
]);
const SONIC_WORKSHOP_DECISION_COLUMNS = [
	"decision_id",
	"status",
	"source_owner",
	"implementation_target",
	"bundle_policy",
	"legacy_migration",
	"preference_schema",
	"parity_claim",
	"authority_status",
];
const EXPECTED_SONIC_WORKSHOP_DECISIONS = new Map([
	["sonic-workshop-preset-8", [
		"independent-implementation-complete",
		"CmzYa@3747222633",
		"independent-visual-module",
		"no-vendor-bundle-import-or-redistribution",
		"legacy-8-to-sonic-topography-7",
		"distinct-workshop-preset-8",
		"code-implemented-field-validation-pending",
		"active",
	]],
]);
const EXPECTED_SONIC_WORKSHOP_CAPABILITY = {
	target_module: "`packages/visual-engine/src/sonic-workshop`",
	current_tauri: "implemented",
	parity_level: "P0",
	convergence_mode: "parity",
	owner_layer: "visual-engine Module",
	state_migration: "legacy `visual.fx` numeric 8 始终迁为 Sonic Topography 7；`visual.workshop.v1` 以 activation id 恢复当前 Workshop preset 8",
	verification: "独立 Module、动态冷加载、独立 render lane、typed audio/media/theme 输入、160×160 有界实例网格、9 主题/六色、封面与有界标题/作者叠层、资源归零、偏好事务与独立性守卫均有自动化证据；Windows/WebView2 观感、CPU/GPU timing 及 frame regression 为 Field Validation Pending (non-blocking)",
	blocked_by: "none",
	performance_budget: "disabled cost=0；high hard caps：mesh/draw 8、geometry 8 MiB、texture/cache 16 MiB、queued task cost 32、CPU p95 1.5 ms、GPU delta p95 5 ms、frame +10%",
};
const EXPECTED_CUEFIELD_AUTOMIX_CAPABILITY = {
	domain: "playback",
	upstream_source: "`05-playback/16-*` 至 `18-*`、`cuefield/**`、本机 `/api/cuefield/*` routes",
	target_module: "`apps/web/src/features/playback/cuefield` + `apps/desktop/src-tauri/src/runtime/cuefield_feedback.rs` (future)",
	current_tauri: "missing",
	parity_level: "P2",
	convergence_mode: "parity",
	owner_layer: "local playback Module + Web controller；desktop persistence Adapter 仅实现 feedback repository",
	api_dependency: "none（无 MineRadio-api；只复用现有 playback/lyrics/beatmap Ports 与本地 feedback repository Port）",
	state_migration: "`mineradio-cuefield-automix-v1` preference + local feedback history migration",
	verification: "本机 planner/timeline/feedback；依赖 beatmap.local-song 收敛；deterministic audio/beatmap fixtures + Web playback handoff tests",
	feature_gate: "cuefield",
	blocked_by: "none",
	performance_budget: "disabled cost=0；planning 与 prepared audio/graph/timer ownership bounded",
};
const SONIC_WORKSHOP_MODULE_DESIGN_COLUMNS = [
	"design_id",
	"module_path",
	"activation_id",
	"input_boundary",
	"vendor_dependency",
	"preference_key",
	"legacy_preset_8",
	"disabled_cost",
	"authority_status",
];
const EXPECTED_SONIC_WORKSHOP_MODULE_DESIGNS = new Map([
	["sonic-workshop-v1", [
		"packages/visual-engine/src/sonic-workshop",
		"sonic-workshop-v1",
		"shared-frame-audio-media-theme-only",
		"none",
		"visual.workshop.v1",
		"migrates-to-sonic-topography-7",
		"zero",
		"active",
	]],
]);
const SONIC_WORKSHOP_BUDGET_COLUMNS = [
	"profile",
	"mesh_hard",
	"draw_call_hard",
	"geometry_hard_mib",
	"texture_hard_mib",
	"cache_hard_mib",
	"queued_task_cost_hard",
	"cpu_p95_ms",
	"gpu_delta_p95_ms",
	"frame_regression",
];
const EXPECTED_SONIC_WORKSHOP_BUDGETS = new Map([
	["high", ["8", "8", "8", "16", "16", "32", "1.5", "5", "<=10%"]],
]);
const REVIEWED_DELTA_COLUMNS = ["delta_id", "status", "blocked_by", "evidence_state"];
const EXPECTED_REVIEWED_DELTAS = new Map([
	["D0", ["complete", "none", "recorded"]],
	["D1", ["complete", "none", "joint-gate-recorded"]],
	["D2", ["implementation-complete", "#56", "external-gate-pending"]],
	["D3", ["implementation-complete", "none", "recorded"]],
]);
const REVIEWED_DELTA_SUMMARY_COLUMNS = ["status_key", "value"];
const EXPECTED_REVIEWED_DELTA_SUMMARY = new Map([
	["reviewed_delta", "open"],
	["overall_status", "blocked"],
	["overall_blocked_by", "#56"],
	["full_parity", "false"],
	["release_evidence", "absent"],
	["sidecar_api", "legacy-frozen"],
]);
const REVIEWED_DELTA_REQUIRED_POLICY_LINES = [
	"当前不得关闭 #59，也不得声称完整复现、完整对齐或 100% 覆盖 Mineradio 2.1.0。",
];
const CANONICAL_FIELD_VALIDATION_PENDING = "Field Validation Pending (non-blocking)";
const FIELD_VALIDATION_RESERVED_CLEARANCE_LANGUAGE = /(?:已解除|已通过实机验证|resolved|cleared|Field Validated|Release Verified)/i;
const UNRESOLVED_CAPABILITY_COLUMNS = [
	"capability_id",
	"current_tauri",
	"parity_level",
	"convergence_mode",
	"blocked_by",
];
const EXPECTED_UNRESOLVED_CAPABILITIES = new Map([
	["search.multi-provider-offset", ["partial", "P1", "parity", "none"]],
	["playback.startup-resume", ["missing", "P0", "parity", "none"]],
	["beatmap.local-song", ["partial", "P1", "parity", "none"]],
	["queue.drag-sort", ["missing", "P1", "parity", "none"]],
	["lyrics.track-offset", ["missing", "P1", "parity", "none"]],
	["visual.archive", ["missing", "P1", "parity", "none"]],
	["visual.camera-gesture", ["missing", "P2", "parity", "none"]],
	["accounts.provider-order", ["missing", "P1", "parity", "none"]],
	["library.drag-sort", ["missing", "P1", "parity", "none"]],
	["local-import.expanded", ["partial", "P1", "parity", "none"]],
	["hotkeys.editor", ["missing", "P1", "parity", "none"]],
	["wallpaper.library", ["partial", "P1", "parity", "none"]],
	["wallpaper.wgc", ["missing", "P1", "parity", "none"]],
	["provider.kugou", ["blocked", "P2", "parity", "MineRadio-api"]],
	["provider.spotify", ["blocked", "P2", "parity", "MineRadio-api"]],
	["cuefield.automix", ["missing", "P2", "parity", "none"]],
]);
const FIELD_VALIDATION_COLUMNS = ["capability_id", "current_tauri", "validation_status"];
const EXPECTED_POSITIVE_FIELD_VALIDATIONS = new Set([
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

function validatePolicySnapshot(documentName, source) {
	if (typeof source !== "string") return [];
	const expected = CONVERGENCE_POLICY_SNAPSHOT_DIGESTS.get(documentName);
	if (!expected) {
		return [`${documentName}: policy snapshot digest is not configured`];
	}
	const normalized = source.replace(/\r\n?/g, "\n");
	const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
	return actual === expected
		? []
		: [`${documentName}: policy snapshot digest must be ${expected}; found ${actual}`];
}

function validateCapabilityContract(capabilityRows, capabilityId, expected) {
	const entry = capabilityRows.get(capabilityId);
	if (!entry) {
		return [`capability-matrix: missing capability contract ${capabilityId}`];
	}
	const errors = [];
	for (const [field, expectedValue] of Object.entries(expected)) {
		const actual = entry.row[field];
		if (actual !== expectedValue) {
			errors.push(`capability-matrix: ${capabilityId} ${field} must be ${expectedValue}; found ${actual}`);
		}
	}
	return errors;
}

export function validateConvergenceBaseline(documents) {
	const errors = [];
	for (const [documentName, source] of [
		["upstream-source-map", documents.upstreamSourceMap],
		["sonic-workshop-provenance", documents.sonicWorkshopProvenance],
		["sonic-workshop-module-design", documents.sonicWorkshopModuleDesign],
		["reviewed-delta-status", documents.reviewedDeltaStatus],
	]) {
		errors.push(...validatePolicySnapshot(documentName, source));
	}
	const capabilityMatrix = inspectCapabilityMatrix(documents.capabilityMatrix);
	errors.push(...capabilityMatrix.errors);
	errors.push(...validateCapabilityContract(
		capabilityMatrix.rows,
		"cuefield.automix",
		EXPECTED_CUEFIELD_AUTOMIX_CAPABILITY,
	));
	errors.push(...validateActiveUpstreamIdentity(
		documents.capabilityMatrix,
		"capability-matrix",
	));
	errors.push(...validateActiveUpstreamIdentity(
		documents.upstreamSourceMap,
		"upstream-source-map",
	));
	errors.push(...validateUpstreamReleaseProvenance(documents.upstreamSourceMap));
	errors.push(...validateD0SourceMap(documents.upstreamSourceMap));
	errors.push(...validateSonicWorkshopDecision(
		documents.sonicWorkshopProvenance,
		capabilityMatrix.rows,
	));
	errors.push(...validateSonicWorkshopModuleDesign(documents.sonicWorkshopModuleDesign));
	errors.push(...validateReviewedDeltaStatus(
		documents.reviewedDeltaStatus,
		capabilityMatrix.rows,
	));
	for (const [documentName, source] of [
		["capability-matrix", documents.capabilityMatrix],
		["upstream-source-map", documents.upstreamSourceMap],
	]) {
		if (activeMarkdownContains(
			source,
			LEGACY_ACTIVE_BASELINE_MARKERS[documentName],
		)) {
			errors.push(`${documentName}: legacy Mineradio v2.0.2 active baseline marker remains`);
		}
	}
	if (!documents.appExtractionMap.includes(EXTRACTION_HEADER)) {
		errors.push("app-extraction-map: missing required header");
	}
	for (const marker of API_FREEZE_MARKERS) {
		if (!documents.apiFreeze.includes(marker)) {
			errors.push(`api-freeze: missing ${marker}`);
		}
	}
	if (typeof documents.appSource === "string") {
		for (const symbol of extractTopLevelSymbols(documents.appSource)) {
			if (!documents.appExtractionMap.includes(`\`${symbol}\``)) {
				errors.push(`app-extraction-map: missing symbol ${symbol}`);
			}
		}
	}
	return errors;
}

function validateSonicWorkshopDecision(source, capabilityRows) {
	if (typeof source !== "string") {
		return ["sonic-workshop-provenance: missing decision document"];
	}
	const errors = [];
	for (const marker of SONIC_WORKSHOP_DECISION_MARKERS) {
		if (!activeMarkdownContains(source, marker)) {
			errors.push(`sonic-workshop-provenance: missing ${marker}`);
		}
	}
	for (const line of SONIC_WORKSHOP_REQUIRED_POLICY_LINES) {
		if (!activeMarkdownHasExactLine(source, line)) {
			errors.push(`sonic-workshop-provenance: missing exact policy line ${line}`);
		}
	}
	const decisionTable = parseExactMarkdownTable(source, {
		columns: SONIC_WORKSHOP_DECISION_COLUMNS,
		documentName: "sonic-workshop-provenance",
		missingName: "structured decision table",
		tableName: "structured decision table",
	});
	const decisionRows = collectUniqueRows(
		decisionTable,
		"sonic-workshop-provenance",
		"decision",
		errors,
	);
	validateExactTupleRows({
		documentName: "sonic-workshop-provenance",
		tableName: "decision",
		rows: decisionRows,
		expected: EXPECTED_SONIC_WORKSHOP_DECISIONS,
		valueOffset: 1,
		errors,
	});

	errors.push(...validateCapabilityContract(
		capabilityRows,
		"visual.sonic-workshop",
		EXPECTED_SONIC_WORKSHOP_CAPABILITY,
	));
	return errors;
}

function validateSonicWorkshopModuleDesign(source) {
	const documentName = "sonic-workshop-module-design";
	if (typeof source !== "string") {
		return [`${documentName}: missing design document`];
	}
	const errors = [];
	const designTable = parseExactMarkdownTable(source, {
		columns: SONIC_WORKSHOP_MODULE_DESIGN_COLUMNS,
		documentName,
		missingName: "module boundary table",
		tableName: "module boundary table",
	});
	const designRows = collectUniqueRows(designTable, documentName, "module design", errors);
	validateExactTupleRows({
		documentName,
		tableName: "module design",
		rows: designRows,
		expected: EXPECTED_SONIC_WORKSHOP_MODULE_DESIGNS,
		valueOffset: 1,
		errors,
	});

	const budgetTable = parseExactMarkdownTable(source, {
		columns: SONIC_WORKSHOP_BUDGET_COLUMNS,
		documentName,
		missingName: "resource budget table",
		tableName: "resource budget table",
	});
	const budgetRows = collectUniqueRows(budgetTable, documentName, "resource budget", errors);
	validateExactTupleRows({
		documentName,
		tableName: "resource budget",
		rows: budgetRows,
		expected: EXPECTED_SONIC_WORKSHOP_BUDGETS,
		valueOffset: 1,
		errors,
	});
	return errors;
}

function validateReviewedDeltaStatus(source, capabilityRows) {
	const documentName = "reviewed-delta-status";
	if (typeof source !== "string") {
		return [`${documentName}: missing status document`];
	}
	const errors = [];
	for (const line of REVIEWED_DELTA_REQUIRED_POLICY_LINES) {
		if (!activeMarkdownHasExactLine(source, line)) {
			errors.push(`${documentName}: missing exact policy line ${line}`);
		}
	}
	const deltaTable = parseExactMarkdownTable(source, {
		columns: REVIEWED_DELTA_COLUMNS,
		documentName,
		missingName: "D0-D3 status table",
		tableName: "D0-D3 status table",
	});
	const deltaRows = collectUniqueRows(deltaTable, documentName, "delta", errors);
	validateExactTupleRows({
		documentName,
		tableName: "delta",
		rows: deltaRows,
		expected: EXPECTED_REVIEWED_DELTAS,
		valueOffset: 1,
		errors,
	});

	const summaryTable = parseExactMarkdownTable(source, {
		columns: REVIEWED_DELTA_SUMMARY_COLUMNS,
		documentName,
		missingName: "closure summary",
		tableName: "closure summary",
	});
	const summaryRows = collectUniqueRows(summaryTable, documentName, "summary key", errors);
	const expectedSummary = new Map([...EXPECTED_REVIEWED_DELTA_SUMMARY]
		.map(([key, value]) => [key, [value]]));
	validateExactTupleRows({
		documentName,
		tableName: "summary",
		rows: summaryRows,
		expected: expectedSummary,
		valueOffset: 1,
		errors,
	});

	const unresolvedTable = parseExactMarkdownTable(source, {
		columns: UNRESOLVED_CAPABILITY_COLUMNS,
		documentName,
		missingName: "unresolved capability table",
		tableName: "unresolved capability table",
	});
	const unresolvedRows = collectUniqueRows(
		unresolvedTable,
		documentName,
		"unresolved capability",
		errors,
	);
	validateExactTupleRows({
		documentName,
		tableName: "unresolved capability",
		rows: unresolvedRows,
		expected: EXPECTED_UNRESOLVED_CAPABILITIES,
		valueOffset: 1,
		errors,
	});

	const fieldValidationTable = parseExactMarkdownTable(source, {
		columns: FIELD_VALIDATION_COLUMNS,
		documentName,
		missingName: "positive Field Validation Pending table",
		tableName: "positive Field Validation Pending table",
	});
	const fieldValidationRows = collectUniqueRows(
		fieldValidationTable,
		documentName,
		"positive Field Validation Pending capability",
		errors,
	);
	const expectedFieldValidations = new Map(
		[...EXPECTED_POSITIVE_FIELD_VALIDATIONS]
			.map((capabilityId) => [
				capabilityId,
				["implemented", "Field Validation Pending (non-blocking)"],
			]),
	);
	validateExactTupleRows({
		documentName,
		tableName: "positive Field Validation Pending capability",
		rows: fieldValidationRows,
		expected: expectedFieldValidations,
		valueOffset: 1,
		errors,
	});

	const actualUnresolved = new Map();
	const actualPositiveFieldValidations = new Set();
	for (const [capabilityId, entry] of capabilityRows) {
		const state = entry.row.current_tauri;
		if (["missing", "partial", "blocked"].includes(state)) {
			actualUnresolved.set(capabilityId, [
				state,
				entry.row.parity_level,
				entry.row.convergence_mode,
				entry.row.blocked_by,
			]);
		}
		const verification = entry.row.verification;
		if (state === "implemented"
			&& verification.includes(CANONICAL_FIELD_VALIDATION_PENDING)) {
			actualPositiveFieldValidations.add(capabilityId);
			if (FIELD_VALIDATION_RESERVED_CLEARANCE_LANGUAGE.test(verification)) {
				errors.push(`capability-matrix: capability ${capabilityId} uses non-canonical Field Validation clearance language`);
			}
		}
	}
	validateExpectedTupleMap(
		"capability-matrix",
		"unresolved capability",
		actualUnresolved,
		EXPECTED_UNRESOLVED_CAPABILITIES,
		errors,
	);
	validateExpectedSet(
		"capability-matrix",
		"positive Field Validation Pending capability",
		actualPositiveFieldValidations,
		EXPECTED_POSITIVE_FIELD_VALIDATIONS,
		errors,
	);
	return errors;
}

function collectUniqueRows(parsed, documentName, rowName, errors) {
	errors.push(...parsed.errors);
	const rows = new Map();
	if (!parsed.found) return rows;
	for (const row of parsed.rows) {
		const key = row.cells[0];
		if (rows.has(key)) {
			errors.push(`${documentName}: ${rowName} line ${row.line} duplicates ${key} from line ${rows.get(key).line}`);
			continue;
		}
		rows.set(key, row);
	}
	return rows;
}

function validateExactTupleRows(options) {
	const {
		documentName,
		tableName,
		rows,
		expected,
		valueOffset,
		errors,
	} = options;
	if (rows.size !== expected.size) {
		errors.push(`${documentName}: expected exactly ${expected.size} ${tableName} rows; found ${rows.size}`);
	}
	for (const [key, expectedValues] of expected) {
		const row = rows.get(key);
		if (!row) {
			errors.push(`${documentName}: missing ${tableName} ${key}`);
			continue;
		}
		const actualValues = row.cells.slice(valueOffset);
		if (actualValues.length !== expectedValues.length
			|| actualValues.some((value, index) => value !== expectedValues[index])) {
			errors.push(`${documentName}: ${tableName} line ${row.line} ${key} tuple must be ${expectedValues.join(" / ")}; found ${actualValues.join(" / ")}`);
		}
	}
	for (const key of rows.keys()) {
		if (!expected.has(key)) {
			errors.push(`${documentName}: unexpected ${tableName} ${key}`);
		}
	}
}

function validateExpectedTupleMap(documentName, rowName, actual, expected, errors) {
	if (actual.size !== expected.size) {
		errors.push(`${documentName}: expected exactly ${expected.size} ${rowName} rows; found ${actual.size}`);
	}
	for (const [key, expectedValues] of expected) {
		const actualValues = actual.get(key);
		if (!actualValues) {
			errors.push(`${documentName}: missing ${rowName} ${key}`);
			continue;
		}
		if (actualValues.some((value, index) => value !== expectedValues[index])) {
			errors.push(`${documentName}: ${rowName} ${key} tuple must be ${expectedValues.join(" / ")}; found ${actualValues.join(" / ")}`);
		}
	}
	for (const key of actual.keys()) {
		if (!expected.has(key)) errors.push(`${documentName}: unexpected ${rowName} ${key}`);
	}
}

function validateExpectedSet(documentName, rowName, actual, expected, errors) {
	if (actual.size !== expected.size) {
		errors.push(`${documentName}: expected exactly ${expected.size} ${rowName} rows; found ${actual.size}`);
	}
	for (const key of expected) {
		if (!actual.has(key)) errors.push(`${documentName}: missing ${rowName} ${key}`);
	}
	for (const key of actual) {
		if (!expected.has(key)) errors.push(`${documentName}: unexpected ${rowName} ${key}`);
	}
}

function activeMarkdownContains(source, marker) {
	if (typeof source !== "string") return false;
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	return lines.some((line, index) => activeLines[index] && line.includes(marker));
}

function activeMarkdownHasExactLine(source, expectedLine) {
	if (typeof source !== "string") return false;
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	return lines.some((line, index) =>
		activeLines[index] && line.trim() === expectedLine);
}

function validateD0SourceMap(source) {
	const documentName = "upstream-source-map";
	const parsed = parseExactMarkdownTable(source, {
		columns: D0_SOURCE_MAP_COLUMNS,
		documentName,
		missingName: "D0 delta map",
		tableName: "D0 delta map",
	});
	if (!parsed.found) return parsed.errors;
	const errors = [...parsed.errors];
	const rows = new Map();
	for (const parsedRow of parsed.rows) {
		const deltaId = parsedRow.cells[0];
		if (rows.has(deltaId)) {
			errors.push(`${documentName}: D0 delta line ${parsedRow.line} duplicates ${deltaId} from line ${rows.get(deltaId).line}`);
			continue;
		}
		rows.set(deltaId, {
			line: parsedRow.line,
			state: parsedRow.cells[1],
			mode: parsedRow.cells[2],
		});
	}
	for (const [deltaId, expected] of D0_SOURCE_MAP_DELTAS) {
		const row = rows.get(deltaId);
		if (!row) {
			errors.push(`${documentName}: missing D0 delta ${deltaId}`);
			continue;
		}
		if (row.state !== expected[0] || row.mode !== expected[1]) {
			errors.push(`${documentName}: D0 delta line ${row.line} ${deltaId} tuple must be ${expected.join(" / ")}; found ${row.state} / ${row.mode}`);
		}
	}
	return errors;
}

function parseExactMarkdownTable(source, options) {
	const {
		columns,
		documentName,
		missingName,
		tableName,
	} = options;
	if (typeof source !== "string") {
		return {
			errors: [`${documentName}: missing ${missingName}`],
			found: false,
			rows: [],
		};
	}
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	const headerIndexes = [];
	for (let index = 0; index < lines.length; index += 1) {
		const cells = parseMarkdownTableRow(lines[index]);
		if (activeLines[index]
			&& cells?.length === columns.length
			&& cells.every((cell, cellIndex) =>
				cell === columns[cellIndex])) {
			headerIndexes.push(index);
		}
	}
	if (headerIndexes.length === 0) {
		return {
			errors: [`${documentName}: missing ${missingName}`],
			found: false,
			rows: [],
		};
	}
	const errors = [];
	if (headerIndexes.length > 1) {
		errors.push(`${documentName}: duplicate ${tableName} headers at lines ${headerIndexes.map((index) => index + 1).join(", ")}`);
	}
	const headerIndex = headerIndexes[0];
	const delimiter = parseMarkdownTableRow(lines[headerIndex + 1] || "");
	if (!delimiter
		|| delimiter.length !== columns.length
		|| !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
		errors.push(`${documentName}: ${tableName} delimiter line ${headerIndex + 2} is malformed`);
	}
	const rows = [];
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const cells = parseMarkdownTableRow(lines[index]);
		if (!cells) break;
		if (cells.length !== columns.length) {
			errors.push(`${documentName}: ${tableName} line ${index + 1} has ${cells.length} columns; expected ${columns.length}`);
			continue;
		}
		rows.push({ cells, line: index + 1 });
	}
	return { errors, found: true, rows };
}

function validateUpstreamReleaseProvenance(source) {
	const documentName = "upstream-source-map";
	const parsed = parseExactMarkdownTable(source, {
		columns: UPSTREAM_PROVENANCE_COLUMNS,
		documentName,
		missingName: "release provenance",
		tableName: "release provenance",
	});
	if (!parsed.found) return parsed.errors;
	const errors = [...parsed.errors];
	const rows = new Map();
	for (const parsedRow of parsed.rows) {
		const role = parsedRow.cells[0];
		if (rows.has(role)) {
			errors.push(`${documentName}: release provenance line ${parsedRow.line} duplicates role "${role}" from line ${rows.get(role).line}`);
			continue;
		}
		rows.set(role, {
			line: parsedRow.line,
			values: Object.fromEntries(UPSTREAM_PROVENANCE_COLUMNS
				.slice(1)
				.map((field, cellIndex) => [field, parsedRow.cells[cellIndex + 1]])),
		});
	}
	for (const [role, expectedValues] of Object.entries(EXPECTED_UPSTREAM_PROVENANCE)) {
		const row = rows.get(role);
		if (!row) {
			errors.push(`${documentName}: missing release provenance role ${role}`);
			continue;
		}
		for (const [field, expected] of Object.entries(expectedValues)) {
			if (row.values[field] !== expected) {
				errors.push(`${documentName}: release provenance line ${row.line} role ${role} field ${field} must be ${expected}; received ${row.values[field]}`);
			}
		}
	}
	return errors;
}

function validateActiveUpstreamIdentity(source, documentName) {
	const parsed = parseExactMarkdownTable(source, {
		columns: ACTIVE_UPSTREAM_IDENTITY_COLUMNS,
		documentName,
		missingName: "active upstream identity",
		tableName: "upstream identity",
	});
	if (!parsed.found) return parsed.errors;
	const errors = [...parsed.errors];
	const activeRows = [];
	for (const row of parsed.rows) {
		if (row.cells[0] === "active") activeRows.push(row);
		else errors.push(`${documentName}: upstream identity line ${row.line} has unsupported baseline_role "${row.cells[0]}"`);
	}
	if (activeRows.length === 0) {
		errors.push(`${documentName}: missing active upstream identity`);
		return errors;
	}
	if (activeRows.length > 1) {
		errors.push(`${documentName}: duplicate active upstream identity rows at lines ${activeRows.map((row) => row.line).join(", ")}`);
	}
	const activeRow = activeRows[0];
	const identity = Object.fromEntries(ACTIVE_UPSTREAM_IDENTITY_COLUMNS
		.slice(1)
		.map((field, index) => [field, activeRow.cells[index + 1]]));
	for (const [field, expected] of Object.entries(ACTIVE_UPSTREAM_IDENTITY)) {
		if (identity[field] !== expected) {
			errors.push(`${documentName}: active upstream identity line ${activeRow.line} field ${field} must be ${expected}; received ${identity[field]}`);
		}
	}
	return errors;
}

function inspectCapabilityMatrix(source) {
	const emptyRows = () => new Map();
	if (typeof source !== "string") {
		return { errors: ["capability-matrix: missing required header"], rows: emptyRows() };
	}
	const lines = source.split(/\r?\n/);
	const activeLines = identifyActiveMarkdownLines(lines);
	const headerIndexes = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (activeLines[index]
			&& parseMarkdownTableRow(lines[index])?.[0] === "capability_id") {
			headerIndexes.push(index);
		}
	}
	if (headerIndexes.length === 0) {
		return { errors: ["capability-matrix: missing required header"], rows: emptyRows() };
	}
	const errors = [];
	if (headerIndexes.length > 1) {
		errors.push(`capability-matrix: duplicate capability headers at lines ${headerIndexes.map((index) => index + 1).join(", ")}`);
	}
	const headerIndex = headerIndexes[0];
	const columns = parseMarkdownTableRow(lines[headerIndex]);
	if (columns.length !== 14) {
		return {
			errors: [...errors, `capability-matrix: header line ${headerIndex + 1} has ${columns.length} columns; expected 14`],
			rows: emptyRows(),
		};
	}
	const expectedColumns = parseMarkdownTableRow(CAPABILITY_HEADER);
	const supportedHeader = expectedColumns.every((column, index) =>
		column === columns[index]);
	if (!supportedHeader) {
		return {
			errors: [...errors, `capability-matrix: header line ${headerIndex + 1} has unsupported columns`],
			rows: emptyRows(),
		};
	}
	const capabilityIndex = columns.indexOf("capability_id");
	const delimiterIndex = headerIndex + 1;
	const delimiter = parseMarkdownTableRow(lines[delimiterIndex] || "");
	if (!delimiter) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} is missing or malformed`);
	} else if (delimiter.length !== columns.length) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} has ${delimiter.length} columns; expected ${columns.length}`);
	} else if (!delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
		errors.push(`capability-matrix: delimiter line ${delimiterIndex + 1} is malformed`);
	}
	const capabilityLines = new Map();
	const capabilityRows = new Map();
	const updaterRows = [];
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const line = lines[index];
		const cells = parseMarkdownTableRow(line);
		if (!cells) {
			if (line.includes("|")) {
				errors.push(`capability-matrix: line ${index + 1} is malformed`);
			}
			break;
		}
		if (cells.length !== columns.length) {
			const capability = cells[capabilityIndex] || "<empty>";
			errors.push(`capability-matrix: line ${index + 1} capability "${capability}" has ${cells.length} columns; expected ${columns.length}`);
			continue;
		}
		const row = Object.fromEntries(columns.map((column, cellIndex) =>
			[column, cells[cellIndex]]));
		if (row.domain === "updater" || row.capability_id.startsWith("updater.")) {
			updaterRows.push({ line: index + 1, row });
		}
		if (!row.capability_id) {
			errors.push(`capability-matrix: line ${index + 1} has empty capability_id`);
			continue;
		}
		for (const [column, allowedValues] of Object.entries(CAPABILITY_ENUMS)) {
			if (!allowedValues.has(row[column])) {
				errors.push(`capability-matrix: line ${index + 1} capability "${row.capability_id}" column ${column} has invalid value "${row[column] || "<empty>"}"`);
			}
		}
		if (row.current_tauri === "blocked"
			&& (!row.blocked_by || row.blocked_by.trim().toLowerCase() === "none")) {
			errors.push(`capability-matrix: line ${index + 1} capability "${row.capability_id}" column blocked_by must name a blocker for blocked state`);
		}
		const firstLine = capabilityLines.get(row.capability_id);
		if (firstLine) {
			errors.push(`capability-matrix: line ${index + 1} capability "${row.capability_id}" duplicates line ${firstLine}`);
		} else {
			capabilityLines.set(row.capability_id, index + 1);
			capabilityRows.set(row.capability_id, { line: index + 1, row });
		}
	}
	if (updaterRows.length !== 1) {
		const locations = updaterRows.length > 0
			? ` at lines ${updaterRows.map((entry) => entry.line).join(", ")}`
			: "";
		errors.push(`capability-matrix: expected exactly one updater authority; found ${updaterRows.length}${locations}`);
	} else {
		const updater = updaterRows[0];
		const authorityMatches = UPDATER_AUTHORITY_FIELDS.every((field) =>
			updater.row[field] === EXPECTED_UPDATER_AUTHORITY[field]);
		if (!authorityMatches) {
			const expected = UPDATER_AUTHORITY_FIELDS
				.map((field) => EXPECTED_UPDATER_AUTHORITY[field])
				.join(" / ");
			const actual = UPDATER_AUTHORITY_FIELDS
				.map((field) => updater.row[field])
				.join(" / ");
			errors.push(`capability-matrix: line ${updater.line} updater authority must be ${expected}; found ${actual}`);
		}
	}
	for (const [capabilityId, expectedValues] of D0_INVENTORY_CAPABILITIES) {
		const inventory = capabilityRows.get(capabilityId);
		if (!inventory) {
			errors.push(`capability-matrix: missing D0 inventory capability ${capabilityId}`);
			continue;
		}
		const actualValues = D0_INVENTORY_FIELDS.map((field) => inventory.row[field]);
		if (actualValues.some((value, index) => value !== expectedValues[index])) {
			errors.push(`capability-matrix: line ${inventory.line} capability "${capabilityId}" D0 tuple must be ${expectedValues.join(" / ")}; found ${actualValues.join(" / ")}`);
		}
	}
	return { errors, rows: capabilityRows };
}

function identifyActiveMarkdownLines(lines) {
	const active = [];
	let fence = null;
	let htmlComment = false;
	for (const line of lines) {
		const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			active.push(false);
			if (match && match[1][0] === fence.character && match[1].length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (htmlComment) {
			active.push(false);
			if (line.includes("-->")) htmlComment = false;
			continue;
		}
		if (match) {
			fence = { character: match[1][0], length: match[1].length };
			active.push(false);
			continue;
		}
		const commentStart = line.indexOf("<!--");
		if (commentStart >= 0) {
			htmlComment = line.indexOf("-->", commentStart + 4) < 0;
			active.push(false);
			continue;
		}
		active.push(true);
	}
	return active;
}

function parseMarkdownTableRow(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
	const cells = [];
	let current = "";
	for (let index = 1; index < trimmed.length - 1; index += 1) {
		const character = trimmed[index];
		if (character === "\\" && trimmed[index + 1] === "|") {
			current += "|";
			index += 1;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	cells.push(current.trim());
	return cells;
}

export function extractTopLevelSymbols(source) {
	const symbols = new Set();
	const declaration = /^(?:export\s+)?(?:const|type|interface|function)\s+([A-Za-z_$][\w$]*)/gm;
	for (const match of source.matchAll(declaration)) {
		symbols.add(match[1]);
	}
	return [...symbols];
}

export async function runConvergenceBaselineCli(repositoryRoot) {
	const paths = {
		capabilityMatrix: "docs/parity/capability-matrix.md",
		upstreamSourceMap: "docs/parity/upstream-source-map.md",
		appExtractionMap: "docs/parity/app-extraction-map.md",
		apiFreeze: "docs/parity/api-freeze.md",
		sonicWorkshopProvenance: "docs/parity/sonic-workshop-provenance.md",
		sonicWorkshopModuleDesign: "docs/parity/sonic-workshop-module-design.md",
		reviewedDeltaStatus: "docs/parity/reviewed-delta-status.md",
	};
	const documents = {};
	for (const [key, relativePath] of Object.entries(paths)) {
		documents[key] = await readFile(resolve(repositoryRoot, relativePath), "utf8");
	}
	documents.appSource = await readFile(resolve(repositoryRoot, "apps/web/src/app/App.tsx"), "utf8");
	const errors = validateConvergenceBaseline(documents);
	if (errors.length > 0) return { errors, paths: Object.values(paths) };
	return { errors: [], paths: Object.values(paths) };
}
