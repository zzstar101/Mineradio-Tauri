#!/usr/bin/env node
// Wave 3 — regenerate / verify the upstream Player Shell golden fixture from the
// frozen upstream git object. Re-running this must be a no-op when the
// documented baseline still holds, and fail loudly if upstream drifts.
//
// The canonical fixture is hand-curated (docs/audit/golden/player-shell/
// upstream-player-shell.json); this script re-derives the *mechanical* parts
// (DOM child order + required id set) straight from the v2.1.0 object and
// verifies the checked-in fixture matches, so the golden never goes stale
// silently.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const UPSTREAM_COMMIT = "96091d123b36783f5604d1acd47b00b0708cabbd";
const GOLDEN_PATH = path.join(
  repositoryRoot,
  "docs/audit/golden/player-shell/upstream-player-shell.json",
);
const REGENERATED_PATH = path.join(
  repositoryRoot,
  "docs/audit/golden/player-shell/upstream-player-shell.derived.json",
);

const REQUIRED_IDS = [
  "bottom-bar",
  "mini-queue-popover",
  "mini-queue-count",
  "mini-queue-list",
  "progress-bar",
  "progress-fill",
  "progress-thumb",
  "controls",
  "control-cover",
  "control-title",
  "control-title-text",
  "control-title-badges",
  "quality-control",
  "quality-btn",
  "quality-btn-label",
  "control-artist",
  "heart-btn",
  "collect-btn",
  "play-mode-btn",
  "prev-btn",
  "play-btn",
  "next-btn",
  "mini-queue-btn",
  "lyric-timing-control",
  "lyrics-toggle-btn",
  "lyric-timing-popover",
  "lyric-timing-value",
  "lyric-timing-song",
  "volume-control",
  "volume-btn",
  "volume-slider",
  "volume-value",
  "fade-in-slider",
  "fade-in-value",
  "fade-out-slider",
  "fade-out-value",
  "controls-hide-btn",
  "immersive-btn",
  "time-display",
];

function gitShow(pathInTree) {
  const result = spawnSync(
    "git",
    ["show", `${UPSTREAM_COMMIT}:${pathInTree}`],
    { cwd: repositoryRoot, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `git show ${UPSTREAM_COMMIT}:${pathInTree} failed: ${result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout;
}

function childIdSequence(elementMarkup) {
  // Direct children of the bar: each is a <div id="..."> tag at depth 1.
  const text = elementMarkup;
  const depthStack = [];
  let depth = 0;
  const ids = [];
  const openRe = /<div\b[^>]*>/g;
  const closeRe = /<\/div>/g;
  const opens = [...text.matchAll(openRe)];
  const closes = [...text.matchAll(closeRe)];
  let i = 0;
  let j = 0;
  while (i < opens.length || j < closes.length) {
    const nextOpen = opens[i]?.index ?? Infinity;
    const nextClose = closes[j]?.index ?? Infinity;
    if (nextOpen < nextClose) {
      const tag = opens[i][0];
      depth += 1;
      if (depth === 2) {
        const idMatch = tag.match(/id="([^"]+)"/);
        ids.push(idMatch?.[1] ?? null);
      }
      void tag;
      i += 1;
    } else {
      j += 1;
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return ids;
}

function matchingClosingDivIndex(html, start) {
  // Count nested <div> / </div> (allowing void-ish self-closing input tags) from
  // the start of the #bottom-bar element to its matching </div>.
  const text = html.slice(start);
  let depth = 0;
  const openRe = /<div\b[^>]*>/g;
  const closeRe = /<\/div>/g;
  const opens = [...text.matchAll(openRe)];
  const closes = [...text.matchAll(closeRe)];
  let i = 0;
  let j = 0;
  while (i < opens.length || j < closes.length) {
    const nextOpen = opens[i]?.index ?? Infinity;
    const nextClose = closes[j]?.index ?? Infinity;
    if (nextOpen < nextClose) {
      depth += 1;
      i += 1;
    } else {
      depth -= 1;
      j += 1;
      if (depth === 0) return start + (closes[j - 1]?.index ?? 0) + "</div>".length;
    }
  }
  return -1;
}

function extractBottomBarRegion(html) {
  const start = html.indexOf('<div id="bottom-bar"');
  if (start < 0) throw new Error("bottom-bar root not found in upstream html");
  const end = matchingClosingDivIndex(html, start);
  if (end < 0) throw new Error("could not find matching #bottom-bar close");
  return html.slice(start, end);
}

function resolveCrossLinkedIds(html, region) {
  // IDs may be split across the three direct children; gather all ids in region.
  const ids = [];
  const re = /id="([^"]+)"/g;
  let match;
  while ((match = re.exec(region)) !== null) ids.push(match[1]);
  return ids;
}

function main() {
  const html = gitShow("public/index.html");
  const region = extractBottomBarRegion(html);
  const foundIds = resolveCrossLinkedIds(html, region);
  const missing = REQUIRED_IDS.filter((id) => !foundIds.includes(id));

  const derived = {
    meta: {
      baseline: "XxHuberrr/Mineradio@v2.1.0",
      peeledCommit: UPSTREAM_COMMIT,
      regeneratedAt: new Date().toISOString(),
      sourceDom: "public/index.html:1255-1409",
      generator: "scripts/player-shell/extract-upstream-golden.mjs",
    },
    requiredIdCount: REQUIRED_IDS.length,
    missingRequiredIds: missing,
    bottomBarDirectChildren: childIdSequence(region),
  };

  writeFileSync(REGENERATED_PATH, JSON.stringify(derived, null, 2));

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
  } catch (error) {
    console.error(`cannot read golden fixture: ${String(error)}`);
    process.exit(2);
  }

  const fixtureKeys = new Set(
    Object.keys(fixture.structure?.nodes ?? {}).flatMap((key) => {
      const node = fixture.structure.nodes[key];
      return node?.id ? [node.id] : [];
    }),
  );
  const fixtureMissing = REQUIRED_IDS.filter((id) => !fixtureKeys.has(id));

  const pass =
    missing.length === 0 &&
    fixtureMissing.length === 0 &&
    fixture.structure?.order?.join(",") ===
      derived.bottomBarDirectChildren.join(",");

  console.log(`derived golden -> ${REGENERATED_PATH}`);
  console.log(
    `required ids missing from upstream DOM: ${
      missing.length ? missing.join(", ") : "none"
    }`,
  );
  console.log(
    `required ids missing from fixture: ${
      fixtureMissing.length ? fixtureMissing.join(", ") : "none"
    }`,
  );
  console.log(
    `canonical bottom-bar order: ${derived.bottomBarDirectChildren.join(" -> ")}`,
  );
  if (!pass) {
    console.error("GOLDEN_DRIFT: upstream DOM no longer matches the canonical fixture");
    process.exit(1);
  }
  console.log("GOLDEN_OK: upstream player shell matches the canonical fixture");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}