import { create } from "zustand";
import type { PlayableState, ProviderId, Track } from "@mineradio/shared";

export type PlaybackMode = "single" | "loop" | "queue" | "shuffle";

export const MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE = 240;
export const MAX_PLAYBACK_EXIT_CHECKPOINT_BYTES = 256 * 1024;
export const PLAYBACK_EXIT_CHECKPOINT_SCHEMA = "playback-exit-checkpoint-v1" as const;

const MAX_CHECKPOINT_TRACK_ID = 512;
const MAX_CHECKPOINT_TRACK_TEXT = 512;
const MAX_CHECKPOINT_TRACK_ARTISTS = 16;
const MAX_CHECKPOINT_TRACK_ARTIST = 256;
const MAX_CHECKPOINT_QUALITY_HINTS = 16;
const MAX_CHECKPOINT_QUALITY_HINT = 64;
const MAX_CHECKPOINT_MEDIA_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const CHECKPOINT_RECEIPT_PATTERN = /^[0-9a-f]{32}$/u;

export type PlaybackCheckpointSourceKind =
	| "remote"
	| "blob"
	| "local"
	| "opaque"
	| "none";

export interface PlaybackCheckpointTrackV1 {
	readonly provider: Track["provider"];
	readonly id: string;
	readonly sourceId: string;
	readonly mediaMid?: string;
	readonly title: string;
	readonly artists: readonly string[];
	readonly album: string;
	readonly durationMs?: number;
	readonly qualityHints: readonly string[];
	readonly playableState: PlayableState;
}

export interface PlaybackExitCheckpointV1 {
	readonly schema: typeof PLAYBACK_EXIT_CHECKPOINT_SCHEMA;
	readonly operationId: string;
	readonly receipt: string;
	readonly queue: readonly PlaybackCheckpointTrackV1[];
	readonly currentTrackIndex: number | null;
	readonly currentTrackRef: string;
	readonly capturedPlaybackIntentId: number;
	readonly positionMs: number;
	readonly durationMs: number | null;
	readonly wasPlaying: boolean;
	readonly mode: PlaybackMode;
	readonly volume: number;
	readonly muted: boolean;
	readonly sourceKind: PlaybackCheckpointSourceKind;
	readonly restartRestorable: boolean;
}

export interface PlaybackCheckpointRestoreAuthority {
	readonly operationId: string;
	readonly receipt: string;
	readonly playbackIntentId: number;
	readonly currentTrackRef: string;
	readonly wasPlaying: boolean;
	readonly sourceKind: PlaybackCheckpointSourceKind;
	readonly restartRestorable: boolean;
	readonly autoplayDispositionConsumed: boolean;
}

export interface CapturePlaybackExitCheckpointRequest {
	readonly operationId: string;
	readonly receipt: string;
	readonly sourceKind: Exclude<PlaybackCheckpointSourceKind, "none">;
	readonly ownerOriginallyPlaying?: boolean;
}

export interface RestorePlaybackExitCheckpointRequest {
	readonly operationId: string;
	readonly receipt: string;
	readonly mode: "same-process-rollback" | "restart-reconciliation";
	readonly checkpoint: PlaybackExitCheckpointV1;
}

export interface ConsumePlaybackCheckpointAutoplayRequest {
	readonly operationId: string;
	readonly receipt: string;
	readonly playbackIntentId: number;
	readonly currentTrackRef: string;
}

export type PlaybackCheckpointRestoreResult =
	| "restored"
	| "already-restored"
	| "rejected";

export interface ReplaceCurrentSourceRequest {
	candidate: Track;
	expectedPlaybackIntentId: number;
	preservePositionMs: number;
}

export interface PreparedHandoffCommitRequest {
	candidate: Track;
	expectedPlaybackIntentId: number;
	expectedOutgoingTrackRef: string;
}

