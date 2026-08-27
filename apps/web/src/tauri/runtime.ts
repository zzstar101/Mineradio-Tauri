import type {
	WallpaperDialogResult,
	WallpaperLibrarySnapshot,
	WallpaperProjectSummary,
	WallpaperRuntimeState,
} from "../ports/wallpaper-engine-runtime-port";

export interface RuntimeConfig {
	mediaProxyBase: string;
	appDataDir: string;
	appVersion: string;
	schemaVersion: string;
	updaterPublicKeyConfigured: boolean;
}



export interface WindowDisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowState {
	isMaximized: boolean;
	isNativeFullScreen: boolean;
	isHtmlFullScreen: boolean;
	isWindowFullScreen: boolean;
	isFullScreen: boolean;
	isMinimized: boolean;
	isVisible: boolean;
	isFocused: boolean;
	isPrimaryDisplay: boolean;
	hasDisplayOnLeft: boolean;
	hasDisplayOnRight: boolean;
	displayBounds: WindowDisplayBounds | null;
}

export type CloseBehavior = "exit" | "tray";
export type LifecyclePhase = "running" | "hiddenToTray" | "exiting" | "cleaned";
export type TrayRuntimePhase = "unavailable" | "ready" | "failed";

export interface WindowRuntimeState {
	lifecycle: {
		closeBehavior: CloseBehavior;
		phase: LifecyclePhase;
		cleanupClaimed: boolean;
	};
	trayPhase: TrayRuntimePhase;
	debounceGeneration: number;
	debounceWorkerRunning: boolean;
}

export type CacheCategory = "audio" | "images" | "lyrics" | "beatmaps" | "temp";

export interface CacheCategoryUsage {
	category: CacheCategory;
	path: string;
	totalBytes: number;
	fileCount: number;
	directoryCount: number;
	errorCount: number;
	skippedLinkCount: number;
	truncated: boolean;
}

export interface CacheSnapshot {
	configuredRoot: string;
	activeRoot: string;
	fallbackUsed: boolean;
	fallbackReason: string | null;
	restartRequired: boolean;
	categories: CacheCategoryUsage[];
	totalBytes: number;
	fileCount: number;
	directoryCount: number;
	errorCount: number;
	skippedLinkCount: number;
	truncated: boolean;
}

export interface CacheRootDecision {
	desiredRoot: string | null;
	effectiveRoot: string;
	fallbackUsed: boolean;
	fallbackReason: string | null;
	restartRequired: boolean;
}

export interface CacheClearResult {
	category: CacheCategory;
	path: string;
	removedBytes: number;
	removedFiles: number;
	removedDirectories: number;
	removedLinks: number;
}

export type DiagnosticHealth = "healthy" | "degraded" | "unavailable";
export type DiagnosticProbeStatus = "healthy" | "unavailable" | "failed";

export interface DiagnosticProbe {
	kind: string;
	status: DiagnosticProbeStatus;
	capturedAtMs: number;
	value: JsonValue | null;
	message: string | null;
	error: { source: string; code: string; message: string; occurredAtMs: number } | null;
}

export interface DesktopDiagnosticsSnapshot {
	schemaVersion: number;
	capturedAtMs: number;
	health: DiagnosticHealth;
	probes: DiagnosticProbe[];
	recentErrors: Array<{ source: string; code: string; message: string; occurredAtMs: number }>;
}

export interface ResourceGovernanceSnapshot {
	minBackgroundDelayMs: number;
	trimCooldownMs: number;
	trimInFlight: boolean;
	lastAttemptMs: number | null;
	systemPurgePolicy: "disabled" | "unsupported";
}

export type Unlisten = () => void;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ExportJsonFileResult {
	cancelled: boolean;
	path: string | null;
}

export interface ImportJsonFileResult {
	cancelled: boolean;
	path: string | null;
	data: JsonValue | null;
}

export interface GlobalHotkeyBinding {
	action: string;
	accelerator: string;
}

export interface GlobalHotkeyConflict {
	sourceName: string;
	sourceIcon: string;
	reason: string;
}

export interface GlobalHotkeyRegistrationResult {
	action: string;
	accelerator: string;
	ok: boolean;
	conflict?: GlobalHotkeyConflict;
}

