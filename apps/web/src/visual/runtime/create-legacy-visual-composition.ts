import type { RefObject } from "react";
import * as THREE from "three";
import {
	createAudioReactivity,
	createBeatMapScheduler,
	createCinemaCamera,
	createConnectorParticles,
	createLyricParticles,
	createHomeVisual,
	createVisualMaintenanceLane,
	createGpuFrameTimer,
	trimHomeCoverTextureCache,
	createDefaultFreeCameraState,
	cloneFxState,
	createRenderLoop,
	createRenderer,
	attachRendererResizeSync,
	createShelfManagerWithThree,
	createShelfPointerContentRowRaycastHitGetter,
	createShelfPointerRaycastFocus,
	createShelfPointerRaycastHitGetter,
	createShelfPointerStrictRaycastHitGetter,
	createShelfSelectSoundPlayer,
	createShelfStep,
	createSonicTopographyPlugin,
	createStageLyricsLifecycle,
	RenderStepSlot,
	type AudioFrameBytes,
	type AudioFrameSource,
	type AudioReactivityEngine,
	type CinemaCamera,
	type FxState,
	type HomeVisual,
	type GpuFrameTimingSnapshot,
	type LyricLine as VisualLyricLine,
	type LyricPalette,
	type LyricParticles,
	type RendererHandle,
	type RenderLoop,
	type ConnectorParticles,
	type ShelfManager,
	type ShelfItem,
	type ShelfContentRow,
	type ShelfOpenDetailContentPayload,
	type ShelfPane,
	type ShelfSelectSoundPlayer,
	type SonicPerformanceQuality,
	type SonicTopographyRuntime,
	type StageLyricsLifecycle,
	type StageLyricsLifecycleOpts,
	type StageLyricsMotionSnapshot,
	type VisualCameraPolicyInput,
	type VisualCameraTarget,
	type VisualEngineComposition,
	type VisualEngineCompositionContext,
	type VisualFrameSnapshot,
	type VisualResourceKind,
	type VisualResourceRetention,
	type VisualResourceScope,
	type VisualVisibilityState,
	type VisualRuntimeMode,
	DEFAULT_LYRIC_PALETTE,
} from "@mineradio/visual-engine";
import {
	attachFreeCameraHost,
	createFreeCameraPoseFromPerspectiveCamera,
	updateAndApplyFreeCamera,
} from "../free-camera-host";
import { attachShelfPointerInteractionWiring } from "../shelf-pointer-interactions";
import type { ShelfDetailRowClickPayload, ShelfPlayPlaylistPayload } from "../shelf-pointer-interactions";
import type { ShelfDetailContentListController } from "../shelf-detail-data";
import { createShelfPaneWheelSwitcher } from "../shelf-pane-switch";
import { createJsDelivrAiDepthEstimator } from "../ai-depth-estimator";
import {
	attachShelfFocusZonePointerWiring,
	createSecondaryPlaylistEdgeGuard,
	isQueueFocusActive,
	isWallpaperSafeShelfPreset,
	shouldClearShelfFocusOnCameraModeChange,
	type QueueFocusPanelInfo,
	type ShelfFocusCameraMode,
} from "../shelf-focus-zone";
import { createShelfTrackChangeGuard } from "../shelf-track-change-guard";
import { isShelfPortraitViewport } from "../shelf-viewport";
import {
	createCursorActivityRuntime,
	type CursorActivityRuntime,
} from "./cursor-activity-runtime";
import type { LegacyVisualEventSink } from "./legacy-visual-events";
import { createSonicWorkshopRuntimeLoader } from "./sonic-workshop-runtime-loader";

export function connectCursorActivityToShelf(input: {
	readonly cursorActivity: Pick<CursorActivityRuntime, "getSnapshot" | "subscribe">;
	readonly shelfManager: Pick<ShelfManager, "setPointerForegroundEligible">;
}): () => void {
	const sync = () => {
		input.shelfManager.setPointerForegroundEligible(!input.cursorActivity.getSnapshot().hidden);
	};
	sync();
	return input.cursorActivity.subscribe(sync);
}

export interface VisualEngineRefs {
	hostRef: RefObject<HTMLDivElement | null>;
	positionRef: RefObject<number>;
	durationMsRef?: RefObject<number | null | undefined>;
	isPlayingRef: RefObject<boolean>;
	lyricLinesRef: RefObject<VisualLyricLine[]>;
	fallbackTextRef?: RefObject<string>;
	lyricsHasNativeKaraokeRef?: RefObject<boolean>;
	shelfItemsRef: RefObject<ShelfItem[]>;
	shelfItemsVersionRef: RefObject<number>;
	splashActiveRef: RefObject<boolean>;
	homeActiveRef?: RefObject<boolean>;
	shelfModeRef?: RefObject<string>;
	shelfCameraModeRef?: RefObject<string>;
	shelfPresenceRef?: RefObject<string>;
	shelfMergeCollectionsRef?: RefObject<boolean>;
	shelfMineCountRef?: RefObject<number>;
	shelfFavCountRef?: RefObject<number>;
	wallpaperSafeRef?: RefObject<boolean>;
	secondaryLeftDisplaySeamGuardRef?: RefObject<boolean>;
	coverUrlRef?: RefObject<string>;
	coverFallbackUrlRef?: RefObject<string>;
	coverUrlVersionRef?: RefObject<number>;
	beatMapKeyRef?: RefObject<string>;
	beatMapRef?: RefObject<unknown>;
	beatMapVersionRef?: RefObject<number>;
	onShelfPlayQueueIndexRef?: RefObject<((index: number) => void) | undefined>;
	onShelfPlayPlaylistRef?: RefObject<((payload: ShelfPlayPlaylistPayload) => void) | undefined>;
	onShelfDetailRowClickRef?: RefObject<((payload: ShelfDetailRowClickPayload) => void) | undefined>;
	onShelfOpenDetailContentRef?: RefObject<((payload: ShelfOpenDetailContentPayload, writer: ShelfDetailContentListController) => void) | undefined>;
	onShelfOpenContentChangeRef?: RefObject<((open: boolean) => void) | undefined>;
	onShelfPaneChangeRef?: RefObject<((pane: ShelfPane) => void) | undefined>;
	lifecycleRef: RefObject<StageLyricsLifecycle | null>;
	desktopLyricsMotionRef?: RefObject<StageLyricsMotionSnapshot>;
	coverResolution: number;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
	onShelfModeChange?: (mode: "side") => void;
}

const VISUAL_COVER_RETRY_INTERVAL_MS = 2200;

export type ManagedAudioFrameSource = AudioFrameSource & {
	getDebugState(): ManagedAudioFrameSourceDebugState;
	dispose(): void;
};

export interface ManagedAudioFrameSourceDebugState {
	audioContextState: AudioContextState | "none";
	sourceElementReady: boolean;
	sourceAttached: boolean;
	sourceAttachFailed: boolean;
	playing: boolean;
	currentTimeSeconds: number;
	mainSampleRate: number;
	mainFftSize: number;
	mainFreqAvg: number;
	mainFreqPeak: number;
	mainTimeRms: number;
	beatSampleRate: number;
	beatFftSize: number;
	beatFreqAvg: number;
	beatFreqPeak: number;
	beatTimeRms: number;
}

function readByteFrequencyStats(data: Uint8Array): { avg: number; peak: number } {
	if (!data.length) return { avg: 0, peak: 0 };
	let sum = 0;
	let peak = 0;
	for (let i = 0; i < data.length; i += 1) {
		const value = data[i] ?? 0;
		sum += value;
		if (value > peak) peak = value;
	}
	return {
		avg: sum / (data.length * 255),
		peak: peak / 255,
	};
}

function readByteTimeRms(data: Uint8Array): number {
	if (!data.length) return 0;
	let sum = 0;
	for (let i = 0; i < data.length; i += 1) {
		const sample = ((data[i] ?? 128) - 128) / 128;
		sum += sample * sample;
	}
	return Math.sqrt(sum / data.length);
}

function mergeFxState(target: FxState, source: Partial<FxState> | undefined): FxState {
	if (!source) return target;
	Object.assign(target, source);
	if (source.mouseXy) target.mouseXy = { ...target.mouseXy, ...source.mouseXy };
	return target;
}

export interface RuntimeVisualPerformancePolicy {
	adaptiveFps: number;
	pixelRatio: number;
	renderWidth?: number;
	renderHeight?: number;
	bloom: boolean;
	aiDepth: boolean;
	backCover: boolean;
}

type RuntimeVisualPerformanceFx = Pick<FxState, "performanceBackground" | "performanceQuality" | "bloom" | "aiDepth" | "backCover">;

export function resolveRuntimeVisualPerformancePolicy(input: {
	fx?: Partial<RuntimeVisualPerformanceFx> | null;
	devicePixelRatio?: number;
	documentHidden?: boolean;
	windowFocused?: boolean;
	prefersReducedMotion?: boolean;
}): RuntimeVisualPerformancePolicy {
	const fx = input.fx ?? {};
	const quality = typeof fx.performanceQuality === "string" ? fx.performanceQuality : "high";
	const background = typeof fx.performanceBackground === "string" ? fx.performanceBackground : "auto";
	const devicePixelRatio = Math.max(0.3, Number(input.devicePixelRatio) || 1);
	const inactive = input.documentHidden === true || input.windowFocused === false;
	const deepBackground = input.documentHidden === true && background !== "keep";
	const releaseBackground = inactive && background === "release";
	const autoBackground = inactive && background !== "keep";
	let adaptiveFps = 0;
	let pixelRatioCap = 1.25;
	let allowExpensiveEffects = true;
	let renderWidth: number | undefined;
	let renderHeight: number | undefined;

	if (quality === "eco") {
		adaptiveFps = 30;
		pixelRatioCap = 0.85;
		allowExpensiveEffects = false;
	} else if (quality === "balanced") {
		adaptiveFps = 45;
		pixelRatioCap = 1;
	} else if (quality === "ultra") {
		adaptiveFps = 0;
		pixelRatioCap = 1.35;
	}

	if (input.prefersReducedMotion) {
		adaptiveFps = adaptiveFps ? Math.min(adaptiveFps, 24) : 24;
		pixelRatioCap = Math.min(pixelRatioCap, 0.9);
		allowExpensiveEffects = false;
	}
	if (autoBackground) {
		adaptiveFps = releaseBackground ? 4 : Math.min(adaptiveFps || 24, 24);
		pixelRatioCap = releaseBackground ? 0.75 : Math.min(pixelRatioCap, 0.9);
		allowExpensiveEffects = false;
	}
	if (deepBackground) {
		adaptiveFps = 1;
		pixelRatioCap = 0.3;
		renderWidth = 4;
		renderHeight = 4;
		allowExpensiveEffects = false;
	}

	return {
		adaptiveFps,
		pixelRatio: Math.min(devicePixelRatio, pixelRatioCap),
		...(renderWidth ? { renderWidth } : {}),
		...(renderHeight ? { renderHeight } : {}),
		bloom: allowExpensiveEffects && fx.bloom === true,
		aiDepth: allowExpensiveEffects && fx.aiDepth === true,
		backCover: allowExpensiveEffects && fx.backCover === true,
	};
}

function applyRuntimeVisualPerformancePolicy(fx: FxState, policy: RuntimeVisualPerformancePolicy): void {
	if (!policy.bloom) fx.bloom = false;
	if (!policy.aiDepth) fx.aiDepth = false;
	if (!policy.backCover) fx.backCover = false;
}

