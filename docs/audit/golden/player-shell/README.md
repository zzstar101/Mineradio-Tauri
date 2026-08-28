# Player Shell Golden — v2.1.0 Upstream

冻结 Wave 3 的 upstream Player Shell / Bottom Bar 产品基线。唯一产品基线：
`XxHuberrr/Mineradio@v2.1.0` peeled commit `96091d123b36783f5604d1acd47b00b0708cabbd`。

## 内容

| 文件 | 含义 |
| --- | --- |
| `upstream-player-shell.json` | Canonical structure + geometry + interaction 机器可读契约（DOM 顺序、角色、popover anchor、z-index、交互语义） |
| `upstream-default.png` | 上游 static 页面默认/展开状态截图（from `.playwright-cli`） |
| `upstream-controls-context.png` | 上游 controls 上下文截图 |

## 状态（每个状态冻结 DOM hierarchy / element order / bounding box / visibility）

| 状态 | DOM/geometry 依据 |
| --- | --- |
| default expanded | `upstream-player-shell.json#structure#nodes#bottom-bar`；`#bottom-bar.visible` opacity .91 |
| collapsed | `#bottom-bar.soft-hidden` / `body.controls-visible`（handle opacity 0） |
| mini queue open | `#mini-queue-popover.show`，`bottom: calc(100% + 14px)`，先于 progress |
| volume popover open | `.volume-popover`，`left 50% bottom 46px`，volume+fade 紧凑行 |
| lyric offset popover | `.lyric-timing-popover`，`-0.1 / 0 / +0.1`，z 8 |
| quality chip | `#quality-control.control-quality-chip` 位于 `#control-title-badges` 内 |
| auto-hide | `#controls-hide-btn.active`；mouse idle/leave → controls condensed |
| immersive | `body.immersive-mode`；隐藏 metadata/utilities；transport+modes 居中 |
| fullscreen | `fullscreen-toggle-btn`；Tauri window command，不改变 shell DOM |
| narrow viewport | `@media (max-width:920px)` controls `minmax(0,1fr) auto minmax(0,1fr)`；620px 单列 |

## 使用

- 组件回归：`apps/web/src/visual/player-shell-golden.ts` 导出 `assertPlayerShellStructure`。
- 再生成：`node scripts/player-shell/extract-upstream-golden.mjs`（从 git 对象重建 JSON）。