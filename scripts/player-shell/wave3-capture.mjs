#!/usr/bin/env node
// Wave 3B — Player Shell capture harness (Layer 3/4 evidence).
//
// Two targets:
//   upstream  — the frozen upstream v2.1.0 static page (served copy), driven by
//               its own JS (real state transitions: volume popover, immersive…).
//   current   — the real current production build (vite preview), booting the
//               canonical main.tsx -> App route, importing a REAL local MP3
//               through the #file-input flow so playback/shell start for real.
//
// Each state produces a screenshot (fixed viewport/DPR) + a geometry JSON of the
// key Player Shell elements. Output dirs keep the two sides separate so the
// diff step can compare them ROI-wise.
//
// Usage:
//   node scripts/player-shell/wave3-capture.mjs current --base-url http://127.0.0.1:4173/ --out .playwright-cli/wave3/current
//   node scripts/player-shell/wave3-capture.mjs upstream --base-url http://127.0.0.1:5190/ --out .playwright-cli/wave3/upstream
//   --states default,volume,lyric-timing,quality,mini-queue,auto-hide,immersive,window-920,window-620
//   --viewport 1920x1080 | 920x1080 | 620x1080
//   --fixture <mp3>   (current only)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const DEFAULT_FIXTURE = path.join(repositoryRoot, ".playwright-cli/fixtures/wave3-fixture.mp3");

const STATE_NAMES = [
  "default",
  "volume",
  "lyric-timing",
  "quality",
  "mini-queue",
  "auto-hide",
  "immersive",
  "window-920",
  "window-620",
];

function usage() {
  console.log(`Wave 3B Player Shell capture harness

Usage:
  node scripts/player-shell/wave3-capture.mjs <current|upstream> --base-url <url> --out <dir> [options]

Options:
  --base-url <url>    App / upstream static page URL (required)
  --out <dir>         Artifact output directory (required)
  --states <csv>      default,volume,lyric-timing,quality,mini-queue,auto-hide,immersive,window-920,window-620
  --viewport <WxH>    Default 1920x1080
  --fixture <path>    Local MP3 fixture (current target only)
  --head-w  <px>      Headless window width override for this capture (same as viewport)
`);
}

