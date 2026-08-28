import { beforeEach, expect, test } from "bun:test";
import { usePlayerShellStore } from "./player-shell-store";

beforeEach(() => {
	usePlayerShellStore.setState({
		controlsAutoHide: true,
		immersiveMode: false,
		lyricOffsets: {},
	});
});

test("controlsAutoHide toggles independently of playback state", () => {
	expect(usePlayerShellStore.getState().controlsAutoHide).toBe(true);
	usePlayerShellStore.getState().toggleControlsAutoHide();
	expect(usePlayerShellStore.getState().controlsAutoHide).toBe(false);
	usePlayerShellStore.getState().setControlsAutoHide(true);
	expect(usePlayerShellStore.getState().controlsAutoHide).toBe(true);
});

test("immersiveMode toggles and can be force-set", () => {
	usePlayerShellStore.getState().toggleImmersiveMode();
	expect(usePlayerShellStore.getState().immersiveMode).toBe(true);
	usePlayerShellStore.getState().setImmersiveMode(false);
	expect(usePlayerShellStore.getState().immersiveMode).toBe(false);
});

test("lyricOffsets map is track-scoped replaceable state", () => {
	usePlayerShellStore.getState().setLyricOffsets({
		"netease:1": { offset: 0.1, updatedAt: 1, title: "t", artist: "a" },
	});
	expect(
		usePlayerShellStore.getState().lyricOffsets["netease:1"]?.offset,
	).toBe(0.1);
});