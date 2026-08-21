import {
	ApiFailureSchema,
	ApiSuccessSchema,
	CapabilityMatrixSchema,
	CapabilityMatrix,
	LyricPayloadSchema,
	PlaylistDetailSchema,
	PlaylistSummary,
	PlaylistSummaryArraySchema,
	PodcastBeatmapResponse,
	PodcastBeatmapResponseSchema,
	PodcastDetailResponse,
	PodcastDetailResponseSchema,
	PodcastHotResponse,
	PodcastHotResponseSchema,
	PodcastMyItemsResponse,
	PodcastMyItemsResponseSchema,
	PodcastMyResponse,
	PodcastMyResponseSchema,
	PodcastProgramsResponse,
	PodcastProgramsResponseSchema,
	PodcastSearchResponse,
	PodcastSearchResponseSchema,
	PlaylistAddSongAck,
	PlaylistAddSongAckSchema,
	DiscoverHomeResponse,
	DiscoverHomeResponseSchema,
	ProviderId,
	QrLoginKind,
	ProviderLoginQrCheck,
	ProviderLoginQrCheckSchema,
	ProviderLoginQrImage,
	ProviderLoginQrImageSchema,
	ProviderLoginQrKey,
	ProviderLoginQrKeySchema,
	ProviderSessionCookieAck,
	ProviderSessionCookieAckSchema,
	ProviderLoginStatus,
	ProviderLoginStatusSchema,
	ProviderLogoutAck,
	ProviderLogoutAckSchema,
	SharedPlaylistImportRequest,
	SharedPlaylistImportResult,
	SharedPlaylistImportResultSchema,
	SongLikeAck,
	SongLikeAckSchema,
	SongLikeCheckAck,
	SongLikeCheckAckSchema,
	TrackQualityAvailability,
	TrackQualityAvailabilitySchema,
	SongUrlResultSchema,
	WeatherRadioResponse,
	WeatherRadioResponseSchema,
	type PlaybackQualityRequest,
	TrackArraySchema,
	Track,
	LyricPayload,
	PlaylistDetail,
	SongUrlResult,
	type ZodTypeLike,
} from "@mineradio/shared";
import { invokeTauriCommand } from "../tauri/runtime";


export interface SidecarClientErrorInit {
	code: string;
	message: string;
	provider?: string;
	retryable: boolean;
	action?: string;
	playbackKeyReady?: boolean;
	restriction?: unknown;
	reason?: string;
	qqCode?: number;
	rawMessage?: string;
	tried?: string[];
}

export class SidecarClientError extends Error {
	readonly code: string;
	readonly provider?: string;
	readonly retryable: boolean;
	readonly action?: string;
	readonly playbackKeyReady?: boolean;
	readonly restriction?: unknown;
	readonly reason?: string;
	readonly qqCode?: number;
	readonly rawMessage?: string;
	readonly tried?: string[];

	constructor(init: SidecarClientErrorInit) {
		super(init.message);
		this.name = "SidecarClientError";
		this.code = init.code;
		this.provider = init.provider;
		this.retryable = init.retryable;
		this.action = init.action;
		this.playbackKeyReady = init.playbackKeyReady;
		this.restriction = init.restriction;
		this.reason = init.reason;
		this.qqCode = init.qqCode;
		this.rawMessage = init.rawMessage;
		this.tried = init.tried;
	}
}

const CapabilitySuccessEnvelopeSchema = ApiSuccessSchema(CapabilityMatrixSchema);

function throwFailureEnvelope(json: unknown): never | void {
	const failure = ApiFailureSchema.safeParse(json);
	if (!failure.success) return;
	throw new SidecarClientError({
		code: failure.data.error.code,
		message: failure.data.error.message,
		provider: failure.data.error.provider,
		retryable: failure.data.error.retryable,
		action: failure.data.error.action,
		playbackKeyReady: failure.data.error.playbackKeyReady,
		restriction: failure.data.error.restriction,
		reason: failure.data.error.reason,
		qqCode: failure.data.error.qqCode,
		rawMessage: failure.data.error.rawMessage,
		tried: failure.data.error.tried,
	});
}

export class SidecarClient {
	private readonly mediaProxyBase: string;

	constructor(mediaProxyBase = "mineradio-tauri://localhost") {
		this.mediaProxyBase = mediaProxyBase.replace(/\/$/, "");
	}

	async capabilities(): Promise<CapabilityMatrix> {
		const json = await this.invokeApiJson("GET", "/providers/capabilities");
		throwFailureEnvelope(json);
		const envelope = CapabilitySuccessEnvelopeSchema.safeParse(json);
		if (!envelope.success) {
			throw new SidecarClientError({
				code: "SCHEMA",
				message: "capabilities response failed schema validation",
				retryable: false,
			});
		}
		return envelope.data.data;
	}

