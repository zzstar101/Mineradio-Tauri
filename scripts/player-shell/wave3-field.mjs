#!/usr/bin/env node
// Wave 3B — Layer 5 Windows/WebView2 field driver for the EXACT packaged
// candidate. Launches/mineradio-tauri.exe with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
// pointing at a CDP port, connects over CDP, drives the REAL WebView2 surface:
// local import -> playback -> lyric offset -> volume -> mini queue -> auto-hide
// -> immersive -> fullscreen, capturing WebView2 screenshots + state JSON.
//
// Usage:
//   node scripts/player-shell/wave3-field.mjs --exe <path> --port <cdp> --fixture <mp3> --out <dir>

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");

function arg(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function resolvePlaywrightCore() {
  const candidates = [
    "C:/Users/zhanw/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/index.mjs",
    "C:/Users/zhanw/AppData/Local/npm-cache/_npx/420ff84f11983ee5/node_modules/playwright-core/index.mjs",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("playwright-core not found in npx cache");
}

async function main() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rest = process.argv.slice(2);
  const exe = path.resolve(repositoryRoot, arg(rest, "--exe") ?? "");
  const port = Number(arg(rest, "--port", "9333"));
  const fixture = arg(rest, "--fixture", path.join(repositoryRoot, ".playwright-cli/fixtures/wave3-fixture.mp3"));
  const outDir = path.resolve(repositoryRoot, arg(rest, "--out", ".playwright-cli/wave3/field"));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (!exe || !existsSync(exe)) { console.error("--exe required"); process.exit(2); }

  // The app must be launched by the caller with the CDP arg already set. We
  // spawn it here with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS so the exact
  // packaged candidate is the one under test.
  const { spawn, spawnSync } = await import("node:child_process");
  const exeBase = path.basename(exe);
  // Clear stale instances (single-instance plugin refuses a second launch).
  // The candidate process name is the exe base name (not "mineradio-tauri").
  spawnSync("taskkill", ["/F", "/IM", exeBase], { stdio: "ignore", windowsHide: true });
  spawnSync("taskkill", ["/F", "/IM", "msedgewebview2.exe"], { stdio: "ignore", windowsHide: true });
  await sleep(2500);
  // Launch via PowerShell so WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS reliably reaches
  // the WebView2 runtime (node child_process env propagation was flaky on this setup).
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${port} --remote-allow-origins=*'; Start-Process -FilePath '${exe}'`],
    { stdio: "ignore", windowsHide: true },
  );
  const appChild = { pid: 0 };
  await sleep(12000);

  let attempts = 0;
  let browser;
  const { chromium } = await import(pathToFileURL(resolvePlaywrightCore()).href);
  while (attempts < 40) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      attempts += 1;
      await sleep(1000);
    }
  }
  if (!browser) { console.error("CDP connect failed"); process.exit(2); }

  // Wait for the real app page (not the initial about:blank target).
  let page = null;
  for (let i = 0; i < 30 && !page; i += 1) {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    const candidate = pages.find((p) => {
      const u = typeof p.url === "function" ? p.url() : p.url;
      return u && !String(u).startsWith("about:");
    });
    if (candidate) page = candidate;
    else await sleep(1000);
  }
  if (!page) {
    const contexts = browser.contexts();
    page = contexts[0]?.pages()[0];
  }
  if (!page) { console.error("no page"); process.exit(2); }

  const results = { candidateExe: exe, output: outDir, scenarios: {} };
  const shot = async (name) => {
    const png = path.join(outDir, `${name}.png`);
    const buf = await page.screenshot({ path: png });
    return { file: png, bytes: buf.length };
  };
  const read = (fn) => page.evaluate(fn);

  // Boot + local import (real packaged WebView2 path).
  await page.waitForSelector("#file-input", { state: "attached", timeout: 30000 });
  try { const enter = await page.$("[aria-label*=进入], #splash button, .splash button"); if (enter) await enter.click(); } catch (e) {}
  await page.setInputFiles("#file-input", fixture);
  await page.waitForFunction(() => !!document.getElementById("control-cover"), null, { timeout: 40000 });
  await page.waitForTimeout(1200);
  results.scenarios.boot = {
    pass: true,
    title: await page.title().catch(() => ""),
    cover: await read(() => !!document.getElementById("control-cover")),
    barVisible: await read(() => document.getElementById("bottom-bar")?.classList.contains("visible") ?? false),
    trackTitle: await read(() => document.getElementById("control-title-text")?.textContent ?? ""),
  };
  results.artifacts = [];
  results.artifacts.push(await shot("field-boot"));

  // Lyric offset: open +0.1, verify label + toast semantics.
  try {
    await page.hover("#lyric-timing-control", { timeout: 8000 }).catch(() => {});
    await page.click("#lyrics-toggle-btn", { timeout: 8000 });
    await page.waitForTimeout(300);
    const before = await read(() => document.getElementById("lyric-timing-value")?.textContent);
    const popoverShown = await read(() => getComputedStyle(document.getElementById("lyric-timing-popover")).opacity);
    await page.click('[data-lyric-offset-step="0.1"]', { timeout: 8000 });
    await page.waitForTimeout(250);
    const after = await read(() => document.getElementById("lyric-timing-value")?.textContent);
    await page.click('[data-lyric-offset-reset]', { timeout: 8000 });
    await page.waitForTimeout(250);
    const reset = await read(() => document.getElementById("lyric-timing-value")?.textContent);
    results.scenarios.lyricOffset = { pass: before === "0.0s" && after === "+0.1s" && reset === "0.0s", before, after, reset, popoverShown: Number(popoverShown) > 0 };
    results.artifacts.push(await shot("field-lyric-offset"));
    await page.keyboard.press("Escape").catch(() => {});
  } catch (error) {
    results.scenarios.lyricOffset = { pass: false, error: String(error) };
  }

  // Volume popover.
  try {
    await page.click("#volume-btn", { timeout: 8000 });
    await page.waitForTimeout(300);
    const shown = await read(() => getComputedStyle(document.querySelector("#volume-control .volume-popover")).opacity);
    const slider = await read(() => !!document.getElementById("volume-slider"));
    const fadeIn = await read(() => !!document.getElementById("fade-in-slider"));
    results.scenarios.volume = { pass: Number(shown) > 0 && slider && fadeIn, shown: Number(shown), slider, fadeIn };
    results.artifacts.push(await shot("field-volume"));
    await page.keyboard.press("Escape").catch(() => {});
    await page.click("#volume-btn", { timeout: 8000 }).catch(() => {});
  } catch (error) {
    results.scenarios.volume = { pass: false, error: String(error) };
  }

  // Mini queue open + explicit close.
  try {
    await page.click("#mini-queue-btn", { timeout: 8000 });
    await page.waitForTimeout(400);
    const open = await read(() => document.getElementById("mini-queue-popover")?.classList.contains("show") ?? false);
    const count = await read(() => document.getElementById("mini-queue-count")?.textContent ?? "");
    const closeBtn = await read(() => !!document.querySelector(".mini-queue-head .fx-mini-btn"));
    await page.click(".mini-queue-head .fx-mini-btn", { timeout: 8000 });
    await page.waitForTimeout(250);
    const closed = await read(() => !(document.getElementById("mini-queue-popover")?.classList.contains("show") ?? true));
    results.scenarios.miniQueue = { pass: open && closeBtn && closed, open, count, closeBtn, closed };
    results.artifacts.push(await shot("field-mini-queue"));
  } catch (error) {
    results.scenarios.miniQueue = { pass: false, error: String(error) };
  }

  // Auto-hide: move pointer away -> handle appears.
  try {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    // Hover bar to keep visible first, then leave for hide.
    await page.mouse.move(960, 1000);
    await page.waitForTimeout(300);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1100);
    const barHidden = await read(() => document.getElementById("bottom-bar")?.classList.contains("soft-hidden") ?? false);
    const handle = await read(() => !!document.getElementById("bottom-handle"));
    results.scenarios.autoHide = { pass: handle, barSoftHidden: barHidden, handle };
    results.artifacts.push(await shot("field-auto-hide"));
  } catch (error) {
    results.scenarios.autoHide = { pass: false, error: String(error) };
  }

  // Immersive enter/exit.
  try {
    await page.hover("#bottom-bar", { timeout: 8000 }).catch(() => {});
    await page.click("#immersive-btn", { timeout: 8000 });
    await page.waitForTimeout(500);
    const on = await read(() => document.body.classList.contains("immersive-mode"));
    const playSize = await read(() => getComputedStyle(document.getElementById("play-btn")).width);
    const actionsGone = await read(() => getComputedStyle(document.querySelector(".control-cluster.actions")).display === "none");
    results.scenarios.immersiveEnter = { pass: on && playSize === "64px" && actionsGone, on, playSize, actionsGone };
    results.artifacts.push(await shot("field-immersive"));
    await page.click("#immersive-btn", { timeout: 8000 });
    await page.waitForTimeout(400);
    const off = await read(() => !document.body.classList.contains("immersive-mode"));
    const playBack = await read(() => getComputedStyle(document.getElementById("play-btn")).width);
    results.scenarios.immersiveExit = { pass: off && playBack === "58px", off, playBack };
  } catch (error) {
    results.scenarios.immersiveEnter = { pass: false, error: String(error) };
  }

  // Progress/seek: pointer drag on #progress-bar.
  try {
    const box = await page.locator("#progress-bar").boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
      await page.waitForTimeout(300);
      const progressPct = await read(() => parseFloat((document.getElementById("progress-fill")?.style.width ?? "0").replace("%", "")) || 0);
      results.scenarios.progressSeek = { pass: progressPct > 5 && progressPct < 95, progressPct };
    } else {
      results.scenarios.progressSeek = { pass: false, error: "no progress bar box" };
    }
  } catch (error) {
    results.scenarios.progressSeek = { pass: false, error: String(error) };
  }

  // Fullscreen toggle (native Tauri window action).
  try {
    const beforeFs = await read(() => ({ de: !!document.fullscreenElement, w: innerWidth, h: innerHeight }));
    await page.click(".fullscreen-toggle-btn", { timeout: 8000 });
    await page.waitForTimeout(1200);
    const afterFs = await read(() => ({ de: !!document.fullscreenElement, w: innerWidth, h: innerHeight }));
    results.scenarios.fullscreen = { pass: beforeFs.w === 1440 && (afterFs.w !== 1440 || afterFs.de), beforeFs, afterFs };
    results.artifacts.push(await shot("field-fullscreen"));
    await page.click(".fullscreen-toggle-btn", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
  } catch (error) {
    results.scenarios.fullscreen = { pass: false, error: String(error) };
  }

  writeFileSync(path.join(outDir, "field-summary.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));

  const passCount = Object.values(results.scenarios).filter((s) => s.pass === true).length;
  const total = Object.keys(results.scenarios).length;
  console.log(`\nFIELD: ${passCount}/${total} scenarios passed`);
  await browser.close().catch(() => {});
  try { spawnSync("taskkill", ["/F", "/IM", exeBase], { stdio: "ignore", windowsHide: true }); } catch {}
  process.exit(passCount === total ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}