import { invokeTauriCommand, isTauriRuntime } from "../../tauri/runtime";

/**
 * Wire types mirror the Rust local-library DTOs (camelCase) exactly.
 * `type`/`source`/`provider` are echoed as "local" by the Rust side.
 */
export type LocalLibraryTrackSourceKind = "local";

export interface LocalLibraryTrackDto {
	type?: LocalLibraryTrackSourceKind;
	source?: LocalLibraryTrackSourceKind;
	provider?: string;
	id: string;
	localFileId: string;
	localKey?: string | null;
	localUrl?: string | null;
	localPath?: string | null;
	localMissing?: boolean;
	name?: string | null;
	title?: string | null;
	artist?: string | null;
	album?: string | null;
	duration?: number | null;
	cover?: string | null;
	hasLyric?: boolean;
	lyricSource?: string | null;
}

export interface LocalLibraryImportFailureDto {
	name: string;
	error: string;
}

export interface LocalLibraryListResult {
	ok: boolean;
	version: number | null;
	count: number;
	tracks: LocalLibraryTrackDto[];
	failures?: LocalLibraryImportFailureDto[];
	metadataWarnings?: LocalLibraryImportFailureDto[];
	error?: string | null;
}

export interface LocalLibraryImportResult extends LocalLibraryListResult {}

export interface LocalLibraryLyricResult {
	ok: boolean;
	localFileId: string;
	lyric: string | null;
	lyricSource?: string | null;
	missing?: boolean;
	error?: string | null;
}

function emptyLocalLibraryListResult(): LocalLibraryListResult {
	return { ok: true, version: null, count: 0, tracks: [] };
}

function placeholderLyricResult(localFileId: string): LocalLibraryLyricResult {
	return { ok: false, localFileId, lyric: null, missing: true };
}

/** Open a native picker; `directory` picks a folder instead of files. */
export async function importLocalLibraryDialog(
	directory: boolean,
): Promise<LocalLibraryImportResult> {
	if (!isTauriRuntime()) return emptyLocalLibraryListResult();
	const result = await invokeTauriCommand<LocalLibraryImportResult>(
		"local_library_import_dialog",
		{ directory },
	);
	return result ?? emptyLocalLibraryListResult();
}

/** Import explicit absolute OS paths (Tauri drag-drop payloads). */
export async function importLocalLibraryPaths(
	paths: string[],
): Promise<LocalLibraryImportResult> {
	if (!isTauriRuntime()) return emptyLocalLibraryListResult();
	const result = await invokeTauriCommand<LocalLibraryImportResult>(
		"local_library_import_paths",
		{ paths },
	);
	return result ?? emptyLocalLibraryListResult();
}

/** List the whole persistent library snapshot. */
export async function listLocalLibrary(): Promise<LocalLibraryListResult> {
	if (!isTauriRuntime()) return emptyLocalLibraryListResult();
	const result = await invokeTauriCommand<LocalLibraryListResult>(
		"local_library_list",
	);
	return result ?? emptyLocalLibraryListResult();
}

/** Read the stored lyric text for one library file. */
export async function readLocalLibraryLyric(
	localFileId: string,
): Promise<LocalLibraryLyricResult> {
	if (!isTauriRuntime()) return placeholderLyricResult(localFileId);
	const result = await invokeTauriCommand<LocalLibraryLyricResult>(
		"local_library_lyric",
		{ localFileId },
	);
	return result ?? placeholderLyricResult(localFileId);
}

/** Remove tracks from the persistent library (no-op in browser mode). */
export async function removeLocalLibraryTracks(
	ids: string[],
): Promise<{ removed: number }> {
	if (!isTauriRuntime()) return { removed: 0 };
	const result = await invokeTauriCommand<number>("local_library_remove", { ids });
	return { removed: typeof result === "number" ? result : 0 };
}

function imageMimeFromPath(path: string): string {
	if (/\.jpe?g$/i.test(path)) return "image/jpeg";
	if (/\.png$/i.test(path)) return "image/png";
	if (/\.webp$/i.test(path)) return "image/webp";
	return "application/octet-stream";
}

/**
 * Resolve a dropped OS image path into a Blob through the Tauri asset
 * protocol. All native IO stays inside the adapter; returns null when the
 * asset scope is unavailable so callers can skip cover association silently.
 */
export async function readDroppedImageBlob(path: string): Promise<Blob | null> {
	if (!isTauriRuntime()) return null;
	try {
		const mod = (await import("@tauri-apps/api/core")) as {
			convertFileSrc?: (path: string) => string;
		};
		const convertFileSrc = mod.convertFileSrc;
		if (typeof convertFileSrc !== "function") return null;
		const response = await fetch(convertFileSrc(path));
		if (!response.ok) return null;
		return await response.blob();
	} catch {
		return null;
	}
}

export function imageFileNameFromPath(path: string): { name: string; type: string } {
	const name = path.split(/[\\/]/).pop() ?? "cover";
	return { name, type: imageMimeFromPath(name) };
}
