export const FROZEN_DESKTOP_COMMANDS = [
	"get_runtime_config",
	"get_database_status",
	"configure_global_hotkeys",
	"window_minimize",
	"window_toggle_maximize",
	"window_toggle_fullscreen",
	"window_close",
	"get_window_state",
	"open_external",
	"export_json_file",
	"import_json_file",
	"desktop_lyrics_show_window",
	"desktop_lyrics_close_window",
	"desktop_lyrics_set_click_through",
	"desktop_lyrics_move_by",
	"desktop_lyrics_set_hot_bounds",
	"desktop_lyrics_update_payload",
	"desktop_lyrics_overlay_ready",
	"login_netease_show_window",
	"login_qq_show_window",
	"login_netease_complete",
	"login_qq_complete",
	"login_netease_close_window",
	"login_qq_close_window",
];

export const M5_ADDITIVE_DESKTOP_COMMANDS = [
	"get_desktop_diagnostics",
	"get_resource_governance",
	"trim_application_working_set",
	"purge_system_memory",
	"get_cache_snapshot",
	"choose_cache_directory",
	"set_cache_root",
	"clear_cache_category",
	"window_show",
	"application_exit",
	"get_window_runtime_state",
	"set_close_behavior",
];

// M6 仅可追加这五个完整桌面 transport command，不能修改 M5 的既有 command 契约。
export const M6_ADDITIVE_DESKTOP_COMMANDS = Object.freeze([
	"get_full_desktop_runtime_state",
	"set_full_desktop_mode",
	"set_desktop_icons_visible",
	"set_full_desktop_interaction_locked",
	"recover_full_desktop_runtime",
]);

// M7 仅追加 Wallpaper Engine 的窄 transport command；音乐 API 与 Sidecar 继续冻结。
export const M7_ADDITIVE_DESKTOP_COMMANDS = Object.freeze([
	"list_wallpaper_engine_projects",
	"get_wallpaper_engine_project_details",
	"choose_wallpaper_engine_directory",
	"choose_wallpaper_engine_project_file",
	"remove_wallpaper_engine_directory",
	"get_wallpaper_engine_runtime_status",
	"start_wallpaper_engine_scene",
	"stop_wallpaper_engine_scene",
	"recover_wallpaper_engine_runtime",
]);

// M8 仅追加 typed preference snapshot、事务与 legacy migration 三条命令。
export const M8_ADDITIVE_DESKTOP_COMMANDS = Object.freeze([
	"get_preferences_snapshot",
	"commit_preferences_transaction",
	"migrate_legacy_preferences",
]);

// D2 用唯一 Rust Runtime Port 原子替换旧 plugin updater 三命令。
export const D2_UPDATE_RUNTIME_COMMANDS = Object.freeze([
	"get_update_runtime_snapshot",
	"dispatch_update_runtime_intent",
	"updater_web_quiescence_acknowledge",
	"updater_web_quiescence_reconcile",
]);

export const D2_UPDATE_RUNTIME_INTERFACES = Object.freeze({
	get_update_runtime_snapshot: "fn get_update_runtime_snapshot(caller: tauri::WebviewWindow, runtime: tauri::State<'_, ApplicationUpdateRuntime>) -> UpdateSnapshot",
	dispatch_update_runtime_intent: "fn dispatch_update_runtime_intent(caller: tauri::WebviewWindow, runtime: tauri::State<'_, ApplicationUpdateRuntime>, request: UpdateDispatchRequest) -> UpdateReceipt",
	updater_web_quiescence_acknowledge: "fn updater_web_quiescence_acknowledge(caller: tauri::WebviewWindow, runtime: tauri::State<'_, ApplicationUpdateRuntime>, acknowledgement: UpdateWebQuiescenceAcknowledgement) -> bool",
	updater_web_quiescence_reconcile: "fn updater_web_quiescence_reconcile(caller: tauri::WebviewWindow, runtime: tauri::State<'_, ApplicationUpdateRuntime>) -> ()",
});

export const M8_DESKTOP_COMMAND_INTERFACES = Object.freeze({
	get_preferences_snapshot: "fn get_preferences_snapshot(state: tauri::State<'_, AppState>) -> Result<db::PreferencesSnapshot, String>",
	commit_preferences_transaction: "fn commit_preferences_transaction(state: tauri::State<'_, AppState>, request: db::PreferenceTransactionRequest) -> Result<db::PreferencesSnapshot, String>",
	migrate_legacy_preferences: "fn migrate_legacy_preferences(state: tauri::State<'_, AppState>, request: db::LegacyPreferencesMigrationRequest) -> Result<db::PreferencesSnapshot, String>",
});

