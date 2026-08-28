# M4 Lyrics and Visual Parity Implementation Plan

> **SUPERSEDED authority:** 本计划及其 fixture 是历史 engine/component implementation smoke evidence；“Complete/implemented/parity”不能解释为 full product visual parity 或 RC readiness。当前 authority 为 `docs/audit/2.1-product-parity-audit.md` 与 `docs/audit/2.1-surface-manifest.json`。

> 每个任务使用纵向 tracer bullet。TDD 只用于核心时序、资源、取消、预算、对象池和性能路径；其余使用 characterization、architecture 与 parity tests。

**Goal:** 在现有 M3 runtime foundation 上完成 Stage Lyrics 2.0、歌词纹理/GPU 上传预算、Sonic Topography preset 7 和 3D Shelf 资源/行为 parity，同时保持 Sidecar/API 行为冻结。

**Design:** `docs/superpowers/specs/2026-07-28-m4-lyrics-visual-parity-design.md`

**Execution status:** Complete。Stage Lyrics、直接迁移版 Sonic Topography 与 3D Shelf 已在 clean implementation commit `0230feb` 通过 final release strict evidence；65/65 checks、三场景 console errors=0、真实 GPU timer-query 各 240 samples，三项能力均为 `implemented`。

**Baseline verification:**

```powershell
bun test packages/visual-engine apps/web/src/visual --parallel=1
bun run --filter ./packages/visual-engine typecheck
bun run --filter ./apps/web typecheck
```

基线：953 tests pass，两个 typecheck pass。

## File map

### Stage Lyrics 2.0

```text
packages/visual-engine/src/stage-lyrics/
├─ model/
├─ layout/
├─ textures/
├─ resource-budget/
├─ scheduler/
├─ rows/
├─ transitions/
└─ lifecycle.ts
```

### Sonic Topography

```text
packages/visual-engine/src/sonic-topography/
├─ sonic-topography.ts
├─ sonic-settings.ts
├─ sonic-audio-profile.ts
├─ sonic-palette.ts
├─ sonic-shaders.ts
├─ sonic-terrain.ts
├─ sonic-floating-blocks.ts
└─ sonic-impulses.ts
```

### Shelf

```text
packages/visual-engine/src/shelf/
├─ object-pool.ts
├─ shelf-resource-diagnostics.ts
├─ shelf-animate.ts
├─ shelf-card-sprite.ts
├─ shelf-content-sprite.ts
└─ shelf-content-list.ts
```

### Web integration

```text
apps/web/src/visual/controls/
├─ StageLyricsControls.tsx
└─ SonicTopographyControls.tsx
```

## Common slice gate

每个任务完成时除目标测试外都执行：

```powershell
git diff --exit-code ab04493 -- sidecars/api packages/shared apps/desktop/src-tauri/src/sidecar.rs apps/desktop/scripts/build-sidecar-binary.mjs apps/desktop/src-tauri/tauri.conf.json
bun test apps/web/src/api/sidecar-client.test.ts sidecars/api --parallel=1
```

translation 只能扩展 visual-engine 内部 contract，禁止修改 shared schema。每个任务在 Critical/Important 清零后再进入下一任务。

## Task 1: Freeze translation contract, fixtures, and architecture seams

**Files:**

- Modify: `packages/visual-engine/src/runtime/visual-engine-contract.ts`
- Modify: `packages/visual-engine/src/runtime/visual-engine-contract.test.ts`
- Modify: `apps/web/src/visual/VisualEngineHost.tsx`
- Modify: `apps/web/src/visual/VisualEngineHost.test.tsx`
- Modify: `apps/web/src/visual/runtime/visual-snapshot-builders.test.ts`
- Add: `packages/visual-engine/src/fixtures/m4/*.ts`
- Add/Modify: `scripts/architecture/*visual*.test.ts`
- Add: `packages/visual-engine/src/runtime/subsystem-diagnostics.ts`
- Modify: `packages/visual-engine/src/runtime/performance-collector.ts`
- Modify: `packages/visual-engine/src/runtime/render-step-slot.ts`

### Step 1: RED — translation preservation

增加一个 public-interface test：shared lyric 的 `translation` 经过 `mapLyricPayload()` 和 `buildLyricsVisualSnapshot()` 后仍存在且被冻结。

Run:

```powershell
bun test apps/web/src/visual/VisualEngineHost.test.tsx apps/web/src/visual/runtime/visual-snapshot-builders.test.ts --parallel=1
```

