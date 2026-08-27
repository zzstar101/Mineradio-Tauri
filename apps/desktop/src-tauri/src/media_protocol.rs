//! `mineradio-tauri://` custom-protocol handler.
//!
//! The Rust API library (`api` crate) returns relative proxy routes
//! (`audio-proxy?url=…&provider=…[&key=…]`); the frontend builds full URLs by
//! prefixing `media_proxy_base()`. The route may also arrive in the authority
//! (host) position (`mineradio-tauri://audio-proxy?url=…`) for legacy calls,
//! or in the path position (`mineradio-tauri://localhost/image-proxy?url=…`).
//! Both are accepted here:
//!
//! * `/audio-proxy?url=…&provider=…[&key=…]` — audio passthrough; `soda`
//!   always decrypts with `key` (playAuth), `qq` decrypts when a `key` is
//!   supplied or the payload carries an encrypted tail, others pass through.
//! * `/image-proxy?url=…` — cover passthrough with a browser user-agent + referer.
//! * `/providers/soda/audio-proxy?url=…&playAuth=…` — legacy soda route kept for
//!   compatibility.

/// Base URL for the `mineradio-tauri` custom protocol.
///
/// Tauri 2 / Wry platform difference: Windows registers the custom scheme as
/// `http://<scheme>.localhost` (WebView2), while macOS/Linux use the native
/// `<scheme>://localhost` form. The frontend prefixes relative proxy routes
/// (`/audio-proxy`, `/image-proxy`) with this base.
#[cfg(target_os = "windows")]
pub fn media_proxy_base() -> &'static str {
    "http://mineradio-tauri.localhost"
}

#[cfg(not(target_os = "windows"))]
pub fn media_proxy_base() -> &'static str {
    "mineradio-tauri://localhost"
}

use std::sync::OnceLock;
use std::time::Duration;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder};

const IMAGE_PROXY_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(120);

fn http_client() -> &'static reqwest::Client {
    crate::install_tls_crypto_provider();
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(MEDIA_FETCH_TIMEOUT)
            .build()
            .expect("failed to build media proxy http client")
    })
}

pub fn handle_media_request<R: tauri::Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let host = request.uri().host().unwrap_or("").to_string();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();

    tauri::async_runtime::spawn(async move {
        let route = effective_route(&host, &path);
        let response = route_media(&route, &query).await;
        responder.respond(response);
    });
}

/// Map a custom-scheme request onto a `/route`. The api crate emits the route in
/// the authority position (`mineradio-tauri://audio-proxy?url=…`), while the
/// frontend builders use the path position (`mineradio-tauri://localhost/audio-proxy?…`).
fn effective_route(host: &str, path: &str) -> String {
    if path.is_empty() || path == "/" {
        if host.is_empty() {
            String::new()
        } else {
            format!("/{host}")
        }
    } else {
        path.to_string()
    }
}

