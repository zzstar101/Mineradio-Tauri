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

test("PlaybackSurface 在 feature 层构造音频设置 ReactNode 并注入音量面板", () => {
	const html = renderToStaticMarkup(
		<PlaybackSurface
			controlsProps={{ visible: true, onReveal: () => undefined }}
			audioSettings={audioSettingsFixture()}
		/>,
	);

	expect(html).toContain("volume-panel-extras");
	expect(html).toContain("playback-audio-settings");
	expect(html).toContain("音频设置");
});
