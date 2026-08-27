import type {
	DesktopCacheCategory,
	DesktopDiagnosticsSnapshot,
	DesktopJsonValue,
} from "../../ports/desktop-runtime-port";
import type { DesktopManagementRuntimeResult } from "./useDesktopManagementRuntime";

const CACHE_CATEGORIES: Array<{ category: DesktopCacheCategory; label: string }> = [
	{ category: "audio", label: "音频" },
	{ category: "images", label: "图片" },
	{ category: "lyrics", label: "歌词" },
	{ category: "beatmaps", label: "节拍" },
	{ category: "temp", label: "临时" },
];

/** 桌面运行时控件与设置搜索共用的唯一文案目录。 */
export const DESKTOP_RUNTIME_CONTROL_DEFINITIONS = Object.freeze({
	sections: Object.freeze({
		runtime: "桌面运行时",
		cache: "缓存治理",
		resources: "资源治理",
		nativeDiagnostics: "Native 诊断",
		visualDiagnostics: "Visual 诊断",
	}),
	closeBehavior: Object.freeze({
		label: "关闭窗口行为",
		exit: "直接退出",
		tray: "后台托盘",
	}),
	cache: Object.freeze({
		categoriesLabel: "缓存分类使用量",
		configuredRoot: "配置目录",
		activeRoot: "活动目录",
		refresh: "刷新使用量",
		chooseRoot: "选择目录",
		resetRoot: "默认目录",
		clearPrefix: "清理",
	}),
	resources: Object.freeze({ trimWorkingSet: "整理应用工作集" }),
	nativeFacts: Object.freeze([
		"生命周期",
		"托盘",
		"主窗口",
		"进程内存",
		"桌面歌词",
	]),
	visualFacts: Object.freeze([
		"渲染状态",
		"帧耗时 P95",
		"GPU 资源",
		"后台任务",
	]),
	refreshDiagnostics: "刷新诊断",
});

export const DESKTOP_RUNTIME_SETTINGS_SEARCH_TERMS = Object.freeze([
	...Object.values(DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections),
	...Object.values(DESKTOP_RUNTIME_CONTROL_DEFINITIONS.closeBehavior),
	...Object.values(DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache),
	...CACHE_CATEGORIES.flatMap(({ label }) => [
		label,
		`${DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.clearPrefix}${label}`,
	]),
	...Object.values(DESKTOP_RUNTIME_CONTROL_DEFINITIONS.resources),
	...DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts,
	...DESKTOP_RUNTIME_CONTROL_DEFINITIONS.visualFacts,
	DESKTOP_RUNTIME_CONTROL_DEFINITIONS.refreshDiagnostics,
]);

type JsonRecord = Record<string, DesktopJsonValue>;

function asRecord(value: DesktopJsonValue | null | undefined): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonRecord
		: null;
}

function recordString(record: JsonRecord | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
}

