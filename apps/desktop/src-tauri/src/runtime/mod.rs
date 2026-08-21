pub mod cache;
pub mod desktop_lyrics;
pub mod diagnostics;
#[allow(dead_code)]
pub mod full_desktop;
pub mod hotkeys;
pub mod resources;
pub mod settings;
#[allow(dead_code)]
pub mod updater;
#[allow(dead_code)]
pub mod wallpaper_engine;
pub mod window;
pub mod window_adapter;
pub mod window_contract;

/// 自 UNIX_EPOCH 起的毫秒时间戳。原为 sidecar 模块内的通用时间源；sidecar 移除后
/// 迁移至此，供各运行时记录事件时刻。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}
