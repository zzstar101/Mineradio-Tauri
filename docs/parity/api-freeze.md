# Native API 架构冻结线

## 当前生产路径

```text
React / Application Ports
  → SidecarClient（兼容命名，无 HTTP）
  → Tauri invoke("api_call")
  → Rust api_bridge
  → in-process mineradio_api::Api
  → Provider adapter
```

`apps/web/src/api/sidecar-client.ts`、`apps/web/src/adapters/sidecar/**` 与 `createLegacyApplicationRuntime` 暂时保留旧名称，以避免 2.1.0 收敛阶段进行大范围 rename。名称不是生产 Sidecar 存在的证据。

## 当前必须保持的边界

- Web feature、component 与 visual 模块只能依赖 Application Ports，不得直接调用 Tauri 或具体兼容客户端。
- 兼容客户端只允许调用受控的 `api_call` command，不得使用 `fetch`、localhost、动态端口或任意 network bypass。
- `api_bridge.rs` 只负责 route、DTO 与 error envelope 映射；Provider 行为归用户所有的 `api/` 子模块。
- TypeScript schema、Rust bridge 类型与 `MineRadio-api` 输入输出必须由自动化 contract tests 保持一致。
- `mineradio-tauri://` 媒体 URI 对 Web 与 visual-engine 是 opaque value；调用方不得解析 host、route 或 query。
- `tauri.conf.json` 的 `bundle.externalBin` 必须为空；仓库不得恢复 Sidecar binary build、supervisor、heartbeat 或 restart/recovery runtime。
- CSP 与 desktop command manifest 继续 fail closed。

## 已退役的旧冻结项

以下 M0/M1 约束只描述历史架构，不再是当前产品 invariant：

- Bun Sidecar 进程与 `sidecars/api/**`；
- `RuntimeConfig.sidecarBaseUrl` 与 localhost HTTP route；
- Rust Sidecar supervisor、health probe、status snapshot 与 restart；
- `get_sidecar_status`、`SidecarRecoveryNotice` 与轮询策略；
- `build-sidecar-binary.mjs`、Sidecar `build.rs` 步骤与 `externalBin` 打包。

历史设计与实施记录保留在 `docs/superpowers/**`，不得把其中的旧 freeze 描述当作当前架构要求。

## 审计命令

```powershell
bun test scripts/architecture/m9-api-readiness-boundary.test.ts apps/web/src/api/sidecar-client.test.ts
bun test packages/shared
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked api_bridge
```

完整 `KEEP / REWRITE / RETIRE` 分类见 `docs/sidecar-retirement-2.1.md`。
