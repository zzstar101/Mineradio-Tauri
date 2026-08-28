# Cover Pipeline 全链路审计

## 结论

确认一个 mapper defect、一个 native proxy provider-classification defect，以及多个 schema/渲染分叉风险。当前不能声称“封面链已完成”。

- **Confirmed P1**：QQ 缺少 album mid 时生成假有效 URL `...T002R300x300M000.jpg`。
- **Confirmed code defect / field impact high-risk**：native image proxy 除 QQ 外统一发送网易云 Referer，Soda/Kugou/Spotify 分类错误。
- **Contract gap**：`coverUrl` 只验证 string，空、malformed、known-invalid pattern 均可通过。
- **Render split**：CSS 图片多为 direct URL，WebGL 使用 custom-protocol proxy；同一曲目可出现“DOM 有图、舞台无纹理”或相反。

## 规范化链路

```text
provider raw response
  -> api/src/providers/* mapper
  -> api::types::Track / Playlist / Album / Recommendation
  -> api_bridge { ok, data }
  -> shared Zod schema
  -> controller/store Track
  -> DOM/CSS direct URL OR MediaUrlPort imageSource
  -> mineradio-tauri://.../image-proxy
  -> User-Agent + provider Referer + HTTP response/cache
  -> CSS image / Three.js texture
```

## Provider × 入口矩阵

`C`=代码链存在，`D`=confirmed defect，`R`=高风险未实测，`U`=真实响应/渲染未验证，`N/A`=该来源不是 provider Track。

| 来源 | Search | Home | Playlist | Album | Stream | Current | Queue | Shelf | Lyrics stage | CSS | WebGL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QQ | D | D/U | D | D | D/U | D | D | D | D | direct U | proxy U |
| Netease | C/U | C/U | C/U | API struct only | C/U | C/U | C/U | C/U | C/U | direct U | proxy U |
| Soda | C/U | C/U | C/U | API struct only | C/U | C/U | C/U | C/U | R | direct U | wrong Referer R |
| Kugou | C/U | C/U | C/U | API struct only | C/U | C/U | C/U | C/U | R | CSP/domain U | wrong Referer R |
| Local | N/A | C/U | C/U | N/A | N/A | C/U | C/U | C/U | C/U | custom protocol U | custom URI U |
| Recommendation | N/A | C/U | card opens track/playlist | N/A | N/A | downstream Track | downstream | downstream | downstream | direct U | downstream proxy |
| Playlist cover | N/A | C/U | C/U | N/A | N/A | N/A | N/A | N/A | N/A | direct U | N/A |
| Album cover | Rust DTO exists | no TS Album schema/client | no album surface | MISSING | N/A | Track fallback only | Track | Track | Track | partial | partial |

## Confirmed defect 1：QQ 空 album mid

- Upstream `server.js:3260-3263` 的 `qqAlbumCover` 对空 mid 返回空串。
- Current `api/src/providers/qq/model.rs:31-63` 的搜索 mapper 无条件 format。
- Current 同文件 `1098-1122` 的 `QqTrack::standardize` 先 `unwrap_or_default()`，再无条件 format。
- 结果是结构合法但语义无效的 `https://y.gtimg.cn/music/photo_new/T002R300x300M000.jpg`。
- `packages/shared/src/track.ts:23` 只做 `z.string()`，无法拦截；现有 mapper test 只覆盖非空 mid。

这不是“CDN 可能失败”的推测，而是相对唯一 upstream 基线的 mapper 行为回退。

## Confirmed defect 2：Referer 分类

`apps/desktop/src-tauri/src/media_protocol.rs:239-245` 只识别 QQ host；其余全部返回 `https://music.163.com/`。上游对 Qishui/Douyin 与 Kugou 使用各自 provider referer。当前 Soda/Kugou/Spotify 图片被明确错误分类；真实 CDN 是否 403/空体需要用户网络样本验证，因此 HTTP 影响标 `UNVERIFIED`，代码语义标 defect。

## CSS / WebGL 分叉

- `legacy-media-url.ts:12-35` 的 `imageSource` 生成 proxy URI 并携带 direct fallback。
- `sidecar-client.ts:343-350` 只对 http(s) 生成 `/image-proxy`，data/blob 原样通过。
- `VisualEngineHost.tsx:150-188` 给 WebGL 使用 media URL port；普通 DOM/CSS cover 仍大量直接使用 `coverUrl`。
- Tauri CSP 只允许列举的图片域与 custom protocols。QQ/网易/已知 douyin 域较明确，Kugou 和未来 CDN 域必须以真实样本校验，不能靠字段存在推断。

## Semantic contract tests 设计（仅计划）

| Fixture | Structural assertion | Semantic assertion | HTTP/render assertion |
| --- | --- | --- | --- |
| QQ track with album mid | TrackSchema pass | URL parse + host/path pattern + mid present | direct/proxy 2xx、图片可解码 |
| QQ track without album mid | TrackSchema pass | `coverUrl === ""`，禁止 `M000.jpg` | fallback cover 可见 |
| Netease/Soda/Kugou real track | provider/id/sourceId valid | URL scheme/host allow policy，非空仅在 provider 确有 cover | correct Referer、UA、decode |
| Playlist/recommendation/album with known cover | DTO schema pass | cover nonempty, parseable, not known-invalid | CSS 与 WebGL 像素均非 fallback |
| protocol-relative/http URL | normalize policy explicit | HTTPS upgrade or documented reject | WebView2 CSP 通过 |
| local cover | custom URI opaque | 不解析 host/path | protocol 200/Range/size/decode |

真实 provider fixture 必须由用户验证并脱敏后冻结；不得凭猜测编造 response shape。

## Release gate

至少完成：QQ empty-mid 修复的 mapper test；四 provider 各一条用户确认的有封面/无封面 fixture；native proxy header test；CSS/WebGL 双路径解码 test；WebView2 CSP/CDN field matrix。完成前 cover pipeline 是 P1 blocker。

