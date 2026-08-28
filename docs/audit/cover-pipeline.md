# Cover Pipeline 全链路审计与 Wave 2 Field Closure

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

| Provider | Confirmed source | Empty semantics | Referer policy | Proxy | Packaged field |
| --- | --- | --- | --- | --- | --- |
| QQ | `y.gtimg.cn` album cover | missing/blank album mid -> `""` | `https://y.qq.com/` | canonical | DOM/WebGL PASS |
| Netease | `p1.music.126.net` `picUrl` | missing -> `""` | `https://music.163.com/` | canonical | DOM/WebGL PASS |
| Soda/Qishui | `p3-luna.douyinpic.com` cover | missing -> `""` | `https://www.qishui.com/` | canonical | DOM/WebGL PASS |
| Kugou | `trans_param.union_cover` from mobile search | missing -> `""` | `https://www.kugou.com/` | canonical | fixture + DOM/WebGL PASS |
| Local | `http://mineradio-local.localhost/cover/...` | missing -> `""` | none | bypass | DOM/WebGL PASS |
| Unknown | arbitrary valid http(s) | missing -> `""` | none | canonical neutral | automated |
| Spotify | transport audit only | missing -> `""` | neutral until confirmed | canonical neutral | product scope unresolved |

The native classifier parses `Url::host_str()` and uses exact-domain/safe-suffix matching. Provider text in attacker-controlled hosts never selects provider headers. Unknown hosts receive User-Agent and image Accept only; they never inherit a provider Referer.

## Semantic contract

- `empty`: legal no-cover state; no request is attempted.
- `known invalid`: QQ `T002R...M000.jpg` is rejected and cannot enter rendering.
- `remote`: valid credential-free `http:`/`https:` source rendered only through MediaUrlPort/native proxy.
- `protocol-relative`: normalized to `https:` before DTO consumption.
- `local/custom`: registered `mineradio-*` schemes and WebView origins remain opaque.
- `blob/data`: `blob:` and `data:image/*` remain local; non-image data URIs are rejected.
- `malformed/unsafe`: schema validation fails; renderer resolves to deterministic no-cover.
- `fallback`: no direct provider fallback. A semantically empty source clears the cover state; a failed non-empty replacement cannot overwrite the committed current identity.

## Native response contract

A proxy success requires all of:

```text
2xx status
content-type starts with image/
non-empty body
body <= 20 MiB
```

A declared `Content-Length` over the limit fails before body consumption. The packaged candidate produced `Image.onerror` for controlled `200 text/html`, empty body, non-2xx, non-image content type, and oversized response cases. Native tests lock their proxy error status and response contract.

## Kugou closure

The previous signed gateway search reproducibly returned:

```text
status=1
error_code=152
error_msg=Parameter Error
```

A live unauthenticated response from `http://mobilecdn.kugou.com/api/v3/search/song` confirmed the currently working request and response shape. The minimized fixture retains only `status`, `errcode`, `data.info[].hash`, album/audio identity, title/artist/album, duration, and `trans_param.union_cover`; it contains no cookie, token, QR material, account metadata, or session credential.

The fix is limited to the confirmed field defect:

```text
mobile search request
-> /data/info list
-> trans_param.union_cover
-> Track.coverUrl
-> CoverSourceSchema
-> canonical image proxy
-> packaged DOM/WebGL
```

Fixture: `api/src/providers/kugou/fixtures/search-cover-response.json`.

## Exact field candidate

```text
parent = 2eba3b079bf2a76f5a84d7491913bc56f60cb909
API = fb00fafe837a875639b905443115ce16b1abdc96
build = wave2b-candidate-b-2eba3b0-fb00faf-20260828T170346Z
artifact = MineRadio-Tauri_2.1.0_x64-setup.exe
artifact SHA256 = d74bc16cc95cd2b96b7bfe3d7bb1d5b3090ab8cd9b3dddbb158e4c0f586e3216
WebView2 = 151.0.4129.107
```

Both SHAs were remote reachable before Candidate B was built. A fresh recursive clone at the exact parent/API pair passed frozen Bun install, web production build, and locked desktop cargo check.

## Windows / WebView2 field matrix

| Provider | Source/status | Header evidence | DOM | WebGL | CSP | Result |
| --- | --- | --- | --- | --- | --- | --- |
| QQ | `200 image/webp`, 300x300 | native policy test + real HTTPS success | PASS | PASS | PASS | FIELD PASS |
| Netease | `200 image/jpg`, 1500x1500 | packaged HTTP forward capture PASS | PASS | PASS | PASS | FIELD PASS |
| Soda | `200 image/jpeg`, 360x360 | native policy test + real HTTPS success; no Netease Referer | PASS | PASS | PASS | FIELD PASS |
| Kugou | `200 image/webp`, 400x400 | packaged HTTP forward capture PASS | PASS | PASS | PASS | FIELD PASS |
| Local | `200 image/jpeg`, 792x792 | N/A; opaque local URI | PASS | PASS | PASS | FIELD PASS |

Each sample used one logical source and one resolved URI policy for a visible DOM image and WebGL texture upload in the installed production-CSP WebView2 process. Canvas readback produced a non-empty per-sample pixel hash.

Netease and Kugou HTTP covers were routed through a controlled forward proxy to observe the packaged native User-Agent, image Accept, and exact Referer. QQ and Soda were not MITM-decrypted; their exact headers remain Layer 1 native contract evidence, while successful real HTTPS proxy rendering is Layer 5 field evidence. The evidence file keeps these layers distinct.

## Lifecycle field evidence

Stale replacement used the production UI and actual Three renderer:

```text
pause Track A image-proxy request
-> switch to Track B
-> B DOM and identifiable WebGL upload commit
-> release A
-> final title/DOM/queue remain B
-> no A WebGL upload occurs after release
```

Result: PASS.

No-cover used a real local FLAC. One copy retained its embedded image; a second copy retained the audio stream but removed metadata and embedded picture. Production drag-drop imported both tracks. Switching valid A -> no-cover B produced a DOM placeholder and the default WebGL fallback particle palette, with no A cover URI or cover-derived visual left representing B. Sanitized visual crops are stored beside the structured evidence.

A real QQ missing-album-mid upstream sample was not found. This remains explicitly `SEMANTIC_VERIFIED / FIELD_SAMPLE_PENDING`; the mapper fixture and packaged empty-source fallback are separate evidence and no fake `M000.jpg` request occurred.

## Evidence authority

The canonical evidence is [cover-field-validation.json](evidence/cover-field-validation.json). It records candidate identity, raw/normalized/resolved source kinds, proxy policy, response status/MIME/size, DOM/WebGL outcomes, headers, abnormal responses, stale lifecycle, no-cover behavior, CSP, fresh-clone results, and screenshot hashes.

`CAN_DOM_AND_WEBGL_DIVERGE = NO` is now proven for the five required packaged samples under the selected source policy. This closes the Wave 2 Cover Pipeline field blocker without promoting unrelated provider, Player Shell, Visual Console, or Stage Lyrics surfaces.

```text
WAVE_2 = PASS
RC_READY = NO
NEXT = WAVE_3_PLAYER_SHELL
```
