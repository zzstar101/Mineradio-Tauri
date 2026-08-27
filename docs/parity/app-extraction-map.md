# `App.tsx` 提取映射

审计基线：`apps/web/src/app/App.tsx` 4960 行；M1 完成时为 1571 行。当前文件主要保留 typed dependency assembly、controller/runtime 组合与跨 Surface 导航；领域 JSX 固定顺序由 `AppShell.tsx` 持有。`purity` 使用 `pure`、`browser-storage`、`DOM`、`Tauri`、`native-api`、`React-runtime` 六种分类。下表保留已经完成的提取历史；被 Sidecar cutover 删除的符号明确标为 retired。

| symbol | kind | purity | current_side_effects | target_module | evidence | migration_order |
| --- | --- | --- | --- | --- | --- | --- |
| `SHOW_SPLASH` | constant | pure | none | `app/runtime/AppBootstrapRuntime.tsx` | App import-time config | 10 |
| Sidecar status polling constants | retired | pure | none | removed in native API cutover | `m9-api-readiness-boundary.test.ts` | complete |
| `PLAYBACK_QUALITY_STORE_KEY` | constant | pure | none | `app/runtime/useShellPreferences.ts` | playback preference characterization | 4 |
| `LONG_PAUSE_PLAYBACK_URL_REFRESH_MS` | constant | pure | none | `features/playback/playback-session-coordinator.ts` | coordinator refresh tests | 4 |
| `PLAYBACK_URL_MAX_AGE_MS` | constant | pure | none | `features/playback/playback-session-coordinator.ts` | coordinator refresh tests | 4 |
| `HOME_LISTEN_STATS_STORE_KEY` | constant | pure | none | `features/home/listen-history.ts` | home summary tests to add | 7 |
| `USER_CAPSULE_AUTO_HIDE_STORE_KEY` | constant | pure | none | `features/accounts/account-preferences.ts` | App UI tests | 6 |
| `PLAYLIST_PANEL_PIN_STORE_KEY` | constant | pure | none | `features/library/library-preferences.ts` | App UI tests | 7 |
| `DIY_MODE_STORE_KEY` | constant | pure | none | `features/settings/player-preferences.ts` | App UI tests | 9 |
| `DEFAULT_GLOBAL_HOTKEYS` | constant | pure | none | `features/desktop/global-hotkeys.ts` | global hotkey tests | 5 |
| `DESKTOP_RUNTIME_SEARCH_TERMS` | constant | pure | none | `app/App.tsx` | Settings real-control search tests | 10 |
| `AccountVipBadge` | type | pure | none | `features/accounts/AccountSurface.tsx` | App account smoke paths | 6 |
| `accountVipBadge` | function | pure | none | `features/accounts/AccountSurface.tsx` | App account smoke paths | 2 |
| `placeholderRuntimeConfig` | function | pure | none | `app/runtime/runtime-placeholders.ts` | runtime tests | 1 |
| `audioElementSupported` | function | DOM | probes browser Audio | `features/playback/audio-capabilities.ts` | PlayerController tests | 4 |
| `buildTrackLyricFallback` | function | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | runtime fallback/stale lyric tests | 2 |
| `mergeProviderPlaylists` | function | pure | none | `features/library/playlist-merge.ts` | existing App export tests | 2 |
| `shouldUseCachedHomeDiscoverPlaylist` | function | pure | none | `features/home/home-cache-policy.ts` | existing App export tests | 2 |
| `normalizePlaybackQualityPreference` | function | pure | none | `features/playback/playback-preferences.ts` | add preference test | 2 |
| `readPlaybackQualityPreference` | function | browser-storage | reads localStorage | `app/runtime/useShellPreferences.ts` | App initialization tests | 4 |
| `savePlaybackQualityPreference` | function | browser-storage | writes localStorage | `app/runtime/useShellPreferences.ts` | App quality tests | 4 |
| `readBooleanPreference` | function | browser-storage | reads localStorage | `app/runtime/useShellPreferences.ts` | global shell boundary | 2 |
| `saveBooleanPreference` | function | browser-storage | writes localStorage | `app/runtime/useShellPreferences.ts` | global shell boundary | 2 |
| `afterPreferenceCommit` | function | pure | dispatches canonical preference completion/error callbacks | `app/runtime/preference-commit.ts` | App canonical preference commit tests | 2 |
| `clampNumber` | function | pure | none | shared local utility near consumer | App behavior tests | 2 |
| `playbackKeyForTrack` | function | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | playback session tests | 2 |
| `DesktopLyricsPayloadContext` | interface | pure | none | `features/desktop/desktop-lyrics-payload.ts` | desktop snapshot tests | 5 |
| `CurrentBeatMapState` | interface | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | beatmap characterization | 4 |
| `TrialBannerState` | interface | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | App/runtime trial tests | 4 |
| `PlaybackReloadReason` | type | pure | none | `features/playback/playback-session-coordinator.ts` | reload policy tests | 4 |
| `LoadedPlaybackUrlState` | interface | pure | none | `features/playback/playback-session-coordinator.ts` (`LoadedPlaybackSource`) | recovery/refresh tests | 4 |
| `PlaybackReloadOptions` | interface | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | runtime reload tests | 4 |
| `LoginQrState` | interface | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 6 |
| `LoginQrTone` | type | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 6 |
| `LoginQrStatusState` | interface | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 6 |
| `LoginModalMode` | type | pure | none | `features/accounts/useLoginQrRuntime.ts` | account modal + QR runtime tests | 6 |
| `LOGIN_PROVIDERS` | constant | pure | none | `features/accounts/useLoginQrRuntime.ts` (`LOGIN_QR_PROVIDERS`) | provider/QR tests | 2 |
| `INITIAL_NETEASE_QR_STATUS` | constant | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 2 |
| `INITIAL_QQ_QR_STATUS` | constant | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 2 |
| `INITIAL_SODA_QR_STATUS` | constant | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 2 |
| `initialQrStatusForProvider` | function | pure | none | `features/accounts/useLoginQrRuntime.ts` | QR runtime tests | 2 |
| `providerLabelText` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrInstructionForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrScannedTextForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `loginTitleForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `loginDescriptionForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `qrLoadingMarkForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `cookiePlaceholderForProvider` | function | pure | none | `features/accounts/provider-copy.ts` | add provider table test | 2 |
| `HomeListenHistoryRecord` | interface | pure | none | `features/home/listen-history.ts` | listen history tests | 7 |
| `HomeListenSession` | interface | pure | none | `features/home/listen-history.ts` | listen session tests | 7 |
| `DESKTOP_LYRIC_FONT_STACKS` | constant | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop style tests | 2 |
| `normalizeDesktopLyricFontKey` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopLyricFontStackForKey` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopLyricFontWeightValue` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `desktopOverlayColorValue` | function | pure | none | `features/desktop/desktop-lyrics-style.ts` | desktop tests | 2 |
| `trackTitle` | function | pure | none | `features/playback/track-view-model.ts` | add table test | 2 |
| `trackArtist` | function | pure | none | `features/playback/track-view-model.ts` | add table test | 2 |
| `trackLikeKey` | function | pure | none | `features/likes/like-key.ts` | likes tests | 2 |
| `trackProviderLikeId` | function | pure | none | `features/likes/like-key.ts` | likes tests | 2 |
| `updateHomeListenHistory` | function | pure | none | `features/home/listen-history.ts` | listen history tests | 3 |
| `readHomeListenHistory` | function | browser-storage | reads localStorage | `adapters/storage/browser-preferences.ts` | migration tests later | 7 |
| `writeHomeListenHistory` | function | browser-storage | writes localStorage | `adapters/storage/browser-preferences.ts` | migration tests later | 7 |
| `beginHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `updateHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `isEffectiveHomeListenSession` | function | pure | none | `features/home/listen-history.ts` | session tests | 3 |
| `buildHomeListenSummary` | function | pure | none | `features/home/listen-history.ts` | summary tests | 3 |
| `isProviderLikeSupported` | function | pure | none | `features/likes/like-policy.ts` | likes tests | 2 |
| `isNeteaseLikeSupported` | function | pure | none | `features/likes/like-policy.ts` | existing App export tests | 2 |
| `isCollectSupportedTrack` | function | pure | none | `features/library/collect-policy.ts` | existing App export tests | 2 |
| `likeUnsupportedMessage` | function | pure | none | `features/likes/like-policy.ts` | copy tests | 2 |
| `collectUnsupportedMessage` | function | pure | none | `features/library/collect-policy.ts` | copy tests | 2 |
| `isLoginRequiredError` | function | pure | none | `features/accounts/account-error-policy.ts` | ApiError tests | 2 |
| `trialBannerText` | function | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | trial tests | 2 |
| `toJsonValue` | function | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | beatmap characterization | 2 |
| `isPodcastTrack` | function | pure | none | `features/playback/usePlaybackSessionRuntime.ts` | podcast beatmap tests | 2 |
| `beatMapArrayLength` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `beatMapNumber` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `beatMapString` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `desktopLyricsBeatMapKey` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | existing App export tests | 2 |
| `desktopLyricsBeatMapContext` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | beatmap tests | 2 |
| `buildDesktopLyricsPayloadPatch` | function | pure | none | `features/desktop/desktop-lyrics-payload.ts` | existing App export tests | 2 |
| `isHomeBlankDismissElement` | function | DOM | inspects event target | `app/runtime/GlobalShellRuntime.tsx` | existing App export tests | 3 |
| `EmptyHomeStateInput` | interface | pure | none | `features/home/home-surface-policy.ts` | home tests | 3 |
| `shouldShowEmptyHome` | function | pure | none | `features/home/home-surface-policy.ts` | existing App export tests | 3 |
| Sidecar recovery policy functions | retired | pure | none | removed in native API cutover | `ApplicationRuntimeBootstrap` tests | complete |
| `isDesktopWindowFullscreen` | function | pure | none | `features/desktop/window-state.ts` | existing App export tests | 2 |
| `forceBottomControlsVisible` | function | DOM | dispatches pointer/UI state | `app/runtime/GlobalShellRuntime.tsx` | App UI tests | 8 |
| `applyDesktopWindowShellState` | function | DOM | changes document classes | `features/desktop/window-shell.ts` | existing App export tests | 5 |
| `DesktopTitlebar` | component | React-runtime | renders window chrome | `app/AppShell.tsx` | App DOM tests | 8 |
| `shouldUseSecondaryLeftDisplaySeamGuard` | function | pure | none | `features/desktop/window-state.ts` | existing App export tests | 2 |
| `AppProps` | type | pure | none | `app/App.tsx` | test injection contract | 10 |
| `DesktopLyricsRuntime` | type | pure | none | `ports/desktop-runtime-port.ts` | desktop adapter tests | 2 |
| `defaultDesktopLyricsRuntime` | constant | Tauri | binds Tauri wrappers | `adapters/tauri/tauri-desktop-runtime.ts` | runtime tests | 5 |
| `defaultApplicationRuntime` | constant | native-api | assembles compatibility client over Tauri invoke | `app/runtime/default-runtime-dependencies.ts` | native client/bootstrap tests | complete |
| `App` | component | React-runtime | typed dependency assembly、controllers/runtimes 和跨 Surface 导航 | composition-only `app/App.tsx` | App characterization + architecture boundaries | 10 |

## 提取纪律

1. 先移动有现有证据的纯函数，并从旧路径临时 re-export；
2. browser storage、DOM、Tauri 和 native API 符号先建立 Port/Adapter；
3. 每次只移动一个 runtime/effect 所有权；
4. 不创建全能 `useAppController`；
5. `App.tsx` 行数不是单独门禁，依赖方向和 characterization tests 才是门禁。

## M0/M1 已验证提取

| boundary | result | evidence | commit |
| --- | --- | --- | --- |
| Search concrete client dependency | `SearchShell` 仅依赖 `SearchExperiencePort`；其余搜索业务仍保留现状 | `bun test apps/web/src/components/shell/SearchShell.test.ts apps/web/src/components/shell/SearchShell.actions.test.tsx apps/web/src/app/App.test.tsx` | `c5804c9` |
| Application service assembly | `AppServices` 与 `AppRuntimeProvider` 已建立；未迁移领域仍由 legacy adapters 委托 | `bun test apps/web/src/app/AppRuntimeProvider.test.tsx apps/web/src/app/App.test.tsx` | `5105427` |
| Native API bootstrap | `ApplicationRuntimeBootstrap` 一次连接后同步能力、账户与曲库；Sidecar health/recovery polling 已退役 | `bun test apps/web/src/app/runtime apps/web/src/app/App.test.tsx scripts/architecture/m9-api-readiness-boundary.test.ts` | PR #67 cutover |
| PlayerController lifecycle | Audio 控制器创建、媒体事件订阅、音量同步和卸载清理由 `PlaybackRuntimeHost` 持有；播放事务仍保留在 App | `bun test apps/web/src/features/playback/PlaybackRuntimeHost.test.tsx apps/web/src/audio/player-controller.test.ts apps/web/src/app/App.test.tsx`；`bun test scripts/architecture/playback-runtime-boundary.test.ts` | `e375762`、`c320ae2`、`b394e60` |
| Playback Port session boundary | 首次播放、URL 恢复、音质、歌词和 podcast beatmap 已通过 `AppServices` Ports；事务时序仍保留在 App | `bun test apps/web/src/features/playback apps/web/src/adapters/sidecar/legacy-media-url.test.ts apps/web/src/app/App.test.tsx`；`bun test scripts/architecture/playback-port-boundary.test.ts` | `6df23f7`、`6c60a6b`、`610b0de` |
| Current-track playback session | 请求 token、当前媒体源、长暂停/URL 年龄刷新、单次媒体恢复、local/remote 装载、歌词 fallback/stale guard、试听提示和 beatmap 协调由 `PlaybackSessionCoordinator` 与 `usePlaybackSessionRuntime` 持有 | `bun test apps/web/src/features/playback apps/web/src/app/App.test.tsx`；`bun test scripts/architecture/playback-session-boundary.test.ts` | `a2c34aa`、`c3818cf`、`e7a839b` |
| Account QR login runtime | 三平台二维码生成 token、立即检查、1800ms polling、in-flight lease、兼容结果分类、成功同步和 timer cleanup 由 `LoginQrCoordinator` 与 `useLoginQrRuntime` 持有；Cookie、logout、账户下拉和 modal UI 仍在 App | `bun test apps/web/src/features/accounts apps/web/src/app/App.test.tsx scripts/architecture/account-qr-runtime-boundary.test.ts` | `eab8422`、`0d4a0b4`、`946f714` |
| Account session controller | 三平台登录状态 map、状态刷新、Cookie 会话写入和 logout 由 `useAccountSessionController` 持有，并通过 `AccountPort` 与 QR/bootstrap 汇合；textarea、modal 和账户下拉仍在 App | `bun test apps/web/src/features/accounts apps/web/src/app/App.test.tsx scripts/architecture/account-session-boundary.test.ts` | `398432d`、`e5a2522`、`3ec372a` |
| Desktop runtime | 桌面歌词窗口、payload gate、窗口状态监听、全局快捷键和 cleanup 由 `useDesktopRuntime` 持有 | `bun test apps/web/src/features/desktop apps/web/src/app/App.test.tsx scripts/architecture/desktop-runtime-boundary.test.ts` | `025bbda` |
| Updater controller | 启动检查、交互刷新、开发预览、错误映射和安装动作由 `useUpdaterController` 持有 | `bun test apps/web/src/features/updater apps/web/src/app/App.test.tsx scripts/architecture/updater-controller-boundary.test.ts` | `4be9837` |
| Likes controller | like 查询、optimistic mutation、rollback 和登录引导由 `useLikesController` 持有 | `bun test apps/web/src/features/likes apps/web/src/app/App.test.tsx scripts/architecture/likes-controller-boundary.test.ts` | `381bc51` |
| Library controller | Provider 局部刷新、导入歌单、播客集合、详情、collect picker 和播放动作由 `useLibraryController` 持有 | `bun test apps/web/src/features/library apps/web/src/app/App.test.tsx scripts/architecture/library-controller-boundary.test.ts` | `08f8ce4` |
| Home controller | discover/weather stale guard、详情、收听会话和 Home actions 由 `useHomeController` 持有 | `bun test apps/web/src/features/home apps/web/src/app/App.test.tsx scripts/architecture/home-controller-boundary.test.ts` | `d60de7b` |
| Playback UI/customization | 本地文件 URL、媒体 UI 事件、队列动作、自定义歌词和封面由 Playback/Customization controllers 持有 | `bun test apps/web/src/features/playback apps/web/src/app/App.test.tsx scripts/architecture/playback-ui-boundary.test.ts` | `fe5b448` |
| Global shell/preferences | document/body classes、全局 listener、toast、AI chip、空白 Home dismiss 和浏览器偏好持久化迁入 shell runtime/preferences | `bun test apps/web/src/app/App.test.tsx scripts/architecture/global-shell-boundary.test.ts` | `e252ee7` |
| Feature surfaces/AppShell | Account、Home/Search、Library、Playback、Visual JSX 和 modal/overlay 顺序迁入 Surface；默认具体依赖迁出 App | `bun test apps/web/src/app/App.test.tsx scripts/architecture/app-composition-boundary.test.ts` | `989dd53` |

## M2 Playback 2.0（Code Complete / Automated Verification Complete）

| boundary | result | evidence | commit |
| --- | --- | --- | --- |
| Explicit session/load authority | `PlaybackPhase`、`playbackSessionId`、`loadRequestId` 与 recovery state 由 reducer/coordinator 显式持有；单调 `playbackIntentId` 使同曲重播创建新 session，旧 URL/歌词/load 结果与非原始 handle 被拒绝 | `playback-state-machine.test.ts`、`playback-session-coordinator.test.ts`、`usePlaybackSessionRuntime.test.tsx`、`playback-store.test.ts` | `bbfa5a7` 至 `da01812` |
| Source-bound media lifecycle | `PlayerController` 以 `currentSrc` 优先、`src` fallback 归一化 source，并仅为匹配 source 暴露精确 load handle；`timeupdate`、`durationchange`、`ended` 经 authority guard，重复 ended 只接受一次，single ended 只触发一次 replacement load/play | `player-controller.test.ts`、`usePlaybackSessionRuntime.test.tsx`、`App.test.tsx` | `2f02465`、`1b78ad3`、`8dd2262`、`da01812` |
| Preserved current policies | 保留远程非试听 source 的单次媒体恢复、long-pause/URL-age 刷新、trial/local 分支和 quality reload；quality reload 复用 session、更新 load token，并只在当前成功 load 后恢复 recovery budget | `playback-session-coordinator.test.ts`、`usePlaybackSessionRuntime.test.tsx` | `887b0cf`、`5090e7f`、`0083c20` |
| Physical Audio owner | `PlaybackAudioRuntime` 独占两个 lifetime deck、pending/committed/retiring owner、Audio Graph、fade、probe 与输出路由；exact issued handle 和 exact source `ownerchange` 才能提交 application load，`stop()`/dispose 释放 physical owner 和资源 | `playback-audio-runtime.test.ts`、`player-controller.test.ts`、`PlaybackRuntimeHost.test.tsx`、`usePlaybackSessionRuntime.test.tsx` | 本 M2 收口提交 |
| Album handoff | 同 Provider/专辑/封面且严格相邻的候选共用 8.5s preload、1.05s muted preroll 与 360–720ms equal-power handoff；采用、advance 和 store commit exact-once，失败、stale、新 intent 与 store rejection 可回滚 | `playback-handoff-policy.test.ts`、`gapless-playback-controller.test.ts`、`playback-audio-runtime.test.ts`、`usePlaybackSessionRuntime.test.tsx` | 本 M2 收口提交 |
| Read-only Visual audio seam | Visual 只消费 `AudioFrameSource` 与数值播放状态，不创建/持有 Controller、`HTMLAudioElement`、`AudioContext`、MediaElementSource 或 sink mutation | Visual runtime/host suites、`playback-audio-owner-boundary.test.ts` | 本 M2 收口提交 |
| Typed output routing | fade/gapless/crossfade、primary、最多四个 mirrors 与 Virtual Output Bridge 进入 `playback.audio.v2`；bridge 归一为 primary，消失设备保留 unavailable 状态，关闭路由恢复系统默认 sink | preference suites、`PlaybackAudioSettings.test.tsx`、`usePlaybackAudioSettings.test.tsx`、runtime routing/devicechange suites | 本 M2 收口提交 |
| Bounded recovery and diagnostics | 9s play deadline、一次 ready retry、1600/3600ms stall、Graph/audibility 有界恢复与稳定错误码；diagnostics 深冻结、可序列化、脱敏，资源与 timer 有硬上限 | `playback-audio-runtime.test.ts`、`m2-playback-budget.test.ts` | 本 M2 收口提交 |

M2 代码和自动验证已经完成：播放域聚焦测试 `232 passed`，完整 Bun `2370 passed`，Rust `299 passed`，typecheck、Web build、performance budget、fmt、clippy、freeze audit 与 `git diff --check` 均通过。真实 WebView2 连播/听感、设备权限与拔插、四路 mirror/Virtual Bridge、前后台/睡眠及 30–60 分钟 Windows soak 保持 `Field Validation Pending (non-blocking)`；这些项目只阻止 `Field Validated / Release Verified`。

当前生产 Provider 路径是兼容命名 Adapter → Tauri `api_call` → Rust `api_bridge` → in-process `MineRadio-api`。localhost、Sidecar supervisor 与 `externalBin` 已移除；兼容名称将在 2.1.0 收敛后再评估是否重命名。