export interface ConfigureGlobalHotkeysResult {
	ok: boolean;
	results: GlobalHotkeyRegistrationResult[];
}

export interface GlobalHotkeyEventPayload {
	action: string;
}

export type ProviderLoginId = "netease" | "qq";

export interface ProviderLoginWindowResult {
	provider: ProviderLoginId;
	stored: boolean;
	reused: boolean;
	partial: boolean;
}

export type FullDesktopMode = "disabled" | "passive" | "interactive";

export type FullDesktopRuntimePhase =
	| "disabled"
	| "attaching"
	| "passive"
	| "interactive"
	| "recovering"
	| "detaching"
	| "recoveryRequired";

export interface FullDesktopRuntimeState {
	phase: FullDesktopRuntimePhase;
	requestedMode: FullDesktopMode;
	effectiveMode: FullDesktopMode;
	iconsVisible: boolean;
	interactionLocked: boolean;
	recoveryRequired: boolean;
	autoResumeSuppressed: boolean;
	explorerGeneration: number;
	lastError?: string;
}

interface RawRuntimeConfig {
	media_proxy_base?: string;
	app_data_dir: string;
	app_version: string;
	schema_version: string;
	updater_public_key_configured: boolean;
}



interface RawWindowDisplayBounds {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

interface RawWindowState {
	isMaximized?: boolean;
	isNativeFullScreen?: boolean;
	isHtmlFullScreen?: boolean;
	isWindowFullScreen?: boolean;
	isFullScreen?: boolean;
	isMinimized?: boolean;
	isVisible?: boolean;
	isFocused?: boolean;
	isPrimaryDisplay?: boolean;
	hasDisplayOnLeft?: boolean;
	hasDisplayOnRight?: boolean;
	displayBounds?: RawWindowDisplayBounds | null;
}

function normalizeWindowState(raw: RawWindowState | null | undefined): WindowState {
	if (!raw) return placeholderWindowState();
	const displayBounds = raw.displayBounds
		&& typeof raw.displayBounds.x === "number"
		&& typeof raw.displayBounds.y === "number"
		&& typeof raw.displayBounds.width === "number"
		&& typeof raw.displayBounds.height === "number"
		? {
			x: raw.displayBounds.x,
			y: raw.displayBounds.y,
			width: raw.displayBounds.width,
			height: raw.displayBounds.height,
		}
		: null;
	return {
		isMaximized: !!raw.isMaximized,
		isNativeFullScreen: !!raw.isNativeFullScreen,
		isHtmlFullScreen: !!raw.isHtmlFullScreen,
		isWindowFullScreen: !!raw.isWindowFullScreen,
		isFullScreen: !!raw.isFullScreen,
		isMinimized: !!raw.isMinimized,
		isVisible: !!raw.isVisible,
		isFocused: !!raw.isFocused,
		isPrimaryDisplay: raw.isPrimaryDisplay ?? true,
		hasDisplayOnLeft: !!raw.hasDisplayOnLeft,
		hasDisplayOnRight: !!raw.hasDisplayOnRight,
		displayBounds,
	};
}

export function isTauriRuntime(): boolean {
	if (typeof window === "undefined") return false;
	return (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

export async function invokeTauriCommand<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
	if (!isTauriRuntime()) {
		return null;
	}
	const mod = await import("@tauri-apps/api/core");
	const invoke = mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<T>;
	return invoke(cmd, args);
}

export async function listenTauriEvent<T = unknown>(
	eventName: string,
	handler: (payload: T) => void
): Promise<Unlisten> {
	if (!isTauriRuntime()) {
		return () => {};
	}
	const mod = await import("@tauri-apps/api/event");
	const listen = mod.listen as (
		eventName: string,
		handler: (event: { payload: T }) => void
	) => Promise<Unlisten>;
	return listen(eventName, (event) => handler(event.payload));
}

function placeholderRuntimeConfig(): RuntimeConfig {
	return {
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "",
		appVersion: "0.0.0-dev",
		schemaVersion: "0.1.0",
		updaterPublicKeyConfigured: false,
	};
}



function placeholderWindowState(): WindowState {
	return {
		isMaximized: false,
		isNativeFullScreen: false,
		isHtmlFullScreen: false,
		isWindowFullScreen: false,
		isFullScreen: false,
		isMinimized: false,
		isVisible: false,
		isFocused: false,
		isPrimaryDisplay: true,
		hasDisplayOnLeft: false,
		hasDisplayOnRight: false,
		displayBounds: null,
	};
}

function cancelledExportJsonResult(): ExportJsonFileResult {
	return {
		cancelled: true,
		path: null,
	};
}

function cancelledImportJsonResult(): ImportJsonFileResult {
	return {
		cancelled: true,
		path: null,
		data: null,
	};
}

function disabledGlobalHotkeysResult(): ConfigureGlobalHotkeysResult {
	return {
		ok: true,
		results: [],
	};
}

function providerLoginPlaceholder(provider: ProviderLoginId): ProviderLoginWindowResult {
	return {
		provider,
		stored: false,
		reused: false,
		partial: false,
	};
}

function fullDesktopRuntimePlaceholder(): FullDesktopRuntimeState {
	return {
		phase: "disabled",
		requestedMode: "disabled",
		effectiveMode: "disabled",
		iconsVisible: true,
		interactionLocked: false,
		recoveryRequired: false,
		autoResumeSuppressed: false,
		explorerGeneration: 0,
	};
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
	if (!isTauriRuntime()) {
		return placeholderRuntimeConfig();
	}
	try {
		const raw = await invokeTauriCommand<RawRuntimeConfig>("get_runtime_config");
		if (!raw) {
			return placeholderRuntimeConfig();
		}
		return {
			mediaProxyBase: raw.media_proxy_base ?? "mineradio-tauri://localhost",
			appDataDir: raw.app_data_dir,
			appVersion: raw.app_version,
			schemaVersion: raw.schema_version,
			updaterPublicKeyConfigured: raw.updater_public_key_configured,
		};
	} catch {
		return placeholderRuntimeConfig();
	}
}

export async function getWindowState(): Promise<WindowState> {
	if (!isTauriRuntime()) {
		return placeholderWindowState();
	}
	try {
		const raw = await invokeTauriCommand<RawWindowState>("get_window_state");
		return normalizeWindowState(raw);
	} catch {
		return placeholderWindowState();
	}
}

export async function listenWindowState(handler: (state: WindowState) => void): Promise<Unlisten> {
	return listenTauriEvent<RawWindowState>("desktop-window-state", (payload) => {
		handler(normalizeWindowState(payload));
	});
}

export async function exportJsonFile(fileName: string, data: JsonValue): Promise<ExportJsonFileResult> {
	if (!isTauriRuntime()) {
		return cancelledExportJsonResult();
	}
	const result = await invokeTauriCommand<ExportJsonFileResult>("export_json_file", { fileName, data });
	return result ?? cancelledExportJsonResult();
}

export async function importJsonFile(): Promise<ImportJsonFileResult> {
	if (!isTauriRuntime()) {
		return cancelledImportJsonResult();
	}
	const result = await invokeTauriCommand<ImportJsonFileResult>("import_json_file");
	return result ?? cancelledImportJsonResult();
}

export async function minimizeWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("window_minimize");
}

export async function toggleWindowMaximize(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("window_toggle_maximize");
}

export async function toggleWindowFullscreen(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("window_toggle_fullscreen");
}

export async function closeWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("window_close");
}

