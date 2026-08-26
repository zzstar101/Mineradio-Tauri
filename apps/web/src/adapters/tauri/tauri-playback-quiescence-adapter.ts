import {
	PlayerController,
	type CommittedPlaybackOwnerLease,
} from "../../audio/player-controller";
import {
	PlaybackQuiescenceController,
	type PlaybackQuiescenceAudioPort,
	type PlaybackQuiescenceOperationIdentity,
	type PlaybackQuiescencePreparedIdentity,
	type PlaybackQuiescencePrepareResult,
	type PlaybackQuiescenceRollbackResult,
} from "../../features/playback/playback-quiescence-controller";
import {
	usePlaybackStore,
	type PlaybackExitCheckpointV1,
} from "../../stores/playback-store";
import {
	invokeTauriCommand,
	listenTauriEvent,
	type Unlisten,
} from "../../tauri/runtime";

export const TAURI_PLAYBACK_QUIESCENCE_EVENTS = Object.freeze({
	prepare: "mineradio-update-web-quiescence-prepare",
	confirm: "mineradio-update-web-quiescence-confirm",
	rollback: "mineradio-update-web-quiescence-rollback",
	release: "mineradio-update-web-quiescence-release",
});

export const TAURI_PLAYBACK_QUIESCENCE_ACK_COMMAND =
	"updater_web_quiescence_acknowledge" as const;
export const TAURI_PLAYBACK_QUIESCENCE_RECONCILE_COMMAND =
	"updater_web_quiescence_reconcile" as const;

export interface PlaybackQuiescenceControllerPort {
	prepare(
		identity: PlaybackQuiescenceOperationIdentity,
	): PlaybackQuiescencePrepareResult;
	hydratePersistedCheckpoint(
		identity: PlaybackQuiescenceOperationIdentity,
		checkpoint: PlaybackExitCheckpointV1 | null,
	): "hydrated" | "already-hydrated" | "rejected";
	confirmCheckpointPersisted(
		identity: PlaybackQuiescencePreparedIdentity,
	): boolean;
	rollback(
		identity: PlaybackQuiescenceOperationIdentity,
	): Promise<PlaybackQuiescenceRollbackResult>;
	releaseForExit(identity: PlaybackQuiescencePreparedIdentity): boolean;
}

export interface TauriPlaybackQuiescenceTransport {
	listen(
		eventName: string,
		handler: (payload: unknown) => void,
	): Promise<Unlisten>;
	invoke<T = unknown>(
		command: string,
		args?: Record<string, unknown>,
	): Promise<T | null>;
}

export interface TauriPlaybackQuiescenceAdapter {
	setPlayerController(controller: PlayerController | null): void;
	dispose(): void;
	/**
	 * 只读所有权信号（仅 production 桥提供）：更新静默事务持有未释放 owner lease
	 * 时为 true。startup-resume 持久化据此暂停自己的 checkpoint 捕获；无桥或测试
	 * 注入的 adapter 缺省视为 false。
	 */
	readonly hasActiveQuiescenceOperation?: () => boolean;
}

export interface CreateTauriPlaybackQuiescenceAdapterOptions {
	readonly controller: PlaybackQuiescenceControllerPort;
	readonly transport?: TauriPlaybackQuiescenceTransport;
	readonly setPlayerController?: (controller: PlayerController | null) => void;
	/** 只读所有权信号注入点（production 桥由 PlaybackQuiescenceController 提供）。 */
	readonly hasActiveQuiescenceOperation?: () => boolean;
}

export interface CreateProductionTauriPlaybackQuiescenceAdapterOptions {
	readonly transport?: TauriPlaybackQuiescenceTransport;
}

interface ExactOperationEnvelope {
	readonly operationId: string;
	readonly operationGeneration: number;
	readonly candidateId: string;
}

interface ExactEvidenceEnvelope extends ExactOperationEnvelope {
	readonly receipt: string;
	readonly checkpointDigest: string;
}

interface PersistedCheckpointEnvelope {
	readonly receipt: string;
	readonly digest: string;
	readonly payload: PlaybackExitCheckpointV1;
}

