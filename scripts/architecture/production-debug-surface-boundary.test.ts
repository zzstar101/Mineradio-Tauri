import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("production bootstrap has no M4 fixture query route", () => {
	const main = read("apps/web/src/main.tsx");
	expect(main).not.toContain("M4ParityRoot");
	expect(main).not.toContain("m4-parity");
	expect(main).not.toContain("./visual/parity/");
});

test("production visual composition does not import or instantiate the audio debugger", () => {
	const composition = read("apps/web/src/visual/runtime/create-legacy-visual-composition.ts");
	expect(composition).not.toContain("visual-audio-debug");
	expect(composition).not.toContain("createVisualAudioDebugger");
	expect(composition).not.toContain("visualAudioDebugger");
});

test("ordinary desktop controls do not render or auto-probe raw diagnostics", () => {
	const controls = read("apps/web/src/features/desktop/DesktopRuntimeControls.tsx");
	const runtime = read("apps/web/src/features/desktop/useDesktopManagementRuntime.ts");
	expect(controls).not.toContain("Native 诊断");
	expect(controls).not.toContain("Visual 诊断");
	expect(controls).not.toContain("刷新诊断");
	expect(runtime).not.toContain("void refreshDiagnostics()");
	expect(runtime).not.toContain("await refreshDiagnostics()");
});
