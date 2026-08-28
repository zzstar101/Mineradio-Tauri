# Parity Verification False-positive 审计

## P0 结论

当前验证体系能证明大量内部 contract 和 resource invariant，但不能证明 upstream v2.1.0 产品 parity。最主要的错误是把 **code present / self-consistent fixture / architecture invariant** 提升为 **full product visual or field parity**，再由文档自动汇总成 `complete` 或 `release-convergence`。

## 现有证据实际上验证了什么

| Evidence | 实际验证范围 | 没有验证 | 处置 |
| --- | --- | --- | --- |
| shared Zod/unit tests | JSON 结构、默认值、部分边界 | provider 语义、URL 可用、真实账号/CDN | KEEP，标 Layer 1；补 semantic fixtures |
| Rust API/provider unit tests | mapper/adapter 在 fixture 上的结构行为 | 真实上游响应、登录态、CDN、字段语义完整性 | KEEP，标 Layer 1；加用户确认 samples |
| architecture guards | import/command/ownership/transport 文本 invariant | UI 像素、交互、性能、provider 可用性 | KEEP；修正错误 invariant |
| `wallpaper-engine-web-boundary.test.ts` | 当前 hostname 字符串存在 | opaque URI contract | REWRITE；它正在固定违规解析 |
| `VisualControlPanelHost.test.tsx` | HTML substring、控件存在 | upstream DOM、布局、默认展开、camera/archive | REWRITE；删除“缺 camera 即通过”的错误 oracle |
| `PlayerConsoleHost.test.tsx` | ID/path/按钮字符串存在 | DOM 顺序、metadata 详情、popover、尺寸/hover | REWRITE 为真实 component behavior + visual |
| M4 parity route | isolated stage/shelf runtime、自身 fixture 数值 | 普通 App、账号、shell、Visual Console、真实歌词 transition | KEEP 为 engine smoke；改名并禁止声称 product parity |
| M4 screenshots | runner 成功截图 | upstream/current pixel/geometry 差异 | REWRITE：加入 upstream golden 和 image/geometry gate |
| M4 evidence model | resident/pending/upload count 等 runtime invariants | peak phase、`overBudgetPhaseCount`、p95/p99/max/longtask | REWRITE |
| M8 perf gate | synthetic Home/Search/Settings、DOM/资源上限、平均帧 | 切词 ±500ms、WebView2/GPU、真实媒体与 provider | KEEP deterministic budget；增加独立 transition gate |
| M9 transport guards | Sidecar/localhost 未复活、command contract | provider 行为/可用性 | KEEP，不能升级成 provider parity |
| M10 delta audit | 被选中的 2.0.3→2.1 delta 与架构映射 | v2.1 全产品 surface | KEEP 为 delta record，不能替代 inventory |
| capability matrix | 当前代码/计划/旧证据的登记 | visual/field truth | REWRITE status model，禁止 `implemented` 单列成为完成 |
| `reviewed-delta-status.md` | 旧汇总结论内部一致 | 当前 product parity | RETIRE 其 release authority；保留历史记录并标 superseded |
| convergence report | 当时 branch/test/build/signing状态 | 当前 HEAD、upstream exhaustive parity | RETIRE 其当前 release authority；不可硬编码结论 |

## 已确认的 false-positive 例子

1. `settings.workbench` 被记为 parity，但运行态是六 tab 重设计，且 archive/camera/hotkeys 明确缺失。
2. D1 / `lyrics.stage-v2` 被记 complete，但关键 build 仍单 phase，门禁不读取 peak 或 over-budget count。
3. `available:true/message:online` 静态 capability 把 adapter 存在冒充 provider 可用。
4. M4 fixture 不加载普通 App，却被用于支撑整个 Lyrics/Visual parity。
5. Player/Visual unit tests只验证字符串存在，无法发现当前 bottom bar/console 的结构回退。
6. `provider.spotify blocked_by MineRadio-api` 与源码矛盾：API 已注册，shared/bridge/UI 才是当前 contract 缺口。
7. `reviewed-delta-status.md` 一边列出多个 P1 missing/partial，一边声称唯一 blocker 是 protected release environment。

## 新验证分层

| Layer | 名称 | 允许声称 | 必须产物 |
| --- | --- | --- | --- |
| 1 | Contract / Unit | Code Present、结构或纯函数正确 | unit results、schema/semantic fixtures |
| 2 | Component Behavior | 单个组件的状态与事件正确 | mounted component、keyboard/pointer/state tests |
| 3 | Visual Regression | 单 surface 在固定状态接近 upstream | upstream golden、current image、pixel + geometry thresholds |
| 4 | Full Product Surface | 真正 App 组合中的导航、z-index、响应式和交叉状态正确 | full-route scenarios、surface inventory coverage |
| 5 | Windows/WebView2 Field | native window/media/provider/真实文件与网络可用 | signed/near-release build、field matrix、screenshots/logs |
| 6 | Performance Field | 用户关键时刻无回退 | traces、raw samples、p95/p99/max/GPU/longtask gates |

只有 Layer 3 + 4 可以声明 `Visual Verified`；只有 Layer 4 + 5 能支持行为 `Product Parity`；性能相关必须再有 Layer 6。Layer 1/2 全绿只能声明自动验证完成。

## 状态模型

每项证据分开记录：`Code Present`、`Automated Verified`、`Visual Verified`、`Field Verified`。产品结论使用本轮限定状态：`EXACT`、`CLOSE`、`PARTIAL`、`MISSING`、`REGRESSION`、`DEBUG_LEAKAGE`、`UNVERIFIED`。任何后层缺证据都不能由前层推导。

Provider capability 还必须拆为：adapter registered、runtime configured、login required/status、request sample verified、field verified。静态 `available:true` 不得进入发布判断。

## CI / evidence 迁移顺序（仅计划）

1. 先停止旧文档作为 release authority；保留文件并加 superseded 链接，不机械删除。
2. 修正会固定错误架构或缺失能力的 guards。
3. 将 M4 改名为 engine fixture evidence，从 production entry 移除。
4. 建立 101-surface manifest，CI 要求每项有 owner、status、证据层和 blocker。
5. 优先为 Visual Console、Player Shell、QQ cover、provider capability、歌词 transition 建立新 oracle。
6. 完成 Windows/WebView2/provider/performance evidence 后才重新计算 RC。
