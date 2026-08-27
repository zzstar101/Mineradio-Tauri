# 推荐页与推荐卡片交互设计

> 状态：设计稿（未实现）。配套现状文档见 `docs/recommendation-page-migration.md`（阶段一：主页预览）。
> 本文覆盖三部分：播放结构与续播逻辑的调研结论、三种推荐卡片的交互设计、独立推荐页设计。

---

## 1. 背景调研：播放结构与续播逻辑

### 1.1 播放结构：从「点卡片」到「出声」

整条链路是 **Store 驱动** 的：

```
卡片 onClick
  → usePlaybackStore（唯一状态源）: queue / currentTrack / playbackIntentId / mode
  → usePlaybackSessionRuntime（effect 引擎）:
       currentTrack 变化 → resolvePlayableAudio() → playback.resolveSongUrl(track)
       → controller.load(audioUrl, session) → controller.play()
  → PlayerController → PlaybackAudioRuntime（深 Module，独占 deck/gain/fade）
```

- `apps/web/src/stores/playback-store.ts` — 队列与当前曲的唯一真相。`setQueue` / `playAt` / `next` / `ended` / `enqueue` / `insertNext`。
- `apps/web/src/ports/music/playback-port.ts` — `songUrl(track)` / `resolveSongUrl(track)`。**要的是完整 `Track` 对象（provider + id + title + artists），不是裸 ID。**
- `apps/desktop/src-tauri/src/api_bridge.rs` — `POST /song-url`（跨源）或 `POST /providers/:id/song-url`（单源）。
- `api/src/cross_source.rs`（`resolve_song_url`）— 先用 `track.id` 直连自家 provider 取 URL；失败用 title+artists 去其他 provider 搜索回退。**id 是真 track id 时直连即出 URL**，title/artists 只影响兜底搜索质量。
- `apps/web/src/features/playback/usePlaybackSessionRuntime.ts` — 标准加载路径：`resolvePlayableAudio` → `controller.load` → `play()`，顺带拉歌词 / 播客 beatmap。
- `apps/web/src/audio/playback-audio-runtime.ts` — 深 Module；caller 只提交 URL 与 intent。

**隐含事实：store 的 `queue` 就是左侧队列展示的数据源。** 往 queue `enqueue` 一首，左侧显示自动多一首——这是 Stream「续接」能落地的根因。

### 1.2 续播逻辑：一首播完怎么接下一首

```
媒体 ended 事件
  → usePlaybackSessionRuntime.handleRuntimeEnded
  → onRuntimeEnded 回调
  → usePlaybackUiController.handleRuntimeEnded      [apps/web/src/features/playback/usePlaybackUiController.ts:231]
  → usePlaybackStore.getState().ended()             [apps/web/src/stores/playback-store.ts:554]
  → mode === "single" ? 重播当前曲 : next()          [playback-store.ts:517]
```

`next()` 按 mode 从**已存在的 queue** 里取下一首：

| mode | 行为 |
|---|---|
| `loop`（默认） | `(current+1) % length`，到尾回卷 |
| `queue` | `current+1`，到尾直接停（currentTrack 置 null） |
| `single` | 永远重播同一首 |
| `shuffle` | 随机，且排除当前项 |

取到新 `currentTrack` → React effect 重新跑「resolve URL → load → play」。

gapless（无缝/淡入淡出，`GaplessPlaybackController`）会在 timeupdate 接近结尾时**预载 `queue[currentIndex+1]`** 到另一个 deck，ended 时 handoff。它依赖「下一首已存在于 queue」。

**核心结论：现有续播是「从预先填好的队列取下一首」，纯同步 store 操作，没有「队列耗尽再按需拉歌」的钩子。** 这是 Stream 需要补的缺口。

### 1.3 关键事实清单

1. `PlaybackPort.songUrl` 需要完整 `Track`，不是裸 ID。
2. 续播完全由 `queue` 驱动；`next()` / `ended()` 是同步 store 操作。
3. gapless 依赖「下一首已在 queue 中」。
4. `ProviderApi::stream_next(id)` 已存在（`api/src/provider.rs:122`），Netease 已实现（`P`=私人FM、`S`=星动模式带缓存续接，`api/src/providers/netease/adapter.rs:717`），QQ 也有实现；**但桌面桥 `api_bridge.rs` 未暴露、前端无对应 port**。
5. `RecommendationCard` 本身不携带 `provider`；provider 在 page 上。卡片数据含 `id / title / subtitle / coverUrl / kind`。
6. 当前主页推荐卡片是**无交互 div**（`apps/web/src/home/EmptyHomeHost.tsx` 推荐预览段没有任何 onClick）。

---

## 2. 三种推荐卡片交互

交互由 `kind` 决定，不从位置/标题推断（遵循迁移文档设计原则）。

### 2.1 Track 卡片 —— 零 API 改动

