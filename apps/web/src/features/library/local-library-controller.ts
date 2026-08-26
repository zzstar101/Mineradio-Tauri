import type { LyricLine, LyricPayload, Track } from "@mineradio/shared";
import {
	importLocalLibraryDialog,
	importLocalLibraryPaths,
	listLocalLibrary,
	readLocalLibraryLyric,
	removeLocalLibraryTracks,
} from "../../adapters/tauri/tauri-local-library";
import type {
	LocalLibraryListResult,
	LocalLibraryTrackDto,
} from "../../adapters/tauri/tauri-local-library";

export type {
	LocalLibraryImportResult,
	LocalLibraryListResult,
	LocalLibraryLyricResult,
	LocalLibraryTrackDto,
} from "../../adapters/tauri/tauri-local-library";

export const LOCAL_LIBRARY_PROTOCOL_HOST = "http://mineradio-local.localhost";

export interface LocalLibraryEntry {
	url: string;
	localFileId: string;
	hasLyric: boolean;
	lyricSource: string | null;
}

export interface LocalLibraryImportOutcome {
	ok: boolean;
	error?: string | null;
	tracks: Track[];
	failures: Array<{ name: string; error: string }>;
	metadataWarnings: Array<{ name: string; error: string }>;
}

export function localLibraryTrackKey(dtoOrTrack: {
	provider?: string | null;
	id: string;
}): string {
	return `${dtoOrTrack.provider ?? "netease"}:${dtoOrTrack.id}`;
}

/**
 * Mirrors the established session-local mapping style of
 * createLocalAudioTrack (apps/web/src/audio/local-audio-import.ts):
 * provider stays "netease", id already carries the "local:" prefix,
 * artists fall back to "本地文件", qualityHints = ["local"].
 */
export function buildTrackFromDto(dto: LocalLibraryTrackDto): Track {
	const id = dto.id;
	// Rust 侧 name 已是 tag 标题或去扩展名的文件名干（upstream cleanText 语义），
	// 这里不再二次剥离扩展名，避免破坏含点的合法标题。
	const title = String(dto.name ?? dto.title ?? "").trim();
	return {
		provider: "netease",
		id,
		sourceId: id,
		title: title || "本地文件",
		artists: [dto.artist?.trim() ? dto.artist.trim() : "本地文件"],
		album: dto.album ?? "",
		coverUrl: dto.cover ?? "",
		durationMs:
			typeof dto.duration === "number" && Number.isFinite(dto.duration) && dto.duration > 0
				? Math.round(dto.duration * 1000)
				: undefined,
		qualityHints: ["local"],
		playableState: "playable",
	};
}

/**
 * Upstream import-dialog convergence decision:
 * - IMPORT_DIALOG_DISMISSED (user cancel) → silent
 * - NO_SUPPORTED_LOCAL_AUDIO / other ok:false without partial failures → info
 * - ok:true with partial failures → failure toast
 */
export function classifyLocalLibraryImportError(
	result: { ok: boolean; error?: string | null; failures?: Array<{ name: string; error: string }> },
): "silent" | "info" | "failure" {
	if (!result.ok) {
		const code = String(result.error ?? "");
		if (code.includes("IMPORT_DIALOG_DISMISSED")) return "silent";
		return "info";
	}
	return result.failures && result.failures.length > 0 ? "failure" : "silent";
}

/** Pure helper: which dropped OS paths are supported audio files. */
export function filterLocalLibraryAudioPaths(paths: string[]): string[] {
	return paths.filter((path) => /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i.test(path));
}

/** Pure helper: which dropped OS paths are cover images. */
export function filterLocalLibraryCoverPaths(paths: string[]): string[] {
	return paths.filter((path) => /\.(jpg|jpeg|png|webp)$/i.test(path));
}

/**
 * Pure helper for the drag-drop cover association rule: a custom cover
 * only applies when exactly one audio file and exactly one image were
 * dropped together.
 */
export function shouldAttachDroppedCover(
	audioPaths: string[],
	coverPaths: string[],
): boolean {
	return audioPaths.length === 1 && coverPaths.length === 1;
}