export interface StageLyricsHostSupplierRefs {
	durationMsRef?: RefObject<number | null | undefined>;
	fallbackTextRef?: RefObject<string>;
	lyricsHasNativeKaraokeRef?: RefObject<boolean>;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}

export function createStageLyricsHostSuppliers(input: StageLyricsHostSupplierRefs): Required<Pick<
	StageLyricsLifecycleOpts,
	"audioDurationSupplier" | "fallbackTextSupplier" | "particleLyricsFlagSupplier" | "lyricGlowParticlesSupplier" | "lyricGlowStrengthSupplier" | "lyricGlowBeatFlagSupplier" | "lyricsHasNativeKaraokeSupplier"
>> {
	const readFx = (): FxState => mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	return {
		audioDurationSupplier: () => {
			const ms = input.durationMsRef?.current;
			return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1000 : NaN;
		},
		fallbackTextSupplier: () => input.fallbackTextRef?.current ?? "",
		particleLyricsFlagSupplier: () => readFx().particleLyrics !== false,
		lyricGlowParticlesSupplier: () => readFx().lyricGlowParticles === true,
		lyricGlowStrengthSupplier: () => {
			const fx = readFx();
			return fx.lyricGlow ? Math.min(0.85, Math.max(0, Number(fx.lyricGlowStrength) || 0)) : 0;
		},
		lyricGlowBeatFlagSupplier: () => {
			const fx = readFx();
			return fx.lyricGlow === true && fx.lyricGlowBeat === true;
		},
		lyricsHasNativeKaraokeSupplier: () => input.lyricsHasNativeKaraokeRef?.current === true,
	};
}

export interface StageLyricsShelfSupplierInput {
	shelfManager: Pick<ShelfManager, "getShelfVisibility" | "getMode" | "hasOpenContent" | "getShelfPinnedOpen" | "getShelfHoverCueValue">;
	shelfModeRef?: RefObject<string>;
	shelfPresenceRef?: RefObject<string>;
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}

export function createStageLyricsShelfSuppliers(input: StageLyricsShelfSupplierInput): Required<Pick<
	StageLyricsLifecycleOpts,
	"getShelfVisibility" | "getShelfMode" | "getShelfHasOpenContent" | "getShelfPinnedOpen" | "getShelfAlwaysVisible" | "getShelfHoverCueValue" | "getSkullShelfOpen"
>> {
	const readFx = (): FxState => mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	const getShelfMode = () => input.shelfModeRef?.current ?? input.fxDefaults?.shelf ?? input.shelfManager.getMode();
	const getShelfPresence = () => input.shelfPresenceRef?.current ?? input.fxDefaults?.shelfPresence ?? "always";
	return {
		getShelfVisibility: () => input.shelfManager.getShelfVisibility(),
		getShelfMode,
		getShelfHasOpenContent: () => input.shelfManager.hasOpenContent(),
		getShelfPinnedOpen: () => input.shelfManager.getShelfPinnedOpen(),
		getShelfAlwaysVisible: () => getShelfPresence() === "always",
		getShelfHoverCueValue: () => input.shelfManager.getShelfHoverCueValue(),
		getSkullShelfOpen: () => resolveSkullShelfCompositionActive({
			preset: readFx().preset,
			shelfMode: getShelfMode(),
			shelfVisibility: input.shelfManager.getShelfVisibility(),
			pinnedOpen: input.shelfManager.getShelfPinnedOpen(),
			hasOpenContent: input.shelfManager.hasOpenContent(),
		}),
	};
}

export interface ReadonlyAudioClockSnapshot {
	readonly playing: boolean;
	readonly currentTimeSeconds: number;
}

/**
 * 把 Playback Audio Runtime 发布的只读 frame source 包装成 Visual 自有生命周期。
 * wrapper 只读 analyser bytes 与媒体时钟；dispose 不会反向释放 playback graph。
 */
export function createReadonlyAudioFrameSource(input: {
	readonly getSource: () => AudioFrameSource | null;
	readonly getFallbackClock: () => ReadonlyAudioClockSnapshot;
}): ManagedAudioFrameSource {
	const empty = new Uint8Array(0);
	let disposed = false;
	const readFrame = (): AudioFrameBytes => {
		if (!disposed) {
			const source = input.getSource();
			const frame = source?.();
			if (frame) return frame;
		}
		const fallback = disposed
			? { playing: false, currentTimeSeconds: 0 }
			: input.getFallbackClock();
		return {
			mainFreqData: empty,
			mainTimeData: empty,
			mainSampleRate: 0,
			mainFftSize: 0,
			beatFreqData: empty,
			beatTimeData: empty,
			beatSampleRate: 0,
			beatFftSize: 0,
			playing: fallback.playing,
			currentTimeSeconds: Math.max(0, Number(fallback.currentTimeSeconds) || 0),
		};
	};
	const frameSource = (() => readFrame()) as ManagedAudioFrameSource;
	frameSource.getDebugState = () => {
		const frame = readFrame();
		const sourceReady = !disposed && input.getSource() !== null;
		const mainStats = readByteFrequencyStats(frame.mainFreqData);
		const beatStats = readByteFrequencyStats(frame.beatFreqData);
		return {
			audioContextState: "none",
			sourceElementReady: sourceReady,
			sourceAttached: sourceReady,
			sourceAttachFailed: false,
			playing: frame.playing,
			currentTimeSeconds: frame.currentTimeSeconds,
			mainSampleRate: frame.mainSampleRate,
			mainFftSize: frame.mainFftSize,
			mainFreqAvg: mainStats.avg,
			mainFreqPeak: mainStats.peak,
			mainTimeRms: readByteTimeRms(frame.mainTimeData),
			beatSampleRate: frame.beatSampleRate,
			beatFftSize: frame.beatFftSize,
			beatFreqAvg: beatStats.avg,
			beatFreqPeak: beatStats.peak,
			beatTimeRms: readByteTimeRms(frame.beatTimeData),
		};
	};
	frameSource.dispose = () => {
		if (disposed) return;
		disposed = true;
	};
	return frameSource;
}

export function shouldResetLyricStageCameraView(input: {
	wasHomeActive: boolean;
	homeActive: boolean;
	playbackActive: boolean;
}): boolean {
	return input.wasHomeActive && !input.homeActive && input.playbackActive;
}

export function shouldRetryVisualCoverLoad(input: {
	coverUrl: string | null | undefined;
	hasCover: number;
	nowMs: number;
	lastAttemptAtMs: number;
	lastAttemptUrl: string;
	intervalMs?: number;
}): boolean {
	const coverUrl = String(input.coverUrl ?? "").trim();
	if (!coverUrl) return false;
	if (Number(input.hasCover) > 0.5) return false;
	if (coverUrl !== input.lastAttemptUrl) return true;
	const interval = Math.max(250, input.intervalMs ?? VISUAL_COVER_RETRY_INTERVAL_MS);
	return input.nowMs - input.lastAttemptAtMs >= interval;
}

export interface SonicPointerReleaseState {
	readonly preset: number;
	readonly dragged: boolean;
	readonly overUi: boolean;
	readonly freeCameraActive: boolean;
	readonly heldMs: number;
	readonly ndcX: number;
	readonly ndcY: number;
}

export function resolveSonicPointerRipple(
	state: SonicPointerReleaseState,
): Readonly<{ x: number; z: number; strength: number }> | null {
	if (state.preset !== 7 || state.dragged || state.overUi || state.freeCameraActive) return null;
	return {
		x: state.ndcX * 17,
		z: state.ndcY * 17,
		strength: Math.min(3, 0.25 + (Math.max(0, state.heldMs) / 1000) * 2.6),
	};
}

function attachBaselineCanvasPointerInput(input: {
	target: HTMLElement;
	windowTarget: Window;
	homeVisual: HomeVisual;
	cinema: CinemaCamera;
	freeCamera: ReturnType<typeof createDefaultFreeCameraState>;
	camera: THREE.PerspectiveCamera;
	pointerTarget: { x: number; y: number };
	isPointerOverUi: (event: MouseEvent | WheelEvent) => boolean;
	getPreset?: () => number;
	onSonicPointerRipple?: (x: number, z: number, strength: number) => void;
}): () => void {
	let rotating = false;
	let dragged = false;
	let pointerDownAt = 0;
	let lastX = 0;
	let lastY = 0;
	let lastT = 0;
	const pointerNdc = new THREE.Vector2();
	const raycaster = new THREE.Raycaster();
	const plane = new THREE.Plane();
	const planePoint = new THREE.Vector3();
	const planeNormal = new THREE.Vector3();
	const worldHit = new THREE.Vector3();
	const localHit = new THREE.Vector3();
	const worldQuat = new THREE.Quaternion();

	const particleLocalPointFromNdc = (ndcX: number, ndcY: number): { x: number; y: number } | null => {
		pointerNdc.set(ndcX, ndcY);
		raycaster.setFromCamera(pointerNdc, input.camera);
		const points = input.homeVisual.getField().points as unknown as THREE.Points;
		if (points) {
			points.updateMatrixWorld(true);
			points.getWorldPosition(planePoint);
			points.getWorldQuaternion(worldQuat);
			planeNormal.set(0, 0, 1).applyQuaternion(worldQuat).normalize();
			if (Math.abs(planeNormal.dot(raycaster.ray.direction)) >= 0.16) {
				plane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
				if (raycaster.ray.intersectPlane(plane, worldHit)) {
					localHit.copy(worldHit);
					points.worldToLocal(localHit);
					if (Number.isFinite(localHit.x) && Number.isFinite(localHit.y) && Math.abs(localHit.x) < 8.5 && Math.abs(localHit.y) < 8.5) {
						return { x: localHit.x, y: localHit.y };
					}
				}
			}
		}
		planeNormal.set(0, 0, 1);
		plane.set(planeNormal, 0);
		if (raycaster.ray.intersectPlane(plane, worldHit)) {
			if (Number.isFinite(worldHit.x) && Number.isFinite(worldHit.y) && Math.abs(worldHit.x) < 8.5 && Math.abs(worldHit.y) < 8.5) {
				return { x: worldHit.x, y: worldHit.y };
			}
		}
		return null;
	};

	const updatePointerTarget = (clientX: number, clientY: number) => {
		const width = Math.max(1, input.windowTarget.innerWidth || input.target.clientWidth || 1);
		const height = Math.max(1, input.windowTarget.innerHeight || input.target.clientHeight || 1);
		const ndcX = (clientX / width) * 2 - 1;
		const ndcY = -(clientY / height) * 2 + 1;
		input.pointerTarget.x = ndcX;
		input.pointerTarget.y = ndcY;
		const fx = input.homeVisual.getFx();
		const local = particleLocalPointFromNdc(ndcX, ndcY);
		if (local) {
			fx.mouseActive = true;
			fx.mouseXy = local;
		} else {
			fx.mouseActive = false;
			fx.mouseXy = { x: -999, y: -999 };
		}
	};

	const clearPointer = () => {
		const fx = input.homeVisual.getFx();
		fx.mouseActive = false;
		fx.mouseXy = { x: -999, y: -999 };
	};

	const onMouseDown = (event: MouseEvent) => {
		if (event.button === 2 || input.isPointerOverUi(event)) return;
		rotating = true;
		dragged = false;
		pointerDownAt = performance.now();
		lastX = event.clientX;
		lastY = event.clientY;
		lastT = performance.now();
		input.cinema.getState().orbit.rotating = true;
		updatePointerTarget(event.clientX, event.clientY);
	};

	const onMouseMove = (event: MouseEvent) => {
		if (input.isPointerOverUi(event) && !rotating) {
			clearPointer();
			return;
		}
		updatePointerTarget(event.clientX, event.clientY);
		if (!rotating || input.freeCamera.active) return;
		if (Math.hypot(event.clientX - lastX, event.clientY - lastY) > 2) dragged = true;
		const now = performance.now();
		const dt = Math.max(1 / 120, Math.min(0.08, (now - lastT) / 1000 || 1 / 60));
		input.homeVisual.applyPointerSpinDrag(event.clientX - lastX, event.clientY - lastY, dt);
		const orbit = input.cinema.getState().orbit;
		orbit.centerLocked = false;
		orbit.rotating = true;
		lastX = event.clientX;
		lastY = event.clientY;
		lastT = now;
	};

	const endDrag = (event?: MouseEvent) => {
		if (rotating && event) {
			const ripple = resolveSonicPointerRipple({
				preset: input.getPreset?.() ?? 0,
				dragged,
				overUi: input.isPointerOverUi(event),
				freeCameraActive: input.freeCamera.active,
				heldMs: performance.now() - pointerDownAt,
				ndcX: input.pointerTarget.x,
				ndcY: input.pointerTarget.y,
			});
			if (ripple !== null) {
				input.onSonicPointerRipple?.(ripple.x, ripple.z, ripple.strength);
			}
		}
		rotating = false;
		dragged = false;
		input.cinema.getState().orbit.rotating = false;
	};

	const onMouseLeave = () => {
		clearPointer();
		endDrag();
	};
	const onWindowBlur = () => endDrag();

	const onWheel = (event: WheelEvent) => {
		if (input.isPointerOverUi(event) || input.freeCamera.active) return;
		event.preventDefault();
		const orbit = input.cinema.getState().orbit;
		orbit.centerLocked = false;
		if (input.homeVisual.applySkullWheel(event.deltaY)) return;
		orbit.userRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + event.deltaY * 0.005));
	};

	input.target.addEventListener("mousedown", onMouseDown);
	input.windowTarget.addEventListener("mousemove", onMouseMove);
	input.windowTarget.addEventListener("mouseup", endDrag);
	input.windowTarget.addEventListener("blur", onWindowBlur);
	input.target.addEventListener("mouseleave", onMouseLeave);
	input.target.addEventListener("wheel", onWheel, { passive: false });
	return () => {
		input.target.removeEventListener("mousedown", onMouseDown);
		input.windowTarget.removeEventListener("mousemove", onMouseMove);
		input.windowTarget.removeEventListener("mouseup", endDrag);
		input.windowTarget.removeEventListener("blur", onWindowBlur);
		input.target.removeEventListener("mouseleave", onMouseLeave);
		input.target.removeEventListener("wheel", onWheel);
	};
}