- 卡片数据已带 `id / title / subtitle / coverUrl`，provider 在 page 上。
- **onclick 时前端现场合成一个 `Track`**：
  ```
  { provider: 所在页 provider, id: card.id, sourceId: card.id,
    title, artists: 由 subtitle 拆, coverUrl, playableState: "playable" }
  ```
- 走现成链路：`setQueue([track])` + `playAt(0)`；交叉源 `resolve_song_url` 用 `card.id` 直连取 URL。
- **待确认**：`card.subtitle` 是否为歌手。若不是干净的 artist 串，直连失败时兜底搜索质量会差。

### 2.2 Playlist 卡片 —— 复用现成歌单逻辑

- 首页已有 `openPlaylist(index)` → `library.playlistDetail(provider, id)` → 详情页 → `setQueue(tracks)` + `playAt(0)`（`apps/web/src/features/home/useHomeController.ts`）。
- 抽通用方法 `openRecommendationPlaylist(provider, id)`：把「按 discover 数组下标」改为「按 provider + card.id」，其余全复用。

### 2.3 Stream 卡片 —— 重点

**播放模型：把 Stream 建模成「按需生长的队列」。**

1. **首次点击**：`await port.streamNext(provider, card.id)` → 第一首 Track → 放进 queue 并记标记 `streamSource = { provider, id }` → `playAt(0)`。
2. **续播**：`ended → next()` 在「当前曲已是 queue 最后一首 + streamSource 激活 + 无进行中的拉取」时，**先异步拉下一首再前进**。store 操作同步，拉歌放 feature 层：
   ```
   ended 事件
     → 若 最后一首 && streamSource 激活 && 未在拉
     → await streamNext(provider, id) → store.enqueue(track) → store.ended()
     → 拉到即播；拉失败 → toast + 走原有 ended 路径
   ```
3. **左侧显示**：续接是往 queue append **真实 Track**，左侧队列天然把新请求的歌接上来，无需额外显示逻辑。

**store 层最小改动：**
- 新增 `streamSource: { provider, id } | null` 状态 + setter。
- 整队列替换的动作（`setQueue`、`clearQueue`、checkpoint 恢复）清空它；`enqueue` / `insertAt` / `next` / `ended` 保留它。

**已确定的行为（2026-08 决策）：**
- **拉取失败 / 队列耗尽**：拉取失败即 `toast「流式续播失败」` + 清空 `streamSource`，退化成普通队列行为（loop 回卷 / queue 停止）。实现简单、行为可预期。
- **gapless 冲突**（实现时锁定）：无缝/淡入淡出需预载 `queue[currentIndex+1]`，而 stream 下一首直到 ended 才知道。Stream 续接应强制走普通 ended 路径（跳过 gapless handoff）。当前 gapless 只在 `queue` 有相邻候选时生效，天然会跳过，但要避免 enqueue 时机让 gapless 状态机误预载——用单测锁定。

### 2.4 Stream 需要新增的接口（全为 API 透传，行为需用户手动验证）

```
POST /providers/:id/stream-next     body: { "id": "<card.id>" }
  → provider_api.stream_next(id) → 返回一个 Track（标准 TrackSchema 校验）
```

前端补：
- `SidecarClient.streamNext(provider, id)`
- `DiscoverPort.streamNext(provider, id)`（或独立 RecommendationPort，见 §6）
- `apps/web/src/adapters/sidecar/legacy-sidecar-services.ts` 实现 + conformance 测试

前端全程把 `card.id` 当**不透明句柄**，不解析其内部结构。

---

## 3. 独立推荐页设计

### 3.1 进入逻辑

- **前置条件**：`recommendation_pages` 响应之后才能出现。即 `recommendations` 非空、主页能渲染出预览时，入口才可点击。
- **入口**：点击首页推荐预览段的**模块标题 / Provider 名字**进入（§4 会把标题改成「Provider · 模块名」，整个标题作为可点击按钮）。
- **交互**：点击 → home controller 置 `recommendationDetail` 状态 → `EmptyHomeHost` 切到推荐页 section（复用 `playlistDetail` 的整页替换模式：`EmptyHomeHost.tsx:624` 当 `playlistDetail` 非空时渲染全页详情）。

### 3.2 页面形式

- **独立单页**：全屏 `<section>`，与 `HomePlaylistDetailPage` 同级，替换主页内容。
- 结构参考歌单详情页：
  - 顶部工具栏：返回按钮（返回首页）+ Provider 名。
  - 页面主体：按 Provider 分组或统一的纵向流（见 3.3）。

### 3.3 渲染方式（流式）

- **流式 / 纵向流**：所有 `RecommendationModule` 按 API 返回顺序（`recommendation_pages` 的原始顺序）自上而下渲染，**不分页、不点「加载更多」**。
- 每个 module 渲染为一条横向卡片 rail（复用主页 rail 的 `home-rail-section` / `home-tile-row` 结构）。
- **已确定的范围（2026-08 决策）**：**统一 feed**——渲染全部 provider 的全部 module，按返回顺序排成一个纵向 feed，Provider 作为分段标题。点击任意 preview 标题进入同一个页面；被点击的 provider 作为**锚点**定位/高亮该分段。
- 页面数据**直接复用** `useHomeController` 已加载的 `recommendations`，打开即时渲染不重新请求；工具栏可提供「刷新」按钮调用 `refreshRecommendations({ refresh: true })`。

