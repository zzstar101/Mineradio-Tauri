# Production Debug / Test Surface 泄漏审计

## 结论

确认 **3 个 production 可达 surface**，均不能用“默认未展开”解释为安全：两个是 `DEBUG_LEAKAGE / P1 RC BLOCKER`，一个是普通启动即 probe 且正常设置可见的 raw diagnostics，需要在产品明确授权前同样按 P1 处理。

## 分类结果

| Surface | 分类 | Production import/entry | 实例化/激活方式 | 可见输出 | 判定 |
| --- | --- | --- | --- | --- | --- |
| Visual audio debugger | accidentally reachable + always instantiated but disabled | `create-legacy-visual-composition.ts:85,1706-1712,1845` | 每次 visual composition 都创建；query `visualAudioDebug`/`audioDebug`、localStorage、`Ctrl+Alt+D`、global API 激活 | max z-index overlay、`DEBUG visual audio` 日志 | DEBUG_LEAKAGE / P1 |
| M4 parity app | accidentally reachable test fixture | `main.tsx:29-44` | 正式入口 `?m4-parity=1` 直接绕过正常 bootstrap | synthetic stage、测试 badge、global test API | DEBUG_LEAKAGE / P1 |
| Desktop raw diagnostics | user-visible without explicit diagnostics opt-in | `App.tsx:1676-1684` → `DesktopRuntimeControls` | normal startup hook 无条件 `refreshDiagnostics()` | probe/errors/generation/renders/long frames/mesh/task 等内部计数 | DEBUG_LEAKAGE / P1，除非产品重新定义为显式高级诊断 |

## Visual audio debugger 证据链

1. `apps/web/src/visual/runtime/create-legacy-visual-composition.ts` 正式路径导入模块并无条件调用 `createVisualAudioDebugger(...)`。
2. `apps/web/src/visual/visual-audio-debug.ts:68-105` 读取 URL 和 localStorage；旧机器上遗留 key 会让 release 启动即显示。
3. 同文件 `177-200` 创建 body 直属 overlay，`206-226` 显示内部时序并写 console。
4. `315-335` 注册全局 `window.__mineradioVisualAudioDebug` 和 `Ctrl+Alt+D`；composition 每帧调用 `.tick(frame)`。
5. 上游 v2.1.0 全树不存在这些入口。旧 M8 文档称它 dev-only，与当前代码事实冲突。

## M4 fixture 证据链

- `main.tsx` 在正常 application bootstrap 之前判断 query param，因而 production build 也可进入。
- `m4-parity-runtime.ts` 加载固定音频、空 cover 和 synthetic lyric fixtures；`M4ParityRoot.tsx` 暴露测试状态与 badge。
- `scripts/parity/m4/README.md` 明确说明该 fixture 不加载普通 App/账号。它可以作为 isolated engine test，但绝不能作为 full product surface parity evidence。

## 搜索结果分类原则

- `development-only`：测试文件、`scripts/` runner、仅测试 bundle 引入的 fixture，可保留。
- `diagnostics explicitly user-enabled`：用户从明确“诊断”入口启用，默认不 probe、不建 UI、不留 global；当前 raw desktop diagnostics 不满足。
- `accidentally reachable`：正式 main query route、隐藏快捷键、localStorage debug key；必须从 production graph 隔离。
- `console.warn/error`：真实启动失败、恢复失败的非敏感错误日志不是自动构成泄漏；应另行做脱敏和噪声审计。
- `mock/fixture`：只要进入 production bundle/route，即使默认不可见也属泄漏；测试目录本身不属问题。

## 建议验证门禁（仅计划）

1. 对 production entry 做 import-graph/字符串门禁：禁止 `visual-audio-debug`、`M4ParityRoot`、fixture badges、`__mineradio*Debug`、debug query/localStorage keys。
2. 构建 release bundle 后扫描 sourcemap/JS，而不只扫描 TS source。
3. 正常启动断言：无 debug DOM、无 debug global、无 debug listeners、无 diagnostics probe，console 无周期 debug 输出。
4. 若保留产品诊断，新增显式 opt-in、权限/隐私说明和关闭后资源归零测试。

