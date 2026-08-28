# Cover Pipeline 全链路审计与 Wave 2 Contract

## Architecture decision

```text
REMOTE_COVER_POLICY = CANONICAL_PROXY

provider raw cover
  -> provider mapper (empty remains empty)
  -> shared CoverSourceSchema normalization/validation
  -> Track / Playlist / Recommendation / Podcast DTO
  -> store/controller keeps the logical source
  -> MediaUrlPort.imageSource
  -> one resolved opaque URI
       -> DOM/CSS
       -> WebGL
  -> mineradio-tauri image proxy for remote http(s)
```

Remote provider URLs are never a cover render fallback. `data:image`, `blob:`, `mineradio-*`, and registered `http://mineradio-*.localhost` WebView origins remain opaque and bypass the remote proxy. Production CSP admits these canonical/local image paths. Existing provider image entries are retained for out-of-scope account/avatar surfaces, but the cover pipeline does not depend on them.

## Provider contract

| Provider | Cover origin | Empty semantics | Confirmed host/CDN evidence | Referer policy | Proxy required | Fixture / field |
| --- | --- | --- | --- | --- | --- | --- |
| QQ | album mid -> provider cover URL | missing/blank album mid -> `""` | `y.gtimg.cn` captured; upstream `qqAlbumCover()` | `https://y.qq.com/` | remote yes | captured semantic fixture; field pending |
| Netease | provider `picUrl` | missing -> `""` | `p2.music.126.net` captured | `https://music.163.com/` | remote yes | captured semantic fixture; field pending |
| Soda/Qishui | provider `url_cover` / `cover_url` | missing -> `""` | `p3-luna.douyinpic.com` captured | `https://www.qishui.com/` | remote yes | captured semantic fixture; field pending |
| Kugou | provider `Image` / `sizable_cover` family | missing -> `""` | upstream confirms `kugou.com` policy family; real cover CDN response absent | `https://www.kugou.com/` only for exact/suffix `kugou.com` hosts | remote yes | `FIELD_SAMPLE_PENDING` |
| Local | native local-library cover URI | missing -> `""` | `http://mineradio-local.localhost` | none | no | automated URI/CSP; field pending |
| Unknown | arbitrary valid http(s) image source | missing -> `""` | no provider assumption | none | remote yes, neutral | automated |
| Spotify | provider image URL, transport audit only | missing -> `""` | no confirmed repository fixture | none until a confirmed CDN policy exists | remote yes, neutral | product scope unresolved; field pending |

The native classifier parses `Url::host_str()` and uses exact-domain/safe-suffix matching. Provider text in attacker-controlled hosts never selects provider headers. Unknown hosts receive User-Agent and image Accept only; they never inherit Netease Referer.

## Semantic contract

- `empty`: legal no-cover state; no request is attempted.
- `known invalid`: QQ `T002R...M000.jpg` is rejected by the shared schema and cannot enter rendering.
- `remote`: only valid `http:`/`https:` URLs without embedded credentials; rendered through MediaUrlPort/native proxy.
- `protocol-relative`: normalized to `https:` before DTO consumption.
- `local/custom`: registered `mineradio-*` schemes and WebView origins remain opaque.
- `blob/data`: `blob:` and `data:image/*` remain local; non-image data URIs are rejected.
- `malformed/unsafe`: schema validation fails explicitly; renderer-level inspection resolves to deterministic no-cover.
- `fallback`: no direct remote fallback. Existing committed WebGL texture remains visible while a replacement loads or fails; a semantically empty/invalid source resolves to the no-cover state.

## Native image response contract

A proxy success requires all of:

```text
2xx status
content-type starts with image/
non-empty body
body <= 20 MiB
```

A declared `Content-Length` over the limit fails before body consumption. `200 text/html`, empty images, and oversized bodies return proxy failure rather than image bytes.

## Fixture provenance

- `packages/shared/fixtures/weather-radio-envelope.json` is the captured native Rust weather-radio envelope retained by Wave 1. It supplies sanitized real QQ, Netease, and Soda cover URLs and contains no credentials.
- QQ empty/missing album-mid semantics are sourced from upstream v2.1.0 `server.js::qqAlbumCover` and locked by MineRadio-api mapper tests for valid, empty, missing flat `albummid`, missing album object, and missing nested mid.
- No confirmed Kugou cover response is present. No response shape or CDN fixture was invented.

## Render and lifecycle evidence

Automated evidence proves:

- DOM and WebGL resolve the same logical remote source to the same opaque URI policy.
- direct provider URLs are unavailable when MediaUrlPort is absent.
- local/data/blob covers bypass remote proxying.
- A slow Track A completion cannot overwrite selected Track B.
- a failed Track B replacement retains the committed Track A WebGL texture.
- invalid/empty sources produce deterministic no-cover state.
- production CSP allows canonical custom/local image paths, and cover resolvers never emit provider CDN direct sources.

`CAN_DOM_AND_WEBGL_DIVERGE = NO` at source-policy level. Decode/render success still requires Windows/WebView2 field evidence.

## Windows / WebView2 field matrix

No packaged or near-release WebView2 session with provider samples was performed in this coding run. Automated tests are not promoted to field evidence.

| Provider | DOM | WebGL | Header | CSP | Result |
| --- | --- | --- | --- | --- | --- |
| QQ | pending | pending | automated only | automated only | `FIELD_SAMPLE_PENDING` |
| Netease | pending | pending | automated only | automated only | `FIELD_SAMPLE_PENDING` |
| Soda | pending | pending | automated only | automated only | `FIELD_SAMPLE_PENDING` |
| Kugou | pending | pending | automated only | automated only | `FIELD_SAMPLE_PENDING` |
| Local | pending | pending | n/a | automated only | `FIELD_SAMPLE_PENDING` |

Until the packaged field matrix records raw cover, normalized cover, resolved URI, proxy policy, status/content-type, DOM result, and WebGL result, Wave 2 remains blocked despite the code defects being closed.