	private async invokeApiJson(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<unknown | null> {
		const tauriResult = await invokeTauriCommand("api_call", { method, path, body: body ?? null });
		if (tauriResult !== null) {
			console.log("[api]: ", path, body, tauriResult);
			return tauriResult;
		}
		return tauriResult;
	}

	private async request<T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		schema: ZodTypeLike,
		body?: unknown,
	): Promise<T> {
		const json = await this.invokeApiJson(method, path, body);
		throwFailureEnvelope(json);
		const envelope = ApiSuccessSchema(schema).safeParse(json);
		if (!envelope.success) {
			throw new SidecarClientError({
				code: "SCHEMA",
				message: `${method} ${path} response failed schema validation`,
				retryable: false,
			});
		}
		return envelope.data.data as T;
	}

	async search(provider: ProviderId, keyword: string, limit: number): Promise<Track[]> {
		const params = new URLSearchParams({ keyword, limit: String(limit) });
		return this.request(
			"GET",
			`/providers/${provider}/search?${params.toString()}`,
			TrackArraySchema,
		);
	}

	async searchAll(keyword: string, limit: number, provider?: ProviderId): Promise<Track[]> {
		const params = new URLSearchParams({ keyword, limit: String(limit) });
		if (provider) params.set("provider", provider);
		return this.request(
			"GET",
			`/search?${params.toString()}`,
			TrackArraySchema,
		);
	}