function arg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function runCommand(command, args, timeoutMs = 240000) {
  const line = [command, ...args]
    .map((raw) => String(raw).includes(" ") ? `"${String(raw).replace(/"/g, '\\"')}"` : String(raw))
    .join(" ");
  const result = spawnSync("cmd.exe", ["/c", line], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  return {
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    status: result.status,
  };
}

function runPlaywright(session, args, timeoutMs = 180000) {
  const cliArgs = ["--yes", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, "--json", ...args];
  return runCommand("npx", cliArgs, timeoutMs);
}

function parseOutput(output, label) {
  try {
    const envelope = JSON.parse(output);
    const result = envelope?.result;
    if (typeof result === "string") {
      const trimmed = result.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
      return result;
    }
    if (typeof result === "object" && result !== null) return result;
    return envelope;
  } catch (error) {
    throw new Error(`${label}: invalid output\n${output}`);
  }
}

function cliPath(outDir) {
  const relative = path.relative(repositoryRoot, outDir);
  return (relative && !relative.startsWith("..") ? relative : outDir).replaceAll("\\", "/");
}

function writeConfig(outDir, viewport) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const configPath = path.join(outDir, ".harness/playwright-cli.json");
  if (!existsSync(path.dirname(configPath))) mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    browser: {
      launchOptions: {
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--hide-scrollbars"],
      },
      contextOptions: {
        viewport,
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Hong_Kong",
        colorScheme: "dark",
        reducedMotion: "no-preference",
      },
    },
  }, null, 2)}\n`, "utf8");
  return configPath;
}

function writeProgram(outDir, label, body) {
  const filePath = path.join(outDir, ".harness", `${label}.js`);
  writeFileSync(filePath, `${body}\n`, "utf8");
  return cliPath(filePath);
}

function currentBootProgram(fixture) {
  return `async page => {
	const mp3 = ${JSON.stringify(fixture)};
	await page.waitForTimeout(1200);
	// Splash is a canvas surface with a delayed ready state. Wait for the
	// actual accessible splash root, dismiss it, then require it to be gone
	// before importing the fixture or capturing shell geometry.
	try {
		await page.waitForSelector("#splash.ready", { state: "attached", timeout: 10000 });
		const enter = await page.$("#splash.ready");
		if (enter) { await enter.click(); }
		await page.waitForFunction(() => !document.body.classList.contains("splash-active"), null, { timeout: 15000 });
	} catch (e) {
		throw new Error("current splash did not dismiss: " + String(e));
	}
	await page.setInputFiles("#file-input", mp3);
	await page.waitForFunction(() => {
		const bar = document.getElementById("bottom-bar");
		return !!bar && (bar.classList.contains("visible") || !!document.querySelector("#control-cover"));
	}, null, { timeout: 30000 });
	await page.waitForTimeout(1200);
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(300);
	return { booted: true };
}`;
}

function upstreamBootProgram() {
  return `async page => {
	await page.waitForTimeout(2500);
	try {
		await page.waitForSelector("#splash.ready", { state: "attached", timeout: 10000 });
		const enter = await page.$("#splash.ready");
		if (enter) await enter.click();
		await page.waitForFunction(() => !document.body.classList.contains("splash-active"), null, { timeout: 15000 });
	} catch (e) {
		throw new Error("upstream splash did not dismiss: " + String(e));
	}
	await page.waitForTimeout(1200);
	await page.evaluate(() => document.fonts.ready);
	return { booted: true };
}`;
}

function stateDriverProgram(state, target) {
  const normalizeComparableState = target === "upstream" ? `await page.evaluate(() => {
    const title = document.getElementById("control-title-text");
    const artist = document.getElementById("control-artist");
    if (title) title.textContent = "wave3-fixture";
    if (artist) artist.textContent = "本地文件";
  });` : ``;
  const actions = {
    "default": `await page.evaluate(() => { document.body.classList.remove("immersive-mode"); })`,
    "volume": `await page.click("#volume-btn", { timeout: 8000 });`,
    "lyric-timing": `await page.hover("#lyric-timing-control", { timeout: 8000 });`,
    "quality": `await page.evaluate(() => { document.body.classList.remove("simple-mode"); document.body.classList.add("diy-mode"); const title = document.getElementById("control-title-text"); const artist = document.getElementById("control-artist"); if (title) title.textContent = ""; if (artist) artist.textContent = ""; }); await page.waitForTimeout(260); await page.click("#quality-btn", { timeout: 8000 }); await page.waitForTimeout(420);`,
    "mini-queue": `await page.click("#mini-queue-btn", { timeout: 8000 });`,
    "auto-hide": `await page.evaluate(() => {
      const bar = document.getElementById("bottom-bar");
      bar?.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: true }));
      bar?.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: true }));
      document.body.classList.remove("controls-visible");
    }); await page.waitForTimeout(900);`,
    "immersive": `await page.evaluate(() => {
      document.body.classList.add("controls-visible");
      const bar = document.getElementById("bottom-bar");
      bar?.classList.add("visible");
      bar?.classList.remove("soft-hidden");
      document.querySelectorAll(".show").forEach((node) => node.classList.remove("show"));
    }); await page.click("#immersive-btn", { timeout: 8000 }); await page.waitForTimeout(120); await page.evaluate(() => {
      if (typeof window.revealBottomControls === "function") window.revealBottomControls(5000);
      document.body.classList.add("controls-visible");
      const bar = document.getElementById("bottom-bar");
      bar?.classList.add("visible");
      bar?.classList.remove("soft-hidden");
    }); await page.waitForTimeout(520);`,

    "window-920": ``,
    "window-620": ``,
  }[state] ?? ``;
  return `async page => {
	${normalizeComparableState}
	${actions}
	await page.waitForTimeout(260);
	const out = await page.evaluate(() => { ${geometryBody()} });
	return out;
}`;
}

function geometryBody() {
  // Runs inside page.evaluate (DOM context).
  return `
	const rect = (sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return { x: Math.round(r.left*10)/10, y: Math.round(r.top*10)/10, width: Math.round(r.width*10)/10, height: Math.round(r.height*10)/10, layoutWidth: Math.round((parseFloat(cs.width) || r.width)*10)/10, layoutHeight: Math.round((parseFloat(cs.height) || r.height)*10)/10, visible: cs.visibility !== "hidden" && r.width > 1 && r.height > 1, display: cs.display, opacity: cs.opacity, zIndex: cs.zIndex };
	};
	return {
		title: document.querySelector("#control-title-text")?.textContent ?? "",
		artist: document.querySelector("#control-artist")?.textContent ?? "",
		cover: rect("#control-cover"),
		progress: rect("#progress-bar"),
		handle: rect("#bottom-handle"),
		bar: rect("#bottom-bar"),
		play: rect("#play-btn"),
		prev: rect("#prev-btn"),
		next: rect("#next-btn"),
		quality: rect("#quality-control"),
		qualityPopover: rect(".quality-popover"),
		heart: rect("#heart-btn"),
		collect: rect("#collect-btn"),
		volume: rect("#volume-control"),
		volumePopover: rect(".volume-popover"),
		lyricTiming: rect("#lyric-timing-control"),
		lyricPopover: rect("#lyric-timing-popover"),
		miniQueueBtn: rect("#mini-queue-btn"),
		miniQueue: rect("#mini-queue-popover"),
		controlsHide: rect("#controls-hide-btn"),
		immersive: rect("#immersive-btn"),
		fullscreen: rect(".fullscreen-toggle-btn"),
		timeDisplay: rect("#time-display"),
		qtyOptions: document.querySelectorAll("#quality-option-list .quality-option").length,
		barClasses: document.getElementById("bottom-bar")?.className ?? "",
		bodyClasses: document.body.className,
		bodyImmersive: document.body.classList.contains("immersive-mode"),
	};
