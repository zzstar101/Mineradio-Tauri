import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Layer 3 geometry guard for the Wave 3 Player Shell / Bottom Bar.
 *
 * Unit runs can't load CSS/layout in happy-dom, so this guard asserts the
 * golden geometry tokens that live in the canonical Wave 3 stylesheet match the
 * upstream fixture (docs/audit/golden/player-shell/upstream-player-shell.json).
 * Real browser geometry diffs are captured by the Playwright CLI evidence
 * runner (Layer 4+); this guard catches silent CSS drift at the automation gate.
 */

const repoRoot = path.resolve(__dirname, "../..");
const cssPath = path.join(
  repoRoot,
  "apps/web/src/styles/wave3-player-shell.css",
);
const goldenPath = path.join(
  repoRoot,
  "docs/audit/golden/player-shell/upstream-player-shell.json",
);

test("Wave 3 player-shell CSS exists and carries canonical geometry tokens", () => {
  const css = readFileSync(cssPath, "utf-8");
  expect(css.length).toBeGreaterThan(2_000);

  const requiredTokens = [
    ".mini-queue-head .fx-mini-btn.ghost",
    ".control-title-badges",
    "#quality-btn.quality-pill",
    ".control-quality-chip",
    ".volume-main-row",
    ".fade-control-row",
    "#volume-value",
    ".lyric-timing-head strong",
    ".lyric-timing-actions",
    "#controls-hide-btn",
    "body.immersive-mode",
    "body.panel-reordering",
    "@media (max-width: 920px)",
    "@media (max-width: 620px)",
  ];
  for (const token of requiredTokens) {
    expect(css.includes(token), `missing geometry token: ${token}`).toBe(true);
  }

  // Geometry values mirrored from the upstream fixture.
  expect(css.includes("height: 15px")).toBe(true); // quality pill / source chip
  expect(css.includes("width: 226px")).toBe(true); // volume popover width
  expect(css.includes("bottom: 46px")).toBe(true); // popover anchor
  expect(css.includes("width: min(620px, calc(100vw - 56px))")).toBe(true);
});

test("Player Shell golden fixture structure order stays canonical", () => {
  const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as typeof import(
    "../../docs/audit/golden/player-shell/upstream-player-shell.json"
  );
  expect(golden.structure.order).toEqual([
    "mini-queue-popover",
    "progress-bar",
    "controls",
  ]);
  expect(golden.interactions.lyricOffset.steps).toEqual([-0.1, 0, 0.1]);
});

test("mini queue drag-sort scope (IN) is reflected in the golden contract + CSS", () => {
  const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as typeof import(
    "../../docs/audit/golden/player-shell/upstream-player-shell.json"
  );
  const css = readFileSync(cssPath, "utf-8");
  expect(golden.interactions.reorder).toContain("long-press");
  expect(css.includes("panel-reordering")).toBe(true);
  expect(css.includes(".mini-queue-item.is-reordering")).toBe(true);
});