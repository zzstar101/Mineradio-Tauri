# M10 Upstream Delta Audit

活动产品行为基线为 `XxHuberrr/Mineradio@v2.1.0`（tag object `37993d337c73b130e4a81da7c973b8d246fe32a3`，peeled commit `96091d123b36783f5604d1acd47b00b0708cabbd`，tree `b1b9f80a72d96afcbc8b4685256c3adba9014551`）。审计输入是实际 `git diff v2.0.3...v2.1.0`，不是 CHANGELOG 推断。

## 行为 Delta

| upstream 2.1 changed behavior | current Tauri mapping | implementation | behavior parity | validation | blocker |
| --- | --- | --- | --- | --- | --- |
| `desktop/local-music-library.js` 新增持久化索引、稳定 file identity、目录/多文件导入、metadata/cover/LRC 限额、Range media protocol、坏索引恢复 | `apps/web/src/audio/local-audio-import.ts` + `usePlaybackUiController.ts` | partial：多文件 bounded selection、exact identity 去重、每曲 Blob URL lifecycle；无 Rust persistence/metadata worker | divergent：重启不恢复，文件夹与 lazy lyric/cover protocol 未等价 | automated（import helper/App tests）；Windows runtime Not Measured | none（可独立完成的 Rust local runtime 仍待实现） |
| `13-playback-start-audio.js` local source 走 lazy lyric、切歌 stale request reject、source identity 与 URI lifecycle | `usePlaybackSessionRuntime.ts` + `PlaybackAudioRuntime` | partial：local source generation/owner 与 stale lyric coordinator 已有；local lyric 当前直接 fallback | divergent for embedded/sidecar local lyric association | automated playback/session tests | none |
| `06-lyrics/05-upload-dragdrop.js` 支持多文件/目录/全局 drop 及封面关联 | `AppShell` file input + local import controller | partial：multiple input、dedup、bounded queue；无 directory picker/drop association | divergent | automated local import/App tests | none |
| `desktop/main.js` / startup bindings 增加 renderer reload、readiness、navigation/reopen recovery | Tauri `app/main_window.rs`、`app/desktop_runtime.rs`、`SidecarRecoveryRuntime` | complete architecture-native runtime | matched by contract; Windows reopen/long-soak remains field pending | Rust startup/recovery tests + Web tests | Windows field validation |
| `08-account/*` QR generation/polling、二次确认、logout clearing、entitlement presentation | `features/accounts/*`、typed account session controller | partial：provider loading/error/stale generation/QR cancellation/session clearing | matched for Netease/QQ/Soda flow contracts; provider order UI absent | account/QR tests | provider API portions blocked by MineRadio-api |
| `qishui-api.js`, `qishui-auth-v6.js`, `qishui-qr-login.js`, `qq-vip-api.js`, `kugou-api.js` provider protocol changes | Legacy Sidecar Adapter only | intentionally frozen; no Provider implementation copied or redesigned | n/a: API authority is MineRadio-api | API-freeze architecture guards | MineRadio-api |
| `04-desktop-overlay-fullscreen.js` fullscreen/visibility transitions | Rust full desktop + wallpaper runtime | complete Rust ownership with fallback/recovery | matched at behavior boundary; WGC remains unsupported fallback | Rust runtime/command tests | Windows WGC field validation / intentional fallback |
| `scripts/quick-check.js`, new upstream tests and package dependencies (`music-metadata`, `qrcode`) | Bun scripts, Web/Rust tests | complete toolchain migration; dependency behavior not copied into Sidecar | matched for local contracts only | Bun 1.4 tests/typecheck/build | none |

## File-Level Coverage

The reviewed upstream file set is: `desktop/local-music-library.js`, `desktop/main.js`, `desktop/preload.js`, `public/js/modules/05-playback/13-playback-start-audio.js`, `public/js/modules/06-lyrics/05-upload-dragdrop.js`, `public/js/modules/08-account/00-login-easter-egg.js`, `01-login-modal-utils.js`, `02-login-status.js`, `03-login-modal-flows.js`, `04-user-modal-logout.js`, `public/js/modules/10-shell/04-desktop-overlay-fullscreen.js`, `05-startup-bindings.js`, `qishui-api.js`, `qishui-auth-v6.js`, `qishui-qr-login.js`, `qq-vip-api.js`, `kugou-api.js`, `server.js`, `scripts/quick-check.js`, and the added/modified upstream tests including `local-music-library-persistence.test.js`, `main-window-runtime-recovery.test.js`, `startup-navigation-readiness.test.js`, `qishui-passport-qr-login.test.js`, `qishui-tier-rights.test.js`, `qq-vip-entitlement.test.js`, and `kugou-vip-hardening.test.js`.

Provider/API implementations remain outside this repository's M10 scope. No MineRadio-api code was copied into Web, Rust, or the legacy Sidecar.

## Capability Dimensions

| capability | implementation | behavior_parity | validation | blocker |
| --- | --- | --- | --- | --- |
| `local-import.expanded` | partial | divergent | automated | none |
| `playback.startup-resume` | missing | unknown | none | none |
| `accounts.provider-order` | missing | unknown | none | none |
| `provider.kugou` | blocked | unknown | none | MineRadio-api |
| `provider.spotify` | blocked | unknown | none | MineRadio-api |
| runtime playback UI clock isolation | complete | intentional-difference (same observable clock, lower React fan-out) | automated | field frame evidence pending |
| visual foreground frame policy | complete | intentional-difference (quality-tier scheduler) | automated | WebView2 GPU/frame evidence pending |

