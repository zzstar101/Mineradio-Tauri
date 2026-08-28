import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DesktopCacheCategory,
	DesktopCacheSnapshot,
	DesktopCloseBehavior,
	DesktopJsonValue,
	DesktopRuntimePort,
	DesktopWindowRuntimeState,
} from "../../ports/desktop-runtime-port";
import {
	composeDesktopDiagnostics,
	type DesktopDiagnosticsComposition,
	type DesktopVisualPerformanceReader,
} from "./desktop-diagnostics";
import {
	createDesktopRequestGuard,
	runLatestDesktopRequest,
} from "./desktop-request-guard";

export const CLOSE_BEHAVIOR_STORE_KEY = "mineradio-tauri-close-behavior-v1";

export interface DesktopManagementRuntimeResult {
	closeBehavior: DesktopCloseBehavior;
	windowRuntime: DesktopWindowRuntimeState | null;
	cache: DesktopCacheSnapshot | null;
	diagnostics: DesktopDiagnosticsComposition | null;
	workingSetAction: DesktopWorkingSetActionState;
	busy: boolean;
	error: string | null;
	setCloseBehavior(behavior: DesktopCloseBehavior): Promise<void>;
	refreshCache(): Promise<void>;
	refreshDiagnostics(): Promise<void>;
	trimApplicationWorkingSet(): Promise<void>;
	chooseCacheRoot(): Promise<void>;
	resetCacheRoot(): Promise<void>;
	clearCacheCategory(category: DesktopCacheCategory): Promise<void>;
}

export interface DesktopManagementRuntimeOptions {
	getVisualPerformanceSnapshot?: DesktopVisualPerformanceReader;
}

export type DesktopWorkingSetActionPhase = "idle" | "running" | "completed" | "skipped" | "failed" | "unavailable";

export interface DesktopWorkingSetActionState {
	phase: DesktopWorkingSetActionPhase;
	message: string;
	reclaimedBytes: number | null;
}

const IDLE_WORKING_SET_ACTION: DesktopWorkingSetActionState = {
	phase: "idle",
	message: "尚未手动整理",
	reclaimedBytes: null,
};

function jsonRecord(value: DesktopJsonValue | undefined): Record<string, DesktopJsonValue> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, DesktopJsonValue>
		: null;
}