export interface PlaybackState {
	currentTrack: Track | null;
	playbackIntentId: number;
	isPlaying: boolean;
	positionMs: number;
	durationMs: number | null;
	volume: number;
	muted: boolean;
	mode: PlaybackMode;
	queue: Track[];
	/** 流式电台续播源：非空且当前曲为队尾时，ended 前自动续拉下一首 */
	streamSource: { provider: ProviderId; id: string } | null;
	checkpointRestore: PlaybackCheckpointRestoreAuthority | null;
	setCurrentTrack: (track: Track | null) => void;
	setPlaying: (playing: boolean) => void;
	togglePlay: () => void;
	setPosition: (ms: number) => void;
	setDuration: (ms: number | null) => void;
	setVolume: (volume: number) => void;
	toggleMute: () => void;
	setMode: (mode: PlaybackMode) => void;
	setQueue: (tracks: Track[]) => void;
	setStreamSource(source: { provider: ProviderId; id: string } | null): void;
	enqueue: (track: Track) => void;
	insertAt: (index: number, track: Track) => void;
	insertNext: (track: Track) => void;
	replaceCurrentSource: (request: ReplaceCurrentSourceRequest) => boolean;
	commitPreparedHandoff: (request: PreparedHandoffCommitRequest) => boolean;
	playAt: (index: number) => void;
	removeAt: (index: number) => void;
	removeTrack: (track: Track) => void;
	next: () => void;
	previous: () => void;
	ended: () => void;
	clearQueue: () => void;
	capturePlaybackExitCheckpoint(
		request: CapturePlaybackExitCheckpointRequest,
	): PlaybackExitCheckpointV1 | null;
	restorePlaybackExitCheckpoint(
		request: RestorePlaybackExitCheckpointRequest,
	): PlaybackCheckpointRestoreResult;
	consumePlaybackCheckpointAutoplay(
		request: ConsumePlaybackCheckpointAutoplayRequest,
	): boolean;
}

function nextPlaybackIntent(state: Pick<PlaybackState, "playbackIntentId">): number {
	return state.playbackIntentId + 1;
}

export function trackRef(track: Track | null): string {
	return track ? `${track.provider}:${track.id}` : "";
}

function playbackPatchForTrack(track: Track | null) {
	return {
		currentTrack: track,
		isPlaying: track ? true : false,
		positionMs: 0,
		durationMs: track?.durationMs ?? null,
	};
}

function stopPlaybackPatch() {
	return {
		currentTrack: null,
		isPlaying: false,
		positionMs: 0,
		durationMs: null,
	};
}

function findTrackIndex(queue: Track[], track: Track | null): number {
	if (!track) return -1;
	const identityIndex = queue.findIndex((item) => item === track);
	if (identityIndex >= 0) return identityIndex;
	const ref = trackRef(track);
	return ref ? queue.findIndex((item) => trackRef(item) === ref) : -1;
}

function checkpointSourceIsRestartRestorable(
	sourceKind: PlaybackCheckpointSourceKind,
): boolean {
	return sourceKind === "remote" || sourceKind === "none";
}

function validCheckpointReceipt(value: unknown): value is string {
	return typeof value === "string" && CHECKPOINT_RECEIPT_PATTERN.test(value);
}

function validCheckpointOperationId(value: unknown): value is string {
	return typeof value === "string" && CHECKPOINT_RECEIPT_PATTERN.test(value);
}