export const DESKTOP_COMMAND_REGISTRATION_ORDER = Object.freeze([
	"get_runtime_config",
	"get_database_status",
	"get_preferences_snapshot",
	"commit_preferences_transaction",
	"migrate_legacy_preferences",
	"get_desktop_diagnostics",
	"get_resource_governance",
	"trim_application_working_set",
	"purge_system_memory",
	"get_cache_snapshot",
	"choose_cache_directory",
	"set_cache_root",
	"clear_cache_category",
	"configure_global_hotkeys",
	"get_update_runtime_snapshot",
	"dispatch_update_runtime_intent",
	"updater_web_quiescence_acknowledge",
	"updater_web_quiescence_reconcile",
	"window_minimize",
	"window_toggle_maximize",
	"window_toggle_fullscreen",
	"window_close",
	"window_show",
	"application_exit",
	"get_window_state",
	"get_window_runtime_state",
	"set_close_behavior",
	"get_full_desktop_runtime_state",
	"set_full_desktop_mode",
	"set_desktop_icons_visible",
	"set_full_desktop_interaction_locked",
	"recover_full_desktop_runtime",
	"list_wallpaper_engine_projects",
	"get_wallpaper_engine_project_details",
	"choose_wallpaper_engine_directory",
	"choose_wallpaper_engine_project_file",
	"remove_wallpaper_engine_directory",
	"get_wallpaper_engine_runtime_status",
	"start_wallpaper_engine_scene",
	"stop_wallpaper_engine_scene",
	"recover_wallpaper_engine_runtime",
	"open_external",
	"export_json_file",
	"import_json_file",
	"desktop_lyrics_show_window",
	"desktop_lyrics_close_window",
	"desktop_lyrics_set_click_through",
	"desktop_lyrics_move_by",
	"desktop_lyrics_set_hot_bounds",
	"desktop_lyrics_update_payload",
	"desktop_lyrics_overlay_ready",
	"login_netease_show_window",
	"login_qq_show_window",
	"login_netease_complete",
	"login_qq_complete",
	"login_netease_close_window",
	"login_qq_close_window",
]);

export const FROZEN_DESKTOP_COMMAND_INTERFACES = Object.freeze({
	get_runtime_config: "fn get_runtime_config(state: tauri::State<'_, AppState>) -> crate::RuntimeConfig",
	get_database_status: "fn get_database_status(state: tauri::State<'_, AppState>) -> Result<db::DatabaseStatus, String>",
	configure_global_hotkeys: "fn configure_global_hotkeys(app: tauri::AppHandle, bindings: Vec<GlobalHotkeyBinding>) -> ConfigureGlobalHotkeysResult",
	window_minimize: "fn window_minimize(app: tauri::AppHandle) -> Result<(), String>",
	window_toggle_maximize: "fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String>",
	window_toggle_fullscreen: "fn window_toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String>",
	window_close: "fn window_close(app: tauri::AppHandle) -> Result<(), String>",
	get_window_state: "fn get_window_state(app: tauri::AppHandle) -> Result<WindowStateSnapshot, String>",
	open_external: "fn open_external(url: String) -> Result<(), String>",
	export_json_file: "async fn export_json_file(app: tauri::AppHandle, file_name: String, data: serde_json::Value) -> Result<ExportJsonFileResult, String>",
	import_json_file: "async fn import_json_file(app: tauri::AppHandle) -> Result<ImportJsonFileResult, String>",
	desktop_lyrics_show_window: "fn desktop_lyrics_show_window(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String>",
	desktop_lyrics_close_window: "fn desktop_lyrics_close_window(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String>",
	desktop_lyrics_set_click_through: "fn desktop_lyrics_set_click_through(app: tauri::AppHandle, state: tauri::State<'_, AppState>, click_through: bool) -> Result<(), String>",
	desktop_lyrics_move_by: "fn desktop_lyrics_move_by(app: tauri::AppHandle, state: tauri::State<'_, AppState>, dx: f64, dy: f64) -> Result<(), String>",
	desktop_lyrics_set_hot_bounds: "fn desktop_lyrics_set_hot_bounds(_app: tauri::AppHandle, state: tauri::State<'_, AppState>, bounds: DesktopLyricsHotBounds) -> Result<(), String>",
	desktop_lyrics_update_payload: "fn desktop_lyrics_update_payload(app: tauri::AppHandle, state: tauri::State<'_, AppState>, payload: serde_json::Value) -> Result<(), String>",
	desktop_lyrics_overlay_ready: "fn desktop_lyrics_overlay_ready(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String>",
	login_netease_show_window: "fn login_netease_show_window(app: tauri::AppHandle) -> Result<(), String>",
	login_qq_show_window: "fn login_qq_show_window(app: tauri::AppHandle) -> Result<(), String>",
	login_netease_complete: "async fn login_netease_complete(app: tauri::AppHandle) -> Result<LoginSessionImportResult, String>",
	login_qq_complete: "async fn login_qq_complete(app: tauri::AppHandle) -> Result<LoginSessionImportResult, String>",
	login_netease_close_window: "fn login_netease_close_window(app: tauri::AppHandle) -> Result<(), String>",
	login_qq_close_window: "fn login_qq_close_window(app: tauri::AppHandle) -> Result<(), String>",
});