/** Pure helper for the busy-guard re-entry decision. */
export function localImportBusyDecision(
	busy: boolean,
): "reject" | "proceed" {
	return busy ? "reject" : "proceed";
}

export interface LocalLibraryImportToastPlanEntry {
	delayMs: number;
	text: string;
}

/**
 * Pure planner for import toasts (upstream convergence):
 * - busy phase message is emitted by the caller before starting;
 * - success mirrors the session flow ("已导入 N 首…" / single title);
 * - partial failures surface a delayed (~900ms) summary toast.
 */
export function planLocalLibraryImportToasts(
	outcome: LocalLibraryImportOutcome,
): LocalLibraryImportToastPlanEntry[] {
	if (!outcome.ok) {
		return classifyLocalLibraryImportError(outcome) === "info"
			? [{ delayMs: 0, text: "没有找到支持的本地音频文件" }]
			: [];
	}
	if (outcome.tracks.length > 0) {
		const plan: LocalLibraryImportToastPlanEntry[] = [{
			delayMs: 0,
			text: outcome.tracks.length > 1
				? `已导入 ${outcome.tracks.length} 首本地音乐`
				: outcome.tracks[0]!.title,
		}];
		if (outcome.failures.length > 0) {
			plan.push({
				delayMs: 900,
				text: `有 ${outcome.failures.length} 个文件无法读取，其余歌曲已保存`,
			});
		}
		return plan;
	}
	if (outcome.failures.length > 0) {
		return [{ delayMs: 0, text: `有 ${outcome.failures.length} 个文件无法读取` }];
	}
	return [];
}

/** Parse stored lyric text into payload lines via the shared LRC parser. */
export function parseLocalLibraryLyricLines(
	text: string,
	durationMs?: number,
): LyricLine[] {
	// Lazy import avoided deliberately: shared parser is pure & cheap.
	const lines: LyricLine[] = [];
	const raw = String(text || "").trim();
	if (!raw) return lines;
	const tagRe = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
	for (const rawLine of raw.split(/\r\n|\r|\n/)) {
		const times: number[] = [];
		tagRe.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = tagRe.exec(rawLine)) !== null) {
			const min = parseInt(match[1]!, 10) || 0;
			const sec = parseInt(match[2]!, 10) || 0;
			const frac = match[3];
			times.push(min * 60_000 + sec * 1000 + (frac ? parseInt((frac + "000").slice(0, 3), 10) : 0));
		}
		if (times.length === 0) continue;
		const lineText = rawLine.replace(tagRe, "").trim();
		if (!lineText) continue;
		for (const timeMs of times) lines.push({ timeMs, text: lineText, source: "local-library" });
	}
	return lines;
}

export function buildLocalLibraryLyricPayload(
	track: Track,
	lines: LyricLine[],
): LyricPayload {
	return {
		provider: track.provider,
		trackId: track.id,
		lines,
		hasTranslation: false,
		isWordByWord: false,
	};
}

interface LocalLibraryControllerDependencies {
	importDialog?: typeof importLocalLibraryDialog;
	importPaths?: typeof importLocalLibraryPaths;
	list?: typeof listLocalLibrary;
	readLyric?: typeof readLocalLibraryLyric;
	removeTracks?: typeof removeLocalLibraryTracks;
}

export class LocalLibraryController {
	private readonly registry = new Map<string, LocalLibraryEntry>();
	private readonly dtos = new Map<string, LocalLibraryTrackDto>();
	private readonly lyricCache = new Map<string, LyricPayload>();
	private readonly deps: Required<LocalLibraryControllerDependencies>;
	private hydrated = false;

	constructor(dependencies: LocalLibraryControllerDependencies = {}) {
		this.deps = {
			importDialog: dependencies.importDialog ?? importLocalLibraryDialog,
			importPaths: dependencies.importPaths ?? importLocalLibraryPaths,
			list: dependencies.list ?? listLocalLibrary,
			readLyric: dependencies.readLyric ?? readLocalLibraryLyric,
			removeTracks: dependencies.removeTracks ?? removeLocalLibraryTracks,
		};
	}