function recordNumber(record: JsonRecord | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function diagnosticProbeValue(
	diagnostics: DesktopDiagnosticsSnapshot | null,
	kind: string,
): JsonRecord | null {
	const probe = diagnostics?.probes.find((candidate) => candidate.kind === kind);
	return probe?.status === "healthy" ? asRecord(probe.value) : null;
}

export function formatDesktopBytes(value: number): string {
	const bytes = Math.max(0, Number.isFinite(value) ? value : 0);
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDiagnosticCount(diagnostics: DesktopDiagnosticsSnapshot | null): string {
	if (!diagnostics) return "等待采样";
	const healthy = diagnostics.probes.filter((probe) => probe.status === "healthy").length;
	return `${healthy}/${diagnostics.probes.length} probes · ${diagnostics.recentErrors.length} errors`;
}

export function DesktopRuntimeControls(props: DesktopManagementRuntimeResult) {
	const nativeDiagnostics = props.diagnostics?.native ?? null;
	const visualDiagnostics = props.diagnostics?.visual ?? null;
	const windowProbe = diagnosticProbeValue(nativeDiagnostics, "window");
	const trayProbe = diagnosticProbeValue(nativeDiagnostics, "tray");
	const lifecycleProbe = asRecord(trayProbe?.lifecycle);
	const nativeMemoryProbe = diagnosticProbeValue(nativeDiagnostics, "native");
	const desktopLyricsProbe = diagnosticProbeValue(nativeDiagnostics, "desktopLyrics");
	const workingSetBytes = recordNumber(nativeMemoryProbe, "workingSetBytes");
	const privateBytes = recordNumber(nativeMemoryProbe, "privateBytes");
	const cache = props.cache;

	return (
		<div className="desktop-runtime-controls" data-busy={props.busy ? "true" : "false"}>
			<div className="fx-section-label">{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections.runtime}</div>
			<div className="fx-seg" role="group" aria-label={DESKTOP_RUNTIME_CONTROL_DEFINITIONS.closeBehavior.label}>
				<button
					type="button"
					className={props.closeBehavior === "exit" ? "active" : ""}
					onClick={() => void props.setCloseBehavior("exit")}
					disabled={props.busy}
				>
					{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.closeBehavior.exit}
				</button>
				<button
					type="button"
					className={props.closeBehavior === "tray" ? "active" : ""}
					onClick={() => void props.setCloseBehavior("tray")}
					disabled={props.busy}
				>
					{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.closeBehavior.tray}
				</button>
			</div>

			<div className="fx-section-label">{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections.cache}</div>
			<div className="fx-runtime-summary">
				<strong>{formatDesktopBytes(cache?.totalBytes ?? 0)}</strong>
				<small>{cache ? `${cache.fileCount} 个文件` : "等待扫描"}</small>
			</div>
			<div className="fx-runtime-path">
				<span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.configuredRoot}</span>
				<code title={cache?.configuredRoot ?? ""}>{cache?.configuredRoot || "未载入"}</code>
			</div>
			<div className="fx-runtime-path">
				<span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.activeRoot}</span>
				<code title={cache?.activeRoot ?? ""}>{cache?.activeRoot || "未载入"}</code>
			</div>
			{cache?.restartRequired ? <div className="fx-runtime-warning">缓存目录将在重启后切换。</div> : null}
			<div className="fx-runtime-cache-list" aria-label={DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.categoriesLabel}>
				{CACHE_CATEGORIES.map(({ category, label }) => {
					const usage = cache?.categories.find((entry) => entry.category === category);
					return (
						<div key={category} className="fx-runtime-cache-row">
							<span>{label}</span>
							<strong>{formatDesktopBytes(usage?.totalBytes ?? 0)}</strong>
							<small>{usage ? `${usage.fileCount} 文件${usage.errorCount ? ` · ${usage.errorCount} 错误` : ""}${usage.truncated ? " · 已截断" : ""}` : "未扫描"}</small>
						</div>
					);
				})}
			</div>
			<div className="fx-runtime-actions">
				<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.refreshCache()}>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.refresh}</button>
				<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.chooseCacheRoot()}>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.chooseRoot}</button>
				<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.resetCacheRoot()}>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.resetRoot}</button>
			</div>
			<div className="fx-runtime-actions">
				{CACHE_CATEGORIES.map(({ category, label }) => (
					<button
						key={category}
						type="button"
						className="fx-mini-btn ghost"
						disabled={props.busy}
						onClick={() => void props.clearCacheCategory(category)}
					>
						{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.cache.clearPrefix}{label}
					</button>
				))}
			</div>

			<div className="fx-section-label">{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections.resources}</div>
			<div className="fx-runtime-actions">
				<button
					type="button"
					className="fx-mini-btn fx-runtime-primary-action"
					disabled={props.busy || props.workingSetAction.phase === "running"}
					onClick={() => void props.trimApplicationWorkingSet()}
				>
					{props.workingSetAction.phase === "running" ? "正在整理…" : DESKTOP_RUNTIME_CONTROL_DEFINITIONS.resources.trimWorkingSet}
				</button>
			</div>
			<div
				className="fx-runtime-status"
				data-state={props.workingSetAction.phase}
				role="status"
				aria-live="polite"
			>
				{props.workingSetAction.message}
				{props.workingSetAction.reclaimedBytes !== null
					? ` · 释放 ${formatDesktopBytes(props.workingSetAction.reclaimedBytes)}`
					: ""}
			</div>

			<div className="fx-section-label">{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections.nativeDiagnostics}</div>
			<div className="fx-runtime-summary">
				<strong>{nativeDiagnostics?.health ?? "unavailable"}</strong>
				<small>{formatDiagnosticCount(nativeDiagnostics)}</small>
			</div>
			<div className="fx-runtime-diagnostic-grid">
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts[0]}</span><strong>{recordString(lifecycleProbe, "phase") ?? "—"}</strong><small>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts[1]} {recordString(trayProbe, "trayPhase") ?? "—"}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts[2]}</span><strong>{windowProbe?.isVisible === true ? "可见" : windowProbe?.isMinimized === true ? "最小化" : "后台"}</strong><small>{windowProbe?.isFocused === true ? "已聚焦" : "未聚焦"}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts[3]}</span><strong>{workingSetBytes === null ? "—" : formatDesktopBytes(workingSetBytes)}</strong><small>{privateBytes === null ? "private —" : `private ${formatDesktopBytes(privateBytes)}`}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.nativeFacts[4]}</span><strong>{desktopLyricsProbe?.inputWorkerRunning === true ? "输入监听中" : "监听未运行"}</strong><small>{desktopLyricsProbe?.hasPayload === true ? "payload ready" : "等待 payload"}</small></div>
			</div>

			<div className="fx-section-label">{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.sections.visualDiagnostics}</div>
			<div className="fx-runtime-summary">
				<strong>{visualDiagnostics?.resources.pressure ?? "unavailable"}</strong>
				<small>{visualDiagnostics ? `${visualDiagnostics.runtime.mode} · generation ${visualDiagnostics.runtime.generation}` : "等待 Visual Engine"}</small>
			</div>
			<div className="fx-runtime-diagnostic-grid">
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.visualFacts[0]}</span><strong>{visualDiagnostics?.runtime.mounted ? (visualDiagnostics.runtime.running ? "运行中" : "已挂载") : "未挂载"}</strong><small>{visualDiagnostics ? `${visualDiagnostics.frames.renders} renders` : "—"}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.visualFacts[1]}</span><strong>{visualDiagnostics ? `${visualDiagnostics.frames.frameCostP95Ms.toFixed(1)} ms` : "—"}</strong><small>{visualDiagnostics ? `${visualDiagnostics.frames.longFrames} long frames` : "—"}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.visualFacts[2]}</span><strong>{visualDiagnostics ? formatDesktopBytes(visualDiagnostics.resources.current.textureBytes + visualDiagnostics.resources.current.geometryBytes) : "—"}</strong><small>{visualDiagnostics ? `${visualDiagnostics.resources.current.meshCount} meshes` : "—"}</small></div>
				<div><span>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.visualFacts[3]}</span><strong>{visualDiagnostics ? visualDiagnostics.tasks.queued + visualDiagnostics.tasks.running : "—"}</strong><small>{visualDiagnostics ? `${visualDiagnostics.tasks.failed} failed · ${visualDiagnostics.tasks.staleResultsDropped} stale` : "—"}</small></div>
			</div>
			<div className="fx-runtime-actions">
				<button type="button" className="fx-mini-btn ghost" disabled={props.busy} onClick={() => void props.refreshDiagnostics()}>{DESKTOP_RUNTIME_CONTROL_DEFINITIONS.refreshDiagnostics}</button>
			</div>
			{cache?.fallbackUsed ? <div className="fx-runtime-warning">缓存目录不可用，当前使用安全回退目录。</div> : null}
			{props.diagnostics?.visualError ? <div className="fx-runtime-warning">Visual 诊断读取失败：{props.diagnostics.visualError}</div> : null}
			{props.error ? <div className="fx-runtime-warning">{props.error}</div> : null}
		</div>
	);
}
