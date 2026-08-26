import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../../apps/web/src/app/App.tsx", import.meta.url), "utf8");
const positionSource = readFileSync(new URL("../../apps/web/src/stores/playback-ui-position.ts", import.meta.url), "utf8");
const visualBuilderSource = readFileSync(new URL("../../apps/web/src/visual/runtime/visual-snapshot-builders.ts", import.meta.url), "utf8");

test("realtime playback position stays behind the bounded UI snapshot seam", () => {
	expect(appSource).toContain("usePlaybackUiPosition");
	expect(appSource).not.toMatch(/usePlaybackStore\(\s*\(s\)\s*=>\s*s\.positionMs/);
	expect(positionSource).toContain("PLAYBACK_UI_POSITION_INTERVAL_MS = 125");
});

test("visual foreground quality policy remains runtime-owned and provider-agnostic", () => {
	expect(visualBuilderSource).toContain("resolveForegroundFramePolicy");
	expect(visualBuilderSource).not.toContain("sidecarBaseUrl");
	expect(visualBuilderSource).not.toContain("fetch(");
});
