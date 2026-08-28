# Wave 3 Player Shell Report

Branch: `rc-stabilization/2.1.0`
Baseline SHA: `0892c13cad29f8e5ba50ef4455828381342463b7`
Final SHA: `0803a8b`（Wave 3 提交顶部）
API SHA: `fb00faf`（submodule，Wave 2 一致）
Working tree: clean

## Baseline

```text
branch: rc-stabilization/2.1.0
baseline SHA: 0892c13cad29f8e5ba50ef4455828381342463b7
final SHA:    0803a8b
API SHA:      fb00fafe837a875639b905443115ce16b1abdc96
working tree: clean
```

Wave 3 提交：

```text
c8ec0a3 test(player): freeze upstream player shell golden
a5d4038 fix(player): restore bottom bar information architecture and utility interactions
9bd8524 test(player): add player shell structure, geometry, and behavior regression
0803a8b docs(audit): record wave 3 player shell manifest parity evidence
```

## Scope Decisions

```text
QUEUE_DRAG_SORT_2_1_SCOPE = IN
CUEFIELD_2_1_SCOPE       = OUT
```

### QUEUE_DRAG_SORT = IN

Upstream v2.1.0 mini queue 依赖长按拖排（`06-lyrics/01-playlist-panel-shell.js` `panelReorderState`，
~520ms 长按 lift + 拖动 → `moveQueueIndex`，跟手 index 计算）。经 `extract-upstream-golden.mjs`
从 frozen DOM/JS 确认这是 Player Shell 真实一等行为。

实现：`playback-store.moveTrack(from,to)`（保留曲目对象身份）+ `visual/mini-queue-reorder.ts`
（长按、移动取消阈值、drop 定位、click 抑制），miniqueue 行带 `data-queue-index`，虚拟列表仍工作。
自动化：`PlayerConsoleHost.test.tsx` drag-sort 测试 + `playback-store.test.ts` moveTrack 回归。

### CUEFIELD = OUT（deliberate product deviation）

Upstream AutoMix 实体是 `05-playback/16-18-cuefield-*`（core / timeline-executor / integration）。
当前 repo 没有等价模块：`visual-engine` 只有 `beatmap-scheduler`（sonic/desktop-lyrics beatmap），
不是 AutoMix plan/handoff/feedback 引擎。运行时能力属于“已被完整移除”情形，迁移到 Tauri 音频/队列
管线成本高且无上游契约样本。因此不渲染死的 `#cuefield-automix-btn`（golden 断言其不存在），
并记录：**Player Shell 不标 EXACT**。计划在后续 Wave（provider/AutoMix 专项）单独评估。

## Canonical Shell

最终结构与 upstream `public/index.html:1255-1409` 一致：

```text
Bottom Handle (#bottom-handle, z8, 236x28, bottom 13px)

Bottom Bar (#bottom-bar, fixed, min(1080px, 100vw-56px), radius 50)
├── Mini Queue (#mini-queue-popover, 先于 progress; 显式关闭 ×; 长按拖排)
│   ├── mini-queue-head (当前队列 / {n} 首 / ×)
│   └── mini-queue-list (data-queue-index rows)
├── Progress (#progress-bar > #progress-fill + #progress-thumb, z1)
└── Controls (grid 3 列)
    ├── actions: control-track [cover(album)→title(text+badges[sources+quality chip])→artist] + heart + collect
    ├── transport: play-mode | prev | play | next | mini-queue
    └── modes: lyric-timing(±0.1) | volume(volume+fade in/out) | controls-hide | immersive | fullscreen | time
```

React 边界按实现需要保留 `PlayerConsoleHost` / `BottomControlsHost`；DOM/视觉结构按 upstream（product
structure first）。Window min/max/close 与 shelf/lyric-source inline 控件移出底栏：
- window chrome 回 titlebar（`#desktop-titlebar` 已有 min/max/close/DIY）
- shelf 控件在 Settings Workbench + shelf surface
- 原词/自定义 lyrics + 编辑收入 lyric-timing popover 内扩展行（不移入底栏，不丢功能）

