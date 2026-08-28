#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	M4_RELEASE_GPU_MINIMUM_SAMPLES,
	M4_RELEASE_PERFORMANCE_BUDGETS,
	evaluateRunChecks,
	evaluateSceneChecks,
	projectRuntimeEvidence,
	resolveSonicEvidenceQuality,
	summarizeChecks,
} from "./evidence-model.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const DEFAULT_SCENES = ["stage", "sonic", "shelf"];
const VIEWPORT = Object.freeze({ width: 1_920, height: 1_080 });
const FRAME_MS = 1_000 / 60;
const recordedCommands = [];
const FIXTURE_COVER_PREFIX = "fixture://cover/";
const FIXTURE_COVER_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">',
	'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
	'<stop stop-color="#18334f"/><stop offset="1" stop-color="#d69b4d"/>',
	'</linearGradient></defs>',
	'<rect width="96" height="96" rx="14" fill="url(#g)"/>',
	'<circle cx="48" cy="48" r="24" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="5"/>',
	'<circle cx="48" cy="48" r="6" fill="#fff" fill-opacity=".9"/>',
	'</svg>',
].join("");
const FIXTURE_COVER_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FIXTURE_COVER_SVG)}`;

function printUsage() {
	console.log(`M4 Playwright CLI evidence runner

Usage:
  node scripts/parity/m4/capture-evidence.mjs [options]

