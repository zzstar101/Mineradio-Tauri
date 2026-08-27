import { beforeEach, expect, test } from "bun:test";
import sharedCheckpointFixture from "../../../desktop/src-tauri/src/runtime/updater/fixtures/playback-exit-checkpoint-v1.json";
import {
	MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE,
	moveTrackToFront,
	usePlaybackStore,
} from "./playback-store";
import type { Track } from "@mineradio/shared";

const RECEIPT_A = "00000000000000000000000000000001";
const RECEIPT_B = "00000000000000000000000000000002";
const RECEIPT_C = "00000000000000000000000000000003";

function operationId(value: number): string {
	return value.toString(16).padStart(32, "0");
}

function makeTrack(id: string): Track {
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: id,
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

test("setCurrentTrack sets the track and toggles play", () => {
	const store = usePlaybackStore.getState();
	store.setCurrentTrack(makeTrack("a"));
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
	store.setPlaying(true);
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
	store.setPlaying(false);
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
	store.togglePlay();
	expect(usePlaybackStore.getState().isPlaying).toBe(true);
});

test("next in queue mode advances and stops at the end", () => {
	const a = makeTrack("a");
	const b = makeTrack("b");
	usePlaybackStore.getState().setMode("queue");
	usePlaybackStore.getState().enqueue(a);
	usePlaybackStore.getState().enqueue(b);
	usePlaybackStore.getState().setCurrentTrack(a);
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	usePlaybackStore.getState().next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("default playback mode follows baseline loop mode", () => {
	expect(usePlaybackStore.getState().mode).toBe("loop");
});

test("setQueue replaces the queue and playAt jumps to a specific track", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	const c = makeTrack("c");
	store.setQueue([a, b, c]);
	expect(usePlaybackStore.getState().queue.length).toBe(3);
	store.playAt(2);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	expect(usePlaybackStore.getState().positionMs).toBe(0);
});

test("next cycles a three-track queue in loop mode and previous wraps", () => {
	usePlaybackStore.getState().setMode("loop");
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(0);
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous wraps from idx 0 in queue mode like the baseline control", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(0);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in single mode stays on the same track", () => {
	usePlaybackStore.getState().setMode("single");
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(1);
	store.previous();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("previous in shuffle mode stays within bounds", () => {
	usePlaybackStore.getState().setMode("shuffle");
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
	store.playAt(2);
	const before = 2;
	store.previous();
	const idx = usePlaybackStore.getState().queue.findIndex(
		(t) => t.id === usePlaybackStore.getState().currentTrack?.id,
	);
	expect(idx).toBeGreaterThanOrEqual(0);
	expect(idx).toBeLessThan(3);
	void before;
});

test("insertAt inserts a track at the given index", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a"), makeTrack("c")]);
	store.insertAt(1, makeTrack("b"));
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("a,b,c");
});

test("insertNext dedupes and moves an existing later track after the current track", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c"), makeTrack("d")];
	store.setQueue(tracks);
	store.playAt(0);
	store.insertNext(tracks[2]);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("a,c,b,d");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("a");
});

test("insertNext dedupes and preserves current track when moving an earlier item", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(2);
	store.insertNext(tracks[0]);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("b,c,a");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
});

test("insertNext appends without auto-start when there is no current track", () => {
	const store = usePlaybackStore.getState();
	store.insertNext(makeTrack("a"));
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["a"]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("removeAt removes tracks and advances current track identity safely", () => {
	const store = usePlaybackStore.getState();
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	store.setQueue(tracks);
	store.playAt(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().queue.map((t) => t.id).join(",")).toBe("b,c");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	store.removeAt(0);
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["c"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("c");
});

test("removeTrack removes every matching track reference", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	store.setQueue([a, b, makeTrack("a")]);
	store.playAt(0);
	store.removeTrack(a);
	expect(usePlaybackStore.getState().queue.map((t) => t.id)).toEqual(["b"]);
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
});

test("clearQueue clears current playback timing state", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("a")]);
	store.playAt(0);
	store.togglePlay();
	store.setPosition(1200);
	store.setDuration(5000);
	store.clearQueue();
	expect(usePlaybackStore.getState().queue).toEqual([]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().positionMs).toBe(0);
	expect(usePlaybackStore.getState().durationMs).toBeNull();
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("volume and mute controls clamp values like the baseline console", () => {
	const store = usePlaybackStore.getState();
	store.setVolume(1.8);
	expect(usePlaybackStore.getState().volume).toBe(1);
	expect(usePlaybackStore.getState().muted).toBe(false);
	store.setVolume(0);
	expect(usePlaybackStore.getState().volume).toBe(0);
	expect(usePlaybackStore.getState().muted).toBe(true);
	store.toggleMute();
	expect(usePlaybackStore.getState().muted).toBe(false);
});

test("next in single mode restarts the current track", () => {
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([makeTrack("a"), makeTrack("b")]);
	store.playAt(1);
	store.setPosition(1200);
	store.next();
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	expect(usePlaybackStore.getState().positionMs).toBe(0);
});

test("shuffle next keeps selection in bounds and avoids the same track when possible", () => {
	const originalRandom = Math.random;
	Math.random = () => 0;
	try {
		const store = usePlaybackStore.getState();
		store.setMode("shuffle");
		store.setQueue([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
		store.playAt(0);
		store.next();
		expect(usePlaybackStore.getState().currentTrack?.id).toBe("b");
	} finally {
		Math.random = originalRandom;
	}
});

test("moveTrackToFront dedupes by provider and id", () => {
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("a")];
	const result = moveTrackToFront(tracks, makeTrack("a"));
	expect(result.map((t) => t.id)).toEqual(["a", "b"]);
});

test("playback intent starts at zero and advances for every setCurrentTrack call", () => {
	const track = makeTrack("a");
	const store = usePlaybackStore.getState();
	expect(store.playbackIntentId).toBe(0);
	store.setCurrentTrack(track);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.setCurrentTrack(track);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	store.setCurrentTrack(null);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("valid playAt and queue navigation advance playback intent", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.next();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
	store.previous();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("single ended restarts playback with a new intent", () => {
	const track = makeTrack("a");
	const store = usePlaybackStore.getState();
	store.setMode("single");
	store.setQueue([track]);
	store.playAt(0);
	store.setPosition(1200);
	store.ended();
	expect(usePlaybackStore.getState().currentTrack).toBe(track);
	expect(usePlaybackStore.getState().positionMs).toBe(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("non-single ended delegates to next with exactly one new intent", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	store.ended();
	expect(usePlaybackStore.getState().currentTrack).toBe(tracks[1]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("clearQueue emits a stop intent even when the queue is already empty", () => {
	const store = usePlaybackStore.getState();
	store.clearQueue();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.clearQueue();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("next emits stop intents for an empty queue and the end of queue mode", () => {
	const store = usePlaybackStore.getState();
	store.next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);

	const track = makeTrack("a");
	store.setMode("queue");
	store.setQueue([track]);
	store.playAt(0);
	store.next();
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(3);
});

test("removing the current item advances intent while removing another item does not", () => {
	const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.removeAt(0);
	expect(usePlaybackStore.getState().currentTrack).toBe(tracks[2]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("removeTrack only advances intent when it removes the current track", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(0);
	store.removeTrack(tracks[1]);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(1);
	store.removeTrack(tracks[0]);
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(2);
});

test("invalid playAt and previous without a queue do not advance intent", () => {
	const store = usePlaybackStore.getState();
	store.playAt(-1);
	store.playAt(0);
	store.previous();
	expect(usePlaybackStore.getState().playbackIntentId).toBe(0);
});

test("previous without a queue does not notify subscribers", () => {
	let notifications = 0;
	const unsubscribe = usePlaybackStore.subscribe(() => {
		notifications += 1;
	});
	try {
		usePlaybackStore.getState().previous();
		expect(notifications).toBe(0);
	} finally {
		unsubscribe();
	}
});

test("non-playback state and queue edits do not advance intent", () => {
	const store = usePlaybackStore.getState();
	const a = makeTrack("a");
	const b = makeTrack("b");
	store.setPlaying(true);
	store.togglePlay();
	store.setPosition(100);
	store.setDuration(200);
	store.setVolume(0.5);
	store.toggleMute();
	store.setMode("queue");
	store.setQueue([a]);
	store.enqueue(b);
	store.insertAt(1, makeTrack("c"));
	store.insertNext(makeTrack("d"));
	expect(usePlaybackStore.getState().playbackIntentId).toBe(0);
});

test("replaceCurrentSource 原子替换当前队列项并保留位置", () => {
	const original = makeTrack("original");
	const next = makeTrack("next");
	const candidate = { ...original, provider: "qq" as const, id: "qq-source" };
	const store = usePlaybackStore.getState();
	store.setQueue([original, next]);
	store.playAt(0);
	store.setPosition(54_321);
	const expectedIntent = usePlaybackStore.getState().playbackIntentId;

	const committed = usePlaybackStore.getState().replaceCurrentSource({
		candidate,
		expectedPlaybackIntentId: expectedIntent,
		preservePositionMs: 54_321,
	});

	expect(committed).toBe(true);
	const state = usePlaybackStore.getState();
	expect(state.queue[0]).toBe(candidate);
	expect(state.queue[1]).toBe(next);
	expect(state.currentTrack).toBe(candidate);
	expect(state.positionMs).toBe(54_321);
	expect(state.playbackIntentId).toBe(expectedIntent + 1);
});

test("replaceCurrentSource 拒绝过期 intent 且不改变队列", () => {
	const original = makeTrack("original");
	const candidate = { ...original, provider: "qq" as const, id: "qq-source" };
	const store = usePlaybackStore.getState();
	store.setQueue([original]);
	store.playAt(0);
	const before = usePlaybackStore.getState();

	const committed = store.replaceCurrentSource({
		candidate,
		expectedPlaybackIntentId: before.playbackIntentId - 1,
		preservePositionMs: 5_000,
	});

	expect(committed).toBe(false);
	expect(usePlaybackStore.getState().queue).toEqual(before.queue);
	expect(usePlaybackStore.getState().currentTrack).toBe(before.currentTrack);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(before.playbackIntentId);
});

test("prepared handoff 只为当前 owner 原子提交相邻候选一次", () => {
	const outgoing = makeTrack("outgoing");
	const incoming = makeTrack("incoming");
	const tail = makeTrack("tail");
	const store = usePlaybackStore.getState();
	store.setQueue([outgoing, incoming, tail]);
	store.playAt(0);
	const expectedIntent = usePlaybackStore.getState().playbackIntentId;

	const committed = usePlaybackStore.getState().commitPreparedHandoff({
		candidate: incoming,
		expectedPlaybackIntentId: expectedIntent,
		expectedOutgoingTrackRef: "netease:outgoing",
	});

	expect(committed).toBe(true);
	const state = usePlaybackStore.getState();
	expect(state.currentTrack).toBe(incoming);
	expect(state.positionMs).toBe(0);
	expect(state.isPlaying).toBe(true);
	expect(state.playbackIntentId).toBe(expectedIntent + 1);

	// 旧 handoff 即使重复完成，也不能再次推进队列或 intent。
	expect(usePlaybackStore.getState().commitPreparedHandoff({
		candidate: incoming,
		expectedPlaybackIntentId: expectedIntent,
		expectedOutgoingTrackRef: "netease:outgoing",
	})).toBe(false);
	expect(usePlaybackStore.getState().currentTrack).toBe(incoming);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(expectedIntent + 1);
});

test("prepared handoff 拒绝非相邻候选并保留当前 owner", () => {
	const outgoing = makeTrack("outgoing");
	const incoming = makeTrack("incoming");
	const wrong = makeTrack("wrong");
	const store = usePlaybackStore.getState();
	store.setQueue([outgoing, incoming, wrong]);
	store.playAt(0);
	const before = usePlaybackStore.getState();

	expect(store.commitPreparedHandoff({
		candidate: wrong,
		expectedPlaybackIntentId: before.playbackIntentId,
		expectedOutgoingTrackRef: "netease:outgoing",
	})).toBe(false);
	expect(usePlaybackStore.getState().currentTrack).toBe(outgoing);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(before.playbackIntentId);
});

test("update-exit checkpoint captures exact queue identity and restart source capability", () => {
	const tracks = [makeTrack("a"), makeTrack("b")];
	const store = usePlaybackStore.getState();
	store.setQueue(tracks);
	store.playAt(1);
	store.setPlaying(false);
	store.setPosition(12_345);

	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(1),
		receipt: RECEIPT_A,
		sourceKind: "blob",
	});

	expect(checkpoint).not.toBeNull();
	expect(checkpoint?.schema).toBe("playback-exit-checkpoint-v1");
	expect(checkpoint?.currentTrackIndex).toBe(1);
	expect(checkpoint?.currentTrackRef).toBe("netease:b");
	expect(checkpoint?.wasPlaying).toBe(false);
	expect(checkpoint?.sourceKind).toBe("blob");
	expect(checkpoint?.restartRestorable).toBe(false);
	expect(checkpoint?.queue.map((track) => track.id)).toEqual(["a", "b"]);
	expect(checkpoint?.volume).toBe(0.84);
	expect(checkpoint?.muted).toBe(false);
});

test("checkpoint captures a deep immutable bounded track DTO without persisted URLs", () => {
	const track = {
		...makeTrack("safe"),
		title: "before",
		artists: ["artist"],
		coverUrl: "https://covers.example/image.jpg?token=secret-value",
		qualityHints: ["standard"],
	};
	const store = usePlaybackStore.getState();
	store.setQueue([track]);
	store.playAt(0);
	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(2),
		receipt: "0123456789abcdef0123456789abcdef",
		sourceKind: "remote",
	});
	expect(checkpoint).not.toBeNull();
	track.title = "after";
	track.artists[0] = "mutated";
	track.qualityHints[0] = "lossless";

	const captured = checkpoint?.queue[0] as unknown as Record<string, unknown>;
	expect(captured.title).toBe("before");
	expect(captured.artists).toEqual(["artist"]);
	expect(captured.qualityHints).toEqual(["standard"]);
	expect(captured.coverUrl).toBe(undefined);
	expect(JSON.stringify(checkpoint)).not.toContain("secret-value");
	expect(Object.isFrozen(captured)).toBe(true);
	expect(Object.isFrozen(captured.artists)).toBe(true);
});

test("stream source and Kugou tracks survive checkpoint restart restore", () => {
	const kugouTrack: Track = {
		...makeTrack("kugou-tail"),
		provider: "kugou",
	};
	const sourceStore = usePlaybackStore.getState();
	sourceStore.setQueue([kugouTrack]);
	sourceStore.playAt(0);
	sourceStore.setStreamSource({ provider: "kugou", id: "radio-42" });
	const checkpoint = sourceStore.capturePlaybackExitCheckpoint({
		operationId: operationId(33),
		receipt: RECEIPT_A,
		sourceKind: "remote",
	})!;

	expect(checkpoint.queue[0]?.provider).toBe("kugou");
	expect(checkpoint.streamSource).toEqual({ provider: "kugou", id: "radio-42" });
	expect(Object.isFrozen(checkpoint.streamSource)).toBe(true);

	resetStore();
	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		operationId: checkpoint.operationId,
		receipt: checkpoint.receipt,
		mode: "restart-reconciliation",
		checkpoint,
	})).toBe("restored");
	const restored = usePlaybackStore.getState();
	expect(restored.currentTrack?.provider).toBe("kugou");
	expect(restored.streamSource).toEqual({ provider: "kugou", id: "radio-42" });
});

test("update-exit checkpoint fails closed above the bounded queue limit", () => {
	const queue = Array.from(
		{ length: MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE + 1 },
		(_, index) => makeTrack(String(index)),
	);
	const store = usePlaybackStore.getState();
	store.setQueue(queue);
	store.playAt(0);

	expect(store.capturePlaybackExitCheckpoint({
		operationId: operationId(3),
		receipt: RECEIPT_B,
		sourceKind: "remote",
	})).toBeNull();
});

test("checkpoint fails closed when bounded fields exceed the total serialized byte limit", () => {
	const queue = Array.from({ length: MAX_PLAYBACK_EXIT_CHECKPOINT_QUEUE }, (_, index) => ({
		...makeTrack(String(index)),
		title: "题".repeat(512),
		album: "专".repeat(512),
		artists: Array.from({ length: 16 }, () => "艺".repeat(256)),
		qualityHints: Array.from({ length: 16 }, () => "q".repeat(64)),
	}));
	const store = usePlaybackStore.getState();
	store.setQueue(queue);
	store.playAt(0);
	expect(store.capturePlaybackExitCheckpoint({
		operationId: operationId(4),
		receipt: RECEIPT_C,
		sourceKind: "remote",
	})).toBeNull();
});

test("checkpoint playback intent follows the exact committed owner lease", () => {
	const track = makeTrack("owner");
	const store = usePlaybackStore.getState();
	store.setQueue([track]);
	store.playAt(0);
	store.setPlaying(false);

	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(5),
		receipt: RECEIPT_C,
		sourceKind: "remote",
		ownerOriginallyPlaying: true,
	});

	expect(checkpoint?.wasPlaying).toBe(true);
});

test("checkpoint playback intent is validated as an identity counter, not media duration", () => {
	const track = makeTrack("long-lived-owner");
	usePlaybackStore.setState({
		queue: [track],
		currentTrack: track,
		playbackIntentId: 700_000_000,
		isPlaying: true,
	});
	const checkpoint = usePlaybackStore.getState().capturePlaybackExitCheckpoint({
		operationId: operationId(31),
		receipt: RECEIPT_A,
		sourceKind: "remote",
	})!;

	resetStore();
	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		operationId: checkpoint.operationId,
		receipt: checkpoint.receipt,
		mode: "restart-reconciliation",
		checkpoint,
	})).toBe("restored");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("long-lived-owner");

	usePlaybackStore.setState({ playbackIntentId: Number.MAX_SAFE_INTEGER + 1 });
	expect(usePlaybackStore.getState().capturePlaybackExitCheckpoint({
		operationId: operationId(32),
		receipt: RECEIPT_B,
		sourceKind: "remote",
	})).toBeNull();
});

test("checkpoint restore is one atomic paused transition bound to operation and receipt", () => {
	const queue = [makeTrack("a"), makeTrack("b")];
	const sourceStore = usePlaybackStore.getState();
	sourceStore.setQueue(queue);
	sourceStore.playAt(1);
	sourceStore.setPlaying(false);
	sourceStore.setPosition(22_000);
	const checkpoint = sourceStore.capturePlaybackExitCheckpoint({
		operationId: operationId(6),
		receipt: RECEIPT_A,
		sourceKind: "remote",
	})!;

	resetStore();
	let notifications = 0;
	const unsubscribe = usePlaybackStore.subscribe(() => {
		notifications += 1;
	});
	try {
		expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
			operationId: operationId(6),
			receipt: RECEIPT_A,
			mode: "restart-reconciliation",
			checkpoint,
		})).toBe("restored");
	} finally {
		unsubscribe();
	}

	const restored = usePlaybackStore.getState();
	expect(notifications).toBe(1);
	expect(restored.queue.map((track) => track.id)).toEqual(["a", "b"]);
	expect(restored.currentTrack?.id).toBe("b");
	expect(restored.positionMs).toBe(22_000);
	expect(restored.isPlaying).toBe(false);
	expect(restored.checkpointRestore).toEqual({
		operationId: operationId(6),
		receipt: RECEIPT_A,
		playbackIntentId: restored.playbackIntentId,
		currentTrackRef: "netease:b",
		wasPlaying: false,
		sourceKind: "remote",
		restartRestorable: true,
		autoplayDispositionConsumed: false,
	});
});

