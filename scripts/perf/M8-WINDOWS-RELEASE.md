# M8 Windows release performance evidence

> **Authority boundary:** M8 deterministic gate 只证明 synthetic deterministic resource/performance budget；它不能证明 Stage Lyrics Windows/WebView2 transition performance，也不能单独决定产品 parity 或 `RC_READY`。Stage transition field authority 见 `docs/audit/stage-lyrics-performance.md`。

这个 runner 只用于正式 Windows release 构建，不进入普通 PR 的确定性门禁。它会：

- 启动目标程序 5 次，以主窗口出现为 ready signal，报告冷启动中位数；
- 每轮先预热 10 秒，再按 1 秒间隔采集 60 秒，共 3 轮；
- 汇总 MineRadio 根进程及其子进程树的 CPU、Working Set 和 Private Bytes；
- 可通过安装包路径记录 package size；
- GPU memory、p50/p95 frame time 可从人工或外部采集 JSON 补入。

```powershell
bun run perf:m8:windows -- `
  --exe "D:\release\MineRadio-Tauri.exe" `
  --package "D:\release\MineRadio-Tauri_0.1.0_x64-setup.exe" `
  --manual scripts/perf/m8-windows-release-manual.example.json
```

输出默认写入 `output/perf/m8-windows-release-evidence.json`，其机器可读契约位于
`scripts/perf/m8-windows-release-evidence.schema.json`。

`--strict` 只用于晋升 `Field Validated / Release Verified`。GPU/frame、真实低配实体机、
WebView2 升级目录或 Windows soak 未完成时，manifest 会明确记录
`field-validation-pending`。这些项目是 non-blocking，不阻止 M8 Code Complete。

人工证据要晋升为 `captured` 时：

- GPU 必须提供 `medianBytes` 与 `peakBytes`；
- frame time 必须提供 `p50Ms` 与 `p95Ms`；
- 低配机与升级验证必须提供 `verified: true` 和非空 `artifactPaths`；
- Windows soak 还必须提供至少 `1800` 秒的 `durationSeconds`。

runner 会终止它自己启动的 exact 根进程树。采集前应关闭已有 MineRadio 实例，避免
single-instance 激活使主窗口 ready signal 失真。