Options:
  --base-url <url>          Vite preview URL (default: http://127.0.0.1:4173/)
  --output <path>           Artifact directory (default: output/playwright/m4)
  --browser <channel>       Playwright CLI browser channel (default: msedge)
  --seed <integer>          Deterministic RNG seed (default: 20240728)
  --profile <quick|release> Capture profile (default: quick)
  --sonic-quality <tier>   eco|balanced|high|ultra (default: quick=eco, release=high)
  --baseline-frame-p95-ms <ms>
                            Current Tauri baseline overall frame p95
  --baseline-gpu-p95-ms <ms>
                            Matching baseline GPU timer-query p95
  --baseline-source-commit <sha>
                            Baseline evidence repository commit
  --baseline-source-manifest <path>
                            Baseline evidence manifest path
  --scenes <csv>            Any of stage,sonic,shelf (default: all)
  --skip-video              Do not capture the Stage seek/transition video
  --strict                  Exit 2 when parity checks fail
  --keep-sessions           Leave Playwright CLI sessions open for inspection
  --headed                  Launch the browser visibly
  --help                    Show this help

Examples:
  node scripts/parity/m4/capture-evidence.mjs
  node scripts/parity/m4/capture-evidence.mjs --profile release --strict --baseline-frame-p95-ms 1.25 --baseline-gpu-p95-ms 0.42 --baseline-source-commit <sha> --baseline-source-manifest <path>
`);
}

function readOptionValue(argv, index, name) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
	return value;
}

export function parseArguments(argv) {
	const options = {
		baseUrl: "http://127.0.0.1:4173/",
		outputDirectory: path.join(repositoryRoot, "output", "playwright", "m4"),
		browser: "msedge",
		seed: 20_240_728,
		profile: "quick",
		sonicQuality: null,
		performanceBaseline: {
			frameP95Ms: null,
			gpuP95Ms: null,
			sourceCommit: "",
			sourceManifest: "",
		},
		scenes: [...DEFAULT_SCENES],
		captureVideo: true,
		strict: false,
		keepSessions: false,
		headed: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			printUsage();
			return null;
		}
		if (argument === "--skip-video") {
			options.captureVideo = false;
			continue;
		}
		if (argument === "--strict") {
			options.strict = true;
			continue;
		}
		if (argument === "--keep-sessions") {
			options.keepSessions = true;
			continue;
		}
		if (argument === "--headed") {
			options.headed = true;
			continue;
		}
		if (argument === "--base-url") {
			options.baseUrl = readOptionValue(argv, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--output") {
			options.outputDirectory = path.resolve(repositoryRoot, readOptionValue(argv, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--browser") {
			options.browser = readOptionValue(argv, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--seed") {
			const value = Number(readOptionValue(argv, index, argument));
			if (!Number.isSafeInteger(value)) throw new Error("--seed must be a safe integer.");
			options.seed = value;
			index += 1;
			continue;
		}
		if (argument === "--profile") {
			const value = readOptionValue(argv, index, argument);
			if (value !== "quick" && value !== "release") throw new Error("--profile must be quick or release.");
			options.profile = value;
			index += 1;
			continue;
		}
		if (argument === "--sonic-quality") {
			const value = readOptionValue(argv, index, argument);
			if (!["eco", "balanced", "high", "ultra"].includes(value)) {
				throw new Error("--sonic-quality must be eco, balanced, high, or ultra.");
			}
			options.sonicQuality = value;
			index += 1;
			continue;
		}
		if (argument === "--baseline-frame-p95-ms" || argument === "--baseline-gpu-p95-ms") {
			const value = Number(readOptionValue(argv, index, argument));
			if (!Number.isFinite(value) || value < 0) throw new Error(`${argument} must be a non-negative finite number.`);
			if (argument === "--baseline-frame-p95-ms") options.performanceBaseline.frameP95Ms = value;
			else options.performanceBaseline.gpuP95Ms = value;
			index += 1;
			continue;
		}
		if (argument === "--baseline-source-commit") {
			options.performanceBaseline.sourceCommit = readOptionValue(argv, index, argument).trim();
			index += 1;
			continue;
		}
		if (argument === "--baseline-source-manifest") {
			options.performanceBaseline.sourceManifest = path.resolve(
				repositoryRoot,
				readOptionValue(argv, index, argument),
			);
			index += 1;
			continue;
		}
		if (argument === "--scenes") {
			const scenes = readOptionValue(argv, index, argument)
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			if (scenes.length === 0 || scenes.some((scene) => !DEFAULT_SCENES.includes(scene))) {
				throw new Error("--scenes only accepts stage,sonic,shelf.");
			}
			options.scenes = [...new Set(scenes)];
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}

	options.sonicQuality = resolveSonicEvidenceQuality(options.profile, options.sonicQuality);
	return options;
}

function ensureDirectory(directory) {
	mkdirSync(directory, { recursive: true });
}

function quoteArgument(value) {
	const raw = String(value);
	if (!/[^\w./:@\\=-]/.test(raw)) return raw;
	return `"${raw.replace(/"/g, '\\"')}"`;
}