Expected: FAIL，因为 `VisualLyricLine` 和映射尚未保留 translation。

### Step 2: GREEN — 最小 contract 扩展

- `VisualLyricLine.translation?: string`；
- host mapping 保留 translation；
- snapshot builder 深冻结但不改变字段；
- Sidecar/shared DTO 不修改。

### Step 3: Freeze dormant runtime seams

- 定义 plugin factory/context/registry interface，但不注册 Sonic；
- 定义 diagnostics supplier registry、immutable copy 和 unregister；
- 增加全局 Maintenance render slot；
- 保持 `PRESET_COUNT=7`、store clamp `0..6`，不迁移持久化 preset 8。

### Step 4: Characterize existing preset 0..6

锁定现有 0..6 行为、NaN/Infinity/小数处理现状，为 Task 10 的原子开放建立 fallback 基线。

### Step 5: Add fixtures

新增短歌词、翻译歌词、密集歌词、长歌词、seek 边界、Sonic audio frame、600 Shelf items。fixture 必须无网络、无真实时间和随机输入。

### Step 6: Architecture guards

守卫：

- visual-engine 不导入 React/Zustand/Tauri/Sidecar；
- Stage/Sonic/Shelf 不创建 AudioContext、RAF 或 requestIdleCallback；
- React controls 不导入 Three；
- translation 扩展不触碰 Sidecar route/DTO。

### Step 7: Verify

```powershell
bun test packages/visual-engine/src/runtime/visual-engine-contract.test.ts packages/visual-engine/src/runtime/subsystem-diagnostics.test.ts packages/visual-engine/src/home-visual apps/web/src/visual/VisualEngineHost.test.tsx apps/web/src/visual/runtime/visual-snapshot-builders.test.ts scripts/architecture --parallel=1
bun run --filter ./packages/visual-engine typecheck
bun run --filter ./apps/web typecheck
```

### Step 8: Review and commit

- 独立规格复审；
- 独立质量复审；
- Critical/Important 清零；
- commit: `feat(visual): freeze m4 contracts and fixtures`

## Task 2: Implement Stage Lyrics display and translation layout

**Files:**

- Add: `packages/visual-engine/src/stage-lyrics/model/stage-lyrics-settings.ts`
- Add: `packages/visual-engine/src/stage-lyrics/model/stage-lyric-entry.ts`
- Add: `packages/visual-engine/src/stage-lyrics/layout/display-mode.ts`
- Add: `packages/visual-engine/src/stage-lyrics/layout/virtual-index.ts`
- Add: `packages/visual-engine/src/stage-lyrics/layout/row-layout.ts`
- Add: matching tests
- Modify: `packages/visual-engine/src/index.ts`

### Step 1: RED→GREEN — settings normalization

按一个 behavior 一个测试完成：

- display mode；
- translation mode；
- motion style；
- custom line count；
- context/translation/edge/glitch ranges；
- clarity tier。
- glitch camera bind/chroma/rate/jitter、vertical float、background star-river。

settings 使用 `FxState.stageLyrics` 嵌套形状；本任务只完成 pure type/default/normalizer 与 layout，不在旧 lifecycle 接入未完成路径。

### Step 2: RED→GREEN — display offsets

测试并实现：

- single `[0]`；
- dual `[0,1]`；
- triple `[-1,0,1]`；
- cinema 5 行；
- custom 1..10。

### Step 3: RED→GREEN — translation virtual index

测试：

- translation off 不占 slot；
- current/dual/multi 插入规则；
- 缺 translation 的相邻行不留下空洞；
- current translation anchor；
- primary prefix cache 结果与无 cache 一致。

### Step 4: Characterize row alpha/scale/edge fade

使用固定 fixture 验证 current/context/translation 的 role、alpha、scale、offset、virtual index。

### Step 5: Verify and review

```powershell
bun test packages/visual-engine/src/stage-lyrics/model packages/visual-engine/src/stage-lyrics/layout --parallel=1
bun run --filter ./packages/visual-engine typecheck
```

Commit: `feat(stage-lyrics): add display and translation layout`

## Task 3: Fix Stage texture ownership and deterministic disposal

**Files:**

- Add: `packages/visual-engine/src/stage-lyrics/textures/texture-lease.ts`
- Add: `packages/visual-engine/src/stage-lyrics/textures/canvas-disposal.ts`
- Add: `packages/visual-engine/src/stage-lyrics/textures/resource-reservation.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-builder.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-sun-bloom.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-dot-texture.ts`
- Modify: associated tests