## Surface Matrix

| Surface | Upstream | Before | After | Visual | Behavior | Field |
| ------- | -------- | ------ | ----- | ------ | -------- | ----- |
| Bottom Handle | S008 | CLOSE | CLOSE | golden 结构 ok | 自动化 ok | field pending |
| Bottom Bar | S009 | REGRESSION | PARTIAL | 三段式 IA 恢复 | 自动化 ok | field pending |
| Mini Queue | S010 | REGRESSION | PARTIAL | 上方浮层+close+拖排 | 自动化 ok | field pending |
| Metadata | S011 | REGRESSION | PARTIAL | detail affordances | 自动化 ok | field pending |
| Quality | S020 | PARTIAL | PARTIAL | 归位 title badges | 自动化 ok | field pending |
| Transport | S016-18,21 | CLOSE | CLOSE | 保留 | 自动化 ok | field pending |
| Lyric Offset | S042 | MISSING | PARTIAL | popover ±0.1 | 自动化 ok | field pending |
| Volume/Fade | S019 | REGRESSION | PARTIAL | 紧凑 volume+fade | 自动化 ok | field pending |
| Auto-hide | (S015/09) | 缺失 | PARTIAL | controls-hide-btn | 自动化 ok | field pending |
| Immersive | (S009) | 缺失 | PARTIAL | body.immersive-mode | 自动化 ok | field pending |
| Fullscreen | S092 | CLOSE | CLOSE | 保留 | 自动化 ok | field pending |
| Responsive | S015 | REGRESSION | PARTIAL | 920/620 breakpoints | CSS guard | field pending |

## Metadata

```text
COVER_ALBUM_DETAIL = PASS  (capability-aware route；search fallback 记录)
TITLE_SONG_DETAIL  = PASS
ARTIST_DETAIL      = PASS
```

说明：完整 album/song/artist **detail surface**（S068/S073）仍 MISSING，单独跟踪。Wave 3 恢复点击
affordance（cover button / title / artist，键盘 Enter/Space），点击走 capability-aware `onTrackDetail`，
App 侧以真实搜索路由 fallback（artist→按歌手搜索、song→按曲名搜索、album→按专辑搜索），绝不调用
不存在 route；都不支持 provider 的 detail 能力时保持 affordance 但不产生死点击。

## Lyric Offset

```text
TRACK_SCOPED_OFFSET = PASS   (-0.1/0/+0.1，按 track identity 保存；local/podcast/remote 分命名空间)
RESTART_PERSISTENCE = PASS*  (preferences 持久化；*WebView2 restart 现场待 L5)
```

实现：`lyrics/lyric-timing.ts`（key、clamp ±5s、format、LRU 500）+ `player-shell-store.lyricOffsets`
+ `usePlayerShellRuntime`（prefs 读写）。Offset 通过 `createLegacyVisualComposition` 的
`getLyricOffsetSeconds` 只作用于 stage lyric `currentTimeSupplier`，不修改 LyricPayload、影响
`LyricView`/进度条/粒子/beatmap。本地曲目、provider 曲目、无歌词/翻译/逐字场景沿用统一 view clock
语义（无歌词时按钮按 track key 禁用）。

## Volume

```text
UPSTREAM_VOLUME_FADE_IA = PASS                 (volume main row + 淡入/淡出)
ADVANCED_AUDIO_NO_LONGER_HIJACKS_BOTTOM_BAR = PASS
```

Playback 2.0 / output routing / mirror / virtual bridge 移到 Settings Workbench 的
`audioSettingsSlot`（“音频与输出” boundary，`VisualControlPanelHost` 新增 slot），volume popover
恢复 upstream 226px 紧凑行；fade 参数仍由 canonical `usePlaybackAudioSettings` 持久化并驱动 runtime。

## Golden Validation