async fn route_media(path: &str, query: &str) -> Response<Vec<u8>> {
    let result = match path {
        "/audio-proxy" => {
            let target = query_param(query, "url").unwrap_or_default();
            let provider = query_param(query, "provider").unwrap_or_default();
            let key = query_param(query, "key");
            proxy_audio_for_provider(&target, &provider, key.as_deref()).await
        }
        "/image-proxy" => {
            let target = query_param(query, "url").unwrap_or_default();
            proxy_image(&target).await
        }
        "/providers/soda/audio-proxy" => {
            let target = query_param(query, "url").unwrap_or_default();
            let play_auth = query_param(query, "playAuth").unwrap_or_default();
            proxy_soda_audio(&target, &play_auth).await
        }
        _ => Err(MediaError::NotFound),
    };

    match result {
        Ok((content_type, bytes)) => ok_response(content_type, bytes),
        Err(err) => err_response(err),
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn parse_target_url(target: &str) -> Result<url::Url, MediaError> {
    if target.trim().is_empty() {
        return Err(MediaError::BadRequest("url required"));
    }
    let parsed = url::Url::parse(target).map_err(|_| MediaError::BadRequest("invalid url"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err(MediaError::BadRequest("url must use http or https")),
    }
}

async fn proxy_audio(target: &str) -> Result<(String, Vec<u8>), MediaError> {
    let url = parse_target_url(target)?;
    let response = http_client()
        .get(url)
        .send()
        .await
        .map_err(|_| MediaError::Upstream)?;
    if !response.status().is_success() {
        return Err(MediaError::UpstreamStatus(response.status().as_u16()));
    }
    let content_type = content_type_of(&response)
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| MediaError::Upstream)?
        .to_vec();
    Ok((content_type, bytes))
}

async fn proxy_audio_for_provider(
    target: &str,
    provider: &str,
    key: Option<&str>,
) -> Result<(String, Vec<u8>), MediaError> {
    match provider {
        // Soda play URLs are always encrypted; `key` is the playAuth token.
        "soda" => proxy_soda_audio(target, key.unwrap_or("")).await,
        // QQ audio is encrypted when a `key` (ekey) is supplied, or when the
        // payload carries an encrypted tail; decrypt_qq_audio passes plain files
        // through untouched.
        "qq" => {
            let url = parse_target_url(target)?;
            let response = http_client()
                .get(url)
                .send()
                .await
                .map_err(|_| MediaError::Upstream)?;
            if !response.status().is_success() {
                return Err(MediaError::UpstreamStatus(response.status().as_u16()));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| MediaError::Upstream)?
                .to_vec();
            let decrypted = mineradio_api::decrypt_qq_audio(bytes, key)
                .map_err(|err| MediaError::Decrypt(err.to_string()))?;
            Ok((decrypted.content_type, decrypted.data))
        }
        // netease / kugou / unknown: plain passthrough.
        _ => proxy_audio(target).await,
    }
}

async fn proxy_image(target: &str) -> Result<(String, Vec<u8>), MediaError> {
    let url = parse_target_url(target)?;
    let referer = referer_for_url(&url);
    let response = http_client()
        .get(url)
        .header(header::USER_AGENT, IMAGE_PROXY_USER_AGENT)
        .header(header::REFERER, referer)
        .send()
        .await
        .map_err(|_| MediaError::Upstream)?;
    if !response.status().is_success() {
        return Err(MediaError::UpstreamStatus(response.status().as_u16()));
    }
    let content_type = content_type_of(&response).unwrap_or("").to_string();
    if !content_type.starts_with("image/") {
        return Err(MediaError::UpstreamStatus(502));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| MediaError::Upstream)?
        .to_vec();
    Ok((content_type, bytes))
}

async fn proxy_soda_audio(target: &str, play_auth: &str) -> Result<(String, Vec<u8>), MediaError> {
    let url = parse_target_url(target)?;
    if play_auth.trim().is_empty() {
        return Err(MediaError::BadRequest("playAuth required"));
    }
    let response = http_client()
        .get(url)
        .send()
        .await
        .map_err(|_| MediaError::Upstream)?;
    if !response.status().is_success() {
        return Err(MediaError::UpstreamStatus(response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| MediaError::Upstream)?
        .to_vec();
    let decrypted = mineradio_api::decrypt_soda_audio(bytes, play_auth)
        .map_err(|err| MediaError::Decrypt(err.to_string()))?;
    Ok((decrypted.content_type, decrypted.data))
}

fn content_type_of(response: &reqwest::Response) -> Option<&str> {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
}

fn referer_for_url(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host.contains("qq.com") || host.contains("qpic.cn") || host.contains("gtimg.cn") {
        "https://y.qq.com/".to_string()
    } else {
        "https://music.163.com/".to_string()
    }
}

fn ok_response(content_type: String, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCEPT_RANGES, "bytes")
        .body(bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn err_response(err: MediaError) -> Response<Vec<u8>> {
    let status = match &err {
        MediaError::BadRequest(_) => StatusCode::BAD_REQUEST,
        MediaError::Upstream | MediaError::UpstreamStatus(_) | MediaError::Decrypt(_) => {
            StatusCode::BAD_GATEWAY
        }
        MediaError::NotFound => StatusCode::NOT_FOUND,
    };
    let body = format!(
        r#"{{"ok":false,"error":{{"code":"MEDIA_PROXY","message":"{}"}}}}"#,
        err
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[derive(Debug)]
enum MediaError {
    BadRequest(&'static str),
    Upstream,
    UpstreamStatus(u16),
    Decrypt(String),
    NotFound,
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::BadRequest(message) => f.write_str(message),
            MediaError::Upstream => f.write_str("upstream media request failed"),
            MediaError::UpstreamStatus(status) => {
                write!(f, "upstream media request returned {status}")
            }
            MediaError::Decrypt(message) => write!(f, "media decrypt failed: {message}"),
            MediaError::NotFound => f.write_str("unknown media route"),
        }
    }
}