### Step 1: RED — shared sun is not disposed by a row

构建两个 group 共享 sun texture，释放一个后另一个仍可用；最终 owner release 恰好一次。

### Step 2: GREEN — owned/borrowed lease

- shared sun 由 lifecycle/cache scope 持有；
- row material 仅借用；
- dot texture 显式 owned 或 borrowed；
- 不从 `material.map` 反推 ownership。

### Step 3: RED→GREEN — Canvas backing store cleanup

owned Canvas texture release 后：

- `texture.dispose()` 一次；
- canvas width/height 为 1；
- 二次 release 无操作。

### Step 4: RED→GREEN — partial build rollback

中途失败或取消时，已经创建的 texture/geometry/material 按逆序释放，其他资源不被跳过。

### Step 5: RED→GREEN — reservation lifecycle

- 分配前 reservation；
- 创建成功转正式 allocation；
- 创建失败/取消回滚；
- clarity pool 不重复计数；
- current/adjacent/prewarm 映射 essential/normal/background 与 retention。

### Step 6: Verify and review

```powershell
bun test packages/visual-engine/src/stage-lyrics/lyric-builder.test.ts packages/visual-engine/src/stage-lyrics/textures --parallel=1
```

Commit: `fix(stage-lyrics): make texture ownership explicit`

## Task 4: Add cooperative Stage raster pipeline and active cancellation

**Files:**

- Add: `packages/visual-engine/src/stage-lyrics/scheduler/cooperative-build.ts`
- Add: `packages/visual-engine/src/stage-lyrics/scheduler/stage-build-coordinator.ts`
- Add: matching tests
- Add: `packages/visual-engine/src/runtime/visual-maintenance-lane.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-mask.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-glow.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-readability.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lifecycle.ts`
- Modify: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`

### Step 1: Tracer bullet RED→GREEN

一个两 phase 的假 build 通过 injected `BudgetTaskQueue` 每 slice 只推进一个 phase，并最终 commit。

continuation 由 coordinator 使用递增 phase key 重新入队，不允许 active task 以同 owner/key 替换自己；同优先级 FIFO，低优先级有公平性测试。

### Step 2: RED→GREEN — replacement cancels old generation

- 同 owner/key 新任务 abort 旧任务；
- 旧任务在下一 phase 前停止；
- stale result 不 commit；
-取消后的 canvas 回收。

### Step 3: RED→GREEN — lifecycle disposal

dispose mid-build：pending=0、commit=0、资源 exactly once、`whenIdle()` 收口。

### Step 4: Split real builder into resumable phases

顺序拆分：layout metrics、base mask、readability、glow、row layer、geometry/material assembly。每 phase 可独立中止。

### Step 5: Add phase diagnostics

记录 phase count、last/peak duration、>8ms violation、pending builds、cancelled/stale counts。

### Step 6: Install the single maintenance pump

- `RenderStepSlot.Maintenance` 每 frame 唯一调用 `tasks.runSlice()`；
- 从 `LegacyHomeVisualRuntimeGovernor` 移除 queue pump；
- Home inactive/released 不会阻断 Stage build 收口；
- `whenIdle()` 等待 raster/cancellation settlement。

### Step 7: Verify and review

```powershell
bun test packages/visual-engine/src/stage-lyrics/scheduler packages/visual-engine/src/stage-lyrics/lifecycle.test.ts apps/web/src/visual/runtime/create-legacy-visual-composition.test.ts --parallel=1
```

Commit: `feat(stage-lyrics): add cooperative cancellable builds`

## Task 5: Add GPU upload gate, clarity pool, and atomic takeover

**Files:**

- Add: `packages/visual-engine/src/stage-lyrics/resource-budget/upload-gate.ts`
- Add: `packages/visual-engine/src/stage-lyrics/resource-budget/clarity-budget.ts`
- Add: `packages/visual-engine/src/stage-lyrics/resource-budget/quality-pool.ts`
- Add: matching tests
- Add: `packages/visual-engine/src/stage-lyrics/resource-budget/texture-upload-executor.ts`
- Add: `packages/visual-engine/src/stage-lyrics/transitions/atomic-takeover.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lifecycle.ts`
- Modify: `packages/visual-engine/src/runtime/visual-engine-contract.ts`
- Modify: `packages/visual-engine/src/runtime/performance-collector.ts`
- Modify: `packages/visual-engine/src/runtime/visual-engine.ts`
- Modify: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`

