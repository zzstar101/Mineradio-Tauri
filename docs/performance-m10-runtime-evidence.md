# M10 Runtime Performance Evidence

本文件区分 deterministic/code evidence 与真实 Windows WebView2 field evidence。没有采到的指标明确写为 `Not Measured`。

## Before / After

| signal | before (code evidence) | after (code evidence) | field result |
| --- | --- | --- | --- |
| React root playback position subscription | `App.tsx` directly subscribed to `positionMs` (60Hz path) | `usePlaybackUiPosition()` publishes bounded 125ms snapshots; seek jumps publish immediately | Not Measured in WebView2 |
| UI position publication | every store `timeupdate` | 7–9 publications per synthetic 60Hz second | automated test |
| visual foreground scheduler | every presentation frame for all quality tiers | eco 30fps, balanced 45fps, high 60/vsync-compatible, ultra vsync | Not Measured |
| audio/media clock | coupled through store value | runtime `AudioFrameSource` remains authoritative; UI gate does not throttle media clock | automated contract tests |
| inactive Home/Library heavy surface | still mounted by design; ownership not yet safely separable | unchanged pending ownership seam | Not Measured |
| Three.js calls/triangles/textures | Not Measured | existing `renderer.info` collector contract retained | Not Measured |
| frame p50/p95/p99, dropped frames | Not Measured | Not Measured | Not Measured |
| WebView2 CPU/GPU/RSS/private memory | Not Measured | Not Measured | Not Measured |
| long-run resource plateau | deterministic resource ledgers only | deterministic ledgers remain bounded | Windows soak Not Measured |

## Evidence Commands

```text
bun test --parallel=1 apps/web/src/stores/playback-ui-position.test.ts apps/web/src/audio/local-audio-import.test.ts apps/web/src/visual/runtime/visual-snapshot-builders.test.ts
bun run typecheck
bun run web:build
bun run perf:budget
```

The M8 deterministic gate is Tier 1 evidence. Tier 2 headless browser and Tier 3 Windows WebView2 GPU/compositor evidence remain pending and must not be inferred from these tests.