function jsonNumber(value: DesktopJsonValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeTrimSkipReason(value: DesktopJsonValue | undefined): string {
	const reason = jsonRecord(value);
	const kind = typeof reason?.kind === "string" ? reason.kind : "unknown";
	if (kind === "foreground") return "窗口位于前台，未整理工作集";
	if (kind === "visible") return "窗口仍可见，未整理工作集";
	if (kind === "backgroundDelay") return "进入后台时间不足，稍后再试";
	if (kind === "cooldown") return "整理仍在冷却期内";
	if (kind === "inFlight") return "已有整理任务正在运行";
	if (kind === "unsupported") return "当前平台不支持工作集整理";
	if (kind === "disabled") return "工作集整理已禁用";
	return "本次工作集整理被运行时跳过";
}

export function describeWorkingSetTrimResult(value: DesktopJsonValue | null): DesktopWorkingSetActionState {
	const result = jsonRecord(value ?? undefined);
	if (!result) {
		return {
			phase: "unavailable",
			message: "当前运行环境未提供工作集整理",
			reclaimedBytes: null,
		};
	}
	const status = typeof result.status === "string" ? result.status : "";
	if (status === "completed") {
		const reclaimedBytes = jsonNumber(result.reclaimedWorkingSetBytes) ?? 0;
		return {
			phase: "completed",
			message: reclaimedBytes > 0 ? "应用工作集已整理" : "工作集已检查，无可释放内存",
			reclaimedBytes,
		};
	}
	if (status === "skipped") {
		return {
			phase: "skipped",
			message: describeTrimSkipReason(result.reason),
			reclaimedBytes: null,
		};
	}
	if (status === "failed") {
		const error = jsonRecord(result.error);
		return {
			phase: "failed",
			message: typeof error?.message === "string" ? error.message : "工作集整理失败",
			reclaimedBytes: null,
		};
	}
	return {
		phase: "unavailable",
		message: "运行时返回了无法识别的整理结果",
		reclaimedBytes: null,
	};
}

export function normalizeCloseBehavior(value: unknown): DesktopCloseBehavior {
	return value === "tray" ? "tray" : "exit";
}

export function loadCloseBehavior(storage: Pick<Storage, "getItem"> | null | undefined): DesktopCloseBehavior {
	return readLegacyCloseBehavior(storage) ?? "exit";
}

export function readLegacyCloseBehavior(
	storage: Pick<Storage, "getItem"> | null | undefined,
): DesktopCloseBehavior | null {
	if (!storage) return null;
	try {
		const value = storage.getItem(CLOSE_BEHAVIOR_STORE_KEY);
		return value === "exit" || value === "tray" ? value : null;
	} catch {
		return null;
	}
}

export function saveCloseBehavior(
	storage: Pick<Storage, "setItem"> | null | undefined,
	behavior: DesktopCloseBehavior,
): void {
	if (!storage) return;
	try {
		storage.setItem(CLOSE_BEHAVIOR_STORE_KEY, behavior);
	} catch {
	}
}

export function clearLegacyCloseBehavior(
	storage: Pick<Storage, "removeItem"> | null | undefined,
): void {
	if (!storage) return;
	try {
		storage.removeItem(CLOSE_BEHAVIOR_STORE_KEY);
	} catch {
	}
}

export function useDesktopManagementRuntime(
	desktop: DesktopRuntimePort,
	options: DesktopManagementRuntimeOptions = {},
): DesktopManagementRuntimeResult {
	const [closeBehavior, setCloseBehaviorState] = useState<DesktopCloseBehavior>("exit");
	const [windowRuntime, setWindowRuntime] = useState<DesktopWindowRuntimeState | null>(null);
	const [cache, setCache] = useState<DesktopCacheSnapshot | null>(null);
	const [diagnostics, setDiagnostics] = useState<DesktopDiagnosticsComposition | null>(null);
	const [workingSetAction, setWorkingSetAction] = useState<DesktopWorkingSetActionState>(IDLE_WORKING_SET_ACTION);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const closeBehaviorRequestGuardRef = useRef(createDesktopRequestGuard());
	const closeBehaviorMutationRef = useRef<Promise<void>>(Promise.resolve());
	const cacheRequestGuardRef = useRef(createDesktopRequestGuard());
	const diagnosticsRequestGuardRef = useRef(createDesktopRequestGuard());
	const visualPerformanceReaderRef = useRef(options.getVisualPerformanceSnapshot);
	visualPerformanceReaderRef.current = options.getVisualPerformanceSnapshot;

	useEffect(() => {
		closeBehaviorRequestGuardRef.current.dispose();
		cacheRequestGuardRef.current.dispose();
		diagnosticsRequestGuardRef.current.dispose();
		const closeBehaviorGuard = createDesktopRequestGuard();
		const cacheGuard = createDesktopRequestGuard();
		const diagnosticsGuard = createDesktopRequestGuard();
		closeBehaviorRequestGuardRef.current = closeBehaviorGuard;
		closeBehaviorMutationRef.current = Promise.resolve();
		cacheRequestGuardRef.current = cacheGuard;
		diagnosticsRequestGuardRef.current = diagnosticsGuard;
		return () => {
			closeBehaviorGuard.dispose();
			cacheGuard.dispose();
			diagnosticsGuard.dispose();
		};
	}, [desktop]);

	const enqueueCloseBehaviorMutation = useCallback((behavior: DesktopCloseBehavior) => {
		const request = closeBehaviorMutationRef.current
			.catch(() => undefined)
			.then(() => desktop.setCloseBehavior(behavior));
		closeBehaviorMutationRef.current = request.then(
			() => undefined,
			() => undefined,
		);
		return request;
	}, [desktop]);

	const refreshCache = useCallback(async () => {
		if (typeof desktop.getCacheSnapshot !== "function") return;
		const guard = cacheRequestGuardRef.current;
		await runLatestDesktopRequest(
			guard,
			() => desktop.getCacheSnapshot(),
			(snapshot) => {
				setCache(snapshot);
				setError(null);
			},
			(cause) => setError(String(cause)),
		);
	}, [desktop]);

	const refreshDiagnostics = useCallback(async () => {
		const guard = diagnosticsRequestGuardRef.current;
		await runLatestDesktopRequest(
			guard,
			() => typeof desktop.getDesktopDiagnostics === "function"
				? desktop.getDesktopDiagnostics()
				: Promise.resolve(null),
			(native) => {
				setDiagnostics(composeDesktopDiagnostics(native, visualPerformanceReaderRef.current));
				setError(null);
			},
			(cause) => setError(String(cause)),
		);
	}, [desktop]);

	const applyCloseBehavior = useCallback(async (behavior: DesktopCloseBehavior) => {
		const storage = typeof localStorage === "undefined" ? null : localStorage;
		const guard = closeBehaviorRequestGuardRef.current;
		const generation = guard.begin();
		if (typeof desktop.setCloseBehavior !== "function") {
			if (guard.isCurrent(generation)) {
				setCloseBehaviorState(behavior);
				saveCloseBehavior(storage, behavior);
			}
			return;
		}
		setBusy(true);
		try {
			const next = await enqueueCloseBehaviorMutation(behavior);
			if (!guard.isCurrent(generation)) return;
			setWindowRuntime(next);
			setCloseBehaviorState(next?.lifecycle.closeBehavior ?? behavior);
			if (next) clearLegacyCloseBehavior(storage);
			else saveCloseBehavior(storage, behavior);
			setError(null);
		} catch (cause) {
			if (guard.isCurrent(generation)) setError(String(cause));
			throw cause;
		} finally {
			if (guard.isCurrent(generation)) setBusy(false);
		}
	}, [desktop, enqueueCloseBehaviorMutation]);

	useEffect(() => {
		if (typeof desktop.getWindowRuntimeState !== "function") {
			return;
		}
		const guard = closeBehaviorRequestGuardRef.current;
		const generation = guard.begin();
		const storage = typeof localStorage === "undefined" ? null : localStorage;
		const legacyBehavior = readLegacyCloseBehavior(storage);
		// 缓存与 raw diagnostics 都只能由显式用户动作触发，不能在普通启动时 probe。
		void desktop.getWindowRuntimeState()
			.then(async (runtime) => {
				if (!guard.isCurrent(generation)) return;
				let resolved = runtime;
				if (runtime && legacyBehavior && runtime.lifecycle.closeBehavior !== legacyBehavior) {
					resolved = await enqueueCloseBehaviorMutation(legacyBehavior);
				}
				if (!guard.isCurrent(generation)) return;
				if (resolved && legacyBehavior) clearLegacyCloseBehavior(storage);
				setWindowRuntime(resolved);
				setCloseBehaviorState(resolved?.lifecycle.closeBehavior ?? legacyBehavior ?? "exit");
				setError(null);
			})
			.catch((cause) => {
				if (guard.isCurrent(generation)) setError(String(cause));
			});
	}, [desktop, enqueueCloseBehaviorMutation]);

	const chooseCacheRoot = useCallback(async () => {
		if (typeof desktop.chooseCacheDirectory !== "function" || typeof desktop.setCacheRoot !== "function") return;
		setBusy(true);
		try {
			const path = await desktop.chooseCacheDirectory();
			if (path) {
				await desktop.setCacheRoot(path);
				await refreshCache();
			}
		} catch (cause) {
			setError(String(cause));
		} finally {
			setBusy(false);
		}
	}, [desktop, refreshCache]);

	const resetCacheRoot = useCallback(async () => {
		if (typeof desktop.setCacheRoot !== "function") return;
		setBusy(true);
		try {
			await desktop.setCacheRoot(null);
			await refreshCache();
		} catch (cause) {
			setError(String(cause));
		} finally {
			setBusy(false);
		}
	}, [desktop, refreshCache]);

	const clearCache = useCallback(async (category: DesktopCacheCategory) => {
		if (typeof desktop.clearCacheCategory !== "function") return;
		setBusy(true);
		try {
			await desktop.clearCacheCategory(category);
			await refreshCache();
		} catch (cause) {
			setError(String(cause));
		} finally {
			setBusy(false);
		}
	}, [desktop, refreshCache]);

	const trimWorkingSet = useCallback(async () => {
		if (typeof desktop.trimApplicationWorkingSet !== "function") return;
		setBusy(true);
		setWorkingSetAction({ phase: "running", message: "正在整理应用工作集…", reclaimedBytes: null });
		try {
			const result = await desktop.trimApplicationWorkingSet(true);
			setWorkingSetAction(describeWorkingSetTrimResult(result));
		} catch (cause) {
			setError(String(cause));
			setWorkingSetAction({ phase: "failed", message: String(cause), reclaimedBytes: null });
		} finally {
			setBusy(false);
		}
	}, [desktop]);

	return {
		closeBehavior,
		windowRuntime,
		cache,
		diagnostics,
		workingSetAction,
		busy,
		error,
		setCloseBehavior: applyCloseBehavior,
		refreshCache,
		refreshDiagnostics,
		trimApplicationWorkingSet: trimWorkingSet,
		chooseCacheRoot,
		resetCacheRoot,
		clearCacheCategory: clearCache,
	};
}
