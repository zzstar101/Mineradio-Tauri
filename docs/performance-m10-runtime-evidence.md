# M10 Runtime Performance Evidence

> **Historical runtime evidence only.** Headless/synthetic M10 数据不证明完整产品 parity、Windows/WebView2 Stage Lyrics transition performance 或 RC readiness；当前权威见 `docs/audit/2.1-surface-manifest.json` 与 `docs/audit/stage-lyrics-performance.md`。

本文件区分 deterministic/code evidence、Tier 2 headless benchmark 与真实 Windows WebView2 field evidence。没有采到的指标明确写为 `Not Measured`。

## Before / After

| signal | before (code evidence) | after (code evidence) | field result |
| --- | --- | --- | --- |
| React root playback position subscription | `App.tsx` directly subscribed to `positionMs` (60Hz path) | `usePlaybackUiPosition()` publishes bounded 125ms snapshots; seek jumps publish immediately | Not Measured in WebView2 |
| UI position publication | every store `timeupdate` | 7–9 publications per synthetic 60Hz second | automated test |
| visual foreground scheduler | every presentation frame for all quality tiers | eco 30fps, balanced 45fps, high 60fps, ultra vsync-compatible quality-tier gate; media clock never throttled | Tier 2 A/B below |
| inactive heavy surfaces | all overlays permanently mounted (DOM + hook subscriptions while closed) | `AccountOverlaySurface` lazy-mounted on `modalOpen`（模块级共享 store 保证重挂载即同步）；其余 4 个候选经证据评估保留（SSR/DOM-presence 测试契约或内部已零输出），新增 `app-shell-mount-discipline` 守卫锁定 runtime-owning surfaces 永不被条件卸载 | Tier 2 DOM 计数稳定 |
| local library import | session-only blob，重启丢失 | Rust persistent index + protocol streaming；无 unbounded Blob URL；bounded 并发/限额 | Windows soak Not Measured |
| Three.js calls/triangles/textures | Not Measured | existing `renderer.info` collector contract retained | Not Measured (headless 无 WebGL context) |
| WebView2 CPU/GPU/RSS/private memory | Not Measured | Not Measured | **Not Measured**（headless Chromium 无法代表 WebView2 compositor） |
| long-run resource plateau | deterministic resource ledgers only | deterministic ledgers remain bounded | Windows soak Not Measured |

## Tier 2 Headless Benchmark（真实测量，非推断）

工具：`scripts/perf/m10-runtime-benchmark.mjs`（Playwright Chromium → msedge channel，headless，1600×900@1，production vite preview）。原始 JSON：`output/perf/m10-final.json`（commit `2d9e065+M10 worktree`，dirty）。

| scenario | dur s | fps effective | fps p50/p95/p99 | dropped ratio | longtasks | heap Δ MiB / max MiB | dom Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| home-default | 15 | 240.0 | 238.1 / 232.6 / 232.6 | 0.0% | 0 / 0ms | +1.90 / 23.00 | 1188→1188 |
| home-high（ultra tier 经真实 UI 应用） | 15 | 240.0 | 238.1 / 232.6 / 232.6 | 0.0% | 0 / 0ms | −1.39 / 24.35 | 1191→1191 |
| search-interaction（114 keys + 36 wheel scrolls） | 15 | 235.9 | 238.1 / 232.6 / 120.5 | 1.2% | 0 / 0ms | +6.97 / 30.23 | 1188→1189 |

解读边界（不得过度声明）：
- 显示器为 240Hz；idle 场景 vsync 打满且零掉帧——**quality-tier 调度器在 idle 下未引入退化**；eco/balanced 档的降帧收益需在 GPU 有负载时才有意义，headless 无法复现（记为 field-pending）。
- search-interaction 的 p99 掉到 120.5fps / dropped 1.2% 来自输入事件风暴下的真实交互成本，属正常范围。
- 长任务 0：无主线程阻塞尖峰。
- 该数据是 Chromium headless，**不是 WebView2 compositor**。Tier 3（WebView2 release 证据）仍 pending。
- 冒烟基线（同 harness，5s 场景，`output/perf/m10-smoke.json`）：search dropped 29%（36 keys/10 scrolls，更密集的早期版本）→ 正式运行放宽交互节奏后 1.2%，说明 dropped 主导因素是输入速率而非渲染回归。

## Evidence Commands

```text
bun test --parallel=1                       # 全仓 deterministic（2660 pass）
bun run typecheck                           # 四 workspace
bun run web:build                           # production bundle
bun run perf:budget                         # M8 deterministic gate
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked   # 592 pass
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
bun scripts/perf/m10-runtime-benchmark.mjs [--quick] [--skip-build]    # Tier 2
```

The M8 deterministic gate is Tier 1 evidence. Tier 2 above is real measured data on Chromium headless. Tier 3 (Windows WebView2 GPU/compositor/RSS) remains pending and must not be inferred from any of these.
