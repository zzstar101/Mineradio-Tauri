import { useEffect, useRef } from "react";
import {
	savePlaybackSessionCheckpoint,
	type PlaybackSessionCheckpointSaveResult,
} from "../../adapters/tauri/tauri-playback-session";
import {
	usePlaybackStore,
	type PlaybackExitCheckpointV1,
} from "../../stores/playback-store";

/**
 * 上游 Mineradio v2.1 startup-resume 的 Web 持久化层。
 *
 * - 播放期间按 ≥2500ms 节流保存 last-playback 快照（对齐上游 saveLastPlaybackSnapshot
 *   throttle），并在 visibilitychange(hidden)/pagehide/beforeunload 时尽力 flush。
 * - envelope 包裹 frozen 的 `PlaybackExitCheckpointV1`：`autoplayOnStartup` 等启动期
 *   旗标只落在 wrapper 上，绝不改动 checkpoint schema 本身。
 * - 更新静默事务持有 owner lease 时（`hasActiveQuiescenceOperation`）完全暂停捕获，
 *   checkpoint 所有权归 quiescence authority。
 * - 启动恢复由 `applyStartupPlaybackSessionPayload` 在 React 首帧前执行（main.tsx
 *   bootstrap，先于 App 内本地库 hydration 合并队列状态）。
 */
export const PLAYBACK_SESSION_PERSIST_SCHEMA =
	"playback-session-persist-v1" as const;
export const PLAYBACK_SESSION_CAPTURE_MIN_INTERVAL_MS = 2_500;

export interface PlaybackSessionPersistEnvelopeV1 {
	readonly schema: typeof PLAYBACK_SESSION_PERSIST_SCHEMA;
	readonly savedAtMs: number;
	readonly autoplayOnStartup: boolean;
	readonly checkpoint: PlaybackExitCheckpointV1;
}

const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{32}$/u;

export interface SessionCheckpointCaptureDecisionInput {
	readonly lastSavedAtMs: number | null;
	readonly nowMs: number;
	readonly isPlaying: boolean;
	readonly positionChangedSinceLastSave: boolean;
	readonly hasCurrentTrack: boolean;
	/** 只读所有权信号：更新静默事务活跃时跳过全部捕获。 */
	readonly updaterQuiescenceOwnsCheckpoint: boolean;
	/** visibilitychange(hidden)/pagehide/beforeunload 触发的立即 best-effort 捕获。 */
	readonly forceFlush?: boolean;
	readonly minIntervalMs?: number;
}

/** 纯节流决策：周期路径要求节流间隔 + （正在播放或位置前进）；flush 路径绕过节流。 */
export function shouldCaptureSessionCheckpoint(
	input: SessionCheckpointCaptureDecisionInput,
): boolean {
	const minIntervalMs =
		input.minIntervalMs ?? PLAYBACK_SESSION_CAPTURE_MIN_INTERVAL_MS;
	if (!input.hasCurrentTrack) return false;
	if (input.updaterQuiescenceOwnsCheckpoint) return false;
	if (input.forceFlush) {
		return input.lastSavedAtMs === null
			|| input.positionChangedSinceLastSave
			|| input.isPlaying;
	}
	const throttleOk = input.lastSavedAtMs === null
		|| input.nowMs - input.lastSavedAtMs >= minIntervalMs;
	return throttleOk && (input.isPlaying || input.positionChangedSinceLastSave);
}