### Step 1: RED→GREEN — upload ≤1/frame

在同一 frame enqueue 多个单-texture ticket，只允许 renderer-backed executor 预上传一个；下一 frame 才允许下一个。

### Step 2: RED→GREEN — pending replacement ≤1

新 replacement 取代旧 pending ticket；旧 texture 被释放且不能 commit。

### Step 3: RED→GREEN — atomic takeover

一个 row/group 的全部 required textures 都 upload-ready 前旧 current 保持；成功后交换，旧资源再释放；renderer upload failure 回滚新 leases并保留旧资源。

### Step 4: RED→GREEN — clarity budgets and LRU

逐一覆盖：

- tier/quality byte table；
- single-item cap；
- resident row 4/6/8；
- current essential 不驱逐；
- soft 暂停 background；
- hard 拒绝 optional/background；
- transition 临时 +1 replacement。

### Step 5: Add performance diagnostics

通过 Task 1 的通用 diagnostics registry 注册 Stage supplier；collector 做 immutable copy，记录 current/peak、pending build/upload、resident rows、uploadsThisFrame 与 ledger reconciliation。

### Step 6: Real renderer instrumentation

使用真实 `WebGLRenderer.initTexture` adapter/instrumentation 验证每 frame 调用 `≤1`；fake uploader 只覆盖错误与时序，不作为最终上传证据。

### Step 6: Verify and review

```powershell
bun test packages/visual-engine/src/stage-lyrics/resource-budget packages/visual-engine/src/stage-lyrics/transitions packages/visual-engine/src/stage-lyrics/lifecycle.test.ts --parallel=1
```

Commit: `feat(stage-lyrics): budget uploads and quality textures`

## Task 6: Complete Stage runtime behavior, controls, and parity fixtures

**Files:**

- Add: `packages/visual-engine/src/stage-lyrics/rows/persistent-row-window.ts`
- Add: `packages/visual-engine/src/stage-lyrics/transitions/stage-transition.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lifecycle.ts`
- Modify: `packages/visual-engine/src/stage-lyrics/lyric-shader-material.ts`
- Add: `apps/web/src/visual/controls/StageLyricsControls.tsx`
- Modify: `apps/web/src/visual/VisualControlPanelHost.tsx`
- Modify: `apps/web/src/stores/visual-store.ts`
- Add/Modify: tests

### Step 1: RED→GREEN — pause hold

暂停时 current mesh/progress 保持；`pauseHold=false` 才允许旧行为。

### Step 2: RED→GREEN — seek binary selection

覆盖首行前、精确边界、重复时间戳、末行、快速 scrub；禁止 frame lane O(n) 扫描。

### Step 3: RED→GREEN — prewarm and resident windows

- single cache ≤10；
- current/outgoing 有界；
- multi-line lightweight first paint；
- full takeover；
- track window 在边界前预热；
- dispose 清零。

### Step 4: Characterize motion styles and edge/background adaptation

按 glass/smooth/float/quick/shine/glitch 固定 observable formulas/uniforms，不对每个内部变量做脆弱断言。

### Step 5: Add modular controls and persistence

控件通过既有 callback 修改 store，不直接调用 engine。round-trip tests 覆盖全部新字段。

### Step 6: Fixed parity tests

使用短/翻译/密集/长/seek fixture 验证 current/context/translation、anchor、opacity、scale、glow 和无 flicker takeover。

### Step 7: Verify and review

```powershell
bun test packages/visual-engine/src/stage-lyrics apps/web/src/visual/controls apps/web/src/stores/visual-store.test.ts apps/web/src/visual/VisualControlPanelHost.test.tsx --parallel=1
bun run --filter ./packages/visual-engine typecheck
bun run --filter ./apps/web typecheck
```

Commit: `feat(stage-lyrics): complete stage lyrics 2 parity`

## Task 7: Add upstream Sonic settings and dormant controls

**Origin gate:** Sonic 采用 `XxHuberrr/Mineradio@4abaa190` 到 `yin-yizhen/sonic-topography@3ff303e` 的直接迁移路线。所有后续任务必须保留 Ajin、`Non-Commercial Learning License`、公开合作证据、维护者项目决策、“不等于书面授权”的限定和修改说明，并继续遵守 visual-engine seam。

**Files:**