export const FROZEN_DESKTOP_SERIALIZATION_CONTRACTS = Object.freeze({
	RuntimeConfig: {
		kind: "struct",
		serde: [],
		fields: [
			"app_data_dir: String",
			"app_version: String",
			"schema_version: String",
			"media_proxy_base: String",
			"updater_public_key_configured: bool",
		],
	},
	DatabaseStatus: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["path: String", "migration_version: i64", "startup_count: i64"],
	},
	GlobalHotkeyBinding: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["action: String", "accelerator: String"],
	},
	GlobalHotkeyConflict: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["source_name: String", "source_icon: String", "reason: String"],
	},
	GlobalHotkeyRegistrationResult: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: [
			"action: String",
			"accelerator: String",
			"ok: bool",
			'#[serde(skip_serializing_if = "Option::is_none")] conflict: Option<GlobalHotkeyConflict>',
		],
	},
	ConfigureGlobalHotkeysResult: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["ok: bool", "results: Vec<GlobalHotkeyRegistrationResult>"],
	},
	GlobalHotkeyEventPayload: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["action: String"],
	},
	WindowDisplayBounds: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["x: i32", "y: i32", "width: u32", "height: u32"],
	},
	WindowStateSnapshot: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: [
			"is_maximized: bool",
			"is_native_full_screen: bool",
			"is_html_full_screen: bool",
			"is_window_full_screen: bool",
			"is_full_screen: bool",
			"is_minimized: bool",
			"is_visible: bool",
			"is_focused: bool",
			"is_primary_display: bool",
			"has_display_on_left: bool",
			"has_display_on_right: bool",
			"display_bounds: Option<WindowDisplayBounds>",
		],
	},
	ExportJsonFileResult: {
		kind: "struct",
		serde: [],
		fields: ["cancelled: bool", "path: Option<String>"],
	},
	ImportJsonFileResult: {
		kind: "struct",
		serde: [],
		fields: ["cancelled: bool", "path: Option<String>", "data: Option<serde_json::Value>"],
	},
	DesktopLyricsHotBounds: {
		kind: "struct",
		serde: [],
		fields: ["left: i32", "top: i32", "right: i32", "bottom: i32"],
	},
	LoginSessionImportResult: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: ["provider: LoginProvider", "stored: bool", "reused: bool", "partial: bool"],
	},
	LoginProvider: {
		kind: "enum",
		serde: ['rename_all = "lowercase"'],
		variants: ["Netease", "Qq"],
	},
});

export const M6_DESKTOP_COMMAND_INTERFACES = Object.freeze({
	get_full_desktop_runtime_state: "fn get_full_desktop_runtime_state(state: tauri::State<'_, AppState>) -> Result<FullDesktopRuntimeState, String>",
	set_full_desktop_mode: "fn set_full_desktop_mode(app: tauri::AppHandle, state: tauri::State<'_, AppState>, mode: FullDesktopMode) -> Result<FullDesktopRuntimeState, String>",
	set_desktop_icons_visible: "fn set_desktop_icons_visible(state: tauri::State<'_, AppState>, visible: bool) -> Result<FullDesktopRuntimeState, String>",
	set_full_desktop_interaction_locked: "fn set_full_desktop_interaction_locked(state: tauri::State<'_, AppState>, locked: bool) -> Result<FullDesktopRuntimeState, String>",
	recover_full_desktop_runtime: "fn recover_full_desktop_runtime(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<FullDesktopRuntimeState, String>",
});

