import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { PlayerConsoleHost } from "../../visual/PlayerConsoleHost";
import type { PlaybackMode } from "../../stores/playback-store";
import type { ShelfCameraMode, ShelfMode, ShelfPresence } from "../../stores/shelf-store";
import type { PlaybackQualityRequest, ProviderId, Track, TrackQualityOption } from "@mineradio/shared";

export interface BottomControlsHostProps {
	visible: boolean;
	onReveal: () => void;
	onHide?: () => void;
	onTogglePlay?: () => void;
	onPrevious?: () => void;
	onNext?: () => void;
	onModeChange?: (mode: PlaybackMode) => void;
	onQueue?: () => void;
	onCloseMiniQueue?: () => void;
	onLyrics?: () => void;
	onLyricSourceChange?: (mode: "original" | "custom") => void;
	onOpenCustomLyrics?: () => void;
	onCollectCurrent?: () => void;
	onToggleLikeCurrent?: () => void;
	onClose?: () => void;
	onNotice?: (message: string) => void;
	onSeek?: (positionMs: number) => void;
	onVolumeChange?: (volume: number) => void;
	onFadeInMsChange?: (fadeInMs: number) => void;
	onFadeOutMsChange?: (fadeOutMs: number) => void;
	onToggleMute?: () => void;
	renderVolumePanelExtras?: (active: boolean) => ReactNode;
	onQualityChange?: (
		quality: PlaybackQualityRequest,
	) => Promise<void> | void;
	onSourceSwitch?: (provider: ProviderId) => void;
	onShelfModeChange?: (mode: ShelfMode) => void;
	onShelfCameraModeChange?: (mode: ShelfCameraMode) => void;
	onShelfPresenceChange?: (presence: ShelfPresence) => void;
	onShelfShowPodcastsChange?: (show: boolean) => void;
	onShelfMergeCollectionsChange?: (merge: boolean) => void;
	onPlayQueueIndex?: (index: number) => void;
	onRemoveQueueIndex?: (index: number) => void;
	onInsertQueueNext?: (index: number) => void;
	onMoveQueueIndex?: (fromIndex: number, toIndex: number) => void;
	onMinimize?: () => void;
	onToggleMaximize?: () => void;
	onToggleFullscreen?: () => void;
	onTrackDetail?: (kind: "album" | "song" | "artist") => void;
	onToggleControlsAutoHide?: () => void;
	onToggleImmersive?: () => void;
	onLyricOffsetAdjust?: (stepSeconds: number) => void;
	onLyricOffsetReset?: () => void;
	mode?: PlaybackMode;
	isPlaying?: boolean;
	currentTitle?: string;
	currentArtist?: string;
	currentCoverUrl?: string;
	currentLiked?: boolean;
	currentLikeBusy?: boolean;
	queue?: Track[];
	currentTrack?: Track | null;
	miniQueueOpen?: boolean;
	positionMs?: number;
	durationMs?: number | null;
	volume?: number;
	muted?: boolean;
	fadeInMs?: number;
	fadeOutMs?: number;
	playbackQuality?: PlaybackQualityRequest;
	qualityOptions?: TrackQualityOption[];
	sourceProviders?: readonly ProviderId[];
	sourceSwitchBusy?: ProviderId | null;
	sourceSwitchDisabled?: boolean;
	shelfMode?: ShelfMode;
	shelfCameraMode?: ShelfCameraMode;
	shelfPresence?: ShelfPresence;
	shelfShowPodcasts?: boolean;
	shelfMergeCollections?: boolean;
	lyricSourceMode?: "original" | "custom";
	hasCustomLyric?: boolean;
	controlsAutoHide?: boolean;
	immersiveMode?: boolean;
	lyricOffsetLabel?: string;
	lyricTimingDisabled?: boolean;
	timers?: {
		setTimeout?: typeof window.setTimeout;
		clearTimeout?: typeof window.clearTimeout;
	};
	deps?: {
		setTimeoutRef?: typeof window.setTimeout;
		clearTimeoutRef?: typeof window.clearTimeout;
		isSuppressed?: () => boolean;
		isHomeControlsLocked?: () => boolean;
	};
}

