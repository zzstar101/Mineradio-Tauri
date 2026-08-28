# M10 Upstream Delta Audit

> **Historical selected-delta evidence only.** M10 不覆盖完整 S001-S101 产品面，不能替代 `docs/audit/2.1-surface-manifest.json`，也不能单独决定产品 parity 或 `RC_READY`。

活动产品行为基线为 `XxHuberrr/Mineradio@v2.1.0`（tag object `37993d337c73b130e4a81da7c973b8d246fe32a3`，peeled commit `96091d123b36783f5604d1acd47b00b0708cabbd`，tree `b1b9f80a72d96afcbc8b4685256c3adba9014551`）。审计输入是实际 `git diff v2.0.3...v2.1.0`，不是 CHANGELOG 推断。

## 行为 Delta

| upstream 2.1 changed behavior | current Tauri mapping | implementation | behavior parity | validation | blocker |
| --- | --- | --- | --- | --- | --- |
| `desktop/local-music-library.js` 新增持久化索引、稳定 file identity、目录/多文件导入、metadata/cover/LRC 限额、Range media protocol、坏索引恢复 | Rust `runtime/local_library.rs` + `commands/local_library.rs`（`mineradio-local://` 协议、token 门控、原子 staged commit）+ Web `local-library-controller.ts` / `useLocalLibraryRuntime.ts` | complete：sha256 路径 identity、revision、16MiB 索引限额、50000 文件上限、并发 3 metadata worker（lofty）、cover 预算（6MiB/4096px/12Mpx/未知尺寸 1MiB）、sidecar LRC + embedded 歌词（UTF8-BOM/UTF16/GB18030）、per-file 失败隔离、corrupt index 静默恢复、remove 清理封面；Web：native dialog/folder/drag-drop 三入口、busy guard、失败 toast、启动水合并入恢复队列 | matched（协议 host 从 Electron scheme 映射为 `http://mineradio-local.localhost`，CORS 反射含 tauri.localhost —— 架构原生差异）；Windows 真机 import/重启水合 field pending | Rust 13 focused tests + cargo 全量 592；Web controller/adapter/runtime tests；架构 manifest 守卫 | Windows field validation |
| `13-playback-start-audio.js` local source lazy lyric、切歌 stale request reject、source identity 与 URI lifecycle | `usePlaybackSessionRuntime.ts` `applyLocalLibraryLyricOnDemand`（session token + queue-key 双守卫、controller 缓存、custom-lyrics 优先、persist=false 语义） | complete | matched | automated session runtime/controller tests | none |
| `06-lyrics/05-upload-dragdrop.js` 多文件/目录/全局 drop 及封面关联 | AppShell input（browser 模式保留 session-only 流程）；Tauri 模式 native dialog/folder/drop → persistent import；drop 单音频+单图 → `applyCustomCoverImage` 关联 | complete | matched for Tauri runtime；browser 模式 intentional-difference（无持久层可用） | automated App/controller tests | none |
| `desktop/main.js` / startup bindings 增加 renderer reload、readiness、navigation/reopen recovery | Tauri `app/main_window.rs`、`app/desktop_runtime.rs`、`SidecarRecoveryRuntime` | complete architecture-native runtime | matched by contract; Windows reopen/long-soak remains field pending | Rust startup/recovery tests + Web tests | Windows field validation |
| last-playback snapshot restore + startup autoplay preference（upstream localStorage `mineradio-last-playback-v1` 语义） | `runtime/playback_session.rs`（`playback-session-checkpoint-v1.json` 原子持久化、256KiB 上限、损坏即缺席）+ `tauri-playback-session.ts` + `usePlaybackSessionPersistence.ts`（2500ms 节流捕获、hidden/pagehide/beforeunload flush、quiescence owner 让渡）+ main.tsx React 首帧前恢复；autoplay 由 envelope `autoplayOnStartup` 门控（默认 false → 恢复 UI 保持暂停） | complete（复用 frozen PlaybackExitCheckpointV1 schema，未改 store） | matched（autoplay 默认关闭属 upstream `startupAutoplayPreference=false` 对齐）；真实 Windows quit→relaunch field pending | Rust roundtrip/bound/corrupt/atomicity 测试；Web throttle/flush/guard/gating 测试 | Windows field validation |
| `08-account/*` QR generation/polling、二次确认、logout clearing、entitlement presentation；provider order/visibility（localStorage order+visible 列表、FLIP 拖拽重排、登录 tab 排序） | `features/accounts/*`：QR/session flows 此前已 matched；本阶段新增 `accounts.providerOrder.v1` typed preference + `useProviderOrderController`（normalize/dedupe/append-missing、moveBeforePure、模块级共享 store 双 surface 同步）+ AccountSurface 指针拖拽 FLIP 重排 + 登录 modal tab 排序 + Alt+Arrow 键盘重排 | partial→complete for provider-order UI contracts; kugou/spotify key 归一化保留但 UI 不渲染 | matched for netease/qq/soda；kugou/spotify 渲染缺失 = blocked_by MineRadio-api（intentional）；Rust allowlist 需追加 `accounts.providerOrder.v1` 才能跨重启持久化（见 blockers） | 39 account/provider-order tests；preference conformance | **MineRadio-api（kugou/spotify provider 数据面）**；**Tauri db.rs ALLOWED_PREFERENCE_KEYS 追加一行** |
| `qishui-api.js`, `qishui-auth-v6.js`, `qishui-qr-login.js`, `qq-vip-api.js`, `kugou-api.js` provider protocol changes | Legacy Sidecar Adapter only | intentionally frozen; no Provider implementation copied or redesigned | n/a: API authority is MineRadio-api | API-freeze architecture guards | MineRadio-api |
| `04-desktop-overlay-fullscreen.js` fullscreen/visibility transitions | Rust full desktop + wallpaper runtime | complete Rust ownership with fallback/recovery | matched at behavior boundary; WGC remains unsupported fallback | Rust runtime/command tests | Windows WGC field validation / intentional fallback |
| `scripts/quick-check.js`, new upstream tests and package dependencies (`music-metadata`, `qrcode`) | Bun scripts, Web/Rust tests；metadata 解析由 lofty 承担（不复制 music-metadata 进 Sidecar） | complete toolchain migration | matched for local contracts only | Bun 1.4 tests/typecheck/build | none |

