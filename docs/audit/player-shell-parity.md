# Bottom Bar / Player Shell 产品 Parity 审计

## 结论

`REGRESSION / P1 RC BLOCKER`。当前 `PlayerConsoleHost` 保留了播放按钮等基础行为，但 bottom bar 的 DOM 顺序、metadata 交互、popover 内容、控制集合和显隐行为均与 upstream v2.1.0 明显不同。它是功能性重排，不是视觉/行为复原。

## 逐区对照

| 区域 | Upstream v2.1.0 | Current Tauri | 状态 | 用户影响 |
| --- | --- | --- | --- | --- |
| 总体结构 | mini queue 在 progress 前；metadata/transport/utilities 三段 | progress、queue、metadata 和扩展 controls 重排 | REGRESSION | 扫描路径和空间关系改变 |
| mini queue | 标题/数量/显式 `×`；支持 upstream reorder | 无显式关闭；加入 insert-next/remove；无 drag-sort | REGRESSION | 关闭和重排行为缺失 |
| cover | button，可开专辑详情 | `aria-hidden` 非交互 | REGRESSION | 丢失专辑导航 |
| title/artist | 可开 song/artist detail，title 内含 badges/quality | 纯文本，无详情入口；quality 移出 metadata | REGRESSION | 丢失详情与 entitlement 上下文 |
| like/collect | 与 provider/track capability 对齐 | 按钮可见但 capability gate 不完整 | PARTIAL | 不支持 provider 仍可触发动作 |
| mode/prev/play/next | 居中 transport | 基础按钮存在 | CLOSE | 核心点击路径保留 |
| Cuefield | transport 内独立实验按钮与反馈 | 完全不存在 | MISSING | 上游 AutoMix 能力消失 |
| lyric offset | “歌词校准” ±0.1s/reset，按 track | 只有歌词按钮和原词/自定义 SourceSwitcher | MISSING | 无法校准 provider 时间偏差 |
| volume/fade | 紧凑 popover：volume + fade in/out | popover 内嵌完整 Playback 2.0、output/mirror/virtual bridge | REGRESSION | 底栏变成大型设置面板，尺寸/层级改变 |
| control auto-hide | DIY 下显式按钮 | 缺失 | MISSING | 上游沉浸控制路径不完整 |
| immersive | “全沉浸式” | 缺失 | MISSING | 行为缺口 |
| fullscreen | upstream DIY/状态下显式 | 当前有 fullscreen | CLOSE | 基础行为需 WebView2 验证 |
| time/progress | 右侧时间，顶边 progress | 基本存在 | CLOSE | seek/真实时钟仍 field pending |
| 3D Shelf controls | 不占据 upstream bottom bar 默认结构 | 当前扩展可能进入底栏 | REGRESSION | 产品基线之外的布局漂移 |
| native window buttons | titlebar 所有 | 当前部分 shell 状态会把桌面动作混入控制区 | PARTIAL | 控件职责混杂 |

## 关键源码证据

- Upstream：`public/index.html:1257-1409`；metadata detail 在 `1275-1291`；Cuefield 在 `1313-1320`；歌词校准在 `1344-1358`。
- Current：`apps/web/src/visual/PlayerConsoleHost.tsx:433-586`。封面/metadata 见 `433-495`，transport/queue 见 `513-558`，volume/lyrics utilities 见 `565-586`。
- Current `PlaybackAudioSettings` 被放进音量 popover；这证明音频能力“更多”，但也证明 upstream player shell 的信息架构被替换。
- 运行态可访问性树与截图同时验证了 current 没有 Cuefield、歌词 ±0.1、metadata detail、auto-hide 和 immersive，并显示 volume popover 内完整 Playback 2.0 面板。

## 状态拆分

- `Code Present`：play/pause、prev/next、mode、queue open、volume、quality、fullscreen、time/progress。
- `Behavior Partial`：capability-gated like/collect、quality entitlement、mini queue。
- `Visual Regression`：总体三段结构、metadata、popover、control ordering。
- `Missing`：track lyric offset、Cuefield、queue drag-sort、metadata detail、control auto-hide、immersive。
- `Field Unverified`：真实 seek、gapless、output routing、preview、end-of-track、Stream Next、startup resume。

## 修复验收条件（仅计划）

1. 以 upstream `IDX:1257-1409` 建立 DOM 顺序和 computed geometry golden，覆盖 collapsed/expanded、queue open、volume open、quality open、DIY 和 fullscreen。
2. 恢复 metadata 的 album/song/artist 详情行为与 lyric offset；capability 不支持的 provider 不渲染动作。
3. Playback 2.0/output routing 移到不改变 upstream bottom bar 的附加设置 surface。
4. 用真实 WebView2 验证 hover、auto-hide、focus、keyboard、seek、popover z-index 和窄窗口无重叠。