	async weatherRadio(params: {
		city?: string;
		q?: string;
		location?: string;
		lat?: number;
		lon?: number;
		timezone?: string;
	} = {}): Promise<WeatherRadioResponse> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null || value === "") continue;
			query.set(key, String(value));
		}
		const suffix = query.toString() ? `?${query.toString()}` : "";
		return this.request(
			"GET",
			`/weather/radio${suffix}`,
			WeatherRadioResponseSchema,
		);
	}

	async discoverHome(): Promise<DiscoverHomeResponse> {
		return this.request(
			"GET",
			"/discover/home",
			DiscoverHomeResponseSchema,
		);
	}

	async podcastSearch(keywords: string, limit = 18): Promise<PodcastSearchResponse> {
		const params = new URLSearchParams({ keywords, limit: String(limit) });
		return this.request(
			"GET",
			`/podcast/search?${params.toString()}`,
			PodcastSearchResponseSchema,
		);
	}

	async podcastHot(limit = 18, offset = 0): Promise<PodcastHotResponse> {
		const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
		return this.request(
			"GET",
			`/podcast/hot?${params.toString()}`,
			PodcastHotResponseSchema,
		);
	}

	async podcastDetail(id: string): Promise<PodcastDetailResponse> {
		const params = new URLSearchParams({ id });
		return this.request(
			"GET",
			`/podcast/detail?${params.toString()}`,
			PodcastDetailResponseSchema,
		);
	}

	async podcastPrograms(id: string, limit = 30, offset = 0): Promise<PodcastProgramsResponse> {
		const params = new URLSearchParams({ id, limit: String(limit), offset: String(offset) });
		return this.request(
			"GET",
			`/podcast/programs?${params.toString()}`,
			PodcastProgramsResponseSchema,
		);
	}

	async podcastMy(): Promise<PodcastMyResponse> {
		return this.request(
			"GET",
			"/podcast/my",
			PodcastMyResponseSchema,
		);
	}

	async podcastMyItems(key: string, limit = 36, offset = 0): Promise<PodcastMyItemsResponse> {
		const params = new URLSearchParams({ key, limit: String(limit), offset: String(offset) });
		return this.request(
			"GET",
			`/podcast/my/items?${params.toString()}`,
			PodcastMyItemsResponseSchema,
		);
	}

	async podcastDjBeatmap(url: string, durationSec = 0, introSec = 0): Promise<PodcastBeatmapResponse> {
		const params = new URLSearchParams({
			url,
			duration: String(durationSec),
			intro: String(introSec),
		});
		return this.request(
			"GET",
			`/podcast/dj-beatmap?${params.toString()}`,
			PodcastBeatmapResponseSchema,
		);
	}

	async songUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult> {
		return this.request(
			"POST",
			`/providers/${track.provider}/song-url`,
			SongUrlResultSchema,
			quality ? { track, quality } : track,
		);
	}

	async resolveSongUrl(track: Track, quality?: PlaybackQualityRequest): Promise<SongUrlResult> {
		return this.request(
			"POST",
			"/song-url",
			SongUrlResultSchema,
			quality ? { track, quality } : track,
		);
	}

	async trackQualities(track: Track): Promise<TrackQualityAvailability> {
		return this.request(
			"POST",
			`/providers/${track.provider}/qualities`,
			TrackQualityAvailabilitySchema,
			track,
		);
	}

	audioProxyUrl(url: string): string {
		if (/^https?:\/\//i.test(url)) return url;
		if (/^(mineradio-tauri:\/\/localhost|https?:\/\/mineradio-tauri\.localhost)(\/|$)/i.test(url)) return url;
		return `${this.mediaProxyBase}/${url.replace(/^\/+/, "")}`;
	}

	proxiedUrl(url: string): string {
		if (/^https?:\/\//i.test(url)) return url;
		if (/^(mineradio-tauri:\/\/localhost|https?:\/\/mineradio-tauri\.localhost)(\/|$)/i.test(url)) return url;
		if (url.startsWith("/")) return `${this.mediaProxyBase}${url}`;
		return `${this.mediaProxyBase}/${url.replace(/^\/+/, "")}`;
	}

	imageProxyUrl(url: string, cacheBust = false, now = Date.now()): string {
		if (!url) return "";
		if (/^data:image\//i.test(url) || /^blob:/i.test(url)) return url;
		if (/^(mineradio-tauri:\/\/localhost|https?:\/\/mineradio-tauri\.localhost)(\/|$)/i.test(url)) return url;
		if (!/^https?:\/\//i.test(url)) return "";
		const params = new URLSearchParams({ url });
		if (cacheBust) params.set("v", String(now));
		return `${this.mediaProxyBase}/image-proxy?${params.toString()}`;
	}

	async lyric(track: Track): Promise<LyricPayload> {
		return this.request(
			"POST",
			`/providers/${track.provider}/lyric`,
			LyricPayloadSchema,
			track,
		);
	}

	async playlistDetail(provider: ProviderId, id: string): Promise<PlaylistDetail> {
		return this.request(
			"GET",
			`/providers/${provider}/playlists/${encodeURIComponent(id)}`,
			PlaylistDetailSchema,
		);
	}

	async playlistList(provider: ProviderId): Promise<PlaylistSummary[]> {
		return this.request(
			"GET",
			`/providers/${provider}/playlists`,
			PlaylistSummaryArraySchema,
		);
	}

	async importSharedPlaylist(input: SharedPlaylistImportRequest): Promise<SharedPlaylistImportResult> {
		return this.request(
			"POST",
			"/shared-playlist/import",
			SharedPlaylistImportResultSchema,
			input,
		);
	}

	async likeSong(provider: ProviderId, id: string, liked: boolean): Promise<SongLikeAck> {
		return this.request(
			"POST",
			`/providers/${provider}/like`,
			SongLikeAckSchema,
			{ id, liked },
		);
	}

	async checkSongLikes(provider: ProviderId, ids: string[]): Promise<SongLikeCheckAck> {
		const params = new URLSearchParams({ ids: ids.join(",") });
		return this.request(
			"GET",
			`/providers/${provider}/like-check?${params.toString()}`,
			SongLikeCheckAckSchema,
		);
	}

	async addSongToPlaylist(provider: ProviderId, playlistId: string, trackId: string): Promise<PlaylistAddSongAck> {
		return this.request(
			"POST",
			`/providers/${provider}/playlists/add-song`,
			PlaylistAddSongAckSchema,
			{ playlistId, trackId },
		);
	}

	async setProviderSessionCookie(
		provider: ProviderId,
		cookie: string,
	): Promise<ProviderSessionCookieAck> {
		return this.request(
			"POST",
			`/providers/${provider}/session-cookie`,
			ProviderSessionCookieAckSchema,
			{ cookie },
		);
	}

	async clearProviderSessionCookie(provider: ProviderId): Promise<ProviderSessionCookieAck> {
		return this.request(
			"DELETE",
			`/providers/${provider}/session-cookie`,
			ProviderSessionCookieAckSchema,
		);
	}

	async createProviderLoginQrKey(provider: ProviderId, kind?: QrLoginKind): Promise<ProviderLoginQrKey> {
		const params = kind ? new URLSearchParams({ kind }) : new URLSearchParams();
		const suffix = params.toString() ? `?${params.toString()}` : "";
		return this.request(
			"GET",
			`/providers/${provider}/login-qr-key${suffix}`,
			ProviderLoginQrKeySchema,
		);
	}

	async createProviderLoginQrImage(provider: ProviderId, key: string, kind?: QrLoginKind): Promise<ProviderLoginQrImage> {
		const params = new URLSearchParams({ key });
		if (kind) params.set("kind", kind);
		return this.request(
			"GET",
			`/providers/${provider}/login-qr-create?${params.toString()}`,
			ProviderLoginQrImageSchema,
		);
	}

	async checkProviderLoginQr(provider: ProviderId, key: string, kind?: QrLoginKind): Promise<ProviderLoginQrCheck> {
		const params = new URLSearchParams({ key });
		if (kind) params.set("kind", kind);
		return this.request(
			"GET",
			`/providers/${provider}/login-qr-check?${params.toString()}`,
			ProviderLoginQrCheckSchema,
		);
	}

	async loginStatus(provider: ProviderId): Promise<ProviderLoginStatus> {
		return this.request(
			"GET",
			`/providers/${provider}/login-status`,
			ProviderLoginStatusSchema,
		);
	}

	async logout(provider: ProviderId): Promise<ProviderLogoutAck> {
		return this.request(
			"POST",
			`/providers/${provider}/logout`,
			ProviderLogoutAckSchema,
		);
	}
}
