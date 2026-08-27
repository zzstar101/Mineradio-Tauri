# MineRadio 三版本性能开销对比（历史 Sidecar 基线）

> 本文记录 2026-07-02 的旧 Bun Sidecar 架构测量，只用于历史对照。2.1.0 已切换到 in-process `MineRadio-api`；其中 Sidecar polling 指标不是当前 runtime 指标，不能作为 native 架构的 release baseline。

生成时间: 2026-07-02T09:42:35.701Z

## 版本

| 版本           | Ref     | 量测路径                                                                         |
| ------------ | ------- | ---------------------------------------------------------------------------- |
| Electron 原项目 | 6b13010 | C:\Users\zhanw\AppData\Local\Temp\mineradio-perf-worktrees\electron-original |
| Tauri 优化前    | 9d590d2 | C:\Users\zhanw\AppData\Local\Temp\mineradio-perf-worktrees\tauri-baseline    |
| Tauri 当前优化版  | HEAD    | C:\Users\zhanw\AppData\Local\Temp\mineradio-perf-worktrees\tauri-optimized   |

## 初始页面负载 (Electron 离屏窗口，同 1280x720)

| 版本           | DOM 节点 | JS Heap MiB | Electron RSS MiB | CPU % | 导航 ms  | 资源数 |
| ------------ | ------ | ----------- | ---------------- | ----- | ------ | --- |
| Electron 原项目 | 1243   | 12.2        | 566.4            | 0.28  | 1075.6 | 9   |
| Tauri 优化前    | 712    | 14.4        | 414.3            | 0.37  | 302.8  | 8   |
| Tauri 当前优化版  | 712    | 14.7        | 500.7            | 0.28  | 257.7  | 8   |

当前优化版相对 Tauri 优化前: 初始 JS Heap 变化 +2.4%，Electron RSS 变化 +20.9%，CPU 样本变化 -23.5%。
当前优化版相对 Electron 原项目: 初始 JS Heap 变化 +20.4%，Electron RSS 变化 -11.6%，CPU 样本变化 +1.2%。

## Tauri 热点渲染开销

| 场景         | 优化前 rows | 优化后 rows | rows 下降 | 优化前 DOM | 优化后 DOM | DOM 下降 | CPU ms 变化 | Wall ms 变化 |
| ---------- | -------- | -------- | ------- | ------- | ------- | ------ | --------- | ---------- |
| 队列面板 240 首 | 240      | 13       | 94.6%   | 2659    | 162     | 93.9%  | -82.0%    | -76.5%     |
| 歌单详情 600 首 | 600      | 15       | 97.5%   | 3039    | 114     | 96.2%  | -100.0%   | -83.5%     |
| 播客集合 180 个 | 180      | 13       | 92.8%   | 917     | 82      | 91.1%  | -100.0%   | -42.9%     |
| 迷你队列 240 首 | 240      | 12       | 95.0%   | 2034    | 210     | 89.7%  | -79.5%    | -82.9%     |
| 歌词视图 240 行 | 240      | 17       | 92.9%   | 242     | 19      | 92.1%  | -100.0%   | -56.8%     |
| 搜索结果 180 首 | 180      | 12       | 93.3%   | 3084    | 228     | 92.6%  | -92.1%    | -82.7%     |

## Depth / 轮询 / 构建产物

| 指标                            | 优化前      | 优化后      | 变化        |
| ----------------------------- | -------- | -------- | --------- |
| depth 热路径新增大 Float32Array 次数  | 6        | 0        | 100.0%    |
| depth 热路径新增大 Float32Array MiB | 1.50     | 0.00     | 100.0%    |
| 隐藏稳定 sidecar 轮询间隔 ms          | 24000    | 60000    | 150.0% 间隔 |
| 隐藏稳定 sidecar 轮询频率             | 2.50/min | 1.00/min | 60.0%     |
| 前端产物总 MiB                     | 1.58     | 1.59     | +0.5%     |
| 前端 JS MiB                     | 1.48     | 1.48     | +0.5%     |

## 结论

- 当前优化版在大列表渲染上收益最明显: 队列 rows 下降 94.6%，歌单详情 rows 下降 97.5%，播客集合 rows 下降 92.8%，迷你队列 rows 下降 95.0%，歌词视图 rows 下降 92.9%，搜索结果 rows 下降 93.3%。
- Depth 连续构建热路径新增大 scratch 分配从 6 次降到 0 次，大数组新增分配下降 100.0%。
- 隐藏且 ready 的 sidecar 状态轮询频率从 2.50/min 降到 1.00/min，稳定后台轮询下降 60.0%。

## 历史建议（不属于 2.1.0 收敛范围）

- 将我的歌单概览页做扁平化虚拟列表，处理多平台歌单很多时的 DOM 压力。
- 继续收敛 cover depth 的临时 canvas 与 ImageData 分配，优先复用归一化 canvas，避免连续切歌时触发额外 GC。
- 给 AI depth 增加尺寸/来源维度的 LRU 和失败冷却，避免同封面不同 URL 参数重复估计。
- 加一个 CI 可跑的轻量 perf budget，只检查 DOM rows、depth 大数组次数、关键 bundle size，避免性能回退。

## 限制

- 初始页面负载使用同一个 Electron 离屏窗口加载三版页面，适合比较前端页面负载，不等价于最终 Tauri/WebView2 发布包的完整桌面进程占用。
- 热点渲染开销只对 Tauri 优化前后同组件同输入比较；Electron 原项目是单文件前端，无法和 React 组件做一一对应挂载量测。
- CPU 样本是短窗口采样，绝对值会随机器后台负载波动，重点看同机同脚本的相对变化。
- Sidecar polling 数据只描述已经退役的进程架构；当前 native baseline 由 `bun run perf:budget` 与 `bun scripts/perf/m10-runtime-benchmark.mjs --quick` 重新生成并记录在 2.1.0 Convergence Report。
