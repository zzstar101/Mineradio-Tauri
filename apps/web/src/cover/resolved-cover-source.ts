import { inspectCoverSource, type CoverSourceKind } from "@mineradio/shared";
import { useCallback } from "react";
import { useOptionalAppServices } from "../app/AppRuntimeProvider";
import type { MediaUrlPort } from "../ports/media-url-port";

export const REMOTE_COVER_POLICY = "CANONICAL_PROXY" as const;

export interface ResolvedCoverSource {
  readonly kind: CoverSourceKind;
  readonly logicalSource: string;
  readonly uri: string;
}

export function resolveCoverSource(
  rawSource: unknown,
  mediaUrl: Pick<MediaUrlPort, "imageSource"> | null | undefined
): ResolvedCoverSource {
  const inspected = inspectCoverSource(rawSource);
  if (inspected.kind === "empty" || inspected.kind === "invalid") {
    return { kind: inspected.kind, logicalSource: "", uri: "" };
  }
  if (inspected.kind === "remote" && !mediaUrl) {
    return { kind: "remote", logicalSource: inspected.normalized, uri: "" };
  }
  const resolved = mediaUrl?.imageSource(inspected.normalized);
  return {
    kind: inspected.kind,
    logicalSource: inspected.normalized,
    uri: resolved?.uri ?? inspected.normalized
  };
}

export function coverSourceToCssBackgroundImage(source: string): string | undefined {
  if (!source) return undefined;
  return `url("${source.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}")`;
}

export function useCoverSourceResolver(): (rawSource: unknown) => ResolvedCoverSource {
  const services = useOptionalAppServices();
  return useCallback(
    (rawSource: unknown) => resolveCoverSource(rawSource, services?.mediaUrl),
    [services?.mediaUrl]
  );
}
