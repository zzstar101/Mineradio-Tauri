import type {
	PodcastProgram,
	PodcastRadio,
	ProviderId,
	Track,
} from "@mineradio/shared";
import type { SearchExperiencePort } from "../../ports/music/search-port";
import type {
	PreferenceKey,
	PreferencesRepository,
} from "../../ports/preferences-repository";
import { SEARCH_HISTORY_PREFERENCE } from "../../preferences/keys";
import type { SearchMode, SearchRecentQuery } from "../../stores/search-store";

export interface SearchSessionSnapshot {
	keyword: string;
	committedKeyword: string;
	mode: SearchMode;
	provider: ProviderId;
	results: Track[];
	podcasts: PodcastRadio[];
	programs: PodcastProgram[];
	selectedPodcast: PodcastRadio | null;
	loading: boolean;
	loadingNext: boolean;
	error: string | null;
	exhausted: boolean;
	visibleCount: number;
	detailOpen: boolean;
	recentQueries: SearchRecentQuery[];
	generation: number;
}

export interface SearchSessionState {
	getSnapshot(): SearchSessionSnapshot;
	setState(patch: Partial<SearchSessionSnapshot>): void;
}

const EMPTY_SNAPSHOT: SearchSessionSnapshot = {
	keyword: "",
	committedKeyword: "",
	mode: "song",
	provider: "netease",
	results: [],
	podcasts: [],
	programs: [],
	selectedPodcast: null,
	loading: false,
	loadingNext: false,
	error: null,
	exhausted: true,
	visibleCount: 0,
	detailOpen: false,
	recentQueries: [],
	generation: 0,
};

export function createMemorySearchSessionState(
	initial: Partial<SearchSessionSnapshot> = {},
): SearchSessionState {
	let snapshot = { ...EMPTY_SNAPSHOT, ...initial };
	return {
		getSnapshot: () => snapshot,
		setState: (patch) => {
			snapshot = { ...snapshot, ...patch };
		},
	};
}

function intentKey(keyword: string, mode: SearchMode): string {
	return `${mode}:${keyword.trim().toLocaleLowerCase()}`;
}

function modeProvider(mode: SearchMode): ProviderId | undefined {
	if (mode === "netease") return "netease";
	if (mode === "qq") return "qq";
	return undefined;
}

