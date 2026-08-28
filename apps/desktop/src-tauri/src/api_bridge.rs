//! Frontend-facing API bridge.
//!
//! `api.ts` on the web side calls Tauri's `api_call` invoke command; this module
//! maps the frontend contract (`{ ok, data }` / `{ ok, error }`) onto the
//! in-process `mineradio_api` crate.

use std::{collections::HashMap, sync::OnceLock, time::Duration};

use mineradio_api::{
    analyze_podcast_dj_beatmap, Api, ApiError, ApiErrorCode, PodcastAudioFormat,
    PodcastDjAnalyzerParams, ProviderApi, ProviderId, QrLoginKind, SongUrlOptions, Track,
    WeatherRadioParams,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongUrlRequestBody {
    track: Track,
    #[serde(default)]
    quality: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LikeBody {
    id: String,
    liked: bool,
}

/// 流式电台续拉请求体：推荐 Stream 卡片的句柄 id（不解析内部结构）
#[derive(Deserialize)]
struct StreamNextBody {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistAddSongBody {
    playlist_id: String,
    track_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCookieBody {
    cookie: String,
}

enum Success {
    Data(serde_json::Value),
    Raw(serde_json::Value),
}

#[tauri::command]
pub async fn api_call(
    state: tauri::State<'_, crate::AppState>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let api = state
        .api
        .clone()
        .ok_or_else(|| "api not initialized".to_string())?;
    let app_version = state.config.app_version.clone();
    let schema_version = state.config.schema_version.clone();
    Ok(dispatch(
        &api,
        &app_version,
        &schema_version,
        method.as_str(),
        &path,
        body,
    )
    .await)
}

async fn dispatch(
    api: &Api,
    app_version: &str,
    schema_version: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> serde_json::Value {
    let (route, query) = split_path(path);
    let params = parse_query(query);

    match handle_route(
        api,
        app_version,
        schema_version,
        method,
        route,
        &params,
        body,
    )
    .await
    {
        Ok(Success::Data(data)) => ok_envelope(data),
        Ok(Success::Raw(raw)) => raw,
        Err(err) => error_envelope(&err),
    }
}

async fn handle_route(
    api: &Api,
    app_version: &str,
    schema_version: &str,
    method: &str,
    route: &str,
    params: &HashMap<String, String>,
    body: Option<serde_json::Value>,
) -> Result<Success, ApiCallError> {
    match (method, route) {
        ("GET", "/health") => Ok(Success::Raw(health_body(app_version, schema_version))),
        ("GET", "/providers/capabilities") => Ok(Success::Data(capabilities_matrix())),
        ("GET", "/weather/radio") => {
            let value = api
                .weather_radio(WeatherRadioParams {
                    city: params.get("city").cloned(),
                    q: params.get("q").cloned(),
                    location: params.get("location").cloned(),
                    lat: query_f64_value(params, "lat"),
                    lon: query_f64_value(params, "lon"),
                    timezone: params.get("timezone").cloned(),
                })
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/discover/home") => Err(ApiCallError::unavailable(
            "discover home is not available in the current MineRadio-api",
        )),
        ("GET", "/podcast/search") => {
            let keywords = params
                .get("keywords")
                .or_else(|| params.get("keyword"))
                .cloned()
                .unwrap_or_default();
            let value = api
                .podcast_search(keywords, query_u32(params, "limit", 18))
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/hot") => {
            let value = api
                .podcast_hot(
                    query_u32(params, "limit", 18),
                    query_u32_allow_zero(params, "offset", 0),
                )
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/detail") => {
            let rid = params
                .get("id")
                .or_else(|| params.get("rid"))
                .cloned()
                .unwrap_or_default();
            let value = api
                .podcast_detail(rid)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/programs") => {
            let rid = params
                .get("id")
                .or_else(|| params.get("rid"))
                .cloned()
                .unwrap_or_default();
            let value = api
                .podcast_programs(
                    rid,
                    query_u32(params, "limit", 30),
                    query_u32_allow_zero(params, "offset", 0),
                )
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/my") => {
            let value = api
                .podcast_my()
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/my/items") => {
            let value = api
                .podcast_my_items(
                    params
                        .get("key")
                        .cloned()
                        .unwrap_or_else(|| "collect".to_owned()),
                    query_u32(params, "limit", 36),
                    query_u32_allow_zero(params, "offset", 0),
                )
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(value))
        }
        ("GET", "/podcast/dj-beatmap") => {
            let url = params
                .get("url")
                .map(|value| value.as_str())
                .unwrap_or_default();
            if url.trim().is_empty() {
                return Err(ApiCallError::bad_request("url required"));
            }
            let intro_sec = params.get("intro").and_then(|raw| raw.parse::<u32>().ok());
            let audio = download_podcast_audio(url).await.map_err(|err| {
                ApiCallError::internal(&format!("podcast audio download failed: {err}"))
            })?;
            let analyzer_params = PodcastDjAnalyzerParams {
                format: guess_podcast_audio_format(url),
                intro_sec,
            };
            // 音频解码+节拍分析是重 CPU 同步任务，丢到阻塞线程池避免卡住异步运行时
            let map = tauri::async_runtime::spawn_blocking(move || {
                analyze_podcast_dj_beatmap(&audio, &analyzer_params)
            })
            .await
            .map_err(|err| ApiCallError::internal(&format!("podcast analyze join failed: {err}")))?
            .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::json!({ "ok": true, "map": map })))
        }
        ("GET", "/recommendations/pages") => {
            let refresh = params
                .get("refresh")
                .map(|value| value == "true" || value == "1")
                .unwrap_or(false);
            let pages = api
                .recommendation_pages(refresh)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(pages).unwrap()))
        }
        ("GET", "/search") => {
            let keyword = params
                .get("keyword")
                .map(|v| v.as_str())
                .unwrap_or_default();
            if keyword.trim().is_empty() {
                return Err(ApiCallError::bad_request("keyword required"));
            }
            let provider = params.get("provider").and_then(|raw| parse_provider(raw));
            let limit = query_u32(params, "limit", 20);
            let tracks = api
                .search_tracks(keyword, provider, limit)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(tracks).unwrap()))
        }
        ("POST", "/song-url") => {
            let (track, options) = parse_song_url_body(body)?;
            let result = api
                .song_url(track, options)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(media_song_url_value(result)))
        }
        ("POST", "/shared-playlist/import") => Err(ApiCallError::unavailable(
            "shared playlist import is not available in the current MineRadio-api",
        )),
        _ => handle_provider_route(api, method, route, params, body).await,
    }
}