## File-Level Coverage

The reviewed upstream file set is: `desktop/local-music-library.js`, `desktop/main.js`, `desktop/preload.js`, `public/js/modules/05-playback/13-playback-start-audio.js`, `public/js/modules/06-lyrics/05-upload-dragdrop.js`, `public/js/modules/08-account/00-login-easter-egg.js`, `01-login-modal-utils.js`, `02-login-status.js`, `03-login-modal-flows.js`, `04-user-modal-logout.js`, `public/js/modules/10-shell/04-desktop-overlay-fullscreen.js`, `05-startup-bindings.js`, `qishui-api.js`, `qishui-auth-v6.js`, `qishui-qr-login.js`, `qq-vip-api.js`, `kugou-api.js`, `server.js`, `scripts/quick-check.js`, and the added/modified upstream tests including `local-music-library-persistence.test.js`, `main-window-runtime-recovery.test.js`, `startup-navigation-readiness.test.js`, `qishui-passport-qr-login.test.js`, `qishui-tier-rights.test.js`, `qq-vip-entitlement.test.js`, and `kugou-vip-hardening.test.js`.

Provider/API implementations remain outside this repository's M10 scope. No MineRadio-api code was copied into Web, Rust, or the legacy Sidecar.

## Capability Dimensions

| capability | implementation | behavior_parity | validation | blocker |
| --- | --- | --- | --- | --- |
| `local-import.expanded` | complete (Rust persistent library + dialog/folder/drop entries) | matched (protocol-host mapping = intentional architecture-native difference) | automated; Windows field-pending | Windows field validation |
| `lyrics.local-on-demand` | complete | matched | automated | none |
| `playback.startup-resume` | complete (session checkpoint file + boot restore + autoplay gate) | matched | automated; Windows relaunch field-pending | Windows field validation |
| `accounts.provider-order` | complete (order persistence via typed preference + drag/keyboard reorder + tab ordering) | matched for available providers | automated | Tauri Rust preference allowlist 一行追加（见下）；kugou/spotify 渲染 blocked_by=MineRadio-api |
| `queue.drag-sort` / `library.drag-sort` / `hotkeys.editor` / `visual.archive` / `visual.camera-gesture` / `beatmap.local-song` / `search.multi-provider-offset` / `wallpaper.wgc` | unchanged from previous review（非 2.1 delta 或需独立设计） | unknown/divergent as previously recorded | as previously recorded | 见 capability matrix 主表 |
| runtime playback UI clock isolation | complete | intentional-difference (same observable clock, lower React fan-out) | automated | field frame evidence pending |
| visual foreground frame policy | complete (eco 30 / balanced 45 / high 60 / ultra vsync quality tiers) | intentional-difference (quality-tier scheduler) | automated + Tier 2 headless benchmark | WebView2 GPU/frame evidence field-pending |

## Known Follow-ups（非本阶段可闭合）

1. **db.rs `ALLOWED_PREFERENCE_KEYS` 追加 `("accounts.providerOrder.v1", 1)`**——否则 provider order 在 Tauri 运行时写入会被 Rust allowlist 拒绝（web/browser dev 与测试路径不受影响；controller 已 fail-safe 降级）。这是一行改动，随下一 commit 提交。
2. kugou/spotify provider 数据面 = blocked_by MineRadio-api。
3. Windows 真机 field validation：本地库导入/重启水合、startup-resume 退出→重launch、WebView2 GPU/frame 采样。
