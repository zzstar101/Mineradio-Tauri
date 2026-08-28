import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import {
	attachControlGlassNode,
	createControlConsoleMotion,
	injectControlGlassStyle,
	type ControlConsoleMotion,
} from "@mineradio/visual-engine";
import type { PlaybackMode } from "../stores/playback-store";
import type { ShelfCameraMode, ShelfMode, ShelfPresence } from "../stores/shelf-store";
import type { PlaybackQualityRequest, ProviderId, Track, TrackQualityOption } from "@mineradio/shared";
import { createProgressDragParticleEmitter, type ProgressDragParticleEmitter } from "./progress-drag-particles";
import { resolveVirtualListWindow } from "../components/shell/virtual-list";
import { SourceSwitcher } from "../features/playback/SourceSwitcher";
import { coverSourceToCssBackgroundImage, useCoverSourceResolver } from "../cover/resolved-cover-source";
import { isProviderLikeSupported, likeUnsupportedMessage } from "../features/likes/likes-policy";
import { isCollectSupportedTrack, collectUnsupportedMessage } from "../features/library/library-policy";
import { useMiniQueueReorder } from "./mini-queue-reorder";

const PLAYBACK_QUALITY_OPTIONS: Array<{
	value: PlaybackQualityRequest;
	label: string;
	short: string;
	detail: string;
	svip?: boolean;
}> = [
	{ value: "jymaster", label: "超清母带", short: "母带", detail: "SVIP / 最高规格", svip: true },
	{ value: "hires", label: "高清臻音", short: "臻音", detail: "默认 / 细节优先" },
	{ value: "lossless", label: "无损 SQ", short: "SQ", detail: "FLAC 优先" },
	{ value: "exhigh", label: "极高 HQ", short: "HQ", detail: "320kbps" },
	{ value: "standard", label: "标准", short: "STD", detail: "128kbps" },
];
const MINI_QUEUE_ROW_HEIGHT = 58;
const MINI_QUEUE_VIEWPORT_HEIGHT = 320;

type PlaybackQualityViewOption = {
	value: PlaybackQualityRequest;
	label: string;
	short: string;
	detail: string;
	svip?: boolean;
};

function qualityViewOptions(options: TrackQualityOption[] | undefined): PlaybackQualityViewOption[] {
	if (options === undefined || options.length === 0) return PLAYBACK_QUALITY_OPTIONS;
	return options.map((option) => ({
		value: option.requestQuality,
		label: option.label,
		short: option.short ?? option.label,
		detail: option.detail ?? option.type?.toUpperCase() ?? option.level ?? option.id,
	}));
}

function fallbackQualityOption(value: PlaybackQualityRequest | undefined): PlaybackQualityViewOption {
	if (value) {
		const label = value.toUpperCase();
		return { value, label, short: label, detail: "当前音源档位" };
	}
	return { value: "hires", label: "音质", short: "音质", detail: "暂无可切换档位" };
}

function playbackQualityOption(value: PlaybackQualityRequest | undefined, options: PlaybackQualityViewOption[]) {
	const selected = value ? options.find((option) => option.value === value) : undefined;
	if (selected) return selected;
	if (value) return fallbackQualityOption(value);
	return options[0] ?? fallbackQualityOption(value);
}

export type TrackDetailKind = "album" | "song" | "artist";

export interface PlayerConsoleHostProps {
	visible?: boolean;
	onReveal?: () => void;
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
	onClose?: () => void;
	onTrackDetail?: (kind: TrackDetailKind) => void;
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
	fadeInLabel?: string;
	fadeOutLabel?: string;
	deps?: {
		controlsHovering?: () => boolean;
		miniQueueOpen?: () => boolean;
		controlsAutoHide?: () => boolean;
		isShelfSuppressed?: () => boolean;
		isHomeControlsLocked?: () => boolean;
	};
	timers?: {
		setTimeout?: typeof window.setTimeout;
		clearTimeout?: typeof window.clearTimeout;
	};
}