### 3.4 UI 表现

- 复用现有样式与组件：
  - 工具栏 / 返回：参照 `HomePlaylistDetailPage` 的 `home-detail-toolbar` / `home-detail-back`。
  - 卡片 rail：复用 `home-rail-section-head`、`home-tile-row`、`home-recommendation-card` 系列样式。
  - Provider 标签：复用 `HOME_PROVIDER_LABELS`。
- 卡片交互按 §2 的 kind 分发（Track 直接播 / Stream 流式播 / Playlist 打开歌单）。
- 空态：`recommendations` 为空时显示「暂无推荐内容」+ 重试。

### 3.5 页面状态与组件拆分

- 状态：`useHomeController` 新增
  ```ts
  const [recommendationDetail, setRecommendationDetail] = useState<RecommendationDetail | null>(null);
  // RecommendationDetail = { anchorProvider: ProviderId }
  //   统一 feed 下 anchorProvider 用于进入后定位/高亮被点击的 provider 分段。
  ```
  `openRecommendations(provider)` 设置之；`closeRecommendations()` 清空。
- 组件：
  - `features/recommendation/RecommendationPage.tsx`：整页 section（工具栏 + 纵向流）。
  - `features/recommendation/RecommendationModuleRail.tsx`：单条 module rail + 卡片交互分发。
  - `features/recommendation/recommendation-page-policy.ts`：纯函数，把 `RecommendationPage[]` 按返回顺序压平成 `{ provider, module }[]`，供流式渲染 + 单测。

---

## 4. 主页预览调整

- **模块标题前加 Provider 名**：当前预览标题只显示 module.title（`EmptyHomeHost.tsx` 的 `home-recommendation-module-title`）。改为
  ```
  {HOME_PROVIDER_LABELS[provider]} · {module.title}
  ```
- **标题变为入口按钮**：整个标题区域改为可点击按钮，onClick → `props.onOpenRecommendations?.(provider)`。
- `EmptyHomeHostProps` 新增 `onOpenRecommendations?: (provider: ProviderId) => void`；`App.tsx` 接线到 `useHomeController.openRecommendations`。
- 若标题改由 `home-recommendation-preview-policy.ts` 的 `HomeProviderPreview.title` 承载，则在该 policy 里拼接 label（纯函数，可单测）。

---

## 5. 落地清单

**Track / Playlist（纯前端，零 API 改动）**
- [ ] `EmptyHomeHost.tsx`：推荐卡片加 onClick，按 `card.kind` 分发。
- [ ] `useHomeController.ts`：`openRecommendationPlaylist(provider, id)` 通用歌单打开。
- [ ] 合成 Track 的 helper（卡片 → Track），可单测。

**Stream（前端 + 一层桥透传）**
- [ ] `api_bridge.rs`：`POST /providers/:id/stream-next` 路由（唯一新增 API，需用户手动验证）。
- [ ] `SidecarClient.streamNext` / `DiscoverPort.streamNext` / legacy adapter / conformance 测试。
- [ ] `playback-store.ts`：`streamSource` 状态 + setter。
- [ ] `usePlaybackUiController.ts`（或推荐 feature 层）：末尾续拉逻辑。

**推荐页**
- [ ] `useHomeController.ts`：`recommendationDetail` 状态 + `open/closeRecommendations`。
- [ ] `features/recommendation/*`：页面、module rail、policy + 单测。
- [ ] `EmptyHomeHost.tsx`：标题加 Provider 前缀 + 可点击入口；整页 section 切换。
- [ ] `App.tsx`：接线 `onOpenRecommendations`。

---

## 6. 已确定 & 待确认

**已确定（2026-08）：**
1. 推荐页范围：**统一 feed**，全部 provider 全部 module 按返回顺序纵向排布。
2. Stream 拉取失败：**toast + 清空 streamSource**，退化成普通队列行为。
3. Stream 续拉钩子：放 **feature 层**（store 保持同步），即 `usePlaybackUiController.handleRuntimeEnded` 或独立 stream 控制器。

**待确认：**
1. Stream 卡片 `subtitle` 是否可当歌手用（影响 Track 兜底搜索）？需真实账号数据验证。
2. 推荐页打开时是否需要「刷新」入口，还是只依赖登录触发的缓存失效？
3. `stream_next` 是否也在 `DiscoverPort` 上暴露，还是单独建 `RecommendationPort`？
4. gapless 与 stream 共存时，enqueue 时机是否会误触 gapless 预载？（实现时用单测锁定「stream 强制普通 ended」）
