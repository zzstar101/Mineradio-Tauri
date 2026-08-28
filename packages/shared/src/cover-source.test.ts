import { expect, test } from "bun:test";
import {
  CoverSourceSchema,
  inspectCoverSource,
  isKnownInvalidCoverSource,
  normalizeCoverSource,
  validateRemoteCoverSource
} from "./cover-source";

const INVALID_QQ_COVER = "https://y.gtimg.cn/music/photo_new/T002R300x300M000.jpg";

test("empty cover is a valid no-cover state", () => {
  expect(CoverSourceSchema.parse("")).toBe("");
  expect(CoverSourceSchema.parse("   ")).toBe("");
  expect(inspectCoverSource("").kind).toBe("empty");
});

test("remote cover normalization is explicit and rejects malformed sources", () => {
  expect(CoverSourceSchema.parse("//p3.music.126.net/cover.jpg"))
    .toBe("https://p3.music.126.net/cover.jpg");
  expect(validateRemoteCoverSource("http://p3.music.126.net/cover.jpg")).toBe(true);
  expect(normalizeCoverSource("https://exa mple.com/cover.jpg")).toBe(null);
  expect(CoverSourceSchema.safeParse("https://exa mple.com/cover.jpg").success).toBe(false);
  expect(CoverSourceSchema.safeParse("https://user:password@example.com/cover.jpg").success).toBe(false);
});

test("known invalid QQ empty-mid cover never enters the canonical pipeline", () => {
  expect(isKnownInvalidCoverSource(INVALID_QQ_COVER)).toBe(true);
  expect(normalizeCoverSource(INVALID_QQ_COVER)).toBe(null);
  expect(CoverSourceSchema.safeParse(INVALID_QQ_COVER).success).toBe(false);
  expect(isKnownInvalidCoverSource("https://attacker.example/music/photo_new/T002R300x300M000.jpg")).toBe(false);
});

test("inline and local cover sources remain opaque and are not remote", () => {
  const sources = [
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:http://localhost/cover-id",
    "mineradio-local://cover/session/track",
    "mineradio-tauri://localhost/image-proxy?url=x",
    "http://mineradio-local.localhost/cover/id?cap=token"
  ];
  for (const source of sources) {
    expect(CoverSourceSchema.parse(source)).toBe(source);
    expect(validateRemoteCoverSource(source)).toBe(false);
  }
  expect(CoverSourceSchema.safeParse("data:text/html,not-an-image").success).toBe(false);
  expect(CoverSourceSchema.safeParse("javascript:alert(1)").success).toBe(false);
  expect(CoverSourceSchema.safeParse("file:///tmp/cover.jpg").success).toBe(false);
});
