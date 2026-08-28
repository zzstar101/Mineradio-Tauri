import type { DesktopCacheCategory } from "../../ports/desktop-runtime-port";
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
]);

export function formatDesktopBytes(value: number): string {
	const bytes = Math.max(0, Number.isFinite(value) ? value : 0);
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function DesktopRuntimeControls(props: DesktopManagementRuntimeResult) {
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

			{cache?.fallbackUsed ? <div className="fx-runtime-warning">缓存目录不可用，当前使用安全回退目录。</div> : null}
			{props.error ? <div className="fx-runtime-warning">{props.error}</div> : null}
		</div>
	);
}
