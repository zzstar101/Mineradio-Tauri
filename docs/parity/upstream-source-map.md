# Mineradio 2.1.0 上游源码映射

下表是活动上游行为身份的唯一机器可读记录。正式 tag 是 annotated tag，活动行为身份只使用其 peeled commit；tag object 与 release branch tip 均不得替代该 commit。

| baseline_role | repository | tag | peeled_commit | tree | package_version |
| --- | --- | --- | --- | --- | --- |
| active | XxHuberrr/Mineradio | v2.1.0 | 96091d123b36783f5604d1acd47b00b0708cabbd | b1b9f80a72d96afcbc8b4685256c3adba9014551 | 2.1.0 |

以下 provenance 记录 annotated tag 的实际 peel 结果，不构成第二个活动身份。

| provenance_role | ref | object_id | resolved_commit | tree | package_version |
| --- | --- | --- | --- | --- | --- |
| release_tag | refs/tags/v2.1.0 | 37993d337c73b130e4a81da7c973b8d246fe32a3 | 96091d123b36783f5604d1acd47b00b0708cabbd | b1b9f80a72d96afcbc8b4685256c3adba9014551 | 2.1.0 |

历史 2.0.3 reviewed delta 的继承映射如下。`partial`、`missing` 和 `blocked` 是代码或决策缺口，不能降格为 Field Validation Pending；2.1.0 新增 delta 见本文后续 M10 审计表。

| delta_id | current_tauri | convergence_mode | evidence |
| --- | --- | --- | --- |
| lyrics.nested-render-base | implemented | parity | 2.0.3 nested row/context/readability group 已由唯一 effective 38/24 base 驱动；current/outgoing/prewarm/async attach 与真实 Three.js render-list characterization 均有 D1 证据 |
| visual.cursor-shelf-layer | implemented | parity | Web cursor runtime 实现 2500ms auto-hide、五类活动、visibility/dispose 与 `body.cursor-hidden`，并以 selection-preserving policy 驱动 passive Shelf lift/foreground gate |
| updater.github-release | implemented | architecture-replacement | 上游 2.0.3 使用外部 HTTPS 网盘页并交浏览器打开；Tauri 已切换为 GitHub Release + signed Rust UpdateRuntime，不实现网盘/browser-only 模型；Bun Sidecar 保持 `legacy-frozen` 且不参与更新链 |
| visual.sonic-workshop | implemented | parity | 已依据可观察行为完成独立 visual Module；不复制 vendor bundle，legacy `visual.fx` numeric `8` 继续迁为 Sonic Topography `7`，当前 Workshop preset 8 只由独立 `visual.workshop.v1` 恢复；Windows/WebView2 观感与 CPU/GPU/frame timing 为 Field Validation Pending (non-blocking) |
| wallpaper.idle-dispose | implemented | parity | Rust Wallpaper Runtime 的 idle dispose 与 repeated dispose 自动测试已覆盖；无需以 Windows 实机验证替代代码结论 |

除 Sonic Topography 外，本文件只把上游当作行为、参数和恢复语义证据，不继承其全局脚本组织方式。Sonic 依据已确认的来源链、维护者审阅的公开合作证据与项目决策采用直接迁移；该证据不等于书面授权或许可放宽，实施仍须适配 visual-engine 的 scheduler、resource scope、typed settings 和生命周期 seam。

