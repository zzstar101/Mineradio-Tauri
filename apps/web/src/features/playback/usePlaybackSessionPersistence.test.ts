import { beforeEach, expect, test } from "bun:test";
import type { Track } from "@mineradio/shared";
import {
	applyStartupPlaybackSessionPayload,
	capturePlaybackSessionEnvelope,
	createPlaybackSessionPersistenceRuntime,
	type PlaybackSessionPersistEnvelopeV1,
	PLAYBACK_SESSION_PERSIST_SCHEMA,
	shouldCaptureSessionCheckpoint,
	validatedPlaybackSessionPayload,
} from "./usePlaybackSessionPersistence";
import { usePlaybackStore } from "../../stores/playback-store";

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: `title-${id}`,
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState: "unknown",
	};
}

function resetStore() {
	usePlaybackStore.setState({
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
		previewRange: null,
		trialBanner: null,
		checkpointRestore: null,
	});
}

beforeEach(() => {
	resetStore();
});

test("periodic capture decision requires a track, freedom from quiescence, throttle and progress", () => {
	const base = {
		lastSavedAtMs: null as number | null,
		nowMs: 10_000,
		isPlaying: true,
		positionChangedSinceLastSave: false,
		hasCurrentTrack: true,
		updaterQuiescenceOwnsCheckpoint: false,
	};
	expect(shouldCaptureSessionCheckpoint(base)).toBe(true);

	// 无曲目 / quiescence 持有 → 一律不捕获。
	expect(
		shouldCaptureSessionCheckpoint({ ...base, hasCurrentTrack: false }),
	).toBe(false);
	expect(
		shouldCaptureSessionCheckpoint({
			...base,
			updaterQuiescenceOwnsCheckpoint: true,
		}),
	).toBe(false);

	// 节流窗口内（<2500ms）：即使正在播放或位置前进也不捕获（上游为固定节流）。
	const saved = {
		...base,
		lastSavedAtMs: 9_000,
		isPlaying: false,
		positionChangedSinceLastSave: false,
	};
	expect(shouldCaptureSessionCheckpoint(saved)).toBe(false);
	expect(shouldCaptureSessionCheckpoint({ ...saved, isPlaying: true })).toBe(false);
	expect(
		shouldCaptureSessionCheckpoint({
			...saved,
			positionChangedSinceLastSave: true,
		}),
	).toBe(false);
	// 超过节流窗口且正在播放 → 捕获。
	expect(
		shouldCaptureSessionCheckpoint({ ...saved, nowMs: 12_600, isPlaying: true }),
	).toBe(true);
	// 超过节流窗口但暂停且位置未变 → 无进度不捕获。
	expect(
		shouldCaptureSessionCheckpoint({ ...saved, nowMs: 12_600 }),
	).toBe(false);
	// 超过节流窗口且位置前进（暂停 seek）→ 捕获。
	expect(
		shouldCaptureSessionCheckpoint({
			...saved,
			nowMs: 12_600,
			positionChangedSinceLastSave: true,
		}),
	).toBe(true);
});

test("flush capture bypasses the throttle but still respects ownership, track and change gates", () => {
	const base = {
		lastSavedAtMs: 9_000 as number | null,
		nowMs: 9_010,
		isPlaying: false,
		positionChangedSinceLastSave: false,
		hasCurrentTrack: true,
		updaterQuiescenceOwnsCheckpoint: false,
		forceFlush: true,
	} as const;
	// 无任何变化 → flush 不产生冗余保存。
	expect(shouldCaptureSessionCheckpoint(base)).toBe(false);
	expect(shouldCaptureSessionCheckpoint({ ...base, isPlaying: true })).toBe(true);
	expect(
		shouldCaptureSessionCheckpoint({
			...base,
			positionChangedSinceLastSave: true,
		}),
	).toBe(true);
	// 首次保存（lastSavedAtMs=null）允许 flush。
	expect(
		shouldCaptureSessionCheckpoint({ ...base, lastSavedAtMs: null }),
	).toBe(true);
	// flush 不能穿透 quiescence 所有权。
	expect(
		shouldCaptureSessionCheckpoint({
			...base,
			positionChangedSinceLastSave: true,
			updaterQuiescenceOwnsCheckpoint: true,
		}),
	).toBe(false);
});

