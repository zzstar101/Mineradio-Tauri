# Mineradio 2.1.0 Convergence Report

> **SUPERSEDED / HISTORICAL.** 本报告记录当时分支、构建与架构 convergence，不是当前 HEAD 的产品 parity 或 RC authority。2.1 权威见 `docs/audit/2.1-product-parity-audit.md` 与 `docs/audit/2.1-surface-manifest.json`；本报告不能单独决定 `RC_READY`。

生成日期：2026-08-28

## 1. Final Git State

| Item | Value |
| --- | --- |
| Branch | `integration/2.1.0` |
| Main base | `72cddfe3da3ddd2f2e3d9b6db4f855878c00c31d` |
| PR #67 tip | `f8686b1b86b2690c81821d49f590550101cc675a` |
| Integration merge | `3281fe0ca50e5e1ff8dd202b6b754f45e93f0526` |
| Convergence commit | `acad8b9f17dc4ffe16931954b414ce572ccba414` |
| MineRadio-api submodule | `eb3463e7118fb69e7b785b77a33e48f6a12732ac` |
| Product version | `2.1.0` in all four release-controlled manifests |
| Dirty state | Clean after the report and release-version commits |

### Repository Safety Snapshot

- 未删除任何 worktree、stash 或 unreachable object。
- 保留 `stash@{0}` / `456fb0796b13c2266eb52013bac817c4a9f20e84`。
- 既有有价值 WIP 均位于 `refs/archive/pre-2.1/unreachable-*`。
- 集成前未提交工作树额外归档为 `refs/archive/pre-2.1/integration-wip-20260828`，指向 `4ea2d5b02622cd1722966c1ddbb8625cc63ea7fa`。
- 多个 auxiliary、detached 与 prunable worktree 原样保留，没有执行 prune。
- `git fsck --unreachable --no-reflogs` 未发现尚未被 archive ref 保护的 unreachable commit。

## 2. #67 Integration Result

PR #67 已通过 merge commit `3281fe0` 集成到 M10 基线，形成以下 production path：

```text
Web Application Ports
  -> compatibility SidecarClient
  -> Tauri invoke("api_call")
  -> Rust api_bridge
  -> in-process mineradio_api::Api
  -> Provider
```

主要集成模块包括 native API bridge、媒体协议、Kugou capability/QR login、playlist `hasMore`、previewRange、Stream Next、启动恢复、local library、provider ordering 和 updater quiescence。

Git remerge 识别到的语义冲突位于 `Cargo.lock`、Rust `lib.rs`、`tauri.conf.json`、账号 provider order 组件/测试、root `package.json` 与 M9 architecture guard。解决方式是保留 M10 的 local-library/preferences/updater/audio ownership，同时接入 native API state/commands、Kugou capability 和 Sidecar removal；`externalBin` 保持为空。

没有保留双 transport 或 HTTP fallback。唯一兼容折衷是继续使用 `SidecarClient`、`adapters/sidecar` 等历史命名，避免在 RC 收敛期进行无行为收益的大范围重命名；架构 guard 明确禁止这些名称重新获得 Sidecar transport 语义。

## 3. Sidecar Retirement

| Area | Old | New | Action |
| --- | --- | --- | --- |
| Runtime | Bun Sidecar child process | Rust `api_bridge` + in-process API | RETIRE / REWRITE |
| Health | `/health` heartbeat and polling | Main-process lifecycle; no child health contract | RETIRE |
| Recovery | supervisor restart/recovery | Tauri application lifecycle | RETIRE |
| Transport | localhost HTTP | Tauri `invoke("api_call")` | REWRITE |
| Packaging | Bun binary in `externalBin` | Rust dependency/submodule | RETIRE |
| Provider boundary | Web -> Sidecar routes | Ports -> invoke -> bridge -> API | REWRITE |
| Contract drift | Sidecar DTO tests | shared Zod + Rust golden contracts | REWRITE |
| Command surface | Sidecar runtime commands | controlled `api_call` manifest | REWRITE |
| Media URI | proxy URL knowledge | opaque native media URI | KEEP / REWRITE |
| Playback ownership | transport-independent audio invariant | unchanged Playback Audio Runtime | KEEP |

完整 artifact 分类见 `docs/sidecar-retirement-2.1.md`。生产源码审计与 `m9-api-readiness-boundary.test.ts` 均确认 Bun process、health polling、supervisor、Sidecar build script 和 provider localhost HTTP 未复活。

## 4. Validation Matrix