```text
states compared: 结构/几何契约（golden JSON 机器可读）+ 结构断言 + CSS 几何 guard
viewport: 1920x1080（golden 记录）；920/620 响应式由 CSS guard 覆盖
pixel result:  待 Layer 3 Playwright pixel diff（未在本轮 closure，诚实记录）
geometry result: Layer 3 自动化 PASS（结构顺序、popover anchor、pill/bar 尺寸、breakpoints）
remaining deliberate differences:
  - Cuefield AutoMix 缺席（OUT）
  - album/song/artist detail surface 未建（S068/S073 MISSING，search fallback）
  - immersive 不自带强制 particle-lyrics（视觉 Wave 职责，记录偏差）
```

资产：`docs/audit/golden/player-shell/`（`upstream-player-shell.json` canonical 结构+几何+交互，
`upstream-default.png` / `upstream-controls-context.png` 参考截图，
`extract-upstream-golden.mjs` 可重建校验 GOLDEN_OK）。

## Field Validation

未执行 packaged Windows/WebView2 candidate 现场（Layer 5 需要真实安装/WebView2/monitor/restart）。
Manifest 已把相关 P1 保留下 blocker 且 `visualVerified/fieldVerified=false`，不冒充 EXACT。待下一个
candidate：normal playback / queue open-close-select / metadata detail / like-collect capability /
quality / lyric offset + restart / volume-fade / auto-hide / immersive / fullscreen / narrow window。

## Playback Regression

```text
normal playback = PASS*   (*自动化；真实媒体 Layer5 待 field)
preview         = PASS    (preview-trial 测试全绿)
Stream Next     = PASS    (stream 相关测试全绿)
resume          = PASS    (checkpoint/restart 测试全绿)
seek            = PASS    (进度回调 path 保留)
mode            = PASS    (循环/单曲/随机/顺序)
queue           = PASS    (playAt/remove/insertNext/moveTrack 全绿)
```

Wave 3 未触碰 playback runtime、deck/gapless/preview/checkpoint 所有权；Bottom Bar 继续消费 canonical
`usePlaybackStore` / `useLyricsStore` / `useUiStore`，没有第二套 playback state。

## Previous Waves Regression

```text
WAVE_0 = PASS
WAVE_1 = PASS
WAVE_2 = PASS
```

确认：
- debug leakage guard：production dist 反向扫描 PASS
- Home / Cover tests / Cover pipeline：全绿（`bun run test` 2421/2421）
- Rust：`cargo fmt --check`、`cargo check --locked`、`cargo test --locked`（568 pass）全部 PASS
- `bun run typecheck` / `bun run web:build` PASS；surface manifest guard PASS

## Remaining Wave 3 Blockers

```text
NONE（code/automated 层）
```

仍为后续 Gate 的（不让本 Wave 误标完成的）：
- Layer 3 真实 pixel golden（Playwright CLI 同视口 upstream/current 像素+盒几何 diff）
- Layer 4 完整路由 App 截图/交互
- Layer 5 Windows + WebView2 现场（列表上方 field 场景）
- S068/S073 详情 surface、S030 AutoMix（分别为独立 surface / 明确 OUT）

## Release State

```text
ARCHITECTURE_CUTOVER = PASS
PRODUCT_PARITY_AUDIT = COMPLETE

WAVE_0 = PASS
WAVE_1 = PASS
WAVE_2 = PASS
WAVE_3 = PASS   (code + automated Layer 3/4 证据；visual/field 分层未过)

RC_READY = NO

NEXT = WAVE_4_VISUAL_CONSOLE
```

`WAVE_3 = PASS` 含义：Player Shell 的 code + Layer 2 component + Layer 3 结构/几何自动证据通过，
且两个 scope decision 已明确（drag-sort IN、Cuefield OUT 并记录偏差）。`RC_READY` 仍为 NO——
S009/S010/S011/S015/S019/S020/S042/S066 等 P1 在 visual/field 证据补齐前保持 `blocker=true`。