export const M6_DESKTOP_SERIALIZATION_CONTRACTS = Object.freeze({
	FullDesktopMode: {
		kind: "enum",
		serde: ['rename_all = "camelCase"'],
		variants: ["Disabled", "Passive", "Interactive"],
	},
	FullDesktopPhase: {
		kind: "enum",
		serde: ['rename_all = "camelCase"'],
		variants: ["Disabled", "Attaching", "Passive", "Interactive", "Recovering", "Detaching", "RecoveryRequired"],
	},
	FullDesktopRuntimeState: {
		kind: "struct",
		serde: ['rename_all = "camelCase"'],
		fields: [
			"phase: FullDesktopPhase",
			"requested_mode: FullDesktopMode",
			"effective_mode: FullDesktopMode",
			"icons_visible: bool",
			"interaction_locked: bool",
			"recovery_required: bool",
			"auto_resume_suppressed: bool",
			"explorer_generation: u64",
			'#[serde(skip_serializing_if = "Option::is_none")] last_error: Option<String>',
		],
	},
});

export const M7_DESKTOP_COMMAND_INTERFACES = Object.freeze({
	list_wallpaper_engine_projects: "async fn list_wallpaper_engine_projects(state: tauri::State<'_, AppState>, request: Option<ListWallpaperProjectsRequest>) -> Result<WallpaperLibraryView, String>",
	get_wallpaper_engine_project_details: "fn get_wallpaper_engine_project_details(state: tauri::State<'_, AppState>, id: String) -> Result<Option<WallpaperProjectView>, String>",
	choose_wallpaper_engine_directory: "async fn choose_wallpaper_engine_directory(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<WallpaperDialogResult, String>",
	choose_wallpaper_engine_project_file: "async fn choose_wallpaper_engine_project_file(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<WallpaperDialogResult, String>",
	remove_wallpaper_engine_directory: "async fn remove_wallpaper_engine_directory(state: tauri::State<'_, AppState>, root_id: String) -> Result<WallpaperLibraryView, String>",
	get_wallpaper_engine_runtime_status: "async fn get_wallpaper_engine_runtime_status(state: tauri::State<'_, AppState>, request: Option<WallpaperRuntimeStatusRequest>) -> Result<WallpaperRuntimeState, String>",
	start_wallpaper_engine_scene: "async fn start_wallpaper_engine_scene(app: tauri::AppHandle, state: tauri::State<'_, AppState>, request: StartWallpaperSceneCommandRequest) -> Result<WallpaperRuntimeState, String>",
	stop_wallpaper_engine_scene: "async fn stop_wallpaper_engine_scene(state: tauri::State<'_, AppState>, request: Option<StopWallpaperSceneCommandRequest>) -> Result<WallpaperRuntimeState, String>",
	recover_wallpaper_engine_runtime: "async fn recover_wallpaper_engine_runtime(state: tauri::State<'_, AppState>) -> Result<WallpaperRuntimeState, String>",
});

export const M7_DESKTOP_SERIALIZATION_CONTRACTS = Object.freeze({
	ListWallpaperProjectsRequest: {
		kind: "struct", serde: ['rename_all = "camelCase"'],
		fields: ['#[serde(default)] force_refresh: bool'],
	},
	WallpaperRuntimeStatusRequest: {
		kind: "struct", serde: ['rename_all = "camelCase"'],
		fields: ['#[serde(default)] refresh: bool'],
	},
	StartWallpaperSceneCommandRequest: {
		kind: "struct", serde: ['rename_all = "camelCase"'],
		fields: ["project_id: String", "fps: Option<u32>"],
	},
	StopWallpaperSceneCommandRequest: {
		kind: "struct", serde: ['rename_all = "camelCase"'],
		fields: ["session_id: Option<String>"],
	},
	WallpaperRuntimePhase: {
		kind: "enum", serde: ['rename_all = "camelCase"'],
		variants: ["Idle", "Starting", "Active", "Stopping", "CleanupRequired", "Unavailable"],
	},
	WallpaperCaptureMode: {
		kind: "enum", serde: ['rename_all = "camelCase"'],
		variants: ["None", "DwmThumbnail"],
	},
	WallpaperRuntimeState: {
		kind: "struct", serde: ['rename_all = "camelCase"'],
		fields: [
			"available: bool", "phase: WallpaperRuntimePhase", "pending: bool", "active: bool",
			"project_id: String", "session_id: String", "source_id: String",
			"capture_mode: WallpaperCaptureMode", "source_window_aligned: bool",
			"dwm_surface_ready: bool", "glass_sampler_ready: bool", "audio_muted: bool",
			"cleanup_required: bool", "full_desktop_mode: WallpaperFullDesktopMode",
			"generation: u64", "last_error: Option<String>",
		],
	},
});

