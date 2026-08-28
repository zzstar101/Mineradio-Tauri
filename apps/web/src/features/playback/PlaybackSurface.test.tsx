import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PLAYBACK_AUDIO_PREFERENCE } from "../../preferences/keys";
import { PlaybackSurface } from "./PlaybackSurface";
import type { PlaybackAudioSettingsResult } from "./usePlaybackAudioSettings";

function audioSettingsFixture(): PlaybackAudioSettingsResult {
	return {
		hydrated: true,
		busy: false,
		refreshing: false,
		controllerReady: true,
		outputSupported: true,
		routing: null,
		output: {
			primary: {
				deviceId: "",
				label: "系统默认输出",
				state: "ready-or-playing",
			},
			mirrors: [],
			bridge: null,
		},
		preference: PLAYBACK_AUDIO_PREFERENCE.defaultValue(),
		devices: [],
		error: null,
		setFadeInMs: async () => undefined,
		setFadeOutMs: async () => undefined,
		setGaplessEnabled: async () => undefined,
		setCrossfadeEnabled: async () => undefined,
		setPrimaryOutputId: async () => undefined,
		toggleMirrorOutput: async () => undefined,
		setVirtualBridgeSinkId: async () => undefined,
		handleControllerReady: async () => undefined,
		applyToController: async () => undefined,
		setPanelOpen: () => undefined,
		refreshDevices: async () => undefined,
	};
}

test("PlaybackSurface keeps Playback 2.0 audio settings out of the bottom-bar volume popover", () => {
	const html = renderToStaticMarkup(
		<PlaybackSurface
			controlsProps={{ visible: true, onReveal: () => undefined }}
			audioSettings={audioSettingsFixture()}
		/>,
	);

	// Wave 3: volume popover 只保留 upstream volume/fade；Playback 2.0 移到
	// Settings Workbench 的 advanced audio slot（App 注入），不再注入底栏。
	expect(html).not.toContain("volume-panel-extras");
	expect(html).not.toContain("playback-audio-settings");
	expect(html).toContain('id="volume-slider"');
	expect(html).toContain('id="fade-in-slider"');
	expect(html).toContain('id="fade-out-slider"');
});
