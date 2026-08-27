# Sidecar Retirement 2.1

## Canonical Architecture

```text
Web feature / controller
  → Application Ports
  → SidecarClient（兼容命名）
  → Tauri invoke: api_call
  → Rust api_bridge
  → MineRadio-api
  → Provider
```

2.1.0 不再包含 Bun Sidecar production runtime。`SidecarClient`、`adapters/sidecar`、`legacy-sidecar-services` 与 `createLegacyApplicationRuntime` 只是兼容名称；它们不建立 HTTP 连接，不分配 localhost 端口，也不启动或监督子进程。收敛阶段保留这些名称，避免无行为收益的大范围重命名。

## Guard Classification

| Area | Previous invariant | 2.1 action | Current protection |
| --- | --- | --- | --- |
| Bun process | Sidecar child 必须存在并可启动 | RETIRE | 旧进程和 build script 必须保持删除 |
| Heartbeat / health | `/health` 与 bounded polling | RETIRE | native API 无独立进程健康状态 |
| Supervisor / restart | 子进程崩溃后恢复 | RETIRE | in-process API 生命周期归 Tauri 主进程 |
| Local HTTP / port | 动态 localhost 地址与 route | RETIRE | Web client 禁止 `fetch`、`127.0.0.1` 与 `sidecarBaseUrl` |
| Sidecar packaging | `externalBin` 打包 Bun binary | RETIRE | `externalBin` 必须为空，旧 binary build script 必须不存在 |
| Web provider boundary | 业务代码不能绕过 canonical API client | REWRITE | Application Port import guard + native invoke route guard |
| Contract parity | Web DTO 与 Provider response 一致 | REWRITE | shared Zod schema + Rust bridge/API tests |
| Controlled commands | desktop command surface 固定 | REWRITE | command manifest 包含受控 `api_call` |
| CSP / network bypass | production Web 不得任意联网 | REWRITE | CSP guard + compatibility client no-fetch assertion |
| Port delegation | MusicServices 保持逐项委托 | KEEP | `legacy-sidecar-services.test.ts`，与 transport 无关 |
| Media URI opacity | 业务与 visual 不解析媒体地址 | KEEP | `legacy-media-url.test.ts` 与 architecture guard |
| Playback / visual ownership | audio 与 visual invariant | KEEP | playback/visual boundary suites |

## Test And Document Disposition

| Artifact | Action | Reason |
| --- | --- | --- |
| `apps/web/src/api/sidecar-client.test.ts` | REWRITE | 文件名兼容保留，测试对象已是 Tauri invoke route 与 schema |
| `apps/web/src/adapters/sidecar/legacy-sidecar-services.test.ts` | KEEP | 保护 transport-neutral Port 委托 |
| `apps/web/src/adapters/sidecar/legacy-media-url.test.ts` | KEEP | 保护 opaque media URI 与 fallback 行为 |
| `apps/web/src/adapters/sidecar/legacy-application-runtime.test.ts` | REWRITE | 保护 native application-port assembly，名称兼容保留 |
| `packages/shared/src/health.ts` 及其测试 | RETIRE | Sidecar process health contract 已不存在 |
| `scripts/architecture/m9-api-readiness-boundary.test.ts` | REWRITE | 保护 Tauri invoke → `api_bridge` → `MineRadio-api` 与旧工件不复活 |
| `docs/superpowers/**` | KEEP (historical) | 保存当时设计与证据，不作为 current architecture source |
| `AGENTS.md`、`CONTEXT.md`、`docs/parity/**` | REWRITE | 必须描述当前 production architecture 与 release 状态 |

## Release Rule

Sidecar retirement 的代码与自动化完成，不等于真实 Provider 已完成字段验证。尤其 Kugou 的 QR 登录、登录状态和登录后 Provider request 必须保留 `FIELD_VALIDATION_PENDING`，直到用户在真实网络与账号环境中验证。