function boundedCheckpointText(
	value: unknown,
	maxLength: number,
	allowEmpty = true,
): value is string {
	return typeof value === "string"
		&& (allowEmpty || value.length > 0)
		&& value.length <= maxLength
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

function validCheckpointTrackValue(value: unknown): value is PlaybackCheckpointTrackV1 {
	if (!value || typeof value !== "object") return false;
	const track = value as Partial<PlaybackCheckpointTrackV1>;
	return (track.provider === "netease" || track.provider === "qq" || track.provider === "soda")
		&& boundedCheckpointText(track.id, MAX_CHECKPOINT_TRACK_ID, false)
		&& boundedCheckpointText(track.sourceId, MAX_CHECKPOINT_TRACK_ID, false)
		&& (track.mediaMid === undefined
			|| boundedCheckpointText(track.mediaMid, MAX_CHECKPOINT_TRACK_ID, false))
		&& boundedCheckpointText(track.title, MAX_CHECKPOINT_TRACK_TEXT)
		&& Array.isArray(track.artists)
		&& track.artists.length <= MAX_CHECKPOINT_TRACK_ARTISTS
		&& track.artists.every((artist) =>
			boundedCheckpointText(artist, MAX_CHECKPOINT_TRACK_ARTIST))
		&& boundedCheckpointText(track.album, MAX_CHECKPOINT_TRACK_TEXT)
		&& (track.durationMs === undefined
			|| (Number.isSafeInteger(track.durationMs)
				&& track.durationMs >= 0
				&& track.durationMs <= MAX_CHECKPOINT_MEDIA_DURATION_MS))
		&& Array.isArray(track.qualityHints)
		&& track.qualityHints.length <= MAX_CHECKPOINT_QUALITY_HINTS
		&& track.qualityHints.every((hint) =>
			boundedCheckpointText(hint, MAX_CHECKPOINT_QUALITY_HINT))
		&& [
			"unknown",
			"playable",
			"login_required",
			"vip_required",
			"paid_required",
			"copyright_unavailable",
			"trial_only",
			"unavailable",
		].includes(String(track.playableState));
}

function checkpointTrackFromTrack(track: Track): PlaybackCheckpointTrackV1 | null {
	const candidate: PlaybackCheckpointTrackV1 = {
		provider: track.provider,
		id: track.id,
		sourceId: track.sourceId,
		...(track.mediaMid === undefined ? {} : { mediaMid: track.mediaMid }),
		title: track.title,
		artists: Object.freeze([...track.artists]),
		album: track.album,
		...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
		qualityHints: Object.freeze([...track.qualityHints]),
		playableState: track.playableState,
	};
	return validCheckpointTrackValue(candidate) ? Object.freeze(candidate) : null;
}

function trackFromCheckpoint(track: PlaybackCheckpointTrackV1): Track {
	return {
		provider: track.provider,
		id: track.id,
		sourceId: track.sourceId,
		...(track.mediaMid === undefined ? {} : { mediaMid: track.mediaMid }),
		title: track.title,
		artists: [...track.artists],
		album: track.album,
		coverUrl: "",
		...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
		qualityHints: [...track.qualityHints],
		playableState: track.playableState,
	};
}

function checkpointEncodedSize(value: unknown): number | null {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return null;
	}
}

function validCheckpointNumber(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isFinite(value)
		&& value >= 0
		&& value <= MAX_CHECKPOINT_MEDIA_DURATION_MS;
}

function validCheckpointPlaybackIntentId(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0;
}

function validatedCheckpointCurrentTrack(
	checkpoint: PlaybackExitCheckpointV1,
): PlaybackCheckpointTrackV1 | null | undefined {
	const encodedSize = checkpointEncodedSize(checkpoint);
	if (
		checkpoint.schema !== PLAYBACK_EXIT_CHECKPOINT_SCHEMA
		|| !validCheckpointOperationId(checkpoint.operationId)
		|| !validCheckpointReceipt(checkpoint.receipt)
		|| !Array.isArray(checkpoint.queue)
		|| checkpoint.queue.length > MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE
		|| !checkpoint.queue.every(validCheckpointTrackValue)
		|| encodedSize === null
		|| encodedSize > MAX_PLAYBACK_EXIT_CHECKPOINT_BYTES
		|| !validCheckpointPlaybackIntentId(checkpoint.capturedPlaybackIntentId)
		|| !validCheckpointNumber(checkpoint.positionMs)
		|| (checkpoint.durationMs !== null && !validCheckpointNumber(checkpoint.durationMs))
		|| typeof checkpoint.wasPlaying !== "boolean"
		|| !(["single", "loop", "queue", "shuffle"] as const).includes(checkpoint.mode)
		|| typeof checkpoint.volume !== "number"
		|| !Number.isFinite(checkpoint.volume)
		|| checkpoint.volume < 0
		|| checkpoint.volume > 1
		|| typeof checkpoint.muted !== "boolean"
		|| !(["remote", "blob", "local", "opaque", "none"] as const).includes(
			checkpoint.sourceKind,
		)
		|| checkpoint.restartRestorable !== checkpointSourceIsRestartRestorable(
			checkpoint.sourceKind,
		)
		|| !boundedCheckpointText(checkpoint.currentTrackRef, 640)
	) return undefined;

	if (checkpoint.currentTrackIndex === null) {
		return checkpoint.currentTrackRef === ""
			&& checkpoint.sourceKind === "none"
			? null
			: undefined;
	}
	if (
		!Number.isInteger(checkpoint.currentTrackIndex)
		|| checkpoint.currentTrackIndex < 0
		|| checkpoint.currentTrackIndex >= checkpoint.queue.length
		|| checkpoint.sourceKind === "none"
	) return undefined;
	const current = checkpoint.queue[checkpoint.currentTrackIndex];
	return current && `${current.provider}:${current.id}` === checkpoint.currentTrackRef
		? current
		: undefined;
}

