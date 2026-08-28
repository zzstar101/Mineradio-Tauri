import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import React from "react";
import { settingGroupMatches } from "../features/settings/settings-catalog";
import {
  buildNativeDesktopSettingsSearchTerms,
  VisualControlPanelHost,
  VISUAL_SETTINGS_SEARCH_INDEX,
} from "./VisualControlPanelHost";
import { CUSTOM_LYRIC_FONT_STORE_KEY } from "../desktop-lyrics/custom-lyric-font";
import { DESKTOP_RUNTIME_SETTINGS_SEARCH_TERMS } from "../features/desktop/DesktopRuntimeControls";
import { FULL_DESKTOP_SETTINGS_SEARCH_TERMS } from "../features/desktop/FullDesktopControls";
import { WALLPAPER_ENGINE_SETTINGS_SEARCH_TERMS } from "../features/wallpaper-engine/WallpaperEngineControls";

test("VisualControlPanelHost server-renders the baseline fx fab and panel shell", () => {
  const html = renderToStaticMarkup(
    React.createElement(VisualControlPanelHost, {}),
  );
  expect(html).toContain('id="fx-fab"');
  expect(html).toContain('id="fx-fab-hide-btn"');
  expect(html).toContain('id="fx-panel"');
  expect(html).toContain("视觉控制台");
  expect(html).toContain("MINERADIO VISUALS");
  expect(html).toContain('id="preset-grid"');
  expect(html).toContain('class="preset-card');
  expect(html.match(/class="preset-card/g)?.length).toBe(9);
  expect(html).toContain('data-preset="7"');
  expect(html).toContain('data-preset="8"');
  expect(html).toContain("安魂");
  expect(html).toContain("YUI7W");
  expect(html).toContain("Sonic Topography");
  expect(html).toContain("音域回响 Wallpaper Engine");
  expect(html).toContain("CmzYa");
});

test("VisualControlPanelHost selects Workshop and leaves it through transactional fx patches", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const patches: Array<Record<string, unknown>> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      preset: 0,
      onSettingsTransaction: async (patch) => {
        patches.push(patch as Record<string, unknown>);
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  (container.querySelector('.preset-card[data-preset="8"]') as HTMLButtonElement).click();
  for (let tick = 0; tick < 12 && patches.length < 1; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  (container.querySelector('.preset-card[data-preset="4"]') as HTMLButtonElement).click();
  for (let tick = 0; tick < 12 && patches.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(patches).toEqual([
    { preset: 8, workshop: { active: true } },
    { preset: 4, workshop: { active: false } },
  ]);

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost server-renders its current structural control catalog", () => {
  const html = renderToStaticMarkup(
    React.createElement(VisualControlPanelHost, {}),
  );
  expect(html).toContain('id="ui-accent-picker"');
  expect(html).toContain('id="visual-tint-picker"');
  expect(html).toContain('id="home-accent-picker"');
  expect(html).toContain('id="fx-intensity"');
  expect(html).toContain('id="fx-depth"');
  expect(html).toContain('id="fx-coverres"');
  expect(html).toContain('id="fx-cineshake"');
  expect(html).toContain('id="fx-lyricglow"');
  expect(html).toContain('id="fx-lyric-fold"');
  expect(html).toContain('id="lyric-color-picker"');
  expect(html).toContain('id="lyric-highlight-picker"');
  expect(html).toContain('id="lyric-glow-picker"');
  expect(html).toContain('id="lyric-font-grid"');
  expect(html).toContain('data-font="stone-song"');
  expect(html).toContain('id="fx-overlay-fold"');
  expect(html).not.toContain('id="t-float"');
  expect(html).toContain('id="t-aidepth"');
  expect(html).toContain("AI 立体增强");
  expect(html).toContain('id="t-desktopLyrics"');
  expect(html).not.toContain('id="t-wallpaperMode"');
  expect(html).not.toContain("壁纸模式");
  expect(html).not.toContain("壁纸透明度");
  expect(html).not.toContain("Wallpaper preview");
  expect(html).not.toContain("开发中");
  expect(html).toContain('id="fx-desktoplyricssize"');
  expect(html).toContain('id="fx-desktoplyricsopacity"');
  expect(html).toContain('id="fx-desktoplyricsy"');
  expect(html).toContain('id="desktop-lyrics-fps-seg"');
  expect(html).toContain('id="fx-stage-fold"');
  expect(html).toContain('id="shelf-seg"');
  expect(html).toContain('id="t-shelfShowPodcasts"');
  expect(html).toContain('id="t-shelfMergeCollections"');
  // Camera gesture parity is intentionally not asserted here. It requires a future
  // upstream visual/product oracle rather than freezing the current absence as PASS.
  expect(html).toContain('id="fx-advanced"');
  expect(html).toContain('id="performance-background-seg"');
  expect(html).toContain('id="performance-quality-seg"');
});

test("VisualControlPanelHost opens the panel and emits baseline preset/setting callbacks", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      preset: 0,
      intensity: 0.85,
      settings: {
        cinema: true,
        wallpaperMode: false,
        shelfShowPodcasts: true,
        desktopLyricsFps: 60,
      },
      onPresetChange: (preset) => calls.push(`preset:${preset}`),
      onNumberSettingChange: (key, value) => calls.push(`${key}:${value}`),
      onBooleanSettingChange: (key, value) => calls.push(`${key}:${value}`),
      onStringSettingChange: (key, value) => calls.push(`${key}:${value}`),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(container.querySelector("#fx-panel")?.className).not.toContain("show");
  (container.querySelector("#fx-fab") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.querySelector("#fx-panel")?.className).toContain("show");
  expect(container.querySelector("#fx-fab")?.className).toContain("active");
  (
    container.querySelector(
      '.preset-card[data-preset="4"]',
    ) as HTMLButtonElement
  ).click();
  const intensity = container.querySelector(
    "#fx-intensity",
  ) as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(intensity, "1.2");
  intensity.dispatchEvent(new window.Event("input", { bubbles: true }));
  (
    container.querySelector('[data-font="stone-song"]') as HTMLButtonElement
  ).click();
  (container.querySelector("#t-cinema") as HTMLButtonElement).click();
  (container.querySelector("#t-aidepth") as HTMLButtonElement).click();
  (
    container.querySelector("#t-shelfShowPodcasts") as HTMLButtonElement
  ).click();
  const desktopOpacity = container.querySelector(
    "#fx-desktoplyricsopacity",
  ) as HTMLInputElement;
  valueSetter?.call(desktopOpacity, "0.48");
  desktopOpacity.dispatchEvent(new window.Event("input", { bubbles: true }));
  (
    container.querySelector(
      '[data-desktop-lyrics-fps="120"]',
    ) as HTMLButtonElement
  ).click();
	for (let tick = 0; tick < 24 && calls.length < 8; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

  expect(calls).toEqual([
    "preset:4",
    "intensity:1.2",
    "lyricFont:stone-song",
    "cinema:false",
    "aiDepth:true",
    "shelfShowPodcasts:false",
    "desktopLyricsOpacity:0.48",
    "desktopLyricsFps:120",
  ]);
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost mirrors baseline fx fab auto-hide preference and peek hot-zone", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  (globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
  localStorage.clear();
  document.body.className = "";
  const notices: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      onNotice: (message) => notices.push(message),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const toggle = container.querySelector("#fx-fab-hide-btn") as HTMLButtonElement;
  expect(toggle.textContent).toBe("‹");
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(localStorage.getItem("mineradio-fx-fab-auto-hide-v1")).toBe("1");
  expect(document.body.classList.contains("fx-fab-auto-hide")).toBe(true);
  expect(toggle.textContent).toBe("›");
  expect(toggle.title).toBe("取消自动隐藏视觉控制台");
  expect(notices).toEqual(["视觉控制台按钮已自动隐藏"]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const pointerMove = new window.MouseEvent("mousemove", {
    clientX: window.innerWidth - 20,
    clientY: window.innerHeight - 20,
  });
  for (let i = 0; i < 5; i += 1) {
    window.dispatchEvent(pointerMove);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(document.body.classList.contains("fx-fab-peek")).toBe(false);

  window.dispatchEvent(new window.MouseEvent("mousemove", {
    clientX: window.innerWidth - 220,
    clientY: window.innerHeight - 220,
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5 && !document.body.classList.contains("fx-fab-peek"); i += 1) {
    window.dispatchEvent(pointerMove);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(document.body.classList.contains("fx-fab-peek")).toBe(true);

  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(localStorage.getItem("mineradio-fx-fab-auto-hide-v1")).toBe("0");
  expect(document.body.classList.contains("fx-fab-auto-hide")).toBe(false);
  expect(document.body.classList.contains("fx-fab-peek")).toBe(false);
  expect(notices).toEqual(["视觉控制台按钮已自动隐藏", "视觉控制台按钮已固定显示"]);

  root.unmount();
  container.remove();
  localStorage.clear();
  document.body.className = "";
});

test("VisualControlPanelHost waits for canonical FAB preference commit before changing UI", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  (globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
  localStorage.clear();
  document.body.className = "";
  let releaseCommit: (() => void) | null = null;
  const commits: boolean[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      initialFabAutoHide: false,
      onFabAutoHideChange: async (value: boolean) => {
        commits.push(value);
        await new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  (container.querySelector("#fx-fab-hide-btn") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(commits).toEqual([true]);
  expect(document.body.classList.contains("fx-fab-auto-hide")).toBe(false);
  expect(localStorage.getItem("mineradio-fx-fab-auto-hide-v1")).toBeNull();

  (releaseCommit as (() => void) | null)?.();
  for (
    let index = 0;
    index < 8 && !document.body.classList.contains("fx-fab-auto-hide");
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(document.body.classList.contains("fx-fab-auto-hide")).toBe(true);

  root.unmount();
  container.remove();
  document.body.className = "";
});

test("VisualControlPanelHost serializes rapid setting commits through the transaction owner", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: number[] = [];
  let activeCommits = 0;
  let maxConcurrentCommits = 0;
  let releaseFirst: (() => void) | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: { depth: 1 },
      onNumberSettingChange: async (key, value) => {
        if (key !== "depth") return;
        calls.push(value);
        activeCommits += 1;
        maxConcurrentCommits = Math.max(maxConcurrentCommits, activeCommits);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        activeCommits -= 1;
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slider = container.querySelector("#fx-depth") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(slider, "1.1");
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  valueSetter?.call(slider, "1.2");
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toEqual([1.1]);
  (releaseFirst as (() => void) | null)?.();
  for (let index = 0; index < 8 && calls.length < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(calls).toEqual([1.1, 1.2]);
  expect(maxConcurrentCommits).toBe(1);

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost rebases a queued mutation after the previous commit fails", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: number[] = [];
  const notices: string[] = [];
  let rejectFirst: ((reason?: unknown) => void) | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(VisualControlPanelHost, {
    settings: { depth: 1 },
    onNumberSettingChange: (key, value) => {
      if (key !== "depth") return;
      calls.push(value);
      if (calls.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
    },
    onNotice: (message) => notices.push(message),
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const slider = container.querySelector("#fx-depth") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(slider, "1.1");
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  valueSetter?.call(slider, "1.2");
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  (rejectFirst as ((reason?: unknown) => void) | null)?.(
    new Error("first commit failed"),
  );
  for (let tick = 0; tick < 12 && calls.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(calls).toEqual([1.1, 1.2]);
  expect(notices).toEqual(["first commit failed"]);
  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("1/40");

  (container.querySelector("[data-settings-undo]") as HTMLButtonElement).click();
  for (let tick = 0; tick < 12 && calls.length < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(calls).toEqual([1.1, 1.2, 1]);

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost merges one color gesture into a single history entry", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        visualTintMode: "custom",
        visualTintColor: "#112233",
      },
      onFxPatchChange: () => undefined,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const picker = container.querySelector("#visual-tint-picker") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(picker, "#223344");
  picker.dispatchEvent(new window.Event("input", { bubbles: true }));
  valueSetter?.call(picker, "#334455");
  picker.dispatchEvent(new window.Event("input", { bubbles: true }));
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("1/40");

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost emits baseline UI accent, visual tint, and Home fill color controls", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        uiAccentColor: "#ffffff",
        visualTintMode: "custom",
        visualTintColor: "#445566",
        homeAccentColor: "#ffffff",
      },
      onStringSettingChange: (key, value) => calls.push(`${key}:${value}`),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  const uiAccent = container.querySelector(
    "#ui-accent-picker",
  ) as HTMLInputElement;
  valueSetter?.call(uiAccent, "#12abef");
  uiAccent.dispatchEvent(new window.Event("input", { bubbles: true }));
  (container.querySelector("#ui-accent-default-btn") as HTMLButtonElement).click();

  const visualTint = container.querySelector(
    "#visual-tint-picker",
  ) as HTMLInputElement;
  valueSetter?.call(visualTint, "#223344");
  visualTint.dispatchEvent(new window.Event("input", { bubbles: true }));
  (container.querySelector("#visual-tint-auto-btn") as HTMLButtonElement).click();
  (container.querySelector("#visual-tint-default-btn") as HTMLButtonElement).click();

  const homeAccent = container.querySelector(
    "#home-accent-picker",
  ) as HTMLInputElement;
  valueSetter?.call(homeAccent, "#fedcba");
  homeAccent.dispatchEvent(new window.Event("input", { bubbles: true }));
  (container.querySelector("#home-accent-default-btn") as HTMLButtonElement).click();
	for (let tick = 0; tick < 24 && calls.length < 9; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

  expect(calls).toEqual([
    "uiAccentColor:#12abef",
    "uiAccentColor:#ffffff",
    "visualTintMode:custom",
    "visualTintColor:#223344",
    "visualTintMode:auto",
    "visualTintMode:auto",
    "visualTintColor:#9db8cf",
    "homeAccentColor:#fedcba",
    "homeAccentColor:#ffffff",
  ]);
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost batches visual tint color drag into one fx patch when available", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const patches: string[] = [];
  const stringCalls: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        visualTintMode: "auto",
        visualTintColor: "#9db8cf",
      },
      onFxPatchChange: (patch) => patches.push(JSON.stringify(patch)),
      onStringSettingChange: (key, value) => stringCalls.push(`${key}:${value}`),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  const visualTint = container.querySelector(
    "#visual-tint-picker",
  ) as HTMLInputElement;
  valueSetter?.call(visualTint, "#223344");
  visualTint.dispatchEvent(new window.Event("input", { bubbles: true }));

  expect(patches).toEqual([
    JSON.stringify({ visualTintMode: "custom", visualTintColor: "#223344" }),
  ]);
  expect(stringCalls).toEqual([]);
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost emits baseline stage lyric color controls", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const calls: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        lyricColorMode: "auto",
        lyricColor: "#a9b8c8",
        lyricHighlightMode: "auto",
        lyricHighlightColor: "#fac900",
        lyricGlowLinked: true,
        lyricGlowColor: "#008aff",
      },
      onStringSettingChange: (key, value) => calls.push(`${key}:${value}`),
      onBooleanSettingChange: (key, value) => calls.push(`${key}:${value}`),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  const lyricColor = container.querySelector("#lyric-color-picker") as HTMLInputElement;
  valueSetter?.call(lyricColor, "#112233");
  lyricColor.dispatchEvent(new window.Event("input", { bubbles: true }));
  const highlightColor = container.querySelector("#lyric-highlight-picker") as HTMLInputElement;
  valueSetter?.call(highlightColor, "#445566");
  highlightColor.dispatchEvent(new window.Event("input", { bubbles: true }));
  (container.querySelector("#lyric-glow-linked") as HTMLButtonElement).click();
  const glowColor = container.querySelector("#lyric-glow-picker") as HTMLInputElement;
  valueSetter?.call(glowColor, "#778899");
  glowColor.dispatchEvent(new window.Event("input", { bubbles: true }));
  (container.querySelector("#lyric-color-auto-btn") as HTMLButtonElement).click();
	for (let tick = 0; tick < 24 && calls.length < 7; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

  expect(calls).toEqual([
    "lyricColorMode:custom",
    "lyricColor:#112233",
    "lyricHighlightMode:custom",
    "lyricHighlightColor:#445566",
    "lyricGlowLinked:false",
    "lyricGlowColor:#778899",
    "lyricColorMode:auto",
  ]);
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost delegates nested Stage and dormant Sonic settings through one fx patch", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const patches: Array<Record<string, unknown>> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        stageLyrics: { displayMode: "cinema", customLineCount: 10 },
        sonic: { terrain: { density: 46 }, trigger: { monitorEnabled: true } },
      },
      onFxPatchChange: (patch) => patches.push(patch as Record<string, unknown>),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(container.querySelector("#fx-stage-lyrics-fold")).not.toBeNull();
  expect(container.querySelector("#fx-sonic-fold")).not.toBeNull();
  (container.querySelector('[data-stage-display-mode="dual"]') as HTMLButtonElement).click();
  const density = container.querySelector("#sonic-terrain-density") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(density, "73");
  density.dispatchEvent(new window.Event("input", { bubbles: true }));
	for (let tick = 0; tick < 24 && patches.length < 2; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

  expect(patches.length).toBe(2);
  expect((patches[0]?.stageLyrics as { displayMode?: string } | undefined)?.displayMode).toBe("dual");
  expect((patches[1]?.sonic as { terrain?: { density?: number } } | undefined)?.terrain?.density).toBe(73);
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost applies low-spec settings as one transaction and can undo it", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const patches: Array<Record<string, unknown>> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        performanceQuality: "high",
        performanceBackground: "auto",
        coverResolution: 1.55,
        aiDepth: true,
        bloom: true,
        backCover: true,
        lyricGlowParticles: true,
        particleLyrics: true,
      },
      onSettingsTransaction: (patch) => {
        patches.push(patch as Record<string, unknown>);
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lowSpec = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "低配模式",
  ) as HTMLButtonElement;
  lowSpec.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(patches[0]).toEqual({
    performanceQuality: "eco",
    performanceBackground: "release",
    coverResolution: 0.9,
    aiDepth: false,
    bloom: false,
    backCover: false,
    lyricGlowParticles: false,
    particleLyrics: false,
  });

  const undo = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "撤销",
  ) as HTMLButtonElement;
  expect(undo.disabled).toBe(false);
  undo.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(patches[1]).toEqual({
    performanceQuality: "high",
    performanceBackground: "auto",
    coverResolution: 1.55,
    aiDepth: true,
    bloom: true,
    backCover: true,
    lyricGlowParticles: true,
    particleLyrics: true,
  });
  root.unmount();
  container.remove();
});

test("VisualControlPanelHost global search indexes actual advanced control labels", () => {
  for (const query of ["流速", "扭曲", "离散感", "背景压缩"]) {
    expect(
      settingGroupMatches(
        query,
        VISUAL_SETTINGS_SEARCH_INDEX.systemAdvanced,
      ),
    ).toBe(true);
  }
});

test("VisualControlPanelHost global search indexes real Stage, Sonic, and injected Native controls", () => {
  for (const query of ["上下文透明度", "翻译缩放", "纹理清晰度", "触发阈值", "超低频"]) {
    expect(
      settingGroupMatches(query, VISUAL_SETTINGS_SEARCH_INDEX.visualEngines),
    ).toBe(true);
  }

  const nativeTerms = buildNativeDesktopSettingsSearchTerms([
    ...DESKTOP_RUNTIME_SETTINGS_SEARCH_TERMS,
    ...FULL_DESKTOP_SETTINGS_SEARCH_TERMS,
    ...WALLPAPER_ENGINE_SETTINGS_SEARCH_TERMS,
  ]);
  for (const query of ["后台托盘", "整理应用工作集", "隐藏图标", "启动 Scene"]) {
    expect(settingGroupMatches(query, nativeTerms)).toBe(true);
  }
});

test("VisualControlPanelHost resets all visual preferences as one undoable transaction", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const patches: Array<Record<string, unknown>> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        speed: 2.2,
        twist: 0.4,
        performanceQuality: "eco",
      },
      onSettingsTransaction: (patch) => {
        patches.push(patch as Record<string, unknown>);
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  (container.querySelector("[data-settings-reset]") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(patches.length).toBe(1);
  expect(patches[0]?.speed).toBe(1);
  expect(patches[0]?.twist).toBe(0);
  expect(patches[0]?.performanceQuality).toBe("high");
  expect(Object.hasOwn(patches[0] ?? {}, "backgroundImage")).toBe(false);
  expect(Object.hasOwn(patches[0] ?? {}, "backgroundMedia")).toBe(false);
  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("1/40");

  (container.querySelector("[data-settings-undo]") as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(patches[1]).toEqual({
    speed: 2.2,
    twist: 0.4,
    performanceQuality: "eco",
  });

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost marks the Desktop runtime slot as non-undoable", () => {
  const html = renderToStaticMarkup(
    React.createElement(VisualControlPanelHost, {
      desktopRuntimeSlot: React.createElement("button", null, "清理缓存"),
    }),
  );

  expect(html).toContain("data-settings-native-boundary");
  expect(html).toContain('data-undoable="false"');
  expect(html).toContain("系统操作不可撤销");
  expect(html).toContain("清理缓存");
});

test("VisualControlPanelHost reports low-spec success only after canonical commit", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const notices: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: {
        performanceQuality: "high",
        performanceBackground: "auto",
        coverResolution: 1.55,
        aiDepth: true,
        bloom: true,
        backCover: true,
        lyricGlowParticles: true,
        particleLyrics: true,
      },
      onSettingsTransaction: async () => {
        throw new Error("canonical commit failed");
      },
      onNotice: (message) => notices.push(message),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lowSpec = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "低配模式",
  ) as HTMLButtonElement;
  lowSpec.click();
  for (let tick = 0; tick < 12 && notices.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(notices.includes("已启用低配模式，可从最近更改撤销")).toBe(false);
  expect(notices).toEqual(["canonical commit failed"]);
  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("0/40");

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost keeps reset out of history when canonical commit fails", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  const notices: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(VisualControlPanelHost, {
      settings: { speed: 2.2 },
      onSettingsTransaction: async () => {
        throw new Error("reset commit failed");
      },
      onNotice: (message) => notices.push(message),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  (container.querySelector("[data-settings-reset]") as HTMLButtonElement).click();
  for (let tick = 0; tick < 12 && notices.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(notices).toEqual(["reset commit failed"]);
  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("0/40");
  expect(
    (container.querySelector("[data-settings-undo]") as HTMLButtonElement).disabled,
  ).toBe(true);

  root.unmount();
  container.remove();
});

test("VisualControlPanelHost keeps an active custom font when its fallback commit fails", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  (globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
  localStorage.clear();
  localStorage.setItem(CUSTOM_LYRIC_FONT_STORE_KEY, JSON.stringify({
    version: 1,
    records: [{
      id: "font01",
      name: "测试字体",
      family: "MineRadio Custom Font 01",
      dataUrl: "data:font/woff2;base64,AA==",
      size: 2,
      savedAt: 1,
    }],
  }));
  const patches: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(VisualControlPanelHost, {
    settings: { lyricFont: "custom:font01" },
    onSettingsTransaction: async (patch) => {
      patches.push(patch as Record<string, unknown>);
      throw new Error("字体 fallback 保存失败");
    },
    onNotice: (message) => notices.push(message),
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const remove = container.querySelector(
    ".fx-custom-font-remove",
  ) as HTMLButtonElement;
  expect(remove.dataset.undoable).toBe("false");
  remove.click();
  for (let tick = 0; tick < 12 && notices.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(patches).toEqual([{ lyricFont: "sans" }]);
  expect(notices).toEqual(["字体 fallback 保存失败"]);
  expect(localStorage.getItem(CUSTOM_LYRIC_FONT_STORE_KEY)).toContain("font01");
  expect(
    container.querySelector(".settings-workbench-history-head small")?.textContent,
  ).toBe("0/40");

  root.unmount();
  container.remove();
  localStorage.clear();
});

test("VisualControlPanelHost commits a safe fallback before deleting an active custom font", async () => {
  await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
  (globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage;
  localStorage.clear();
  localStorage.setItem(CUSTOM_LYRIC_FONT_STORE_KEY, JSON.stringify({
    version: 1,
    records: [{
      id: "font02",
      name: "可删除字体",
      family: "MineRadio Custom Font 02",
      dataUrl: "data:font/woff2;base64,AA==",
      size: 2,
      savedAt: 2,
    }],
  }));
  const events: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(VisualControlPanelHost, {
    settings: { lyricFont: "custom:font02" },
    onSettingsTransaction: async (patch) => {
      events.push(`commit:${String(patch.lyricFont)}`);
    },
    onNotice: (message) => events.push(`notice:${message}`),
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  (container.querySelector(".fx-custom-font-remove") as HTMLButtonElement).click();
  for (let tick = 0; tick < 12 && events.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(events).toEqual([
    "commit:sans",
    "notice:已删除字体：可删除字体",
  ]);
  expect(localStorage.getItem(CUSTOM_LYRIC_FONT_STORE_KEY)).not.toContain("font02");

  root.unmount();
  container.remove();
  localStorage.clear();
});
