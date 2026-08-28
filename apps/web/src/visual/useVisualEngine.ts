import { useEffect, useRef, type RefObject } from "react";
import {
	createVisualEngine,
	type AudioFrameSource,
	type LyricsVisualSnapshot,
	type PlaybackVisualSnapshot,
	type ShelfVisualSnapshot,
	type VisualEngineFacade,
	type VisualEngineOptions,
	type VisualPerformanceSnapshot,
	type VisualSettingsSnapshot,
} from "@mineradio/visual-engine";
import { getWindowState, isTauriRuntime, listenWindowState } from "../tauri/runtime";
import {
	createLegacyVisualComposition,
} from "./runtime/create-legacy-visual-composition";
import type { LegacyVisualEventSink } from "./runtime/legacy-visual-events";
import {
	createVisualEnvironmentAdapter,
	type VisualEnvironmentAdapter,
} from "./runtime/visual-environment-adapter";
import { createVisualMediaClock } from "./runtime/visual-snapshot-builders";

export * from "./runtime/create-legacy-visual-composition";

export interface UseVisualEngineInput {
	readonly hostRef: RefObject<HTMLDivElement | null>;
	readonly audioFrameSource: AudioFrameSource;
	readonly positionMs: number;
	readonly playbackVolume: number;
	readonly playbackSnapshot: PlaybackVisualSnapshot;
	readonly lyricsSnapshot: LyricsVisualSnapshot;
	readonly shelfSnapshot: ShelfVisualSnapshot;
	readonly settingsSnapshot: VisualSettingsSnapshot;
	readonly events: LegacyVisualEventSink;
	/** Wave 3: stage lyric 视图时钟偏移（秒），仅影响歌词 index。 */
	readonly lyricOffsetSeconds?: number;
	readonly performanceSnapshotReaderRef?: VisualPerformanceSnapshotReaderRef;
}

export type VisualPerformanceSnapshotReader = () => VisualPerformanceSnapshot | null;

export interface VisualPerformanceSnapshotReaderRef {
	current: VisualPerformanceSnapshotReader | null;
}

export interface UseVisualEngineDependencies {
	readonly createFacade?: (options: VisualEngineOptions) => VisualEngineFacade;
	readonly createEnvironmentAdapter?: () => VisualEnvironmentAdapter;
	readonly reportError?: (error: unknown) => void;
}

interface ResolvedUseVisualEngineDependencies {
	readonly createFacade: (options: VisualEngineOptions) => VisualEngineFacade;
	readonly createEnvironmentAdapter: () => VisualEnvironmentAdapter;
	readonly reportError: (error: unknown) => void;
}

function copyNativeWindowState(state: Awaited<ReturnType<typeof getWindowState>>) {
	return {
		isVisible: state.isVisible,
		isFocused: state.isFocused,
		isMinimized: state.isMinimized,
	};
}

function createProductionEnvironmentAdapter(): VisualEnvironmentAdapter {
	if (!isTauriRuntime()) return createVisualEnvironmentAdapter();
	return createVisualEnvironmentAdapter({
		nativeSource: {
			getWindowState: async () => copyNativeWindowState(await getWindowState()),
			listenWindowState: (listener) => listenWindowState((state) => {
				listener(copyNativeWindowState(state));
			}),
		},
	});
}

function reportVisualMountError(error: unknown): void {
	try {
		console.error("[visual-engine] mount failed", error);
	} catch {
		// 控制台不可用时，mount 失败仍由 facade 自身完成资源回滚。
	}
}

function resolveDependencies(
	dependencies: UseVisualEngineDependencies,
): ResolvedUseVisualEngineDependencies {
	return {
		createFacade: dependencies.createFacade ?? createVisualEngine,
		createEnvironmentAdapter: dependencies.createEnvironmentAdapter ?? createProductionEnvironmentAdapter,
		reportError: dependencies.reportError ?? reportVisualMountError,
	};
}

function safelyCleanup(cleanup: () => void): void {
	try {
		cleanup();
	} catch {
		// 单个 cleanup 失败不能阻断 adapter、facade 的其余释放。
	}
}

function safelyReportError(
	dependencies: ResolvedUseVisualEngineDependencies,
	error: unknown,
): void {
	try {
		dependencies.reportError(error);
	} catch {
		reportVisualMountError(error);
	}
}