function getPlaylistPanelFocusInfo(doc: Document): QueueFocusPanelInfo | null {
	const panel = doc.querySelector("#playlist-panel");
	if (!(panel instanceof HTMLElement)) return null;
	const rect = panel.getBoundingClientRect();
	return {
		active: panel.classList.contains("peek") || panel.classList.contains("show"),
		peek: panel.classList.contains("peek"),
		rect: {
			left: rect.left,
			right: rect.right,
			top: rect.top,
			bottom: rect.bottom,
		},
	};
}

export function isRuntimeShelfPreviewActive(
	presence: string | null | undefined,
	shelfVisibility: number,
): boolean {
	return presence === "auto" && shelfVisibility > 0.16;
}

export interface SkullShelfCompositionInput {
	preset: number | null | undefined;
	shelfMode: string | null | undefined;
	shelfVisibility: number;
	pinnedOpen: boolean;
	hasOpenContent: boolean;
}

export function resolveSkullShelfCompositionActive(input: SkullShelfCompositionInput): boolean {
	if (Number(input.preset) !== 6) return false;
	if (input.shelfMode !== "side") return false;
	return input.pinnedOpen || input.shelfVisibility > 0.18 || input.hasOpenContent;
}

export interface WallpaperShelfDimInput {
	preset: number | null | undefined;
	shelfMode: string | null | undefined;
	pinnedOpen: boolean;
	hasOpenContent: boolean;
	shelfVisibility?: number;
	hoverCueValue?: number;
}

export function shouldDimWallpaperParticlesForShelf(input: WallpaperShelfDimInput): boolean {
	if (Number(input.preset) !== 5) return false;
	if (input.shelfMode !== "side") return false;
	return input.pinnedOpen || input.hasOpenContent;
}

export function resolveSkullMouthLyricsActive(input: {
	preset: number | null | undefined;
	skullParticlesVisible?: boolean;
}): boolean {
	return Number(input.preset) === 6 && input.skullParticlesVisible === true;
}

export function resolveRuntimeWallpaperSafe(input: {
	fxDefaults?: Partial<FxState>;
	fxRef?: RefObject<Partial<FxState> | undefined>;
}): boolean {
	const fx = mergeFxState(mergeFxState(cloneFxState(), input.fxDefaults), input.fxRef?.current);
	return isWallpaperSafeShelfPreset(fx.preset);
}

