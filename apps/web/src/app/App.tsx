import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { AppRuntimeProvider } from "./AppRuntimeProvider";
export {
  deriveSidecarRecoveryNoticeState,
  nextSidecarStatusPollDelayMs,
} from "./runtime/sidecar-recovery-policy";
import { AppShell, type AppShellProps } from "./AppShell";
import {
  defaultApplicationRuntime,
  defaultDesktopRuntime,
  defaultFullDesktopRuntime,
  defaultWallpaperEngineRuntime,
} from "./runtime/default-runtime-dependencies";
import { useLyricsStore } from "../stores/lyrics-store";
import { usePlaybackStore } from "../stores/playback-store";
import { useProviderStore } from "../stores/provider-store";
import { useSearchStore } from "../stores/search-store";
import { useShelfStore } from "../stores/shelf-store";
import { useUiStore } from "../stores/ui-store";
import { useVisualStore } from "../stores/visual-store";
import { usePlaybackUiPosition } from "../stores/playback-ui-position";
import type {
  DesktopJsonValue,
  DesktopRuntimePort,
  DesktopWindowState,
} from "../ports/desktop-runtime-port";
import type { FullDesktopRuntimePort } from "../ports/full-desktop-runtime-port";
import type { WallpaperEngineRuntimePort } from "../ports/wallpaper-engine-runtime-port";
import {
  usePlaybackSessionRuntime,
  type CurrentBeatMapState,
} from "../features/playback/usePlaybackSessionRuntime";
import { useSourceSwitchController } from "../features/playback/useSourceSwitchController";
import { usePlaybackAudioSettings } from "../features/playback/usePlaybackAudioSettings";
import {
  LOCAL_AUDIO_ACCEPT,
  usePlaybackUiController,
} from "../features/playback/usePlaybackUiController";
import type { PlaybackControllerRef } from "../features/playback/PlaybackSurface";
import { useTrackCustomizationController } from "../features/customization/useTrackCustomizationController";
import {
  LOGIN_QR_PROVIDERS,
  useLoginQrRuntime,
  type LoginModalMode,
  type LoginProviderId,
} from "../features/accounts/useLoginQrRuntime";
import { useAccountSessionController } from "../features/accounts/useAccountSessionController";
import { useDesktopRuntime } from "../features/desktop/useDesktopRuntime";
import { useDesktopManagementRuntime } from "../features/desktop/useDesktopManagementRuntime";
import {
  DESKTOP_RUNTIME_SETTINGS_SEARCH_TERMS,
  DesktopRuntimeControls,
} from "../features/desktop/DesktopRuntimeControls";
import { useFullDesktopRuntime } from "../features/desktop/useFullDesktopRuntime";
import {
  FULL_DESKTOP_SETTINGS_SEARCH_TERMS,
  FullDesktopControls,
} from "../features/desktop/FullDesktopControls";
import {
  WALLPAPER_ENGINE_SETTINGS_SEARCH_TERMS,
  WallpaperEngineControls,
} from "../features/wallpaper-engine/WallpaperEngineControls";
import { setFullDesktopModeWithWallpaperFallback } from "../features/wallpaper-engine/full-desktop-wallpaper-coordinator";
import { useWallpaperEngineRuntime } from "../features/wallpaper-engine/useWallpaperEngineRuntime";
import { useUpdateExperience } from "../features/updater/useUpdateExperience";
import type { UpdateExperienceController } from "../features/updater/update-experience-controller";
import { resolveUpdatePresentationMode } from "../features/updater/update-view-model";
import type { TauriPlaybackQuiescenceAdapter } from "../adapters/tauri/tauri-playback-quiescence-adapter";
import { useLikesController } from "../features/likes/useLikesController";
export { isNeteaseLikeSupported } from "../features/likes/likes-policy";
import {
  useLibraryController,
  type LibraryControllerResult,
} from "../features/library/useLibraryController";
export {
  isCollectSupportedTrack,
  mergeProviderPlaylists,
} from "../features/library/library-policy";
import {
  useHomeController,
  type HomeControllerResult,
} from "../features/home/useHomeController";
import type { HomeListenRepository } from "../features/home/home-listen-repository";
export { shouldUseCachedHomeDiscoverPlaylist } from "../features/home/home-policy";
import {
  buildDesktopLyricsPayloadPatch,
  desktopLyricsBeatMapContext,
  desktopLyricsBeatMapKey,
} from "../features/desktop/desktop-lyrics-payload";
export {
  buildDesktopLyricsPayloadPatch,
  desktopLyricsBeatMapKey,
} from "../features/desktop/desktop-lyrics-payload";
import type { PlaylistPanelTab } from "../components/shell/PlaylistPanelHost";
import type { SearchMode } from "../components/shell/SearchShell";
import { buildDesktopLyricSnapshot } from "../desktop-lyrics/desktop-lyrics-snapshot";
import { useCustomLyricFontRuntime } from "../desktop-lyrics/useCustomLyricFontRuntime";
import type { SidecarRecoveryNoticeState } from "../components/shell/SidecarRecoveryNotice";
import type { VisualGuideStep } from "../components/shell/VisualGuideHost";
import { SplashHost, type SplashHostProps } from "../visual/SplashHost";
import {
  VisualEngineHost,
  type DesktopLyricsMotionSnapshot,
} from "../visual/VisualEngineHost";
import type { VisualPerformanceSnapshotReader } from "../visual/useVisualEngine";
import {
  createPodcastRadioDetailOpener,
  createShelfDetailContentLoader,
  handleShelfDetailRowAction,
  type ShelfDetailContentListController,
} from "../visual/shelf-detail-data";
import {
  type ProviderId,
  type ProviderLoginStatus,
  type Track,
} from "@mineradio/shared";
import type { AudioFrameSource } from "@mineradio/visual-engine";
import {
  readPlaybackQualityPreference,
  savePlaybackQualityPreference,
  useShellPreferences,
  type HydratedShellPreferencesSnapshot,
} from "./runtime/useShellPreferences";
import type { PreferencesRepository } from "../ports/preferences-repository";
import type {
  ApplicationPorts,
  ApplicationRuntimePort,
} from "../ports/application-runtime-port";
import {
  PLAYBACK_QUALITY_PREFERENCE,
  SETTINGS_FAB_AUTO_HIDE_PREFERENCE,
  WALLPAPER_SELECTION_PREFERENCE,
} from "../preferences/keys";
import { useGlobalShellRuntime } from "./runtime/GlobalShellRuntime";
export { isHomeBlankDismissElement } from "./runtime/GlobalShellRuntime";

const SHOW_SPLASH = import.meta.env.VITE_SPLASH !== "0";
const DESKTOP_RUNTIME_SEARCH_TERMS = Object.freeze([
  ...FULL_DESKTOP_SETTINGS_SEARCH_TERMS,
  ...WALLPAPER_ENGINE_SETTINGS_SEARCH_TERMS,
  ...DESKTOP_RUNTIME_SETTINGS_SEARCH_TERMS,
]);

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function afterPreferenceCommit(
  result: Promise<void> | void,
  onCommitted: () => void,
  onRejected: (error: unknown) => void,
): void {
  if (result && typeof result.then === "function") {
    void Promise.resolve(result).then(onCommitted).catch(onRejected);
    return;
  }
  onCommitted();
}

const LOGIN_PROVIDERS = LOGIN_QR_PROVIDERS;

function providerLabelText(provider: ProviderId): string {
  if (provider === "netease") return "网易云";
  if (provider === "qq") return "QQ 音乐";
  return "汽水音乐";
}


function trackTitle(track: Track | null | undefined): string {
  return track?.title || "MineRadio-Tauri";
}

function trackArtist(track: Track | null | undefined): string {
  return track?.artists?.join(" / ") || track?.album || "";
}

export interface EmptyHomeStateInput {
  splashActive: boolean;
  homeForcedOpen: boolean;
  homeSuppressed: boolean;
  hasCurrentTrack: boolean;
  queueLength: number;
  isPlaying: boolean;
  immersiveActive?: boolean;
  shelfDetailOpen?: boolean;
  shelfPinnedOpen?: boolean;
  shelfStageOpen?: boolean;
}

export function shouldShowEmptyHome(input: EmptyHomeStateInput): boolean {
  if (input.splashActive) return false;
  if (input.homeForcedOpen) return true;
  if (input.homeSuppressed) return false;
  if (input.immersiveActive) return false;
  if (input.shelfDetailOpen) return false;
  if (input.shelfPinnedOpen) return false;
  if (input.shelfStageOpen) return false;
  if (input.hasCurrentTrack) return false;
  if (input.queueLength > 0) return false;
  if (input.isPlaying) return false;
  return true;
}

export function isDesktopWindowFullscreen(state: DesktopWindowState): boolean {
  return !!(
    state.isFullScreen ||
    state.isNativeFullScreen ||
    state.isHtmlFullScreen ||
    state.isWindowFullScreen ||
    (typeof document !== "undefined" && document.fullscreenElement)
  );
}

