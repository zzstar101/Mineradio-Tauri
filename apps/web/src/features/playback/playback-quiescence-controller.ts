import type {
	CommittedPlaybackOwnerLease,
} from "../../audio/player-controller";
import type {
	CapturePlaybackExitCheckpointRequest,
	PlaybackExitCheckpointV1,
	PlaybackCheckpointRestoreResult,
	RestorePlaybackExitCheckpointRequest,
} from "../../stores/playback-store";

export interface PlaybackQuiescenceOperationIdentity {
	readonly operationId: string;
	readonly operationGeneration: number;
}

export interface PlaybackQuiescencePreparedIdentity
	extends PlaybackQuiescenceOperationIdentity {
	readonly receipt: string;
}

export interface PlaybackQuiescenceAudioPort {
	stageCommittedOwnerLease(): CommittedPlaybackOwnerLease | null;
	pauseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
	rollbackCommittedOwnerLease(
		lease: CommittedPlaybackOwnerLease,
	): Promise<boolean>;
	releaseCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
	cancelCommittedOwnerLease(lease: CommittedPlaybackOwnerLease): boolean;
}

export interface PlaybackQuiescenceCheckpointPort {
	capturePlaybackExitCheckpoint(
		request: CapturePlaybackExitCheckpointRequest,
	): PlaybackExitCheckpointV1 | null;
	restorePlaybackExitCheckpoint(
		request: RestorePlaybackExitCheckpointRequest,
	): PlaybackCheckpointRestoreResult;
}

export interface PlaybackQuiescenceControllerOptions {
	readonly audio: PlaybackQuiescenceAudioPort;
	readonly checkpoint: PlaybackQuiescenceCheckpointPort;
	readonly createReceipt?: () => string;
}

export type PlaybackQuiescencePrepareResult =
	| {
			readonly status: "prepared" | "already-prepared";
			readonly checkpoint: PlaybackExitCheckpointV1;
	  }
	| {
			readonly status: "rejected";
			readonly reason:
				| "operation-active"
				| "checkpoint-rejected"
				| "owner-checkpoint-mismatch"
				| "source-not-restart-restorable";
	  };

export type PlaybackQuiescenceRollbackResult =
	| "restored"
	| "no-op-not-prepared"
	| "no-op-not-paused"
	| "owner-stale"
	| "rejected";

interface ActivePlaybackQuiescence {
	readonly identity: PlaybackQuiescenceOperationIdentity;
	readonly checkpoint: PlaybackExitCheckpointV1 | null;
	readonly owner: CommittedPlaybackOwnerLease | null;
	phase: "not-prepared" | "staged" | "paused" | "pause-failed" | "sealed-for-exit" | "released";
	rollback: Promise<PlaybackQuiescenceRollbackResult> | null;
	rollbackResult: PlaybackQuiescenceRollbackResult | null;
}

function sameIdentity(
	left: PlaybackQuiescenceOperationIdentity,
	right: PlaybackQuiescenceOperationIdentity,
): boolean {
	return left.operationId === right.operationId
		&& left.operationGeneration === right.operationGeneration;
}

function validOperationIdentity(
	identity: PlaybackQuiescenceOperationIdentity,
): boolean {
	return /^[0-9a-f]{32}$/u.test(identity.operationId)
		&& Number.isSafeInteger(identity.operationGeneration)
		&& identity.operationGeneration > 0;
}

function validPreparedIdentity(
	identity: PlaybackQuiescencePreparedIdentity,
): boolean {
	return validOperationIdentity(identity)
		&& /^[0-9a-f]{32}$/u.test(identity.receipt);
}

