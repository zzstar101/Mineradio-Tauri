# Wave 3B Player Shell Closure Report

## Exact Candidate

```text
parent SHA:   52cf8d8009702e2c9853ec3567368fb9063136e1
API SHA:      fb00fafe837a875639b905443115ce16b1abdc96
artifact:     mineradio-tauri-2.1.0-20260829T043503.exe (release, --no-bundle)
artifact SHA256: da01ada3c079b32fbf14515442080906c1f90cfeec03edb6d88cfb8158907fb9
BUILD_ID:     cand-20260829T043503
Windows:      本机（Windows），WebView2 runtime 151.0.4129.107
window:       1440x1080
```

Artifact 元数据存于 `.playwright-cli/wave3/candidate/`（BUILD_ID / PARENT_SHA / API_SHA / SHA256.txt），
exe 本身在 gitignored 目录（SHA 记录可复现）。

## Evidence Consistency

```text
REPORT_SHA_MATCH = YES   （player-shell-wave3-report.md 已更新为 HEAD 52cf8d8 的 lineage）
MANIFEST_SHA_MATCH = YES （wave3bEvidenceNote.parentSha = 52cf8d8 = 该 manifest 提交的 HEAD）
GOLDEN_BASELINE_MATCH = YES（golden 只依赖 upstream 96091d1，与实现 SHA 无关；extract-upstream-golden GOLDEN_OK）
```

## Scope

```text
QUEUE_DRAG_SORT_2_1_SCOPE = IN
CUEFIELD_2_1_SCOPE        = OUT（deliberate deviation，transport 少 cuefield 按钮 → play 中心左移 ~20-25px，已量化）
IMMERSIVE_PARTICLE_LYRICS_2_1_SCOPE = IN（进入沉浸式强制 particle lyrics，退出恢复；save/restore 与 hydration 解耦，含测试）
```

## Layer 3 Visual

Harness：真实 app 路由（vite preview 生产 build）+ 真实本地 MP3 导入启动真实播放；上游 static harness。
1920x1080 dsf=1。每状态：截图 + geometry JSON + ROI pixel/geometry diff（含 roi-diff 叠加图供人工复核）。

| State | Pixel | Geometry | Result |
|---|---|---|---|
| Default | mismatch~7% SSIM低(内容差异) | bar/cover/progress/handle 0px；play cDx -24.5px | PASS-EXPECTED (Cuefield OUT) |
| Volume | 已比 | volume popover width/anchor 一致 | PASS |
| Lyric Offset | 已比 | popover 一致 | PASS |
| Quality | 已比 | chip 位置一致 | PASS |
| Mini Queue | 已比 | popover 位置/尺寸一致 | PASS |
| Auto-hide | 已比 | handle 一致；play cDx -24.5px | PASS-EXPECTED |
| Immersive | 已比 | bar 620、play 64 一致 | PASS |
| 920 | 已比 | bar 一致；play 54 match；cDx -21px | PASS-EXPECTED |
| 620 | 已比 | 单列堆叠布局一致（grid-column:1/order/控制 track 隐藏）；play cDx -20px | PASS-EXPECTED |

Pixel 诚实说明：upstream 是 empty-track 内容、当前是本地 track 内容 + 不同 stage 背景，ROI 内像素差异主要是“内容差异”，结构由 geometry 契约（CSS 权威值经 golden 修正）判定。SSIM 低不代表结构回归。

**本层发现并修复的真实 gap**：
- 旧 Wave 3 CSS 用的 pre-2.1.0 bar（1080/1060px、340/380/400 网格）→ 实际 v2.1.0 是“控制栏自适应”1120px + `minmax(0,1fr) max-content minmax(0,1fr)`。已移植权威 cascade 并修正 golden oracle。
- 920/620 窄布局未移植（缺 grid-column:1 堆叠、control-track 隐藏、order）→ 已修复并与 upstream 620 测量一致。
- 920 `#play-btn` 尺寸被级联异常覆盖 → 用 `!important` 做确定性硬化（immersive 64 同样硬化），当前与 upstream 计算一致。

## Layer 4 Full Product（真实 app 路由）

经 `main.tsx -> App -> 真实 stores/controllers -> PlayerShell`（非 M4/isolated harness），本地导入真实 MP3 启动真实播放：

| Surface | Player Shell result |
|---|---|
| Home（播放启动） | bar visible（z6），cover/metadata 就绪 |
| Search focus/typing | bar 保持 visible、z6、cover 保留（不因 route 丢失） |
| Settings 打开/关闭 | bar 保持，不遮挡、不 remount |
| Visual stage | visual host + canvas 存在 |