test("envelope validation enforces schema and defaults autoplayOnStartup to false", () => {
	expect(validatedPlaybackSessionPayload(null).status).toBe("invalid");
	expect(validatedPlaybackSessionPayload([1]).status).toBe("invalid");
	expect(
		validatedPlaybackSessionPayload({ schema: "playback-session-persist-v2" }).status,
	).toBe("invalid");

	const checkpoint = {
		schema: "playback-exit-checkpoint-v1",
		operationId: "a".repeat(32),
		receipt: "b".repeat(32),
		queue: [],
		currentTrackIndex: null,
		currentTrackRef: "",
		capturedPlaybackIntentId: 0,
		positionMs: 0,
		durationMs: null,
		wasPlaying: false,
		mode: "loop",
		volume: 0.5,
		muted: false,
		sourceKind: "none",
		restartRestorable: true,
	} as const;
	const valid = validatedPlaybackSessionPayload({
		schema: PLAYBACK_SESSION_PERSIST_SCHEMA,
		savedAtMs: 1_724_000_000_000,
		checkpoint,
	});
	if (valid.status !== "valid") throw new Error("应通过校验");
	expect(valid.envelope.autoplayOnStartup).toBe(false);
	expect(validatedPlaybackSessionPayload({
		schema: PLAYBACK_SESSION_PERSIST_SCHEMA,
		savedAtMs: 1_724_000_000_000,
		autoplayOnStartup: "yes",
		checkpoint,
	}).status).toBe("invalid");
	expect(validatedPlaybackSessionPayload({
		schema: PLAYBACK_SESSION_PERSIST_SCHEMA,
		savedAtMs: -5,
		checkpoint,
	}).status).toBe("invalid");
});

test("capture builds an envelope snapshot from the live store", () => {
	usePlaybackStore.setState({
		currentTrack: makeTrack("capture-1"),
		playbackIntentId: 3,
		isPlaying: true,
		positionMs: 42_000,
		durationMs: 180_000,
		volume: 0.7,
		muted: false,
		mode: "loop",
		queue: [makeTrack("capture-1"), makeTrack("capture-2")],
	});
	const envelope = capturePlaybackSessionEnvelope({ nowMs: 5_000 });
	expect(envelope).not.toBeNull();
	expect(envelope?.schema).toBe(PLAYBACK_SESSION_PERSIST_SCHEMA);
	expect(envelope?.savedAtMs).toBe(5_000);
	expect(envelope?.autoplayOnStartup).toBe(false);
	expect(envelope?.checkpoint.currentTrackRef).toBe("netease:capture-1");
	expect(envelope?.checkpoint.positionMs).toBe(42_000);
	expect(envelope?.checkpoint.restartRestorable).toBe(true);

	// 空播放状态（无曲目）→ envelope 捕获退化为 none-source checkpoint，仍可持久化；
	// 这里断言其形态而非 null。
	resetStore();
	const idleEnvelope = capturePlaybackSessionEnvelope({ nowMs: 5_001 });
	expect(idleEnvelope?.checkpoint.sourceKind).toBe("none");
	expect(idleEnvelope?.checkpoint.currentTrackIndex).toBeNull();
	// 无效时钟输入 → 拒绝构建。
	expect(capturePlaybackSessionEnvelope({ nowMs: -1 })).toBeNull();
});

