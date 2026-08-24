mod api_bridge;
mod app;
mod commands;
mod db;
pub(crate) mod media_protocol;
mod paths;
mod platform;
mod runtime;
#[cfg(feature = "updater-smoke")]
pub mod updater_smoke;

use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

pub use app::state::{
    AppState, DesktopLyricsPollerChild, DesktopLyricsRuntimeState, RuntimeConfig,
};

static TLS_PROVIDER: OnceLock<()> = OnceLock::new();

fn updater_public_key_configured_from_plugin_config(
    plugins: &tauri::utils::config::PluginConfig,
) -> bool {
    updater_public_key_from_plugin_config(plugins).is_some()
}

fn updater_public_key_from_plugin_config(
    plugins: &tauri::utils::config::PluginConfig,
) -> Option<String> {
    plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn install_tls_crypto_provider() {
    TLS_PROVIDER.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub fn run() {
    install_tls_crypto_provider();
    let app_data_dir = paths::resolve_app_data_dir();
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let schema_version = "0.1.0".to_string();
    let context = tauri::generate_context!();
    let updater_public_key = updater_public_key_from_plugin_config(&context.config().plugins);
    let updater_public_key_configured = updater_public_key.is_some();

    // SQLite 本地存储初始化
    let (db_state, db_init_error) = match db::initialize(&app_data_dir) {
        Ok(s) => (Some(Mutex::new(s)), None),
        Err(e) => {
            let msg = format!(
                "db::initialize failed at {}: {:?}",
                app_data_dir.display(),
                e
            );
            eprintln!("{}", msg);
            (None, Some(msg))
        }
    };

    let runtime_settings = Arc::new(Mutex::new(
        runtime::settings::RuntimeSettingsStore::for_app_data(&app_data_dir),
    ));
    let (cache_state, cache_init_error) = match runtime::cache::CacheRuntime::for_app_data(
        &app_data_dir,
        Arc::clone(&runtime_settings),
    ) {
        Ok(runtime) => (Some(Arc::new(Mutex::new(runtime))), None),
        Err(error) => {
            let message = format!("cache runtime initialization failed: {error}");
            eprintln!("{message}");
            (None, Some(message))
        }
    };

    // Rust 侧 API 库初始化。前端通过 api_call invoke 使用此 in-process 库。
    let api = tauri::async_runtime::block_on(async {
        mineradio_api::Api::init(mineradio_api::LibraryConfig {
            app_version: app_version.clone(),
            api_version: "0.1.0".to_string(),
            schema_version: schema_version.clone(),
            data_dir: Some(app_data_dir.clone()),
        })
        .await
    })
    .map_err(|err| eprintln!("mineradio api init failed: {err}"))
    .ok();
    let mut state = AppState::new(
        app_data_dir.to_string_lossy().to_string(),
        app_version.clone(),
        schema_version.clone(),
        updater_public_key_configured,
        db_state,
        db_init_error,
        cache_state,
        cache_init_error,
        runtime_settings,
    );
    state.attach_api(api);

    let setup_app_version = app_version.clone();
    let setup_app_data = app_data_dir.clone();
    let setup_updater_public_key = updater_public_key.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            app::desktop_runtime::reactivate_main_window_for_single_instance(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_page_load(app::wallpaper_engine_runtime::handle_main_webview_page_load)
        .register_asynchronous_uri_scheme_protocol(
            "mineradio-wallpaper",
            |context, request, responder| {
                let app = context.app_handle().clone();
                let webview_label = context.webview_label().to_owned();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<AppState>();
                    let response = app::wallpaper_media_protocol::build_media_response(
                        &webview_label,
                        request,
                        |project_id, role| {
                            app::wallpaper_engine_runtime::resolve_media(
                                state.inner(),
                                project_id,
                                role,
                            )
                        },
                    );
                    responder.respond(response);
                });
            },
        )
        .register_asynchronous_uri_scheme_protocol(
            "mineradio-tauri",
            media_protocol::handle_media_request,
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_config,
            commands::get_database_status,
            commands::get_preferences_snapshot,
            commands::commit_preferences_transaction,
            commands::migrate_legacy_preferences,
            commands::get_desktop_diagnostics,
            commands::get_resource_governance,
            commands::trim_application_working_set,
            commands::purge_system_memory,
            commands::get_cache_snapshot,
            commands::choose_cache_directory,
            commands::set_cache_root,
            commands::clear_cache_category,
            commands::configure_global_hotkeys,
            commands::get_update_runtime_snapshot,
            commands::dispatch_update_runtime_intent,
            commands::updater_web_quiescence_acknowledge,
            commands::updater_web_quiescence_reconcile,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_toggle_fullscreen,
            commands::window_close,
            commands::window_show,
            commands::application_exit,
            commands::get_window_state,
            commands::get_window_runtime_state,
            commands::set_close_behavior,
            commands::get_full_desktop_runtime_state,
            commands::set_full_desktop_mode,
            commands::set_desktop_icons_visible,
            commands::set_full_desktop_interaction_locked,
            commands::recover_full_desktop_runtime,
            commands::list_wallpaper_engine_projects,
            commands::get_wallpaper_engine_project_details,
            commands::choose_wallpaper_engine_directory,
            commands::choose_wallpaper_engine_project_file,
            commands::remove_wallpaper_engine_directory,
            commands::get_wallpaper_engine_runtime_status,
            commands::start_wallpaper_engine_scene,
            commands::stop_wallpaper_engine_scene,
            commands::recover_wallpaper_engine_runtime,
            commands::open_external,
            commands::export_json_file,
            commands::import_json_file,
            commands::desktop_lyrics_show_window,
            commands::desktop_lyrics_close_window,
            commands::desktop_lyrics_set_click_through,
            commands::desktop_lyrics_move_by,
            commands::desktop_lyrics_set_hot_bounds,
            commands::desktop_lyrics_update_payload,
            commands::desktop_lyrics_overlay_ready,
            commands::login_netease_show_window,
            commands::login_qq_show_window,
            commands::login_netease_complete,
            commands::login_qq_complete,
            commands::login_netease_close_window,
            commands::login_qq_close_window,
            api_bridge::api_call
        ])
        .setup(move |app| {
            // NOTE: spawn + health-wait are best-effort. This setup closure only
            // runs under a real `tauri::Builder` app (`tauri dev`), never from
            // cargo tests (tests call only the pure module functions).
            let update_runtime = match app::updater_runtime::ApplicationUpdateRuntime::build(
                app.handle().clone(),
                &setup_app_data,
                &setup_app_version,
                setup_updater_public_key.as_deref(),
                app::update_distribution::compiled_official_distribution(),
            ) {
                Ok(runtime) => runtime,
                Err(error) => {
                    // 更新初始化故障只关闭更新能力，不能阻止播放器启动。
                    eprintln!(
                        "updater bootstrap failed; continuing with updates disabled: {error}"
                    );
                    app::updater_runtime::ApplicationUpdateRuntime::disabled_after_bootstrap_failure(
                        app.handle().clone(),
                        &setup_app_version,
                    )
                }
            };
            if !app.manage(update_runtime) {
                return Err(std::io::Error::other("UPDATE_RUNTIME_ALREADY_MANAGED").into());
            }
            app::full_desktop_runtime::recover_before_main_window(app.handle())?;
            app::main_window::create_main_window(app.handle())?;
            app::wallpaper_engine_runtime::initialize_after_main_window(app.handle());
            app::wallpaper_engine_runtime::start_reconcile_watcher_after_main_window(app.handle());
            app::full_desktop_runtime::schedule_auto_resume_after_main_window(app.handle());
            app::full_desktop_runtime::sync_native_recovery_surfaces(app.handle());
            app::full_desktop_runtime::start_explorer_watcher_after_main_window(app.handle());
            let state = app.state::<AppState>();
            let close_behavior = state
                .window_runtime
                .lock()
                .map(|runtime| runtime.snapshot().lifecycle.close_behavior)
                .unwrap_or_default();
            if close_behavior == app::lifecycle::CloseBehavior::Tray {
                if let Err(error) = app::tray::ensure_main_tray(app.handle()) {
                    state.diagnostics.record_runtime_error(
                        runtime::diagnostics::DiagnosticProbeKind::Tray,
                        crate::runtime::now_ms(),
                        format!("persisted tray initialization failed: {error}"),
                    );
                }
            }
            Ok(())
        })
        .on_window_event(app::desktop_runtime::handle_window_event)
        .build(context)
        .expect("failed to build MineRadio-Tauri shell");
    app.run(app::desktop_runtime::handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_public_key_config_is_read_from_tauri_plugin_config() {
        let empty = tauri::utils::config::PluginConfig(Default::default());
        assert!(!updater_public_key_configured_from_plugin_config(&empty));

        let mut plugins = std::collections::HashMap::new();
        plugins.insert(
            "updater".to_string(),
            serde_json::json!({ "endpoints": ["https://example.test/latest.json"], "pubkey": "   " }),
        );
        assert!(!updater_public_key_configured_from_plugin_config(
            &tauri::utils::config::PluginConfig(plugins)
        ));

        let mut plugins = std::collections::HashMap::new();
        plugins.insert(
            "updater".to_string(),
            serde_json::json!({ "endpoints": ["https://example.test/latest.json"], "pubkey": "base64-public-key" }),
        );
        assert!(updater_public_key_configured_from_plugin_config(
            &tauri::utils::config::PluginConfig(plugins)
        ));
    }
}
