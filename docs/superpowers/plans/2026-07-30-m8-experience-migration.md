# M8 P1 体验与数据迁移实施计划

> **Historical implementation evidence only.** M8 deterministic checks cover synthetic resource/performance budgets, not full product parity or Stage Lyrics Windows/WebView2 transition performance。当前权威见 `docs/audit/2.1-surface-manifest.json` 与 `docs/audit/stage-lyrics-performance.md`。

**设计：** `docs/superpowers/specs/2026-07-30-m8-experience-migration-design.md`

**当前状态：** Code Complete / Automated Verification Complete / Field Validation Pending（non-blocking）

**范围冻结：** 不修改 Bun Sidecar、现有音乐 API、shared DTO、Provider、media URL 与 `bundle.externalBin`；不进入 M9；不接入开发中的 Rust `mineradio-api`。

## Tracer 1：冻结 M8 seam 和 API 行为（完成）

- 添加 M8 API freeze、direct-localStorage、search transport 和 performance budget architecture guards；
- 固定 legacy key allowlist、migration payload/operation 上限；
- 保持现有 28 frozen 与 M5–M7 additive Tauri command；只追加三条 preference command；
- 为 memory/browser/Tauri Preferences Adapter 建立同一 conformance suite。

验证：guards RED→GREEN；现有 M1–M7 tests 不回退。

## Tracer 2：PreferencesRepository 与迁移 journal（完成）

- RED：typed key default/schema、transaction 原子性、损坏值 quarantine；
- GREEN：实现 Port、memory Adapter 和 legacy browser Adapter；
- RED：legacy-authoritative/copy/verify/commit、digest change、crash resume、mirror failure；
- GREEN：实现 SQLite preferences/journal 和 allowlist Tauri Adapter；
- 接入首批 shell/quality/visual/shelf/FAB/wallpaper keys；
- hydration 完成前禁止默认值回写；legacy 保留，不删除。

验证：Rust transaction/migration tests + Web conformance/migration fixtures。

## Tracer 3：单一 Search Session（完成）

- RED：compact/detail duplicate fetch、跨 Surface stale、same-query retry；
- GREEN：实现 `SearchSessionController` 和 hook；
- 将 `SearchShell`/`SearchDetailPage` 改成 snapshot + intents；详情页移除 `SidecarClient`；
- 删除无生产引用的旧 `SearchPanel`；
- RED→GREEN：history 成功提交、大小写去重、最多 10、legacy shape 迁移、删除/清空；
- RED→GREEN：provider cumulative limit、All 本地渐进、Podcast offset、single-flight、no-novel exhausted；
- 加入“加载更多”与真实历史 UI。

验证：controller public interface tests + Surface integration + search Port architecture guard。

## Tracer 4：Home listen ledger 与 Dashboard policy（完成）

- RED→GREEN：v1→v2 migration 不丢 lifetime、不伪造 daily；
- RED→GREEN：Continue 优先级、Next Up、For You 稳定去重和 today/streak；
- 实现 `HomeListenRepository`、Dashboard model 和 `useHomeDashboardController`；
- 保留现有 Discover/Playlist/Podcast/Weather rail 和播放事务；
- 增加局部错误/重试，不清空其他成功数据。

验证：pure policy/ledger tests + Home Surface 行为测试。

## Tracer 5：Home Hero MP4 生命周期（完成）

- RED：格式/300MB、replace generation、owned URL revoke、hidden/unmount release；
- GREEN：IndexedDB `HomeHeroVideoRepository` 和 memory fake；
- 接入选择、替换、删除、播放/暂停；
- 不把 Blob/Base64 写入 preference JSON。

验证：repository contract、controller resource lifecycle、Home behavior tests。

## Tracer 6：设置事务与工作台（完成）

- RED→GREEN：persist 后 push、changedPaths undo、multi-key、no-op、650ms gesture merge、40 条上限、failed undo、serial double undo、rollback-to；
- 实现 typed settings catalog 和六 tab；
- 全局搜索、最近更改、undo、rollback-to 和可逆 reset；
- 将 Visual/Shelf 重叠字段作为一个 transaction；
- 保留 Desktop Runtime 控件，native/destructive action 标记为不可 undo；
- 将 `VisualControlPanelHost` 拆为工作台 shell 和按领域 section，App 只传 typed callbacks。

验证：transaction controller public interface tests + Workbench integration。

## Tracer 7：手动音源切换（完成）

- RED→GREEN：严格标题/歌手匹配、翻唱/Remix 拒绝、stale intent、exact index replacement、position preserve、失败回滚和 actual provider；
- 实现 `SourceSwitchController` 和当前能力驱动的 UI；
- 本地、Podcast、当前 Provider 和缺 capability 项禁用；
- 不增加 Provider，不修改音乐 API。

验证：policy/controller tests + playback integration。

## Tracer 8：低配模式与性能门禁（代码完成 / release field validation pending）

- 低配模式作为一条可逆 multi-key settings transaction；
- `perf:budget` 比较 checked-in deterministic baseline；
- Home/Search/Settings DOM、virtual window、Depth allocation、bundle、migration budget、timer/listener/Object URL cleanup fail closed；
- 添加 Windows release runner 和 evidence schema；真实低配/升级/soak 标记 Field Validation Pending。

验证：`bun run perf:budget` + parity/evidence guard。

## Tracer 9：文档和最终门禁（完成）

- 更新 capability matrix、umbrella M8 状态和 migration inventory；
- 记录不可宣称项与 Field Validation Pending；
- 运行：

```text
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture scripts/perf
bun run typecheck
bun run web:build
bun run perf:budget
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
git diff --check
```

M8 完成后停止，不进入 M9，也不切换 `mineradio-api`。

## 收口记录

- Home Dashboard、Search Session、Settings transaction/undo、手动音源切换、Preferences migration 和 deterministic performance gate 均已有生产接线与聚焦自动验证；
- 首批 migration inventory 已覆盖 quality、shell booleans、visual/shelf、FAB auto-hide、Wallpaper selection、Home listen ledger v2 和 search history；canonical repository 提交成功后才发布运行时/UI 状态，legacy 只做 best-effort mirror；
- SQLite v3 只追加三条 allowlisted preference command，未改变既有 Tauri command 语义；Bun Sidecar、音乐 API、shared DTO、Provider、media URL 与 `bundle.externalBin` 继续冻结；
- 最终门禁结果：Bun/workspace `2222 passed`；Rust 主 crate `292 passed`，Updater example `7 passed`；workspace typecheck、Web production build、`perf:budget`、Rust fmt、全 target/feature Clippy `-D warnings`、API/architecture freeze 与 `git diff --check` 全绿。

以下保持 `Field Validation Pending (non-blocking)`：正式 WebView2 release 冷启动和完整进程树内存、GPU/frame/包体积、真实低配/iGPU/电池/温控、真实旧版本目录升级与回滚、安装器升级/断电恢复、大型 MP4/字体/封面权限，以及 Home/Shelf/Sonic/后台 30–60 分钟 Windows soak。它们只阻止 `Field Validated / Release Verified`，不阻止代码完成。

不得据 M8 宣称 Electron 2.0.2 的 180 首/完整远端分页、Provider partial-error 聚合、Kugou/Spotify、平台官方推荐 Feed、全部 Base64 资产文件化、native 操作可撤销、真实设备性能收益，或 Rust `mineradio-api` 已嵌入。M9 尚未开始。