export function PlayerConsoleHost(props: PlayerConsoleHostProps): ReactElement {
	const resolveCover = useCoverSourceResolver();
	const currentCoverSource = resolveCover(props.currentCoverUrl).uri;
	const barRef = useRef<HTMLDivElement | null>(null);
	const miniQueueListRef = useRef<HTMLDivElement | null>(null);
	const modeBtnRef = useRef<HTMLButtonElement | null>(null);
	const modeIconRef = useRef<SVGSVGElement | null>(null);
	const playBtnRef = useRef<HTMLButtonElement | null>(null);
	const normalBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const motionRef = useRef<ControlConsoleMotion | null>(null);
	const visibleRef = useRef(!!props.visible);
	const barHoveringRef = useRef(false);
	const progressParticleEmitterRef = useRef<ProgressDragParticleEmitter | null>(null);

	visibleRef.current = !!props.visible;
	const onToggleFullscreenRef = useRef(props.onToggleFullscreen);
	onToggleFullscreenRef.current = props.onToggleFullscreen;
	const onRevealRef = useRef(props.onReveal);
	onRevealRef.current = props.onReveal;
	const onTogglePlayRef = useRef(props.onTogglePlay);
	onTogglePlayRef.current = props.onTogglePlay;
	const onPreviousRef = useRef(props.onPrevious);
	onPreviousRef.current = props.onPrevious;
	const onNextRef = useRef(props.onNext);
	onNextRef.current = props.onNext;
	const onModeChangeRef = useRef(props.onModeChange);
	onModeChangeRef.current = props.onModeChange;
	const onQueueRef = useRef(props.onQueue);
	onQueueRef.current = props.onQueue;
	const onCloseMiniQueueRef = useRef(props.onCloseMiniQueue);
	onCloseMiniQueueRef.current = props.onCloseMiniQueue;
	const onLyricsRef = useRef(props.onLyrics);
	onLyricsRef.current = props.onLyrics;
	const onLyricSourceChangeRef = useRef(props.onLyricSourceChange);
	onLyricSourceChangeRef.current = props.onLyricSourceChange;
	const onOpenCustomLyricsRef = useRef(props.onOpenCustomLyrics);
	onOpenCustomLyricsRef.current = props.onOpenCustomLyrics;
	const onCollectCurrentRef = useRef(props.onCollectCurrent);
	onCollectCurrentRef.current = props.onCollectCurrent;
	const onToggleLikeCurrentRef = useRef(props.onToggleLikeCurrent);
	onToggleLikeCurrentRef.current = props.onToggleLikeCurrent;
	const onNoticeRef = useRef(props.onNotice);
	onNoticeRef.current = props.onNotice;
	const onSeekRef = useRef(props.onSeek);
	onSeekRef.current = props.onSeek;
	const onVolumeChangeRef = useRef(props.onVolumeChange);
	onVolumeChangeRef.current = props.onVolumeChange;
	const onFadeInMsChangeRef = useRef(props.onFadeInMsChange);
	onFadeInMsChangeRef.current = props.onFadeInMsChange;
	const onFadeOutMsChangeRef = useRef(props.onFadeOutMsChange);
	onFadeOutMsChangeRef.current = props.onFadeOutMsChange;
	const onToggleMuteRef = useRef(props.onToggleMute);
	onToggleMuteRef.current = props.onToggleMute;
	const onQualityChangeRef = useRef(props.onQualityChange);
	onQualityChangeRef.current = props.onQualityChange;
	const onPlayQueueIndexRef = useRef(props.onPlayQueueIndex);
	onPlayQueueIndexRef.current = props.onPlayQueueIndex;
	const onRemoveQueueIndexRef = useRef(props.onRemoveQueueIndex);
	onRemoveQueueIndexRef.current = props.onRemoveQueueIndex;
	const onInsertQueueNextRef = useRef(props.onInsertQueueNext);
	onInsertQueueNextRef.current = props.onInsertQueueNext;
	const onMoveQueueIndexRef = useRef(props.onMoveQueueIndex);
	onMoveQueueIndexRef.current = props.onMoveQueueIndex;
	const onTrackDetailRef = useRef(props.onTrackDetail);
	onTrackDetailRef.current = props.onTrackDetail;
	const onToggleControlsAutoHideRef = useRef(props.onToggleControlsAutoHide);
	onToggleControlsAutoHideRef.current = props.onToggleControlsAutoHide;
	const onToggleImmersiveRef = useRef(props.onToggleImmersive);
	onToggleImmersiveRef.current = props.onToggleImmersive;
	const onLyricOffsetAdjustRef = useRef(props.onLyricOffsetAdjust);
	onLyricOffsetAdjustRef.current = props.onLyricOffsetAdjust;
	const onLyricOffsetResetRef = useRef(props.onLyricOffsetReset);
	onLyricOffsetResetRef.current = props.onLyricOffsetReset;
	const depsRef = useRef(props.deps);
	depsRef.current = props.deps;
	const [progressDragging, setProgressDragging] = useState(false);
	const [volumeOpen, setVolumeOpen] = useState(false);
	const [qualityOpen, setQualityOpen] = useState(false);
	const [miniQueueScrollTop, setMiniQueueScrollTop] = useState(0);
	const [lyricTimingOpen, setLyricTimingOpen] = useState(false);

	const registerNormal = useCallback((id: string) => (el: HTMLButtonElement | null) => {
		normalBtnRefs.current[id] = el;
	}, []);

	// Wave 3 mini queue drag-sort (upstream long-press reorder).
	useMiniQueueReorder({
		containerRef: miniQueueListRef,
		rowSelector: ".mini-queue-item",
		indexAttr: "data-queue-index",
		enabled: !!props.miniQueueOpen,
		onMove: (fromIndex, toIndex) => onMoveQueueIndexRef.current?.(fromIndex, toIndex),
		...(props.timers?.setTimeout ? { timers: { setTimeout: props.timers.setTimeout, clearTimeout: props.timers.clearTimeout ?? window.clearTimeout.bind(window) } } : {}),
	});

	useEffect(() => {
		const bar = barRef.current;
		if (!bar || typeof window === "undefined") return;
		injectControlGlassStyle();
		const detachGlass = attachControlGlassNode(bar, { refreshOnResize: true });

		const playButton = playBtnRef.current;
		const modeButton = modeBtnRef.current;
		const modeIcon = modeIconRef.current;
		const normalButtons = Object.values(normalBtnRefs.current).filter((b): b is HTMLButtonElement => !!b);
		const motion = createControlConsoleMotion({
			root: { bar, modeButton, modeIcon, playButton, normalButtons },
			deps: {
				controlsHovering: () => barHoveringRef.current || !!depsRef.current?.controlsHovering?.(),
				miniQueueOpen: () => !!depsRef.current?.miniQueueOpen?.(),
				controlsAutoHide: () => depsRef.current?.controlsAutoHide?.() ?? props.controlsAutoHide ?? true,
				isHomeControlsLocked: () => !!depsRef.current?.isHomeControlsLocked?.(),
				isShelfSuppressed: () => !!depsRef.current?.isShelfSuppressed?.(),
			},
		});
		motionRef.current = motion;

		let cancelled = false;
		void motion.init().then(() => {
			if (cancelled) return;
			if (visibleRef.current) motion.reveal(520);
			else motion.setHidden(true);
		});

		const onBarEnter = () => {
			barHoveringRef.current = true;
			onRevealRef.current?.();
			bar.classList.add("visible");
			motion.setHidden(false);
		};
		const onBarLeave = () => {
			barHoveringRef.current = false;
			if (!visibleRef.current) motion.setHidden(true);
		};
		bar.addEventListener("pointerenter", onBarEnter);
		bar.addEventListener("pointerleave", onBarLeave);

		const btnBindings: Array<{ el: HTMLElement; kind: "play" | "normal" }> = [];
		if (playButton) btnBindings.push({ el: playButton, kind: "play" });
		for (const nb of normalButtons) btnBindings.push({ el: nb, kind: "normal" });
		if (modeButton) btnBindings.push({ el: modeButton, kind: "normal" });

		const handlers: Array<{ el: HTMLElement; type: string; fn: (e: Event) => void }> = [];
		for (const { el, kind } of btnBindings) {
			const hoverIn = (e: Event) => {
				if ((e as globalThis.PointerEvent).pointerType === "touch") return;
				if (kind === "play") motion.playButtonHover(el, true);
				else motion.normalButtonHover(el, true);
			};
			const hoverOut = () => {
				if (kind === "play") motion.playButtonHover(el, false);
				else motion.normalButtonHover(el, false);
			};
			const pressDown = () => {
				if (kind === "play") motion.playButtonPress(el, true);
				else motion.buttonPress(el, true);
			};
			const release = () => {
				const hovered = typeof el.matches === "function" && el.matches(":hover");
				if (kind === "play") motion.playButtonPress(el, false);
				else motion.buttonPress(el, false);
				motion.buttonRelease(el, { isPlay: kind === "play", hovered });
			};
			const clickPulseFn = () => motion.clickPulse(el, kind);
			el.addEventListener("pointerenter", hoverIn);
			el.addEventListener("pointerleave", hoverOut);
			el.addEventListener("pointercancel", hoverOut);
			el.addEventListener("pointerdown", pressDown);
			el.addEventListener("pointerup", release);
			el.addEventListener("click", clickPulseFn);
			handlers.push(
				{ el, type: "pointerenter", fn: hoverIn as (e: Event) => void },
				{ el, type: "pointerleave", fn: hoverOut as (e: Event) => void },
				{ el, type: "pointercancel", fn: hoverOut as (e: Event) => void },
				{ el, type: "pointerdown", fn: pressDown as (e: Event) => void },
				{ el, type: "pointerup", fn: release as (e: Event) => void },
				{ el, type: "click", fn: clickPulseFn as (e: Event) => void },
			);
		}

		return () => {
			cancelled = true;
			bar.removeEventListener("pointerenter", onBarEnter);
			bar.removeEventListener("pointerleave", onBarLeave);
			for (const h of handlers) h.el.removeEventListener(h.type, h.fn);
			motion.dispose();
			detachGlass();
			motionRef.current = null;
		};
	}, []);

	useEffect(() => {
		progressParticleEmitterRef.current = createProgressDragParticleEmitter();
		return () => {
			progressParticleEmitterRef.current?.dispose();
			progressParticleEmitterRef.current = null;
		};
	}, []);

	useEffect(() => {
		const bar = barRef.current;
		if (!bar) return;
		bar.classList.toggle("visible", !!props.visible);
		bar.classList.toggle("soft-hidden", !props.visible);
	}, [props.visible]);

	const cyclePlayModeStub = useCallback(() => {
		const order: PlaybackMode[] = ["queue", "loop", "single", "shuffle"];
		const current = props.mode ?? "queue";
		const next = order[(order.indexOf(current) + 1) % order.length] ?? "queue";
		onModeChangeRef.current?.(next);
		motionRef.current?.toggleModeButton(next === "loop" ? "repeat" : next);
	}, [props.mode]);

	const toggleFullscreenStub = useCallback(() => {
		onToggleFullscreenRef.current?.();
	}, []);
	const togglePlayStub = useCallback(() => {
		onTogglePlayRef.current?.();
	}, []);
	const previousStub = useCallback(() => {
		onPreviousRef.current?.();
	}, []);
	const nextStub = useCallback(() => {
		onNextRef.current?.();
	}, []);
	const queueStub = useCallback(() => {
		onQueueRef.current?.();
	}, []);
	const closeQueueStub = useCallback(() => {
		onCloseMiniQueueRef.current?.();
	}, []);
	const trackDetailStub = useCallback((kind: TrackDetailKind) => {
		onTrackDetailRef.current?.(kind);
	}, []);
	const toggleControlsAutoHideStub = useCallback(() => {
		onToggleControlsAutoHideRef.current?.();
	}, []);
	const toggleImmersiveStub = useCallback(() => {
		onToggleImmersiveRef.current?.();
	}, []);
	const adjustLyricOffsetStub = useCallback((stepSeconds: number) => {
		onLyricOffsetAdjustRef.current?.(stepSeconds);
	}, []);
	const resetLyricOffsetStub = useCallback(() => {
		onLyricOffsetResetRef.current?.();
	}, []);
	const lyricSourceMode = props.lyricSourceMode === "custom" ? "custom" : "original";
	const chooseOriginalLyrics = useCallback(() => {
		onLyricSourceChangeRef.current?.("original");
	}, []);
	const chooseCustomLyrics = useCallback(() => {
		onLyricSourceChangeRef.current?.("custom");
	}, []);
	const openCustomLyrics = useCallback(() => {
		onOpenCustomLyricsRef.current?.();
	}, []);
	const noticeStub = useCallback((message: string) => {
		onNoticeRef.current?.(message);
	}, []);
	const positionMs = props.positionMs ?? 0;
	const durationMs = props.durationMs ?? 0;
	const seekFromPointer = useCallback((clientX: number, target: HTMLDivElement) => {
		if (durationMs <= 0) return;
		const rect = target.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		onSeekRef.current?.(Math.floor(durationMs * ratio));
	}, [durationMs]);
	const emitProgressDragParticles = useCallback((clientX: number, target: HTMLDivElement) => {
		const rect = target.getBoundingClientRect();
		progressParticleEmitterRef.current?.emit(clientX, rect.top + rect.height / 2);
	}, []);
	const seekStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setProgressDragging(true);
		seekFromPointer(event.clientX, event.currentTarget);
		emitProgressDragParticles(event.clientX, event.currentTarget);
	}, [emitProgressDragParticles, seekFromPointer]);
	const seekMoveStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (!progressDragging) return;
		seekFromPointer(event.clientX, event.currentTarget);
		emitProgressDragParticles(event.clientX, event.currentTarget);
	}, [emitProgressDragParticles, progressDragging, seekFromPointer]);
	const seekEndStub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		setProgressDragging(false);
		event.currentTarget.releasePointerCapture?.(event.pointerId);
	}, []);
	const volume = Math.max(0, Math.min(1, props.volume ?? 0.84));
	const muted = !!props.muted;
	const volumePct = Math.round((muted ? 0 : volume) * 100);
	const qualityOptions = qualityViewOptions(props.qualityOptions);
	const quality = playbackQualityOption(props.playbackQuality, qualityOptions);
	const currentLiked = props.currentLiked === true;
	const currentLikeBusy = props.currentLikeBusy === true;

	const progressPct = durationMs > 0 ? Math.max(0, Math.min(100, (positionMs / durationMs) * 100)) : 0;
	const formatTime = (ms: number): string => {
		const total = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${s.toString().padStart(2, "0")}`;
	};

	// Wave 3 capability gating: unsupported provider → disabled affordance with
	// upstream-style message instead of waiting for an API error.
	const currentTrack = props.currentTrack ?? null;
	const canLike = isProviderLikeSupported(currentTrack);
	const canCollect = isCollectSupportedTrack(currentTrack);
	const likeTitle = currentLiked
		? "取消红心"
		: canLike
			? "红心喜欢"
			: likeUnsupportedMessage(currentTrack);
	const collectTitle = canCollect ? "收藏到歌单" : collectUnsupportedMessage(currentTrack);

	const queue = props.queue ?? [];
	const miniQueueWindow = resolveVirtualListWindow({
		itemCount: queue.length,
		rowHeight: MINI_QUEUE_ROW_HEIGHT,
		viewportHeight: MINI_QUEUE_VIEWPORT_HEIGHT,
		scrollTop: miniQueueScrollTop,
	});
	const visibleMiniQueue = queue.slice(miniQueueWindow.startIndex, miniQueueWindow.endIndex);
	const miniQueueVirtualStyle = miniQueueWindow.virtualized
		? {
			paddingTop: miniQueueWindow.paddingTop,
			paddingBottom: miniQueueWindow.paddingBottom,
		}
		: undefined;

	const fadeInMs = Math.max(0, Math.round(props.fadeInMs ?? 460));
	const fadeOutMs = Math.max(0, Math.round(props.fadeOutMs ?? 420));
	const formatFade = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

	return (
		<div id="bottom-bar" className={props.visible ? "visible" : "soft-hidden"} ref={barRef}>
			<div id="mini-queue-popover" className={props.miniQueueOpen ? "mini-queue-popover show" : "mini-queue-popover"} onClick={(event) => event.stopPropagation()}>
				<div className="mini-queue-head">
					<div>
						<div className="mini-queue-title">当前队列</div>
						<div id="mini-queue-count" className="mini-queue-count">{props.queue?.length ?? 0} 首</div>
					</div>
					<button className="fx-mini-btn ghost" type="button" title="关闭" aria-label="关闭当前队列" style={{ height: "26px", padding: "0 9px", fontSize: "13px" }} onClick={closeQueueStub}>×</button>
				</div>
				<div
					id="mini-queue-list"
					ref={miniQueueListRef}
					className="mini-queue-list"
					data-virtualized={miniQueueWindow.virtualized ? "true" : undefined}
					onScroll={(event) => setMiniQueueScrollTop(event.currentTarget.scrollTop)}
					style={miniQueueVirtualStyle}
				>
					{queue.length === 0 ? (
						<div className="mini-queue-empty">队列为空，先搜索或打开歌单</div>
					) : visibleMiniQueue.map((track, localIndex) => {
						const index = miniQueueWindow.startIndex + localIndex;
						const now = !!currentTrack && currentTrack.provider === track.provider && currentTrack.id === track.id;
						return (
							<div className={now ? "mini-queue-item now" : "mini-queue-item"} key={`${track.provider}-${track.id}-${index}`} data-queue-index={index}>
								<button className="mini-queue-main" type="button" onClick={() => onPlayQueueIndexRef.current?.(index)}>
									{resolveCover(track.coverUrl).uri ? <img src={resolveCover(track.coverUrl).uri} alt="" /> : <span className="mini-queue-cover" />}
									<span className="mini-queue-info">
										<span className="mini-queue-name">{track.title}</span>
										<span className="mini-queue-sub">{track.artists.join(" / ") || "未知艺人"}</span>
									</span>
								</button>
								<button className="mini-queue-remove mini-queue-next" type="button" title="下一首播放" onClick={() => onInsertQueueNextRef.current?.(index)}>下</button>
								<button className="mini-queue-remove" type="button" title="移除" onClick={() => onRemoveQueueIndexRef.current?.(index)}>×</button>
							</div>
						);
					})}
				</div>
			</div>
			<div id="progress-bar" className={progressDragging ? "is-dragging" : ""} onPointerDown={seekStub} onPointerMove={seekMoveStub} onPointerUp={seekEndStub} onPointerCancel={seekEndStub}>
				<div id="progress-fill" style={{ width: `${progressPct}%` }} />
				<div id="progress-thumb" aria-hidden="true" style={{ left: `${progressPct}%` }} />
			</div>
			<div id="controls">
				<div className="control-cluster actions">
					<div className="control-track">
						<button
							id="control-cover"
							className={currentCoverSource ? "control-cover has-cover" : "control-cover cover-empty"}
							type="button"
							title="专辑详情"
							aria-label="专辑详情"
							style={currentCoverSource ? { backgroundImage: coverSourceToCssBackgroundImage(currentCoverSource) } : undefined}
							onClick={() => trackDetailStub("album")}
						/>
						<div className="control-meta">
							<div id="control-title" className="control-title" title="歌曲详情" role="button" tabIndex={0} onClick={() => trackDetailStub("song")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); trackDetailStub("song"); } }}>
								<span id="control-title-text" className="control-title-text">{props.currentTitle ?? ""}</span>
								<span id="control-title-badges" className="control-title-badges">
									{props.currentTrack && props.sourceProviders?.length && props.onSourceSwitch ? (
										<SourceSwitcher
											currentProvider={props.currentTrack.provider}
											availableProviders={props.sourceProviders}
											busyProvider={props.sourceSwitchBusy ?? null}
											disabled={props.sourceSwitchDisabled}
											onSwitch={props.onSourceSwitch}
										/>
									) : null}
									<div id="quality-control" className="quality-control control-quality-chip">
										<button id="quality-btn" className={qualityOpen ? "ctrl-btn quality-pill active" : "ctrl-btn quality-pill"} ref={registerNormal("quality-btn")} type="button" title={`音质: ${quality.label}`} aria-label="音质" onClick={() => setQualityOpen((open) => !open)}>
											<span id="quality-btn-label">{quality.short}</span>
										</button>
										<div className={qualityOpen ? "quality-popover show" : "quality-popover"} onClick={(event) => event.stopPropagation()}>
											<div id="quality-option-list" className="quality-option-list">
												{qualityOptions.map((option) => (
													<button
														key={option.value}
														className={option.value === quality.value ? "quality-option active" : "quality-option"}
														type="button"
														data-quality={option.value}
														data-svip={option.svip ? "1" : undefined}
														title={option.label}
														onClick={() => {
															setQualityOpen(false);
															try {
																const pending = onQualityChangeRef.current?.(option.value);
																if (!pending) return;
																void Promise.resolve(pending).catch((error) => {
																	noticeStub(error instanceof Error ? error.message : "音质偏好保存失败");
																});
															} catch (error) {
																noticeStub(error instanceof Error ? error.message : "音质偏好保存失败");
															}
														}}
													>
														<span>{option.label}</span>
														<small>{option.detail}</small>
													</button>
												))}
											</div>
										</div>
									</div>
								</span>
							</div>
							<div id="control-artist" className="control-artist" title="歌手详情" role="button" tabIndex={0} onClick={() => trackDetailStub("artist")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); trackDetailStub("artist"); } }}>{props.currentArtist ?? ""}</div>
						</div>
					</div>
					<button
						id="heart-btn"
						ref={registerNormal("heart-btn")}
						className={`ctrl-btn${currentLiked ? " liked active" : ""}${currentLikeBusy ? " busy" : ""}`}
						type="button"
						title={likeTitle}
						aria-label={likeTitle}
						aria-pressed={currentLiked}
						disabled={currentLikeBusy}
						onClick={() => onToggleLikeCurrentRef.current?.()}
					>
						<svg className="heart-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z" /></svg>
					</button>
					<button id="collect-btn" ref={registerNormal("collect-btn")} className="ctrl-btn" type="button" title={collectTitle} aria-label={collectTitle} onClick={() => onCollectCurrentRef.current?.()}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
					</button>
				</div>
				<div className="control-cluster transport">
					<button id="play-mode-btn" ref={modeBtnRef} className="ctrl-btn" type="button" onClick={cyclePlayModeStub} title={`播放顺序：${props.mode ?? "queue"}`} aria-label="播放顺序">
						<svg id="play-mode-icon" ref={modeIconRef} width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
					</button>
					<button id="prev-btn" ref={registerNormal("prev-btn")} className="ctrl-btn" type="button" title="上一首" aria-label="上一首" onClick={previousStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
					</button>
					<button id="play-btn" ref={playBtnRef} className="ctrl-btn" type="button" title="播放/暂停" aria-label="播放/暂停" data-playing={props.isPlaying ? "true" : "false"} onClick={togglePlayStub}>
						<svg id="play-icon" viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="currentColor">{props.isPlaying ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}</svg>
					</button>
					<button id="next-btn" ref={registerNormal("next-btn")} className="ctrl-btn" type="button" title="下一首" aria-label="下一首" onClick={nextStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18V6z" /></svg>
					</button>
					<button id="mini-queue-btn" ref={registerNormal("mini-queue-btn")} className={props.miniQueueOpen ? "ctrl-btn active" : "ctrl-btn"} type="button" title="当前队列" aria-label="当前队列" onClick={queueStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
					</button>
				</div>
				<div className="control-cluster modes">
					<div id="lyric-timing-control" className={props.lyricOffsetLabel && props.lyricOffsetLabel !== "0.0s" ? "lyric-timing-control has-offset" : "lyric-timing-control"} onPointerEnter={() => setLyricTimingOpen(true)} onFocus={() => setLyricTimingOpen(true)} onPointerLeave={() => setLyricTimingOpen(false)} onBlur={() => setLyricTimingOpen(false)}>
						<button id="lyrics-toggle-btn" className="ctrl-btn lyrics-toggle-btn" ref={registerNormal("lyrics-toggle-btn")} type="button" title="歌词校准" aria-label="歌词校准" onClick={() => setLyricTimingOpen((open) => !open)}>
							<span className="lyrics-word-icon">词</span>
						</button>
						<div id="lyric-timing-popover" className={lyricTimingOpen ? "lyric-timing-popover show" : "lyric-timing-popover"} onClick={(event) => event.stopPropagation()}>
							<div className="lyric-timing-head">
								<span>歌词校准</span>
								<strong id="lyric-timing-value">{props.lyricOffsetLabel ?? "0.0s"}</strong>
							</div>
							<div id="lyric-timing-song" className="lyric-timing-song">{props.currentTitle ?? "当前歌曲"}</div>
							<div className="lyric-timing-actions">
								<button type="button" data-lyric-offset-step="-0.1" title="歌词延后 0.1 秒" disabled={props.lyricTimingDisabled} onClick={() => adjustLyricOffsetStub(-0.1)}>-0.1</button>
								<button type="button" data-lyric-offset-reset title="重置当前歌曲歌词校准" disabled={props.lyricTimingDisabled} onClick={resetLyricOffsetStub}>0</button>
								<button type="button" data-lyric-offset-step="0.1" title="歌词提前 0.1 秒" disabled={props.lyricTimingDisabled} onClick={() => adjustLyricOffsetStub(0.1)}>+0.1</button>
							</div>
							<div className="lyric-source-row lyric-timing-source-row" aria-label="歌词来源">
								<div className="fx-seg lyric-source-seg" id="lyric-source-seg">
									<button id="lyric-source-original" type="button" className={lyricSourceMode === "original" ? "active" : ""} onClick={chooseOriginalLyrics}>原词</button>
									<button id="lyric-source-custom" type="button" className={`${lyricSourceMode === "custom" ? "active" : ""}${props.hasCustomLyric ? " has-custom" : ""}`.trim()} onClick={chooseCustomLyrics}>自定义</button>
								</div>
								<button id="lyric-custom-edit-btn" type="button" className="lyric-custom-edit" title="编辑自定义歌词" onClick={openCustomLyrics}>编辑</button>
							</div>
						</div>
					</div>
					<div id="volume-control" className={`volume-control${muted ? " muted" : ""}`}>
						<button id="volume-btn" className={volumeOpen ? "ctrl-btn active" : "ctrl-btn"} ref={registerNormal("volume-btn")} type="button" title="音量 / 静音" aria-label="音量" onClick={() => setVolumeOpen((open) => !open)} onDoubleClick={() => onToggleMuteRef.current?.()}>
							<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />{volumePct > 0 ? <path d="M15 8.5a5 5 0 0 1 0 7" /> : <path d="M16 9l5 5M21 9l-5 5" />}</svg>
						</button>
						<div className={volumeOpen ? "volume-popover show" : "volume-popover"} onClick={(event) => event.stopPropagation()}>
							<div className="volume-main-row">
								<input id="volume-slider" type="range" min="0" max="1" step="0.01" value={volume} aria-label="音量" onChange={(event) => onVolumeChangeRef.current?.(Number(event.currentTarget.value))} />
								<span id="volume-value">{volumePct}%</span>
							</div>
							<div className="fade-control-row">
								<label htmlFor="fade-in-slider">淡入</label>
								<input id="fade-in-slider" type="range" min="0" max="3" step="0.05" value={fadeInMs / 1000} aria-label="音乐淡入秒数" onChange={(event) => onFadeInMsChangeRef.current?.(Math.round(Number(event.currentTarget.value) * 1000))} />
								<span id="fade-in-value">{formatFade(fadeInMs)}</span>
							</div>
							<div className="fade-control-row">
								<label htmlFor="fade-out-slider">淡出</label>
								<input id="fade-out-slider" type="range" min="0" max="3" step="0.05" value={fadeOutMs / 1000} aria-label="音乐淡出秒数" onChange={(event) => onFadeOutMsChangeRef.current?.(Math.round(Number(event.currentTarget.value) * 1000))} />
								<span id="fade-out-value">{formatFade(fadeOutMs)}</span>
							</div>
						</div>
					</div>
					<button id="controls-hide-btn" ref={registerNormal("controls-hide-btn")} className={props.controlsAutoHide ? "ctrl-btn active" : "ctrl-btn"} type="button" title="控制条自动隐藏" aria-label="控制条自动隐藏" aria-pressed={props.controlsAutoHide === true} onClick={toggleControlsAutoHideStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 8h14" /><path d="M8 12h8" /><path d="M10 16h4" /></svg>
					</button>
					<button id="immersive-btn" ref={registerNormal("immersive-btn")} className="ctrl-btn" type="button" title={props.immersiveMode ? "退出全沉浸式" : "全沉浸式"} aria-label="全沉浸式" aria-pressed={props.immersiveMode === true} onClick={toggleImmersiveStub}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={1.9}><path d="M4 9V5a1 1 0 0 1 1-1h4" /><path d="M15 4h4a1 1 0 0 1 1 1v4" /><path d="M20 15v4a1 1 0 0 1-1 1h-4" /><path d="M9 20H5a1 1 0 0 1-1-1v-4" /><circle cx="12" cy="12" r="2.2" /></svg>
					</button>
					<button className="ctrl-btn fullscreen-toggle-btn" ref={registerNormal("fullscreen-toggle-btn")} type="button" onClick={toggleFullscreenStub} title="全屏 (F)" aria-label="全屏" onDoubleClick={(event) => event.preventDefault()}>
						<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 7V3h4" /><path d="M21 7V3h-4" /><path d="M3 17v4h4" /><path d="M21 17v4h-4" /></svg>
					</button>
						<div id="time-display">{formatTime(positionMs)} / {formatTime(durationMs)}</div>
				</div>
			</div>
		</div>
	);
}