function randomHex128(): string {
	const bytes = new Uint8Array(16);
	const crypto = globalThis.crypto;
	if (!crypto || typeof crypto.getRandomValues !== "function") {
		throw new Error("cryptographic randomness is unavailable");
	}
	crypto.getRandomValues(bytes);
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeNowMs(nowMs: number): boolean {
	return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

/**
 * 从 store 当前状态构建 session persist envelope。每次捕获使用全新
 * operationId/receipt 对；restore 时原样回传即可通过 store 校验。
 *
 * sourceKind 缺省 "remote"：provider 曲目跨重启可重新解析（远端或本地库协议 URL），
 * 与上游 last-playback restore 语义一致；仅存在于会话 blob URL 的曲目在下次启动会走
 * 常规媒体失败降级路径（toast），属可接受的 best-effort 行为。
 */
export function capturePlaybackSessionEnvelope(args: {
	nowMs: number;
	sourceKind?: "remote" | "blob" | "local" | "opaque";
	autoplayOnStartup?: boolean;
}): PlaybackSessionPersistEnvelopeV1 | null {
	if (!safeNowMs(args.nowMs)) return null;
	const state = usePlaybackStore.getState();
	let operationId: string;
	let receipt: string;
	try {
		operationId = randomHex128();
		receipt = randomHex128();
	} catch {
		return null;
	}
	const checkpoint = state.capturePlaybackExitCheckpoint({
		operationId,
		receipt,
		sourceKind: args.sourceKind ?? "remote",
	});
	if (!checkpoint) return null;
	return Object.freeze({
		schema: PLAYBACK_SESSION_PERSIST_SCHEMA,
		savedAtMs: args.nowMs,
		autoplayOnStartup: args.autoplayOnStartup ?? false,
		checkpoint,
	});
}

export type ValidatedPlaybackSessionPayload =
	| { readonly status: "valid"; readonly envelope: PlaybackSessionPersistEnvelopeV1 }
	| { readonly status: "invalid" };

/** 结构化校验 envelope；checkpoint 深度校验仍由 store.restorePlaybackExitCheckpoint 兜底。 */
export function validatedPlaybackSessionPayload(
	payload: unknown,
): ValidatedPlaybackSessionPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { status: "invalid" };
	}
	const record = payload as Record<string, unknown>;
	if (
		record.schema !== PLAYBACK_SESSION_PERSIST_SCHEMA
		|| !safeNowMs(record.savedAtMs as number)
		|| !(record.autoplayOnStartup === undefined
			|| typeof record.autoplayOnStartup === "boolean")
		|| !record.checkpoint
		|| typeof record.checkpoint !== "object"
	) {
		return { status: "invalid" };
	}
	const checkpoint = record.checkpoint as PlaybackExitCheckpointV1;
	if (
		!CHECKPOINT_ID_PATTERN.test(String(checkpoint.operationId))
		|| !CHECKPOINT_ID_PATTERN.test(String(checkpoint.receipt))
	) {
		return { status: "invalid" };
	}
	return {
		status: "valid",
		envelope: Object.freeze({
			schema: PLAYBACK_SESSION_PERSIST_SCHEMA,
			savedAtMs: record.savedAtMs as number,
			autoplayOnStartup: record.autoplayOnStartup ?? false,
			checkpoint,
		}),
	};
}

export interface StartupPlaybackSessionRestoreResult {
	readonly restored: boolean;
	/** envelope.autoplayOnStartup（缺省 false → 恢复 UI 但保持暂停）。 */
	readonly autoplayOnStartup: boolean;
}

/**
 * 启动恢复入口：把持久化 envelope 应用到 playback store。
 *
 * autoplay gating 对齐上游 startupAutoplayPreference/startupResumeSecondsFromSnapshot：
 * `autoplayOnStartup=false` 时把副本的 wasPlaying 归零后恢复——UI 显示曲目、队列与
 * 位置但保持暂停；true 时沿用 checkpoint.wasPlaying 走既有 consumeCheckpointAutoplay
 * 路径自动续播（positionRef>0 的 seek 由 usePlaybackSessionRuntime 完成）。
 */
export function applyStartupPlaybackSessionPayload(
	payload: unknown,
): StartupPlaybackSessionRestoreResult {
	const validated = validatedPlaybackSessionPayload(payload);
	if (validated.status !== "valid") return { restored: false, autoplayOnStartup: false };
	const { envelope } = validated;
	const gatedCheckpoint: PlaybackExitCheckpointV1 = envelope.autoplayOnStartup
		? envelope.checkpoint
		: Object.freeze({ ...envelope.checkpoint, wasPlaying: false });
	const result = usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		operationId: envelope.checkpoint.operationId,
		receipt: envelope.checkpoint.receipt,
		mode: "restart-reconciliation",
		checkpoint: gatedCheckpoint,
	});
	const restored = result === "restored" || result === "already-restored";
	if (!restored && result === "rejected") {
		console.warn("playback session checkpoint restore rejected; starting fresh");
	}
	return { restored, autoplayOnStartup: envelope.autoplayOnStartup };
}

