# M4 Engine / Component Smoke Evidence

> **Authority boundary:** 该 fixture 只证明 isolated Stage/Sonic/Shelf engine 与 component smoke/resource contract；不证明 full App、上游视觉、产品 parity 或 RC readiness。

该 runner 通过 `@playwright/cli` 驱动真实 Edge/Chromium，调用仅由 Vite development server 提供的独立 `m4-fixture.html` test entry，不加载普通 `App`、账户状态或 production bootstrap。该 fixture 不进入 production build。

## 运行

启动独立 development/test fixture server（不要使用 production preview）：

```powershell
bun run --filter ./apps/web dev -- --host 127.0.0.1 --port 4173 --strictPort
```

另一个终端执行 quick evidence：

```powershell
node scripts/parity/m4/capture-evidence.mjs
```

Release soak 与硬门：

```powershell
node scripts/parity/m4/capture-evidence.mjs --profile release --strict `
  --baseline-frame-p95-ms 1.25 `
  --baseline-gpu-p95-ms 0.42 `
  --baseline-source-commit "BASELINE_COMMIT" `
  --baseline-source-manifest "C:\path\to\baseline\manifest.json"
```

上例数字仅展示参数格式，不能直接作为本机 baseline。Sonic strict run 必须使用同一台机器、
同一浏览器、`1920×1080`、DPR 1、相同 quality 与 release profile 采集的当前 Tauri baseline；
不要把 dirty quick evidence 或其他机器的数据填入 release 门禁。baseline 数值、source commit、
source manifest 绝对路径和完整 CLI
都会写入 scene evidence 与 manifest，任一 baseline p95 或来源缺失时 fail closed。

如果 preview 使用其他端口：

```powershell
node scripts/parity/m4/capture-evidence.mjs --base-url http://127.0.0.1:4174/
```

脚本默认使用 `msedge`、`1920×1080`、DPR 1、`zh-CN`、
`Asia/Hong_Kong`、deterministic scheduler 和 seed `20240728`。每个场景使用
独立 Playwright CLI session，并在结束时只关闭自己的 session。

quick profile 的 Sonic fixture 默认显式使用 `quality=eco`；release profile 默认显式使用
`quality=high`，也可通过 `--sonic-quality ultra` 运行 ultra 硬门。quality 会同时进入 URL、
runtime snapshot、scene evidence 和 manifest。release strict 不接受 eco/balanced，避免把 high
预算无说明地套到轻量 fixture。

## 产物

默认目录为 `output/playwright/m4/`：

```text
manifest.json
stage/
├─ stage-steady-4200ms.png
├─ stage-after-seek.png
├─ stage-seek-transition.webm
└─ evidence.json
sonic/
├─ sonic-<quality>-1920x1080.png
└─ evidence.json
shelf/
├─ shelf-600x600-soak.png
└─ evidence.json
```

`manifest.json` 和各场景 `evidence.json` 记录：

- commit、branch、dirty 状态和完整 CLI 命令；
- 浏览器版本、UA、viewport、DPR、字体、WebGL vendor/renderer；
- `performance.frames` 与 gate p50/p95；
- resource current/peak/budget/pressure；
- task queue 与 subsystem diagnostics；
- Three.js renderer draw/memory counters；
- Stage、Sonic、Shelf 的结构硬门。

Release strict 还会拒绝：dirty worktree、preview 内嵌 build commit 与当前 HEAD 不一致、
任一场景 console error 非零，以及缺少真实 GPU timer-query 扩展、完整 240 样本窗口或有效
p95。`--strictPort` 确保旧 4173 preview 不会被 Vite 静默绕到其他端口。

Sonic release 硬预算直接来自 M4 设计：

- high 1080p：Sonic gate CPU p95 `≤1.5ms`，GPU p95 相对 baseline 增量 `≤5ms`；
- ultra 1080p：Sonic gate CPU p95 `≤2.5ms`，GPU p95 相对 baseline 增量 `≤8ms`；
- 整体 frame p95 `≤baseline × 1.10`；
- 阈值比较为闭区间，恰好等于阈值通过；当前值、baseline 或来源缺失均失败。

## GPU 计时语义

证据页已把真实 `GpuFrameTimer` 接入 production presentation seam。它围绕正式 renderer
presentation 发起 `EXT_disjoint_timer_query_webgl2` query，并在后续帧非阻塞回收结果。

- 只有 query 已 resolved、GPU 未处于 disjoint 状态、`sampleCount > 0` 且 p50/p95
  均为有效值时，才记录 `gpuTiming.status = "measured"` 与 `measured=true`；
- 扩展可用但尚无有效样本时记录 `status = "proxy"`、`measured=false`，CPU frame
  cost、draw calls、triangles/points/lines 仍只是 proxy；
- 扩展不可用时记录 `status = "unavailable"`，release strict 直接失败；
- disjoint query 会被丢弃，不能伪造为有效 sample；
- `--profile release --strict` 要求固定采样缓冲完整达到 `sampleCount >= 240`；样本不足、
  p95 缺失或超过 quality 对应预算时必须失败。

因此，扩展能力探测不能代替真实 GPU 测量，proxy 数据也不能称为 GPU p95。

## 验证 runner

```powershell
bun test scripts/parity/m4 --parallel=1
node --check scripts/parity/m4/capture-evidence.mjs
git diff --check -- scripts/parity/m4
```