- Add: `packages/visual-engine/src/sonic-topography/sonic-settings.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-settings.test.ts`
- Modify: `packages/visual-engine/src/home-visual/fx-defaults.ts`
- Modify: `apps/web/src/stores/visual-store.ts`
- Add: `apps/web/src/visual/controls/SonicTopographyControls.tsx`
- Modify: `apps/web/src/visual/VisualControlPanelHost.tsx`
- Add/Modify: tests

### Step 1: RED→GREEN — effective defaults

锁定 Electron 2.0.2 ground/EQ/color/floating/trigger 默认值。

### Step 2: RED→GREEN — clamp and derived grid

- 0..100 integer controls；
- band start/end；
- density 46 和 100 在四档 quality 的 grid；
- amplitude 0→0、50→1、100→15。

### Step 3: Add nested settings without opening preset 7

- `FxState.sonic` 使用嵌套 typed shape；
- normalizer 缺失字段补 upstream effective defaults；
- controls 可独立渲染测试，但 production selector 仍不可选择 7；
- `PRESET_COUNT`、store clamp、legacy 8 与 0..6 行为保持不变。

### Step 4: Verify and review

```powershell
bun test packages/visual-engine/src/sonic-topography/sonic-settings.test.ts packages/visual-engine/src/home-visual/preset-state.test.ts apps/web/src/stores/visual-store.test.ts apps/web/src/visual/VisualControlPanelHost.test.tsx --parallel=1
```

Commit: `feat(sonic): add preset settings and persistence`

## Task 8: Implement immutable 512-bin Sonic audio seam and profile

**Files:**

- Add: `packages/visual-engine/src/sonic-topography/sonic-audio-profile.ts`
- Add: matching tests
- Modify: `packages/visual-engine/src/audio/audio-snapshot.ts`
- Modify: `packages/visual-engine/src/audio/audio-reactivity.ts`
- Modify: associated tests

### Step 1: RED→GREEN — fixed Hz bands

使用 synthetic frequency fixtures 逐 band 验证 32..16000Hz 八段边界。

先实现只读 `SonicSpectrumFrame`：同一次 analyser read 内复制/重采样到固定 512-byte buffer，只暴露 `bin()`/`mean()`；不暴露可写 typed array。

### Step 2: RED→GREEN — kick/body/vocal/snap

覆盖 kickSub/core/punch、body、vocal、snap 和 derived lowDrive/dominance/energy。

### Step 3: RED→GREEN — onset/hysteresis/reset

- kick crossing 0.58；
- re-arm below 0.32；
- seek-back reset；
- disabled monitor fallback；
- dt-independent smoothing。
- trackKey、seek-back、sampleRate/fftSize 变化、source detach reset；
- pause decay 不产生 onset，reduced-motion 不停止分析。

### Step 4: Integration

由 `audio-reactivity` 从既有原始 FFT 生成并冻结 `SonicAudioSnapshot`；每 update 最多一份 512-byte frame，不创建新 AudioContext 或第二次 analyser read。composition 将 playback trackKey 作为 timeline identity 提交。

### Step 5: Verify and review

```powershell
bun test packages/visual-engine/src/sonic-topography/sonic-audio-profile.test.ts packages/visual-engine/src/audio --parallel=1
```

Commit: `feat(sonic): add detailed audio profile`

## Task 9: Implement Sonic render plugin and resource lifecycle

**Precondition:** review 必须先确认实现材料只包含本计划、独立 fixture 和可观察行为规格；不得把第三方参考源码或 shader 放入实现上下文。

**Files:**

- Add: `packages/visual-engine/src/sonic-topography/sonic-shaders.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-palette.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-terrain.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-floating-blocks.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-impulses.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-topography.ts`
- Add: `packages/visual-engine/src/sonic-topography/sonic-plugin.ts`
- Add: matching tests
- Modify: `packages/visual-engine/src/index.ts`

### Step 1: Static terrain tracer bullet

创建最小 terrain InstancedMesh，验证 grid/layout/material/uniform 和 dispose。

### Step 2: Direct-port shader adaptation specification

依据独立行为规格设计并锁定本项目自己的 uniform interface、最多 10 个 ripple、地形波动、distance fade/fog、amplitude/EQ 映射；增加 GLSL compile smoke 或 Three material smoke。不得复制或逐行翻译第三方 shader。

### Step 3: Floating and deterministic impulses

注入 RNG，逐个完成 floating、ripple ring、meteor cooldown、trail ring；验证 100/10/20/200 上限。

