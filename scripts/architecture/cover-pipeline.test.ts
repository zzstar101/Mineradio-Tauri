import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const coverDomSurfaces = [
  "apps/web/src/components/shell/PlaylistPanelHost.tsx",
  "apps/web/src/components/shell/SearchDetailPage.tsx",
  "apps/web/src/components/shell/SearchShell.tsx",
  "apps/web/src/features/library/LibrarySurface.tsx",
  "apps/web/src/features/recommendation/RecommendationCard.tsx",
  "apps/web/src/home/EmptyHomeHost.tsx",
  "apps/web/src/visual/PlayerConsoleHost.tsx"
];

test("remote cover DOM surfaces resolve through the canonical cover policy", () => {
  for (const path of coverDomSurfaces) {
    const source = read(path);
    expect(source).toContain("useCoverSourceResolver");
    expect(source).not.toMatch(/src=\{[^}\n]*\.coverUrl\}/);
    expect(source).not.toMatch(/backgroundImage:\s*`url\([^`\n]*\.coverUrl/);
  }
});

test("cover policy keeps DOM and WebGL on MediaUrlPort without direct fallback", () => {
  const resolver = read("apps/web/src/cover/resolved-cover-source.ts");
  const adapter = read("apps/web/src/adapters/sidecar/legacy-media-url.ts");
  const visualHost = read("apps/web/src/visual/VisualEngineHost.tsx");
  const context = read("CONTEXT.md");

  expect(resolver).toContain('REMOTE_COVER_POLICY = "CANONICAL_PROXY"');
  expect(adapter).not.toContain("fallbackUri");
  expect(visualHost).toContain("resolvedCoverSource.uri");
  expect(context).toContain("Remote DOM/CSS 与 WebGL 封面统一使用 Media URL Port");
});

test("production CSP admits the canonical cover protocols", () => {
  const config = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
  const csp = String(config.app.security.csp);
  const imageDirective = csp
    .split(";")
    .map((directive: string) => directive.trim())
    .find((directive: string) => directive.startsWith("img-src ")) ?? "";

  expect(imageDirective).toContain("mineradio-tauri:");
  expect(imageDirective).toContain("http://mineradio-tauri.localhost");
  expect(imageDirective).toContain("http://mineradio-local.localhost");
});
