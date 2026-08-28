import { expect, test } from "bun:test";
import { resolveCoverSource, REMOTE_COVER_POLICY } from "./resolved-cover-source";

const mediaUrl = {
  imageSource(source: string) {
    return {
      logicalSource: source,
      uri: `mineradio-image://cover/${encodeURIComponent(source)}`
    };
  }
};

test("remote covers use one canonical proxy policy for DOM and WebGL consumers", () => {
  const raw = "//p3.music.126.net/cover.jpg";
  const dom = resolveCoverSource(raw, mediaUrl);
  const webgl = resolveCoverSource(raw, mediaUrl);

  expect(REMOTE_COVER_POLICY).toBe("CANONICAL_PROXY");
  expect(dom).toEqual(webgl);
  expect(dom.logicalSource).toBe("https://p3.music.126.net/cover.jpg");
  expect(dom.uri.startsWith("mineradio-image://cover/")).toBe(true);
});

test("remote covers do not fall back to a direct provider URL without MediaUrlPort", () => {
  expect(resolveCoverSource("https://y.gtimg.cn/cover.jpg", null)).toEqual({
    kind: "remote",
    logicalSource: "https://y.gtimg.cn/cover.jpg",
    uri: ""
  });
});

test("invalid and empty covers resolve to deterministic no-cover state", () => {
  expect(resolveCoverSource("https://y.gtimg.cn/music/photo_new/T002R300x300M000.jpg", mediaUrl))
    .toEqual({ kind: "invalid", logicalSource: "", uri: "" });
  expect(resolveCoverSource("", mediaUrl))
    .toEqual({ kind: "empty", logicalSource: "", uri: "" });
});

test("local and inline covers remain usable without remote proxying", () => {
  const local = "http://mineradio-local.localhost/cover/id?cap=token";
  const data = "data:image/png;base64,abc";
  expect(resolveCoverSource(local, null)).toEqual({ kind: "local", logicalSource: local, uri: local });
  expect(resolveCoverSource(data, null)).toEqual({ kind: "inline", logicalSource: data, uri: data });
});