export function useVisualEngine(
	input: UseVisualEngineInput,
	dependencies: UseVisualEngineDependencies = {},
): void {
	const dependenciesRef = useRef<ResolvedUseVisualEngineDependencies | null>(null);
	if (!dependenciesRef.current) dependenciesRef.current = resolveDependencies(dependencies);

	const positionMsRef = useRef(input.positionMs);
	const playbackVolumeRef = useRef(input.playbackVolume);
	const lyricsOffsetSecondsRef = useRef(input.lyricOffsetSeconds ?? 0);
	const playbackSnapshotRef = useRef(input.playbackSnapshot);
	const lyricsSnapshotRef = useRef(input.lyricsSnapshot);
	const shelfSnapshotRef = useRef(input.shelfSnapshot);
	const settingsSnapshotRef = useRef(input.settingsSnapshot);
	const eventsRef = useRef(input.events);
	const facadeRef = useRef<VisualEngineFacade | null>(null);

	positionMsRef.current = input.positionMs;
	playbackVolumeRef.current = input.playbackVolume;
	lyricsOffsetSecondsRef.current = input.lyricOffsetSeconds ?? 0;
	playbackSnapshotRef.current = input.playbackSnapshot;
	lyricsSnapshotRef.current = input.lyricsSnapshot;
	shelfSnapshotRef.current = input.shelfSnapshot;
	settingsSnapshotRef.current = input.settingsSnapshot;
	eventsRef.current = input.events;

	useEffect(() => {
		const host = input.hostRef.current;
		if (typeof window === "undefined" || !host) return;

		const resolved = dependenciesRef.current!;
		let environment: VisualEnvironmentAdapter | null = null;
		let facade: VisualEngineFacade | null = null;
		let performanceReader: VisualPerformanceSnapshotReader | null = null;
		let unsubscribeEnvironment: (() => void) | null = null;
		let active = true;
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			active = false;
			if (
				performanceReader
				&& input.performanceSnapshotReaderRef?.current === performanceReader
			) {
				input.performanceSnapshotReaderRef.current = null;
			}
			if (facadeRef.current === facade) facadeRef.current = null;
			if (unsubscribeEnvironment) safelyCleanup(unsubscribeEnvironment);
			if (environment) safelyCleanup(() => environment?.dispose());
			if (facade) safelyCleanup(() => facade?.dispose());
		};

		try {
			environment = resolved.createEnvironmentAdapter();
			const initialVisibility = environment.getSnapshot();
			const mediaClock = createVisualMediaClock({
				getAudioFrame: input.audioFrameSource,
				getPositionMs: () => positionMsRef.current,
				getPlaybackSnapshot: () => playbackSnapshotRef.current,
			});
			facade = resolved.createFacade({
				mediaClock,
				initialVisibility,
				createComposition: () => createLegacyVisualComposition({
					audioFrameSource: input.audioFrameSource,
					events: eventsRef.current,
					getPlaybackVolume: () => playbackVolumeRef.current,
					getLyricOffsetSeconds: () => lyricsOffsetSecondsRef.current,
					getPrefersReducedMotion: () => environment?.getPrefersReducedMotion() ?? false,
				}),
			});
			facadeRef.current = facade;
			performanceReader = () => facade?.getPerformanceSnapshot() ?? null;
			if (input.performanceSnapshotReaderRef) {
				input.performanceSnapshotReaderRef.current = performanceReader;
			}

			facade.setPlaybackSnapshot(playbackSnapshotRef.current);
			facade.setLyricsSnapshot(lyricsSnapshotRef.current);
			facade.setShelfSnapshot(shelfSnapshotRef.current);
			facade.setVisualSettings(settingsSnapshotRef.current);
			facade.setVisibility(initialVisibility);
			unsubscribeEnvironment = environment.subscribe((visibility) => {
				if (!active) return;
				facade?.setVisibility(visibility);
			});

			void Promise.resolve()
				.then(() => {
					if (!active) return;
					return facade?.mount(host);
				})
				.catch((error) => {
					if (!active) return;
					safelyReportError(resolved, error);
					cleanup();
				});
		} catch (error) {
			if (active) safelyReportError(resolved, error);
			cleanup();
		}

		return cleanup;
	}, [input.audioFrameSource, input.hostRef, input.performanceSnapshotReaderRef]);

	useEffect(() => {
		facadeRef.current?.setPlaybackSnapshot(input.playbackSnapshot);
	}, [input.playbackSnapshot]);

	useEffect(() => {
		facadeRef.current?.setLyricsSnapshot(input.lyricsSnapshot);
	}, [input.lyricsSnapshot]);

	useEffect(() => {
		facadeRef.current?.setShelfSnapshot(input.shelfSnapshot);
	}, [input.shelfSnapshot]);

	useEffect(() => {
		facadeRef.current?.setVisualSettings(input.settingsSnapshot);
	}, [input.settingsSnapshot]);
}