`;
}


function routeProgram() {
  return `async page => {
	const mp3 = ${JSON.stringify(DEFAULT_FIXTURE)};
	await page.waitForTimeout(1000);
	try { await page.waitForSelector("#splash.ready", { state: "attached", timeout: 10000 }); const en = await page.$("#splash.ready"); if (en) await en.click(); await page.waitForFunction(() => !document.body.classList.contains("splash-active"), null, { timeout: 15000 }); } catch(e){ throw new Error("route splash did not dismiss: " + String(e)); }
	await page.setInputFiles("#file-input", mp3);
	await page.waitForFunction(() => !!document.getElementById("control-cover"), null, { timeout: 30000 });
	await page.waitForTimeout(800);
	const barState = () => page.evaluate(() => {
		const bar = document.getElementById("bottom-bar");
		return { barVisible: !!bar && bar.classList.contains("visible"), barZ: bar ? getComputedStyle(bar).zIndex : null, handle: !!document.getElementById("bottom-handle"), cover: !!document.getElementById("control-cover"), bodyClasses: document.body.className };
	});
	const steps = [];
	steps.push({ step: "player", ...(await barState()) });
	try {
		const input = await page.$("#search-box input, #search-input");
		if (input) await input.click();
		await page.waitForTimeout(250);
	} catch(e){}
	steps.push({ step: "search-focus", ...(await barState()) });
	try {
		const input = await page.$("#search-box input, #search-input");
		if (input) await input.type("test");
		await page.waitForTimeout(1400);
	} catch(e){}
	steps.push({ step: "search-typing", ...(await barState()) });
	try {
		const fab = await page.$("#fx-fab");
		if (fab) { await fab.click(); await page.waitForTimeout(900); }
	} catch(e){}
	const settings = await page.evaluate(() => {
		const panel = document.getElementById("fx-panel") || document.querySelector("#fx-panel");
		return { panelOpen: !!panel && panel.classList.contains("show"), panelTitle: panel?.querySelector(".fx-panel-title, h2, .panel-title")?.textContent ?? "" };
	});
	steps.push({ step: "settings-open", ...settings, ...(await barState()) });
	try { const fab = await page.$("#fx-fab"); if (fab) await fab.click(); } catch(e){}
	await page.waitForTimeout(600);
	steps.push({ step: "settings-closed", ...(await barState()) });
	const visual = await page.evaluate(() => ({
		hasVisualHost: !!document.querySelector("#visual-host, #stage, canvas"),
		canvasCount: document.querySelectorAll("canvas").length,
	}));
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	return { steps, visual, viewport };
}`;
}

function main() {
  const [target, ...rest] = process.argv.slice(2);
  if (target === "route") {
    const baseUrl = arg(rest, "--base-url");
    const outDir = path.resolve(repositoryRoot, arg(rest, "--out") ?? `.playwright-cli/wave3/current`);
    const configPath = writeConfig(outDir, { width: 1920, height: 1080 });
    const session = "wave3-route";
    if (!baseUrl) { console.error("--base-url required"); process.exit(2); }
    const program = routeProgram();
    try {
      runPlaywright(session, ["open", "about:blank", "--browser", "msedge", "--config", cliPath(configPath)], 120000);
      runPlaywright(session, ["goto", baseUrl], 120000);
      const r = runPlaywright(session, ["run-code", "--filename", writeProgram(outDir, "route", program)], 240000);
      const result = parseOutput(r.stdout, "route");
      writeFileSync(path.join(outDir, "route-full-app.json"), `${JSON.stringify(result, null, 2)}