| 领域 | 上游证据 | 当前 Tauri 证据 | 目标所有权 | 迁移规则 |
| --- | --- | --- | --- | --- |
| 启动与本地服务 | `desktop/main.js`、`server.js` | `src-tauri/src/sidecar.rs`、`api/sidecar-client.ts`、`adapters/sidecar/legacy-application-runtime.ts` | `ApplicationRuntimePort` + `ApiRuntimePort` + Legacy Sidecar Adapter | M0–M9 保留现有 supervisor 和 HTTP 行为；业务 caller 只消费聚合 Ports |
| 搜索 | `public/js/modules/05-playback/07-search.js` | `components/shell/SearchShell.tsx` | `SearchExperiencePort` + search controller | 先换依赖类型，不改请求与竞态控制 |
| 播放 URL 与音质 | `05-playback/00-api-quality-output.js`、`11-provider-fallback.js` | `features/playback/usePlaybackSessionRuntime.ts`、`playback-session-coordinator.ts`、`audio/player-controller.ts` | playback session runtime + frozen Playback Port | 保留既有 reload/fallback；opaque URL、session/load generation、fresh URL 单次预算和回滚均不改变 Sidecar 调用 |
| 队列与切歌 | `05-playback/09-queue-snapshot-autoplay.js` 至 `13-playback-start-audio.js` | playback store、handoff policy/controller、session runtime | playback store/runtime | exact current intent 与严格相邻 candidate 才能 compare-and-commit；真实媒体时钟不受视觉 Frame Gate 限流 |
| Audio owner / Gapless | `05-playback/12-playback-switch-core.js`、`13-playback-start-audio.js` | `audio/playback-audio-runtime.ts`、`features/playback/playback-handoff-policy.ts`、`gapless-playback-controller.ts` | `PlaybackAudioRuntime` + session coordinator | pending/committed owner 分离；A/B deck 共用 prepared authority；8.5s preload、1.05s muted preroll、360–720ms equal-power；失败保留 outgoing |
| Audio Graph | `05-playback/08-audio-graph-controls.js` | `audio/playback-audio-runtime.ts`、Visual `AudioFrameSource` consumers | playback runtime + read-only visual snapshot | Runtime 独占 Graph/source/gain/recovery；Visual 不创建或断开 MediaElementSource，不让 React 每帧驱动 analyser |
| 输出路由与恢复 | `05-playback/00-api-quality-output.js`、`08-audio-graph-controls.js`、`13-playback-start-audio.js` | `audio/playback-audio-runtime.ts`、`features/playback/PlaybackAudioSettings.tsx` | playback runtime + typed preferences | primary/最多四 mirrors/Virtual Bridge、默认 sink 恢复、play/stall/Graph/audibility 有界预算；实机设备/听感为 Field Validation Pending（non-blocking） |
| 歌词请求 | `06-lyrics/00-lyrics-fetch-parse.js` | lyrics store、custom lyrics、`App.tsx` | lyrics controller | 保留 fallback、自定义歌词与 stale request 语义 |
| 舞台歌词 | `02-visual/10-lyrics-mask-textures.js` 至 `14-stage-lyrics-rendering.js` | `packages/visual-engine/src/stage-lyrics/**` | visual-engine | 保留旧 mesh 直到新正文 ready，双预算上传 |
| Sonic Topography | `public/sonic-topography-preset.js`、`03-beat/06-sonic-audio-monitor.js`；原始来源 `yin-yizhen/sonic-topography@3ff303e` | `packages/visual-engine/src/sonic-topography/**` | visual-engine | 直接迁移视觉算法，保留 Ajin、来源 commit、Non-Commercial Learning License 和修改说明；不继承全局脚本结构 |
| Cursor activity / Shelf cursor layer | 2.0.3 cursor activity producer、`body.cursor-hidden` 与 Shelf lift/layer gate | `apps/web/src/visual/runtime/cursor-activity-runtime.ts` + visual composition + `packages/visual-engine/src/shelf` | Web cursor runtime + visual-engine Shelf input | 2500ms idle、activity/visibility/dispose、真实 cursor 呈现与 selection-preserving Shelf gate 已实现；Windows 观感继续 Field Validation Pending (non-blocking) |
| Sonic Workshop | 2.0.3 `public/sonic-workshop-preset.js`、`public/vendor/sonic-workshop/**`；CmzYa / Workshop `3747222633` | 独立实现：160×160 有界实例网格、低频波纹、高频流星、idle wave、主题/媒体卡片、冷加载与资源归零 | `packages/visual-engine/src/sonic-workshop` + Web composition lazy loader + `visual.workshop.v1` | 不使用 Sonic Topography/Ajin provenance 代替，不复制或再分发 vendor bundle；legacy `visual.fx` numeric `8` 继续迁为 `7`，当前 Workshop preset 8 由独立 activation id 恢复；自动化实现完成，Windows/WebView2 观感与 CPU/GPU/frame timing 为 Field Validation Pending (non-blocking) |
| 主循环与调度 | `00-state/10-frame-scheduler.js`、`11-main-loop.js` | visual-engine runtime | visual scheduler | analyser/视觉采样可限流，媒体状态不可限流 |
| 3D 歌单架 | `04-shelf/**` | visual shelf modules、`shelf-detail-data.ts` | visual-engine + library controller | 数据增长时 DOM/GPU 对象保持有界 |
| Home 2.0 | `05-playback/03-home-discover-weather.js`、`03a-home-dashboard.js`、`05-home-actions.js` | `home/EmptyHomeHost.tsx`、`App.tsx` | home controller/surface | 维持当前 API，允许重做 UI 组织 |
| 窗口、托盘与关闭 | `desktop/main.js` | `app/lifecycle.rs`、`app/tray.rs`、`app/desktop_runtime.rs`、`runtime/window.rs` | desktop runtime | 默认 exit、可选 tray；所有真实退出汇合到 exactly-once cleanup |
| 完整桌面 | `desktop/full-desktop-mode-runtime.js` | `apps/desktop/src-tauri/src/runtime/full_desktop/**`、`apps/desktop/src-tauri/src/app/full_desktop_runtime.rs`、`apps/desktop/src-tauri/src/commands/full_desktop.rs`、Web `full-desktop-runtime` Port/Adapter/runtime | Rust full desktop runtime | 动态创建主窗口前恢复 journal；状态机统一 attach、reconcile、Escape/tray/exit rollback，无法证明恢复时 fail closed |
| 原生桌面图标 | `desktop/desktop-native-icon-layer-runtime.js`、`desktop/desktop-icon-shape-runtime.js` | `apps/desktop/src-tauri/src/platform/windows/full_desktop.rs` | Rust Windows platform | 只操作经 parent/thread/PID/creation-time 验证的 WorkerW/DefView/ListView；快照化 mutation 必须在 deadline 内 best-effort 对称 rollback |
| Wallpaper Engine | `desktop/wallpaper-engine-runtime.js`、`desktop/wallpaper-engine-library.js` | Rust core/Windows Adapter/app lifecycle + Web `WallpaperEngineRuntimePort`/Background/controller | Rust runtime/platform + Web controller/background | 只关闭 exact location，不终止共享 Wallpaper Engine 核心进程；图片/视频/preview 仅用登记 project-id/role custom protocol；exact signer、bounded absence/journal recovery、DWM 主背景、HWND rebind、周期 location mute、成功-session epoch cleanup 与 Full Desktop transition owner 已实现。原生 WGC/D3D 未启用，明确使用 `glassSamplerReady=false` 的 DOM/static fallback；真实 Scene/DWM/静音/cursor/mixed-DPI/soak 为 Field Validation Pending（non-blocking） |
| Wallpaper idle dispose | 2.0.3 idle Scene dispose 幂等成功 | Rust Wallpaper Runtime idle/repeated dispose tests | Rust runtime | 该语义已自动验证；与 Wallpaper library 搜索/星标/隐藏恢复 partial、native WGC missing 分开记录 |
| 更新 | 2.0.3 external HTTPS download pages | signed Rust UpdateRuntime + thin Tauri/Web adapters | Rust Update Runtime Port | GitHub Release 是明确 architecture replacement；生产 authority 已切换，且 Bun Sidecar 保持 `legacy-frozen`、不参与更新链 |
| 桌面歌词 | `desktop/main.js`、overlay preload | desktop lyrics Rust/React modules | desktop runtime | 保持锁定、穿透、拖动和显示器修正 |
| 内存与资源 | `desktop/system-memory.js`、`00-state/08-desktop-render-power.js` | visual perf state、Rust diagnostics | resources runtime | 系统级释放默认关闭且不在前台播放运行 |
| 缓存治理 | `desktop/main.js` cache handlers、`server.js` cache paths | `runtime/cache.rs`、`commands/cache.rs` | cache runtime | 只管理已验证分类，不接受任意删除路径，不跟随 reparse point |
| Cuefield | `05-playback/16-cuefield-automix-core.js` 至 `18-cuefield-automix-integration.js`、`cuefield/**`、本机 `/api/cuefield/*` | 尚无本地 planner/timeline Module 与 desktop feedback repository | `apps/web/src/features/playback/cuefield` + `apps/desktop/src-tauri/src/runtime/cuefield_feedback.rs` (future) | Web 拥有规划、时间线和播放交接；desktop Adapter 只负责本地反馈迁移/持久化；不访问平台、凭据或远端 Cuefield 服务，不依赖 MineRadio-api；当前为 local `missing / P2 / parity / blocked_by=none` |

## 明确不迁移的上游实现

- 同步 XHR 脚本拼接与编号加载顺序；
- renderer 全局变量和内联事件；
- Electron 主进程内加载完整 HTTP server；
- 运行时 PowerShell/C# helper；
- 登录彩蛋认证门禁；
- 未使用或未实例化的旧 runtime；
- Electron 快速补丁更新路径。