function runCommand(command, args, options = {}) {
	const commandLine = [command, ...args].map(quoteArgument).join(" ");
	if (options.record !== false) recordedCommands.push(commandLine);
	const result = spawnSync(commandLine, {
		cwd: repositoryRoot,
		env: {
			...process.env,
			NO_COLOR: "1",
			FORCE_COLOR: "0",
		},
		encoding: "utf8",
		shell: true,
		stdio: "pipe",
		maxBuffer: 64 * 1024 * 1024,
		timeout: options.timeoutMs ?? 180_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error([
			`Command failed (${result.status}): ${commandLine}`,
			result.stdout ? `STDOUT:\n${result.stdout}` : "",
			result.stderr ? `STDERR:\n${result.stderr}` : "",
		].filter(Boolean).join("\n"));
	}
	return {
		commandLine,
		stdout: String(result.stdout ?? "").trim(),
		stderr: String(result.stderr ?? "").trim(),
	};
}

function parseJsonOutput(output, label) {
	if (!output) return null;
	try {
		return JSON.parse(output);
	} catch (error) {
		throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${output}`);
	}
}

function decodePlaywrightResult(output, label) {
	const envelope = parseJsonOutput(output, label);
	const result = envelope?.result;
	if (typeof result !== "string") return result ?? envelope;
	const trimmed = result.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return result;
	try {
		return JSON.parse(trimmed);
	} catch {
		return result;
	}
}

function runPlaywrightCli(session, args, options = {}) {
	const cliArgs = ["--yes", "--package", "@playwright/cli", "playwright-cli"];
	if (session) cliArgs.push(`-s=${session}`);
	if (options.json !== false) cliArgs.push("--json");
	cliArgs.push(...args);
	const result = runCommand("npx", cliArgs, { timeoutMs: options.timeoutMs });
	return options.json === false
		? result.stdout
		: decodePlaywrightResult(result.stdout, `playwright-cli ${args[0] ?? ""}`);
}

function runGit(args) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: "pipe",
	});
	if (result.status !== 0) return null;
	return String(result.stdout ?? "").trim();
}

function relativeArtifactPath(filePath) {
	const relative = path.relative(repositoryRoot, filePath);
	return relative && !relative.startsWith("..") ? relative.replaceAll("\\", "/") : filePath;
}

function cliArtifactPath(filePath) {
	const relative = path.relative(repositoryRoot, filePath);
	return relative && !relative.startsWith("..") ? relative : filePath;
}

function fileArtifact(filePath, kind) {
	if (!existsSync(filePath)) return { kind, path: relativeArtifactPath(filePath), exists: false, bytes: 0 };
	const stats = statSync(filePath);
	const artifact = {
		kind,
		path: relativeArtifactPath(filePath),
		exists: true,
		bytes: stats.size,
	};
	if (kind === "screenshot" && stats.size >= 24) {
		const header = readFileSync(filePath).subarray(0, 24);
		if (header.toString("hex", 0, 8) === "89504e470d0a1a0a") {
			artifact.width = header.readUInt32BE(16);
			artifact.height = header.readUInt32BE(20);
		}
	}
	return artifact;
}

async function probePreview(baseUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const response = await fetch(baseUrl, { signal: controller.signal });
		if (!response.ok) throw new Error(`Preview returned HTTP ${response.status}.`);
		return {
			url: response.url,
			status: response.status,
			contentType: response.headers.get("content-type"),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function scenarioUrl(baseUrl, scene, seed, sonicQuality) {
	const url = new URL("m4-fixture.html", baseUrl);
	url.searchParams.set("scene", scene);
	url.searchParams.set("mode", "deterministic");
	url.searchParams.set("seed", String(seed));
	url.searchParams.set("quality", sonicQuality);
	return url.toString();
}

function writeRunnerConfig(outputDirectory, headed) {
	const harnessDirectory = path.join(outputDirectory, ".harness");
	ensureDirectory(harnessDirectory);
	const configPath = path.join(harnessDirectory, "playwright-cli.json");
	writeFileSync(configPath, `${JSON.stringify({
		browser: {
			launchOptions: {
				headless: !headed,
			},
			contextOptions: {
				viewport: VIEWPORT,
				deviceScaleFactor: 1,
				locale: "zh-CN",
				timezoneId: "Asia/Hong_Kong",
				colorScheme: "dark",
				reducedMotion: "no-preference",
			},
		},
	}, null, 2)}\n`, "utf8");
	return { configPath, harnessDirectory };
}

function browserProgram(input) {
	return `async page => {
	const input = ${JSON.stringify(input)};
	await page.waitForFunction(() => Boolean(window.__MINERADIO_M4_PARITY__), null, { timeout: 30000 });
	const browser = page.context().browser();
	const pageResult = await page.evaluate(async (action) => {
		const wait = (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
		const contract = window.__MINERADIO_M4_PARITY__;
		if (!contract) throw new Error("M4 parity contract is unavailable.");
		await contract.ready;
		await document.fonts.ready;

		const snapshot = () => contract.snapshot();
		const pendingState = (scene, value) => {
			const performance = value?.performance ?? {};
			const tasks = performance.tasks ?? {};
			const subsystems = performance.subsystems ?? {};
			const basePending = (Number(tasks.queued) || 0) + (Number(tasks.running) || 0);
			const renderer = value?.renderer ?? {};
			const gpuTiming = renderer.gpuTiming ?? {};
			const gpuSupported = gpuTiming.extensionSupported === true || renderer.gpuTimerQuerySupported === true;
			const gpuReady = !action.requireGpuTiming
				|| !gpuSupported
				|| (Number(gpuTiming.sampleCount) || 0) > 0;
			if (scene === "stage") {
				const stage = subsystems["stage-lyrics"] ?? {};
				const pending = basePending
					+ (Number(stage.activeBuilds) || 0)
					+ (Number(stage.pendingBuilds) || 0)
					+ (Number(stage.pendingUploads) || 0);
				return { pending, ready: pending === 0 && Number(stage.residentRows) > 0 && gpuReady };
			}
			if (scene === "sonic") {
				const sonic = subsystems.sonicTopography ?? {};
				const pending = basePending + (Number(sonic.pendingRebuilds) || 0);
				return { pending, ready: pending === 0 && sonic.active === true && Number(sonic.residentMeshCount) === 4 && gpuReady };
			}
			const shelf = subsystems.shelf ?? {};
			return {
				pending: basePending,
				ready: basePending === 0
					&& Number(shelf.cards?.created) > 0
					&& Number(shelf.detailRows?.created) > 0
					&& gpuReady,
			};
		};
		const advance = async (frameCount, frameMs = action.frameMs) => {
			let remaining = Math.max(0, Math.floor(Number(frameCount) || 0));
			while (remaining > 0) {
				const next = Math.min(remaining, 60);
				await contract.step(next, frameMs);
				remaining -= next;
			}
		};
		const settle = async (scene, maxBatches = 80, batchFrames = 3) => {
			let stableReadyBatches = 0;
			let latest = snapshot();
			for (let batch = 0; batch < maxBatches; batch += 1) {
				await contract.step(batchFrames, action.frameMs);
				latest = snapshot();
				const state = pendingState(scene, latest);
				stableReadyBatches = state.ready ? stableReadyBatches + 1 : 0;
				if (stableReadyBatches >= 2) return { batches: batch + 1, state, snapshot: latest };
			}
			return { batches: maxBatches, state: pendingState(scene, latest), snapshot: latest };
		};

		let settleResult = null;
		const samples = [];
		if (action.kind === "prepare") {
			if (action.seekMs !== null) contract.seek(action.seekMs);
			await advance(action.advanceFrames);
			settleResult = await settle(action.scene, action.settleMaxBatches, action.settleBatchFrames);
		} else if (action.kind === "stage-transition") {
			for (let index = 0; index < action.scrubPoints; index += 1) {
				contract.seek((index * 791) % 11_500);
				await contract.step(1, action.frameMs);
			}
			for (const segment of action.segments) {
				contract.seek(segment.seekMs);
				for (let frame = 0; frame < segment.frames; frame += 1) {
					await contract.step(1, action.frameMs);
					if (action.wallDelayMs > 0) await wait(action.wallDelayMs);
				}
			}
			settleResult = await settle(action.scene, action.settleMaxBatches, action.settleBatchFrames);
		} else if (action.kind === "sonic-sample") {
			await advance(action.warmupFrames);
			for (let sampleIndex = 0; sampleIndex < action.repetitions; sampleIndex += 1) {
				await advance(action.sampleFrames);
				samples.push(snapshot());
			}
			settleResult = await settle(action.scene, action.settleMaxBatches, action.settleBatchFrames);
		} else if (action.kind === "shelf-soak") {
			await contract.soakShelf();
			await advance(action.advanceFrames);
			settleResult = await settle(action.scene, action.settleMaxBatches, action.settleBatchFrames);
		} else {
			throw new Error("Unknown browser action kind: " + action.kind);
		}

		const canvas = document.querySelector(".m4-parity-stage canvas");
		const probeCanvas = document.createElement("canvas");
		const gl = probeCanvas.getContext("webgl2", { powerPreference: "high-performance" });
		let webgl = { webgl2: false, timerQuerySupported: false };
		if (gl) {
			const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
			webgl = {
				webgl2: true,
				vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
				renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
				version: gl.getParameter(gl.VERSION),
				shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
				maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
				maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
				maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
				maxSamples: gl.getParameter(gl.MAX_SAMPLES),
				timerQuerySupported: Boolean(gl.getExtension("EXT_disjoint_timer_query_webgl2")),
				supportedExtensions: (gl.getSupportedExtensions() ?? []).slice().sort(),
				contextAttributes: gl.getContextAttributes(),
			};
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		}

		const fontFaces = typeof document.fonts?.values === "function"
			? Array.from(document.fonts.values()).map((face) => ({
				family: face.family,
				style: face.style,
				weight: face.weight,
				status: face.status,
			})).sort((left, right) => left.family.localeCompare(right.family))
			: [];
		const memory = performance.memory
			? {
				jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
				totalJSHeapSize: performance.memory.totalJSHeapSize,
				usedJSHeapSize: performance.memory.usedJSHeapSize,
			}
			: null;

		return {
			status: document.querySelector("[data-m4-parity-status]")?.getAttribute("data-m4-parity-status") ?? null,
			snapshot: snapshot(),
			samples,
			settle: settleResult,
			environment: {
				buildCommit: contract.buildCommit,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				devicePixelRatio: window.devicePixelRatio,
				canvas: canvas ? {
					clientWidth: canvas.clientWidth,
					clientHeight: canvas.clientHeight,
					width: canvas.width,
					height: canvas.height,
				} : null,
				userAgent: navigator.userAgent,
				language: navigator.language,
				languages: Array.from(navigator.languages ?? []),
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				fonts: {
					status: document.fonts.status,
					rootFontFamily: getComputedStyle(document.documentElement).fontFamily,
					microsoftYaHei: document.fonts.check('700 32px "Microsoft YaHei"'),
					segoeUi: document.fonts.check('700 32px "Segoe UI"'),
					arial: document.fonts.check('700 32px Arial'),
					faces: fontFaces,
				},
				webgl,
				memory,
			},
		};
	}, input);

	return {
		url: page.url(),
		browser: {
			name: browser?.browserType().name() ?? null,
			version: browser?.version() ?? null,
		},
		viewport: page.viewportSize(),
		...pageResult,
	};
}`;
}

function writeBrowserProgram(harnessDirectory, label, input) {
	const filePath = path.join(harnessDirectory, `${label}.js`);
	writeFileSync(filePath, `${browserProgram(input)}\n`, "utf8");
	return filePath;
}

function parityPageInitProgram(enableFixtureCoverResolver) {
	return `async page => {
	const coverUrl = ${JSON.stringify(FIXTURE_COVER_DATA_URL)};
	const fixturePrefix = ${JSON.stringify(FIXTURE_COVER_PREFIX)};
	const faviconSvg = ${JSON.stringify(FIXTURE_COVER_SVG)};
	await page.route("**/favicon.ico", (route) => route.fulfill({
		status: 200,
		contentType: "image/svg+xml",
		body: faviconSvg,
	}));
	if (${JSON.stringify(enableFixtureCoverResolver)}) {
		await page.addInitScript(({ replacement, prefix }) => {
			const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
			if (!descriptor?.get || !descriptor.set) return;
			Object.defineProperty(HTMLImageElement.prototype, "src", {
				configurable: descriptor.configurable,
				enumerable: descriptor.enumerable,
				get: descriptor.get,
				set(value) {
					const next = typeof value === "string" && value.startsWith(prefix) ? replacement : value;
					descriptor.set.call(this, next);
				},
			});
		}, { replacement: coverUrl, prefix: fixturePrefix });
	}
	return {
		installed: true,
		faviconRoute: true,
		fixtureCoverResolver: ${JSON.stringify(enableFixtureCoverResolver)},
		replacementScheme: "data:",
	};
}`;
}

function installParityPageHarness(session, harnessDirectory, scene) {
	const filePath = path.join(harnessDirectory, `${scene}-page-init.js`);
	writeFileSync(filePath, `${parityPageInitProgram(scene === "shelf")}\n`, "utf8");
	return runPlaywrightCli(session, ["run-code", "--filename", cliArtifactPath(filePath)], { timeoutMs: 60_000 });
}

function runBrowserAction(session, harnessDirectory, label, input) {
	const programPath = writeBrowserProgram(harnessDirectory, label, input);
	const startedAt = performance.now();
	const result = runPlaywrightCli(session, ["run-code", "--filename", cliArtifactPath(programPath)], { timeoutMs: 300_000 });
	return {
		...result,
		hostWallMs: performance.now() - startedAt,
	};
}

function captureScreenshot(session, filePath) {
	ensureDirectory(path.dirname(filePath));
	runPlaywrightCli(session, ["screenshot", "--filename", cliArtifactPath(filePath)], { timeoutMs: 60_000 });
	return fileArtifact(filePath, "screenshot");
}

function sceneProfile(profile, scene) {
	if (profile === "release") {
		return scene === "sonic"
			? { warmupFrames: 600, sampleFrames: 3_600, repetitions: 3 }
			: scene === "stage"
				? { scrubPoints: 240, transitionFrames: 100 }
				: { advanceFrames: 240 };
	}
	return scene === "sonic"
		? { warmupFrames: 240, sampleFrames: 600, repetitions: 1 }
		: scene === "stage"
			? { scrubPoints: 24, transitionFrames: 100 }
			: { advanceFrames: 120 };
}

function baseAction(scene, kind, profile, strict) {
	return {
		kind,
		scene,
		frameMs: FRAME_MS,
		settleMaxBatches: 80,
		settleBatchFrames: 3,
		requireGpuTiming: profile === "release" && strict,
	};
}

function captureScene(options, runnerConfig, scene) {
	const sceneDirectory = path.join(options.outputDirectory, scene);
	ensureDirectory(sceneDirectory);
	const session = `m4-evidence-${scene}-${process.pid}-${Date.now().toString(36)}`;
	const url = scenarioUrl(options.baseUrl, scene, options.seed, options.sonicQuality);
	const checkpoints = [];
	const artifacts = [];
	let videoStarted = false;

	try {
		const openArgs = ["open", "about:blank", "--browser", options.browser, "--config", cliArtifactPath(runnerConfig.configPath)];
		if (options.headed) openArgs.push("--headed");
		runPlaywrightCli(session, openArgs, { timeoutMs: 120_000 });
		runPlaywrightCli(session, ["resize", String(VIEWPORT.width), String(VIEWPORT.height)], { timeoutMs: 60_000 });
		installParityPageHarness(session, runnerConfig.harnessDirectory, scene);
		runPlaywrightCli(session, ["goto", url], { timeoutMs: 120_000 });

		if (scene === "stage") {
			const profile = sceneProfile(options.profile, scene);
			const steady = runBrowserAction(session, runnerConfig.harnessDirectory, "stage-steady", {
				...baseAction(scene, "prepare", options.profile, options.strict),
				seekMs: 3_200,
				advanceFrames: 60,
			});
			checkpoints.push({ name: "steady", ...steady });
			artifacts.push(captureScreenshot(session, path.join(sceneDirectory, "stage-steady-4200ms.png")));

			const videoPath = path.join(sceneDirectory, "stage-seek-transition.webm");
			if (options.captureVideo) {
				runPlaywrightCli(session, ["video-start", cliArtifactPath(videoPath), "--size", `${VIEWPORT.width}x${VIEWPORT.height}`], { timeoutMs: 60_000 });
				videoStarted = true;
			}
			const transition = runBrowserAction(session, runnerConfig.harnessDirectory, "stage-transition", {
				...baseAction(scene, "stage-transition", options.profile, options.strict),
				scrubPoints: profile.scrubPoints,
				wallDelayMs: options.captureVideo ? 12 : 0,
				segments: [
					{ seekMs: 3_000, frames: profile.transitionFrames },
					{ seekMs: 7_200, frames: profile.transitionFrames },
					{ seekMs: 9_900, frames: profile.transitionFrames },
				],
			});
			checkpoints.push({ name: "seek-transition", ...transition });
			if (videoStarted) {
				runPlaywrightCli(session, ["video-stop"], { timeoutMs: 60_000 });
				videoStarted = false;
				artifacts.push(fileArtifact(videoPath, "video"));
			}
			artifacts.push(captureScreenshot(session, path.join(sceneDirectory, "stage-after-seek.png")));
		} else if (scene === "sonic") {
			const profile = sceneProfile(options.profile, scene);
			const sample = runBrowserAction(session, runnerConfig.harnessDirectory, "sonic-sample", {
				...baseAction(scene, "sonic-sample", options.profile, options.strict),
				warmupFrames: profile.warmupFrames,
				sampleFrames: profile.sampleFrames,
				repetitions: profile.repetitions,
			});
			checkpoints.push({ name: `${options.sonicQuality}-sample`, ...sample });
			artifacts.push(captureScreenshot(
				session,
				path.join(sceneDirectory, `sonic-${options.sonicQuality}-1920x1080.png`),
			));
		} else {
			const profile = sceneProfile(options.profile, scene);
			const soak = runBrowserAction(session, runnerConfig.harnessDirectory, "shelf-soak", {
				...baseAction(scene, "shelf-soak", options.profile, options.strict),
				advanceFrames: profile.advanceFrames,
			});
			checkpoints.push({ name: "600-card-600-row-soak", ...soak });
			artifacts.push(captureScreenshot(session, path.join(sceneDirectory, "shelf-600x600-soak.png")));
		}

		const finalCheckpoint = checkpoints.at(-1);
		const finalSnapshot = finalCheckpoint?.snapshot ?? null;
		const environment = {
			...(finalCheckpoint?.environment ?? {}),
			viewport: finalCheckpoint?.viewport ?? finalCheckpoint?.environment?.viewport ?? null,
			webgl: finalCheckpoint?.environment?.webgl ?? null,
		};
		const runtimeEvidence = projectRuntimeEvidence(finalSnapshot, environment.webgl);
		const consoleErrors = runPlaywrightCli(session, ["console", "error"], { timeoutMs: 60_000 });
		const checks = evaluateSceneChecks(scene, finalSnapshot, environment, {
			profile: options.profile,
			strict: options.strict,
			expectedCommit: options.expectedCommit,
			consoleErrors,
			sonicQuality: options.sonicQuality,
			performanceBaseline: options.performanceBaseline,
		});
		const sceneEvidence = {
			scene,
			url,
			session,
			fixture: scene === "stage"
				? "M4_LYRICS_TRANSLATED"
				: scene === "sonic"
					? `M4_SONIC_AUDIO_FRAMES / ${options.sonicQuality} preset 7`
					: "M4_SHELF_600 + generated 600 detail rows",
			profile: options.profile,
			sonicQuality: finalSnapshot?.sonicQuality ?? options.sonicQuality,
			performanceBaseline: { ...options.performanceBaseline },
			checkpoints,
			finalSnapshot,
			environment,
			runtimeEvidence,
			checks,
			consoleErrors,
			artifacts,
		};
		const evidencePath = path.join(sceneDirectory, "evidence.json");
		writeFileSync(evidencePath, `${JSON.stringify(sceneEvidence, null, 2)}\n`, "utf8");
		artifacts.push(fileArtifact(evidencePath, "evidence"));
		return sceneEvidence;
	} catch (error) {
		if (videoStarted) {
			try {
				runPlaywrightCli(session, ["video-stop"], { timeoutMs: 60_000 });
			} catch {
				// 主错误优先，停止录屏失败只留在命令日志中。
			}
		}
		return {
			scene,
			url,
			session,
			profile: options.profile,
			checkpoints,
			artifacts,
			error: error instanceof Error ? error.stack ?? error.message : String(error),
			checks: [{
				id: `${scene}.capture`,
				severity: "hard",
				status: "fail",
				actual: "capture failed",
				expected: "capture completed",
			}],
		};
	} finally {
		if (!options.keepSessions) {
			try {
				runPlaywrightCli(session, ["close"], { timeoutMs: 60_000 });
			} catch {
				// 已异常退出的独立 session 无需阻塞 manifest 生成。
			}
		}
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!options) return;
	const repository = {
		root: repositoryRoot,
		commit: runGit(["rev-parse", "HEAD"]),
		branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
		dirty: Boolean(runGit(["status", "--porcelain=v1"])),
	};
	ensureDirectory(options.outputDirectory);
	const runnerConfig = writeRunnerConfig(options.outputDirectory, options.headed);
	const preview = await probePreview(options.baseUrl);
	const startedAt = new Date();
	const playwrightCliVersion = runPlaywrightCli(null, ["--version"], { json: false, timeoutMs: 60_000 });
	const sceneResults = [];

	for (const scene of options.scenes) {
		console.log(`[m4-evidence] capturing ${scene}...`);
		const result = captureScene({ ...options, expectedCommit: repository.commit }, runnerConfig, scene);
		sceneResults.push(result);
		console.log(`[m4-evidence] ${scene}: ${result.error ? "capture-error" : "captured"}`);
	}

	const runChecks = evaluateRunChecks(repository, {
		profile: options.profile,
		strict: options.strict,
	});
	const summary = summarizeChecks([...sceneResults, { scene: "run", checks: runChecks }]);
	const manifest = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		repository,
		runner: {
			path: "scripts/parity/m4/capture-evidence.mjs",
			invocation: ["node", "scripts/parity/m4/capture-evidence.mjs", ...process.argv.slice(2)].map(quoteArgument).join(" "),
			playwrightCliVersion,
			requestedBrowserChannel: options.browser,
			profile: options.profile,
			strict: options.strict,
		},
		preview: {
			...preview,
			buildCommit: sceneResults.find((scene) => scene.environment?.buildCommit)?.environment?.buildCommit ?? null,
		},
		input: {
			baseUrl: options.baseUrl,
			seed: options.seed,
			mode: "deterministic",
			viewport: VIEWPORT,
			deviceScaleFactor: 1,
			locale: "zh-CN",
			timezoneId: "Asia/Hong_Kong",
			scenes: options.scenes,
			sonicQuality: options.sonicQuality,
			performanceBaseline: { ...options.performanceBaseline },
			captureVideo: options.captureVideo,
		},
		measurementPolicy: {
			cpuFrameCost: "measured by the production VisualPerformanceSnapshot collector",
			rendererCounters: "proxy evidence from Three.js renderer.info",
			gpuTimer: `measured by resolved EXT_disjoint_timer_query_webgl2 queries around the production presentation render; release strict requires at least ${M4_RELEASE_GPU_MINIMUM_SAMPLES} real samples`,
			sonicReleaseBudgets: M4_RELEASE_PERFORMANCE_BUDGETS,
		},
		scenes: sceneResults,
		runChecks,
		summary,
		commands: recordedCommands,
	};
	const manifestPath = path.join(options.outputDirectory, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	console.log(`[m4-evidence] manifest: ${relativeArtifactPath(manifestPath)}`);
	console.log(`[m4-evidence] checks: ${summary.passed}/${summary.total} passed; status=${summary.status}`);
	if (options.strict && summary.status !== "pass") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
