import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_PRODUCTION_DEBUG_MARKERS = Object.freeze([
	"M4ParityRoot",
	"m4-parity",
	"__MINERADIO_M4_PARITY__",
	"visual-audio-debug",
	"__mineradioVisualAudioDebug",
	"mineradio.visualAudioDebug",
	"visualAudioDebug",
	"audioDebug",
	"DEBUG visual audio",
]);

async function artifactFiles(root) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...await artifactFiles(fullPath));
		else if (entry.isFile()) files.push(fullPath);
	}
	return files;
}

export async function findProductionDebugLeakage(distDirectory) {
	const rootStats = await stat(distDirectory).catch(() => null);
	if (!rootStats?.isDirectory()) {
		throw new Error(`production web dist is missing: ${distDirectory}`);
	}
	const violations = [];
	for (const filePath of await artifactFiles(distDirectory)) {
		const bytes = await readFile(filePath);
		const content = bytes.toString("utf8");
		for (const marker of FORBIDDEN_PRODUCTION_DEBUG_MARKERS) {
			if (content.includes(marker)) {
				violations.push({
					file: path.relative(distDirectory, filePath).replaceAll("\\", "/"),
					marker,
				});
			}
		}
	}
	return violations;
}

async function main() {
	const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const distDirectory = process.argv[2]
		? path.resolve(process.argv[2])
		: path.join(repositoryRoot, "apps/web/dist");
	const violations = await findProductionDebugLeakage(distDirectory);
	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(`production debug leakage: ${violation.marker} in ${violation.file}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log(`production debug leakage scan PASS (${distDirectory})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
