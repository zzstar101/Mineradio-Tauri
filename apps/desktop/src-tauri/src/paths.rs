use std::path::PathBuf;

pub const APP_DATA_DIR_NAME: &str = "MineRadio-Tauri";

pub fn with_override(dir: Option<String>, fallback: PathBuf) -> PathBuf {
    match dir {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s),
        _ => fallback,
    }
}

pub fn default_app_data_dir_from_base(base: PathBuf) -> PathBuf {
    base.join(APP_DATA_DIR_NAME)
}

pub fn resolve_app_data_dir() -> PathBuf {
    let override_dir = std::env::var("MINERADIO_APP_DATA_DIR").ok();
    let fallback = dirs::data_dir()
        .map(default_app_data_dir_from_base)
        .unwrap_or_else(|| default_app_data_dir_from_base(PathBuf::from(".")));
    with_override(override_dir, fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_override_uses_override_when_set() {
        let p = with_override(Some("/tmp/data".to_string()), PathBuf::from("/fallback"));
        assert_eq!(p, PathBuf::from("/tmp/data"));
    }

    #[test]
    fn with_override_falls_back_when_unset() {
        let p = with_override(None, PathBuf::from("/fallback"));
        assert_eq!(p, PathBuf::from("/fallback"));
    }

    #[test]
    fn with_override_falls_back_when_empty() {
        let p = with_override(Some("".to_string()), PathBuf::from("/fallback"));
        assert_eq!(p, PathBuf::from("/fallback"));
    }

    #[test]
    fn with_override_falls_back_when_whitespace() {
        let p = with_override(Some("   ".to_string()), PathBuf::from("/fallback"));
        assert_eq!(p, PathBuf::from("/fallback"));
    }

    #[test]
    fn resolve_app_data_dir_returns_nonempty_path() {
        let app_data = resolve_app_data_dir();
        assert!(!app_data.to_string_lossy().is_empty());
    }

    #[test]
    fn default_app_data_dir_uses_project_identity() {
        let base = PathBuf::from("/user-data");
        let app_data = default_app_data_dir_from_base(base);
        assert_eq!(
            app_data,
            PathBuf::from("/user-data").join("MineRadio-Tauri")
        );
    }
}