export function BottomControlsHost(props: BottomControlsHostProps): ReactElement {
	const handleRef = useRef<HTMLButtonElement | null>(null);
	const propsRef = useRef(props);
	const hoveringRef = useRef(false);
	propsRef.current = props;

	useEffect(() => {
		const handle = handleRef.current;
		const bar = document.getElementById("bottom-bar");
		if (!handle || !bar || typeof document === "undefined") return;

		const setTimeoutRef =
			propsRef.current.deps?.setTimeoutRef ??
			(typeof window !== "undefined" ? window.setTimeout.bind(window) : undefined);
		const clearTimeoutRef =
			propsRef.current.deps?.clearTimeoutRef ??
			(typeof window !== "undefined" ? window.clearTimeout.bind(window) : undefined);
		let hideTimer: number | null = null;
		let handleTimer: number | null = null;

		const clearHideTimer = () => {
			if (hideTimer != null && clearTimeoutRef) clearTimeoutRef(hideTimer);
			hideTimer = null;
		};
		const clearHandleTimer = () => {
			if (handleTimer != null && clearTimeoutRef) clearTimeoutRef(handleTimer);
			handleTimer = null;
		};
		const suppressed = () =>
			document.body.classList.contains("home-controls-locked") ||
			propsRef.current.deps?.isHomeControlsLocked?.() ||
			propsRef.current.deps?.isSuppressed?.();
		const wakeBottomHandle = (duration = 2000) => {
			document.body.classList.add("controls-handle-awake");
			clearHandleTimer();
			if (!setTimeoutRef) return;
			handleTimer = setTimeoutRef(() => {
				handleTimer = null;
				document.body.classList.remove("controls-handle-awake");
			}, duration);
		};
		const scheduleHide = (delay = 70) => {
			clearHideTimer();
			if (!setTimeoutRef) return;
			hideTimer = setTimeoutRef(() => {
				hideTimer = null;
				if (!hoveringRef.current) propsRef.current.onHide?.();
			}, delay);
		};
		const enterControls = () => {
			if (suppressed()) return;
			hoveringRef.current = true;
			bar.classList.add("visible");
			bar.classList.remove("soft-hidden");
			wakeBottomHandle();
			propsRef.current.onReveal();
			clearHideTimer();
		};
		const leaveControls = () => {
			hoveringRef.current = false;
			scheduleHide(480);
			wakeBottomHandle(900);
		};
		const enterHandle = () => {
			if (suppressed()) return;
			hoveringRef.current = true;
			wakeBottomHandle();
			propsRef.current.onReveal();
			clearHideTimer();
		};
		const clickHandle = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (suppressed()) return;
			propsRef.current.onReveal();
			wakeBottomHandle(900);
		};

		bar.addEventListener("mouseenter", enterControls);
		bar.addEventListener("mouseleave", leaveControls);
		handle.addEventListener("mouseenter", enterHandle);
		handle.addEventListener("mouseleave", leaveControls);
		handle.addEventListener("click", clickHandle);
		return () => {
			bar.removeEventListener("mouseenter", enterControls);
			bar.removeEventListener("mouseleave", leaveControls);
			handle.removeEventListener("mouseenter", enterHandle);
			handle.removeEventListener("mouseleave", leaveControls);
			handle.removeEventListener("click", clickHandle);
			clearHideTimer();
			clearHandleTimer();
			hoveringRef.current = false;
			document.body.classList.remove("controls-handle-awake");
		};
	}, []);

	return (
		<>
			<button
				id="bottom-handle"
				ref={handleRef}
				className={props.visible ? "active" : ""}
				type="button"
				aria-label="展开播放器控制台"
				title="展开播放器控制台"
			>
				<span />
			</button>
			<PlayerConsoleHost
				visible={props.visible}
				onReveal={props.onReveal}
				onTogglePlay={props.onTogglePlay}
				onPrevious={props.onPrevious}
				onNext={props.onNext}
				onModeChange={props.onModeChange}
				onQueue={props.onQueue}
				onCloseMiniQueue={props.onCloseMiniQueue}
				onLyrics={props.onLyrics}
				onLyricSourceChange={props.onLyricSourceChange}
				onOpenCustomLyrics={props.onOpenCustomLyrics}
				onCollectCurrent={props.onCollectCurrent}
				onToggleLikeCurrent={props.onToggleLikeCurrent}
				onClose={props.onClose}
				onNotice={props.onNotice}
				onSeek={props.onSeek}
				onVolumeChange={props.onVolumeChange}
				onFadeInMsChange={props.onFadeInMsChange}
				onFadeOutMsChange={props.onFadeOutMsChange}
				onToggleMute={props.onToggleMute}
				renderVolumePanelExtras={props.renderVolumePanelExtras}
				onQualityChange={props.onQualityChange}
				onSourceSwitch={props.onSourceSwitch}
				onShelfModeChange={props.onShelfModeChange}
				onShelfCameraModeChange={props.onShelfCameraModeChange}
				onShelfPresenceChange={props.onShelfPresenceChange}
				onShelfShowPodcastsChange={props.onShelfShowPodcastsChange}
				onShelfMergeCollectionsChange={props.onShelfMergeCollectionsChange}
				onPlayQueueIndex={props.onPlayQueueIndex}
				onRemoveQueueIndex={props.onRemoveQueueIndex}
				onInsertQueueNext={props.onInsertQueueNext}
				onMoveQueueIndex={props.onMoveQueueIndex}
				onMinimize={props.onMinimize}
				onToggleMaximize={props.onToggleMaximize}
				onToggleFullscreen={props.onToggleFullscreen}
				onTrackDetail={props.onTrackDetail}
				onToggleControlsAutoHide={props.onToggleControlsAutoHide}
				onToggleImmersive={props.onToggleImmersive}
				onLyricOffsetAdjust={props.onLyricOffsetAdjust}
				onLyricOffsetReset={props.onLyricOffsetReset}
				mode={props.mode}
				isPlaying={props.isPlaying}
				currentTitle={props.currentTitle}
				currentArtist={props.currentArtist}
				currentCoverUrl={props.currentCoverUrl}
				currentLiked={props.currentLiked}
				currentLikeBusy={props.currentLikeBusy}
				queue={props.queue}
				currentTrack={props.currentTrack}
				miniQueueOpen={props.miniQueueOpen}
				positionMs={props.positionMs}
				durationMs={props.durationMs}
				volume={props.volume}
				muted={props.muted}
				fadeInMs={props.fadeInMs}
				fadeOutMs={props.fadeOutMs}
				playbackQuality={props.playbackQuality}
				qualityOptions={props.qualityOptions}
				sourceProviders={props.sourceProviders}
				sourceSwitchBusy={props.sourceSwitchBusy}
				sourceSwitchDisabled={props.sourceSwitchDisabled}
				shelfMode={props.shelfMode}
				shelfCameraMode={props.shelfCameraMode}
				shelfPresence={props.shelfPresence}
				shelfShowPodcasts={props.shelfShowPodcasts}
				shelfMergeCollections={props.shelfMergeCollections}
				lyricSourceMode={props.lyricSourceMode}
				hasCustomLyric={props.hasCustomLyric}
				controlsAutoHide={props.controlsAutoHide}
				immersiveMode={props.immersiveMode}
				lyricOffsetLabel={props.lyricOffsetLabel}
				lyricTimingDisabled={props.lyricTimingDisabled}
				timers={{
					setTimeout: props.timers?.setTimeout,
					clearTimeout: props.timers?.clearTimeout,
				}}
				deps={{
					controlsHovering: () => hoveringRef.current,
					miniQueueOpen: () => propsRef.current.miniQueueOpen === true,
					isHomeControlsLocked: props.deps?.isHomeControlsLocked,
					isShelfSuppressed: props.deps?.isSuppressed,
				}}
			/>
		</>
	);
}
