# Mineradio 2.1.0 reviewed delta 状态

> **SUPERSEDED / HISTORICAL.** 本文件是当时的 selected-delta implementation 汇总，不再是 2.1 产品 parity 或 RC readiness authority。新权威为 `docs/audit/2.1-product-parity-audit.md` 与 `docs/audit/2.1-surface-manifest.json`；本文件中的 convergence/release disposition 不得单独生成 `RC_READY=true`。

本文以 `XxHuberrr/Mineradio@v2.1.0` 为活动产品行为基线，并把 capability 实现状态与 2.1.0 release disposition 分开。自动化实现完成不代表 Windows/WebView2、真实账号、真实网络或升级链路已经通过实机验证。

## D0-D3 状态

| delta_id | status | blocked_by | evidence_state |
| --- | --- | --- | --- |
| D0 | complete | none | recorded |
| D1 | complete | none | joint-gate-recorded |
| D2 | implementation-complete | protected release environment | external-gate-pending |
| D3 | implementation-complete | none | recorded |

D1 的 Stage Lyrics、Shelf 与 WebGL 资源门禁已收口。D2 的本地 updater runtime、Draft N-1→N harness 与工作流实现不能替代首次真实受保护发布。D3 的 Sonic Workshop 自动化完成，Windows/WebView2 观感与 GPU/frame timing 仍待实机验证。

## 架构状态

| status_key | value |
| --- | --- |
| reviewed_delta | open |
| overall_status | release-convergence |
| overall_blocked_by | protected release environment |
| full_parity | false |
| release_evidence | pending |
| sidecar_api | retired-native |
| canonical_provider_path | Tauri api_call → Rust api_bridge → MineRadio-api |

`SidecarClient`、`adapters/sidecar` 与 `createLegacyApplicationRuntime` 是兼容名称，不代表 Bun process、HTTP、localhost、heartbeat、supervisor 或 `externalBin` 仍存在。详细分类见 `docs/sidecar-retirement-2.1.md`。

## 2.1 Release Disposition

| capability | disposition | reason |
| --- | --- | --- |
| Native API architecture cutover | COMPLETE | production path 与 architecture guard 已切换 |
| Provider order persistence | COMPLETE | Web/Tauri 共用 `accounts.providerOrder.v1`，Rust allowlist 与跨重启测试已覆盖 |
| Local library implementation | COMPLETE | 持久索引、协议播放、cover 与 lazy lyrics 有自动化覆盖 |
| Startup resume / preview / Stream Next | COMPLETE | checkpoint 与交叉流程有自动化覆盖 |
| Playlist pagination | COMPLETE | `hasMore` 权威、offset、single-flight 与跨 playlist race 已覆盖 |
| Kugou Provider / QR login | FIELD_VALIDATION_PENDING | 代码、schema 与 bridge 已接入；真实登录及登录后请求未经用户验证 |
| Windows playback / WebView2 / local library | FIELD_VALIDATION_PENDING | 需要真实 Windows UI、媒体栈和用户目录 |
| Packaged installer / N-1→N upgrade | FIELD_VALIDATION_PENDING | 需要签名包与受保护发布环境 |
| Protected release evidence | EXTERNAL_BLOCKED | 本地仓库不能生成真实审批与公开 discovery 证据 |
| Queue drag-sort | POST_2_1 | 不影响 2.1 核心播放正确性 |
| Visual archive | POST_2_1 | 独立增强，不阻塞 RC |
| Camera gesture | POST_2_1 | 可选输入能力，不阻塞 RC |
| Cuefield AutoMix | POST_2_1 | 独立大功能，不属于收敛范围 |
| Wallpaper library enhancements / WGC | POST_2_1 | 当前 fallback 与核心 wallpaper runtime 可用 |
| Spotify Provider | EXTERNAL_BLOCKED | 当前 native API capability 未完成且无实测证据 |

## Remaining Parity Snapshot

以下能力仍可保留在 capability matrix 中，但不得作为 2.1.0 RC 的隐含 blocker：

| capability_id | current_tauri | parity_level | convergence_mode | blocked_by |
| --- | --- | --- | --- | --- |
| search.multi-provider-offset | partial | P1 | parity | none |
| beatmap.local-song | partial | P1 | parity | none |
| queue.drag-sort | missing | P1 | parity | none |
| lyrics.track-offset | missing | P1 | parity | none |
| visual.archive | missing | P1 | parity | none |
| visual.camera-gesture | missing | P2 | parity | none |
| library.drag-sort | missing | P1 | parity | none |
| hotkeys.editor | missing | P1 | parity | none |
| wallpaper.library | partial | P1 | parity | none |
| wallpaper.wgc | missing | P1 | parity | none |
| provider.spotify | blocked | P2 | parity | MineRadio-api |
| cuefield.automix | missing | P2 | parity | none |

## Field Validation Pending

以下项目不能由 fixture 或单元测试替代：本地曲库导入与跨重启水合、startup resume、Stream Next 与 relaunch、Provider 排序跨重启、Kugou QR/登录态/登录后请求、真实音频播放、WebView2 渲染、打包安装器、N-1→N 升级和启动性能。

| capability_id | current_tauri | validation_status |
| --- | --- | --- |
| playback.gapless | implemented | Field Validation Pending (non-blocking) |
| playback.output-routing | implemented | Field Validation Pending (non-blocking) |
| playback.startup-resume | implemented | Field Validation Pending (non-blocking) |
| lyrics.stage-v2 | implemented | Field Validation Pending (non-blocking) |
| visual.cursor-activity | implemented | Field Validation Pending (non-blocking) |
| visual.sonic-workshop | implemented | Field Validation Pending (non-blocking) |
| home.dashboard | implemented | Field Validation Pending (non-blocking) |
| local-import.expanded | implemented | Field Validation Pending (non-blocking) |
| desktop.tray-close | implemented | Field Validation Pending (non-blocking) |
| desktop.lyrics | implemented | Field Validation Pending (non-blocking) |
| desktop.window | implemented | Field Validation Pending (non-blocking) |
| desktop.cache | implemented | Field Validation Pending (non-blocking) |
| desktop.diagnostics | implemented | Field Validation Pending (non-blocking) |
| desktop.memory-governance | implemented | Field Validation Pending (non-blocking) |
| desktop.full-mode | implemented | Field Validation Pending (non-blocking) |
| desktop.native-icons | implemented | Field Validation Pending (non-blocking) |
| wallpaper.engine | implemented | Field Validation Pending (non-blocking) |
| persistence.preferences | implemented | Field Validation Pending (non-blocking) |
| performance.m8-gate | implemented | Field Validation Pending (non-blocking) |
| provider.kugou | implemented | Field Validation Pending (non-blocking) |

在真实环境证据完成前，不得声称 `Field Validated` 或 `Release Verified`。是否允许形成 RC 候选，应由收敛报告依据自动化 gate 和剩余风险单独判定；final release 仍必须完成上述实机验证。

当前不得声称完整复现、完整对齐或 100% 覆盖 Mineradio 2.1.0。