export async function getWindowRuntimeState(): Promise<WindowRuntimeState | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<WindowRuntimeState>("get_window_runtime_state");
}

export async function setCloseBehavior(behavior: CloseBehavior): Promise<WindowRuntimeState | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<WindowRuntimeState>("set_close_behavior", { behavior });
}

export async function showWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("window_show");
}

export async function exitApplication(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("application_exit");
}

export async function getCacheSnapshot(): Promise<CacheSnapshot | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<CacheSnapshot>("get_cache_snapshot");
}

export async function chooseCacheDirectory(): Promise<string | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<string | null>("choose_cache_directory");
}

export async function setCacheRoot(path: string | null): Promise<CacheRootDecision | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<CacheRootDecision>("set_cache_root", { path });
}

export async function clearCacheCategory(category: CacheCategory): Promise<CacheClearResult | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<CacheClearResult>("clear_cache_category", { category });
}

export async function getDesktopDiagnostics(): Promise<DesktopDiagnosticsSnapshot | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<DesktopDiagnosticsSnapshot>("get_desktop_diagnostics");
}

export async function getResourceGovernance(): Promise<ResourceGovernanceSnapshot | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<ResourceGovernanceSnapshot>("get_resource_governance");
}

export async function trimApplicationWorkingSet(force = false): Promise<JsonValue | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<JsonValue>("trim_application_working_set", { force });
}