export function moveTrackToFront(queue: Track[], track: Track): Track[] {
	const ref = trackRef(track);
	if (!ref) return [track, ...queue];
	const existing = queue.find((item) => trackRef(item) === ref) ?? track;
	return [existing, ...queue.filter((item) => trackRef(item) !== ref)];
}

export const usePlaybackStore = create<PlaybackState>()((set, get) => ({
	currentTrack: null,
	playbackIntentId: 0,
	isPlaying: false,
	positionMs: 0,
	durationMs: null,
	volume: 0.84,
	muted: false,
	mode: "loop",
	queue: [],
	streamSource: null,
	checkpointRestore: null,
	setStreamSource: (source) => set({ streamSource: source }),
	setCurrentTrack: (track) =>
		set((s) => ({
			...playbackPatchForTrack(track),
			playbackIntentId: nextPlaybackIntent(s),
		})),
	setPlaying: (playing) => set({ isPlaying: playing }),
	togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
	setPosition: (ms) => set({ positionMs: ms }),
	setDuration: (ms) => set({ durationMs: ms }),
	setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)), muted: volume <= 0 }),
	toggleMute: () => set((s) => ({ muted: !s.muted })),
	setMode: (mode) => set({ mode }),
	setQueue: (tracks) => set({ queue: tracks, streamSource: null }),
	enqueue: (track) => set((s) => ({ queue: [...s.queue, track] })),
	insertAt: (index, track) =>
		set((s) => {
			const next = [...s.queue];
			const at = Math.max(0, Math.min(index, next.length));
			next.splice(at, 0, track);
			return { queue: next };
		}),
	insertNext: (track) =>
		set((s) => {
			const targetRef = trackRef(track);
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			const existingIdx = targetRef ? s.queue.findIndex((item) => trackRef(item) === targetRef) : -1;
			if (existingIdx === currentIdx && currentIdx >= 0) return {};

			const next = [...s.queue];
			const moved = existingIdx >= 0 ? next.splice(existingIdx, 1)[0] : track;
			let adjustedCurrentIdx = currentIdx;
			if (existingIdx >= 0 && existingIdx < currentIdx) adjustedCurrentIdx -= 1;

			if (adjustedCurrentIdx < 0) {
				next.push(moved);
				return { queue: next };
			}

			const insertAt = Math.min(next.length, adjustedCurrentIdx + 1);
			next.splice(insertAt, 0, moved);
			return { queue: next };
		}),
	replaceCurrentSource: (request) => {
		let committed = false;
		set((state) => {
			if (state.playbackIntentId !== request.expectedPlaybackIntentId) return {};
			const currentIndex = findTrackIndex(state.queue, state.currentTrack);
			if (currentIndex < 0 || !state.currentTrack) return {};
			const queue = [...state.queue];
			queue[currentIndex] = request.candidate;
			committed = true;
			return {
				queue,
				currentTrack: request.candidate,
				positionMs: Math.max(0, request.preservePositionMs),
				durationMs: request.candidate.durationMs ?? state.durationMs,
				playbackIntentId: nextPlaybackIntent(state),
			};
		});
		return committed;
	},
	commitPreparedHandoff: (request) => {
		let committed = false;
		set((state) => {
			if (state.playbackIntentId !== request.expectedPlaybackIntentId) return {};
			if (trackRef(state.currentTrack) !== request.expectedOutgoingTrackRef) return {};
			if (state.mode === "single" || state.mode === "shuffle") return {};
			const currentIndex = findTrackIndex(state.queue, state.currentTrack);
			if (currentIndex < 0 || state.queue.length < 2) return {};
			const nextIndex = currentIndex + 1 < state.queue.length
				? currentIndex + 1
				: state.mode === "loop"
					? 0
					: -1;
			if (nextIndex < 0) return {};
			const adjacent = state.queue[nextIndex];
			if (!adjacent || trackRef(adjacent) !== trackRef(request.candidate)) return {};

			committed = true;
			return {
				...playbackPatchForTrack(adjacent),
				playbackIntentId: nextPlaybackIntent(state),
			};
		});
		return committed;
	},
	playAt: (index) =>
		set((s) => {
			if (index < 0 || index >= s.queue.length) return {};
			const track = s.queue[index] ?? null;
			return {
				...playbackPatchForTrack(track),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	removeAt: (index) =>
		set((s) => {
			if (index < 0 || index >= s.queue.length) return {};
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			const next = s.queue.filter((_, itemIdx) => itemIdx !== index);
			if (index !== currentIdx) return { queue: next };

			const nextCurrent = next[Math.min(index, next.length - 1)] ?? null;
			return {
				queue: next,
				...playbackPatchForTrack(nextCurrent),
				...(nextCurrent ? {} : { isPlaying: false }),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	removeTrack: (track) =>
		set((s) => {
			const ref = trackRef(track);
			if (!ref) return {};
			const firstRemovedIdx = s.queue.findIndex((item) => trackRef(item) === ref);
			if (firstRemovedIdx < 0) return {};
			const currentRemoved = trackRef(s.currentTrack) === ref;
			const next = s.queue.filter((item) => trackRef(item) !== ref);
			if (!currentRemoved) return { queue: next };

			const nextCurrent = next[Math.min(firstRemovedIdx, next.length - 1)] ?? null;
			return {
				queue: next,
				...playbackPatchForTrack(nextCurrent),
				...(nextCurrent ? {} : { isPlaying: false }),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	clearQueue: () =>
		set((s) => ({
			queue: [],
			streamSource: null,
			...stopPlaybackPatch(),
			playbackIntentId: nextPlaybackIntent(s),
		})),
	previous: () =>
		set((s) => {
			if (s.queue.length === 0) return s;
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			let prevIdx: number;
			if (s.mode === "shuffle") {
				const len = s.queue.length;
				prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
			} else if (s.mode === "single") {
				prevIdx = currentIdx >= 0 ? currentIdx : 0;
			} else {
				const len = s.queue.length;
				prevIdx = currentIdx >= 0 ? (currentIdx - 1 + len) % len : 0;
			}
			const prevTrack = s.queue[prevIdx] ?? null;
			return {
				...playbackPatchForTrack(prevTrack),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	next: () =>
		set((s) => {
			if (s.queue.length === 0) {
				return {
					...stopPlaybackPatch(),
					playbackIntentId: nextPlaybackIntent(s),
				};
			}
			const currentIdx = findTrackIndex(s.queue, s.currentTrack);
			let nextIdx: number;
			if (s.mode === "shuffle") {
				if (s.queue.length === 1) {
					nextIdx = 0;
				} else {
					const randomIdx = Math.floor(Math.random() * (s.queue.length - 1));
					nextIdx = currentIdx >= 0 && randomIdx >= currentIdx ? randomIdx + 1 : randomIdx;
				}
			} else if (s.mode === "single") {
				nextIdx = currentIdx >= 0 ? currentIdx : 0;
			} else if (s.mode === "loop") {
				nextIdx = (currentIdx + 1) % s.queue.length;
			} else {
				const candidate = currentIdx + 1;
				if (candidate >= s.queue.length) {
					return {
						...stopPlaybackPatch(),
						playbackIntentId: nextPlaybackIntent(s),
					};
				}
				nextIdx = candidate;
			}
			const nextTrack = s.queue[nextIdx] ?? null;
			return {
				...playbackPatchForTrack(nextTrack),
				playbackIntentId: nextPlaybackIntent(s),
			};
		}),
	ended: () => {
		if (get().mode === "single") {
			set((s) => {
				const currentIdx = findTrackIndex(s.queue, s.currentTrack);
				const track = currentIdx >= 0 ? s.queue[currentIdx] : s.currentTrack;
				return {
					...playbackPatchForTrack(track),
					playbackIntentId: nextPlaybackIntent(s),
				};
			});
			return;
		}
		get().next();
	},
	capturePlaybackExitCheckpoint: (request) => {
		if (
			!validCheckpointOperationId(request.operationId)
			|| !validCheckpointReceipt(request.receipt)
		) return null;
		const state = get();
		const checkpointQueue = state.queue.map(checkpointTrackFromTrack);
		if (
			state.queue.length > MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE
			|| checkpointQueue.some((track) => track === null)
			|| !validCheckpointPlaybackIntentId(state.playbackIntentId)
			|| !validCheckpointNumber(state.positionMs)
			|| (state.durationMs !== null && !validCheckpointNumber(state.durationMs))
			|| (request.ownerOriginallyPlaying !== undefined
				&& typeof request.ownerOriginallyPlaying !== "boolean")
			|| !(request.sourceKind === "remote"
				|| request.sourceKind === "blob"
				|| request.sourceKind === "local"
				|| request.sourceKind === "opaque")
		) return null;
		const currentTrackIndex = findTrackIndex(state.queue, state.currentTrack);
		if (state.currentTrack && currentTrackIndex < 0) return null;
		const sourceKind = state.currentTrack ? request.sourceKind : "none";
		const checkpoint = Object.freeze({
			schema: PLAYBACK_EXIT_CHECKPOINT_SCHEMA,
			operationId: request.operationId,
			receipt: request.receipt,
			queue: Object.freeze(checkpointQueue as PlaybackCheckpointTrackV1[]),
			currentTrackIndex: state.currentTrack ? currentTrackIndex : null,
			currentTrackRef: trackRef(state.currentTrack),
			capturedPlaybackIntentId: state.playbackIntentId,
			positionMs: state.positionMs,
			durationMs: state.durationMs,
			wasPlaying: state.currentTrack
				? (request.ownerOriginallyPlaying ?? state.isPlaying)
				: false,
			mode: state.mode,
			volume: state.volume,
			muted: state.muted,
			sourceKind,
			restartRestorable: checkpointSourceIsRestartRestorable(sourceKind),
		} satisfies PlaybackExitCheckpointV1);
		const encodedSize = checkpointEncodedSize(checkpoint);
		return encodedSize !== null && encodedSize <= MAX_PLAYBACK_EXIT_CHECKPOINT_BYTES
			? checkpoint
			: null;
	},
	restorePlaybackExitCheckpoint: (request) => {
		const before = get();
		const prior = before.checkpointRestore;
		if (
			prior?.operationId === request.operationId
			&& prior.receipt === request.receipt
		) return "already-restored";
		if (
			prior?.operationId === request.operationId
		) return "rejected";
		const checkpoint = request.checkpoint;
		if (
			!checkpoint
			|| typeof checkpoint !== "object"
			|| checkpoint.operationId !== request.operationId
			|| checkpoint.receipt !== request.receipt
			|| (request.mode !== "same-process-rollback"
				&& request.mode !== "restart-reconciliation")
		) return "rejected";
		const currentTrack = validatedCheckpointCurrentTrack(checkpoint);
		if (currentTrack === undefined) return "rejected";
		if (request.mode === "restart-reconciliation" && !checkpoint.restartRestorable) {
			return "rejected";
		}
		const restoredQueue = checkpoint.queue.map(trackFromCheckpoint);
		const restoredCurrentTrack = checkpoint.currentTrackIndex === null
			? null
			: restoredQueue[checkpoint.currentTrackIndex] ?? null;
		set((state) => {
			const playbackIntentId = nextPlaybackIntent(state);
			return {
				queue: restoredQueue,
				currentTrack: restoredCurrentTrack,
				// 恢复检查点属于整队列替换，流式续播源一并失效
				streamSource: null,
				playbackIntentId,
				isPlaying: restoredCurrentTrack ? checkpoint.wasPlaying : false,
				positionMs: restoredCurrentTrack ? checkpoint.positionMs : 0,
				durationMs: restoredCurrentTrack ? checkpoint.durationMs : null,
				mode: checkpoint.mode,
				volume: checkpoint.volume,
				muted: checkpoint.muted,
				checkpointRestore: {
					operationId: request.operationId,
					receipt: request.receipt,
					playbackIntentId,
					currentTrackRef: checkpoint.currentTrackRef,
					wasPlaying: checkpoint.wasPlaying,
					sourceKind: checkpoint.sourceKind,
					restartRestorable: checkpoint.restartRestorable,
					autoplayDispositionConsumed: false,
				},
			};
		});
		return "restored";
	},
	consumePlaybackCheckpointAutoplay: (request) => {
		let consumed = false;
		set((state) => {
			const authority = state.checkpointRestore;
			if (
				!authority
				|| authority.operationId !== request.operationId
				|| authority.receipt !== request.receipt
				|| authority.playbackIntentId !== request.playbackIntentId
				|| authority.currentTrackRef !== request.currentTrackRef
			) return {};
			consumed = true;
			if (authority.autoplayDispositionConsumed) return {};
			return {
				checkpointRestore: {
					...authority,
					autoplayDispositionConsumed: true,
				},
			};
		});
		return consumed;
	},
}));
