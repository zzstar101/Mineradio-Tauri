#[allow(dead_code)]
#[path = "src/app/update_distribution.rs"]
mod update_distribution;

fn main() {
    emit_update_distribution_marker();
    tauri_build::build();
}

fn emit_update_distribution_marker() {
    println!(
        "cargo:rerun-if-env-changed={}",
        update_distribution::OFFICIAL_DISTRIBUTION_ENV
    );

    let requested = std::env::var(update_distribution::OFFICIAL_DISTRIBUTION_ENV).ok();
    let target = std::env::var("TARGET").expect("TARGET is set by Cargo");
    let mode = update_distribution::classify_build_request(requested.as_deref(), &target);

    // 无论是否命中正式发行条件都注入确定值，避免增量构建沿用旧 marker。
    println!(
        "cargo:rustc-env={}={}",
        update_distribution::COMPILED_DISTRIBUTION_ENV,
        mode.compiled_marker()
    );
}

