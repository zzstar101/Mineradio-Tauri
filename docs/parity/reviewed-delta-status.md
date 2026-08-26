# Mineradio 2.1.0 reviewed delta 状态

本文以 `XxHuberrr/Mineradio@v2.1.0` 为活动产品行为基线；历史 2.0.3 evidence 继续保留，但不再构成活动基线。本文不是完整能力对齐声明。`missing`、`partial`、`blocked` 与 Field Validation Pending 必须继续保留；只有真实外部门禁证据才能改变对应状态。

## D0–D3 状态

| delta_id | status | blocked_by | evidence_state |
| --- | --- | --- | --- |
| D0 | complete | none | recorded |
| D1 | complete | none | joint-gate-recorded |
| D2 | implementation-complete | #56 | external-gate-pending |
| D3 | implementation-complete | none | recorded |

D1 已由生产 `StageLyricsLifecycle`、Shelf supplier、真实 WebGL render-list 与完整资源归零联合门禁收口。D2 的本地 Runtime、Draft N−1→N harness 与发布工作流实现不等于真实受保护发布；#56 所需的独立人工批准、首次真实升级和公开 discovery 证据不得由本地 fixture 替代。D3 已完成 Sonic Workshop 独立重实现，能力为 `implemented / P0 / parity / blocked_by=none`；Windows/WebView2 观感与 CPU/GPU/frame timing 继续是非阻塞待实测。

## 关闭状态

| status_key | value |
| --- | --- |
| reviewed_delta | open |
| overall_status | blocked |
| overall_blocked_by | #56 |
| full_parity | false |
| release_evidence | absent |
| sidecar_api | legacy-frozen |

`overall_blocked_by=#56` 表示无法用仓库内自动化消除的最终外部门禁。

当前不得关闭 #59，也不得声称完整复现、完整对齐或 100% 覆盖 Mineradio 2.1.0。

## 未解决能力快照

下表必须与活动 capability matrix 保持逐项一致，共 16 项。它们是代码、迁移或依赖缺口，不得改写成待实测。

| capability_id | current_tauri | parity_level | convergence_mode | blocked_by |
| --- | --- | --- | --- | --- |
| search.multi-provider-offset | partial | P1 | parity | none |
| playback.startup-resume | missing | P0 | parity | none |
| beatmap.local-song | partial | P1 | parity | none |
| queue.drag-sort | missing | P1 | parity | none |
| lyrics.track-offset | missing | P1 | parity | none |
| visual.archive | missing | P1 | parity | none |
| visual.camera-gesture | missing | P2 | parity | none |
| accounts.provider-order | missing | P1 | parity | none |
| library.drag-sort | missing | P1 | parity | none |
| local-import.expanded | partial | P1 | parity | none |
| hotkeys.editor | missing | P1 | parity | none |
| wallpaper.library | partial | P1 | parity | none |
| wallpaper.wgc | missing | P1 | parity | none |
| provider.kugou | blocked | P2 | parity | MineRadio-api |
| provider.spotify | blocked | P2 | parity | MineRadio-api |
| cuefield.automix | missing | P2 | parity | none |

## 已实现但仍待实机验证

以下 17 项的自动化实现状态是 `implemented`，但正向实机证据仍为非阻塞 Field Validation Pending。删除待实测标记不能提升其证据等级。

| capability_id | current_tauri | validation_status |
| --- | --- | --- |
| playback.gapless | implemented | Field Validation Pending (non-blocking) |
| playback.output-routing | implemented | Field Validation Pending (non-blocking) |
| lyrics.stage-v2 | implemented | Field Validation Pending (non-blocking) |
| visual.cursor-activity | implemented | Field Validation Pending (non-blocking) |
| visual.sonic-workshop | implemented | Field Validation Pending (non-blocking) |
| home.dashboard | implemented | Field Validation Pending (non-blocking) |
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

## 冻结边界

生产网络适配器仍是 `legacy-frozen` Bun Sidecar。`SidecarClient`、`RuntimeConfig.sidecarBaseUrl`、`get_sidecar_status`、`SidecarRecoveryNotice`、`apps/desktop/scripts/build-sidecar-binary.mjs`、`externalBin` 与 `ApiError` 继续属于活动边界；开发中的 Rust `MineRadio-api` 尚未嵌入。

`cuefield.automix` 不属于 Provider/API blocker。上游 `/api/cuefield/transition` 和 `/api/cuefield/feedback` 只承载同机 beat-map planner 与本地 JSONL 反馈；未来由 Web playback Module 拥有规划、时间线和播放交接，desktop persistence Adapter 只实现本地 feedback repository 与历史迁移，并复用现有 playback、lyrics、beatmap Ports。只有 `provider.kugou` 与 `provider.spotify` 继续由 `MineRadio-api` 阻塞。

Sonic Workshop 已独立实现于 `packages/visual-engine/src/sonic-workshop`。不得导入或再分发现有 vendor bundle；legacy `visual.fx` numeric preset `8` 继续迁移到 Sonic Topography `7`，新的 `visual.workshop.v1` preference schema 与 `sonic-workshop-v1` activation id 区分当前 Workshop preset 8。自动化实现完成不等于通过 Windows/WebView2 观感、真实 CPU/GPU/frame timing 或长时 soak，这些证据继续保持 `Field Validation Pending (non-blocking)`。
