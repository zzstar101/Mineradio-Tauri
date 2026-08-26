import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M10 perf(ui) 挂载纪律守卫。
 *
 * 行为说明：AppShell 中下列表面是"永久挂载"契约的一部分——
 * - VisualSurface 承载 Three.js/WebGL 画布与视觉引擎生命周期；
 * - PlaybackRuntimeSurface 持有 <audio> 元素；
 * - HomeSurface / LibrarySurface 主面板持有搜索/书架状态局部性与上游对齐行为；
 * - PlaybackSurface 主控件由内部 visible 状态驱动。
 * 它们在 JSX 中必须无条件渲染（不能被 `&&`、三元或提前 return 移出树），
 * 否则卸载会破坏画布/音频生命周期与状态局部性。其余 overlay 类表面
 * （登录弹窗等）在验证状态全部外置后允许条件挂载以降低常驻合成开销。
 */
const shellSource = readFileSync(
  resolve(import.meta.dir, "../../apps/web/src/app/AppShell.tsx"),
  "utf8",
);

test("AppShell keeps lifecycle-critical surfaces unconditionally mounted", () => {
  const compositionSource = shellSource.slice(
    shellSource.indexOf("export function AppShell"),
  );
  const unconditionalTokens = [
    "<VisualSurface",
    "<HomeSurface",
    "<AccountSurface",
    "<LibrarySurface",
    "<PlaybackSurface",
    "<PlaybackRuntimeSurface",
  ];

  for (const token of unconditionalTokens) {
    const line = compositionSource
      .split("\n")
      .find((sourceLine) => sourceLine.includes(token));
    expect(line).toBeDefined();
    // 无条件使用 = 该 JSX 元素是语句起点（仅缩进在前），
    // 而不是 `{cond && <X/>}` 或 `{cond ? (<X/>) : null}` 的一部分。
    expect(line?.trim().startsWith(token)).toBe(true);
  }
});

test("AccountOverlaySurface is lazily mounted behind its modalOpen gate", () => {
  const compositionSource = shellSource.slice(
    shellSource.indexOf("export function AppShell"),
  );
  expect(compositionSource).toContain("accountOverlay.modalOpen ? (");
  expect(compositionSource).toContain("<AccountOverlaySurface {...accountOverlay} />");
});
