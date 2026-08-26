//! MineRadio 桌面运行时命令入口。
//!
//! 各领域模块保持既有 Tauri command 名称、参数与返回结构，
//! 此处只负责统一导出给主程序注册。

mod cache;
mod desktop_lyrics;
mod diagnostics;
mod dialogs;
mod full_desktop;
mod hotkeys;
mod local_library;
mod login;
mod playback_session;
mod preferences;
mod runtime;
mod updater;
mod wallpaper_engine;
mod window;
mod window_runtime;

pub use cache::*;
pub use desktop_lyrics::*;
pub use diagnostics::*;
pub use dialogs::*;
pub use full_desktop::*;
pub use hotkeys::*;
pub use local_library::*;
pub use login::*;
pub use playback_session::*;
pub use preferences::*;
pub use runtime::*;
pub use updater::*;
pub use wallpaper_engine::*;
pub use window::*;
pub use window_runtime::*;

pub mod labels {
    pub use crate::app::window_labels::{LOGIN_NETEASE, LOGIN_QQ, MAIN};
}