| Capability | Automated | Field | Status |
| --- | --- | --- | --- |
| TypeScript/shared/Web contracts | PASS | n/a | COMPLETE |
| Rust bridge/API golden contracts | PASS | Provider samples pending | FIELD_VALIDATION_PENDING |
| Sidecar retirement boundary | PASS | n/a | COMPLETE |
| Provider ordering persistence | Browser/Tauri conformance + SQLite restart PASS | WebView2 restart pending | FIELD_VALIDATION_PENDING |
| Local library import/hydration/lyrics/playback | Controller/runtime/Rust tests PASS | Real file + relaunch pending | FIELD_VALIDATION_PENDING |
| Preview detection x resume | Store/session integration PASS | Real preview media pending | FIELD_VALIDATION_PENDING |
| Stream Next x startup resume | Restored stream-tail grow/ended test PASS | Real Stream + relaunch pending | FIELD_VALIDATION_PENDING |
| Playlist pagination | hasMore/offset/limit/race tests PASS | QQ/Netease large playlists pending | FIELD_VALIDATION_PENDING |
| Kugou discovery/data/login contract | API unit + Web route/capability tests PASS | Real QR/login/status/request pending | FIELD_VALIDATION_PENDING |
| Full Bun workspace | `2374 pass, 0 fail` | n/a | COMPLETE |
| MineRadio-api Rust tests | `160 pass` + golden PASS | Real provider behavior pending | FIELD_VALIDATION_PENDING |
| Desktop Rust tests | `565 pass` | n/a | COMPLETE |
| Clippy | all targets/features, `-D warnings` PASS | n/a | COMPLETE |
| Web production build | PASS | WebView2 rendering pending | FIELD_VALIDATION_PENDING |
| Recursive-submodule fresh clone | frozen install + Web build + desktop check PASS | n/a | COMPLETE |
| NSIS application/bundle generation | `MineRadio-Tauri_2.1.0_x64-setup.exe` generated | install pending | FIELD_VALIDATION_PENDING |
| Updater signature | FAIL: private key absent locally | protected release required | RELEASE_BLOCKER |
| N-1 -> N upgrade | architecture/smoke guards PASS | actual upgrade not run | RELEASE_BLOCKER |

## 5. Performance

旧 Sidecar 数值只保留为历史参考，不能与 native architecture 直接作绝对比较。

| Metric | Old baseline | Native integration baseline | Regression |
| --- | --- | --- | --- |
| Bundle total | 1.59 MiB historical | 2,290,787 bytes (2.18 MiB) | Increase; deterministic budget PASS |
| Bundle JS | 1.48 MiB historical | 2,098,908 bytes (2.00 MiB) | Increase; no gate failure |
| Home default | not comparable | 240.2 effective FPS, 0% drop | No measured severe regression |
| Home high | not comparable | 239.9 effective FPS, 0.08% drop | No measured severe regression |
| Search interaction | not comparable | 238.9 effective FPS, 0.17% drop | No measured severe regression |
| Long tasks | not comparable | 0 in all quick scenarios | None observed |
| Heap max | not comparable | 22.19-23.96 MiB | Native field baseline pending |
| Playback resource cadence | M2 fixed platform | deterministic gate PASS | None |
| Sidecar polling | 1/min historical | removed | Improvement by architecture removal |

M10 quick benchmark runs in degraded Vite preview without Tauri/provider runtime and recorded two 404 console errors per scenario. It is valid as frontend rendering evidence only. Startup, idle CPU, desktop RSS, provider request latency and packaged WebView2 performance remain field measurements.

## 6. Remaining Release Blockers

### BLOCKER

- Run protected release packaging with `TAURI_SIGNING_PRIVATE_KEY`; require `bun run build` exit 0 and verify the exact updater signature/artifact identity.
- Complete Windows/WebView2 field validation for local library restart hydration, startup resume, Stream Next, Stream Next x relaunch, provider-order restart, normal/preview playback and real Kugou login/data request.
- Run the actual N-1 -> 2.1.0 installer upgrade smoke and preserve its bounded evidence.

### RC-NONBLOCKER

- Vite reports the existing >500 kB chunk warning; deterministic bundle gate passes. Further code splitting requires a separate measured regression case.
- `MineRadio-api` emits existing dead-code/unused warnings as a dependency; desktop clippy with `-D warnings` passes. API warning cleanup is user-owned and not part of this convergence change.
- Degraded headless benchmark 404s and native startup/idle metrics need field evidence but do not justify speculative performance work.

### POST-2.1

- Queue drag-sort, visual archive, camera gesture, Cuefield AutoMix and wallpaper library enhancement remain outside the 2.1 release scope.

### FIELD-VALIDATION

- Real Provider responses, especially Kugou QR login, status and authenticated request, require user-owned network/account verification.
- Packaged WebView2 rendering, installer launch, N-1 upgrade and startup performance require the signed Windows candidate.

## 7. Recommendation

```text
READY_FOR_2.1.0_RC1 = NO
```

The source integration candidate is converged: architecture, contracts, tests, clean checkout, native compilation, deterministic performance gates and unsigned NSIS generation pass. RC1 must wait for the protected signing build and the minimal Windows/provider field matrix above. No additional feature, visual redesign or speculative optimization should be started while those release gates are being completed.