function forceBottomControlsVisible(awakeDurationMs = 900): void {
  if (typeof document === "undefined") return;
  document.body.classList.remove("home-controls-locked");
  document.body.classList.add("controls-visible", "controls-handle-awake");
  const bar = document.getElementById("bottom-bar");
  if (bar) {
    bar.classList.add("visible");
    bar.classList.remove("soft-hidden");
    bar.style.pointerEvents = "";
  }
  document.getElementById("bottom-handle")?.classList.add("active");
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      document.body.classList.remove("controls-handle-awake");
    }, awakeDurationMs);
  }
}

export function applyDesktopWindowShellState(state: DesktopWindowState): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.add("desktop-shell-root");
  document.body.classList.add("desktop-shell");
  document.body.classList.toggle("desktop-maximized", !!state.isMaximized);
  document.body.classList.toggle(
    "desktop-fullscreen",
    isDesktopWindowFullscreen(state),
  );
}

export function shouldUseSecondaryLeftDisplaySeamGuard(
  state: DesktopWindowState | null,
): boolean {
  return state?.isPrimaryDisplay === false && state.hasDisplayOnLeft;
}

export type AppProps = {
  updateController: UpdateExperienceController;
  playbackQuiescenceAdapter?: TauriPlaybackQuiescenceAdapter | null;
  SplashComponent?: (props: SplashHostProps) => ReactElement | null;
  VisualComponent?: typeof VisualEngineHost;
  applicationRuntime?: ApplicationRuntimePort;
  desktopLyricsRuntime?: DesktopLyricsRuntime;
  desktopRuntime?: DesktopRuntimePort;
  fullDesktopRuntime?: FullDesktopRuntimePort;
  wallpaperEngineRuntime?: WallpaperEngineRuntimePort;
  homeListenRepository?: HomeListenRepository;
  preferences?: PreferencesRepository;
  hydratedPreferences?: HydratedShellPreferencesSnapshot;
};

export type DesktopLyricsRuntime = {
  showWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  updatePayload: (payload: DesktopJsonValue) => Promise<void>;
};