### Step 4: RED→GREEN — lifecycle

- 7→0→7；
- activate/deactivate/dispose exactly once；
- density/count transactional rebuild；
- failure keeps previous layer；
- exit 后 scene 无 root，resource scope 回基线。

factory 通过完整 plugin context 创建 child resource/cancellation scope；registry 失败回滚且 exactly-once dispose。本任务仍保持 plugin dormant，不开放 public preset 7。

### Step 5: RED→GREEN — cooperative rebuild

- terrain/instance matrix 分 phase 构建；
- settings drag 取消旧 generation；
- stale rebuild 不提交；
- 离开/释放取消 pending rebuild；
- 每 phase 有实例数量和耗时预算。

### Step 6: Resource diagnostics

mesh=4、textures=0、instance cap、geometry soft/hard budget，current/peak 对账。

### Step 7: Verify and review

```powershell
bun test packages/visual-engine/src/sonic-topography --parallel=1
bun run --filter ./packages/visual-engine typecheck
```

Commit: `feat(sonic): implement topography plugin`

## Task 10: Atomically open preset 7 and integrate Sonic policies

**Files:**

- Modify: `packages/visual-engine/src/runtime/render-step-slot.ts`
- Modify: `packages/visual-engine/src/runtime/cinema-camera.ts`
- Modify: `packages/visual-engine/src/runtime/cinema-camera.test.ts`
- Modify: `packages/visual-engine/src/home-visual/preset-state.ts`
- Modify: `packages/visual-engine/src/home-visual/fx-defaults.ts`
- Modify: `apps/web/src/stores/visual-store.ts`
- Modify: `apps/web/src/visual/VisualControlPanelHost.tsx`
- Modify: `packages/visual-engine/src/stage-lyrics/lifecycle.ts`
- Modify: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`
- Modify: composition tests

### Step 1: RED→GREEN — atomic preset opening

- 在同一切片注册 Sonic factory、composition route、`PRESET_COUNT=8`、production selector 与 legacy `8→7` migration；
- 7 在 route ready 前绝不进入旧 Home shader；
- `0..6` 不变；
- NaN/Infinity 归 0，finite 小数统一 `Math.round` 后 clamp。

### Step 2: RED→GREEN — render order and activation

完整顺序 Home → Camera → Gesture → Skull → Sonic → Stage；只在 preset 7 update，preset 6/7 互斥。

### Step 3: RED→GREEN — camera and lyric policies

- baseline `(0,.18,8.4)`；
- composition camera policy 从 Stage world target 获取 lyric lookAt，Sonic 不反向查询 Stage；
- Shelf focus precedence；
- unlocked lyric offset `Y-0.34/Z+0.16`；
- camera lock/detail 不重复偏移。

### Step 4: RED→GREEN — Home preserve

preset 7 进入 Home 仍为 7，pin/open Shelf 被 suppress；0..6 现有 Home behavior 不变。

### Step 5: RED→GREEN — pointer ripple

- click release 触发；
- long press strength ≤3；
- drag/UI/free-camera 不触发；
- cleanup 无 listener 残留。

### Step 6: Verify and review

```powershell
bun test packages/visual-engine/src/runtime/cinema-camera.test.ts packages/visual-engine/src/stage-lyrics/lifecycle.test.ts apps/web/src/visual/runtime/create-legacy-visual-composition.test.ts apps/web/src/visual/useVisualEngine.test.ts --parallel=1
```

Commit: `feat(sonic): integrate preset with visual runtime`

## Task 11: Complete Shelf pools, track-change guard, focus policy, and close animation

**Files:**

- Add: `packages/visual-engine/src/shelf/object-pool.ts`
- Add: `packages/visual-engine/src/shelf/object-pool.test.ts`
- Add: `packages/visual-engine/src/shelf/shelf-resource-diagnostics.ts`
- Modify: `packages/visual-engine/src/shelf/shelf-card-sprite.ts`
- Modify: `packages/visual-engine/src/shelf/shelf-content-sprite.ts`
- Modify: `packages/visual-engine/src/shelf/shelf-animate.ts`
- Modify: `packages/visual-engine/src/shelf/shelf-animate.test.ts`
- Modify: `apps/web/src/visual/shelf-pointer-interactions.ts`
- Modify: `apps/web/src/visual/shelf-pointer-interactions.test.ts`
- Modify: `apps/web/src/visual/shelf-focus-zone.ts`
- Modify: `apps/web/src/stores/shelf-store.ts`
- Modify: `packages/visual-engine/src/home-visual/fx-defaults.ts`
- Modify: `apps/web/src/visual/VisualEngineHost.tsx`
- Modify: `apps/web/src/visual/PlayerConsoleHost.tsx`
- Modify: `apps/web/src/visual/runtime/create-legacy-visual-composition.ts`

### Step 1: RED→GREEN — reusable pool primitive

固定 capacity、acquire/release/rebind、exactly-once dispose、dispose 后拒绝 acquire。

### Step 2: RED→GREEN — 600 card pool

从首到尾滚动 fixture：active+idle ≤11、created ≤11、warm 后不再创建。

### Step 3: RED→GREEN — 600 detail rows

同上，panel ≤1；loading/error/empty 也复用。

### Step 4: RED→GREEN — binding generation

rebind 重置 identity/index/draw key/renderOrder/action payload/visual state 并提升 generation；recycled card/row 的迟到 cover/load 不得污染新 binding。

### Step 5: RED→GREEN — 1120ms track-change guard

- 1119ms 阻断、1120ms 解除；
- hover/click/wheel/contextmenu 均 gate；
- 未 pin/detail 时清状态；
- pin/detail exception；
- injected fake clock。

语义固定：pin/detail 只保持可见；card 交互仍全阻断。identity 有效的已开 detail 内部滚动/row action允许；pointer-down generation 跨切歌的 release 一律丢弃。

### Step 6: RED→GREEN — static focus policy

直接 click/contextmenu/open detail 不得绕过 static；dynamic→static 清旧 focus。

### Step 7: RED→GREEN — close transition generation

- immediate 同 tick dispose；
- normal 保留约180ms且 hit disabled；
- 完成后 exactly once；
- close 后立即 reopen 不被旧 generation 清理。

显式覆盖 `closed/open/closing`，closing 期间 hasOpenContent=true、hit/raycast=false、focus cleared、callback exactly once。

### Step 8: RED→GREEN — build slice budget

每 slice ≤2 cards / target ≤7ms；窗口变化取消 stale build；pool warm 后不 build。

### Step 9: Remaining parity

- stage no-hit normal wheel 不消费；
- Shift 强制；
- portrait predicate 统一；
- 新安装 camera default dynamic、旧 static 保留。

字段缺失与显式 static 必须通过 raw-property presence 区分，并统一修正 fx defaults/store/host/player console/composition fallback。

### Step 10: Resource registration

card/row/panel 的 texture/geometry/material/mesh 逐项登记到 Shelf child scope；idle pool 使用 rebuildable retention；dispose 清零并注销 diagnostics supplier。

### Step 11: Verify and review

```powershell
bun test packages/visual-engine/src/shelf apps/web/src/visual/shelf-pointer-interactions.test.ts apps/web/src/visual/shelf-focus-zone.test.ts apps/web/src/stores/shelf-store.test.ts apps/web/src/visual/runtime/create-legacy-visual-composition.test.ts --parallel=1
bun run --filter ./packages/visual-engine typecheck
bun run --filter ./apps/web typecheck
```

Commit: `feat(shelf): add bounded pools and interaction guards`

## Task 12: Add parity/performance harness, docs, and full verification

**Files:**

- Add: deterministic M4 parity/perf scripts under `scripts/perf` or `scripts/parity`
- Add/Modify: architecture guards
- Modify: `docs/parity/capability-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-26-mineradio-2.0.2-tauri-convergence-design.md`
- Add the distributed Sonic visual origin, Ajin attribution, source commits, public collaboration statement, and Non-Commercial Learning License to `THIRD_PARTY_NOTICES.md`
- Modify: planning/progress docs

### Step 1: License review

记录 Mineradio → Sonic Topography 的来源链、Ajin、公开合作证据、维护者项目决策、许可限定和修改说明；运行 origin-attribution 守卫，确保直接迁移不会丢失署名、非商业告知或“不等于书面授权”的限定。

### Step 2: Deterministic visual evidence

- 固定 RNG/audio/cover/lyrics/viewport/DPR/font；
- Stage 指定时间点 snapshots；
- Sonic 1080p eco golden；
- 5..10 秒 transitions/glitch/seek recording；
- 记录可重复命令和 artifacts 路径。

实现 Playwright/Chromium web fixture：固定 clock/audio/RNG/viewport/DPR/测试字体，等待 `document.fonts.ready`。artifact manifest 记录 commit、浏览器、GPU、字体、seed、fixture、命令和阈值。

Release runner 必须把 repository clean、preview build commit、三场景 console error=0 与真实 GPU timer-query 样本纳入 hard checks；preview 固定端口并使用 `--strictPort`，禁止把旧 4173 构建误记为当前 HEAD。

### Step 3: Performance soak

- Stage rapid scrub / continuous track switches / setting drags / 200+ lines；
- Sonic 10s warmup + 60s sample ×3；
- Shelf 600 cards + 600 rows end-to-end；
- 采样 p50/p95、long frames、peak/current resources、queue depth、renderer memory。

GPU p95 使用 production presentation seam 上的真实 `EXT_disjoint_timer_query_webgl2` query；只有 resolved、non-disjoint 且 `sampleCount > 0` 才是 measured。扩展可用但没有有效样本时，release strict gate 必须失败；runner 不支持时只记录 draw/instance/frame proxy 并标记降级，最终 release 至少在一台支持 timer query 的 Windows runner 上完成硬门。

### Step 4: Update matrix only from evidence

只有达到对应全部 gate 才晋升能力状态：

- `lyrics.stage-v2`；
- `visual.sonic-topography`；
- `shelf.3d`

Stage/Shelf 与直接迁移版 Sonic 已由 `0230feb` 的 clean immutable release evidence 晋升 `implemented`；final manifest 记录 65/65 hard checks、三场景 console errors=0 和真实 GPU timer-query 各 240 samples。

### Step 5: Focused verification

```powershell
bun test packages/visual-engine apps/web/src/visual apps/web/src/stores/visual-store.test.ts apps/web/src/stores/shelf-store.test.ts scripts/architecture --parallel=1
bun run --filter ./packages/visual-engine typecheck
bun run --filter ./apps/web typecheck
```

### Step 6: Full repository verification

```powershell
bun test --parallel=1 packages/shared packages/visual-engine sidecars/api apps/web scripts/ci scripts/architecture
bun run typecheck
bun run web:build
```

再执行仓库现有 API freeze、`git diff --check` 和 `git status --short`。

### Step 7: Final independent review

要求审查者覆盖：

- spec compliance；
- resource ownership；
- cancellation races；
- visual regressions；
- performance gates；
- API freeze；
- third-party notices。

Critical/Important 必须清零。

### Step 8: Final commit

候选提交：`feat(visual): add m4 parity candidates`

禁止使用 `complete m4` 语义，直到 Sonic 直接迁移、来源/许可复审与全部 release gate 同时通过。

## Completion checklist

- [x] Stage translation/display/translation/motion/clarity implemented
- [x] Stage cooperative build and active cancellation implemented
- [x] Stage upload ≤1/frame and clarity pool budgets verified
- [x] Stage pause/seek/resident-prewarm/atomic takeover verified
- [x] Sonic preset 7 + 8→7 migration technical candidate implemented
- [x] Sonic 8-band/Kick analyzer technical candidate implemented without second audio graph
- [x] Sonic 4-mesh resource/lifecycle limits verified for the technical candidate
- [x] Sonic camera/lyrics/Home/Shelf/pointer parity verified for the technical candidate
- [x] Shelf 11/11 pools and 600 item soak verified
- [x] Shelf 1120ms guard/static focus/close animation/build budget verified
- [x] Sidecar/API freeze passes
- [x] Focused tests/typechecks pass
- [x] Full tests/typecheck/build pass
- [x] Visual/performance evidence recorded for Stage/Shelf and the direct-port Sonic implementation
- [x] Capability matrix updated from evidence
- [x] Origin chain, public collaboration statement, license, and attribution recorded
- [x] Sonic origin-attribution guard passes
- [x] Preset 7 opening, 8→7 migration, selector and plugin route landed atomically in the technical candidate
- [x] Per-slice diff proves Sidecar/shared/Rust sidecar packaging freeze
- [x] Final independent review has no Critical/Important

直接迁移版 Sonic 已完成代码复核、来源/许可告知、origin-attribution 守卫和 high/release strict evidence。final manifest 验证 commit `0230feb`、65/65 checks、4 meshes、24,636 instances、Sonic CPU p95 `0.100000ms`、GPU p95 增量 `0.046080ms`、整体 frame p95 `0.400000ms`，因此 `visual.sonic-topography` 已晋升 `implemented`，M4 完成。