function clampRange(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function hexToRgbValue(hex: string): { r: number; g: number; b: number } {
	const raw = String(hex || "").trim().replace(/^#/, "");
	const normalized = /^[0-9a-f]{3}$/i.test(raw)
		? raw.split("").map((c) => c + c).join("")
		: raw;
	const valid = /^[0-9a-f]{6}$/i.test(normalized) ? normalized : "a9b8c8";
	const n = parseInt(valid, 16);
	return {
		r: (n >> 16) & 255,
		g: (n >> 8) & 255,
		b: n & 255,
	};
}

function rgbToHslValue(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h /= 6;
	}
	return { h, s, l };
}

function hueToRgbValue(p: number, q: number, t: number): number {
	let v = t;
	if (v < 0) v += 1;
	if (v > 1) v -= 1;
	if (v < 1 / 6) return p + (q - p) * 6 * v;
	if (v < 1 / 2) return q;
	if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
	return p;
}

function hslToRgbCss(h: number, s: number, l: number): string {
	let r: number;
	let g: number;
	let b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hueToRgbValue(p, q, h + 1 / 3);
		g = hueToRgbValue(p, q, h);
		b = hueToRgbValue(p, q, h - 1 / 3);
	}
	return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export function lyricPaletteFromHex(hex: string): LyricPalette {
	const c = hexToRgbValue(hex);
	const hsl = rgbToHslValue(c.r, c.g, c.b);
	const neutral = hsl.s < 0.035;
	const s = neutral ? 0 : clampRange(hsl.s * 1.08, 0.14, 0.92);
	let l = hsl.l;
	if (l < 0.11) l = 0.15 + l * 1.18;
	else if (l < 0.28) l = 0.21 + (l - 0.11) * 1.18;
	else l = clampRange(l, 0.30, 0.82);
	l = clampRange(l, 0.14, 0.84);
	const primary = hslToRgbCss(hsl.h, s, l);
	const secondary = hslToRgbCss(
		(hsl.h + 0.055) % 1,
		neutral ? 0 : clampRange(s * 0.88, 0.12, 0.78),
		clampRange(l + (l < 0.38 ? 0.10 : -0.08), 0.18, 0.76),
	);
	const highlight = hslToRgbCss(
		(hsl.h + 0.018) % 1,
		neutral ? 0 : clampRange(s * 0.72, 0.10, 0.70),
		clampRange(l + 0.22, 0.38, 0.92),
	);
	return {
		primary,
		secondary,
		highlight,
		glowColor: secondary,
	};
}

export function resolveStageLyricPalette(
	fxInput: Partial<FxState>,
	coverPalette?: LyricPalette | null,
): LyricPalette {
	const fx = mergeFxState(cloneFxState(), fxInput);
	const base = fx.lyricColorMode === "custom"
		? lyricPaletteFromHex(fx.lyricColor)
		: coverPalette ?? DEFAULT_LYRIC_PALETTE;
	const primary = base.primary;
	const highlightPalette = fx.lyricHighlightMode === "custom"
		? lyricPaletteFromHex(fx.lyricHighlightColor)
		: null;
	const glowPalette = fx.lyricGlowLinked === false
		? lyricPaletteFromHex(fx.lyricGlowColor)
		: null;
	const highlight = highlightPalette?.primary ?? base.highlight;
	const glowColor = glowPalette?.primary ?? highlightPalette?.secondary ?? base.glowColor;
	return {
		primary,
		secondary: base.secondary,
		highlight,
		glowColor,
	};
}

export function setRuntimeShelfMode(
	shelfModeRef: RefObject<string> | undefined,
	mode: "side",
	onShelfModeChange?: (mode: "side") => void,
): void {
	if (shelfModeRef) shelfModeRef.current = mode;
	onShelfModeChange?.(mode);
}

const HOME_WALLPAPER_PRESET = 5;

export function resolveHomeVisualPreset(
	homeActive: boolean,
	currentPreset: number,
	defaultPreset: number,
	previousPreset: number | null,
	opts: {
		playbackActive?: boolean;
		playbackPreset?: number | null;
		previewEnabled?: boolean;
		committedPresetChanged?: boolean;
	} = {},
): { preset: number; previousPreset: number | null; changed: boolean } {
	if (homeActive && (opts.previewEnabled === false || opts.committedPresetChanged)) {
		return {
			preset: defaultPreset,
			previousPreset: null,
			changed: currentPreset !== defaultPreset,
		};
	}
	if (homeActive && (defaultPreset === 7 || defaultPreset === 8)) {
		return {
			preset: defaultPreset,
			previousPreset: null,
			changed: currentPreset !== defaultPreset,
		};
	}
	if (homeActive) {
		const nextPreviousPreset = previousPreset ?? currentPreset;
		return {
			preset: HOME_WALLPAPER_PRESET,
			previousPreset: nextPreviousPreset,
			changed: currentPreset !== HOME_WALLPAPER_PRESET || previousPreset === null,
		};
	}
	const target = previousPreset ?? (
		opts.playbackActive && typeof opts.playbackPreset === "number"
			? opts.playbackPreset
			: defaultPreset
	);
	return {
		preset: target,
		previousPreset: null,
		changed: currentPreset !== target,
	};
}

export function resolveStageLyricLayoutOptions(
	fx: Partial<FxState>,
	orbitState: { orbitCenterLocked?: boolean; orbitRecentering?: boolean } = {},
	opts: { skullParticlesVisible?: boolean } = {},
) {
	return {
		lyricCameraLock: !!fx.lyricCameraLock,
		lyricScale: fx.lyricScale,
		lyricOffsetX: fx.lyricOffsetX,
		lyricOffsetY: fx.lyricOffsetY,
		lyricOffsetZ: fx.lyricOffsetZ,
		lyricTiltX: fx.lyricTiltX,
		lyricTiltY: fx.lyricTiltY,
		preset: fx.preset,
		skullLyricEdgeGuard: Number(fx.preset) === 6 && !!(orbitState.orbitCenterLocked || orbitState.orbitRecentering),
		skullMouthLyrics: resolveSkullMouthLyricsActive({
			preset: fx.preset,
			skullParticlesVisible: opts.skullParticlesVisible,
		}),
	};
}

export function resolveLegacyVisualCameraPolicyInput(
	fx: Partial<FxState>,
	stageWorldTarget: VisualCameraTarget | null,
): Omit<VisualCameraPolicyInput, "shelfFocusTarget"> {
	const preset = Number(fx.preset) || 0;
	const lyricCameraLock = !!fx.lyricCameraLock;
	return {
		activePreset: preset,
		lyricCameraLock,
		wallpaperLyricLock: preset === 5 && lyricCameraLock,
		stageWorldTarget: fx.particleLyrics === false ? null : stageWorldTarget,
	};
}

export function sonicPaletteSnapshotFromLyricPalette(
	palette: LyricPalette | null | undefined,
): Readonly<{ primary: string; secondary: string; highlight: string }> | null {
	if (!palette) return null;
	return Object.freeze({
		primary: palette.primary,
		secondary: palette.secondary,
		highlight: palette.highlight,
	});
}

function sonicPaletteSnapshotKey(palette: LyricPalette | null | undefined): string {
	const snapshot = sonicPaletteSnapshotFromLyricPalette(palette);
	return snapshot ? `${snapshot.primary}|${snapshot.secondary}|${snapshot.highlight}` : "none";
}

class LegacyVisualCompositionCancelledError extends Error {
	constructor() {
		super("Legacy visual composition mount was cancelled.");
		this.name = "LegacyVisualCompositionCancelledError";
	}
}

function registerOwnedCleanup(
	scope: VisualResourceScope,
	isCurrent: () => boolean,
	owner: string,
	kind: VisualResourceKind,
	dispose: () => void,
	retention: VisualResourceRetention = "persistent",
): void {
	if (!isCurrent()) {
		dispose();
		throw new LegacyVisualCompositionCancelledError();
	}
	try {
		scope.register({ owner, kind, retention, dispose });
	} catch (error) {
		dispose();
		throw error;
	}
}

function registerOwnedDisposable<T extends { dispose(): void }>(
	scope: VisualResourceScope,
	isCurrent: () => boolean,
	owner: string,
	kind: VisualResourceKind,
	resource: T,
	retention: VisualResourceRetention = "persistent",
): T {
	registerOwnedCleanup(scope, isCurrent, owner, kind, () => resource.dispose(), retention);
	return resource;
}

export async function mountOwnedStageLyricsLifecycle(input: {
	readonly scope: VisualResourceScope;
	readonly lifecycle: StageLyricsLifecycle;
	readonly scene: Parameters<StageLyricsLifecycle["mount"]>[0];
	readonly isCurrent: () => boolean;
	readonly onMounted: () => void;
}): Promise<boolean> {
	registerOwnedDisposable(input.scope, input.isCurrent, "stage-lyrics", "mesh", input.lifecycle);
	await input.lifecycle.mount(input.scene);
	if (!input.isCurrent()) return false;
	input.onMounted();
	return true;
}

export interface CreateLegacyVisualCompositionOptions {
	readonly audioFrameSource: AudioFrameSource;
	readonly events: LegacyVisualEventSink;
	readonly getPrefersReducedMotion?: () => boolean;
	readonly getPlaybackVolume: () => number;
	/** M4 确定性视觉证据使用；产品路径继续使用默认随机源。 */
	readonly random?: () => number;
	/** 仅暴露正式运行时的有限控制面给隔离 parity route。 */
	readonly onDebugController?: (controller: LegacyVisualDebugController | null) => void;
	/** 仅在 M4 parity 证据页启用；正式产品路径默认不发起 timer query。 */
	readonly enableGpuTimerQuery?: boolean;
}

export interface LegacyVisualDebugController {
	seekShelf(index: number): void;
	openShelfDetail(index: number, rows: readonly ShelfContentRow[]): void;
	scrollShelfDetail(delta: number): void;
	closeShelfDetail(immediate?: boolean): void;
	getRendererDiagnostics(): {
		readonly drawCalls: number;
		readonly triangles: number;
		readonly points: number;
		readonly lines: number;
		readonly geometries: number;
		readonly textures: number;
		readonly gpuTimerQuerySupported: boolean;
		readonly gpuTiming: GpuFrameTimingSnapshot | null;
	};
}

export const LEGACY_VISUAL_LANE_CADENCE = Object.freeze({
	Beatmap: 60,
	Ripples: 60,
	Shelf: 30,
	LyricParticles: 45,
	SonicTopography: "presentation",
	SonicWorkshop: "presentation",
	StageLyrics: 45,
	DesktopOverlaySync: 12,
	HomeVisual: "presentation",
	CameraCinematic: "presentation",
} as const);

interface MountedLegacySubsystems {
	homeVisual: HomeVisual;
	shelfManager: ShelfManager;
	sonic: SonicTopographyRuntime;
	lifecycle: StageLyricsLifecycle;
}

export function normalizeSonicPerformanceQuality(value: string | null | undefined): SonicPerformanceQuality {
	return value === "eco" || value === "balanced" || value === "high" || value === "ultra"
		? value
		: "high";
}

export function shouldActivateSonicTopography(preset: number | null | undefined): boolean {
	return Number(preset) === 7;
}

export function shouldActivateSonicWorkshop(preset: number | null | undefined): boolean {
	return Number(preset) === 8;
}

export function resolveSonicShelfMode(
	preset: number | null | undefined,
	mode: string | null | undefined,
	hasOpenContent: boolean,
): string {
	if (Number(preset) !== 7 || hasOpenContent) return mode ?? "side";
	return "off";
}

export interface LegacyHomeVisualRuntimeGovernor {
	sync(mode: VisualRuntimeMode): void;
}

export function createLegacyHomeVisualRuntimeGovernor(input: {
	readonly homeVisual: Pick<HomeVisual, "setRuntimeActive">;
	readonly tasks: Pick<VisualEngineCompositionContext["tasks"], "cancelPriority">;
	readonly resources: Pick<VisualResourceScope, "releaseRetention">;
	readonly beforeReleaseResources?: () => void;
	readonly trimCache?: (maxEntries: number) => void;
	readonly refreshPerformanceSnapshots: () => void;
}): LegacyHomeVisualRuntimeGovernor {
	let previousMode: VisualRuntimeMode | null = null;
	let homeRuntimeActive = true;
	return {
		sync(mode) {
			if (mode === previousMode) return;
			if (mode === "released") {
				input.homeVisual.setRuntimeActive(false);
				homeRuntimeActive = false;
				input.beforeReleaseResources?.();
				input.tasks.cancelPriority("background");
				(input.trimCache ?? trimHomeCoverTextureCache)(0);
				input.resources.releaseRetention(["rebuildable", "ephemeral"]);
				input.refreshPerformanceSnapshots();
			} else if (
				!homeRuntimeActive &&
				(mode === "foreground" || mode === "background")
			) {
				input.homeVisual.setRuntimeActive(true);
				homeRuntimeActive = true;
			}
			previousMode = mode;
		},
	};
}

function mutableFxCopy(fx: Readonly<Partial<FxState>>): Partial<FxState> {
	return {
		...fx,
		...(fx.mouseXy ? { mouseXy: { ...fx.mouseXy } } : {}),
		...(fx.stageLyrics ? { stageLyrics: { ...fx.stageLyrics } } : {}),
		...(fx.sonic ? {
			sonic: {
				...fx.sonic,
				terrain: { ...fx.sonic.terrain },
				eq: { ...fx.sonic.eq },
				colors: { ...fx.sonic.colors },
				floating: { ...fx.sonic.floating },
				trigger: { ...fx.sonic.trigger },
			},
		} : {}),
		...(fx.workshop ? {
			workshop: {
				...fx.workshop,
				colors: { ...fx.workshop.colors },
			},
		} : {}),
	};
}

function createRuntimeRefs(
	container: HTMLElement,
	events: LegacyVisualEventSink,
): VisualEngineRefs {
	if (container.tagName.toLowerCase() !== "div") {
		throw new TypeError("Legacy visual composition host must be a div element.");
	}
	const host = container as HTMLDivElement;
	return {
		hostRef: { current: host },
		positionRef: { current: 0 },
		durationMsRef: { current: null },
		isPlayingRef: { current: false },
		lyricLinesRef: { current: [] },
		fallbackTextRef: { current: "" },
		lyricsHasNativeKaraokeRef: { current: false },
		shelfItemsRef: { current: [] },
		shelfItemsVersionRef: { current: 0 },
		coverUrlRef: { current: "" },
		coverFallbackUrlRef: { current: "" },
		coverUrlVersionRef: { current: 0 },
		beatMapKeyRef: { current: "" },
		beatMapRef: { current: null },
		beatMapVersionRef: { current: 0 },
		splashActiveRef: { current: false },
		homeActiveRef: { current: false },
		shelfModeRef: { current: "side" },
		shelfCameraModeRef: { current: "dynamic" },
		shelfPresenceRef: { current: "always" },
		shelfMergeCollectionsRef: { current: false },
		shelfMineCountRef: { current: 0 },
		shelfFavCountRef: { current: 0 },
		wallpaperSafeRef: { current: false },
		secondaryLeftDisplaySeamGuardRef: { current: false },
		onShelfPlayQueueIndexRef: { current: (index) => events.onShelfPlayQueueIndex(index) },
		onShelfPlayPlaylistRef: { current: (payload) => events.onShelfPlayPlaylist(payload) },
		onShelfDetailRowClickRef: { current: (payload) => events.onShelfDetailRowClick(payload) },
		onShelfOpenDetailContentRef: { current: (payload, writer) => events.onShelfOpenDetailContent(payload, writer) },
		onShelfOpenContentChangeRef: { current: (open) => events.onShelfOpenContentChange(open) },
		onShelfPaneChangeRef: { current: (pane) => events.onShelfPaneChange(pane) },
		lifecycleRef: { current: null },
		coverResolution: 1.55,
		fxDefaults: undefined,
		fxRef: { current: undefined },
		onShelfModeChange: (mode) => events.onShelfModeChange(mode),
	};
}

function syncRuntimeRefs(refs: VisualEngineRefs, snapshot: VisualFrameSnapshot): void {
	refs.durationMsRef!.current = snapshot.playback.durationMs;
	refs.isPlayingRef.current = snapshot.playback.playing;
	refs.fallbackTextRef!.current = snapshot.lyrics.fallbackText;
	refs.lyricsHasNativeKaraokeRef!.current = snapshot.lyrics.hasNativeKaraoke;
	if (refs.lyricLinesRef.current !== snapshot.lyrics.lines) {
		refs.lyricLinesRef.current = snapshot.lyrics.lines as VisualLyricLine[];
		try {
			refs.lifecycleRef.current?.setLyricLines(refs.lyricLinesRef.current);
		} catch {
		}
	}
	if (refs.shelfItemsRef.current !== snapshot.shelf.items) {
		refs.shelfItemsRef.current = snapshot.shelf.items as ShelfItem[];
		refs.shelfItemsVersionRef.current += 1;
	}
	if (
		refs.coverUrlRef!.current !== snapshot.playback.coverUrl
		|| refs.coverFallbackUrlRef!.current !== snapshot.playback.coverFallbackUrl
	) {
		refs.coverUrlRef!.current = snapshot.playback.coverUrl;
		refs.coverFallbackUrlRef!.current = snapshot.playback.coverFallbackUrl;
		refs.coverUrlVersionRef!.current += 1;
	}
	if (
		refs.beatMapKeyRef!.current !== snapshot.playback.beatMapKey ||
		refs.beatMapRef!.current !== snapshot.playback.beatMap
	) {
		refs.beatMapKeyRef!.current = snapshot.playback.beatMapKey;
		refs.beatMapRef!.current = snapshot.playback.beatMap;
		refs.beatMapVersionRef!.current += 1;
	}
	refs.splashActiveRef.current = snapshot.playback.splashActive;
	refs.homeActiveRef!.current = snapshot.playback.homeActive;
	refs.shelfModeRef!.current = snapshot.shelf.mode;
	refs.shelfCameraModeRef!.current = snapshot.shelf.cameraMode;
	refs.shelfPresenceRef!.current = snapshot.shelf.presence;
	refs.shelfMergeCollectionsRef!.current = snapshot.shelf.mergeCollections;
	refs.shelfMineCountRef!.current = snapshot.shelf.mineCount;
	refs.shelfFavCountRef!.current = snapshot.shelf.favCount;
	refs.wallpaperSafeRef!.current = snapshot.settings.wallpaperSafe;
	refs.secondaryLeftDisplaySeamGuardRef!.current = snapshot.shelf.secondaryLeftDisplaySeamGuard;
	refs.coverResolution = snapshot.settings.coverResolution;
	refs.fxRef!.current = mutableFxCopy(snapshot.settings.fx);
}

export function createLegacyVisualComposition(
	options: CreateLegacyVisualCompositionOptions,
): VisualEngineComposition {
	let disposed = false;
	let mounted = false;
	let generation = 0;
	let refs: VisualEngineRefs | null = null;
	let context: VisualEngineCompositionContext | null = null;
	let currentVisibility: VisualVisibilityState = {
		documentVisible: true,
		windowVisible: true,
		windowFocused: true,
		windowMinimized: false,
	};
	let subsystems: MountedLegacySubsystems | null = null;
	let ownedScope: VisualResourceScope | null = null;
	let runtimeGovernor: LegacyHomeVisualRuntimeGovernor | null = null;

	return {
		async mount(nextContext) {
			if (mounted) throw new Error("Legacy visual composition can only be mounted once.");
			if (disposed) throw new LegacyVisualCompositionCancelledError();
			if (typeof window === "undefined" || typeof document === "undefined") {
				throw new Error("Legacy visual composition requires a browser environment.");
			}
			mounted = true;
			context = nextContext;
			generation += 1;
			const mountGeneration = generation;
			const scope = nextContext.resources.createChild("legacy-visual-composition");
			ownedScope = scope;
			const mountTicket = nextContext.cancellation.issue("legacy-visual-composition", "mount");
			const isCurrent = () => (
				!disposed
				&& generation === mountGeneration
				&& scope.isOpen()
				&& !mountTicket.signal.aborted
				&& mountTicket.isCurrent()
			);
			const host = nextContext.container;
			refs = createRuntimeRefs(host, options.events);
			syncRuntimeRefs(refs, nextContext.getFrameSnapshot());
			const readPrefersReducedMotion = () => (
				options.getPrefersReducedMotion?.()
				?? nextContext.getFrameSnapshot().settings.prefersReducedMotion
			);

			const frameSource = registerOwnedDisposable(
				scope,
				isCurrent,
				"audio-frame-source",
				"async-task",
				createReadonlyAudioFrameSource({
					getSource: () => options.audioFrameSource,
					getFallbackClock: () => ({
						playing: nextContext.mediaClock.isPlaying(),
						currentTimeSeconds: nextContext.mediaClock.currentTimeSeconds(),
					}),
				}),
			);
			const audioEngine = registerOwnedDisposable(scope, isCurrent, "audio-reactivity", "subscription", createAudioReactivity({
				frameSource,
				prefersReducedMotion: readPrefersReducedMotion,
			}));
			const readRuntimeFx = (): FxState => mergeFxState(cloneFxState(), refs?.fxRef?.current);
			const runtimeVisualPerformanceFx: Partial<RuntimeVisualPerformanceFx> = {};
			const readRuntimeVisualPerformanceFx = (): Partial<RuntimeVisualPerformanceFx> => {
				const current = refs?.fxRef?.current;
				runtimeVisualPerformanceFx.performanceBackground = current?.performanceBackground;
				runtimeVisualPerformanceFx.performanceQuality = current?.performanceQuality;
				runtimeVisualPerformanceFx.bloom = current?.bloom;
				runtimeVisualPerformanceFx.aiDepth = current?.aiDepth;
				runtimeVisualPerformanceFx.backCover = current?.backCover;
				return runtimeVisualPerformanceFx;
			};
			const readVisualPerformancePolicy = (): RuntimeVisualPerformancePolicy => resolveRuntimeVisualPerformancePolicy({
				fx: readRuntimeVisualPerformanceFx(),
				devicePixelRatio: window.devicePixelRatio,
				documentHidden: !currentVisibility.documentVisible,
				windowFocused: currentVisibility.windowFocused,
				prefersReducedMotion: readPrefersReducedMotion(),
			});
			const initialVisualPerformancePolicy = readVisualPerformancePolicy();
			const visualRendererPolicyKey = (policy: RuntimeVisualPerformancePolicy): string =>
				`${policy.pixelRatio}|${policy.renderWidth ?? "auto"}|${policy.renderHeight ?? "auto"}`;
			let activeVisualRendererPolicyKey = visualRendererPolicyKey(initialVisualPerformancePolicy);
			const renderer = registerOwnedDisposable(scope, isCurrent, "renderer", "mesh", await createRenderer(host, {
				pixelRatio: initialVisualPerformancePolicy.pixelRatio,
				powerPreference: initialVisualPerformancePolicy.pixelRatio <= 0.9 ? "low-power" : "high-performance",
			}));
			const visualPerformanceResizeOpts = (
				opts: Parameters<typeof renderer.resize>[0] | undefined,
				policy: RuntimeVisualPerformancePolicy,
			): Parameters<typeof renderer.resize>[0] => ({
				...opts,
				width: policy.renderWidth ?? opts?.width,
				height: policy.renderHeight ?? opts?.height,
				pixelRatio: policy.pixelRatio,
			});
			const resizeAwareRenderer = {
				...renderer,
				resize: (resizeOptions?: Parameters<typeof renderer.resize>[0]) => {
					const policy = readVisualPerformancePolicy();
					activeVisualRendererPolicyKey = visualRendererPolicyKey(policy);
					renderer.resize(visualPerformanceResizeOpts(resizeOptions, policy));
					refs?.lifecycleRef.current?.requestCameraSnap(10);
				},
			};
			const offResize = attachRendererResizeSync(host, resizeAwareRenderer);
			registerOwnedCleanup(scope, isCurrent, "renderer-resize", "listener", offResize);
			resizeAwareRenderer.resize();
			let lifecycle: StageLyricsLifecycle | null = null;
			const cinema = registerOwnedDisposable(scope, isCurrent, "cinema-camera", "subscription", createCinemaCamera({
				camera: renderer.camera,
				getCurrentTime: () => nextContext.mediaClock.currentTimeSeconds(),
				cameraPolicyInputSupplier: () => {
					const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
					return resolveLegacyVisualCameraPolicyInput(fx, lifecycle?.getWorldLookAtTarget() ?? null);
				},
			}));
			const shelfSelectSound = createShelfSelectSoundPlayer({
				audioContext: null,
				window,
				volume: () => {
					const supplied = options.getPlaybackVolume();
					if (typeof supplied === "number" && Number.isFinite(supplied)) {
						return Math.max(0, Math.min(1, supplied));
					}
					return 0;
				},
			});
			const freeCamera = createDefaultFreeCameraState();
			const runtimeFx = readRuntimeFx();
			applyRuntimeVisualPerformancePolicy(runtimeFx, readVisualPerformancePolicy());
			let latestCoverLyricPalette: LyricPalette | null = null;
			let lastAppliedLyricPaletteKey = "";
			const applyStageLyricPalette = () => {
				const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
				const palette = resolveStageLyricPalette(fx, latestCoverLyricPalette);
				const key = `${palette.primary}|${palette.secondary}|${palette.highlight}|${palette.glowColor}`;
				if (key === lastAppliedLyricPaletteKey) return;
				lastAppliedLyricPaletteKey = key;
				refs?.lifecycleRef.current?.setPalette(palette);
			};
			const aiDepthEstimator = createJsDelivrAiDepthEstimator();
			const homeVisual = registerOwnedDisposable(scope, isCurrent, "home-visual", "mesh", await createHomeVisual({
				scene: renderer.scene,
				coverResolution: refs.coverResolution,
				fx: runtimeFx,
				estimateAiDepth: aiDepthEstimator,
				runtime: {
					cancellationScope: nextContext.cancellation,
					taskQueue: nextContext.tasks,
					resourceScope: scope,
				},
				orbitCenterLockedSupplier: () => cinema.getState().orbit.centerLocked,
				onCoverLyricPalette: (palette) => {
					latestCoverLyricPalette = palette;
					lastAppliedLyricPaletteKey = "";
					applyStageLyricPalette();
				},
				backCoverRandom: options.random,
				random: options.random,
			}));
			audioEngine.setSonicTriggerSettings(homeVisual.getFx().sonic.trigger);
			let workshopLoader: ReturnType<typeof createSonicWorkshopRuntimeLoader> | null = null;
			runtimeGovernor = createLegacyHomeVisualRuntimeGovernor({
				homeVisual,
				tasks: nextContext.tasks,
				resources: scope,
				beforeReleaseResources: () => {
					workshopLoader?.sync(false, homeVisual.getFx().workshop);
				},
				refreshPerformanceSnapshots: nextContext.refreshPerformanceSnapshots,
			});
			const maintenanceLane = createVisualMaintenanceLane({
				tasks: nextContext.tasks,
				refreshPerformanceSnapshots: nextContext.refreshPerformanceSnapshots,
			});
			let homeVisualPreviousPreset: number | null = null;
			let homeVisualPreviewActive = false;
			let homePresetPreviewEnabled = false;
			let homePresetPreviewSourcePreset: number | null = null;
			let sonicActive = false;
			let configuredSonicSettings: FxState["sonic"] | null = null;
			let configuredSonicQuality: SonicPerformanceQuality | null = null;
			let configuredSonicPaletteKey = "";
			let syncedCoverUrlVersion = refs.coverUrlVersionRef?.current ?? 0;
			const syncRendererPerformancePolicy = () => {
				const policy = readVisualPerformancePolicy();
				const key = visualRendererPolicyKey(policy);
				if (key === activeVisualRendererPolicyKey) return policy;
				activeVisualRendererPolicyKey = key;
				renderer.resize(visualPerformanceResizeOpts(undefined, policy));
				refs?.lifecycleRef.current?.requestCameraSnap(10);
				return policy;
			};
			const syncHomeVisualPixelRatio = () => {
				const pixelRatio = renderer.renderer.getPixelRatio?.() ?? 1;
				const uniforms = homeVisual.getField().materialUniforms;
				if (uniforms.uPixel) uniforms.uPixel.value = pixelRatio;
			};
			syncHomeVisualPixelRatio();
			let lastCoverLoadAttemptUrl = refs.coverUrlRef?.current ?? "";
			let lastCoverLoadAttemptAt = performance.now();
			const requestHomeVisualCover = (
				coverUrl: string,
				coverFallbackUrl: string,
				nowMs = performance.now(),
			) => {
				lastCoverLoadAttemptUrl = coverUrl;
				lastCoverLoadAttemptAt = nowMs;
				homeVisual.setCoverUrl(coverUrl, coverFallbackUrl);
			};
			requestHomeVisualCover(
				lastCoverLoadAttemptUrl,
				refs.coverFallbackUrlRef?.current ?? "",
				lastCoverLoadAttemptAt,
			);

			let shelfManagerForCallback: ShelfManager | null = null;
			const shelfResourceScope = scope.createChild("shelf");
			const shelfManager = registerOwnedDisposable(scope, isCurrent, "shelf-manager", "mesh", await createShelfManagerWithThree({
				scene: renderer.scene,
				document,
				resourceScope: shelfResourceScope,
				getLayoutProfileOverrides: () => {
					const width = window.innerWidth || host.clientWidth || 0;
					const height = window.innerHeight || host.clientHeight || 0;
					const portrait = isShelfPortraitViewport(width, height);
					const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
					return {
						portrait,
						narrow: !portrait && width > 0 && width < 980,
						 skullSafe: Number(fx.preset) === 6,
					};
				},
				onDetailPhaseChange: (phase) => {
					if (phase !== "closing") return;
					cinema.setFocusZone(null, {
						immediate: true,
						portrait: isShelfPortraitViewport(window.innerWidth, window.innerHeight),
						wallpaperSafe: refs?.wallpaperSafeRef?.current ?? false,
					});
				},
				onOpenDetailContent: (payload) => {
					const contentList = shelfManagerForCallback?.getContentList();
					if (contentList) options.events.onShelfOpenDetailContent(payload, contentList);
				},
			}));
			const cursorActivity = registerOwnedDisposable(
				scope,
				isCurrent,
				"cursor-activity",
				"listener",
				createCursorActivityRuntime({ window, document }),
			);
			const disconnectCursorActivity = connectCursorActivityToShelf({
				cursorActivity,
				shelfManager,
			});
			registerOwnedCleanup(
				scope,
				isCurrent,
				"cursor-shelf-policy",
				"subscription",
				disconnectCursorActivity,
			);
			const sonicPlugin = createSonicTopographyPlugin();
			const sonic = registerOwnedDisposable(
				scope,
				isCurrent,
				"sonic-topography",
				"subscription",
				sonicPlugin.create({
					scene: renderer.scene,
					renderer: renderer.renderer,
					resources: scope,
					cancellation: nextContext.cancellation,
					tasks: nextContext.tasks,
					diagnostics: nextContext.diagnostics,
					audio: () => {
						const snapshot = audioEngine.getSnapshot().sonic;
						if (!snapshot) throw new Error("Sonic audio snapshot is unavailable.");
						return snapshot;
					},
					random: options.random,
					palette: () => sonicPaletteSnapshotFromLyricPalette(latestCoverLyricPalette),
					visualRotation: () => homeVisual.getField().points.rotation,
				}),
			);
			shelfManagerForCallback = shelfManager;
			const shelfTrackChangeGuard = createShelfTrackChangeGuard({
				getTrackKey: () => nextContext.getFrameSnapshot().playback.trackKey,
				onChange: () => {
					if (!shelfManager.getShelfPinnedOpen() && !shelfManager.hasOpenContent()) {
						shelfManager.clearShelfHoverCue();
						shelfManager.clearSelected();
					}
					cinema.setFocusZone(null, {
						immediate: true,
						portrait: isShelfPortraitViewport(window.innerWidth, window.innerHeight),
						wallpaperSafe: refs?.wallpaperSafeRef?.current ?? false,
					});
				},
			});
			const unregisterShelfDiagnostics = nextContext.diagnostics.register("shelf", () => {
				const resources = shelfManager.getResourceDiagnostics();
				return {
					detailPhase: shelfManager.getDetailPhase(),
					cards: { ...resources.cards },
					detailRows: { ...resources.detailRows },
					detailPanels: resources.detailPanels,
				};
			});
			registerOwnedCleanup(
				scope,
				isCurrent,
				"shelf-diagnostics",
				"subscription",
				unregisterShelfDiagnostics,
			);
			const connectorParticles = registerOwnedDisposable(scope, isCurrent, "connector-particles", "mesh", await createConnectorParticles({
				scene: renderer.scene,
				dotTexture: homeVisual.getField().materialUniforms.uDotTex?.value ?? null,
			}));
			if (connectorParticles.object) {
				connectorParticles.object.visible = false;
				connectorParticles.object.renderOrder = 49;
			}
			const lyricParticles = registerOwnedDisposable(scope, isCurrent, "lyric-particles", "mesh", await createLyricParticles({
				scene: renderer.scene,
				pixelScale: 1,
			}));
			if (lyricParticles.object) lyricParticles.object.visible = runtimeFx.particleLyrics !== false;

			lifecycle = createStageLyricsLifecycle({
				scene: renderer.scene,
				currentTimeSupplier: () => nextContext.mediaClock.currentTimeSeconds(),
				isPlayingSupplier: () => nextContext.mediaClock.isPlaying(),
				lyricLinesSupplier: () => refs?.lyricLinesRef.current ?? [],
				...createStageLyricsHostSuppliers(refs),
				audioDurationSupplier: () => nextContext.mediaClock.durationSeconds() ?? NaN,
				...createStageLyricsShelfSuppliers({
					shelfManager,
					shelfModeRef: refs.shelfModeRef,
					shelfPresenceRef: refs.shelfPresenceRef,
					fxRef: refs.fxRef,
				}),
				lyricTextOptionsSupplier: () => {
					const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
					return {
						lyricFont: fx.lyricFont,
						lyricLetterSpacing: fx.lyricLetterSpacing,
						lyricLineHeight: fx.lyricLineHeight,
						lyricWeight: fx.lyricWeight,
					};
				},
				stageLyricsSettingsSupplier: () => mergeFxState(cloneFxState(), refs?.fxRef?.current).stageLyrics,
				rand: options.random,
				taskQueue: nextContext.tasks,
				resourceScope: scope,
				cancellationScope: nextContext.cancellation,
				textureUploadExecutor: (texture) => renderer.renderer.initTexture(texture),
				diagnostics: nextContext.diagnostics,
				clarityQualitySupplier: () => normalizeSonicPerformanceQuality(
					mergeFxState(cloneFxState(), refs?.fxRef?.current).performanceQuality,
				),
				lyricLayoutOptionsSupplier: () => {
					const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
					const orbit = cinema.getState().orbit;
					return resolveStageLyricLayoutOptions(fx, { orbitCenterLocked: orbit.centerLocked }, {
						skullParticlesVisible: homeVisual.getSkullParticles()?.visible === true,
					});
				},
				skullMouthTransformSupplier: () => homeVisual.getSkullMouthTransform(),
				skullBeatFlashSupplier: () => homeVisual.getSkullBeatFlash(),
				getBeatCamKick: () => cinema.getState().beatCam,
				coverWorldTransformSupplier: () => {
					const points = homeVisual.getField().points;
					return {
						position: points.position,
						quaternion: points.quaternion,
						updateMatrixWorld: (force?: boolean) => points.updateMatrixWorld(force),
						getWorldPosition: (target: { x: number; y: number; z: number }) => {
							const worldPosition = points.position.clone();
							points.getWorldPosition(worldPosition);
							target.x = worldPosition.x;
							target.y = worldPosition.y;
							target.z = worldPosition.z;
							return target;
						},
						getWorldQuaternion: (target: { x: number; y: number; z: number; w: number }) => {
							const worldQuaternion = points.quaternion.clone();
							points.getWorldQuaternion(worldQuaternion);
							target.x = worldQuaternion.x;
							target.y = worldQuaternion.y;
							target.z = worldQuaternion.z;
							target.w = worldQuaternion.w;
							return target;
						},
					};
				},
				cameraSupplier: () => renderer.camera,
				pixelScale: 1,
				maxAnisotropy: Math.min(8, renderer.renderer.capabilities.getMaxAnisotropy?.() ?? 1),
				reduceMotion: readPrefersReducedMotion,
			});
			const lifecycleMounted = await mountOwnedStageLyricsLifecycle({
				scope,
				lifecycle,
				scene: renderer.scene,
				isCurrent,
				onMounted: () => {
					if (!refs) return;
					refs.lifecycleRef.current = lifecycle;
					lifecycle.requestCameraSnap(10);
					lifecycle.setLyricLines(refs.lyricLinesRef.current);
				},
			});
			if (!lifecycleMounted) throw new LegacyVisualCompositionCancelledError();
			applyStageLyricPalette();

			let syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
			let syncedBeatMapVersion = refs.beatMapVersionRef?.current ?? 0;
			let syncedShelfContentOpen = false;
			let syncedShelfCameraMode: ShelfFocusCameraMode = refs.shelfCameraModeRef?.current === "static" ? "static" : "dynamic";
			const pointerTarget = { x: 0, y: 0 };
			const pointerParallax = { x: 0, y: 0 };
			shelfManager.setData(refs.shelfItemsRef.current, { asyncBuild: true });
			shelfManager.setShelfPane(nextContext.getFrameSnapshot().shelf.pane);
			const beatMapScheduler = createBeatMapScheduler({
				scheduleCameraBeat: (beat) => cinema.applyBeat(Math.max(Number(beat.strength) || 0, Number(beat.impact) || 0), true),
				triggerScheduledBeat: (beat) => audioEngine.triggerScheduledBeat(beat),
				setBeatMapReady: (ready) => audioEngine.setBeatMapReady(ready),
				setWaitingForBeatMap: (waiting) => audioEngine.setWaitingForBeatMap(waiting),
			});
			beatMapScheduler.setBeatMap(refs.beatMapKeyRef?.current ?? "", refs.beatMapRef?.current ?? null);
			const renderLoop = registerOwnedDisposable(scope, isCurrent, "render-loop", "subscription", createRenderLoop({
				renderer: renderer.renderer,
				scene: renderer.scene,
				camera: renderer.camera,
				audio: audioEngine,
				scheduler: context.scheduler,
				performance: context.performance,
				pointerTarget,
				pointerParallax,
				isMainSceneCoveredBySplash: () => refs?.splashActiveRef.current === true,
				prefersReducedMotion: readPrefersReducedMotion,
				onCacheTrim: () => {},
				gpuFrameTimer: options.enableGpuTimerQuery
					? createGpuFrameTimer(renderer.renderer.getContext())
					: undefined,
			}));
			workshopLoader = registerOwnedDisposable(
				scope,
				isCurrent,
				"sonic-workshop-loader",
				"subscription",
				createSonicWorkshopRuntimeLoader({
					// 只有明确选中当前 schema 的 preset 8 后才加载独立实现。
					load: () => import("@mineradio/visual-engine/sonic-workshop"),
					createContext: () => ({
						scene: renderer.scene,
						renderer: renderer.renderer,
						resources: scope,
						cancellation: nextContext.cancellation,
						tasks: nextContext.tasks,
						diagnostics: nextContext.diagnostics,
						audio: () => {
							const snapshot = audioEngine.getSnapshot().sonic;
							if (!snapshot) throw new Error("Workshop audio snapshot is unavailable.");
							return snapshot;
						},
						coverTexture: () => (
							homeVisual.getField().materialUniforms.uCoverTex?.value as THREE.Texture | null
						) ?? null,
						media: () => {
							const playback = nextContext.getFrameSnapshot().playback;
							return Object.freeze({
								trackKey: playback.trackKey,
								title: playback.title ?? "",
								artist: playback.artist ?? "",
								playing: playback.playing,
								coverTexture: (
									homeVisual.getField().materialUniforms.uCoverTex?.value as THREE.Texture | null
								) ?? null,
							});
						},
						coverPalette: () => latestCoverLyricPalette
							? Object.freeze({
								primary: latestCoverLyricPalette.primary,
								warm: latestCoverLyricPalette.primary,
								cool: latestCoverLyricPalette.secondary,
								ripple: latestCoverLyricPalette.highlight,
								peak: latestCoverLyricPalette.glowColor,
							})
							: null,
						random: options.random,
					}),
					registerStep: (run) => renderLoop.registerStep(
						RenderStepSlot.SonicWorkshop,
						run,
						{ cadence: LEGACY_VISUAL_LANE_CADENCE.SonicWorkshop },
					),
				}),
			);
			registerOwnedCleanup(scope, isCurrent, "beatmap-lane", "subscription", renderLoop.registerStep(RenderStepSlot.Beatmap, () => {
				if (refs?.beatMapVersionRef && syncedBeatMapVersion !== refs.beatMapVersionRef.current) {
					syncedBeatMapVersion = refs.beatMapVersionRef.current;
					beatMapScheduler.setBeatMap(refs.beatMapKeyRef?.current ?? "", refs.beatMapRef?.current ?? null);
				}
				beatMapScheduler.update(nextContext.mediaClock.currentTimeSeconds());
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.Beatmap }));
			registerOwnedCleanup(scope, isCurrent, "maintenance-lane", "subscription", renderLoop.registerStep(RenderStepSlot.Maintenance, () => {
				maintenanceLane.pump(nextContext.scheduler.getMode());
			}));
			registerOwnedCleanup(scope, isCurrent, "ripples-lane", "subscription", renderLoop.registerStep(RenderStepSlot.Ripples, (frame) => {
				homeVisual.updateRipples(frame.dt);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.Ripples }));
			registerOwnedCleanup(scope, isCurrent, "home-visual-lane", "subscription", renderLoop.registerStep(RenderStepSlot.HomeVisual, (frame) => {
				mergeFxState(homeVisual.getFx(), refs?.fxRef?.current);
				audioEngine.setSonicTriggerSettings(homeVisual.getFx().sonic.trigger);
				const workshopSettings = homeVisual.getFx().workshop;
				workshopLoader.sync(
					shouldActivateSonicWorkshop(homeVisual.getFx().preset) && workshopSettings.active,
					workshopSettings,
				);
				const sonicRequested = shouldActivateSonicTopography(homeVisual.getFx().preset);
				if (sonicRequested) {
					const settings = homeVisual.getFx().sonic;
					const quality = normalizeSonicPerformanceQuality(homeVisual.getFx().performanceQuality);
					const paletteKey = sonicPaletteSnapshotKey(latestCoverLyricPalette);
					if (!sonicActive) {
						sonic.activate(settings, quality);
						sonicActive = true;
						configuredSonicSettings = settings;
						configuredSonicQuality = quality;
						configuredSonicPaletteKey = paletteKey;
					} else if (
						configuredSonicSettings !== settings ||
						configuredSonicQuality !== quality ||
						configuredSonicPaletteKey !== paletteKey
					) {
						sonic.configure(settings, quality);
						configuredSonicSettings = settings;
						configuredSonicQuality = quality;
						configuredSonicPaletteKey = paletteKey;
					}
				} else if (sonicActive) {
					sonic.deactivate();
					sonicActive = false;
					configuredSonicSettings = null;
					configuredSonicQuality = null;
					configuredSonicPaletteKey = "";
				}
				const visualPolicy = syncRendererPerformancePolicy();
				applyRuntimeVisualPerformancePolicy(homeVisual.getFx(), visualPolicy);
				syncHomeVisualPixelRatio();
				const uniforms = homeVisual.getField().materialUniforms as Record<string, { value: unknown }>;
				const currentCoverUrl = refs?.coverUrlRef?.current ?? "";
				const currentCoverFallbackUrl = refs?.coverFallbackUrlRef?.current ?? "";
				if (refs?.coverUrlVersionRef && syncedCoverUrlVersion !== refs.coverUrlVersionRef.current) {
					syncedCoverUrlVersion = refs.coverUrlVersionRef.current;
					requestHomeVisualCover(currentCoverUrl, currentCoverFallbackUrl, frame.now);
				} else if (shouldRetryVisualCoverLoad({
					coverUrl: currentCoverUrl,
					hasCover: Number(uniforms.uHasCover?.value ?? 0),
					nowMs: frame.now,
					lastAttemptAtMs: lastCoverLoadAttemptAt,
					lastAttemptUrl: lastCoverLoadAttemptUrl,
				})) {
					requestHomeVisualCover(currentCoverUrl, currentCoverFallbackUrl, frame.now);
				}
				applyStageLyricPalette();
				const homeActive = refs?.homeActiveRef?.current === true;
				const wasHomePreviewActive = homeVisualPreviewActive;
				const enteringHomePreview = homeActive && !homeVisualPreviewActive;
				const committedPreset = homeVisual.getFx().preset ?? 0;
				if (enteringHomePreview) {
					homePresetPreviewEnabled = true;
					homePresetPreviewSourcePreset = committedPreset;
				}
				const committedPresetChanged = homeActive && homePresetPreviewEnabled &&
					homePresetPreviewSourcePreset !== null && committedPreset !== homePresetPreviewSourcePreset;
				if (committedPresetChanged) {
					homePresetPreviewEnabled = false;
					homeVisualPreviousPreset = null;
					homePresetPreviewSourcePreset = committedPreset;
					cinema.setPresetCameraBaseline(committedPreset);
				}
				if (!homeActive) {
					homePresetPreviewEnabled = false;
					homePresetPreviewSourcePreset = null;
				}
				const resettingToLyricStage = shouldResetLyricStageCameraView({
					wasHomeActive: wasHomePreviewActive,
					homeActive,
					playbackActive: nextContext.mediaClock.isPlaying() || !!currentCoverUrl,
				});
				const preset = resolveHomeVisualPreset(homeActive, homeVisual.getPreset(), committedPreset, homeVisualPreviousPreset, {
					playbackActive: nextContext.mediaClock.isPlaying(),
					playbackPreset: committedPreset,
					previewEnabled: homePresetPreviewEnabled,
					committedPresetChanged,
				});
				if (preset.changed) {
					homeVisual.setPreset(preset.preset, { silent: true, preserveCamera: false, skipTransition: homeActive, noSave: true });
					cinema.setPresetCameraBaseline(preset.preset);
				} else if (enteringHomePreview) {
					cinema.setPresetCameraBaseline(preset.preset);
				}
				if (resettingToLyricStage) {
					cinema.resetLyricStageCoverWallView();
					lifecycle.requestCameraSnap(14);
				}
				homeVisualPreviousPreset = preset.previousPreset;
				homeVisualPreviewActive = homeActive;
				if (homeVisualPreviewActive) {
					if (typeof uniforms.uAlpha?.value === "number" && uniforms.uAlpha.value < 0.96) uniforms.uAlpha.value = 0.96;
					if (uniforms.uFloatAlpha) uniforms.uFloatAlpha.value = 0;
				}
				homeVisual.setSkullShelfCompositionActive(resolveSkullShelfCompositionActive({
					preset: homeVisual.getFx().preset,
					shelfMode: shelfManager.getMode(),
					shelfVisibility: shelfManager.getShelfVisibility(),
					pinnedOpen: shelfManager.getShelfPinnedOpen(),
					hasOpenContent: shelfManager.hasOpenContent(),
				}));
				homeVisual.setWallpaperShelfDimActive(shouldDimWallpaperParticlesForShelf({
					preset: homeVisual.getFx().preset,
					shelfMode: shelfManager.getMode(),
					pinnedOpen: shelfManager.getShelfPinnedOpen(),
					hasOpenContent: shelfManager.hasOpenContent(),
				}));
				homeVisual.updateCore(frame);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.HomeVisual }));
			registerOwnedCleanup(scope, isCurrent, "camera-lane", "subscription", renderLoop.registerStep(RenderStepSlot.CameraCinematic, (frame) => {
				if (updateAndApplyFreeCamera(freeCamera, renderer.camera, frame.dt, frame.now, {
					cameraShake: homeVisual.getFx().cinemaShake,
					beatCam: cinema.getState().beatCam,
					camPunch: cinema.getState().cameraPunch,
				})) return;
				cinema.update(frame);
				const fx = homeVisual.getFx();
				if (Number(fx.preset) === 6) {
					cinema.applySkullCameraPose(frame, {
						active: true,
						portrait: isShelfPortraitViewport(window.innerWidth, window.innerHeight),
						shelfComposition: resolveSkullShelfCompositionActive({
							preset: fx.preset,
							shelfMode: shelfManager.getMode(),
							shelfVisibility: shelfManager.getShelfVisibility(),
							pinnedOpen: shelfManager.getShelfPinnedOpen(),
							hasOpenContent: shelfManager.hasOpenContent(),
						}),
						zoom: homeVisual.getSkullWheelZoom(),
					});
				}
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.CameraCinematic }));
			const shelfStep = createShelfStep(shelfManager, {
				getShelfMode: () => resolveSonicShelfMode(
					refs?.fxRef?.current?.preset,
					refs?.shelfModeRef?.current ?? "side",
					shelfManager.hasOpenContent(),
				),
				getShelfPresence: () => refs?.shelfPresenceRef?.current ?? "always",
				getSplashActive: () => refs?.splashActiveRef.current === true,
			});
			registerOwnedCleanup(scope, isCurrent, "shelf-lane", "subscription", renderLoop.registerStep(RenderStepSlot.Shelf, (frame) => {
				shelfTrackChangeGuard.sync();
				if (refs && syncedShelfItemsVersion !== refs.shelfItemsVersionRef.current) {
					syncedShelfItemsVersion = refs.shelfItemsVersionRef.current;
					shelfManager.setData(refs.shelfItemsRef.current, { asyncBuild: true });
					shelfManager.setShelfPane(nextContext.getFrameSnapshot().shelf.pane);
				}
				const nextShelfCameraMode = refs?.shelfCameraModeRef?.current === "static" ? "static" : "dynamic";
				if (shouldClearShelfFocusOnCameraModeChange(syncedShelfCameraMode, nextShelfCameraMode)) {
					cinema.setFocusZone(null, {
						immediate: true,
						portrait: isShelfPortraitViewport(window.innerWidth, window.innerHeight),
						wallpaperSafe: refs?.wallpaperSafeRef?.current ?? false,
					});
				}
				syncedShelfCameraMode = nextShelfCameraMode;
				shelfStep(frame);
				const shelfContentOpen = shelfManager.hasOpenContent();
				if (shelfContentOpen !== syncedShelfContentOpen) {
					syncedShelfContentOpen = shelfContentOpen;
					options.events.onShelfOpenContentChange(shelfContentOpen);
					lifecycle.requestCameraSnap(10);
				}
				const connectorVisible = shelfManager.getMode() === "stage" && shelfManager.getShelfVisibility() > 0 && shelfManager.getData().length > 0;
				if (connectorParticles.object) connectorParticles.object.visible = connectorVisible;
				if (connectorParticles.floorMirror) connectorParticles.floorMirror.visible = connectorVisible;
				connectorParticles.setIntensity(connectorVisible ? shelfManager.getShelfVisibility() : 0);
				connectorParticles.update(frame);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.Shelf }));
			registerOwnedCleanup(scope, isCurrent, "sonic-topography-lane", "subscription", renderLoop.registerStep(RenderStepSlot.SonicTopography, (frame) => {
				if (!sonicActive) return;
				sonic.update(frame);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.SonicTopography }));
			registerOwnedCleanup(scope, isCurrent, "lyric-particles-lane", "subscription", renderLoop.registerStep(RenderStepSlot.LyricParticles, (frame) => {
				const fx = mergeFxState(cloneFxState(), refs?.fxRef?.current);
				if (lyricParticles.object) lyricParticles.object.visible = fx.particleLyrics !== false;
				lyricParticles.setGlowStrength(fx.lyricGlow ? Math.min(0.85, Math.max(0, Number(fx.lyricGlowStrength) || 0)) : 0.28);
				lyricParticles.update(frame);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.LyricParticles }));
			registerOwnedCleanup(scope, isCurrent, "stage-lyrics-lane", "subscription", renderLoop.registerStep(RenderStepSlot.StageLyrics, (frame) => {
				lifecycle.update(frame);
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.StageLyrics }));
			registerOwnedCleanup(scope, isCurrent, "desktop-overlay-sync-lane", "subscription", renderLoop.registerStep(RenderStepSlot.DesktopOverlaySync, () => {
				options.events.onDesktopLyricsMotion(lifecycle.getMotionSnapshot());
			}, { cadence: LEGACY_VISUAL_LANE_CADENCE.DesktopOverlaySync }));
			registerOwnedCleanup(scope, isCurrent, "audio-beat-subscription", "subscription", audioEngine.subscribeBeat((burst, isScheduled) => {
				cinema.applyBeat(burst, isScheduled);
			}));

			const getSideShelfFocusHit = await createShelfPointerRaycastFocus({
				camera: renderer.camera,
				shelfManager,
				getScreenPad: () => (refs?.shelfPresenceRef?.current === "always" ? 18 : 24),
			});
			if (!isCurrent()) throw new LegacyVisualCompositionCancelledError();
			const getShelfPointerHit = await createShelfPointerRaycastHitGetter({ camera: renderer.camera, shelfManager });
			if (!isCurrent()) throw new LegacyVisualCompositionCancelledError();
			const getStrictShelfPointerHit = await createShelfPointerStrictRaycastHitGetter({ camera: renderer.camera, shelfManager });
			if (!isCurrent()) throw new LegacyVisualCompositionCancelledError();
			const getStrictShelfDetailRowHit = await createShelfPointerContentRowRaycastHitGetter({ camera: renderer.camera, shelfManager });
			if (!isCurrent()) throw new LegacyVisualCompositionCancelledError();
			const shelfPaneWheelSwitcher = createShelfPaneWheelSwitcher({
				getPane: () => shelfManager.getShelfPane(),
				getMergeCollections: () => refs?.shelfMergeCollectionsRef?.current === true,
				getMineCount: () => refs?.shelfMineCountRef?.current ?? shelfManager.getData().length,
				getFavCount: () => refs?.shelfFavCountRef?.current ?? 0,
				getCenterTarget: () => shelfManager.getState().centerTarget,
				setPane: (pane) => {
					shelfManager.setShelfPane(pane);
					options.events.onShelfPaneChange(pane);
				},
			});
			const secondaryPlaylistEdgeGuard = createSecondaryPlaylistEdgeGuard();
			const offShelfFocus = attachShelfFocusZonePointerWiring({
				target: window,
				cinema,
				shelfManager,
				getSplashActive: () => refs?.splashActiveRef.current === true,
				getShelfCameraMode: () => refs?.shelfCameraModeRef?.current ?? "dynamic",
				getPortrait: () => isShelfPortraitViewport(window.innerWidth, window.innerHeight),
				getWallpaperSafe: () => refs?.wallpaperSafeRef?.current ?? false,
				getViewportWidth: () => window.innerWidth || host.clientWidth || 0,
				getViewportHeight: () => window.innerHeight || host.clientHeight || 0,
				getQueueFocusActive: (pointer) => isQueueFocusActive(pointer, getPlaylistPanelFocusInfo(document), {
					secondaryLeftDisplaySeamGuardActive: refs?.secondaryLeftDisplaySeamGuardRef?.current === true,
					secondaryEdgeGuard: secondaryPlaylistEdgeGuard,
				}),
				getSideShelfFocusHit,
				trackChangeGuard: shelfTrackChangeGuard,
				onFocusZoneChange: (result) => {
					if (result.wallpaperSafe && (result.type === "shelf-side" || result.type === "shelf-detail")) lifecycle.requestCameraSnap(10);
				},
			});
			registerOwnedCleanup(scope, isCurrent, "shelf-focus-wiring", "listener", offShelfFocus);
			const offShelfPointerInteractions = attachShelfPointerInteractionWiring({
				target: window,
				cinema,
				shelfManager,
				getHit: getShelfPointerHit,
				getStrictHit: getStrictShelfPointerHit,
				getStrictDetailRowHit: getStrictShelfDetailRowHit,
				getSplashActive: () => refs?.splashActiveRef.current === true,
				getPortrait: () => isShelfPortraitViewport(window.innerWidth, window.innerHeight),
				getWallpaperSafe: () => refs?.wallpaperSafeRef?.current ?? false,
				getViewportWidth: () => window.innerWidth || host.clientWidth || 0,
				getViewportHeight: () => window.innerHeight || host.clientHeight || 0,
				getShelfPresence: () => refs?.shelfPresenceRef?.current ?? "always",
				getShelfPreviewActive: () => isRuntimeShelfPreviewActive(refs?.shelfPresenceRef?.current, shelfManager.getShelfVisibility()),
				getShelfCameraMode: () => refs?.shelfCameraModeRef?.current ?? "dynamic",
				getTrackKey: () => nextContext.getFrameSnapshot().playback.trackKey,
				trackChangeGuard: shelfTrackChangeGuard,
				isDetailWheelTarget: (event) => shelfManager.getContentList()?.hasScreenTargetAt({ x: event.clientX, y: event.clientY }) === true,
				setShelfMode: (mode) => setRuntimeShelfMode(refs?.shelfModeRef, mode, options.events.onShelfModeChange),
				onBeforeShelfWheelScroll: (direction) => shelfPaneWheelSwitcher.step(direction),
				onShelfPlayQueueIndex: (index) => options.events.onShelfPlayQueueIndex(index),
				onShelfPlayPlaylist: (payload) => options.events.onShelfPlayPlaylist(payload),
				onShelfDetailRowClick: (payload) => options.events.onShelfDetailRowClick(payload),
				onShelfSelectFeedback: (direction, variant) => { shelfSelectSound.play(direction, variant); },
				onFocusZoneChange: (type, focusOptions) => {
					if (focusOptions?.wallpaperSafe && (type === "shelf-side" || type === "shelf-detail")) lifecycle.requestCameraSnap(10);
				},
			});
			registerOwnedCleanup(scope, isCurrent, "shelf-pointer-wiring", "listener", offShelfPointerInteractions);
			const isPointerOverRuntimeUi = (event: MouseEvent | WheelEvent) => {
				const element = document.elementFromPoint(event.clientX, event.clientY);
				return !!(element && element.closest?.("#search-area,#top-right,#fullscreen-diy-zone,#fx-panel,#fx-fab,#fx-fab-hide-btn,#playlist-panel,#bottom-bar,#thumb-wrap,#empty-home,#visual-guide,#trial-banner,#source-fallback-notice,.modal-mask,#toast,#ai-depth-chip,#beat-chip,#drop-overlay"));
			};
			const offCanvasPointer = attachBaselineCanvasPointerInput({
				target: renderer.renderer.domElement,
				windowTarget: window,
				homeVisual,
				cinema,
				freeCamera,
				camera: renderer.camera,
				pointerTarget,
				isPointerOverUi: isPointerOverRuntimeUi,
				getPreset: () => homeVisual.getFx().preset,
				onSonicPointerRipple: (x, z, strength) => sonic.pointerRipple(x, z, strength),
			});
			registerOwnedCleanup(scope, isCurrent, "canvas-pointer-wiring", "listener", offCanvasPointer);
			const offFreeCamera = attachFreeCameraHost({
				target: window,
				wheelTarget: renderer.renderer.domElement,
				state: freeCamera,
				getCameraPose: () => createFreeCameraPoseFromPerspectiveCamera(renderer.camera),
				getNowMs: () => performance.now(),
				isPointerOverUi: isPointerOverRuntimeUi,
			});
			registerOwnedCleanup(scope, isCurrent, "free-camera-wiring", "listener", offFreeCamera);
			syncRuntimeRefs(refs, nextContext.getFrameSnapshot());
			subsystems = { homeVisual, shelfManager, sonic, lifecycle };
			options.onDebugController?.({
				seekShelf(index) {
					shelfManager.scrollBy(index - shelfManager.getCenterIdx());
				},
				openShelfDetail(index, rows) {
					shelfManager.openDetail(index);
					shelfManager.getContentList()?.setRows([...rows]);
				},
				scrollShelfDetail(delta) {
					shelfManager.getContentList()?.scrollBy(delta);
				},
				closeShelfDetail(immediate = false) {
					shelfManager.closeDetail({ immediate });
				},
				getRendererDiagnostics() {
					const info = renderer.renderer.info;
					const gpuTiming = renderLoop.getGpuTimingSnapshot();
					return {
						drawCalls: info.render.calls,
						triangles: info.render.triangles,
						points: info.render.points,
						lines: info.render.lines,
						geometries: info.memory.geometries,
						textures: info.memory.textures,
						gpuTimerQuerySupported: gpuTiming?.extensionSupported ?? false,
						gpuTiming,
					};
				},
			});
			renderLoop.start();
		},
		applyFrameSnapshot(snapshot) {
			if (disposed || !refs) return;
			const previousCoverResolution = refs.coverResolution;
			syncRuntimeRefs(refs, snapshot);
			if (subsystems) {
				subsystems.shelfManager.setShelfPane(snapshot.shelf.pane);
				if (previousCoverResolution !== snapshot.settings.coverResolution) {
					subsystems.homeVisual.getFx().coverResolution = snapshot.settings.coverResolution;
				}
			}
			runtimeGovernor?.sync(context?.scheduler.getMode() ?? "foreground");
		},
		applyPreset(preset) {
			if (disposed || !refs) return;
			refs.fxRef!.current = { ...refs.fxRef?.current, preset };
			subsystems?.homeVisual.setPreset(preset);
		},
		setVisibility(state) {
			currentVisibility = { ...state };
			runtimeGovernor?.sync(context?.scheduler.getMode() ?? "foreground");
		},
			dispose() {
			if (disposed) return;
				disposed = true;
				options.onDebugController?.(null);
			generation += 1;
			if (refs) refs.lifecycleRef.current = null;
			const disposalErrors: unknown[] = [];
			try {
				const report = ownedScope?.dispose();
				if (report) {
					for (const error of report.errors) disposalErrors.push(error.cause);
				}
			} catch (error) {
				disposalErrors.push(error);
			}
			ownedScope = null;
			subsystems = null;
			runtimeGovernor = null;
			context = null;
			if (disposalErrors.length > 0) {
				throw new AggregateError(disposalErrors, "Legacy visual composition resource disposal failed.");
			}
		},
	};
}