test("Web restore accepts the shared Rust checkpoint fixture without persisted controller generation or URLs", () => {
	const raw = JSON.stringify(sharedCheckpointFixture);
	expect(raw).not.toContain("operationGeneration");
	expect(raw).not.toContain("coverUrl");
	expect(raw).not.toContain("http://");
	expect(raw).not.toContain("https://");
	const checkpoint = JSON.parse(raw);

	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		operationId: "11111111111111111111111111111111",
		receipt: "22222222222222222222222222222222",
		mode: "restart-reconciliation",
		checkpoint,
	})).toBe("restored");
	const restored = usePlaybackStore.getState();
	expect(restored.queue.map((track) => track.id)).toEqual(["song-1", "song-2"]);
	expect(restored.currentTrack?.id).toBe("song-1");
	expect(restored.positionMs).toBe(12_345.5);
	expect(restored.isPlaying).toBe(true);
	expect(restored.streamSource).toBeNull();
});

test("checkpoint restore is idempotent and rejects conflicting or forged identity", () => {
	const store = usePlaybackStore.getState();
	const queue = [makeTrack("a")];
	store.setQueue(queue);
	store.playAt(0);
	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(7),
		receipt: RECEIPT_B,
		sourceKind: "remote",
	})!;
	resetStore();
	const request = {
		operationId: operationId(7),
		receipt: RECEIPT_B,
		mode: "restart-reconciliation",
		checkpoint,
	} as const;

	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint(request)).toBe("restored");
	const first = usePlaybackStore.getState();
	let notifications = 0;
	const unsubscribe = usePlaybackStore.subscribe(() => {
		notifications += 1;
	});
	try {
		expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint(request)).toBe("already-restored");
		expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
			...request,
			receipt: RECEIPT_C,
		})).toBe("rejected");
		const forged = {
			...checkpoint,
			currentTrackRef: "netease:forged",
		};
		expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
			operationId: operationId(8),
			receipt: checkpoint.receipt,
			mode: "restart-reconciliation",
			checkpoint: forged,
		})).toBe("rejected");
	} finally {
		unsubscribe();
	}
	expect(notifications).toBe(0);
	expect(usePlaybackStore.getState().playbackIntentId).toBe(first.playbackIntentId);
});