function createCryptographicReceipt(): string {
	const bytes = new Uint8Array(16);
	const crypto = globalThis.crypto;
	if (!crypto || typeof crypto.getRandomValues !== "function") {
		throw new Error("cryptographic randomness is unavailable");
	}
	crypto.getRandomValues(bytes);
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function operationIdentity(
	identity: PlaybackQuiescenceOperationIdentity,
): PlaybackQuiescenceOperationIdentity {
	return Object.freeze({
		operationId: identity.operationId,
		operationGeneration: identity.operationGeneration,
	});
}

function suppliedReceipt(
	identity: PlaybackQuiescenceOperationIdentity,
): string | null {
	const candidate = identity as PlaybackQuiescenceOperationIdentity & {
		readonly receipt?: unknown;
	};
	return typeof candidate.receipt === "string" ? candidate.receipt : null;
}

function samePreparedIdentity(
	active: ActivePlaybackQuiescence,
	identity: PlaybackQuiescencePreparedIdentity,
): boolean {
	return sameIdentity(active.identity, identity)
		&& active.checkpoint?.receipt === identity.receipt;
}

/**
 * Web 播放静默的窄协调器。prepare 只生成 checkpoint 与 owner lease；只有 native
 * 已确认 checkpoint 落盘后，caller 才能用 exact identity 进入暂停阶段。
 */
export class PlaybackQuiescenceController {
	private active: ActivePlaybackQuiescence | null = null;
	private readonly consumed = new Map<number, {
		readonly identity: PlaybackQuiescenceOperationIdentity;
		readonly checkpointReceipt: string | null;
		readonly result: PlaybackQuiescenceRollbackResult;
	}>();
	private highestConsumedGeneration = 0;
	private readonly createReceipt: () => string;

	constructor(
		private readonly options: PlaybackQuiescenceControllerOptions,
	) {
		this.createReceipt = options.createReceipt ?? createCryptographicReceipt;
	}

	prepare(identity: PlaybackQuiescenceOperationIdentity): PlaybackQuiescencePrepareResult {
		if (!validOperationIdentity(identity)) {
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		if (identity.operationGeneration <= this.highestConsumedGeneration) {
			return { status: "rejected", reason: "operation-active" };
		}
		const active = this.active;
		if (active && sameIdentity(active.identity, identity)) {
			return active.phase === "released" || !active.checkpoint
				? { status: "rejected", reason: "operation-active" }
				: { status: "already-prepared", checkpoint: active.checkpoint };
		}
		if (active && active.phase !== "released") {
			return { status: "rejected", reason: "operation-active" };
		}

		let receipt: string;
		try {
			receipt = this.createReceipt();
		} catch {
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		if (!/^[0-9a-f]{32}$/u.test(receipt)) {
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		const owner = this.options.audio.stageCommittedOwnerLease();
		const checkpoint = this.options.checkpoint.capturePlaybackExitCheckpoint({
			operationId: identity.operationId,
			receipt,
			sourceKind: owner?.sourceKind ?? "opaque",
			ownerOriginallyPlaying: owner?.originallyPlaying,
		});
		if (!checkpoint) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return { status: "rejected", reason: "checkpoint-rejected" };
		}
		const checkpointHasOwner = checkpoint.currentTrackRef.length > 0;
		if (
			checkpoint.operationId !== identity.operationId
			|| checkpoint.receipt !== receipt
			|| (!!owner !== checkpointHasOwner)
			|| (owner && (
				owner.trackRef !== checkpoint.currentTrackRef
				|| owner.playbackIntentId !== checkpoint.capturedPlaybackIntentId
			))
		) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return { status: "rejected", reason: "owner-checkpoint-mismatch" };
		}
		if (!checkpoint.restartRestorable) {
			if (owner) this.options.audio.cancelCommittedOwnerLease(owner);
			return {
				status: "rejected",
				reason: "source-not-restart-restorable",
			};
		}
		this.active = {
			identity: operationIdentity(identity),
			checkpoint,
			owner,
			phase: "staged",
			rollback: null,
			rollbackResult: null,
		};
		return { status: "prepared", checkpoint };
	}

	/**
	 * 只读所有权信号：更新静默事务持有未释放的 owner lease（prepare 已接受且尚未
	 * released/consumed）时为 true。startup-resume 持久化 hook 用它暂停自己的
	 * checkpoint 捕获，避免与更新事务的 checkpoint 所有权互相踩踏；它不改变任何
	 * 事务状态。
	 */
	hasActiveOperation(): boolean {
		return this.active !== null && this.active.phase !== "released";
	}

	hydratePersistedCheckpoint(
		identity: PlaybackQuiescenceOperationIdentity,
		checkpoint: PlaybackExitCheckpointV1 | null,
	): "hydrated" | "already-hydrated" | "rejected" {
		if (!validOperationIdentity(identity)) return "rejected";
		const consumed = this.consumed.get(identity.operationGeneration);
		if (consumed) return sameIdentity(consumed.identity, identity)
			&& (consumed.checkpointReceipt === null
				|| consumed.checkpointReceipt === checkpoint?.receipt)
			? "already-hydrated"
			: "rejected";
		if (identity.operationGeneration < this.highestConsumedGeneration) return "rejected";
		if (this.active && this.active.phase !== "released") {
			return sameIdentity(this.active.identity, identity)
				&& this.active.checkpoint?.receipt === checkpoint?.receipt
				? "already-hydrated"
				: "rejected";
		}
		if (checkpoint && (
			checkpoint.operationId !== identity.operationId
			|| !checkpoint.restartRestorable
		)) return "rejected";
		this.active = {
			identity: operationIdentity(identity),
			checkpoint,
			owner: null,
			phase: checkpoint ? "paused" : "not-prepared",
			rollback: null,
			rollbackResult: null,
		};
		return "hydrated";
	}

	confirmCheckpointPersisted(identity: PlaybackQuiescencePreparedIdentity): boolean {
		const active = this.active;
		if (
			!validPreparedIdentity(identity)
			|| !active
			|| !samePreparedIdentity(active, identity)
		) return false;
		if (active.phase === "paused") return true;
		if (active.phase !== "staged") return false;
		if (!active.owner) {
			active.phase = "paused";
			return true;
		}
		const paused = this.options.audio.pauseCommittedOwnerLease(active.owner);
		active.phase = paused ? "paused" : "pause-failed";
		return paused;
	}

	rollback(
		identity: PlaybackQuiescenceOperationIdentity,
	): Promise<PlaybackQuiescenceRollbackResult> {
		if (!validOperationIdentity(identity)) return Promise.resolve("rejected");
		const active = this.active;
		if (!active) {
			const prior = this.consumed.get(identity.operationGeneration);
			if (prior) {
				return Promise.resolve(sameIdentity(prior.identity, identity)
					&& (prior.checkpointReceipt === null
						|| prior.checkpointReceipt === suppliedReceipt(identity))
					? prior.result
					: "rejected");
			}
			return Promise.resolve("rejected");
		}
		if (!sameIdentity(active.identity, identity)) {
			return Promise.resolve("rejected");
		}
		if (
			active.checkpoint
			&& active.checkpoint.receipt !== suppliedReceipt(identity)
		) return Promise.resolve("rejected");
		if (active.rollback) return active.rollback;
		if (active.rollbackResult) return Promise.resolve(active.rollbackResult);
		if (active.phase === "not-prepared") {
			active.phase = "released";
			active.rollbackResult = this.consume(
				active.identity,
				null,
				"no-op-not-prepared",
			);
			return Promise.resolve(active.rollbackResult);
		}
		if (!active.owner && active.checkpoint) {
			const restored = this.options.checkpoint.restorePlaybackExitCheckpoint({
				operationId: active.identity.operationId,
				receipt: active.checkpoint.receipt,
				mode: "restart-reconciliation",
				checkpoint: active.checkpoint,
			});
			active.phase = "released";
			active.rollbackResult = this.consume(
				active.identity,
				active.checkpoint.receipt,
				restored === "restored" || restored === "already-restored"
					? "restored"
					: "rejected",
			);
			return Promise.resolve(active.rollbackResult);
		}
		if (
			(active.phase !== "paused" && active.phase !== "sealed-for-exit")
			|| !active.owner
		) {
			if (active.owner) this.options.audio.cancelCommittedOwnerLease(active.owner);
			active.phase = "released";
			active.rollbackResult = this.consume(
				active.identity,
				active.checkpoint?.receipt ?? null,
				"no-op-not-paused",
			);
			return Promise.resolve(active.rollbackResult);
		}
		const checkpoint = active.checkpoint;
		active.rollback = this.options.audio.rollbackCommittedOwnerLease(active.owner)
			.then((restored) => {
				const storeRestored = restored && checkpoint
					? this.options.checkpoint.restorePlaybackExitCheckpoint({
						operationId: active.identity.operationId,
						receipt: checkpoint.receipt,
						mode: "same-process-rollback",
						checkpoint,
					})
					: null;
				const result: PlaybackQuiescenceRollbackResult = !restored
					? "owner-stale"
					: storeRestored === "restored" || storeRestored === "already-restored"
						? "restored"
						: "rejected";
				active.phase = "released";
				active.rollbackResult = this.consume(
					active.identity,
					checkpoint?.receipt ?? null,
					result,
				);
				return result;
			}, () => {
				active.phase = "released";
				active.rollbackResult = this.consume(
					active.identity,
					checkpoint?.receipt ?? null,
					"owner-stale",
				);
				return "owner-stale";
			});
		return active.rollback;
	}

	releaseForExit(identity: PlaybackQuiescencePreparedIdentity): boolean {
		const active = this.active;
		if (
			!validPreparedIdentity(identity)
			|| !active
			|| !samePreparedIdentity(active, identity)
		) return false;
		if (active.phase === "released") return true;
		if (active.phase === "sealed-for-exit") return true;
		if (active.phase !== "paused") return false;
		if (active.owner && !this.options.audio.releaseCommittedOwnerLease(active.owner)) {
			return false;
		}
		active.phase = "sealed-for-exit";
		return true;
	}

	private consume(
		identity: PlaybackQuiescenceOperationIdentity,
		checkpointReceipt: string | null,
		result: PlaybackQuiescenceRollbackResult,
	): PlaybackQuiescenceRollbackResult {
		const frozenIdentity = operationIdentity(identity);
		this.consumed.set(identity.operationGeneration, {
			identity: frozenIdentity,
			checkpointReceipt,
			result,
		});
		this.highestConsumedGeneration = Math.max(
			this.highestConsumedGeneration,
			identity.operationGeneration,
		);
		while (this.consumed.size > 32) {
			const oldest = this.consumed.keys().next().value;
			if (oldest === undefined) break;
			this.consumed.delete(oldest);
		}
		return result;
	}
}