export async function purgeSystemMemory(): Promise<JsonValue | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<JsonValue>("purge_system_memory");
}

export async function openExternalUrl(url: string): Promise<boolean> {
	if (!isTauriRuntime()) return false;
	try {
		await invokeTauriCommand("open_external", { url });
		return true;
	} catch {
		return false;
	}
}

export async function showDesktopLyricsWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("desktop_lyrics_show_window");
}

export async function closeDesktopLyricsWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("desktop_lyrics_close_window");
}

export async function updateDesktopLyricsPayload(payload: JsonValue): Promise<void> {
	if (!isTauriRuntime()) return;
	await invokeTauriCommand("desktop_lyrics_update_payload", { payload });
}

export async function configureGlobalHotkeys(bindings: GlobalHotkeyBinding[]): Promise<ConfigureGlobalHotkeysResult> {
	if (!isTauriRuntime()) {
		return disabledGlobalHotkeysResult();
	}
	const result = await invokeTauriCommand<ConfigureGlobalHotkeysResult>("configure_global_hotkeys", { bindings });
	return result ?? disabledGlobalHotkeysResult();
}

export async function listenGlobalHotkey(handler: (payload: GlobalHotkeyEventPayload) => void): Promise<Unlisten> {
	return listenTauriEvent<GlobalHotkeyEventPayload>("mineradio-global-hotkey", handler);
}

export async function listenDesktopLyricsLockChanged(handler: (clickThrough: boolean) => void): Promise<Unlisten> {
	return listenTauriEvent<boolean>("desktop-lyrics-lock-changed", (payload) => {
		handler(payload === true);
	});
}

export async function openProviderLoginWindow(provider: ProviderLoginId): Promise<ProviderLoginWindowResult> {
	if (!isTauriRuntime()) {
		return providerLoginPlaceholder(provider);
	}
	const command = provider === "qq" ? "login_qq_complete" : "login_netease_complete";
	const result = await invokeTauriCommand<ProviderLoginWindowResult>(command);
	return result ?? providerLoginPlaceholder(provider);
}

export async function getFullDesktopRuntimeState(): Promise<FullDesktopRuntimeState> {
	if (!isTauriRuntime()) return fullDesktopRuntimePlaceholder();
	const result = await invokeTauriCommand<FullDesktopRuntimeState>("get_full_desktop_runtime_state");
	return result ?? fullDesktopRuntimePlaceholder();
}

export async function setFullDesktopMode(mode: FullDesktopMode): Promise<FullDesktopRuntimeState> {
	if (!isTauriRuntime()) return fullDesktopRuntimePlaceholder();
	const result = await invokeTauriCommand<FullDesktopRuntimeState>("set_full_desktop_mode", { mode });
	return result ?? fullDesktopRuntimePlaceholder();
}

export async function setDesktopIconsVisible(visible: boolean): Promise<FullDesktopRuntimeState> {
	if (!isTauriRuntime()) return fullDesktopRuntimePlaceholder();
	const result = await invokeTauriCommand<FullDesktopRuntimeState>("set_desktop_icons_visible", { visible });
	return result ?? fullDesktopRuntimePlaceholder();
}

export async function setFullDesktopInteractionLocked(locked: boolean): Promise<FullDesktopRuntimeState> {
	if (!isTauriRuntime()) return fullDesktopRuntimePlaceholder();
	const result = await invokeTauriCommand<FullDesktopRuntimeState>("set_full_desktop_interaction_locked", { locked });
	return result ?? fullDesktopRuntimePlaceholder();
}

export async function recoverFullDesktopRuntime(): Promise<FullDesktopRuntimeState> {
	if (!isTauriRuntime()) return fullDesktopRuntimePlaceholder();
	const result = await invokeTauriCommand<FullDesktopRuntimeState>("recover_full_desktop_runtime");
	return result ?? fullDesktopRuntimePlaceholder();
}