test("restart reconciliation rejects non-restorable sources while same-process rollback remains exact", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("local")]);
	store.playAt(0);
	store.setPlaying(false);
	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(9),
		receipt: RECEIPT_A,
		sourceKind: "blob",
	})!;
	resetStore();
	const request = {
		operationId: checkpoint.operationId,
		receipt: checkpoint.receipt,
		checkpoint,
	} as const;
	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		...request,
		mode: "restart-reconciliation",
	})).toBe("rejected");
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		...request,
		mode: "same-process-rollback",
	})).toBe("restored");
	expect(usePlaybackStore.getState().currentTrack?.id).toBe("local");
	expect(usePlaybackStore.getState().isPlaying).toBe(false);
});

test("strict checkpoint restore rejects malformed booleans, receipts, and track payloads", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("strict")]);
	store.playAt(0);
	expect(store.capturePlaybackExitCheckpoint({
		operationId: operationId(10),
		receipt: "not-random",
		sourceKind: "remote",
	})).toBeNull();
	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(11),
		receipt: RECEIPT_B,
		sourceKind: "remote",
	})!;
	resetStore();
	for (const malformed of [
		{ ...checkpoint, wasPlaying: "false" },
		{ ...checkpoint, muted: "false" },
		{ ...checkpoint, queue: [{ ...checkpoint.queue[0], artists: "artist" }] },
		{ ...checkpoint, streamSource: null },
		{ ...checkpoint, streamSource: { provider: "unknown", id: "radio" } },
		{ ...checkpoint, streamSource: { provider: "netease", id: "" } },
		{ ...checkpoint, streamSource: { provider: "netease", id: "x".repeat(513) } },
	] as unknown as typeof checkpoint[]) {
		expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
			operationId: checkpoint.operationId,
			receipt: checkpoint.receipt,
			mode: "restart-reconciliation",
			checkpoint: malformed,
		})).toBe("rejected");
	}
	expect(usePlaybackStore.getState().currentTrack).toBeNull();
});

