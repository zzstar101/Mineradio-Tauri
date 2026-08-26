# CI/CD 加固设计

## 目标

修复当前发布资产可被同版本覆盖、CI 未覆盖 Rust/Tauri、测试访问真实 QQ 服务以及构建工具链漂移的问题，使每个公开 Release 都能唯一对应一个受检 tag 提交。

## 发布不变量

- 受保护发布流程位于历史中从未出现过的 `protected-release.yml`；legacy `release.yml` 永久禁用，避免指向历史提交的 tag 重新执行旧权限模型。
- Release 只能由严格 `vX.Y.Z` tag 触发，且 tag 在创建时必须精确指向默认分支 tip，不再允许从普通分支手动发布。
- tag 版本必须同时等于根 `package.json`、桌面 package、Tauri 配置和 Cargo package 版本。
- 发布任务只 checkout 触发 tag，使用固定 Bun、Rust、runner 与 Action commit。
- 发布任务先在无签名密钥环境中构建 NSIS，再让固定 Tauri CLI 仅对最终产物和来源证明签名。
- 发布前使用与 `tauri-plugin-updater` 相同的 Minisign 语义，用应用内置公钥真实验签。
- 受测 Bun REST 客户端先创建草稿 Release；五项资产的名称、状态、大小和 SHA-256 全部验证通过后才公开。
- 签名 provenance 把 repository、tag、提交 SHA 与安装包、updater 签名和 `latest.json` 的字节绑定，允许同一 tag 在 API 响应丢失后安全续跑。
- 同一 tag 的重跑只能基于同一提交；既有 Release 只有在身份、签名、provenance 和资产完全匹配时才能恢复，禁止覆盖或 clobber。

## CI 结构

- Linux job 保留 Bun 安装、类型检查、测试和 Web 构建。
- Windows job 执行 Rust format、Clippy、测试和 Cargo lock 校验，覆盖实际桌面目标平台。
- 两个 job 使用固定 Bun 1.4.0；Rust 使用仓库内固定 toolchain。
- QQ session-cookie 路由测试通过依赖注入使用本地 adapter，不访问真实第三方 API。

## 发布运行器隔离

发布按权限和秘密拆分为三个 Windows runner，并由只读 Ubuntu preflight 先校验 tag：

1. `build-windows` 不关联 environment、不接触签名 secret，完成 Bun/Rust 检查、构建 unsigned NSIS 和 updater 验签器，并上传不可变 Actions artifact。
2. `sign-windows` 使用新的 runner 和受保护的 `production-release` environment，只以只读 token 下载 unsigned artifact；使用固定的 Tauri CLI 直接签安装包和 provenance，不运行含 secret 的 package script。
3. `publish-release` 再使用一个新的 runner 和同一受保护 environment，拥有 `contents: write` 但不引用私钥；它下载已签资产和验签器，用受测 Bun REST 客户端复验并发布。

artifact 名称由依赖 job output 传递，不根据当前 `run_attempt` 重算，因此部分 rerun 可以复用已成功依赖 job 的 artifact，同时保持 build、sign、publish 的 runner 与权限边界。

所有版本 tag 共享仓库级 release concurrency group；新版本必须等待正在运行或等待审批的版本完成，避免跨版本同时修改 Latest。

## 发布校验脚本

新增独立脚本读取四个版本来源并校验 tag。核心逻辑导出为纯函数，使用 Bun 单元测试覆盖：

- 合法且一致的 `v0.1.0`。
- 非语义化 tag。
- tag 与应用版本不一致。
- 各版本文件互相不一致。

发布辅助脚本还负责：

- 拒绝零字节安装包并生成 Tauri updater manifest。
- 生成并验证无时间戳、确定性的签名 provenance。
- 比较 GitHub REST asset 的 `state`、`size`、`digest` 与本地或下载文件。
- 通过 draft/published 状态机恢复发布，并让严格 `vMAJOR.MINOR.PATCH` 的最大版本收敛为 Latest。

## 安全边界

- Checkout 不持久化 GitHub 凭据。
- Checkout、cache 和 setup-bun 固定到完整 commit SHA；发布 REST 调用由固定 Bun 运行，不依赖 runner 中漂移的 GitHub CLI 或 Node。
- updater 私钥只传入直接调用 Tauri signer 的窄步骤，不传给 Web、Bun package script、Cargo build 或发布客户端。
- 发布客户端执行验签器时主动移除 `GITHUB_TOKEN` 和 `GH_TOKEN`；验签子进程不能同时持有公开发布权限。
- Release 先 draft 后公开，资产验证失败时不会成为 latest。
- 签名前和公开前都复查本地 HEAD、tracked worktree、远端 tag SHA，并要求 tag 提交已进入默认分支。

## 不在本次范围

- Windows Authenticode 需要真实代码签名证书和对应 Secrets，当前无法安全生成。
- GitHub Environment 的 environment secret 迁移、tag deployment policy、tag ruleset 和 immutable releases 属于仓库设置，必须按 `docs/release-runbook.md` 在 GitHub 侧启用；当前仓库明确不配置 required reviewers。
- Immutable releases 不追溯；现有 `v0.1.0` 仍是可变的遗留 release，后续应由新的受保护版本替代其 Latest 位置。
- 运行时远程模型与远程 JavaScript 的产品供应链调整单独处理。

## 验证

- Bun 全量测试、typecheck、Web build。
- release version guard 单元测试与命令行成功/失败路径。
- `cargo fmt`、`cargo clippy -D warnings`、`cargo test --locked`。
- actionlint 校验 GitHub Actions 语法和表达式。
- `git diff --check` 与最终工作树检查。