async fn handle_provider_route(
    api: &Api,
    method: &str,
    route: &str,
    params: &HashMap<String, String>,
    body: Option<serde_json::Value>,
) -> Result<Success, ApiCallError> {
    let segments: Vec<&str> = route
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() < 3 || segments[0] != "providers" {
        return Err(ApiCallError::not_found(&format!(
            "unknown route: {method} {route}"
        )));
    }
    let provider = parse_provider(segments[1])
        .ok_or_else(|| ApiCallError::not_found(&format!("unknown provider: {}", segments[1])))?;
    let sub: Vec<&str> = segments[2..].to_vec();
    let provider_api = provider_api(api, provider);

    match (method, sub.as_slice()) {
        ("GET", ["search"]) => {
            let keyword = params
                .get("keyword")
                .map(|v| v.as_str())
                .unwrap_or_default();
            if keyword.trim().is_empty() {
                return Err(ApiCallError::bad_request("keyword required"));
            }
            let limit = query_u32(params, "limit", 20);
            let tracks = provider_api
                .search_track(keyword, 0, limit)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(tracks).unwrap()))
        }
        ("POST", ["song-url"]) => {
            let (track, options) = parse_song_url_body(body)?;
            let result = provider_api
                .song_url(&track, options)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(media_song_url_value(result)))
        }
        ("POST", ["qualities"]) => {
            let track = parse_body::<Track>(&body)?;
            let result = provider_api
                .track_qualities(&track)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("POST", ["lyric"]) => {
            let track = parse_body::<Track>(&body)?;
            let result = provider_api
                .lyric(&track)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["playlists"]) => {
            let result = provider_api
                .playlist_list()
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["playlists", id]) => {
            let id = decode_path_segment(id);
            let offset = query_u32(params, "offset", 0);
            // 缺省 500：QQ 侧 song_num 上限即 500，网易 n 按需返回。
            // 旧实现硬编码 (0, 0)：QQ clamp 后只回 1 首，网易直接回空，
            // 歌单详情页因此显示“没有内容”。
            let limit = query_u32(params, "limit", 500);
            let result = provider_api
                .playlist_detail(&id, offset, limit)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("POST", ["playlists", "add-song"]) => {
            let parsed = parse_body::<PlaylistAddSongBody>(&body)?;
            let result = provider_api
                .update_song_in_playlist(&parsed.playlist_id, &parsed.track_id, true)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("POST", ["like"]) => {
            let parsed = parse_body::<LikeBody>(&body)?;
            let result = provider_api
                .like_song(&parsed.id, parsed.liked)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("POST", ["stream-next"]) => {
            let parsed = parse_body::<StreamNextBody>(&body)?;
            let result = provider_api
                .stream_next(&parsed.id)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["like-check"]) => {
            let ids = params
                .get("ids")
                .map(|raw| {
                    raw.split(',')
                        .map(|id| id.trim().to_string())
                        .filter(|id| !id.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                return Err(ApiCallError::bad_request("ids required"));
            }
            let result = provider_api
                .check_song_likes(&ids)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["login-status"]) => {
            let result = provider_api
                .login_status()
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("POST", ["logout"]) => {
            provider_api
                .logout()
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::json!({
                "provider": provider.as_str(),
                "loggedOut": true
            })))
        }
        ("POST", ["session-cookie"]) => {
            let parsed = parse_body::<SessionCookieBody>(&body)?;
            if parsed.cookie.trim().is_empty() {
                return Err(ApiCallError::bad_request("cookie required"));
            }
            mineradio_api::set_runtime_provider_cookie(provider, parsed.cookie)
                .await
                .map_err(|err| ApiCallError::internal(&err))?;
            Ok(Success::Data(serde_json::json!({
                "provider": provider.as_str(),
                "stored": true
            })))
        }
        ("DELETE", ["session-cookie"]) => {
            mineradio_api::clear_runtime_provider_cookie(&provider).await;
            Ok(Success::Data(serde_json::json!({
                "provider": provider.as_str(),
                "stored": false
            })))
        }
        ("GET", ["login-qr-key"]) => {
            let qr = qr_login(api, provider, params.get("kind").map(String::as_str))?;
            let result = qr
                .create_key()
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["login-qr-create"]) => {
            let key = params.get("key").map(|v| v.as_str()).unwrap_or_default();
            if key.trim().is_empty() {
                return Err(ApiCallError::bad_request("QR key required"));
            }
            let qr = qr_login(api, provider, params.get("kind").map(String::as_str))?;
            let result = qr
                .create_image(key)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        ("GET", ["login-qr-check"]) => {
            let key = params.get("key").map(|v| v.as_str()).unwrap_or_default();
            if key.trim().is_empty() {
                return Err(ApiCallError::bad_request("QR key required"));
            }
            let qr = qr_login(api, provider, params.get("kind").map(String::as_str))?;
            let result = qr
                .check(key)
                .await
                .map_err(|err| ApiCallError::from_api_error(&err))?;
            Ok(Success::Data(serde_json::to_value(result).unwrap()))
        }
        _ => Err(ApiCallError::not_found(&format!(
            "unknown route: {method} {route}"
        ))),
    }
}

fn media_song_url_value(result: mineradio_api::types::SongUrlResult) -> serde_json::Value {
    let mut value =
        serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({ "url": "" }));
    if let Some(url) = value.get("url").and_then(serde_json::Value::as_str) {
        if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
            value["url"] = serde_json::Value::String(format!(
                "{}/{}",
                crate::media_protocol::media_proxy_base(),
                url.trim_start_matches('/')
            ));
        }
    }
    value
}

fn parse_song_url_body(
    body: Option<serde_json::Value>,
) -> Result<(Track, Option<SongUrlOptions>), ApiCallError> {
    let Some(value) = body else {
        return Err(ApiCallError::bad_request("invalid or missing Track body"));
    };
    if let Ok(request) = serde_json::from_value::<SongUrlRequestBody>(value.clone()) {
        return Ok((
            request.track,
            Some(SongUrlOptions {
                quality: request.quality,
            }),
        ));
    }
    if let Ok(track) = serde_json::from_value::<Track>(value) {
        return Ok((track, None));
    }
    Err(ApiCallError::bad_request("invalid or missing Track body"))
}

fn parse_body<T: serde::de::DeserializeOwned>(
    body: &Option<serde_json::Value>,
) -> Result<T, ApiCallError> {
    let value = body
        .as_ref()
        .ok_or_else(|| ApiCallError::bad_request("missing body"))?;
    serde_json::from_value(value.clone()).map_err(|_| ApiCallError::bad_request("invalid body"))
}

fn provider_api(api: &Api, provider: ProviderId) -> ProviderApi {
    match provider {
        ProviderId::Netease => api.netease.clone(),
        ProviderId::Qq => api.qq.clone(),
        ProviderId::Soda => api.soda.clone(),
        ProviderId::Kugou => api.kugou.clone(),
        ProviderId::Spotify => api.spotify.clone(),
        ProviderId::Unknown => unreachable!("unknown provider rejected earlier"),
    }
}

fn qr_login(
    api: &Api,
    provider: ProviderId,
    kind: Option<&str>,
) -> Result<mineradio_api::QrLoginApi, ApiCallError> {
    let kind = match kind {
        Some("qq") => QrLoginKind::Qq,
        Some("qq_music") => QrLoginKind::QqMusic,
        Some("wechat") => QrLoginKind::Wechat,
        Some("netease") => QrLoginKind::Netease,
        Some("kugou") => QrLoginKind::Kugou,
        Some("soda") => QrLoginKind::Soda,
        Some(_) => return Err(ApiCallError::bad_request("unknown QR login kind")),
        None => match provider {
            ProviderId::Netease => QrLoginKind::Netease,
            ProviderId::Qq => QrLoginKind::Qq,
            ProviderId::Soda => QrLoginKind::Soda,
            ProviderId::Kugou => QrLoginKind::Kugou,
            ProviderId::Spotify | ProviderId::Unknown => {
                return Err(ApiCallError::not_found(
                    "QR login not supported for provider",
                ))
            }
        },
    };
    if kind.provider() != provider {
        return Err(ApiCallError::bad_request(
            "QR login kind does not match provider",
        ));
    }
    api.qr_login(kind)
        .cloned()
        .ok_or_else(|| ApiCallError::not_found("QR login not available"))
}

fn parse_provider(raw: &str) -> Option<ProviderId> {
    let provider = raw.parse::<ProviderId>().ok()?;
    if provider == ProviderId::Unknown {
        None
    } else {
        Some(provider)
    }
}

fn decode_path_segment(segment: &str) -> String {
    urlencoding::decode(segment)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| segment.to_string())
}

fn split_path(path: &str) -> (&str, &str) {
    match path.split_once('?') {
        Some((route, query)) => (route, query),
        None => (path, ""),
    }
}

fn parse_query(query: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn query_u32(params: &HashMap<String, String>, key: &str, default: u32) -> u32 {
    params
        .get(key)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn query_u32_allow_zero(params: &HashMap<String, String>, key: &str, default: u32) -> u32 {
    params
        .get(key)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
}

fn query_f64_value(params: &HashMap<String, String>, key: &str) -> Option<serde_json::Value> {
    params
        .get(key)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(serde_json::Value::from)
}

fn health_body(app_version: &str, schema_version: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "appVersion": app_version,
        "apiVersion": "0.1.0",
        "schemaVersion": schema_version,
        "providers": ["netease", "qq", "kugou", "soda"],
        "providerStatus": capabilities_matrix()
    })
}

fn capabilities_matrix() -> serde_json::Value {
    // Registration/configuration describe this process graph only. `available` and
    // `fieldVerified` must never be inferred from adapter presence; they remain false
    // until an explicit operational/field evidence owner records them.
    serde_json::json!({
        "version": "0.1.0",
        "providers": [
            {
                "providerId": "netease",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "like", "quality"],
                "message": "registered; operational status unverified"
            },
            {
                "providerId": "qq",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "quality"],
                "message": "registered; operational status unverified"
            },
            {
                "providerId": "kugou",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "like", "quality"],
                "message": "registered; operational status unverified"
            },
            {
                "providerId": "soda",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "like", "quality"],
                "message": "registered; operational status unverified"
            }
        ],
        "services": [
            {
                "serviceId": "recommendations",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "message": "route registered; operational status unverified"
            },
            {
                "serviceId": "weatherRadio",
                "registered": true,
                "configured": true,
                "available": false,
                "fieldVerified": false,
                "message": "route registered; operational status unverified"
            }
        ]
    })
}