export interface PlaybackSessionPersistenceRuntimeOptions {
	subscribeStore(listener: () => void): () => void;
	readSnapshot(): {
		isPlaying: boolean;
		positionMs: number;
		hasCurrentTrack: boolean;
	};
	isQuiescenceOwned(): boolean;
	capture(): unknown | null;
	save(envelope: unknown): Promise<PlaybackSessionCheckpointSaveResult>;
	now(): number;
	minIntervalMs?: number;
	onWarning?(message: string, detail?: unknown): void;
}

export interface PlaybackSessionPersistenceRuntime {
	attemptPeriodicCapture(): void;
	flushOnUnload(): void;
	dispose(): void;
}

/**
 * 无 React 依赖的捕获循环；React hook 只做 DOM/订阅接线。in-flight 去重保证同一时刻
 * 至多一个保存请求，节流簿记只在成功保存后推进。
 */
export function createPlaybackSessionPersistenceRuntime(
	options: PlaybackSessionPersistenceRuntimeOptions,
): PlaybackSessionPersistenceRuntime {
	const warn = options.onWarning
		?? ((message: string, detail?: unknown) => console.warn(message, detail));
	let disposed = false;
	let inFlight = false;
	let lastSavedAtMs: number | null = null;
	let lastSavedPositionMs = options.readSnapshot().positionMs;

	const attempt = (forceFlush: boolean): void => {
		if (disposed || inFlight) return;
		const snapshot = options.readSnapshot();
		const nowMs = options.now();
		const shouldCapture = shouldCaptureSessionCheckpoint({
			lastSavedAtMs,
			nowMs,
			isPlaying: snapshot.isPlaying,
			positionChangedSinceLastSave: snapshot.positionMs !== lastSavedPositionMs,
			hasCurrentTrack: snapshot.hasCurrentTrack,
			updaterQuiescenceOwnsCheckpoint: options.isQuiescenceOwned(),
			forceFlush,
			minIntervalMs: options.minIntervalMs,
		});
		if (!shouldCapture) return;
		inFlight = true;
		void (async () => {
			try {
				const envelope = options.capture();
				if (envelope === null) return;
				const result = await options.save(envelope);
				if (!result.ok) {
					warn("playback session checkpoint save rejected", result.reason);
					return;
				}
				lastSavedAtMs = options.now();
				lastSavedPositionMs = snapshot.positionMs;
			} catch (error) {
				warn("playback session checkpoint save failed", error);
			} finally {
				inFlight = false;
			}
		})();
	};

	const unsubscribe = options.subscribeStore(() => {
		if (!disposed) attempt(false);
	});

	return {
		attemptPeriodicCapture() {
			attempt(false);
		},
		flushOnUnload() {
			attempt(true);
		},
		dispose() {
			disposed = true;
			unsubscribe();
		},
	};
}

export interface PlaybackSessionPersistenceHookOptions {
	/** 只读所有权信号（来自 production quiescence adapter）；缺省视为无事务。 */
	hasActiveQuiescenceOperation?: () => boolean;
	save?: typeof savePlaybackSessionCheckpoint;
	minIntervalMs?: number;
	now?: () => number;
}

/** App 侧接线 hook：store 订阅 + hidden/pagehide/beforeunload flush。 */
export function usePlaybackSessionPersistence(
	options: PlaybackSessionPersistenceHookOptions = {},
): void {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	useEffect(() => {
		const runtime = createPlaybackSessionPersistenceRuntime({
			subscribeStore(listener) {
				return usePlaybackStore.subscribe(listener);
			},
			readSnapshot: () => {
				const state = usePlaybackStore.getState();
				return {
					isPlaying: state.isPlaying,
					positionMs: state.positionMs,
					hasCurrentTrack: !!state.currentTrack,
				};
			},
			isQuiescenceOwned:
				() => optionsRef.current.hasActiveQuiescenceOperation?.() ?? false,
			capture: () =>
				capturePlaybackSessionEnvelope({ nowMs: Date.now() }),
			save: (envelope) =>
				Promise.resolve((optionsRef.current.save ?? savePlaybackSessionCheckpoint)(envelope)),
			now: () => optionsRef.current.now?.() ?? Date.now(),
			minIntervalMs: optionsRef.current.minIntervalMs,
		});
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") runtime.flushOnUnload();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("pagehide", runtime.flushOnUnload);
		window.addEventListener("beforeunload", runtime.flushOnUnload);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			window.removeEventListener("pagehide", runtime.flushOnUnload);
			window.removeEventListener("beforeunload", runtime.flushOnUnload);
			runtime.dispose();
		};
	}, []);
}
