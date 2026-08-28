import { z } from "zod";

export type CoverSourceKind = "empty" | "remote" | "inline" | "local" | "invalid";

export interface CoverSourceInspection {
  readonly kind: CoverSourceKind;
  readonly normalized: string;
  readonly reason?: string;
}

const REMOTE_PROTOCOLS = new Set(["http:", "https:"]);
const LOCAL_WEBVIEW_HOSTS = new Set([
  "mineradio-local.localhost",
  "mineradio-tauri.localhost",
  "mineradio-wallpaper.localhost"
]);
const LOCAL_CUSTOM_SOURCE_RE = /^mineradio-(?:tauri|local|wallpaper|image):\/\/[^\s]+$/i;
const INLINE_IMAGE_SOURCE_RE = /^data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s]*$/i;
const KNOWN_INVALID_QQ_PATH_RE = /\/music\/photo_new\/T002R\d+x\d+M000\.jpg$/i;

function parseRemoteSource(source: string): URL | null {
  try {
    const parsed = new URL(source);
    if (!REMOTE_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isKnownInvalidCoverSource(source: string): boolean {
  const normalized = String(source ?? "").trim().replace(/^\/\//, "https://");
  const parsed = parseRemoteSource(normalized);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return (
    (hostMatches(host, "gtimg.cn") || hostMatches(host, "y.qq.com")) &&
    KNOWN_INVALID_QQ_PATH_RE.test(parsed.pathname)
  );
}

export function inspectCoverSource(value: unknown): CoverSourceInspection {
  if (typeof value !== "string") {
    return { kind: "invalid", normalized: "", reason: "cover source must be a string" };
  }
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty", normalized: "" };

  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (INLINE_IMAGE_SOURCE_RE.test(normalized)) {
    return { kind: "inline", normalized };
  }
  if (/^data:/i.test(normalized)) {
    return { kind: "invalid", normalized: "", reason: "cover data URI must contain image media" };
  }
  if (/^blob:/i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      return parsed.protocol === "blob:"
        ? { kind: "inline", normalized: parsed.href }
        : { kind: "invalid", normalized: "", reason: "invalid cover blob URI" };
    } catch {
      return { kind: "invalid", normalized: "", reason: "invalid cover blob URI" };
    }
  }
  if (LOCAL_CUSTOM_SOURCE_RE.test(normalized)) {
    return { kind: "local", normalized };
  }

  const remote = parseRemoteSource(normalized);
  if (remote) {
    if (isKnownInvalidCoverSource(remote.href)) {
      return { kind: "invalid", normalized: "", reason: "known invalid QQ cover source" };
    }
    return {
      kind: LOCAL_WEBVIEW_HOSTS.has(remote.hostname.toLowerCase()) ? "local" : "remote",
      normalized: remote.href
    };
  }

  return { kind: "invalid", normalized: "", reason: "unsupported or malformed cover source" };
}

export function normalizeCoverSource(value: unknown): string | null {
  const inspected = inspectCoverSource(value);
  return inspected.kind === "invalid" ? null : inspected.normalized;
}

export function validateRemoteCoverSource(value: unknown): boolean {
  return inspectCoverSource(value).kind === "remote";
}

export const CoverSourceSchema = z.string().transform((value, context) => {
  const inspected = inspectCoverSource(value);
  if (inspected.kind === "invalid") {
    context.addIssue({
      code: "custom",
      message: inspected.reason ?? "invalid cover source"
    });
    return z.NEVER;
  }
  return inspected.normalized;
});
