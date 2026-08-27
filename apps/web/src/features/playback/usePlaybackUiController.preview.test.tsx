import { beforeEach, expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Track } from "@mineradio/shared";
import { usePlaybackStore } from "../../stores/playback-store";
import {
	usePlaybackUiController,
	type PlaybackUiControllerResult,
} from "./usePlaybackUiController";

function track(provider: Track["provider"], id: string, playableState: Track["playableState"]): Track {
	return {
		provider,
		id,
		sourceId: id,
		title: id,
		artists: [],
		album: "",
		coverUrl: "",
		qualityHints: [],
		playableState,
	};
}

function resetPlaybackStore(): void {
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

async function mountController(): Promise<{
	controller: PlaybackUiControllerResult;
	dispose(): void;
}> {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const controllerRef: { current: PlaybackUiControllerResult | null } = { current: null };

	function Harness() {
		controllerRef.current = usePlaybackUiController({
			controllerRef: { current: null },
			lyricsPayloadRef: { current: null },
			playbackMode: "loop",
			setPositionMs: (position) => usePlaybackStore.getState().setPosition(position),
			setDurationMs: (duration) => usePlaybackStore.getState().setDuration(duration),
			setLyricsIndex: () => undefined,
			setMiniQueue: () => undefined,
			insertQueueNext: () => undefined,
			setPlaybackMode: () => undefined,
			setQueue: (tracks) => usePlaybackStore.getState().setQueue(tracks),
			clearQueue: () => usePlaybackStore.getState().clearQueue(),
			recordListenProgress: () => undefined,
			finalizeListenSession: () => undefined,
			enterPlaybackSurface: () => undefined,
			setHomeForcedOpen: () => undefined,
			setHomeSuppressed: () => undefined,
			clearCurrentBeatMap: () => undefined,
			applyCustomCoverImage: async () => undefined,
			showToast: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	return {
		controller: controllerRef.current!,
		dispose() {
			root.unmount();
			host.remove();
		},
	};
}

beforeEach(resetPlaybackStore);

test("equal-duration previews are re-evaluated for the new playback identity", async () => {
	const mounted = await mountController();
	const first = track("netease", "preview-a", "vip_required");
	const second = track("qq", "preview-b", "vip_required");
	const store = usePlaybackStore.getState();
	store.setQueue([first, second]);
	store.playAt(0);
	usePlaybackStore.getState().setPreviewRange({ startMs: 0, endMs: 30_000 });
	mounted.controller.handleRuntimeTimeUpdate({
		loadContext: null,
		sourceUrl: "preview-a",
		positionMs: 1_000,
		durationMs: 30_000,
	});
	expect(usePlaybackStore.getState().trialBanner?.provider).toBe("netease");

	usePlaybackStore.getState().playAt(1);
	usePlaybackStore.getState().setPreviewRange({ startMs: 0, endMs: 30_000 });
	mounted.controller.handleRuntimeTimeUpdate({
		loadContext: null,
		sourceUrl: "preview-b",
		positionMs: 1_000,
		durationMs: 30_000,
	});

	expect(usePlaybackStore.getState().trialBanner?.provider).toBe("qq");
	mounted.dispose();
});

test("switching from preview to a local or full source clears preview state atomically", async () => {
	const mounted = await mountController();
	const preview = track("netease", "preview", "vip_required");
	const local = track("netease", "local:file-1", "playable");
	usePlaybackStore.getState().setCurrentTrack(preview);
	usePlaybackStore.getState().setPreviewRange({ startMs: 0, endMs: 30_000 });
	mounted.controller.handleRuntimeTimeUpdate({
		loadContext: null,
		sourceUrl: "preview",
		positionMs: 1_000,
		durationMs: 30_000,
	});
	expect(usePlaybackStore.getState().trialBanner).not.toBeNull();

	usePlaybackStore.getState().setCurrentTrack(local);

	expect(usePlaybackStore.getState().previewRange).toBeNull();
	expect(usePlaybackStore.getState().trialBanner).toBeNull();
	mounted.dispose();
});