test("restart simulation restores queue/current/position/volume/mode into a fresh store", () => {
	// —— 第一次“进程”：播放中的会话被节流捕获并持久化。
	usePlaybackStore.setState({
		currentTrack: makeTrack("song-a"),
		playbackIntentId: 7,
		isPlaying: true,
		positionMs: 61_500,
		durationMs: 200_000,
		volume: 0.33,
		muted: true,
		mode: "queue",
		queue: [makeTrack("song-a"), makeTrack("song-b"), makeTrack("song-c")],
	});
	const envelope = capturePlaybackSessionEnvelope({
		nowMs: 100_000,
		autoplayOnStartup: true,
	});
	expect(envelope).not.toBeNull();

	// —— 第二次“进程”：全新空 store，启动时 load + restore。
	resetStore();
	const result = applyStartupPlaybackSessionPayload(envelope);
	expect(result).toEqual({ restored: true, autoplayOnStartup: true });

	const state = usePlaybackStore.getState();
	expect(state.queue.map((track) => track.id)).toEqual(["song-a", "song-b", "song-c"]);
	expect(state.currentTrack?.id).toBe("song-a");
	expect(state.positionMs).toBe(61_500);
	expect(state.volume).toBe(0.33);
	expect(state.muted).toBe(true);
	expect(state.mode).toBe("queue");
	expect(state.isPlaying).toBe(true);
	expect(state.checkpointRestore).not.toBeNull();
	expect(state.checkpointRestore?.currentTrackRef).toBe("netease:song-a");
	expect(state.checkpointRestore?.autoplayDispositionConsumed).toBe(false);
	// 既有 consumeCheckpointAutoplay 语义可用：exact identity 消费成功。
	expect(
		state.consumePlaybackCheckpointAutoplay({
			operationId: envelope!.checkpoint.operationId,
			receipt: envelope!.checkpoint.receipt,
			playbackIntentId: state.playbackIntentId,
			currentTrackRef: "netease:song-a",
		}),
	).toBe(true);
});

test("autoplayOnStartup default false restores UI paused by zeroing wasPlaying on a copy", () => {
	usePlaybackStore.setState({
		currentTrack: makeTrack("paused-song"),
		playbackIntentId: 4,
		isPlaying: true,
		positionMs: 12_345,
		durationMs: 90_000,
		volume: 0.6,
		muted: false,
		mode: "loop",
		queue: [makeTrack("paused-song")],
	});
	const envelope = capturePlaybackSessionEnvelope({ nowMs: 200_000 });
	expect(envelope?.autoplayOnStartup).toBe(false);

	resetStore();
	const result = applyStartupPlaybackSessionPayload(envelope);
	expect(result.restored).toBe(true);

	const state = usePlaybackStore.getState();
	expect(state.currentTrack?.id).toBe("paused-song");
	expect(state.positionMs).toBe(12_345);
	// envelope 缺省 false → 保持暂停；checkpoint 原始对象未被改动（frozen schema）。
	expect(state.isPlaying).toBe(false);
	expect(envelope?.checkpoint.wasPlaying).toBe(true);
});

test("invalid persisted payloads are rejected without touching the store", () => {
	const before = usePlaybackStore.getState().playbackIntentId;
	expect(applyStartupPlaybackSessionPayload(null).restored).toBe(false);
	expect(applyStartupPlaybackSessionPayload(undefined).restored).toBe(false);
	expect(
		applyStartupPlaybackSessionPayload({ schema: PLAYBACK_SESSION_PERSIST_SCHEMA })
		.restored,
	).toBe(false);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(before);
});

interface RuntimeHarness {
	runtime: ReturnType<typeof createPlaybackSessionPersistenceRuntime>;
	emitStoreEvent(): void;
	setSnapshot(snapshot: { isPlaying: boolean; positionMs: number; hasCurrentTrack: boolean }): void;
	advanceClock(ms: number): void;
	saved(): unknown[];
	warnings(): string[];
	setSaveResult(result: { ok: boolean; reason?: string }): void;
	setQuiescenceOwned(owned: boolean): void;
	setCaptureResult(value: unknown | null): void;
}

function createHarness(): RuntimeHarness {
	let listener: (() => void) | null = null;
	let snapshot = { isPlaying: false, positionMs: 1_000, hasCurrentTrack: true };
	let nowMs = 10_000;
	let saveResult: { ok: boolean; reason?: string } = { ok: true };
	let quiescenceOwned = false;
	let captureResult: unknown | null = {};
	const savedEnvelopes: unknown[] = [];
	const warningLog: string[] = [];
	const runtime = createPlaybackSessionPersistenceRuntime({
		subscribeStore(nextListener) {
			listener = nextListener;
			return () => {
				listener = null;
			};
		},
		readSnapshot: () => ({ ...snapshot }),
		isQuiescenceOwned: () => quiescenceOwned,
		capture: () => captureResult,
		async save(envelope) {
			savedEnvelopes.push(envelope);
			await Promise.resolve();
			return saveResult.ok
				? { ok: true }
				: { ok: false, reason: saveResult.reason ?? "REJECTED" };
		},
		now: () => nowMs,
		onWarning: (message) => warningLog.push(message),
	});
	return {
		runtime,
		emitStoreEvent() {
			listener?.();
		},
		setSnapshot(next) {
			snapshot = next;
		},
		advanceClock(ms: number) {
			nowMs += ms;
		},
		saved: () => savedEnvelopes,
		warnings: () => warningLog,
		setSaveResult(result) {
			saveResult = result;
		},
		setQuiescenceOwned(owned) {
			quiescenceOwned = owned;
		},
		setCaptureResult(value) {
			captureResult = value;
		},
	};
}

