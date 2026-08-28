# Stage Lyrics Transition 性能审计

## 结论

`REGRESSION / P1 RC BLOCKER`，但当前仓库无法给出可信的真机数值。代码已经确认存在与用户报告一致的 hitch 机制；p95/p99/max/GPU 数值必须在 Windows/WebView2 release candidate 上测，不能由平均 FPS 或 isolated M4 fixture代替。

## 机制证据

1. `stage-build-coordinator.ts:190-202` 只在 phase 返回后记录耗时并增加 `overBudgetPhaseCount`；默认 `8ms` 阈值既不抢占、不 yield，也不 fail release。
2. 预热路径 `lifecycle.ts:1494-1518` 的 phase 0 只返回 continuation，phase 1 一次执行完整 `buildLyricForText`。
3. 当前行 miss 路径 `lifecycle.ts:1737-1747` 同样在一个关键 phase 内完成 build。
4. `lyric-builder.ts:261-380` 在同一续体创建 mask/glow/readability canvas、CanvasTexture、多组 geometry/material、typed arrays 和 sparks。
5. upload gate 把 texture upload 数量限制为每帧一个，但没有对单次 `initTexture` 的时长设预算；CPU build 与 upload 仍可能在 transition 邻近帧叠加。
6. persistent row cache/prewarm 可以降低命中时成本，但 cache miss、窗口不足、快速 seek、逐字/译文变化仍进入关键 build。

因此 `overBudgetPhaseCount` 是观测值，不是防卡顿机制。旧 D1 `complete` 和 `lyrics.stage-v2 implemented` 不能证明 transition 性能。

## 风险分解

| 项目 | 当前证据 | 风险判断 | 所需测量 |
| --- | --- | --- | --- |
| lyric group build | 单 phase 完整 build | Confirmed risk | phase duration、调用栈 |
| structured raster | canvas/text 同步生成 | Confirmed risk | raster duration/尺寸/字数 |
| CanvasTexture creation | 每组多个 texture | Confirmed risk | allocations、GC、texture count |
| GPU upload | 每帧一个但无时长预算 | High risk | upload CPU + GPU timing |
| geometry/material rebuild | 每行创建多对象 | Confirmed risk | allocation bytes、compile/upload |
| outgoing disposal | takeover 周边执行 | High risk | disposal duration、GPU objects |
| clarity pool | 有复用机制 | PARTIAL mitigation | hit/miss/eviction |
| atomic takeover | 避免闪空 | Behavior positive | takeover timestamp/cost |
| prewarm window | 有 persistent row window | PARTIAL mitigation | hit rate、lead time |
| React + WebGL 同帧 | 尚无 trace 关联 | UNVERIFIED | React commit marks + RAF |
| karaoke/translation | 更多 metrics/raster 内容 | High risk | scenario split |
| GC | 多 canvas/typed arrays/objects | UNVERIFIED | allocation timeline/GC pause |

## 真实 transition profiling 方案

### 场景

在同一 Windows/WebView2 release build、同一 GPU/电源模式下至少跑：普通 LRC、双语、逐字 karaoke、长行换行、快速 seek 导致 cache miss、正常预热命中、cover 同时变化。每场景 50 次 N→N+1 transition，前 10 次 warm-up 不计。

### 埋点

- 以 lyric index commit 为 `t0`，采集 `[t0-500ms, t0+500ms]` RAF intervals。
- Performance marks：queue、prewarm start/end、raster start/end、builder start/end、texture create、upload start/end、takeover、outgoing dispose、cache hit/miss。
- `PerformanceObserver` longtask；Chrome/WebView2 trace 的 Main、Renderer、GPU lanes；React commit marks。
- 每 transition 记录 canvas/texture/geometry/material 数、分配字节、GC pause、GPU frame time。

### 建议 gate

硬件相关指标同时采用绝对线和同机 upstream 差值：

| Metric, transition ±500ms | 候选阈值 |
| --- | --- |
| frame p95 | `<=16.7ms` 且不高于 upstream +2ms |
| frame p99 | `<=25ms` 且不高于 upstream +4ms |
| max frame | `<=50ms` |
| frames >16.7ms | 不高于 upstream +2/transition |
| frames >33ms | `<=1/transition` |
| long tasks >=50ms | `0` |
| stage build phase peak | `<=4.2ms`; `>8ms` hard fail |
| texture upload CPU peak | `<=3ms`，且每帧最多 1 次 |
| prewarm hit rate（顺播） | `>=95%` |
| GPU frame p95 delta | 不高于 upstream +10% |

阈值是建议的验收 contract，不是本轮实测结果。若低配设备无法满足绝对线，应先固定分层硬件基线，而不是删除指标。

## 自动化 gate 设计（仅计划）

1. Coordinator 单测新增 hard budget outcome，不能只断言计数增加。
2. Builder 拆 phase 后，用 deterministic fake clock 验证任何 phase 不包含完整 raster+geometry+material 链。
3. Full App 测试 route 使用真实 store/controller 和 stage engine；M4 isolated fixture仅保留为 component/engine smoke。
4. Windows runner 输出逐 transition 原始 JSON 与 trace artifact，release gate 读取 p95/p99/max/over-count，不读平均 FPS。
5. 性能报告必须区分 cache hit/miss、karaoke/translation 和 cover change，不得合并成单个平均值。