test("paused checkpoint autoplay disposition is consumed once by exact identity", () => {
	const store = usePlaybackStore.getState();
	store.setQueue([makeTrack("paused")]);
	store.playAt(0);
	store.setPlaying(false);
	const checkpoint = store.capturePlaybackExitCheckpoint({
		operationId: operationId(12),
		receipt: RECEIPT_C,
		sourceKind: "remote",
	})!;
	resetStore();
	expect(usePlaybackStore.getState().restorePlaybackExitCheckpoint({
		operationId: checkpoint.operationId,
		receipt: checkpoint.receipt,
		mode: "restart-reconciliation",
		checkpoint,
	})).toBe("restored");
	const authority = usePlaybackStore.getState().checkpointRestore!;
	const consume = {
		operationId: authority.operationId,
		receipt: authority.receipt,
		playbackIntentId: authority.playbackIntentId,
		currentTrackRef: authority.currentTrackRef,
	};
	expect(usePlaybackStore.getState().consumePlaybackCheckpointAutoplay(consume)).toBe(true);
	expect(usePlaybackStore.getState().checkpointRestore?.autoplayDispositionConsumed)
		.toBe(true);
	expect(usePlaybackStore.getState().consumePlaybackCheckpointAutoplay(consume)).toBe(true);
	expect(usePlaybackStore.getState().consumePlaybackCheckpointAutoplay({
		...consume,
		playbackIntentId: consume.playbackIntentId + 1,
	})).toBe(false);
});