`, "utf8");
      console.log(JSON.stringify(result, null, 2));
      runPlaywright(session, ["close"], 30000);
    } catch (error) {
      console.error("route failed:", String(error));
      try { runPlaywright(session, ["close"], 15000); } catch {}
      process.exit(2);
    }
    process.exit(0);
  }
  if (target !== "current" && target !== "upstream") {
    usage();
    process.exit(2);
  }
  const baseUrl = arg(rest, "--base-url");
  const outDir = path.resolve(repositoryRoot, arg(rest, "--out") ?? `.playwright-cli/wave3/${target}`);
  const viewportRaw = arg(rest, "--viewport", "1920x1080");
  const [vw, vh] = viewportRaw.split("x").map(Number);
  const viewport = { width: vw || 1920, height: vh || 1080 };
  const fixture = arg(rest, "--fixture", DEFAULT_FIXTURE);
  const states = (arg(rest, "--states", "default,volume,lyric-timing,quality,mini-queue,auto-hide,immersive") ?? "")
    .split(",")
    .filter((s) => s.trim() && STATE_NAMES.includes(s.trim()));

  if (!baseUrl) {
    console.error("--base-url required");
    process.exit(2);
  }
  if (target === "current" && !existsSync(fixture)) {
    console.error(`fixture mp3 missing: ${fixture}`);
    process.exit(2);
  }
  const configPath = writeConfig(outDir, viewport);
  const summary = { target, baseUrl, viewport, states: [], artifacts: [] };

  for (const state of states) {
    const session = `wave3-${target}-${state}-${process.pid}-${Date.now().toString(36)}`;
    const stateDir = path.join(outDir, state);
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const viewportForState = state === "window-920" ? { width: 920, height: 1080 }
      : state === "window-620" ? { width: 620, height: 1080 }
      : viewport;

    // Per-state context viewport (playwright-cli resize then open fresh).
    const configPathState = writeConfig(outDir, viewportForState);
    try {
      runPlaywright(session, ["open", "about:blank", "--browser", "msedge", "--config", cliPath(configPathState)], 120000);
      runPlaywright(session, ["resize", String(viewportForState.width), String(viewportForState.height)]);
      const bootProgram = target === "current"
        ? currentBootProgram(fixture)
        : upstreamBootProgram();
      runPlaywright(session, ["goto", baseUrl], 120000);
      runPlaywright(session, ["run-code", "--filename", writeProgram(outDir, `${state}-boot`, bootProgram)], 180000);

      const driver = stateDriverProgram(state, target);
      const result = runPlaywright(session, ["run-code", "--filename", writeProgram(outDir, `${state}-driver`, driver)], 180000);
      const geometry = parseOutput(result.stdout, `${state} driver`);

      const pngPath = path.join(stateDir, `${target}-${state}.png`);
      runPlaywright(session, ["screenshot", "--filename", cliPath(pngPath)], 60000);
      writeFileSync(path.join(stateDir, `${target}-${state}.geometry.json`), `${JSON.stringify(geometry, null, 2)}\n`, "utf8");

      runPlaywright(session, ["close"], 30000);
      summary.states.push(state);
      summary.artifacts.push({ state, png: pngPath, geometry: path.join(stateDir, `${target}-${state}.geometry.json`) });
    } catch (error) {
      console.error(`capture failed for ${target} ${state}: ${String(error)}`);
      try { runPlaywright(session, ["close"], 15000); } catch { /* ignore */ }
      process.exitCode = 2;
      break;
    }
  }
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`captured ${target}: ${summary.states.join(", ")} -> ${outDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}