interface RollbackEnvelope extends ExactOperationEnvelope {
	readonly checkpoint: PersistedCheckpointEnvelope | null;
}

const defaultTransport: TauriPlaybackQuiescenceTransport = {
	listen: listenTauriEvent,
	invoke: invokeTauriCommand,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lowerHex(value: unknown, length: number): value is string {
	return typeof value === "string"
		&& value.length === length
		&& /^[0-9a-f]+$/u.test(value);
}

function exactOperationEnvelope(value: unknown): ExactOperationEnvelope | null {
	if (!isRecord(value)) return null;
	if (
		!lowerHex(value.operationId, 32)
		|| !Number.isSafeInteger(value.operationGeneration)
		|| Number(value.operationGeneration) <= 0
		|| !lowerHex(value.candidateId, 64)
	) return null;
	return Object.freeze({
		operationId: value.operationId,
		operationGeneration: Number(value.operationGeneration),
		candidateId: value.candidateId,
	});
}

function exactEvidenceEnvelope(value: unknown): ExactEvidenceEnvelope | null {
	const operation = exactOperationEnvelope(value);
	if (
		!operation
		|| !isRecord(value)
		|| !lowerHex(value.receipt, 32)
		|| !lowerHex(value.checkpointDigest, 64)
	) return null;
	return Object.freeze({
		...operation,
		receipt: value.receipt,
		checkpointDigest: value.checkpointDigest,
	});
}

function persistedCheckpointEnvelope(
	value: unknown,
	operationId: string,
): PersistedCheckpointEnvelope | null {
	if (
		!isRecord(value)
		|| !lowerHex(value.receipt, 32)
		|| !lowerHex(value.digest, 64)
		|| !isRecord(value.payload)
		|| value.payload.schema !== "playback-exit-checkpoint-v1"
		|| value.payload.operationId !== operationId
		|| value.payload.receipt !== value.receipt
		|| value.payload.restartRestorable !== true
	) return null;
	return Object.freeze({
		receipt: value.receipt,
		digest: value.digest,
		payload: value.payload as unknown as PlaybackExitCheckpointV1,
	});
}

function rollbackEnvelope(value: unknown): RollbackEnvelope | null {
	const operation = exactOperationEnvelope(value);
	if (!operation || !isRecord(value) || !("checkpoint" in value)) return null;
	if (value.checkpoint === null) {
		return Object.freeze({ ...operation, checkpoint: null });
	}
	const checkpoint = persistedCheckpointEnvelope(
		value.checkpoint,
		operation.operationId,
	);
	return checkpoint ? Object.freeze({ ...operation, checkpoint }) : null;
}

function operationIdentity(
	envelope: ExactOperationEnvelope,
): PlaybackQuiescenceOperationIdentity {
	return Object.freeze({
		operationId: envelope.operationId,
		operationGeneration: envelope.operationGeneration,
	});
}

/**
 * Rust 是更新状态 authority；这个 Adapter 只把 exact operation 消息翻译给播放静默
 * controller，并把结果原样回传。四个 listener 安装完成前绝不触发恢复协调。
 */
export async function createTauriPlaybackQuiescenceAdapter(
	options: CreateTauriPlaybackQuiescenceAdapterOptions,
): Promise<TauriPlaybackQuiescenceAdapter> {
	const transport = options.transport ?? defaultTransport;
	const unlisten: Unlisten[] = [];
	let disposed = false;
	let pendingEvent = Promise.resolve();
	const acceptedOperations = new Map<number, ExactOperationEnvelope>();
	let highestAcceptedGeneration = 0;

	const isExactAcceptedOperation = (envelope: ExactOperationEnvelope) => {
		const accepted = acceptedOperations.get(envelope.operationGeneration);
		return !!accepted
			&& accepted.operationId === envelope.operationId
			&& accepted.candidateId === envelope.candidateId;
	};

	const conflictsWithAcceptedOperation = (envelope: ExactOperationEnvelope) => {
		if (envelope.operationGeneration < highestAcceptedGeneration) return true;
		const accepted = acceptedOperations.get(envelope.operationGeneration);
		return !!accepted && (
			accepted.operationId !== envelope.operationId
			|| accepted.candidateId !== envelope.candidateId
		);
	};

	const rememberAcceptedOperation = (envelope: ExactOperationEnvelope) => {
		acceptedOperations.set(envelope.operationGeneration, envelope);
		highestAcceptedGeneration = Math.max(
			highestAcceptedGeneration,
			envelope.operationGeneration,
		);
		while (acceptedOperations.size > 32) {
			const oldest = acceptedOperations.keys().next().value;
			if (oldest === undefined) break;
			acceptedOperations.delete(oldest);
		}
	};

	const acknowledge = async (acknowledgement: Record<string, unknown>) => {
		if (disposed) return;
		await transport.invoke(TAURI_PLAYBACK_QUIESCENCE_ACK_COMMAND, {
			acknowledgement: Object.freeze(acknowledgement),
		});
	};

	const enqueue = (
		handler: (payload: unknown) => Promise<void>,
		payload: unknown,
	) => {
		if (disposed) return;
		pendingEvent = pendingEvent
			.then(() => disposed ? undefined : handler(payload))
			// Transport 失败由 Rust timeout/reconcile authority 处理，Web 不得越级推进状态。
			.catch(() => undefined);
	};

	const handlePrepare = async (payload: unknown) => {
		const envelope = exactOperationEnvelope(payload);
		if (!envelope) return;
		if (conflictsWithAcceptedOperation(envelope)) {
			await acknowledge({
				kind: "prepare",
				...envelope,
				receipt: null,
				checkpoint: null,
				result: "rejected",
				reason: "operation-active",
			});
			return;
		}
		const result = options.controller.prepare(operationIdentity(envelope));
		if (result.status !== "rejected") rememberAcceptedOperation(envelope);
		await acknowledge({
			kind: "prepare",
			...envelope,
			receipt: result.status === "rejected" ? null : result.checkpoint.receipt,
			checkpoint: result.status === "rejected" ? null : result.checkpoint,
			result: result.status,
			...(result.status === "rejected" ? { reason: result.reason } : {}),
		});
	};

	const handleConfirm = async (payload: unknown) => {
		const envelope = exactEvidenceEnvelope(payload);
		if (!envelope) return;
		const confirmed = isExactAcceptedOperation(envelope)
			&& options.controller.confirmCheckpointPersisted(Object.freeze({
				...operationIdentity(envelope),
				receipt: envelope.receipt,
			}));
		await acknowledge({
			kind: "confirm",
			...envelope,
			result: confirmed ? "confirmed" : "rejected",
		});
	};

	const handleRelease = async (payload: unknown) => {
		const envelope = exactEvidenceEnvelope(payload);
		if (!envelope) return;
		const released = isExactAcceptedOperation(envelope)
			&& options.controller.releaseForExit(Object.freeze({
				...operationIdentity(envelope),
				receipt: envelope.receipt,
			}));
		await acknowledge({
			kind: "release",
			...envelope,
			result: released ? "released" : "rejected",
		});
	};

	const handleRollback = async (payload: unknown) => {
		const envelope = rollbackEnvelope(payload);
		if (!envelope) return;
		const acknowledgementBase = {
			kind: "rollback",
			operationId: envelope.operationId,
			operationGeneration: envelope.operationGeneration,
			candidateId: envelope.candidateId,
			receipt: envelope.checkpoint?.receipt ?? null,
			checkpointDigest: envelope.checkpoint?.digest ?? null,
		};
		if (conflictsWithAcceptedOperation(envelope)) {
			await acknowledge({ ...acknowledgementBase, result: "rejected" });
			return;
		}
		const identity = operationIdentity(envelope);
		const hydrated = options.controller.hydratePersistedCheckpoint(
			identity,
			envelope.checkpoint?.payload ?? null,
		);
		if (hydrated === "rejected") {
			await acknowledge({ ...acknowledgementBase, result: "rejected" });
			return;
		}
		rememberAcceptedOperation(envelope);
		const rollbackIdentity = envelope.checkpoint
			? Object.freeze({ ...identity, receipt: envelope.checkpoint.receipt })
			: identity;
		const result = await options.controller.rollback(rollbackIdentity);
		await acknowledge({ ...acknowledgementBase, result });
	};

	try {
		unlisten.push(await transport.listen(
			TAURI_PLAYBACK_QUIESCENCE_EVENTS.prepare,
			(payload) => enqueue(handlePrepare, payload),
		));
		unlisten.push(await transport.listen(
			TAURI_PLAYBACK_QUIESCENCE_EVENTS.confirm,
			(payload) => enqueue(handleConfirm, payload),
		));
		unlisten.push(await transport.listen(
			TAURI_PLAYBACK_QUIESCENCE_EVENTS.rollback,
			(payload) => enqueue(handleRollback, payload),
		));
		unlisten.push(await transport.listen(
			TAURI_PLAYBACK_QUIESCENCE_EVENTS.release,
			(payload) => enqueue(handleRelease, payload),
		));
		await transport.invoke(TAURI_PLAYBACK_QUIESCENCE_RECONCILE_COMMAND);
	} catch (error) {
		for (const stop of unlisten.splice(0).reverse()) stop();
		throw error;
	}

	return Object.freeze({
		setPlayerController(controller: PlayerController | null) {
			if (!disposed) options.setPlayerController?.(controller);
		},
		hasActiveQuiescenceOperation: options.hasActiveQuiescenceOperation,
		dispose() {
			if (disposed) return;
			disposed = true;
			options.setPlayerController?.(null);
			for (const stop of unlisten.splice(0).reverse()) stop();
		},
	});
}

function createDynamicPlaybackAudioPort(): PlaybackQuiescenceAudioPort & {
	setController(controller: PlayerController | null): void;
} {
	let current: PlayerController | null = null;
	const owners = new WeakMap<CommittedPlaybackOwnerLease, PlayerController>();
	const ownerFor = (lease: CommittedPlaybackOwnerLease) => owners.get(lease) ?? null;
	return {
		setController(controller) {
			current = controller;
		},
		stageCommittedOwnerLease() {
			const owner = current;
			const lease = owner?.stageCommittedOwnerLease() ?? null;
			if (owner && lease) owners.set(lease, owner);
			return lease;
		},
		pauseCommittedOwnerLease(lease) {
			return ownerFor(lease)?.pauseCommittedOwnerLease(lease) ?? false;
		},
		async rollbackCommittedOwnerLease(lease) {
			const owner = ownerFor(lease);
			if (!owner) return false;
			const restored = await owner.rollbackCommittedOwnerLease(lease);
			if (restored) owners.delete(lease);
			return restored;
		},
		releaseCommittedOwnerLease(lease) {
			const released = ownerFor(lease)?.releaseCommittedOwnerLease(lease) ?? false;
			if (released) owners.delete(lease);
			return released;
		},
		cancelCommittedOwnerLease(lease) {
			const cancelled = ownerFor(lease)?.cancelCommittedOwnerLease(lease) ?? false;
			if (cancelled) owners.delete(lease);
			return cancelled;
		},
	};
}

/** 创建 production 播放静默桥；PlayerController 仍由 React PlaybackRuntimeHost 持有。 */
export async function createProductionTauriPlaybackQuiescenceAdapter(
	options: CreateProductionTauriPlaybackQuiescenceAdapterOptions = {},
): Promise<TauriPlaybackQuiescenceAdapter> {
	const audio = createDynamicPlaybackAudioPort();
	const controller = new PlaybackQuiescenceController({
		audio,
		checkpoint: {
			capturePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().capturePlaybackExitCheckpoint(request)
			),
			restorePlaybackExitCheckpoint: (request) => (
				usePlaybackStore.getState().restorePlaybackExitCheckpoint(request)
			),
		},
	});
	return createTauriPlaybackQuiescenceAdapter({
		controller,
		transport: options.transport,
		setPlayerController: (player) => audio.setController(player),
		hasActiveQuiescenceOperation: () => controller.hasActiveOperation(),
	});
}
