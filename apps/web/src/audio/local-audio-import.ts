import type { Track } from "@mineradio/shared";

export const LOCAL_AUDIO_ACCEPT = ".mp3,.flac,.wav,.ogg,.m4a,.jpg,.jpeg,.png,.webp";
export const LOCAL_AUDIO_IMPORT_LIMIT = 5000;

type LocalFileLike = {
  name: string;
  type?: string;
  size?: number;
  lastModified?: number;
};

export function isLocalAudioFile(file: LocalFileLike): boolean {
  const type = String(file.type ?? "").toLowerCase();
  if (type.startsWith("audio/")) return true;
  return /\.(mp3|flac|wav|ogg|m4a)$/i.test(file.name);
}

export function isLocalCoverFile(file: LocalFileLike): boolean {
  const type = String(file.type ?? "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return /\.(jpg|jpeg|png|webp)$/i.test(file.name);
}

export function firstLocalAudioFile<T extends LocalFileLike>(files: Iterable<T> | ArrayLike<T>): T | null {
  const list = typeof (files as Iterable<T>)[Symbol.iterator] === "function"
    ? Array.from(files as Iterable<T>)
    : Array.from(files as ArrayLike<T>);
  return list.find(isLocalAudioFile) ?? null;
}

export function localAudioFiles<T extends LocalFileLike>(
	files: Iterable<T> | ArrayLike<T>,
): T[] {
	const list = typeof (files as Iterable<T>)[Symbol.iterator] === "function"
		? Array.from(files as Iterable<T>)
		: Array.from(files as ArrayLike<T>);
	const seen = new Set<string>();
	const result: T[] = [];
	for (const file of list) {
		if (!isLocalAudioFile(file)) continue;
		const key = `${file.name}\u0000${file.size ?? 0}\u0000${file.lastModified ?? 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(file);
		if (result.length >= LOCAL_AUDIO_IMPORT_LIMIT) break;
	}
	return result;
}

export function firstLocalCoverFile<T extends LocalFileLike>(files: Iterable<T> | ArrayLike<T>): T | null {
  const list = typeof (files as Iterable<T>)[Symbol.iterator] === "function"
    ? Array.from(files as Iterable<T>)
    : Array.from(files as ArrayLike<T>);
  return list.find(isLocalCoverFile) ?? null;
}

function imageMimeFromName(name: string | undefined): string {
  if (/\.jpe?g$/i.test(name ?? "")) return "image/jpeg";
  if (/\.png$/i.test(name ?? "")) return "image/png";
  if (/\.webp$/i.test(name ?? "")) return "image/webp";
  return "";
}

export function readLocalFileAsDataUrl(file: Blob): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const encoded = btoa(binary);
    const fileName = (file as Blob & { name?: string }).name;
    const mime = file.type || imageMimeFromName(fileName) || "application/octet-stream";
    return `data:${mime};base64,${encoded}`;
  });
}

export function createLocalAudioTrack(file: LocalFileLike): Track {
  const id = `local:${file.name}:${file.size ?? 0}:${file.lastModified ?? 0}`;
  return {
    provider: "netease",
    id,
    sourceId: id,
    title: file.name.replace(/\.[^.]+$/, ""),
    artists: ["本地文件"],
    album: "",
    coverUrl: "",
    durationMs: undefined,
    qualityHints: ["local"],
    playableState: "playable"
  };
}