	registerTracks(dtos: LocalLibraryTrackDto[]): Track[] {
		const tracks: Track[] = [];
		for (const dto of dtos) {
			if (!dto?.id || !dto.localFileId) continue;
			const key = localLibraryTrackKey({ provider: "netease", id: dto.id });
			if (!this.dtos.has(key)) this.dtos.set(key, dto);
			else this.dtos.set(key, dto); // refresh metadata, keep insertion order
			this.registry.set(key, {
				url: dto.localUrl ?? `${LOCAL_LIBRARY_PROTOCOL_HOST}/audio/${dto.id}`,
				localFileId: dto.localFileId,
				hasLyric: dto.hasLyric === true,
				lyricSource: dto.lyricSource ?? null,
			});
			tracks.push(buildTrackFromDto(dto));
		}
		return tracks;
	}

	/** Ordered snapshot of the registered library in insertion order. */
	snapshotTracks(): Track[] {
		return Array.from(this.dtos.values()).map((dto) => buildTrackFromDto(dto));
	}

	getLocalAudioUrl(key: string): string | null {
		return this.registry.get(key)?.url ?? null;
	}

	getLocalMeta(key: string): LocalLibraryEntry | null {
		return this.registry.get(key) ?? null;
	}

	isLibraryTrackKey(key: string): boolean {
		return this.registry.has(key);
	}

	cachedLyric(key: string): LyricPayload | null {
		return this.lyricCache.get(key) ?? null;
	}

	storeCachedLyric(key: string, payload: LyricPayload): void {
		this.lyricCache.set(key, payload);
	}

	async loadLyric(
		key: string,
		options: {
			expectedQueueKey: string;
			currentQueueKey(): string;
			isCurrent(): boolean;
		},
	): Promise<{ payload: LyricPayload | null; rejected: false } | { payload: null; rejected: true }> {
		const cached = this.lyricCache.get(key);
		if (cached) return { payload: cached, rejected: false };
		const meta = this.registry.get(key);
		if (!meta || !meta.hasLyric) return { payload: null, rejected: false };
		const result = await this.deps.readLyric(meta.localFileId);
		// Generation + queue-identity guards: drop stale responses silently.
		if (!options.isCurrent() || options.currentQueueKey() !== options.expectedQueueKey) {
			return { payload: null, rejected: true };
		}
		if (!result.ok || !result.lyric) return { payload: null, rejected: false };
		const track = { provider: "netease", id: key.slice(key.indexOf(":") + 1) } as Track;
		const payload = buildLocalLibraryLyricPayload(
			track,
			parseLocalLibraryLyricLines(result.lyric),
		);
		this.lyricCache.set(key, payload);
		return { payload, rejected: false };
	}

	async importViaDialog(directory: boolean): Promise<LocalLibraryImportOutcome> {
		const result = await this.deps.importDialog(directory);
		return this.toOutcome(result);
	}

	async importPaths(paths: string[]): Promise<LocalLibraryImportOutcome> {
		const result = await this.deps.importPaths(paths);
		return this.toOutcome(result);
	}

	private toOutcome(result: LocalLibraryListResult): LocalLibraryImportOutcome {
		return {
			ok: result.ok,
			error: result.error ?? null,
			tracks: this.registerTracks(result.tracks),
			failures: result.failures ?? [],
			metadataWarnings: result.metadataWarnings ?? [],
		};
	}

	async hydrate(): Promise<Track[]> {
		const result = await this.deps.list();
		const tracks = this.registerTracks(result.tracks);
		this.hydrated = true;
		return tracks;
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	async remove(ids: string[]): Promise<number> {
		const result = await this.deps.removeTracks(ids);
		for (const id of ids) {
			const key = localLibraryTrackKey({ provider: "netease", id });
			this.registry.delete(key);
			this.dtos.delete(key);
			this.lyricCache.delete(key);
		}
		return result.removed;
	}
}

export const localLibraryController = new LocalLibraryController();

let hydrationPromise: Promise<void> | null = null;

/**
 * Boot sequencing seam: hydrate the persistent library once; repeated
 * callers await the same promise. Never rejects.
 */
export function ensureLocalLibraryHydrated(): Promise<void> {
	if (!hydrationPromise) {
		hydrationPromise = localLibraryController.hydrate().then(() => undefined).catch(() => undefined);
	}
	return hydrationPromise;
}
