# MineRadio domain context

## M2 playback language

- **Playback Audio Runtime**：独占 A/B deck、Audio Graph、Audio owner handoff、fade、播放恢复和输出路由的 deep Module。caller 只提交播放 source/intent 与 typed preference，不接触 AudioContext、GainNode、sink 或 timer。
  _Avoid_：Audio manager、visual audio graph
- **Audio Deck**：Playback Audio Runtime 持有的两个长寿命媒体槽 A/B；deck identity 稳定，source 和 pending/committed/retiring 角色可以变化。
  _Avoid_：player instance、temporary audio
- **Pending Audio Owner**：已装载或预载、但尚未通过 exact handle 和 `play()` success 获得媒体 authority 的 deck。它的原生事件不能更新 application state。
  _Avoid_：current audio、next player
- **Committed Audio Owner**：唯一有权发布真实 media clock、position、duration、ended 和 audio-driven visual 状态的 deck。用户选择的 track 在 resolving 期间不自动等于 Committed Audio Owner。
  _Avoid_：active ref、visible track
- **Prepared Handoff**：绑定 outgoing session/intent、candidate、queue fingerprint、deck 与 generation 的一次性 owner 转移。失败或 stale 只释放 pending，不破坏 committed owner。
  _Avoid_：preload callback、next-song promise
- **Album Gapless Candidate**：严格相邻、同 provider、同规范化 album 且同 exact cover 的下一 queue item；任一身份字段缺失都不推断为同专辑。
  _Avoid_：similar album、title match
- **Readonly Audio Frame Source**：Playback Audio Runtime 向 Visual Module 发布的聚合 analyser bytes、media clock 与 playing snapshot。它不暴露 AudioContext、deck、AudioNode 或 mutation。
  _Avoid_：audio element ref、visual-owned analyser
- **Output Route**：一个 primary sink、最多四个 mirror sinks 和可选 Virtual Output Bridge 的 typed playback preference 与 runtime state。
  _Avoid_：arbitrary device graph
- **Virtual Output Bridge**：把已识别的虚拟音频输出设备设为 primary sink 的 Output Route。它不是录音输入、capture stream 或额外 Sidecar。
  _Avoid_：microphone capture、input forwarding
- **Stall Lineage**：一次 committed load 及其唯一 fresh-URL recovery 所属的有界恢复链。新 URL load 不会重置该链并形成无限刷新。
  _Avoid_：unbounded retry

## M9 runtime language

- **Application Ports**：Web 应用运行所需的一组稳定 Interface，包含 Music、API Runtime、Media URI 与 Desktop Ports；业务 Module 只能通过这些 Interface 调用外部能力。
- **Application Runtime Port**：启动 Application Ports 的单一 Seam。caller 只知道 `connect()` 的成功、不可用与失败语义，不知道 Tauri IPC、Rust bridge 或 Provider 实现。
- **Native API Compatibility Adapter**：位于 `adapters/sidecar` 的兼容命名 Adapter。它创建仍名为 `SidecarClient` 的兼容客户端，通过 Tauri `api_call` 调用 Rust `api_bridge`，并向 Application Runtime Port 发布 Application Ports；它不拥有 HTTP、localhost、子进程、health probe 或 supervisor。
- **Opaque media source**：由 Media URL Port 产生的媒体 URI 与可选 fallback URI。业务和 visual-engine 只负责传递或加载，不解析 host、route 或 query。

## Invariants

- Playback Audio Runtime 是 playback Audio 元素、MediaElementSource、gain、analyser、fade、probe、mirror 和 sink mutation 的唯一 owner。
- 任意时刻最多一个 Pending Audio Owner、一个 Committed Audio Owner、一个 Prepared Handoff 和四个 mirror Audio；dispose 后全部资源和 timer 归零。
- Visual Module 只能读取 Readonly Audio Frame Source，不创建、断开、恢复或路由 playback Audio Graph。
- Prepared Handoff 只有在 incoming `play()` 成功且 generation/session/intent/candidate/queue authority 全部有效时才能 commit；失败保留 outgoing committed owner。
- Album Gapless Candidate 使用保守同专辑规则；gapless 与 crossfade 共享同一个 Prepared Handoff。
- 每个 Stall Lineage 最多一次 fresh URL recovery；play、ready、stall、Graph 与 audibility probe 都有 deterministic budget。
- Output Route disabled path 不保留 mirror Audio、sync interval 或设备轮询；Virtual Output Bridge 不创建 capture stream。
- Provider 的 canonical production path 固定为 Web Application Ports → Tauri `api_call` → Rust `api_bridge` → in-process `mineradio_api::Api`。
- Bun Sidecar、localhost HTTP、heartbeat、supervisor、restart/recovery 与 Sidecar `externalBin` 已退出生产架构，不得重新引入。
- CSS 封面继续使用 direct URL；WebGL 封面使用 Media URL Port 返回的 opaque native URI，并保留 direct fallback。
- `SidecarClient` 作为兼容命名只能存在于 API implementation 和 `adapters/sidecar` 中；该名称不代表 Sidecar transport 仍然存在。
- `api/` 是用户所有的 Provider 行为来源；任何真实 Provider 能力只能在字段验证后标为发布可用。
