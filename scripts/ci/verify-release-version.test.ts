import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseReleaseTag,
  readRepositoryVersions,
  validateReleaseVersions,
} from "./verify-release-version.mjs";

const consistentVersions = {
  "package.json": "0.1.0",
  "apps/desktop/package.json": "0.1.0",
  "apps/desktop/src-tauri/tauri.conf.json": "0.1.0",
  "apps/desktop/src-tauri/Cargo.toml": "0.1.0",
};

describe("parseReleaseTag", () => {
  test("返回合法发布标签中的版本号", () => {
    expect(parseReleaseTag("v0.1.0")).toBe("0.1.0");
  });

  test("拒绝不符合 vX.Y.Z 的标签", () => {
    for (const tag of ["0.1.0", "v1.2", "v1.2.3-beta"]) {
      expect(() => parseReleaseTag(tag)).toThrow(
        '发布标签 "' + tag + '" 格式无效，必须匹配 vX.Y.Z',
      );
    }
  });

  test("拒绝版本段中的前导零", () => {
    for (const tag of ["v01.2.3", "v1.02.3", "v1.2.03"]) {
      expect(() => parseReleaseTag(tag)).toThrow(
        '发布标签 "' + tag + '" 格式无效，必须匹配 vX.Y.Z',
      );
    }
  });
});

describe("validateReleaseVersions", () => {
  test("接受合法且一致的 v0.1.0", () => {
    expect(validateReleaseVersions("v0.1.0", consistentVersions)).toEqual({
      tag: "v0.1.0",
      version: "0.1.0",
    });
  });

  test("拒绝不符合 vX.Y.Z 的标签", () => {
    expect(() => validateReleaseVersions("0.1.0", consistentVersions)).toThrow(
      '发布标签 "0.1.0" 格式无效，必须匹配 vX.Y.Z',
    );
  });

  test("拒绝版本段中的前导零", () => {
    for (const tag of ["v01.2.3", "v1.02.3", "v1.2.03"]) {
      expect(() => validateReleaseVersions(tag, consistentVersions)).toThrow(
        `发布标签 "${tag}" 格式无效，必须匹配 vX.Y.Z`,
      );
    }
  });

  test("拒绝与应用版本不一致的标签", () => {
    expect(() => validateReleaseVersions("v0.2.0", consistentVersions)).toThrow(
      "发布标签版本 0.2.0 与应用版本 0.1.0 不一致",
    );
  });

  test("拒绝四个版本来源互相不一致", () => {
    expect(() =>
      validateReleaseVersions("v0.1.0", {
        "package.json": "0.1.0",
        "apps/desktop/package.json": "0.1.1",
        "apps/desktop/src-tauri/tauri.conf.json": "0.1.2",
        "apps/desktop/src-tauri/Cargo.toml": "0.1.3",
      }),
    ).toThrow(
      [
        "版本来源不一致:",
        "- package.json: 0.1.0",
        "- apps/desktop/package.json: 0.1.1",
        "- apps/desktop/src-tauri/tauri.conf.json: 0.1.2",
        "- apps/desktop/src-tauri/Cargo.toml: 0.1.3",
      ].join("\n"),
    );
  });
});

test("读取仓库的四个版本来源", () => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "mineradio-release-version-"),
  );

  try {
    const desktopRoot = join(repositoryRoot, "apps/desktop");
    const tauriRoot = join(desktopRoot, "src-tauri");
    mkdirSync(tauriRoot, { recursive: true });

    writeFileSync(
      join(repositoryRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8",
    );
    writeFileSync(
      join(desktopRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8",
    );
    writeFileSync(
      join(tauriRoot, "tauri.conf.json"),
      JSON.stringify({ version: "1.2.3" }),
      "utf8",
    );
    writeFileSync(
      join(tauriRoot, "Cargo.toml"),
      [
        "[workspace]",
        "members = []",
        "",
        "[package]",
        'name = "mineradio-test"',
        'version = "1.2.3"',
        "",
        "[dependencies]",
        'example = "9.9.9"',
      ].join("\n"),
      "utf8",
    );

    expect(readRepositoryVersions(repositoryRoot)).toEqual({
      "package.json": "1.2.3",
      "apps/desktop/package.json": "1.2.3",
      "apps/desktop/src-tauri/tauri.conf.json": "1.2.3",
      "apps/desktop/src-tauri/Cargo.toml": "1.2.3",
    });
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("2.1.0 发布的四个产品版本源保持一致", () => {
  expect(validateReleaseVersions("v2.1.0", readRepositoryVersions())).toEqual({
    tag: "v2.1.0",
    version: "2.1.0",
  });
});
