import { create } from "zustand";
import type { LyricTimingOffsetMap } from "../lyrics/lyric-timing";

/**
 * Wave 3 Player Shell transient + track-scoped state.
 *
 * - controlsAutoHide / immersiveMode: bottom-bar visibility policy (persisted
 *   through preferences by usePlayerShellRuntime).
 * - lyricOffsets: 按 track 的歌词时差映射（track-scoped），持久化走 preferences。
 *
 * 注意：不在这里保存 playback 状态；Bottom Bar 继续消费 canonical
 * playback/lyrics/ui stores，避免出现第二套 playback state。
 */
export interface PlayerShellState {
	controlsAutoHide: boolean;
	immersiveMode: boolean;
	lyricOffsets: LyricTimingOffsetMap;
	setControlsAutoHide: (enabled: boolean) => void;
	toggleControlsAutoHide: () => void;
	setImmersiveMode: (enabled: boolean) => void;
	toggleImmersiveMode: () => void;
	setLyricOffsets: (map: LyricTimingOffsetMap) => void;
}

export const usePlayerShellStore = create<PlayerShellState>()((set, get) => ({
	controlsAutoHide: true,
	immersiveMode: false,
	lyricOffsets: {},
	setControlsAutoHide: (enabled) => set({ controlsAutoHide: !!enabled }),
	toggleControlsAutoHide: () =>
		set({ controlsAutoHide: !get().controlsAutoHide }),
	setImmersiveMode: (enabled) => set({ immersiveMode: !!enabled }),
	toggleImmersiveMode: () => set({ immersiveMode: !get().immersiveMode }),
	setLyricOffsets: (map) => set({ lyricOffsets: map }),
}));