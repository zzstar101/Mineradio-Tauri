#!/usr/bin/env node
/**
 * M10 Tier-2 headless runtime-performance benchmark harness (MineRadio-Tauri).
 *
 * Produces honest measured evidence only: rAF frame deltas, long tasks, JS heap,
 * DOM node counts and page errors against the production web bundle served by
 * `vite preview`. It never mocks, estimates or fabricates metrics; unavailable
 * metrics are recorded as null with a note.
 *
 * Usage:
 *   bun scripts/perf/m10-runtime-benchmark.mjs [--quick] [--skip-build] [--out <path>]
 *
 * Scenarios (fixed viewport 1600x900 @ DPR 1, headless Chromium channel):
 *   home-default       boot, idle at default visual quality tier
 *   home-high          visual quality tier forced to "ultra" via the real settings UI
 *   search-interaction search shell typing + result scrolling under load
 *
 * Conventions reused from scripts/perf/m8-budget.mjs (build step) and
 * scripts/parity/m4/capture-evidence.mjs (@playwright/cli driving, config file,
 * per-scenario session cleanup). App runs degraded without Tauri/sidecar; that
 * is acceptable for frontend rendering measurement.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const distRoot = path.join(repoRoot, "apps", "web", "dist");
const defaultOutPath = path.join(repoRoot, "output", "perf", "m10-runtime-benchmark.json");

const VIEWPORT = Object.freeze({ width: 1600, height: 900 });
const DEVICE_SCALE_FACTOR = 1;
const SCENARIO_DURATION_MS_DEFAULT = 15_000;
const SCENARIO_DURATION_MS_QUICK = 5_000;
const BOOT_TIMEOUT_MS = 60_000;
const PREVIEW_START_TIMEOUT_MS = 90_000;
const SETTLE_BEFORE_MEASURE_MS_FULL = 2_000;
const SETTLE_BEFORE_MEASURE_MS_QUICK = 1_200;
const MAX_STORED_ERRORS = 100;

const parsedArgs = parseArguments(process.argv.slice(2));
if (!parsedArgs) process.exit(0);
const quickMode = parsedArgs.quick;
const skipBuild = parsedArgs.skipBuild || process.env.MINERADIO_PERF_SKIP_BUILD === "1";
const outPath = parsedArgs.out ?? defaultOutPath;
const scenarioDurationMs = quickMode ? SCENARIO_DURATION_MS_QUICK : SCENARIO_DURATION_MS_DEFAULT;
const settleBeforeMeasureMs = quickMode ? SETTLE_BEFORE_MEASURE_MS_QUICK : SETTLE_BEFORE_MEASURE_MS_FULL;

const notes = [];
const liveChildProcesses = new Set();
let previewChild = null;

function printUsage() {
	console.log(`M10 runtime benchmark

Usage:
  bun scripts/perf/m10-runtime-benchmark.mjs [options]

Options:
  --quick        Short 5s measurement windows instead of 15s (smoke mode)
  --skip-build   Reuse existing apps/web/dist instead of running "bun run web:build"
                 (also honors MINERADIO_PERF_SKIP_BUILD=1)
  --out <path>   Artifact path (default: output/perf/m10-runtime-benchmark.json)
  --help         Show this help
`);
}

function parseArguments(argv) {
	const options = { quick: false, skipBuild: false, out: null };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			printUsage();
			return null;
		}
		if (argument === "--quick") {
			options.quick = true;
			continue;
		}
		if (argument === "--skip-build") {
			options.skipBuild = true;
			continue;
		}
		if (argument === "--out") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error("--out requires a value.");
			options.out = path.resolve(repoRoot, value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

function quoteArgument(value) {
	const raw = String(value);
	if (!/[^\w./:@\\=-]/.test(raw)) return raw;
	return `"${raw.replace(/"/g, '\\"')}"`;
}

function runCommand(command, args, options = {}) {
	const commandLine = [command, ...args].map(quoteArgument).join(" ");
	const result = spawnSync(commandLine, {
		cwd: repoRoot,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		encoding: "utf8",
		shell: true,
		stdio: options.capture ? "pipe" : "inherit",
		maxBuffer: 64 * 1024 * 1024,
		timeout: options.timeoutMs,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = options.capture
			? `\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`
			: "";
		throw new Error(`Command failed (${result.status}): ${commandLine}${detail}`);
	}
	return result;
}

function runGit(args) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) return null;
	return String(result.stdout ?? "").trim();
}

function findOpenPort(startPort) {
	return new Promise((resolve, reject) => {
		function tryPort(port) {
			const server = net.createServer();
			server.once("error", (error) => {
				if ((error.code === "EADDRINUSE" || error.code === "EACCES") && port < startPort + 64) {
					tryPort(port + 1);
					return;
				}
				reject(error);
			});
			server.once("listening", () => server.close(() => resolve(port)));
			server.listen(port, "127.0.0.1");
		}
		tryPort(startPort);
	});
}

function killProcessTree(pid) {
	if (!pid) return;
	liveChildProcesses.delete(pid);
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			// best-effort cleanup
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

function killAllLiveChildren() {
	for (const pid of [...liveChildProcesses]) killProcessTree(pid);
}

async function probePreviewOnce(baseUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const response = await fetch(`${baseUrl}?__m10_probe=${Date.now()}`, {
			signal: controller.signal,
			cache: "no-store",
		});
		if (!response.ok) throw new Error(`Preview returned HTTP ${response.status}.`);
		return true;
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForPreview(baseUrl) {
	const deadline = Date.now() + PREVIEW_START_TIMEOUT_MS;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			await probePreviewOnce(baseUrl);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw new Error(`vite preview did not become reachable at ${baseUrl}: ${lastError}`);
}

async function startPreviewServer() {
	const port = await findOpenPort(4317);
	const baseUrl = `http://127.0.0.1:${port}/`;
	const child = spawn(
		"bun",
		["run", "--filter", "./apps/web", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
		{ cwd: repoRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	previewChild = child;
	liveChildProcesses.add(child.pid);
	const outputTail = [];
	const pushTail = (chunk) => {
		const text = String(chunk ?? "");
		outputTail.push(text);
		if (outputTail.length > 40) outputTail.shift();
	};
	child.stdout?.on("data", pushTail);
	child.stderr?.on("data", pushTail);
	child.once("exit", () => liveChildProcesses.delete(child.pid));
	try {
		await waitForPreview(baseUrl);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\npreview tail:\n${outputTail.join("")}`);
	}
	return { child, baseUrl, port };
}

// ---------------------------------------------------------------------------
// Playwright CLI driving (mirrors scripts/parity/m4/capture-evidence.mjs)
// ---------------------------------------------------------------------------

function writeRunnerConfig(harnessDirectory) {
	mkdirSync(harnessDirectory, { recursive: true });
	const configPath = path.join(harnessDirectory, "playwright-cli.json");
	writeFileSync(configPath, `${JSON.stringify({
		browser: {
			launchOptions: { headless: true },
			contextOptions: {
				viewport: VIEWPORT,
				deviceScaleFactor: DEVICE_SCALE_FACTOR,
				locale: "zh-CN",
				timezoneId: "Asia/Hong_Kong",
				colorScheme: "dark",
				reducedMotion: "no-preference",
			},
		},
	}, null, 2)}\n`, "utf8");
	return configPath;
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
	const commandLine = ["npx", ...cliArgs].map(quoteArgument).join(" ");
	const result = spawnSync(commandLine, {
		cwd: repoRoot,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
	return options.json === false
		? String(result.stdout ?? "").trim()
		: decodePlaywrightResult(result.stdout, `playwright-cli ${args[0] ?? ""}`);
}

async function openSessionWithBrowserFallback(session, configPath) {
	const channels = ["msedge", "chrome"];
	const failures = [];
	for (const channel of channels) {
		try {
			runPlaywrightCli(session, [
				"open", "about:blank", "--browser", channel, "--config", configPath,
			], { timeoutMs: 120_000 });
			runPlaywrightCli(session, [
				"resize", String(VIEWPORT.width), String(VIEWPORT.height),
			], { timeoutMs: 60_000 });
			return channel;
		} catch (error) {
			failures.push(`${channel}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
			try {
				runPlaywrightCli(session, ["close"], { timeoutMs: 30_000 });
			} catch {
				// session may not exist yet
			}
		}
	}
	throw new Error(`No usable browser channel (tried msedge, chrome):\n${failures.join("\n")}`);
}

// ---------------------------------------------------------------------------
// In-page programs (run-code files; plain ES functions evaluated by playwright-cli)
// ---------------------------------------------------------------------------

function buildScenarioProgram(action) {
	const actionLiteral = JSON.stringify(action);
	return `async page => {
	const action = ${actionLiteral};
	const scenarioErrors = [];
	const setupNotes = [];
	page.on("pageerror", (error) => {
		scenarioErrors.push("pageerror: " + String(error && error.message ? error.message : error).slice(0, 500));
	});
	page.on("console", (message) => {
		try {
			if (message.type() === "error") {
				scenarioErrors.push("console.error: " + String(message.text()).slice(0, 500));
			}
		} catch {}
	});
	page.on("crash", () => {
		scenarioErrors.push("crash: page crashed");
	});

	await page.addInitScript(() => {
		window.__m10LongTasks = [];
		window.__m10LongTasksUnsupported = false;
		try {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					window.__m10LongTasks.push(Number(entry.duration));
				}
			});
			observer.observe({ entryTypes: ["longtask"] });
		} catch (error) {
			window.__m10LongTasksUnsupported = true;
		}
	});

	await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 60000 });

	try {
		// 1) React root mounted (blank-root detection).
		await page.waitForFunction(() => {
			const root = document.getElementById("root");
			return Boolean(root && root.children.length > 0);
		}, null, { polling: 250, timeout: action.bootTimeoutMs });
		// 2) The interactive splash must be clicked through ("点击进入") once it
		//    signals ready (splash-engine marks #splash.ready after its intro).
		const splashMounted = await page.evaluate(() => {
			const element = document.getElementById("splash");
			return Boolean(element) || Boolean(document.querySelector(".visual-splash-root"));
		});
		if (splashMounted) {
			try {
				await page.waitForFunction(() => {
					const element = document.getElementById("splash");
					return Boolean(element && element.classList.contains("ready"));
				}, null, { polling: 250, timeout: action.bootTimeoutMs });
			} catch (readyError) {
				setupNotes.push("splash ready signal timed out; attempting direct dismissal: "
					+ String(readyError && readyError.message ? readyError.message : readyError).slice(0, 120));
			}
			await page.keyboard.press("Enter").catch(() => {});
			await page.locator("#splash").click({ force: true, timeout: 10000 }).catch(() => {});
		}
		// 3) Splash fully torn down (engine cleanup removed body flag + host unmounted).
		await page.waitForFunction(() => {
			const splashActive = document.body.classList.contains("splash-active");
			const splashStillMounted = Boolean(document.querySelector(".visual-splash-root"))
				|| Boolean(document.getElementById("splash"));
			return !splashActive && !splashStillMounted;
		}, null, { polling: 250, timeout: action.bootTimeoutMs });
	} catch (error) {
		const rootChildren = await page.evaluate(() => document.getElementById("root")
			? document.getElementById("root").children.length
			: -1).catch(() => -2);
		return {
			ok: false,
			failure: "boot-gate-timeout(rootChildren=" + String(rootChildren) + "): "
				+ String(error && error.message ? error.message : error).slice(0, 300),
			errors: scenarioErrors.slice(0, action.maxErrors),
			setupNotes,
		};
	}
	try {
		await page.evaluate(async () => {
			if (document.fonts && document.fonts.ready) await document.fonts.ready;
		});
	} catch {}

	if (action.kind === "high-tier") {
		try {
			await page.keyboard.press("Escape").catch(() => {});
			// Fresh profiles boot in "simple mode" which hides #fx-fab entirely
			// (display:none). The real UI path is the desktop titlebar toggle.
			const inSimpleMode = await page.evaluate(() => document.body.classList.contains("simple-mode"));
			if (inSimpleMode) {
				await page.locator("#diy-mode-btn").click({ timeout: 10000 });
				await page.waitForFunction(() => document.body.classList.contains("diy-mode"), null, {
					polling: 100,
					timeout: 10000,
				});
				setupNotes.push("diy-mode entered via #diy-mode-btn (prerequisite for visual console)");
				await page.waitForTimeout(400);
			}
			const fab = page.locator("#fx-fab");
			try {
				await fab.click({ timeout: 10000 });
			} catch (clickError) {
				setupNotes.push("fx-fab needed force click: " + String(clickError && clickError.message ? clickError.message : clickError).slice(0, 120));
				await fab.click({ force: true, timeout: 10000 });
			}
			await page.waitForFunction(() => {
				const panel = document.getElementById("fx-panel");
				return Boolean(panel && panel.classList.contains("show"));
			}, null, { polling: 100, timeout: 10000 }).catch(() => {
				setupNotes.push("fx-panel did not report .show after FAB click");
			});
			await page.locator('[data-settings-tab="system"]').click({ timeout: 10000 });
			await page.locator('#performance-quality-seg [data-performance-quality="ultra"]').click({ timeout: 10000 });
			await page.waitForFunction(() => {
				const button = document.querySelector('[data-performance-quality="ultra"]');
				return Boolean(button && button.classList.contains("active"));
			}, null, { polling: 100, timeout: 10000 });
			const applied = await page.evaluate(() => {
				const active = document.querySelector("#performance-quality-seg button.active");
				return active ? active.getAttribute("data-performance-quality") : null;
			});
			if (applied !== "ultra") {
				scenarioErrors.push("setup: quality tier readback was " + String(applied) + ", expected ultra");
			} else {
				setupNotes.push("quality-tier-applied=ultra via #fx-fab > [data-settings-tab=system] > #performance-quality-seg");
			}
			try {
				await fab.click({ timeout: 8000 });
			} catch {
				await fab.click({ force: true, timeout: 5000 }).catch(() => {});
			}
			const panelStillOpen = await page.evaluate(() => {
				const panel = document.getElementById("fx-panel");
				return Boolean(panel && panel.classList.contains("show"));
			}).catch(() => null);
			if (panelStillOpen === true) {
				setupNotes.push("fx-panel remained open during measurement (state recorded honestly)");
			}
		} catch (error) {
			scenarioErrors.push("setup: high-tier UI drive failed: "
				+ String(error && error.message ? error.message : error).slice(0, 300));
			try {
				const panelVisible = await page.evaluate(() => {
					const panel = document.getElementById("fx-panel");
					return Boolean(panel && panel.classList.contains("show"));
				});
				if (panelVisible) await page.locator("#fx-fab").click({ force: true, timeout: 5000 }).catch(() => {});
			} catch {}
		}
		await page.mouse.move(4, 4).catch(() => {});
	} else {
		await page.mouse.move(4, 4).catch(() => {});
	}

	await page.waitForTimeout(action.settleBeforeMeasureMs);

	const interactionState = { keysTyped: 0, wheelScrolls: 0 };
	const measurePromise = page.evaluate((config) => {
		const memoryInfo = () => {
			const mem = performance.memory;
			if (!mem || typeof mem.usedJSHeapSize !== "number" || !Number.isFinite(mem.usedJSHeapSize)) return null;
			return mem;
		};
		const domNodeCount = () => document.getElementsByTagName("*").length;
		const longTasksAll = Array.isArray(window.__m10LongTasks) ? window.__m10LongTasks : [];
		const longTaskIndexBefore = longTasksAll.length;
		const heapStart = memoryInfo();
		const domStart = domNodeCount();
		const startedAt = performance.now();
		const deltas = [];
		let maxHeapBytes = heapStart ? heapStart.usedJSHeapSize : null;
		let last = startedAt;
		const runWindow = new Promise((resolve) => {
			function frame(now) {
				deltas.push(now - last);
				last = now;
				const mem = memoryInfo();
				if (mem && (maxHeapBytes === null || mem.usedJSHeapSize > maxHeapBytes)) {
					maxHeapBytes = mem.usedJSHeapSize;
				}
				if (now - startedAt >= config.durationMs) {
					resolve(null);
					return;
				}
				requestAnimationFrame(frame);
			}
			requestAnimationFrame(frame);
		});
		return runWindow.then(() => {
			const wallMs = performance.now() - startedAt;
			const heapEnd = memoryInfo();
			if (heapEnd && (maxHeapBytes === null || heapEnd.usedJSHeapSize > maxHeapBytes)) {
				maxHeapBytes = heapEnd.usedJSHeapSize;
			}
			const domEnd = domNodeCount();
			const windowTasks = longTasksAll.slice(longTaskIndexBefore);
			let totalTaskMs = 0;
			for (const duration of windowTasks) totalTaskMs += duration;
			const sortedDeltas = deltas.slice().sort((a, b) => a - b);
			const percentileDelta = (quantile) => {
				if (sortedDeltas.length === 0) return null;
				const index = Math.ceil(quantile * sortedDeltas.length) - 1;
				return sortedDeltas[Math.min(sortedDeltas.length - 1, Math.max(0, index))];
			};
			const medianDelta = percentileDelta(0.5);
			let droppedFrames = 0;
			if (medianDelta !== null) {
				for (const delta of deltas) {
					if (delta > medianDelta * 1.5) droppedFrames += 1;
				}
			}
			const fpsFromDelta = (delta) => (delta !== null && delta > 0 ? 1000 / delta : null);
			return {
				frameSamples: deltas.length,
				wallMs,
				fps: {
					p50: fpsFromDelta(percentileDelta(0.5)),
					p95: fpsFromDelta(percentileDelta(0.95)),
					p99: fpsFromDelta(percentileDelta(0.99)),
					effective: deltas.length > 0 ? deltas.length / (wallMs / 1000) : null,
				},
				droppedRatio: deltas.length > 0 ? droppedFrames / deltas.length : null,
				longTasks: {
					count: windowTasks.length,
					totalMs: totalTaskMs,
				},
				heap: (heapStart && heapEnd && maxHeapBytes !== null)
					? {
						usedStartBytes: heapStart.usedJSHeapSize,
						usedEndBytes: heapEnd.usedJSHeapSize,
						usedMaxBytes: maxHeapBytes,
					}
					: null,
				domNodes: {
					start: domStart,
					end: domEnd,
				},
				longTasksUnsupported: window.__m10LongTasksUnsupported === true,
			};
		});
	}, {
		durationMs: action.durationMs,
	}).catch((evaluateError) => ({
		failed: true,
		message: String(evaluateError && evaluateError.message ? evaluateError.message : evaluateError),
	}));

	if (action.kind === "search-interaction") {
		try {
			const input = page.locator("#search-input");
			await input.click({ timeout: 10000 });
			const phrase = "MineRadio 搜索 benchmark abcdefgh 0123456789";
			let cursor = 0;
			const deadline = Date.now() + Math.max(500, action.durationMs - 400);
			while (Date.now() < deadline) {
				const chunkEnd = Math.min(phrase.length, cursor + 6);
				const chunk = phrase.slice(cursor, chunkEnd);
				cursor = chunkEnd >= phrase.length ? 0 : chunkEnd;
				const typer = typeof input.pressSequentially === "function"
					? input.pressSequentially.bind(input)
					: input.type.bind(input);
				await typer(chunk, { delay: 65, timeout: 8000 });
				interactionState.keysTyped += chunk.length;
				if (Date.now() >= deadline) break;
				const box = await page.locator("#search-results").boundingBox().catch(() => null);
				if (box && box.height > 40) {
					await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				} else {
					await page.mouse.move(VIEWPORT_W_FALLBACK / 2, VIEWPORT_H_FALLBACK / 2);
				}
				await page.mouse.wheel(0, 320);
				interactionState.wheelScrolls += 1;
				await page.waitForTimeout(140);
				if (Date.now() >= deadline) break;
				await page.mouse.wheel(0, -320);
				interactionState.wheelScrolls += 1;
				await page.waitForTimeout(140);
			}
		} catch (error) {
			scenarioErrors.push("interaction: " + String(error && error.message ? error.message : error).slice(0, 300));
		}
	}

	const measured = await measurePromise;
	if (measured && measured.failed) {
		return {
			ok: false,
			failure: "measure-evaluate: " + measured.message,
			errors: scenarioErrors.slice(0, action.maxErrors),
			setupNotes,
		};
	}
	return {
		ok: true,
		metrics: measured,
		errors: scenarioErrors.slice(0, action.maxErrors),
		setupNotes,
		interactions: action.kind === "search-interaction" ? interactionState : undefined,
	};
}`;
}

// The program template references viewport center for wheel fallback; inject constants.
function finalizeProgramSource(source) {
	return source
		.replace(/VIEWPORT_W_FALLBACK/g, String(VIEWPORT.width))
		.replace(/VIEWPORT_H_FALLBACK/g, String(VIEWPORT.height));
}

// ---------------------------------------------------------------------------
// Scenario orchestration
// ---------------------------------------------------------------------------

const SCENARIOS = Object.freeze([
	{ name: "home-default", kind: "idle" },
	{ name: "home-high", kind: "high-tier" },
	{ name: "search-interaction", kind: "search-interaction" },
]);

function roundTo(value, digits) {
	if (value === null || value === undefined || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

async function runScenario(scenario, context) {
	const session = `m10-${scenario.name}-${process.pid}-${Date.now().toString(36)}`;
	const notesForRun = [];
	const collectedErrors = [];
	const programPath = path.join(context.harnessDirectory, `${scenario.name}.js`);
	writeFileSync(programPath, `${finalizeProgramSource(buildScenarioProgram({
		url: context.baseUrl,
		kind: scenario.kind,
		durationMs: scenarioDurationMs,
		settleBeforeMeasureMs,
		bootTimeoutMs: BOOT_TIMEOUT_MS,
		maxErrors: MAX_STORED_ERRORS,
		viewportWidth: VIEWPORT.width,
		viewportHeight: VIEWPORT.height,
	}))}\n`, "utf8");

	let browserChannel = null;
	try {
		browserChannel = await openSessionWithBrowserFallback(session, context.configPath);
		const outcome = runPlaywrightCli(session, [
			"run-code", "--filename", programPath,
		], { timeoutMs: 240_000 });

		if (!outcome || outcome.ok !== true) {
			collectedErrors.push(`${outcome?.failure ?? "unknown run-code failure"}`);
			collectedErrors.push(...(Array.isArray(outcome?.errors) ? outcome.errors : []));
			return {
				name: scenario.name,
				durationMs: scenarioDurationMs,
				fps: { p50: null, p95: null, p99: null, effective: null },
				droppedRatio: null,
				longTasks: { count: null, totalMs: null },
				heap: null,
				domNodes: { start: null, end: null },
				errors: collectedErrors,
				measurable: false,
				_runNotes: notesForRun,
			};
		}

		for (const note of outcome.setupNotes ?? []) notesForRun.push(note);
		collectedErrors.push(...(Array.isArray(outcome.errors) ? outcome.errors : []));
		if (outcome.metrics.longTasksUnsupported) {
			notesForRun.push("longtask PerformanceObserver unsupported in this browser; count/total reported as measured-empty (0)");
		}
		if (!outcome.metrics.heap) {
			notesForRun.push("performance.memory unavailable; heap recorded as null");
		}
		if (outcome.interactions) {
			notesForRun.push(`interactions applied: keysTyped=${outcome.interactions.keysTyped} wheelScrolls=${outcome.interactions.wheelScrolls}`);
		}
		const metrics = outcome.metrics;
		return {
			name: scenario.name,
			durationMs: scenarioDurationMs,
			fps: {
				p50: roundTo(metrics.fps.p50, 3),
				p95: roundTo(metrics.fps.p95, 3),
				p99: roundTo(metrics.fps.p99, 3),
				effective: roundTo(metrics.fps.effective, 3),
			},
			droppedRatio: roundTo(metrics.droppedRatio, 4),
			longTasks: {
				count: metrics.longTasks.count,
				totalMs: roundTo(metrics.longTasks.totalMs, 2),
			},
			heap: metrics.heap
				? {
					usedStartBytes: metrics.heap.usedStartBytes,
					usedEndBytes: metrics.heap.usedEndBytes,
					usedMaxBytes: metrics.heap.usedMaxBytes,
				}
				: null,
			domNodes: {
				start: metrics.domNodes.start,
				end: metrics.domNodes.end,
			},
			errors: collectedErrors,
			measurable: Number(metrics.fps.effective) > 0 && Number(metrics.fps.effective) < 500,
			_runNotes: notesForRun,
		};
	} catch (error) {
		collectedErrors.push(`harness: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		return {
			name: scenario.name,
			durationMs: scenarioDurationMs,
			fps: { p50: null, p95: null, p99: null, effective: null },
			droppedRatio: null,
			longTasks: { count: null, totalMs: null },
			heap: null,
			domNodes: { start: null, end: null },
			errors: collectedErrors,
			measurable: false,
			_runNotes: [`browserChannel=${browserChannel ?? "none"}`, ...notesForRun],
		};
	} finally {
		try {
			runPlaywrightCli(session, ["close"], { timeoutMs: 60_000 });
		} catch {
			// an already-exited session must not block artifact generation
		}
	}
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatNumber(value, digits = 2) {
	if (value === null || value === undefined || !Number.isFinite(Number(value))) return "n/a";
	return Number(value).toFixed(digits);
}

function markdownTable(rows) {
	const widths = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, String(cell).length);
		});
	}
	return rows
		.map((row, rowIndex) => {
			const line = `| ${row.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ")} |`;
			if (rowIndex !== 0) return line;
			return `${line}\n| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
		})
		.join("\n");
}

function printSummary(report) {
	console.log("");
	console.log("# M10 runtime benchmark (raw evidence)");
	console.log("");
	console.log(`- generatedAt: ${report.generatedAt}`);
	console.log(`- commit: ${report.commit ?? "n/a"}${report.dirty ? " (dirty)" : " (clean)"}`);
	console.log(`- buildMode: ${report.buildMode}; quick=${quickMode}; durationPerScenario=${scenarioDurationMs}ms`);
	console.log(`- viewport: ${VIEWPORT.width}x${VIEWPORT.height}@${DEVICE_SCALE_FACTOR}; headless; channel fallback msedge->chrome`);
	console.log("");
	const rows = [
		["scenario", "dur s", "fps eff", "fps p50", "fps p95", "fps p99", "dropped", "longtask n", "longtask ms", "heap dMiB", "heap maxMiB", "dom s/e", "errs"],
	];
	for (const scenario of report.scenarios) {
		const heapDeltaMib = scenario.heap
			? formatNumber((scenario.heap.usedEndBytes - scenario.heap.usedStartBytes) / (1024 * 1024), 2)
			: "n/a";
		const heapMaxMib = scenario.heap
			? formatNumber(scenario.heap.usedMaxBytes / (1024 * 1024), 2)
			: "n/a";
		rows.push([
			scenario.name,
			formatNumber(scenario.durationMs / 1000, 0),
			formatNumber(scenario.fps.effective, 1),
			formatNumber(scenario.fps.p50, 1),
			formatNumber(scenario.fps.p95, 1),
			formatNumber(scenario.fps.p99, 1),
			scenario.droppedRatio === null ? "n/a" : `${(scenario.droppedRatio * 100).toFixed(1)}%`,
			scenario.longTasks.count ?? "n/a",
			formatNumber(scenario.longTasks.totalMs, 1),
			heapDeltaMib,
			heapMaxMib,
			scenario.domNodes.start === null ? "n/a" : `${scenario.domNodes.start}/${scenario.domNodes.end}`,
			scenario.errors.length,
		]);
	}
	console.log(markdownTable(rows));
	if (report.notes.length > 0) {
		console.log("");
		console.log("Notes:");
		for (const note of report.notes) console.log(`- ${note}`);
	}
	console.log("");
	console.log(`artifact: ${path.relative(repoRoot, outPath)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	if (skipBuild) {
		if (!existsSync(distRoot)) {
			throw new Error(`--skip-build requested but apps/web/dist is missing: ${distRoot}`);
		}
		notes.push("build skipped (--skip-build); measured existing apps/web/dist");
	} else {
		console.log("[m10] building web production bundle (bun run web:build)...");
		runCommand("bun", ["run", "web:build"], { timeoutMs: 600_000 });
		notes.push("production bundle built via 'bun run web:build' before measurement");
	}
	if (!existsSync(distRoot)) throw new Error("apps/web/dist is missing after build");

	const commitShort = runGit(["rev-parse", "--short", "HEAD"]);
	const dirty = Boolean(runGit(["status", "--porcelain=v1"]));

	const outDirectory = path.dirname(outPath);
	mkdirSync(outDirectory, { recursive: true });
	const harnessDirectory = path.join(outDirectory, ".m10-harness");
	const configPath = writeRunnerConfig(harnessDirectory);

	const preview = await startPreviewServer();
	notes.push(`app served degraded by vite preview at ${preview.baseUrl} (no Tauri/sidecar; frontend rendering measurement only)`);

	try {
		const scenarios = [];
		for (const scenario of SCENARIOS) {
			console.log(`[m10] measuring ${scenario.name} (${scenarioDurationMs}ms window)...`);
			const result = await runScenario(scenario, {
				baseUrl: preview.baseUrl,
				harnessDirectory,
				configPath,
			});
			scenarios.push(result);
			console.log(
				`[m10] ${scenario.name}: fps.effective=${formatNumber(result.fps.effective, 1)}`
				+ ` errors=${result.errors.length}`
				+ `${result.measurable ? "" : " (NOT measurable)"}`,
			);
		}

		notes.push("fps.pNN = 1000 / rAF frame-delta pNN in ms (lower means worse tail latency); fps.effective = frames / wall seconds");
		notes.push("droppedRatio = share of frame deltas exceeding 1.5x the median delta within the same window");
		notes.push("longtask count/totalMs are scoped to each measurement window via PerformanceObserver('longtask'); observer delivery may lag window close slightly");
		notes.push(`browser channel resolved per session: msedge first, chrome fallback (${scenarios.every((s) => s.measurable) ? "primary channel sufficient" : "see scenario errors if any"})`);

		const report = {
			generatedAt: new Date().toISOString(),
			commit: commitShort,
			dirty,
			buildMode: "production-vite-preview",
			scenarios: scenarios.map(({ _runNotes, measurable, ...schemaScenario }) => {
				void measurable;
				void _runNotes;
				return schemaScenario;
			}),
			notes: [
				...notes,
				...scenarios.flatMap((scenario) => (scenario._runNotes ?? []).map((note) => `[${scenario.name}] ${note}`)),
			],
		};

		writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		printSummary(report);

		const measurableCount = scenarios.filter((scenario) => scenario.measurable).length;
		if (measurableCount === 0) {
			console.error("[m10] no scenario produced measurable data; failing");
			process.exitCode = 1;
		} else {
			process.exitCode = 0;
		}
	} finally {
		killProcessTree(preview.child.pid);
	}
}

process.on("exit", () => {
	killAllLiveChildren();
});
process.on("SIGINT", () => {
	killAllLiveChildren();
	process.exit(130);
});
process.on("SIGTERM", () => {
	killAllLiveChildren();
	process.exit(143);
});

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	killAllLiveChildren();
	process.exitCode = 1;
});