export function App({
  updateController,
  playbackQuiescenceAdapter = null,
  SplashComponent = SplashHost,
  VisualComponent = VisualEngineHost,
  applicationRuntime = defaultApplicationRuntime,
  desktopLyricsRuntime,
  desktopRuntime = defaultDesktopRuntime,
  fullDesktopRuntime = defaultFullDesktopRuntime,
  wallpaperEngineRuntime = defaultWallpaperEngineRuntime,
  homeListenRepository,
  preferences,
  hydratedPreferences,
}: AppProps): ReactElement {
  const [applicationPorts, setApplicationPorts] = useState<ApplicationPorts | null>(null);
  const resolvedDesktopRuntime = useMemo<DesktopRuntimePort>(() => {
    if (!desktopLyricsRuntime) return desktopRuntime;
    return {
      ...desktopRuntime,
      showDesktopLyricsWindow: desktopLyricsRuntime.showWindow,
      closeDesktopLyricsWindow: desktopLyricsRuntime.closeWindow,
      updateDesktopLyricsPayload: desktopLyricsRuntime.updatePayload,
    };
  }, [desktopLyricsRuntime, desktopRuntime]);
  const [splashActive, setSplashActive] = useState<boolean>(SHOW_SPLASH);
  const [searchModeRequest, setSearchModeRequest] = useState<SearchMode>("song");
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginModalMode, setLoginModalMode] = useState<LoginModalMode>("full");
  const [loginProvider, setLoginProvider] = useState<LoginProviderId>("netease");
  const [qqManualCookieOpen, setQqManualCookieOpen] = useState(false);
  const [shelfDetailOpen, setShelfDetailOpen] = useState(false);
  const [sidecarRecoveryState, setSidecarRecoveryState] =
    useState<SidecarRecoveryNoticeState | null>(null);
  const [visualGuideOpen, setVisualGuideOpen] = useState(false);
  const visualGuidePlaylistRestoreRef = useRef<{
    open: boolean;
    tab: PlaylistPanelTab;
  } | null>(null);
  const currentTrack = usePlaybackStore((s) => s.currentTrack);
  const playbackIntentId = usePlaybackStore((s) => s.playbackIntentId);
  const queue = usePlaybackStore((s) => s.queue);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const positionMs = usePlaybackUiPosition();
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const checkpointRestore = usePlaybackStore((s) => s.checkpointRestore);
  const consumeCheckpointAutoplay = usePlaybackStore(
    (s) => s.consumePlaybackCheckpointAutoplay,
  );
  const commitPreparedHandoff = usePlaybackStore(
    (s) => s.commitPreparedHandoff,
  );
  const providerMatrix = useProviderStore((s) => s.matrix);
  const setMatrix = useProviderStore((s) => s.setMatrix);
  const sourceSwitchProviders = useMemo<ProviderId[]>(
    () =>
      (providerMatrix?.providers ?? [])
        .filter(
          (entry) =>
            entry.available &&
            entry.capabilities.includes("search") &&
            entry.capabilities.includes("songUrl"),
        )
        .map((entry) => entry.providerId),
    [providerMatrix],
  );
  const shelfOpen = useShelfStore((s) => s.open);
  const closeShelf = useShelfStore((s) => s.closeShelf);
  const selectShelfPlaylist = useShelfStore((s) => s.selectPlaylist);
  const consoleVisible = useUiStore((s) => s.consoleVisible);
  const setConsole = useUiStore((s) => s.setConsole);
  const miniQueueOpen = useUiStore((s) => s.miniQueueOpen);
  const setMiniQueue = useUiStore((s) => s.setMiniQueue);
  const toggleMiniQueue = useUiStore((s) => s.toggleMiniQueue);
  const toast = useUiStore((s) => s.toast);
  const showToast = useUiStore((s) => s.showToast);
  const clearToast = useUiStore((s) => s.clearToast);
  const setDesktopLyricsWindowEnabledRef = useRef<
    (enabled: boolean) => Promise<void> | void
  >(() => {});
  const handleDesktopLyricsPreferenceChange = useCallback(
    (enabled: boolean) => {
      void setDesktopLyricsWindowEnabledRef.current(enabled);
    },
    [],
  );
  const {
    diyMode,
    playlistPanelPinned,
    userCapsuleAutoHide,
    shelfMode,
    shelfCameraMode,
    shelfPresence,
    shelfShowPodcasts,
    shelfMergeCollections,
    visualFx,
    visualPreset,
    visualIntensity,
    setDiyMode,
    setPlaylistPanelPinned: persistPlaylistPanelPinned,
    setUserCapsuleAutoHide,
    markVisualGuideSeen,
    setShelfModeTransient,
    updateShelfMode,
    updateShelfCameraMode,
    updateShelfPresence,
    updateShelfShowPodcasts,
    updateShelfMergeCollections,
    updateVisualPreset,
    updateVisualFxPatch,
    applyVisualSettingsTransaction,
    updateVisualNumberSetting,
    updateVisualBooleanSetting,
    updateVisualStringSetting,
  } = useShellPreferences({
    showToast,
    onDesktopLyricsChange: handleDesktopLyricsPreferenceChange,
    preferences,
    hydratedPreferences,
  });
  const handleShelfModePreferenceChange = useCallback(
    (mode: Parameters<typeof updateShelfMode>[0]) => {
      afterPreferenceCommit(
        updateShelfMode(mode),
        () => undefined,
        () => showToast("3D 歌单架模式保存失败"),
      );
    },
    [showToast, updateShelfMode],
  );
  const handleShelfCameraPreferenceChange = useCallback(
    (mode: Parameters<typeof updateShelfCameraMode>[0]) => {
      afterPreferenceCommit(
        updateShelfCameraMode(mode),
        () => undefined,
        () => showToast("3D 歌单架镜头偏好保存失败"),
      );
    },
    [showToast, updateShelfCameraMode],
  );
  const handleShelfPresencePreferenceChange = useCallback(
    (presence: Parameters<typeof updateShelfPresence>[0]) => {
      afterPreferenceCommit(
        updateShelfPresence(presence),
        () => undefined,
        () => showToast("3D 歌单架显示偏好保存失败"),
      );
    },
    [showToast, updateShelfPresence],
  );
  const handleShelfPodcastsPreferenceChange = useCallback(
    (show: boolean) => {
      afterPreferenceCommit(
        updateShelfShowPodcasts(show),
        () => undefined,
        () => showToast("3D 歌单架播客偏好保存失败"),
      );
    },
    [showToast, updateShelfShowPodcasts],
  );
  const handleShelfCollectionsPreferenceChange = useCallback(
    (merge: boolean) => {
      afterPreferenceCommit(
        updateShelfMergeCollections(merge),
        () => undefined,
        () => showToast("3D 歌单架收藏偏好保存失败"),
      );
    },
    [showToast, updateShelfMergeCollections],
  );
  const {
    isLiked: isTrackLiked,
    isBusy: isTrackLikeBusy,
    toggle: toggleLikeTrack,
  } = useLikesController({
    likes: applicationPorts?.music.likes ?? null,
    currentTrack,
    showToast,
    openProviderLogin: () => setLoginModalOpen(true),
  });
  const lyricsPayload = useLyricsStore((s) => s.payload);
  const setLyricsPayload = useLyricsStore((s) => s.setPayload);
  const setLyricsLoading = useLyricsStore((s) => s.setLoading);
  const setLyricsError = useLyricsStore((s) => s.setError);
  const setLyricsIndex = useLyricsStore((s) => s.setCurrentIndex);
  const lyricsReset = useLyricsStore((s) => s.reset);

  const togglePlay = usePlaybackStore((s) => s.togglePlay);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setPositionMs = usePlaybackStore((s) => s.setPosition);
  const setDurationMs = usePlaybackStore((s) => s.setDuration);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const setPlaybackMode = usePlaybackStore((s) => s.setMode);
  const playbackMode = usePlaybackStore((s) => s.mode);
  const nextTrack = usePlaybackStore((s) => s.next);
  const previousTrack = usePlaybackStore((s) => s.previous);
  const playQueueAt = usePlaybackStore((s) => s.playAt);
  const removeQueueAt = usePlaybackStore((s) => s.removeAt);
  const insertQueueNext = usePlaybackStore((s) => s.insertNext);
  const setQueue = usePlaybackStore((s) => s.setQueue);
  const clearQueue = usePlaybackStore((s) => s.clearQueue);
  const searchKeyword = useSearchStore((s) => s.keyword);
  const searchDetailOpen = useSearchStore((s) => s.detailOpen);
  const setSearchKeyword = useSearchStore((s) => s.setKeyword);
  const setSearchError = useSearchStore((s) => s.setError);
  const libraryControllerRef = useRef<LibraryControllerResult | null>(null);
  const accountLoggedInRef = useRef(false);
  const homeControllerRef = useRef<HomeControllerResult | null>(null);
  const homeResumeRef = useRef<() => void>(() => undefined);
  const currentQueueIndex = useMemo(() => {
    if (!currentTrack) return -1;
    const identityIndex = queue.findIndex((track) => track === currentTrack);
    if (identityIndex >= 0) return identityIndex;
    return queue.findIndex(
      (track) =>
        track.provider === currentTrack.provider && track.id === currentTrack.id,
    );
  }, [currentTrack, queue]);
  const homeController = useHomeController({
    discover: applicationPorts?.music.discover ?? null,
    library: applicationPorts?.music.library ?? null,
    search: applicationPorts?.music.search ?? null,
    currentTrack,
    positionMs,
    durationMs,
    queue,
    currentQueueIndex,
    isPlaying,
    playbackMode,
    providerLoggedIn: () => accountLoggedInRef.current,
    libraryPanelPinned: playlistPanelPinned,
    playback: {
      setQueue,
      playAt: (index) => usePlaybackStore.getState().playAt(index),
      resume: () => homeResumeRef.current(),
    },
    searchQuery: (query, mode = "song") => {
      homeControllerRef.current?.setSuppressed(false);
      setSearchModeRequest(mode);
      setSearchKeyword(query);
      const input = typeof document === "undefined" ? null : document.getElementById("search-input");
      if (input instanceof HTMLElement && input.tagName === "INPUT") input.focus();
    },
    openLogin: () => setLoginModalOpen(true),
    openLibrarySurface: () => {
      const library = libraryControllerRef.current;
      if (!library) return;
      void library.refresh();
      setConsole(false);
      setMiniQueue(false);
      closeShelf();
      selectShelfPlaylist(null);
      library.openPanelTab("playlists");
      showToast("已打开歌单库");
    },
    enterPlaybackSurface: () => {
      setConsole(true);
      setMiniQueue(false);
    },
    closeLibraryPanel: () => libraryControllerRef.current?.setPanelOpen(false),
    closeShelf,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
    storage: homeListenRepository,
  });
  homeControllerRef.current = homeController;
  const {
    discover: homeDiscover,
    weatherRadio: homeWeatherRadio,
    playlistDetail: homePlaylistDetail,
    discoverLoading: homeDiscoverLoading,
    weatherRadioLoading: homeWeatherRadioLoading,
    discoverError: homeDiscoverError,
    weatherRadioError: homeWeatherRadioError,
    forcedOpen: homeForcedOpen,
    suppressed: homeSuppressed,
    listenSummary: homeListenSummary,
    dashboard: homeDashboard,
    setForcedOpen: setHomeForcedOpen,
    setSuppressed: setHomeSuppressed,
    refreshDiscover: refreshHomeDiscover,
    refreshWeatherRadio: refreshHomeWeatherRadio,
    recordListenPause: recordHomeListenPause,
    recordListenProgress: recordHomeListenProgress,
    finalizeListenSession: finalizeHomeListenSession,
    playDaily: playHomeDaily,
    playPrivate: playHomePrivate,
    playDiscoverSongs: playHomeDiscoverSongs,
    openPlaylist: openHomeDiscoverPlaylist,
    closePlaylistDetail: closeHomePlaylistDetail,
    playPlaylistDetail: playHomePlaylistDetail,
    searchPlaylistDetailArtist: searchHomePlaylistDetailArtist,
    openPodcast: openHomeDiscoverPodcast,
    openPodcastSearch: openHomePodcastSearch,
    playWeatherSong: playHomeWeatherSong,
    openInsight: openHomeInsight,
    playRecent: playHomeRecent,
    continueListening: continueHomeListening,
    playNextUp: playHomeNextUp,
    playForYou: playHomeForYou,
    enterPlaybackSurface,
  } = homeController;

  const controllerRef = useRef<PlaybackControllerRef["current"]>(null);
  const audioFrameSourceRef = useRef<AudioFrameSource | null>(null);
  const playbackRateRef = useRef(1);
  const playbackAudioFrameSource = useCallback<AudioFrameSource>(
    () => audioFrameSourceRef.current?.() ?? null,
    [],
  );
  const playbackAudioSettings = usePlaybackAudioSettings({
    controllerRef,
    preferences,
  });
  const handlePlaybackControllerReady = useCallback(
    (controller: PlaybackControllerRef["current"]) => {
      playbackQuiescenceAdapter?.setPlayerController(controller);
      return playbackAudioSettings.handleControllerReady(controller);
    },
    [playbackAudioSettings.handleControllerReady, playbackQuiescenceAdapter],
  );
  const neteaseCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const qqCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sodaCookieInputRef = useRef<HTMLTextAreaElement | null>(null);
  const shelfContentListRef = useRef<ShelfDetailContentListController | null>(
    null,
  );
  const desktopLyricsBeatMapKeyRef = useRef("none");
  const visualPerformanceSnapshotReaderRef = useRef<VisualPerformanceSnapshotReader | null>(null);
  const desktopLyricsMotionRef = useRef<DesktopLyricsMotionSnapshot>({
    highBloom: 0,
    beatGlow: 0,
    beatPulse: 0,
    bass: 0,
  });
  const readVisualPerformanceSnapshot = useCallback(
    () => visualPerformanceSnapshotReaderRef.current?.() ?? null,
    [],
  );
  const lyricsPayloadRef = useRef(lyricsPayload);
  lyricsPayloadRef.current = lyricsPayload;
  const clearCurrentBeatMapRef = useRef<() => void>(() => undefined);
  const confirmSourcePlaybackRef = useRef<() => void>(() => undefined);
  const rollbackFailedSourcePlaybackRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const toggleWindowFullscreenRef = useRef<() => Promise<void>>(async () => {});
  const applyCustomCoverImageRef = useRef<
    (file: Blob, track?: Track) => Promise<void>
  >(async () => undefined);
  const {
    fileInputRef,
    localAudioUrlsRef,
    openLocalFileImport,
    importLocalFiles,
    playMiniQueueIndex,
    insertMiniQueueNext,
    cyclePlaylistPanelMode,
    shufflePlaylistPanelQueue,
    clearPlaylistPanelQueue,
    seekPlayback,
    handleRuntimeTimeUpdate: handleUiRuntimeTimeUpdate,
    handleRuntimeDurationChange: handleUiRuntimeDurationChange,
    handleRuntimeEnded: handleUiRuntimeEnded,
  } = usePlaybackUiController({
    controllerRef,
    lyricsPayloadRef,
    playbackMode,
    setPositionMs,
    setDurationMs,
    setLyricsIndex,
    setMiniQueue,
    insertQueueNext,
    setPlaybackMode,
    setQueue,
    clearQueue,
    recordListenProgress: recordHomeListenProgress,
    finalizeListenSession: finalizeHomeListenSession,
    enterPlaybackSurface,
    setHomeForcedOpen,
    setHomeSuppressed,
    clearCurrentBeatMap: () => clearCurrentBeatMapRef.current(),
    applyCustomCoverImage: (file, track) =>
      applyCustomCoverImageRef.current(file, track),
    showToast,
  });

  const getPlaybackSessionSnapshot = useCallback(() => {
    const state = usePlaybackStore.getState();
    return {
      currentTrack: state.currentTrack,
      positionMs: state.positionMs,
      durationMs: state.durationMs,
      isPlaying: state.isPlaying,
    };
  }, []);
  const persistPlaybackQuality = useCallback(
    (quality: Parameters<typeof savePlaybackQualityPreference>[0]) => {
      if (preferences) {
        return preferences.set(PLAYBACK_QUALITY_PREFERENCE, quality);
      }
      savePlaybackQualityPreference(quality);
    },
    [preferences],
  );
  const {
    playbackQuality,
    trackQualityOptions,
    trialBanner,
    currentBeatMapState,
    originalLyricsPayloadRef,
    clearCurrentBeatMap,
    dismissTrialBanner,
    setPlaybackQuality,
    togglePlayback,
    handleRuntimeTimeUpdate,
    handleRuntimeDurationChange,
    handleRuntimeOwnerChange,
    handleRuntimePlay,
    handleRuntimePause,
    handleRuntimeEnded,
    handleRuntimeError,
    handleRuntimeStalled,
  } = usePlaybackSessionRuntime({
    appServices: applicationPorts,
    controllerRef,
    localAudioUrlsRef,
    currentTrack,
    playbackIntentId,
    positionMs,
    checkpointRestore,
    consumeCheckpointAutoplay,
    queue,
    playbackMode,
    gaplessEnabled: playbackAudioSettings.preference.gaplessEnabled,
    crossfadeEnabled: playbackAudioSettings.preference.crossfadeEnabled,
    commitPreparedHandoff,
    getPlaybackSnapshot: getPlaybackSessionSnapshot,
    setPlaying,
    setPositionMs,
    togglePlayFallback: togglePlay,
    setSearchError,
    showToast,
    setHomeForcedOpen,
    setHomeSuppressed,
    setLyricsPayload,
    setLyricsLoading,
    setLyricsError,
    resetLyrics: lyricsReset,
    beatMapKeyForMap: desktopLyricsBeatMapKey,
    initialLyricsPayload: lyricsPayload,
    initialPlaybackQuality:
      hydratedPreferences?.playbackQuality ?? readPlaybackQualityPreference(),
    persistPlaybackQuality,
    onRuntimePause: recordHomeListenPause,
    onRuntimeTimeUpdate: handleUiRuntimeTimeUpdate,
    onRuntimeDurationChange: handleUiRuntimeDurationChange,
    onRuntimeEnded: handleUiRuntimeEnded,
    onPlaybackReady: () => confirmSourcePlaybackRef.current(),
    onPlaybackFailed: () => {
      void rollbackFailedSourcePlaybackRef.current();
    },
  });
  homeResumeRef.current = togglePlayback;
  clearCurrentBeatMapRef.current = clearCurrentBeatMap;
  const getSourceSwitchSnapshot = useCallback(() => {
    const state = usePlaybackStore.getState();
    return {
      track: state.currentTrack,
      playbackIntentId: state.playbackIntentId,
      positionMs: state.positionMs,
    };
  }, []);
  const commitSourceSwitch = useCallback(
    (request: Parameters<ReturnType<typeof usePlaybackStore.getState>["replaceCurrentSource"]>[0]) =>
      usePlaybackStore.getState().replaceCurrentSource(request),
    [],
  );
  const {
    busyProvider: sourceSwitchBusy,
    switchSource,
    confirmSourcePlayback,
    rollbackFailedSourcePlayback,
  } =
    useSourceSwitchController({
      search: applicationPorts?.music.search ?? null,
      playback: applicationPorts?.music.playback ?? null,
      getPlaybackSnapshot: getSourceSwitchSnapshot,
      commit: commitSourceSwitch,
      showToast,
    });
  confirmSourcePlaybackRef.current = confirmSourcePlayback;
  rollbackFailedSourcePlaybackRef.current = rollbackFailedSourcePlayback;
  const sourceSwitchDisabled = useMemo(() => {
    if (!currentTrack) return true;
    const key = `${currentTrack.provider}:${currentTrack.id}`;
    if (localAudioUrlsRef.current.has(key)) return true;
    const extended = currentTrack as Track & {
      programId?: string;
      radioId?: string;
      local?: boolean;
    };
    return Boolean(extended.programId || extended.radioId || extended.local);
  }, [currentTrack, localAudioUrlsRef]);
  const {
    customLyricModalOpen,
    setCustomLyricModalOpen,
    customLyricText,
    setCustomLyricText,
    customLyricStatus,
    customLyricInputRef,
    currentLyricPreference,
    currentCustomLyricText,
    currentHasCustomCover,
    applyCustomCoverImage,
    clearCustomCoverImage,
    applyOriginalLyrics,
    openCustomLyricModal,
    chooseCustomLyrics,
    saveCustomLyric,
    deleteCustomLyric,
  } = useTrackCustomizationController({
    currentTrack,
    originalLyricsPayloadRef,
    setLyricsPayload,
    showToast,
  });
  applyCustomCoverImageRef.current = applyCustomCoverImage;

  const emptyHomeCoreAllowed = shouldShowEmptyHome({
    splashActive: false,
    homeForcedOpen: false,
    homeSuppressed: false,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
    shelfDetailOpen,
    shelfPinnedOpen: shelfOpen,
    shelfStageOpen: shelfMode === "stage",
  });
  const emptyHomeActive = shouldShowEmptyHome({
    splashActive,
    homeForcedOpen,
    homeSuppressed,
    hasCurrentTrack: !!currentTrack,
    queueLength: queue.length,
    isPlaying,
    shelfDetailOpen,
    shelfPinnedOpen: shelfOpen,
    shelfStageOpen: shelfMode === "stage",
  });
  const homeControlsLocked =
    emptyHomeActive &&
    homeForcedOpen &&
    !consoleVisible &&
    emptyHomeCoreAllowed;
  const currentLiked = isTrackLiked(currentTrack);
  const currentLikeBusy = isTrackLikeBusy(currentTrack);

  const revealConsole = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    setConsole(true);
  }, [setConsole]);

  const openHomePlayerConsole = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(false);
    setConsole(true);
    setMiniQueue(false);
    forceBottomControlsVisible(2800);
    showToast("播放器控制台已展开");
  }, [setConsole, setMiniQueue, showToast]);

  const focusSearch = useCallback(() => {
    if (typeof document === "undefined") return;
    const input = document.getElementById("search-input");
    if (input instanceof HTMLElement && input.tagName === "INPUT") input.focus();
  }, []);

  const searchQuery = useCallback(
    (query: string, mode: SearchMode = "song") => {
      setHomeSuppressed(false);
      setSearchModeRequest(mode);
      setSearchKeyword(query);
      focusSearch();
    },
    [focusSearch, setSearchKeyword],
  );

  const libraryController = useLibraryController({
    library: applicationPorts?.music.library ?? null,
    discover: applicationPorts?.music.discover ?? null,
    getCurrentTrack: () => usePlaybackStore.getState().currentTrack,
    playback: {
      setQueue,
      playAt: (index) => usePlaybackStore.getState().playAt(index),
      enterPlaybackSurface,
    },
    searchQuery,
    openLogin: () => setLoginModalOpen(true),
    resetSearch: () => useSearchStore.getState().reset(),
    setSearchError,
    showToast,
  });
  const {
    playlists: shelfPlaylists,
    importedPlaylists,
    podcastCollections: shelfPodcastCollections,
    panelOpen: playlistPanelOpen,
    panelTab: playlistPanelTab,
    setPanelOpen: setPlaylistPanelOpen,
    setPanelTab: setPlaylistPanelTab,
    openPanelTab: openPlaylistPanelTab,
    refresh: refreshShelfPlaylists,
    refreshProvider: refreshProviderPlaylists,
    openCollectPicker,
    openCollectPickerForCurrent,
    importSharedPlaylist: importSharedPlaylistFromText,
    deleteImportedPlaylist,
    loadPlaylistDetail: loadPlaylistPanelDetail,
    playTracks: playPlaylistPanelTracks,
    openPodcastCollection: openPlaylistPanelPodcastCollection,
    playShelfPlaylist,
  } = libraryController;
  libraryControllerRef.current = libraryController;

  const toggleDiyMode = useCallback(() => {
    const next = !diyMode;
    afterPreferenceCommit(
      setDiyMode(next),
      () => {
        if (!next) {
          setPlaylistPanelOpen(false);
          setMiniQueue(false);
        }
        showToast(next ? "DIY 玩家模式已开启" : "已切回简约模式");
      },
      () => showToast("DIY 玩家模式偏好保存失败"),
    );
  }, [
    diyMode,
    setDiyMode,
    setMiniQueue,
    setPlaylistPanelOpen,
    showToast,
  ]);

  const showUnavailable = useCallback(
    (message: string) => {
      setSearchError(message);
      showToast(message);
      focusSearch();
    },
    [focusSearch, setSearchError, showToast],
  );

  const showNotice = useCallback(
    (message: string) => {
      showToast(message);
    },
    [showToast],
  );

  const restoreVisualGuidePlaylistPanel = useCallback(() => {
    const snapshot = visualGuidePlaylistRestoreRef.current;
    if (!snapshot) return;
    visualGuidePlaylistRestoreRef.current = null;
    setPlaylistPanelTab(snapshot.tab);
    if (!playlistPanelPinned) setPlaylistPanelOpen(snapshot.open);
  }, [playlistPanelPinned]);

  const toggleUserCapsuleAutoHide = useCallback(() => {
    const next = !userCapsuleAutoHide;
    afterPreferenceCommit(
      setUserCapsuleAutoHide(next),
      () => showToast(next ? "账号胶囊已自动隐藏" : "账号胶囊已固定显示"),
      () => showToast("账号胶囊偏好保存失败"),
    );
  }, [setUserCapsuleAutoHide, showToast, userCapsuleAutoHide]);

  const closeVisualGuide = useCallback((markSeen: boolean) => {
    if (markSeen) {
      afterPreferenceCommit(
        markVisualGuideSeen(),
        () => undefined,
        () => showToast("新手引导状态保存失败"),
      );
    }
    restoreVisualGuidePlaylistPanel();
    setVisualGuideOpen(false);
  }, [markVisualGuideSeen, restoreVisualGuidePlaylistPanel, showToast]);

  const prepareVisualGuideStep = useCallback(
    (step: VisualGuideStep) => {
      if (step.selector === "#search-box") {
        setHomeSuppressed(false);
        focusSearch();
      }
      if (step.selector === "#playlist-panel") {
        if (!visualGuidePlaylistRestoreRef.current) {
          visualGuidePlaylistRestoreRef.current = {
            open: playlistPanelOpen || playlistPanelPinned,
            tab: playlistPanelTab,
          };
        }
        setPlaylistPanelTab("playlists");
        setPlaylistPanelOpen(true);
      } else {
        restoreVisualGuidePlaylistPanel();
      }
      if (step.selector === "#bottom-bar") revealConsole();
      if (step.selector === "#fx-fab") {
        const panel = typeof document === "undefined" ? null : document.getElementById("fx-panel");
        const button = typeof document === "undefined" ? null : document.getElementById("fx-fab");
        if (button && "click" in button && !panel?.classList.contains("show")) button.click();
      }
      if (step.target === "shelf") {
        setShelfModeTransient("side");
        useShelfStore.getState().openShelf();
      }
    },
    [
      focusSearch,
      playlistPanelOpen,
      playlistPanelPinned,
      playlistPanelTab,
      restoreVisualGuidePlaylistPanel,
      revealConsole,
      setShelfModeTransient,
    ],
  );

  const goHome = useCallback(() => {
    if (homeForcedOpen || emptyHomeActive) {
      closeHomePlaylistDetail();
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
      if (!playlistPanelPinned) setPlaylistPanelOpen(false);
      closeShelf();
      selectShelfPlaylist(null);
      showToast("已关闭 Home");
      return;
    }
    closeHomePlaylistDetail();
    setHomeSuppressed(false);
    setHomeForcedOpen(true);
    setConsole(false);
    setMiniQueue(false);
    if (!playlistPanelPinned) setPlaylistPanelOpen(false);
    closeShelf();
    selectShelfPlaylist(null);
    focusSearch();
    showToast("已回到 Home");
  }, [
    closeShelf,
    closeHomePlaylistDetail,
    emptyHomeActive,
    focusSearch,
    homeForcedOpen,
    playlistPanelPinned,
    selectShelfPlaylist,
    setConsole,
    setMiniQueue,
    showToast,
  ]);

  const providerLabel = useCallback(
    (provider: ProviderId) => providerLabelText(provider),
    [],
  );

  const handleApplicationConnection = useCallback(
    (ports: ApplicationPorts) => {
      setApplicationPorts(ports);
    },
    [],
  );

  const handleRuntimeLibraryRefresh = useCallback(
    (ports: ApplicationPorts) => {
      void refreshShelfPlaylists(
        ports.music.library,
        ports.music.discover,
      );
    },
    [refreshShelfPlaylists],
  );

  const handleRecoveryState = useCallback(
    (state: SidecarRecoveryNoticeState) => {
      setSidecarRecoveryState(state);
    },
    [],
  );

  const syncProviderLoginLibrary = useCallback(
    async (provider: LoginProviderId) => {
      if (!applicationPorts?.music.library) return;
      await refreshProviderPlaylists(provider);
      await refreshHomeDiscover();
    },
    [applicationPorts?.music.library, refreshHomeDiscover, refreshProviderPlaylists],
  );

  const syncAccountProviderPlaylists = useCallback(
    async (provider: LoginProviderId) => {
      if (!applicationPorts?.music.library) return;
      await refreshProviderPlaylists(provider);
    },
    [applicationPorts?.music.library, refreshProviderPlaylists],
  );

  const refreshAccountLibrary = useCallback(() => {
    void refreshShelfPlaylists();
  }, [refreshShelfPlaylists]);

  const {
    statusByProvider: accountStatusByProvider,
    acceptProviderStatus,
    refreshProviderStatus,
    importProviderCookie: importProviderSessionCookie,
    logoutProvider,
  } = useAccountSessionController({
    accounts: applicationPorts?.music.accounts ?? null,
    syncProviderPlaylists: syncAccountProviderPlaylists,
    refreshHome: refreshHomeDiscover,
    refreshLibrary: refreshAccountLibrary,
    providerLabel,
    showToast,
  });
  const neteaseStatus = accountStatusByProvider.netease;
  const qqStatus = accountStatusByProvider.qq;
  const sodaStatus = accountStatusByProvider.soda;
  accountLoggedInRef.current = !!(
    neteaseStatus?.loggedIn ||
    qqStatus?.loggedIn ||
    sodaStatus?.loggedIn
  );

  const {
    qrByProvider: loginQrByProvider,
    statusByProvider: loginQrStatusByProvider,
    refreshProviderLoginQr,
    resetProviderLoginQr,
  } = useLoginQrRuntime({
    accounts: applicationPorts?.music.accounts ?? null,
    modalOpen: loginModalOpen,
    modalMode: loginModalMode,
    provider: loginProvider,
    onProviderStatus: acceptProviderStatus,
    syncProviderLibrary: syncProviderLoginLibrary,
    refreshLibraryAfterLoggedOut: refreshAccountLibrary,
    providerLabel,
    showToast,
  });

  const openLoginModal = useCallback(() => {
    const statusByProvider: Partial<Record<ProviderId, ProviderLoginStatus | null>> = {
      netease: neteaseStatus,
      qq: qqStatus,
      soda: sodaStatus,
    };
    const loggedProviderCount = LOGIN_PROVIDERS.filter(
      (provider) => statusByProvider[provider]?.loggedIn,
    ).length;
    const firstMissingProvider =
      LOGIN_PROVIDERS.find((provider) => !statusByProvider[provider]?.loggedIn) ?? "netease";
    setAccountDropdownOpen(false);
    resetProviderLoginQr();
    setLoginModalOpen(true);
    if (loggedProviderCount > 0) {
      setLoginModalMode("add-account");
      setLoginProvider(firstMissingProvider);
    } else {
      setLoginModalMode("full");
      setLoginProvider("netease");
    }
    setQqManualCookieOpen(false);
    for (const provider of LOGIN_PROVIDERS) void refreshProviderStatus(provider);
  }, [
    neteaseStatus?.loggedIn,
    qqStatus?.loggedIn,
    sodaStatus?.loggedIn,
    refreshProviderStatus,
    resetProviderLoginQr,
  ]);

  const openSingleProviderLogin = useCallback((provider: ProviderId) => {
    setAccountDropdownOpen(false);
    resetProviderLoginQr();
    setLoginModalOpen(true);
    setLoginProvider(provider);
    setLoginModalMode("single-provider");
    setQqManualCookieOpen(false);
  }, [resetProviderLoginQr]);

  const handleAccountButtonClick = useCallback(() => {
    if (neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) {
      setAccountDropdownOpen((open) => !open);
      return;
    }
    openLoginModal();
  }, [neteaseStatus?.loggedIn, openLoginModal, qqStatus?.loggedIn, sodaStatus?.loggedIn]);

  const openHomeProductGuide = useCallback(() => {
    setHomeSuppressed(false);
    setVisualGuideOpen(true);
  }, []);

  const setPlaylistPanelPinned = useCallback((pinned: boolean) => {
    afterPreferenceCommit(
      persistPlaylistPanelPinned(pinned),
      () => {
        if (pinned) setPlaylistPanelOpen(true);
        showToast(pinned ? "左侧歌单已常开" : "左侧歌单已恢复自动隐藏");
      },
      () => showToast("左侧歌单固定偏好保存失败"),
    );
  }, [persistPlaylistPanelPinned, setPlaylistPanelOpen, showToast]);

  const togglePlaylistPanelPinned = useCallback(() => {
    setPlaylistPanelPinned(!playlistPanelPinned);
  }, [playlistPanelPinned, setPlaylistPanelPinned]);

  const openHomeLibrary = useCallback(() => {
    closeHomePlaylistDetail();
    if (homeDiscover?.loggedIn || neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn) {
      void refreshShelfPlaylists();
      setHomeForcedOpen(false);
      setHomeSuppressed(true);
      setConsole(false);
      setMiniQueue(false);
      closeShelf();
      selectShelfPlaylist(null);
      openPlaylistPanelTab("playlists");
      showToast("已打开歌单库");
      return;
    }
    openLocalFileImport();
  }, [
    closeHomePlaylistDetail,
    homeDiscover?.loggedIn,
    neteaseStatus?.loggedIn,
    closeShelf,
    openLocalFileImport,
    openPlaylistPanelTab,
    qqStatus?.loggedIn,
    sodaStatus?.loggedIn,
    refreshShelfPlaylists,
    selectShelfPlaylist,
    setConsole,
    setHomeForcedOpen,
    setHomeSuppressed,
    setMiniQueue,
    showToast,
  ]);

  const toggleLikeCurrent = useCallback(async () => {
    await toggleLikeTrack(usePlaybackStore.getState().currentTrack);
  }, [toggleLikeTrack]);

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    setLoginModalMode("full");
    setQqManualCookieOpen(false);
    resetProviderLoginQr();
    if (neteaseCookieInputRef.current) neteaseCookieInputRef.current.value = "";
    if (qqCookieInputRef.current) qqCookieInputRef.current.value = "";
    if (sodaCookieInputRef.current) sodaCookieInputRef.current.value = "";
  }, [resetProviderLoginQr]);

  const importProviderCookie = useCallback(
    async (provider: LoginProviderId) => {
      const input =
        provider === "netease"
          ? neteaseCookieInputRef.current
          : provider === "soda"
            ? sodaCookieInputRef.current
            : qqCookieInputRef.current;
      const cookie = input?.value.trim() ?? "";
      await importProviderSessionCookie(provider, cookie, {
        onStored: () => setQqManualCookieOpen(false),
        onFinished: () => {
          if (input) input.value = "";
        },
      });
    },
    [importProviderSessionCookie],
  );

  const toggleLikeQueueIndex = useCallback(
    (index: number) => {
      void toggleLikeTrack(usePlaybackStore.getState().queue[index]);
    },
    [toggleLikeTrack],
  );

  const collectQueueIndex = useCallback(
    (index: number) => {
      const track = usePlaybackStore.getState().queue[index];
      if (track) openCollectPicker(track);
    },
    [openCollectPicker],
  );

  const insertSearchResultNext = useCallback(
    (track: Track) => {
      insertQueueNext(track);
      showToast(`已设为下一首: ${track.title}`);
    },
    [insertQueueNext, showToast],
  );

  const appendSearchResult = useCallback(
    (track: Track) => {
      usePlaybackStore.getState().enqueue(track);
      showToast(`已加入播放队列: ${track.title}`);
    },
    [showToast],
  );

  const playSearchDetailTracks = useCallback(
    (tracks: Track[], index: number) => {
      if (!tracks.length) {
        showToast("没有可播放的搜索结果");
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
      setQueue(tracks);
      usePlaybackStore.getState().playAt(safeIndex);
      useSearchStore.getState().closeDetail();
      enterPlaybackSurface();
      showToast(tracks[safeIndex]?.title ?? "已开始播放");
    },
    [enterPlaybackSurface, setQueue, showToast],
  );

  const searchArtistFromResult = useCallback(
    (artist: string) => {
      searchQuery(artist, "song");
    },
    [searchQuery],
  );

  const currentDesktopLyricSnapshot = useCallback(() => {
    const payload = useLyricsStore.getState().payload;
    const playback = usePlaybackStore.getState();
    const fallback = playback.currentTrack
      ? `${trackTitle(playback.currentTrack)} - ${trackArtist(playback.currentTrack)}`
      : "";
    return buildDesktopLyricSnapshot(payload, playback.positionMs, fallback);
  }, []);

  const buildDesktopRuntimeLyricsPayload = useCallback((force: boolean) => {
    const playback = usePlaybackStore.getState();
    const duration = playback.durationMs ?? 0;
    const snapshot = currentDesktopLyricSnapshot();
    const motion = desktopLyricsMotionRef.current;
    const beatMapContext = desktopLyricsBeatMapContext(
      currentBeatMapState,
      force,
      desktopLyricsBeatMapKeyRef,
    );
    return buildDesktopLyricsPayloadPatch(
      useVisualStore.getState().fx,
      snapshot.text,
      snapshot.progress,
      {
        title: trackTitle(playback.currentTrack),
        artist: trackArtist(playback.currentTrack),
        playing: playback.isPlaying,
        progressSpan: snapshot.progressSpan,
        positionMs: playback.positionMs,
        durationMs: duration,
        playbackRate: playbackRateRef.current,
        highBloom: motion.highBloom,
        beatGlow: motion.beatGlow,
        beatPulse: motion.beatPulse,
        bass: motion.bass,
        stageLyricPalette: motion.palette,
        ...beatMapContext,
      },
    );
  }, [currentBeatMapState, currentDesktopLyricSnapshot]);

  const desktopHotkeyActions = useMemo(() => ({
    togglePlay: togglePlayback,
    prevTrack: previousTrack,
    nextTrack,
    volumeUp: () => setVolume(usePlaybackStore.getState().volume + 0.05),
    volumeDown: () => setVolume(usePlaybackStore.getState().volume - 0.05),
    toggleFullscreen: () => {
      void toggleWindowFullscreenRef.current();
    },
  }), [nextTrack, previousTrack, setVolume, togglePlayback]);

  const clearDesktopWindowShell = useCallback(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("desktop-shell-root");
      document.body.classList.remove(
        "desktop-shell",
        "desktop-maximized",
        "desktop-fullscreen",
      );
    }
  }, []);

  const desktopLyricsPayloadVersion = useMemo(() => ({
    currentTrack,
    isPlaying,
    positionMs,
    durationMs,
    lyricsPayload,
    currentBeatMapState,
    visualFx,
  }), [
    currentBeatMapState,
    currentTrack,
    durationMs,
    isPlaying,
    lyricsPayload,
    positionMs,
    visualFx,
  ]);

  useCustomLyricFontRuntime(visualFx.lyricFont, (fontKey) => {
    updateVisualStringSetting("lyricFont", fontKey);
  });

  const {
    desktopWindowState,
    toggleDesktopLyrics,
    setDesktopLyricsEnabled: setDesktopLyricsWindowEnabled,
    minimizeWindow,
    toggleWindowMaximize,
    toggleWindowFullscreen,
    closeWindow,
  } = useDesktopRuntime({
    desktop: resolvedDesktopRuntime,
    buildLyricsPayload: buildDesktopRuntimeLyricsPayload,
    lyricsPayloadVersion: desktopLyricsPayloadVersion,
    hotkeyActions: desktopHotkeyActions,
    onWindowState: applyDesktopWindowShellState,
    onWindowCleanup: clearDesktopWindowShell,
    onDesktopLyricsLockChanged: (clickThrough) => {
      updateVisualBooleanSetting("desktopLyricsClickThrough", clickThrough);
    },
    onLyricsPayloadSent: (payload) => {
      if (typeof payload.beatMapKey === "string") {
        desktopLyricsBeatMapKeyRef.current = payload.beatMapKey;
      }
    },
  });
  const desktopManagement = useDesktopManagementRuntime(resolvedDesktopRuntime, {
    getVisualPerformanceSnapshot: readVisualPerformanceSnapshot,
  });
  const fullDesktopManagement = useFullDesktopRuntime(fullDesktopRuntime);
  const updateExperience = useUpdateExperience(
    updateController,
    resolveUpdatePresentationMode(
      desktopWindowState,
      fullDesktopManagement.state,
    ),
  );
  const persistWallpaperSelection = useCallback(
    (projectId: string | null) => {
      if (!preferences) return;
      return preferences.set(WALLPAPER_SELECTION_PREFERENCE, projectId);
    },
    [preferences],
  );
  const persistSettingsFabAutoHide = useCallback(
    (value: boolean) => {
      if (!preferences) return;
      return preferences.set(SETTINGS_FAB_AUTO_HIDE_PREFERENCE, value);
    },
    [preferences],
  );
  const wallpaperEngineManagement = useWallpaperEngineRuntime(wallpaperEngineRuntime, {
    windowState: desktopWindowState,
    initialSelection: hydratedPreferences?.wallpaperSelection,
    persistSelection: preferences ? persistWallpaperSelection : undefined,
  });
  const setCoordinatedFullDesktopMode = useCallback(async (mode: "disabled" | "passive" | "interactive") => {
    await setFullDesktopModeWithWallpaperFallback(
      mode,
      wallpaperEngineManagement.preparePassiveFallback,
      fullDesktopManagement.setMode,
    );
  }, [fullDesktopManagement, wallpaperEngineManagement]);
  const coordinatedFullDesktopManagement = useMemo(() => ({
    ...fullDesktopManagement,
    setMode: setCoordinatedFullDesktopMode,
  }), [fullDesktopManagement, setCoordinatedFullDesktopMode]);
  setDesktopLyricsWindowEnabledRef.current = setDesktopLyricsWindowEnabled;
  toggleWindowFullscreenRef.current = toggleWindowFullscreen;
  const dismissEmptyHome = useCallback(() => {
    setHomeForcedOpen(false);
    setHomeSuppressed(true);
    setConsole(false);
    setMiniQueue(false);
  }, [setConsole, setHomeForcedOpen, setHomeSuppressed, setMiniQueue]);
  const { aiDepthChip } = useGlobalShellRuntime({
    diyMode,
    splashActive,
    emptyHomeActive,
    consoleVisible,
    homeControlsLocked,
    userCapsuleAutoHide,
    visualGuideOpen,
    searchDetailOpen,
    shelfMode,
    visualFx,
    toast,
    miniQueueOpen,
    accountDropdownOpen,
    accountLoggedIn: Boolean(
      neteaseStatus?.loggedIn || qqStatus?.loggedIn || sodaStatus?.loggedIn,
    ),
    clearToast,
    setMiniQueue,
    setAccountDropdownOpen,
    dismissEmptyHome,
    showToast,
  });

  const shellProps: AppShellProps = {
    sidecarRuntimeProps: {
      applicationRuntime,
      loginProviders: LOGIN_PROVIDERS,
      onConnection: handleApplicationConnection,
      onCapabilities: setMatrix,
      onProviderStatus: acceptProviderStatus,
      onRefreshLibrary: handleRuntimeLibraryRefresh,
      onRecoveryState: handleRecoveryState,
    },
    fileInputRef,
    localAudioAccept: LOCAL_AUDIO_ACCEPT,
    onImportLocalFiles: importLocalFiles,
    titlebar: {
      maximized: desktopWindowState?.isMaximized,
      onGuide: openHomeProductGuide,
      onDiy: toggleDiyMode,
      diyActive: diyMode,
      onMinimize: () => void minimizeWindow(),
      onToggleMaximize: () => void toggleWindowMaximize(),
      onClose: () => void closeWindow(),
      updateProps: {
        viewModel: updateExperience.viewModel,
        onOpen: updateExperience.openModal,
        onClose: updateExperience.closeModal,
        onPrimary: () => void updateExperience.invokePrimary(),
        onRemindLater: () => void updateExperience.remindLater(),
        onSkipVersion: () => void updateExperience.skipVersion(),
        onOpenRelease: () => void updateExperience.openRelease(),
      },
    },
    SplashComponent,
    splashVisible: SHOW_SPLASH && splashActive,
    onSplashDismissed: () => setSplashActive(false),
    visual: {
      VisualComponent,
      wallpaperEngineBackgroundProps: {
        project: wallpaperEngineManagement.selected,
        runtime: wallpaperEngineManagement.runtime,
        fullDesktopMode: fullDesktopManagement.state?.effectiveMode ?? "disabled",
      },
      engineProps: {
        audioFrameSource: playbackAudioFrameSource,
        lyricsPayload,
        positionMs,
        durationMs,
        isPlaying,
        playbackVolume: muted ? 0 : volume,
        queue,
        playlists: shelfPlaylists,
        podcastCollections: shelfPodcastCollections,
        currentTrack,
        currentCoverUrl: currentTrack?.coverUrl,
        beatMapKey: currentBeatMapState?.key,
        beatMap: currentBeatMapState?.map,
        mediaUrl: applicationPorts?.mediaUrl,
        coverResolution: visualFx.coverResolution,
        fxState: visualFx,
        shelfSettings: {
          mode: shelfMode,
          cameraMode: shelfCameraMode,
          presence: shelfPresence,
          showPodcasts: shelfShowPodcasts,
          mergeCollections: shelfMergeCollections,
        },
        splashActive,
        homeActive: emptyHomeActive,
        secondaryLeftDisplaySeamGuardActive:
          shouldUseSecondaryLeftDisplaySeamGuard(desktopWindowState),
        onShelfModeChange: handleShelfModePreferenceChange,
        onShelfPlayQueueIndex: (index) =>
          usePlaybackStore.getState().playAt(index),
        onShelfPlayPlaylist: (payload) => void playShelfPlaylist(payload),
        onShelfDetailRowClick: (payload) => {
          void handleShelfDetailRowAction({
            ...payload,
            likes: applicationPorts?.music.likes,
            isLiked: () => false,
            onResult: showToast,
            onOpenCollect: openCollectPicker,
            onOpenPodcastRadio: (radioId, title) => {
              const loader = createShelfDetailContentLoader({
                library: applicationPorts?.music.library,
                discover: applicationPorts?.music.discover,
                search: applicationPorts?.music.search,
                getContentList: () => shelfContentListRef.current,
              });
              createPodcastRadioDetailOpener({
                getContentList: () => shelfContentListRef.current,
                load: loader,
              })(radioId, title);
            },
          });
        },
        onShelfOpenDetailContent: (payload, contentList) => {
          shelfContentListRef.current = contentList;
          const loader = createShelfDetailContentLoader({
            library: applicationPorts?.music.library,
            discover: applicationPorts?.music.discover,
            search: applicationPorts?.music.search,
            getContentList: () => contentList,
          });
          void loader(payload);
        },
        onShelfOpenContentChange: setShelfDetailOpen,
        desktopLyricsMotionRef,
        performanceSnapshotReaderRef: visualPerformanceSnapshotReaderRef,
      },
      controlPanelProps: {
        preset: visualPreset,
        intensity: visualIntensity,
        settings: {
          ...visualFx,
          shelf: shelfMode,
          shelfCameraMode,
          shelfPresence,
          shelfShowPodcasts,
          shelfMergeCollections,
        },
        onPresetChange: updateVisualPreset,
        onNumberSettingChange: updateVisualNumberSetting,
        onBooleanSettingChange: updateVisualBooleanSetting,
        onStringSettingChange: updateVisualStringSetting,
        onFxPatchChange: updateVisualFxPatch,
        onSettingsTransaction: applyVisualSettingsTransaction,
        initialFabAutoHide: hydratedPreferences?.settingsFabAutoHide,
        onFabAutoHideChange: preferences
          ? persistSettingsFabAutoHide
          : undefined,
        onNotice: showNotice,
        desktopRuntimeSlot: (
          <>
            <FullDesktopControls {...coordinatedFullDesktopManagement} />
            <WallpaperEngineControls
              {...wallpaperEngineManagement}
              fullDesktopMode={fullDesktopManagement.state?.effectiveMode ?? "disabled"}
            />
            <DesktopRuntimeControls {...desktopManagement} />
          </>
        ),
        desktopRuntimeSearchTerms: DESKTOP_RUNTIME_SEARCH_TERMS,
      },
      aiDepthChip,
    },
    home: {
      homeProps: {
        discover: homeDiscover,
        weatherRadio: homeWeatherRadio,
        listenSummary: homeListenSummary,
        dashboard: homeDashboard,
        playlistDetail: homePlaylistDetail,
        active: emptyHomeActive,
        loading: homeDiscoverLoading || homeWeatherRadioLoading,
        discoverError: homeDiscoverError,
        weatherRadioError: homeWeatherRadioError,
        isPlaying,
        positionMs,
        durationMs,
        onSearchFocus: focusSearch,
        onOpenLibrary: openHomeLibrary,
        onOpenConsole: openHomePlayerConsole,
        onSearchQuery: searchQuery,
        onUpload: openLocalFileImport,
        onGuide: openHomeProductGuide,
        onOpenLogin: openLoginModal,
        onPlayDaily: playHomeDaily,
        onPlayPrivate: () => void playHomePrivate(),
        onPlaySong: (index) => void playHomeDiscoverSongs(index),
        onOpenPlaylist: (index) => void openHomeDiscoverPlaylist(index),
        onOpenPodcast: (index) => void openHomeDiscoverPodcast(index),
        onOpenPodcastSearch: openHomePodcastSearch,
        onOpenInsight: openHomeInsight,
        onPlayRecent: playHomeRecent,
        onContinue: continueHomeListening,
        onPlayNextUp: playHomeNextUp,
        onPlayForYou: playHomeForYou,
        onNotice: showNotice,
        onPlayWeatherSong: (index) => void playHomeWeatherSong(index),
        onRetryDiscover: () => void refreshHomeDiscover(),
        onRetryWeatherRadio: () => void refreshHomeWeatherRadio(),
        onClosePlaylistDetail: closeHomePlaylistDetail,
        onPlayPlaylistDetail: playHomePlaylistDetail,
        onPlaylistDetailArtist: searchHomePlaylistDetailArtist,
      },
      searchProps: {
        client: applicationPorts?.music.search ?? null,
        onFocus: focusSearch,
        onUpload: openLocalFileImport,
        onClearCustomCover: clearCustomCoverImage,
        onResultPlay: enterPlaybackSurface,
        onResultNext: insertSearchResultNext,
        onResultLike: (track) => void toggleLikeTrack(track),
        onResultCollect: openCollectPicker,
        onSharedPlaylistImport: importSharedPlaylistFromText,
        onArtistSearch: searchArtistFromResult,
        isResultLiked: isTrackLiked,
        isResultLikeBusy: isTrackLikeBusy,
        hasCustomCover: currentHasCustomCover,
        peek: emptyHomeActive || searchKeyword.trim().length > 0,
        requestedMode: searchModeRequest,
      },
      searchDetailProps: {
        client: applicationPorts?.music.search ?? null,
        onClose: focusSearch,
        onPlayResults: playSearchDetailTracks,
        onAppendQueue: appendSearchResult,
        onResultNext: insertSearchResultNext,
        onResultLike: (track) => void toggleLikeTrack(track),
        onResultCollect: openCollectPicker,
        onArtistSearch: searchArtistFromResult,
        isResultLiked: isTrackLiked,
        isResultLikeBusy: isTrackLikeBusy,
      },
    },
    account: {
      statuses: accountStatusByProvider,
      dropdownOpen: accountDropdownOpen,
      capsuleAutoHide: userCapsuleAutoHide,
      onHome: goHome,
      onAccountClick: handleAccountButtonClick,
      onHideCapsule: toggleUserCapsuleAutoHide,
      onRefreshStatus: (provider) => void refreshProviderStatus(provider),
      onLogout: (provider) => void logoutProvider(provider),
      onOpenSingleProvider: openSingleProviderLogin,
    },
    guide: {
      open: visualGuideOpen,
      onClose: closeVisualGuide,
      onPrepareStep: prepareVisualGuideStep,
    },
    library: {
      panelProps: {
        open: playlistPanelOpen || playlistPanelPinned,
        pinned: playlistPanelPinned,
        tab: playlistPanelTab,
        queue,
        currentTrack,
        mode: playbackMode,
        playlists: shelfPlaylists,
        importedPlaylists,
        podcastCollections: shelfPodcastCollections,
        onTabChange: openPlaylistPanelTab,
        onPinToggle: togglePlaylistPanelPinned,
        onShuffle: shufflePlaylistPanelQueue,
        onCycleMode: cyclePlaylistPanelMode,
        onClearQueue: clearPlaylistPanelQueue,
        onRefresh: () => void refreshShelfPlaylists(),
        onPlayQueueIndex: playQueueAt,
        onQueueArtist: (artist) => searchQuery(artist, "song"),
        onLikeQueueIndex: toggleLikeQueueIndex,
        onCollectQueueIndex: collectQueueIndex,
        onInsertQueueNext: insertMiniQueueNext,
        onRemoveQueueIndex: removeQueueAt,
        onLoadPlaylistDetail: loadPlaylistPanelDetail,
        onPlayTracks: playPlaylistPanelTracks,
        onDeleteImportedPlaylist: deleteImportedPlaylist,
        onPodcastCollectionOpen: (collection) =>
          void openPlaylistPanelPodcastCollection(collection),
      },
      collect: libraryController,
    },
    playback: {
      controlsProps: {
        visible: consoleVisible,
        onReveal: revealConsole,
        onTogglePlay: togglePlayback,
        onPrevious: previousTrack,
        onNext: nextTrack,
        onModeChange: setPlaybackMode,
        onQueue: toggleMiniQueue,
        onLyrics: () =>
          showNotice(
            lyricsPayload ? "歌词已载入舞台层" : "播放歌曲后会自动加载歌词",
          ),
        onLyricSourceChange: (mode) => {
          if (mode === "custom") chooseCustomLyrics();
          else applyOriginalLyrics();
        },
        onOpenCustomLyrics: openCustomLyricModal,
        onCollectCurrent: openCollectPickerForCurrent,
        onToggleLikeCurrent: toggleLikeCurrent,
        onClose: () => {
          setConsole(false);
          setMiniQueue(false);
        },
        onNotice: showNotice,
        onSeek: seekPlayback,
        onVolumeChange: setVolume,
        onToggleMute: toggleMute,
        onQualityChange: setPlaybackQuality,
        onSourceSwitch: (provider) => void switchSource(provider),
        onShelfModeChange: handleShelfModePreferenceChange,
        onShelfCameraModeChange: handleShelfCameraPreferenceChange,
        onShelfPresenceChange: handleShelfPresencePreferenceChange,
        onShelfShowPodcastsChange: handleShelfPodcastsPreferenceChange,
        onShelfMergeCollectionsChange: handleShelfCollectionsPreferenceChange,
        deps: { isHomeControlsLocked: () => homeControlsLocked },
        onPlayQueueIndex: playMiniQueueIndex,
        onRemoveQueueIndex: removeQueueAt,
        onInsertQueueNext: insertMiniQueueNext,
        onMinimize: () => void minimizeWindow(),
        onToggleMaximize: () => void toggleWindowMaximize(),
        onToggleFullscreen: () => void toggleWindowFullscreen(),
        mode: playbackMode,
        isPlaying,
        currentTitle: currentTrack?.title,
        currentArtist: currentTrack?.artists.join(" / "),
        currentCoverUrl: currentTrack?.coverUrl,
        currentLiked,
        currentLikeBusy,
        queue,
        currentTrack,
        miniQueueOpen,
        positionMs,
        durationMs,
        volume,
        muted,
        playbackQuality,
        qualityOptions: trackQualityOptions,
        sourceProviders: sourceSwitchProviders,
        sourceSwitchBusy,
        sourceSwitchDisabled,
        shelfMode,
        shelfCameraMode,
        shelfPresence,
        shelfShowPodcasts,
        shelfMergeCollections,
        lyricSourceMode:
          currentLyricPreference === "custom" ? "custom" : "original",
        hasCustomLyric: Boolean(currentCustomLyricText),
      },
      audioSettings: playbackAudioSettings,
      recoveryState: sidecarRecoveryState,
    },
    playbackCustomization: {
      customization: {
        customLyricModalOpen,
        setCustomLyricModalOpen,
        customLyricText,
        setCustomLyricText,
        customLyricStatus,
        customLyricInputRef,
        currentCustomLyricText,
        saveCustomLyric,
        deleteCustomLyric,
      },
      currentTrack,
    },
    libraryOverlay: { collect: libraryController },
    accountOverlay: {
      statuses: accountStatusByProvider,
      modalOpen: loginModalOpen,
      modalMode: loginModalMode,
      provider: loginProvider,
      manualCookieOpen: qqManualCookieOpen,
      qrByProvider: loginQrByProvider,
      qrStatusByProvider: loginQrStatusByProvider,
      cookieInputRefs: {
        netease: neteaseCookieInputRef,
        qq: qqCookieInputRef,
        soda: sodaCookieInputRef,
      },
      onClose: closeLoginModal,
      onProviderChange: (provider) => {
        setLoginProvider(provider);
        setQqManualCookieOpen(false);
      },
      onManualCookieToggle: () => setQqManualCookieOpen((open) => !open),
      onRefreshQr: (provider) => void refreshProviderLoginQr(provider),
      onRefreshStatus: (provider) => void refreshProviderStatus(provider),
      onImportCookie: (provider) => void importProviderCookie(provider),
      onLogout: (provider) => void logoutProvider(provider),
      onOpenSingleProvider: openSingleProviderLogin,
    },
    playbackNotices: {
      trialBanner,
      dismissTrialBanner,
      toast,
      onOpenLogin: openLoginModal,
    },
    playbackRuntime: {
      runtimeProps: {
        controllerRef,
        audioFrameSourceRef,
        playbackRateRef,
        volume,
        muted,
        onTimeUpdate: handleRuntimeTimeUpdate,
        onDurationChange: handleRuntimeDurationChange,
        onOwnerChange: handleRuntimeOwnerChange,
        onPlay: handleRuntimePlay,
        onPause: handleRuntimePause,
        onEnded: handleRuntimeEnded,
        onError: handleRuntimeError,
        onStalled: handleRuntimeStalled,
        onControllerReady: handlePlaybackControllerReady,
      },
    },
  };

  return (
    <AppRuntimeProvider services={applicationPorts}>
      <AppShell {...shellProps} />
    </AppRuntimeProvider>
  );
}
