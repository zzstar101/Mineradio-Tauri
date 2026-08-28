import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findProductionDebugLeakage } from "./verify-web-production-artifacts.mjs";

test("production artifact scanner checks emitted JavaScript and source maps", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "mineradio-production-scan-"));
	try {
		await mkdir(path.join(root, "assets"));
		await writeFile(path.join(root, "assets", "app.js"), "console.log('release')");
		await writeFile(
			path.join(root, "assets", "app.js.map"),
			JSON.stringify({ sourcesContent: ["const key = 'mineradio.visualAudioDebug'"] }),
		);
		const violations = await findProductionDebugLeakage(root);
		expect(violations).toContainEqual({
			file: "assets/app.js.map",
			marker: "mineradio.visualAudioDebug",
		});
		expect(violations.every((violation) => violation.file === "assets/app.js.map")).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("production artifact scanner accepts a clean emitted bundle", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "mineradio-production-scan-"));
	try {
		await writeFile(path.join(root, "index.html"), "<script src='/assets/app.js'></script>");
		expect(await findProductionDebugLeakage(root)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