fn ok_envelope(data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "ok": true, "data": data })
}

fn error_envelope(err: &ApiCallError) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": {
            "code": err.code,
            "message": err.message,
            "retryable": err.retryable
        }
    })
}

struct ApiCallError {
    code: String,
    message: String,
    retryable: bool,
}

impl ApiCallError {
    fn from_api_error(err: &ApiError) -> Self {
        Self {
            code: err.code.as_str().to_string(),
            message: err.message.clone(),
            retryable: is_retryable(&err.code),
        }
    }

    fn bad_request(message: &str) -> Self {
        Self {
            code: "BAD_REQUEST".to_string(),
            message: message.to_string(),
            retryable: false,
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            code: "NOT_FOUND".to_string(),
            message: message.to_string(),
            retryable: false,
        }
    }

    fn internal(message: &str) -> Self {
        Self {
            code: "INTERNAL".to_string(),
            message: message.to_string(),
            retryable: true,
        }
    }

    fn unavailable(message: &str) -> Self {
        Self {
            code: "UNAVAILABLE".to_string(),
            message: message.to_string(),
            retryable: false,
        }
    }
}

fn is_retryable(code: &ApiErrorCode) -> bool {
    matches!(
        code,
        ApiErrorCode::Internal | ApiErrorCode::Unavailable | ApiErrorCode::InvalidResponse
    )
}

