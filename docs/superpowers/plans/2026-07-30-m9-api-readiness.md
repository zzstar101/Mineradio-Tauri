# M9 未来 API 接入准备实施计划

> **Historical architecture evidence only.** M9 的 transport/ownership guards 可继续证明 Sidecar removal 与 native command boundary；它们不证明 provider operational、UI/product parity 或 RC readiness。当前产品权威见 `docs/audit/2.1-surface-manifest.json`。

**设计：** `docs/superpowers/specs/2026-07-30-m9-api-readiness-design.md`

**当前状态：** Code Complete / Automated Verification Complete

**范围冻结：** 不切换 `MineRadio-api`，不修改 Bun API/shared DTO/Provider/media 字节行为/Sidecar supervisor/`externalBin`。

## Tracer 1：冻结 M9 seam 与失败证据（完成）

- 新增 M9 architecture guard，先证明 App/Runtime/Visual 的 concrete transport 泄漏；
- 固定 freeze targets 和 legacy behavior；
- 添加 Application Runtime Port 与 domain context。

## Tracer 2：Application Runtime Port（完成）

- 将 Application Ports Interface 从 concrete factory 拆开；
- legacy Sidecar Adapter 独占 config、client 创建和 Port 组装；
- `SidecarRecoveryRuntime` 只接收 `connect()`；
- App 删除 raw client 与 base URL state；
- 保留 health、capability、login restore、library refresh 与 recovery polling 顺序。

## Tracer 3：业务 caller 全量收口（完成）

- Search Detail 改用 `SearchExperiencePort`；
- Shelf like、playlist、podcast 分别使用既有 narrow Ports；
- App/Surface/Controller 不再 structural-cast raw client。

## Tracer 4：Legacy Adapter conformance（完成）

- descriptor-driven 覆盖 28 个 Music 方法；
- 验证 exactly-once、参数/默认值、返回/error identity；
- API runtime 和 Media URL conformance 可供未来 Adapter 复用；
- 保留真实 SidecarClient HTTP/DTO tests。

## Tracer 5：Opaque media source（完成）

- WebGL current/shelf cover 通过 `MediaUrlPort`；
- visual-engine 接收 explicit primary/fallback；
- 删除 `/image-proxy` route/query 识别；
- 保留 CSS direct URL、CORS proxy、fetch/blob 与 direct fallback 行为。

## Tracer 6：文档、全量门禁与提交（完成）

运行：

```text
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture scripts/perf
bun run typecheck
bun run web:build
bun run perf:budget
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
git diff --check
```

更新 umbrella、capability matrix 与 test count，确认 freeze targets 无变更后提交。M9 完成即停止；Rust API 嵌入必须另立设计。

## 收口记录

- `ApplicationRuntimePort.connect()` 已成为启动完整 `ApplicationPorts` 的单一 Seam，Legacy Sidecar Adapter 独占 config/client/transport 组装；App 与业务 caller 仅消费 Ports。
- Search 与 Shelf 已改用既有 narrow Ports；Visual 使用 opaque `MediaImageSource`，current WebGL cover 保留显式 direct fallback，Shelf 使用 opaque primary URI，CSS direct cover 行为保持不变。
- Legacy Music Adapter 28/28 方法、API Runtime 与 Media URL Adapter 已通过核心 conformance；M9 architecture/freeze guard 5/5 通过。
- 冻结范围保持不变：`sidecars/api/**`、`packages/shared/**`、Sidecar supervisor、Cargo、sidecar binary build 与 `externalBin` 均无修改；默认实现仍是 Bun Sidecar。
- 最终门禁：Bun `2263 passed / 0 failed`（`10788` assertions），Rust `292 + 7 passed / 0 failed`；typecheck、Web build、performance budget、Rust fmt/clippy 与 diff check 全绿。

M9 完成即停止；Rust API 嵌入必须另立设计和验收门禁。