test("persistence runtime throttles periodic captures to >=2500ms while playing", async () => {
	const harness = createHarness();

	// 初始即播放：首个事件触发首次保存（lastSavedAtMs=null 放行）。
	harness.setSnapshot({ isPlaying: true, positionMs: 1_500, hasCurrentTrack: true });
	harness.emitStoreEvent();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.saved().length).toBe(1);

	// 2.5 秒内的后续事件全部被节流。
	harness.advanceClock(2_400);
	harness.setSnapshot({ isPlaying: true, positionMs: 3_900, hasCurrentTrack: true });
	harness.emitStoreEvent();
	harness.emitStoreEvent();
	await Promise.resolve();
	expect(harness.saved().length).toBe(1);

	// 跨过节流窗口后放行下一次。
	harness.advanceClock(200);
	harness.emitStoreEvent();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.saved().length).toBe(2);
	harness.runtime.dispose();
});

test("pagehide flush bypasses throttle but skips no-change and quiescence-owned states", async () => {
	const harness = createHarness();

	// 首次保存建立 lastSaved 簿记。
	harness.setSnapshot({ isPlaying: true, positionMs: 2_000, hasCurrentTrack: true });
	harness.emitStoreEvent();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.saved().length).toBe(1);

	// 节流内、暂停且无变化 → flush 不写。
	harness.advanceClock(10);
	harness.setSnapshot({ isPlaying: false, positionMs: 2_000, hasCurrentTrack: true });
	harness.runtime.flushOnUnload();
	await Promise.resolve();
	expect(harness.saved().length).toBe(1);

	// 节流内但位置前进 → flush 写入。
	harness.advanceClock(10);
	harness.setSnapshot({ isPlaying: false, positionMs: 9_500, hasCurrentTrack: true });
	harness.runtime.flushOnUnload();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.saved().length).toBe(2);

	// quiescence 持有所有权 → 连 flush 也跳过。
	harness.advanceClock(10);
	harness.setSnapshot({ isPlaying: false, positionMs: 20_000, hasCurrentTrack: true });
	harness.setQuiescenceOwned(true);
	harness.runtime.flushOnUnload();
	await Promise.resolve();
	expect(harness.saved().length).toBe(2);
	harness.runtime.dispose();
});

test("in-flight saves dedupe concurrent triggers and failures only warn", async () => {
	const harness = createHarness();
	harness.setSnapshot({ isPlaying: true, positionMs: 1_000, hasCurrentTrack: true });

	// capture 返回 null → 不调用 save，也不阻塞后续尝试。
	harness.setCaptureResult(null);
	harness.emitStoreEvent();
	await Promise.resolve();
	expect(harness.saved().length).toBe(0);

	harness.setCaptureResult({ envelope: 1 });
	harness.emitStoreEvent();
	// save 尚未 resolve 前的并发触发必须被 in-flight 去重。
	harness.advanceClock(60_000);
	harness.emitStoreEvent();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.saved().length).toBe(1);

	// 失败只 console.warn，簿记不推进，下一事件可重试。
	harness.advanceClock(3_000);
	harness.setSaveResult({ ok: false, reason: "PLAYBACK_SESSION_CHECKPOINT_TOO_LARGE" });
	harness.setSnapshot({ isPlaying: true, positionMs: 8_000, hasCurrentTrack: true });
	harness.emitStoreEvent();
	await Promise.resolve();
	await Promise.resolve();
	expect(harness.warnings().length).toBe(1);
	expect(harness.saved().length).toBe(2);
	harness.runtime.dispose();
});