`route-full-app.json` 记录了每一步 `barVisible/barZ/cover`。

## Layer 5 Windows/WebView2

按 Floor/真实执行：

| Scenario | Result |
|---|---|
| 精确 candidate 原生启动（Windows） | PASS（进程存活、窗口 title MineRadio-Tauri、WebView2 子进程生成） |
| WebView2 runtime 版本 | 151.0.4129.107 |
| 真实 WebView2 窗口截图 | PASS（`webview2-boot.png`） |
| 交互式字段（lyric offset±0.1、拖排长按、volume/fade slider、auto-hide 鼠标、fullscreen toggle、restart 持久化、桌面窄 960） | PENDING——本机 WebView2 `--remote-debugging-port` 下页面停在 about:blank，无法脚本驱动 packaged WebView2；不打脸冒充 PASS |

## Metadata Detail Semantics（修正，不再写 PASS）

```text
COVER_DETAIL_AFFORDANCE   = PASS（cover button + capability-aware 路由 + 测试）
COVER_UPSTREAM_DETAIL_PARITY = PARTIAL（完整 album detail surface S068 仍 MISSING，search fallback 不是等价 detail）
TITLE_DETAIL_AFFORDANCE   = PASS
TITLE_UPSTREAM_DETAIL_PARITY = PARTIAL
ARTIST_DETAIL_AFFORDANCE  = PASS
ARTIST_UPSTREAM_DETAIL_PARITY = PARTIAL
SEARCH_FALLBACK           = PASS（artist→搜索歌手 / song→搜索曲名 / album→搜索专辑）
```

## Lyric Offset / Queue / Auto-hide / Immersive

```text
TRACK_SCOPED_OFFSET = PASS（-0.1/0/+0.1 按 track key，view clock only）
RESTART_PERSISTENCE = PASS*（preferences 持久化逻辑 + 单元测试；*WebView2 restart 现场待 Layer5 交互打通）
LONG_PRESS_REORDER  = PASS*（自动化 PASS；*WebView2 拖排 field pending）
CLICK_SUPPRESSION   = PASS（drag-sort click 抑制测试）
QUEUE_IDENTITY      = PASS（playback-store.moveTrack 保留对象身份测试）
PLAYBACK_CONTINUITY = PASS*（自动化回归；WebView2 field pending）
IDLE/HOVER/POPOVER/KEYBOARD/IMMERSIVE_INTERACTION = 自动化 PASS；WebView2 鼠标场景 pending
```

## Visual Differences（deliberate deviations）

1. **CUEFIELD OUT**：transport 无 `#cuefield-automix-btn` → play 中心比 upstream 左移 ~20-25px（唯一超容忍 geometry 项，已量化并分类为 PASS-EXPECTED）。
2. **详情 surface 缺位**：S068/S073 MISSING，player metadata 用 search fallback（非等价 detail）。
3. **沉浸式 particle lyrics**：现为 IN（已恢复 upstream 强制粒子歌词并恢复）。
4. **920/620**：桌面主窗口 min_inner_size=960x540 → 920/620 不在桌面可达范围；浏览器 harness 已验证布局一致（浏览器应用场景仍有效）。

## Previous Waves

```text
WAVE_0 = PASS
WAVE_1 = PASS
WAVE_2 = PASS
```

回归：`bun run test` 2426/2426、`bun run typecheck`、`bun run web:build` + debug leakage scan、Rust fmt/check/test、surface manifest guard、Home/Cover 全绿。

## Remaining Wave 3 Blockers

```text
- Layer 5 交互式 WebView2 字段（lyric offset restart、拖排、volume/fade、auto-hide 鼠标、fullscreen、桌面窄 960）
  —— 需要可脚本驱动的 packaged WebView2 环境（或 UIA/自建巡检），本轮环境未打通
- S068/S073 album/song/artist 完整 detail surface（独立 future surface，非本轮）
```

## Release State

```text
WAVE_0 = PASS
WAVE_1 = PASS
WAVE_2 = PASS
WAVE_3 = INCOMPLETE（code + 自动化 + Layer3 视觉 + Layer4 全路由 = PASS；
                     Layer5 交互式 WebView2 字段 = PARTIAL/PENDING）

RC_READY = NO

NEXT = REMAINING_WAVE_3_BLOCKERS（Layer 5 字段条目）
```

Wave 3 代码与视觉已接近收敛；本轮未伪造 WebView2 交互字段结果。
Layer 3 像素/几何、Layer 4 真实路由、候选启动/WebView2/窗口证据均为真实采集。