function wallpaperLibraryPlaceholder(): WallpaperLibrarySnapshot {
	return { projects: [], roots: [], updatedAt: 0 };
}

function wallpaperRuntimePlaceholder(): WallpaperRuntimeState {
	return {
		available: false,
		phase: "unavailable",
		pending: false,
		active: false,
		projectId: "",
		sessionId: "",
		sourceId: "",
		captureMode: "none",
		sourceWindowAligned: false,
		dwmSurfaceReady: false,
		glassSamplerReady: false,
		audioMuted: false,
		cleanupRequired: false,
		fullDesktopMode: "disabled",
	};
}

function wallpaperDialogCancelled(): WallpaperDialogResult {
	return { ok: true, canceled: true };
}

export async function listWallpaperEngineProjects(
	request: { forceRefresh?: boolean } = {},
): Promise<WallpaperLibrarySnapshot> {
	if (!isTauriRuntime()) return wallpaperLibraryPlaceholder();
	return (await invokeTauriCommand<WallpaperLibrarySnapshot>(
		"list_wallpaper_engine_projects",
		{ request },
	)) ?? wallpaperLibraryPlaceholder();
}

export async function getWallpaperEngineProjectDetails(
	id: string,
): Promise<WallpaperProjectSummary | null> {
	if (!isTauriRuntime()) return null;
	return invokeTauriCommand<WallpaperProjectSummary | null>("get_wallpaper_engine_project_details", { id });
}

export async function chooseWallpaperEngineDirectory(): Promise<WallpaperDialogResult> {
	if (!isTauriRuntime()) return wallpaperDialogCancelled();
	return (await invokeTauriCommand<WallpaperDialogResult>("choose_wallpaper_engine_directory"))
		?? wallpaperDialogCancelled();
}

export async function chooseWallpaperEngineProjectFile(): Promise<WallpaperDialogResult> {
	if (!isTauriRuntime()) return wallpaperDialogCancelled();
	return (await invokeTauriCommand<WallpaperDialogResult>("choose_wallpaper_engine_project_file"))
		?? wallpaperDialogCancelled();
}

export async function removeWallpaperEngineDirectory(
	rootId: string,
): Promise<WallpaperLibrarySnapshot> {
	if (!isTauriRuntime()) return wallpaperLibraryPlaceholder();
	return (await invokeTauriCommand<WallpaperLibrarySnapshot>(
		"remove_wallpaper_engine_directory",
		{ rootId },
	)) ?? wallpaperLibraryPlaceholder();
}

export async function getWallpaperEngineRuntimeStatus(
	request: { refresh?: boolean } = {},
): Promise<WallpaperRuntimeState> {
	if (!isTauriRuntime()) return wallpaperRuntimePlaceholder();
	return (await invokeTauriCommand<WallpaperRuntimeState>(
		"get_wallpaper_engine_runtime_status",
		{ request },
	)) ?? wallpaperRuntimePlaceholder();
}

export async function startWallpaperEngineScene(
	request: { projectId: string; fps?: number },
): Promise<WallpaperRuntimeState> {
	if (!isTauriRuntime()) return wallpaperRuntimePlaceholder();
	return (await invokeTauriCommand<WallpaperRuntimeState>(
		"start_wallpaper_engine_scene",
		{ request },
	)) ?? wallpaperRuntimePlaceholder();
}

export async function stopWallpaperEngineScene(
	request: { sessionId?: string } = {},
): Promise<WallpaperRuntimeState> {
	if (!isTauriRuntime()) return wallpaperRuntimePlaceholder();
	return (await invokeTauriCommand<WallpaperRuntimeState>(
		"stop_wallpaper_engine_scene",
		{ request },
	)) ?? wallpaperRuntimePlaceholder();
}

export async function recoverWallpaperEngineRuntime(): Promise<WallpaperRuntimeState> {
	if (!isTauriRuntime()) return wallpaperRuntimePlaceholder();
	return (await invokeTauriCommand<WallpaperRuntimeState>("recover_wallpaper_engine_runtime"))
		?? wallpaperRuntimePlaceholder();
}
