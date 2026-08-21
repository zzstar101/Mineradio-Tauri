//! Frontend-facing API bridge.
//!
//! `api.ts` on the web side calls Tauri's `api_call` invoke command; this module
//! maps the frontend contract (`{ ok, data }` / `{ ok, error }`) onto the
//! in-process `mineradio_api` crate.

use std::collections::HashMap;

use mineradio_api::{
    Api, ApiError, ApiErrorCode, ProviderApi, ProviderId, QrLoginKind, SongUrlOptions, Track,
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

    match handle_route(api, app_version, schema_version, method, route, &params, body).await {
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
        ("GET", "/search") => {
            let keyword = params
                .get("keyword")
                .map(|v| v.as_str())
                .unwrap_or_default();
            if keyword.trim().is_empty() {
                return Err(ApiCallError::bad_request("keyword required"));
            }
            let provider = params
                .get("provider")
                .and_then(|raw| parse_provider(raw));
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
            let result = provider_api
                .playlist_detail(&id, 0, 0)
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
            let qr = qr_login(api, provider)?;
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
            let qr = qr_login(api, provider)?;
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
            let qr = qr_login(api, provider)?;
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
    let mut value = serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({ "url": "" }));
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

fn qr_login(api: &Api, provider: ProviderId) -> Result<mineradio_api::QrLoginApi, ApiCallError> {
    let kind = match provider {
        ProviderId::Netease => QrLoginKind::Netease,
        ProviderId::Qq => QrLoginKind::Qq,
        ProviderId::Soda => QrLoginKind::Soda,
        ProviderId::Kugou => QrLoginKind::Kugou,
        ProviderId::Spotify | ProviderId::Unknown => {
            return Err(ApiCallError::not_found("QR login not supported for provider"))
        }
    };
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

fn health_body(app_version: &str, schema_version: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "appVersion": app_version,
        "apiVersion": "0.1.0",
        "schemaVersion": schema_version,
        "providers": ["netease", "qq", "soda"],
        "providerStatus": capabilities_matrix()
    })
}

fn capabilities_matrix() -> serde_json::Value {
    serde_json::json!({
        "version": "0.1.0",
        "providers": [
            {
                "providerId": "netease",
                "available": true,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "like", "quality"],
                "message": "online"
            },
            {
                "providerId": "qq",
                "available": true,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "quality"],
                "message": "online"
            },
            {
                "providerId": "soda",
                "available": true,
                "capabilities": ["search", "songUrl", "lyric", "playlistList", "playlistDetail", "loginStatus", "logout", "like", "quality"],
                "message": "online"
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
}

fn is_retryable(code: &ApiErrorCode) -> bool {
    matches!(
        code,
        ApiErrorCode::Internal | ApiErrorCode::Unavailable | ApiErrorCode::InvalidResponse
    )
}