/// 下载远端播客音频供节拍分析（超时策略对齐媒体代理）。
async fn download_podcast_audio(url: &str) -> Result<Vec<u8>, String> {
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .expect("failed to build podcast audio http client")
    });
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "MineRadio/1.0")
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("http {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    Ok(bytes.to_vec())
}

/// 从 URL 路径扩展名猜测音频格式，猜不出按 mp3 处理。
fn guess_podcast_audio_format(url: &str) -> PodcastAudioFormat {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "ogg" | "oga" | "opus" => PodcastAudioFormat::Ogg,
        "m4a" | "mp4" | "aac" => PodcastAudioFormat::M4a,
        "flac" => PodcastAudioFormat::Flac,
        "wav" => PodcastAudioFormat::Wav,
        _ => PodcastAudioFormat::Mp3,
    }
}

#[cfg(test)]
mod tests {
    use super::capabilities_matrix;

    #[test]
    fn adapter_registration_is_not_reported_as_operational_availability() {
        let matrix = capabilities_matrix();
        for provider in matrix["providers"].as_array().expect("providers") {
            assert_eq!(provider["registered"], true);
            assert_eq!(provider["configured"], true);
            assert_eq!(provider["available"], false);
            assert_eq!(provider["fieldVerified"], false);
        }
        for service in matrix["services"].as_array().expect("services") {
            assert_eq!(service["registered"], true);
            assert_eq!(service["configured"], true);
            assert_eq!(service["available"], false);
            assert_eq!(service["fieldVerified"], false);
        }
    }
}