export const FROZEN_DESKTOP_ERROR_STRINGS = Object.freeze([
	"DESKTOP_LYRICS_INVALID_MOVE_DELTA",
	"DESKTOP_LYRICS_MOVE_DELTA_OUT_OF_RANGE",
	"DESKTOP_LYRICS_POLLER_JOIN_PANICKED",
	"DESKTOP_LYRICS_POLLER_UNSUPPORTED",
	"DESKTOP_LYRICS_POSITION_OVERFLOW",
	"EXPORT_JSON_DIALOG_CLOSED",
	"EXPORT_JSON_INVALID_EXTENSION",
	"EXPORT_JSON_INVALID_PATH",
	"EXPORT_JSON_PATH_IS_DIRECTORY",
	"EXPORT_JSON_SERIALIZE_FAILED",
	"EXPORT_JSON_WRITE_FAILED",
	"IMPORT_JSON_DIALOG_CLOSED",
	"IMPORT_JSON_INVALID_EXTENSION",
	"IMPORT_JSON_INVALID_JSON",
	"IMPORT_JSON_INVALID_PATH",
	"IMPORT_JSON_PATH_NOT_FILE",
	"IMPORT_JSON_READ_FAILED",
	"INVALID_URL",
	"LOGIN_COOKIE_EMPTY",
	"LOGIN_COOKIE_NOT_PLAYBACK_READY",
	"LOGIN_COOKIE_NOT_READY",
	"LOGIN_RUNTIME_IMPORT_FAILED: {error}",
	"main window not found",
]);

export function parseDesktopCommandManifest(source) {
	const match = source.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
	if (!match) throw new Error("desktop command manifest: generate_handler block not found");
	return [...match[1].matchAll(/commands::([a-z0-9_]+)/g)].map((item) => item[1]);
}

function normalizeRustInterface(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\s*,\s*/g, ", ")
		.replace(/,\s*$/, "");
}

export function parseTauriCommandInterfaces(source) {
	const result = {};
	const pattern = /#\[tauri::command\]\s*pub\s+(async\s+)?fn\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:->\s*([^\{]+?))?\s*\{/g;
	for (const match of source.matchAll(pattern)) {
		const [, asyncMarker, name, parameters, returnType] = match;
		result[name] = `${asyncMarker ? "async " : ""}fn ${name}(${normalizeRustInterface(parameters)}) -> ${normalizeRustInterface(returnType || "()")}`;
	}
	return result;
}

function parseSerdeAttributes(source) {
	return [...String(source ?? "").matchAll(/#\[serde\(([^\]]+)\)\]/g)]
		.map((match) => normalizeRustInterface(match[1]));
}

function stripRustComments(source) {
	return String(source ?? "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

export function parseRustSerializationContracts(source) {
	const result = {};
	const cleanSource = stripRustComments(source);
	const declarationPattern = /((?:#\[[^\]]+\]\s*)*)pub\s+(struct|enum)\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g;
	for (const match of cleanSource.matchAll(declarationPattern)) {
		const [, attributes, kind, name, body] = match;
		const contract = {
			kind,
			serde: parseSerdeAttributes(attributes),
		};
		if (kind === "struct") {
			contract.fields = [];
			const fieldPattern = /((?:#\[[^\]]+\]\s*)*)pub\s+([a-z0-9_]+)\s*:\s*([^,\n]+),/g;
			for (const field of body.matchAll(fieldPattern)) {
				const [, fieldAttributes, fieldName, fieldType] = field;
				const serdePrefix = parseSerdeAttributes(fieldAttributes)
					.map((attribute) => `#[serde(${attribute})] `)
					.join("");
				contract.fields.push(`${serdePrefix}${fieldName}: ${normalizeRustInterface(fieldType)}`);
			}
		} else {
			contract.variants = body
				.split(",")
				.map((variant) => variant.replace(/#\[[^\]]+\]/g, "").trim())
				.filter(Boolean)
				.map((variant) => variant.match(/^([A-Z][A-Za-z0-9_]*)/)?.[1])
				.filter(Boolean);
		}
		result[name] = contract;
	}
	return result;
}

export function parseFrozenDesktopErrorStrings(source) {
	const errorCode = /^(?:DESKTOP_LYRICS|EXPORT_JSON|IMPORT_JSON|LOGIN_|UPDATER_|INVALID_URL)/;
	const literalErrors = new Set([
		"Tauri updater public key is not configured",
		"main window not found",
	]);
	return [...new Set(
		[...String(source ?? "").matchAll(/"([^"\n]+)"/g)]
			.map((match) => match[1])
			.filter((value) => errorCode.test(value) || literalErrors.has(value)),
	)].sort();
}

export function parseFrontendDesktopInvokes(source) {
	return [...source.matchAll(/\binvokeTauriCommand(?:<[^)]*?>)?\(\s*["']([a-z0-9_]+)["']/g)]
		.map((match) => match[1]);
}