function displayProvider(mode: SearchMode): ProviderId {
	return mode === "qq" ? "qq" : "netease";
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export interface SearchSessionControllerOptions {
	state: SearchSessionState;
	preferences?: Pick<PreferencesRepository, "get" | "set">;
	historyPreference?: PreferenceKey<string[]>;
}

const INITIAL_VISIBLE_COUNT = 18;
const LOCAL_APPEND_COUNT = 18;
const PROVIDER_INITIAL_LIMIT = 30;
const PROVIDER_LIMIT_STEP = 30;
const PROVIDER_RESULT_LIMIT = 120;
const ALL_RESULT_LIMIT = 18;
const PODCAST_HOT_LIMIT = 18;
const PODCAST_HOT_RESULT_LIMIT = 90;
const PODCAST_PROGRAM_LIMIT = 36;
const PODCAST_PROGRAM_RESULT_LIMIT = 180;

interface ProviderPaginationState {
	kind: "provider";
	key: string;
	generation: number;
	provider: ProviderId;
	keyword: string;
	requestLimit: number;
}

interface PodcastHotPaginationState {
	kind: "podcast-hot";
	key: string;
	generation: number;
	nextOffset: number;
}

interface PodcastProgramsPaginationState {
	kind: "podcast-programs";
	key: string;
	generation: number;
	radioId: string;
	nextOffset: number;
}

type PaginationState = ProviderPaginationState | PodcastHotPaginationState | PodcastProgramsPaginationState | {
	kind: "local";
	key: string;
	generation: number;
};

function trackIdentity(track: Track): string {
	return `${track.provider}:${track.sourceId || track.id}`;
}

function mergeTracks(previous: Track[], incoming: Track[]): Track[] {
	const seen = new Set<string>();
	const merged: Track[] = [];
	for (const track of [...previous, ...incoming]) {
		const key = trackIdentity(track);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(track);
	}
	return merged;
}

function podcastIdentity(podcast: PodcastRadio): string {
	return podcast.id || podcast.rid;
}

function mergePodcasts(
	previous: PodcastRadio[],
	incoming: PodcastRadio[],
): PodcastRadio[] {
	const seen = new Set<string>();
	const merged: PodcastRadio[] = [];
	for (const podcast of [...previous, ...incoming]) {
		const key = podcastIdentity(podcast);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		merged.push(podcast);
	}
	return merged;
}

function programIdentity(program: PodcastProgram): string {
	return `${program.provider}:${program.programId || program.sourceId || program.id}`;
}

function mergePrograms(
	previous: PodcastProgram[],
	incoming: PodcastProgram[],
): PodcastProgram[] {
	const seen = new Set<string>();
	const merged: PodcastProgram[] = [];
	for (const program of [...previous, ...incoming]) {
		const key = programIdentity(program);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(program);
	}
	return merged;
}

function nextRecentQueries(
	previous: SearchRecentQuery[],
	keyword: string,
	mode: SearchMode,
): SearchRecentQuery[] {
	const query = keyword.trim();
	if (!query) return previous;
	const identity = query.toLocaleLowerCase();
	return [
		{ keyword: query, mode },
		...previous.filter(
			(item) => item.keyword.trim().toLocaleLowerCase() !== identity,
		),
	].slice(0, 10);
}

function normalizeRecentQueries(
	queries: SearchRecentQuery[],
): SearchRecentQuery[] {
	const seen = new Set<string>();
	const result: SearchRecentQuery[] = [];
	for (const item of queries) {
		const keyword = item.keyword.trim();
		if (!keyword) continue;
		const identity = keyword.toLocaleLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		result.push({ keyword, mode: item.mode });
		if (result.length >= 10) break;
	}
	return result;
}

export class SearchSessionController {
	private readonly state: SearchSessionState;
	private preferences?: Pick<PreferencesRepository, "get" | "set">;
	private readonly historyPreference: PreferenceKey<string[]>;
	private port: SearchExperiencePort | null = null;
	private inFlight: {
		key: string;
		generation: number;
		promise: Promise<void>;
	} | null = null;
	private nextFlight: { generation: number; promise: Promise<boolean> } | null = null;
	private pagination: PaginationState | null = null;
	private podcastListPagination: PaginationState | null = null;
	private podcastListExhausted = true;
	private successfulKey = "";
	private historyWrite: Promise<void> = Promise.resolve();

	constructor(options: SearchSessionControllerOptions) {
		this.state = options.state;
		this.preferences = options.preferences;
		this.historyPreference = options.historyPreference ?? SEARCH_HISTORY_PREFERENCE;
	}

	setPort(port: SearchExperiencePort | null): void {
		this.port = port;
	}

	setPreferences(
		preferences: Pick<PreferencesRepository, "get" | "set">,
	): void {
		this.preferences = preferences;
	}

	getSnapshot(): SearchSessionSnapshot {
		return this.state.getSnapshot();
	}

	async hydrateHistory(): Promise<void> {
		if (!this.preferences) return;
		try {
			const stored = await this.preferences.get(this.historyPreference);
			const merged = normalizeRecentQueries([
				...this.state.getSnapshot().recentQueries,
				...stored.map((keyword) => ({ keyword, mode: "song" as const })),
			]);
			this.state.setState({ recentQueries: merged });
		} catch {
			// 历史损坏或存储暂不可用不能阻止搜索。
		}
	}

	async removeHistory(keyword: string): Promise<void> {
		const identity = keyword.trim().toLocaleLowerCase();
		await this.commitHistoryMutation((recentQueries) =>
			recentQueries.filter(
				(item) => item.keyword.trim().toLocaleLowerCase() !== identity,
			),
		);
	}

	async clearHistory(): Promise<void> {
		await this.commitHistoryMutation(() => []);
	}

	openDetail(keyword: string, mode: SearchMode): Promise<void> {
		this.state.setState({ detailOpen: true });
		return this.search(keyword, mode);
	}

	updateDraft(keyword: string): void {
		const current = this.state.getSnapshot();
		if (keyword === current.keyword) return;
		if (!keyword.trim() && current.mode !== "podcast") {
			this.clear(false);
			return;
		}
		const invalidatesCommitted =
			keyword.trim().toLocaleLowerCase() !==
			current.committedKeyword.trim().toLocaleLowerCase();
		this.state.setState({
			keyword,
			...(invalidatesCommitted
				? {
					generation: current.generation + 1,
					loading: false,
					loadingNext: false,
				}
				: {}),
		});
	}

	closeDetail(): void {
		this.state.setState({ detailOpen: false });
	}

	clear(closeDetail = true, nextMode?: SearchMode): void {
		const current = this.state.getSnapshot();
		this.pagination = null;
		this.successfulKey = "";
		this.state.setState({
			keyword: "",
			committedKeyword: "",
			results: [],
			podcasts: [],
			programs: [],
			selectedPodcast: null,
			loading: false,
			loadingNext: false,
			error: null,
			exhausted: true,
			visibleCount: 0,
			generation: current.generation + 1,
			...(nextMode
				? { mode: nextMode, provider: displayProvider(nextMode) }
				: {}),
			...(closeDetail ? { detailOpen: false } : {}),
		});
	}

	async importSharedPlaylist(
		keyword: string,
		mode: SearchMode,
		importPlaylist: (value: string) => Promise<void> | void,
	): Promise<void> {
		const trimmed = keyword.trim();
		if (!trimmed) return;
		const current = this.state.getSnapshot();
		const generation = current.generation + 1;
		const key = intentKey(trimmed, mode);
		this.pagination = null;
		this.successfulKey = "";
		this.state.setState({
			keyword,
			committedKeyword: trimmed,
			mode,
			provider: displayProvider(mode),
			results: [],
			podcasts: [],
			programs: [],
			selectedPodcast: null,
			loading: true,
			loadingNext: false,
			error: null,
			exhausted: true,
			visibleCount: 0,
			generation,
		});
		try {
			await importPlaylist(trimmed);
			if (!this.isCurrent(key, generation)) return;
			this.state.setState({ loading: false });
		} catch (error) {
			if (!this.isCurrent(key, generation)) return;
			this.state.setState({
				loading: false,
				error: errorMessage(error, "歌单导入失败"),
			});
		}
	}

	async openPodcastPrograms(radio: PodcastRadio): Promise<void> {
		const port = this.port;
		if (!port) {
			this.state.setState({ error: "API 尚未就绪，稍后再试" });
			return;
		}
		const radioId = podcastIdentity(radio);
		if (!radioId) return;
		const current = this.state.getSnapshot();
		const generation = current.generation + 1;
		const key = `podcast-programs:${radioId}`;
		this.podcastListPagination = this.pagination;
		this.podcastListExhausted = current.exhausted;
		this.pagination = null;
		this.state.setState({
			generation,
			selectedPodcast: radio,
			programs: [],
			loading: true,
			loadingNext: false,
			error: null,
			visibleCount: 0,
			exhausted: true,
		});
		try {
			const detail = await port.podcastPrograms(
				radioId,
				PODCAST_PROGRAM_LIMIT,
				0,
			);
			if (!this.isProgramCurrent(radioId, generation)) return;
			const programs = detail.programs.slice(0, PODCAST_PROGRAM_RESULT_LIMIT);
			this.pagination = {
				kind: "podcast-programs",
				key,
				generation,
				radioId,
				nextOffset: programs.length,
			};
			this.state.setState({
				selectedPodcast: {
					...radio,
					...detail.radio,
					id: detail.radio.id || radioId,
					rid: detail.radio.rid || radio.rid || radioId,
				},
				programs,
				loading: false,
				visibleCount: Math.min(INITIAL_VISIBLE_COUNT, programs.length),
				exhausted: !detail.more || programs.length >= PODCAST_PROGRAM_RESULT_LIMIT,
			});
		} catch (error) {
			if (!this.isProgramCurrent(radioId, generation)) return;
			this.state.setState({
				loading: false,
				error: errorMessage(error, "播客节目加载失败"),
			});
		}
	}

	backToPodcastResults(): void {
		const current = this.state.getSnapshot();
		const generation = current.generation + 1;
		this.pagination = this.podcastListPagination
			? { ...this.podcastListPagination, generation }
			: null;
		this.state.setState({
			generation,
			selectedPodcast: null,
			programs: [],
			loading: false,
			loadingNext: false,
			error: null,
			visibleCount: Math.min(INITIAL_VISIBLE_COUNT, current.podcasts.length),
			exhausted: this.podcastListExhausted,
		});
	}

	loadNext(): Promise<boolean> {
		const current = this.state.getSnapshot();
		const pagination = this.pagination;
		if (!pagination || pagination.generation !== current.generation) {
			return Promise.resolve(false);
		}

		const itemCount = current.mode === "podcast"
			? current.selectedPodcast ? current.programs.length : current.podcasts.length
			: current.results.length;
		if (current.visibleCount < itemCount) {
			this.state.setState({
				visibleCount: Math.min(itemCount, current.visibleCount + LOCAL_APPEND_COUNT),
			});
			return Promise.resolve(true);
		}
		if (current.exhausted || !this.port) {
			return Promise.resolve(false);
		}
		if (this.nextFlight?.generation === current.generation) {
			return this.nextFlight.promise;
		}

		const promise = pagination.kind === "provider"
			? this.loadNextProviderPage(pagination)
			: pagination.kind === "podcast-hot"
				? this.loadNextPodcastHotPage(pagination)
				: pagination.kind === "podcast-programs"
					? this.loadNextPodcastProgramsPage(pagination)
					: Promise.resolve(false);
		this.nextFlight = { generation: current.generation, promise };
		void promise.finally(() => {
			if (this.nextFlight?.promise === promise) this.nextFlight = null;
		});
		return promise;
	}

	search(keyword: string, mode: SearchMode): Promise<void> {
		const trimmed = keyword.trim();
		const key = intentKey(trimmed, mode);
		const current = this.state.getSnapshot();
		this.state.setState({ keyword, mode, provider: displayProvider(mode) });

		if (!trimmed && mode !== "podcast") {
			this.state.setState({
				committedKeyword: "",
				results: [],
				podcasts: [],
				programs: [],
				selectedPodcast: null,
				loading: false,
				error: null,
				visibleCount: 0,
				exhausted: true,
				generation: current.generation + 1,
			});
			this.successfulKey = "";
			return Promise.resolve();
		}

		if (
			this.inFlight?.key === key &&
			this.inFlight.generation === current.generation
		) {
			return this.inFlight.promise;
		}
		if (
			this.successfulKey === key &&
			current.error === null &&
			intentKey(current.committedKeyword, current.mode) === key
		) {
			if (this.pagination?.key === key) {
				this.pagination = {
					...this.pagination,
					generation: current.generation,
				};
			}
			return Promise.resolve();
		}

		const generation = current.generation + 1;
		this.pagination = null;
		this.state.setState({
			committedKeyword: trimmed,
			mode,
			provider: displayProvider(mode),
			loading: true,
			loadingNext: false,
			error: null,
			generation,
		});

		const promise = this.runInitialSearch(trimmed, mode, key, generation);
		this.inFlight = { key, generation, promise };
		void promise.finally(() => {
			if (this.inFlight?.promise === promise) this.inFlight = null;
		});
		return promise;
	}

	private async runInitialSearch(
		keyword: string,
		mode: SearchMode,
		key: string,
		generation: number,
	): Promise<void> {
		try {
			if (!this.port) throw new Error("API 尚未就绪，稍后再试");
			if (mode === "podcast") {
				const detail = keyword
					? await this.port.podcastSearch(keyword, 30)
					: await this.port.podcastHot(PODCAST_HOT_LIMIT, 0);
				if (!this.isCurrent(key, generation)) return;
				const podcasts = detail.podcasts.slice(
					0,
					keyword ? PROVIDER_INITIAL_LIMIT : PODCAST_HOT_RESULT_LIMIT,
				);
				this.pagination = keyword
					? { kind: "local", key, generation }
					: {
						kind: "podcast-hot",
						key,
						generation,
						nextOffset: podcasts.length,
					};
				this.state.setState({
					results: [],
					podcasts,
					programs: [],
					selectedPodcast: null,
					loading: false,
					error: null,
					visibleCount: Math.min(INITIAL_VISIBLE_COUNT, podcasts.length),
					exhausted: "more" in detail ? !detail.more : true,
				});
				this.successfulKey = key;
				if (keyword && podcasts.length > 0) {
					await this.rememberSuccessfulQuery(keyword, mode);
				}
				return;
			}

			const provider = modeProvider(mode);
			const tracks = provider
				? await this.port.search(provider, keyword, PROVIDER_INITIAL_LIMIT)
				: await this.port.searchAll(keyword, PROVIDER_INITIAL_LIMIT);
			if (!this.isCurrent(key, generation)) return;
			const boundedTracks = tracks.slice(
				0,
				provider ? PROVIDER_RESULT_LIMIT : ALL_RESULT_LIMIT,
			);
			this.pagination = provider
				? {
					kind: "provider",
					key,
					generation,
					provider,
					keyword,
					requestLimit: PROVIDER_INITIAL_LIMIT,
				}
				: { kind: "local", key, generation };
			this.state.setState({
				results: boundedTracks,
				podcasts: [],
				programs: [],
				selectedPodcast: null,
				loading: false,
				error: null,
				visibleCount: Math.min(INITIAL_VISIBLE_COUNT, boundedTracks.length),
				exhausted: mode === "song" || tracks.length < PROVIDER_INITIAL_LIMIT,
			});
			this.successfulKey = key;
			if (boundedTracks.length > 0) {
				await this.rememberSuccessfulQuery(keyword, mode);
			}
		} catch (error) {
			if (!this.isCurrent(key, generation)) return;
			this.successfulKey = "";
			this.state.setState({
				loading: false,
				error: errorMessage(error, mode === "podcast" ? "播客加载失败" : "搜索失败"),
			});
		}
	}

	private async rememberSuccessfulQuery(
		keyword: string,
		mode: SearchMode,
	): Promise<void> {
		await this.commitHistoryMutation((recentQueries) =>
			nextRecentQueries(recentQueries, keyword, mode),
		);
	}

	private commitHistoryMutation(
		resolveNext: (recentQueries: SearchRecentQuery[]) => SearchRecentQuery[],
	): Promise<void> {
		const mutation = this.historyWrite
			.catch(() => undefined)
			.then(async () => {
				// 只有获得串行 ownership 后才读取 canonical snapshot，避免并发操作复活旧条目。
				const recentQueries = normalizeRecentQueries(
					resolveNext(this.state.getSnapshot().recentQueries),
				);
				const preferences = this.preferences;
				if (preferences) {
					await preferences.set(
						this.historyPreference,
						recentQueries.map((item) => item.keyword),
					);
				}
				// canonical commit 成功后再发布 UI；失败则保留最后一次已提交状态。
				this.state.setState({ recentQueries });
			})
			.catch(() => undefined);
		this.historyWrite = mutation;
		return mutation;
	}

	private async loadNextPodcastHotPage(
		pagination: PodcastHotPaginationState,
	): Promise<boolean> {
		const port = this.port;
		if (!port) return false;
		this.state.setState({ loadingNext: true });
		try {
			const detail = await port.podcastHot(
				PODCAST_HOT_LIMIT,
				pagination.nextOffset,
			);
			if (!this.isCurrent(pagination.key, pagination.generation)) return false;
			const current = this.state.getSnapshot();
			const merged = mergePodcasts(current.podcasts, detail.podcasts).slice(
				0,
				PODCAST_HOT_RESULT_LIMIT,
			);
			const novelCount = merged.length - current.podcasts.length;
			const exhausted =
				!detail.more ||
				novelCount === 0 ||
				merged.length >= PODCAST_HOT_RESULT_LIMIT;
			this.pagination = {
				...pagination,
				nextOffset: pagination.nextOffset + detail.podcasts.length,
			};
			this.state.setState({
				podcasts: merged,
				visibleCount: Math.min(
					merged.length,
					current.visibleCount + LOCAL_APPEND_COUNT,
				),
				loadingNext: false,
				exhausted,
			});
			return novelCount > 0;
		} catch (error) {
			if (!this.isCurrent(pagination.key, pagination.generation)) return false;
			this.state.setState({
				loadingNext: false,
				error: errorMessage(error, "播客加载更多失败"),
			});
			return false;
		}
	}

	private async loadNextPodcastProgramsPage(
		pagination: PodcastProgramsPaginationState,
	): Promise<boolean> {
		const port = this.port;
		if (!port) return false;
		this.state.setState({ loadingNext: true });
		try {
			const detail = await port.podcastPrograms(
				pagination.radioId,
				PODCAST_PROGRAM_LIMIT,
				pagination.nextOffset,
			);
			if (!this.isProgramCurrent(pagination.radioId, pagination.generation)) {
				return false;
			}
			const current = this.state.getSnapshot();
			const merged = mergePrograms(current.programs, detail.programs).slice(
				0,
				PODCAST_PROGRAM_RESULT_LIMIT,
			);
			const novelCount = merged.length - current.programs.length;
			const exhausted =
				!detail.more ||
				novelCount === 0 ||
				merged.length >= PODCAST_PROGRAM_RESULT_LIMIT;
			this.pagination = {
				...pagination,
				nextOffset: pagination.nextOffset + detail.programs.length,
			};
			this.state.setState({
				programs: merged,
				visibleCount: Math.min(
					merged.length,
					current.visibleCount + LOCAL_APPEND_COUNT,
				),
				loadingNext: false,
				exhausted,
			});
			return novelCount > 0;
		} catch (error) {
			if (!this.isProgramCurrent(pagination.radioId, pagination.generation)) {
				return false;
			}
			this.state.setState({
				loadingNext: false,
				error: errorMessage(error, "播客节目加载更多失败"),
			});
			return false;
		}
	}

	private async loadNextProviderPage(
		pagination: ProviderPaginationState,
	): Promise<boolean> {
		const port = this.port;
		if (!port) return false;
		const requestLimit = Math.min(
			PROVIDER_RESULT_LIMIT,
			pagination.requestLimit + PROVIDER_LIMIT_STEP,
		);
		this.state.setState({ loadingNext: true });
		try {
			const incoming = await port.search(
				pagination.provider,
				pagination.keyword,
				requestLimit,
			);
			if (!this.isCurrent(pagination.key, pagination.generation)) return false;
			const current = this.state.getSnapshot();
			const merged = mergeTracks(current.results, incoming).slice(0, PROVIDER_RESULT_LIMIT);
			const novelCount = merged.length - current.results.length;
			const exhausted =
				novelCount === 0 ||
				incoming.length < requestLimit ||
				merged.length >= PROVIDER_RESULT_LIMIT ||
				requestLimit >= PROVIDER_RESULT_LIMIT;
			this.pagination = {
				...pagination,
				requestLimit,
			};
			this.state.setState({
				results: merged,
				visibleCount: Math.min(
					merged.length,
					current.visibleCount + LOCAL_APPEND_COUNT,
				),
				loadingNext: false,
				exhausted,
			});
			return novelCount > 0;
		} catch (error) {
			if (!this.isCurrent(pagination.key, pagination.generation)) return false;
			this.state.setState({
				loadingNext: false,
				error: errorMessage(error, "加载更多失败"),
			});
			return false;
		}
	}

	private isCurrent(key: string, generation: number): boolean {
		const current = this.state.getSnapshot();
		return (
			current.generation === generation &&
			intentKey(current.committedKeyword, current.mode) === key &&
			intentKey(current.keyword, current.mode) === key
		);
	}

	private isProgramCurrent(radioId: string, generation: number): boolean {
		const current = this.state.getSnapshot();
		return (
			current.generation === generation &&
			current.mode === "podcast" &&
			current.selectedPodcast !== null &&
			podcastIdentity(current.selectedPodcast) === radioId
		);
	}
}
