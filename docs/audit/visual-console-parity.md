# Visual Console 产品 Parity 审计

## 结论

`REGRESSION / P1 RC BLOCKER`。当前 `VisualControlPanelHost` 并不是 upstream v2.1.0 Visual Console 的复原，而是把其能力重新组织成六 tab 的 `SettingsWorkbench`。参数可写、组件存在和偏好可撤销都不能抵消用户看到的导航层级、默认信息密度、滚动路径、section 顺序和交互模型变化。

运行态截图直接显示：上游标题为“视觉控制台 / MINERADIO VISUALS · 鼠标移开自动隐藏”，默认是连续的折叠 section，并提供“用户存档”；当前标题为“视觉控制台 · 设置工作台”，顶部是搜索、低配、重置、撤销和六 tab，默认只呈现预设与五个主控 slider。

## Surface 对照

| Surface | Upstream v2.1.0 | Current Tauri | 判定 | Evidence |
| --- | --- | --- | --- | --- |
| 外壳与标题 | 右侧连续 Visual Console | “设置工作台”应用壳 | REGRESSION | upstream `public/index.html:329-354`; current `VisualControlPanelHost.tsx:1218-1236` |
| 信息架构 | 按上游顺序展开/折叠 sections | 六 tab：常用/界面/歌词/动效/歌单架/系统 | REGRESSION | `SettingsWorkbench.tsx:73-85` |
| 默认首屏 | 预设、用户存档、恢复与整理 | 预设 + 五个主控，历史 0/40 | REGRESSION | 两张运行态截图 |
| 视觉预设 | 9 个上游 preset，带原命名/作者表达 | 9 个参数入口，名称与说明被改写 | PARTIAL | S045 |
| 用户存档 | 多槽、保存/应用、JSON/短码导入导出 | 不存在；undo history 不是存档 | MISSING | upstream `07-fx/00-preset-archive-data.js`; matrix 已承认 `visual.archive missing` |
| 主控/FX | master sliders、FX、频谱 monitor 与原 sections 共存 | 参数分散到 tabs，部分参数存在 | PARTIAL | current controls around `VisualControlPanelHost.tsx:1239+` |
| accent/tint/color lab | swatch、picker、cover-derived colors、lab popover | 有部分颜色 preference，控件组合与层级不同 | PARTIAL | S050 |
| 背景媒体/颜色 | upstream 原 section、状态与清除动作 | 当前 controls 存在但重新分类 | PARTIAL | S051 |
| cover picker/clarity | 同一视觉工作流内 | 参数存在，入口/回退路径不同 | PARTIAL | S052 |
| 歌词显示 | single/dual/triple、翻译、motion、glitch、font、colors | 部分能力存在并重新分组 | PARTIAL | S053 |
| Stage/Shelf camera | stage/shelf mode、camera/presence/content | 部分 slider/segmented controls，且部分被移到底栏 | PARTIAL | S037/S056 |
| 摄像头手势 | HUD、permission、掌推/捏合/握拳 | 无 adapter、permission 或 UI | MISSING | upstream `public/index.html:928-933` |
| Sonic Topography | preset、频谱 monitor、颜色/浮动 | engine 与 controls 有代码证据，视觉实机仍未比对 | CLOSE | S054 |
| Sonic Workshop | 独立场景 | 当前独立实现，WebView2 观感未验证 | CLOSE | S055 |
| Wallpaper library | 搜索、grid、详情、星标、隐藏/恢复 | 仅列前 8 项，无完整管理 UI | PARTIAL | `WallpaperEngineControls.tsx:55-67` |
| WGC glass | Windows capture sampler | adapter 固定 unsupported | MISSING | `wgc_sampler.rs:23-33` |
| Performance controls | upstream background/lyrics/wallpaper FPS | 当前有 performance settings，但分组和语义不同 | PARTIAL | S059 |
| Hotkeys | local/global 录入、冲突、重置 | Rust 注册能力存在，用户 editor 不存在 | MISSING | upstream `07-fx/06-hotkeys.js:158-230` |
| Panel open/hide | FAB + mouse-leave auto-hide + DIY coupling | 基本交互存在 | CLOSE | S046 |

## “参数存在”不等于 UI Parity

以下能力在当前 store/engine 中可找到参数，但对应上游 UI 没有被复原：master/clarity/camera/glow sliders、部分 lyric display/motion/colors、background、accent、Shelf mode、performance tier。它们应计为 `Code Present` 或 `PARTIAL`，不能计为 `Visual Verified`。

当前新增的搜索、低配模式、40 条 undo history 与事务式 reset 有实际价值，但它们是 Tauri 扩展。只要 upstream v2.1.0 仍是唯一视觉基线，这些扩展不能替代上游的 section composition、用户存档、camera gesture、hotkeys 和 wallpaper library。

## False-positive 来源

- `docs/parity/capability-matrix.md` 把 `settings.workbench` 标作 parity，却同时承认 `visual.archive`、`visual.camera-gesture`、`hotkeys.editor` 缺失。
- M8 设计要求六 tab，并错误地把 upstream archive 当空壳；tag 源码实际包含完整存档流程。
- `VisualControlPanelHost.test.tsx` 主要做 HTML substring/节点存在性断言，甚至把“不含 camera gesture”固定成通过条件；它不比较 upstream DOM、computed style、geometry、scroll path 或交互。
- M4 截图采集没有 upstream golden 的像素或几何比较。

## 修复验收条件（仅计划）

1. 先冻结 upstream Visual Console 的 DOM/section 顺序、默认展开态、panel width、edge behavior 和每个控件的视觉 golden。
2. 将上游缺失能力与仅 UI 缺失分开：archive/hotkeys/camera/WGC 是 capability 缺口；多数 master/lyrics/background 是 UI composition 缺口。
3. 以完整 App route 在相同 viewport、相同 synthetic state 下做 upstream/current 截图和几何容差比较，不再使用 isolated fixture 代替产品 surface。
4. Tauri 扩展只能作为附加 section，不得重排或覆盖 upstream 默认路径，除非另有明确产品决策。

