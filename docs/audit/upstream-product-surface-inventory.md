# Mineradio v2.1.0 上游产品 Surface 清单

## 审计基准与取证方式

- 唯一产品基准：`XxHuberrr/Mineradio@v2.1.0`，peeled commit `96091d123b36783f5604d1acd47b00b0708cabbd`，tree `b1b9f80a72d96afcbc8b4685256c3adba9014551`。
- 本清单按用户体验组织，不按源码目录组织。Surface ID 是本轮所有专项报告与总表的稳定关联键。
- 静态源码由该 commit 的只读 archive 取证；运行态参考由 archive 的 `public/` 静态页面在 Edge 中渲染获得。静态页面缺少 Electron IPC 和真实 provider，因而截图只证明 DOM、布局与可达交互，不证明真实数据行为。
- 运行态参考：`.playwright-cli/upstream-home-player.png`、`.playwright-cli/upstream-visual-console-open.png`。当前对照：`.playwright-cli/current-home.png`、`.playwright-cli/current-visual-console.png`。

缩写：`IDX`=`public/index.html`；`PB`=`public/js/modules/05-playback/`；`LY`=`public/js/modules/06-lyrics/`；`FX`=`public/js/modules/07-fx/`；`AC`=`public/js/modules/08-account/`；`SH`=`public/js/modules/10-shell/`。

## Application Shell

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S001 | 启动 Splash | `IDX:68-88`, startup modules | 全屏 Mine/radio 标识、彩带与进入提示 | 单次点击进入；退场后释放遮罩 | 启动 readiness、用户手势 |
| S002 | Titlebar / window chrome | `IDX:17-64`, `desktop/main.js` | 顶部透明拖拽区、DIY 与原生窗口按钮 | 最小化、最大化、关闭、全屏状态同步 | Electron window state |
| S003 | DIY 玩家模式入口 | `IDX:38-63`, `SH/04-desktop-overlay-fullscreen.js` | titlebar 与全屏边缘均有 DIY 入口 | 切换控制面板、导入入口和额外控制；显示短 toast | `mineradio-diy-mode` preference |
| S004 | Home 主壳 | `IDX:89-327`, `PB/03a-home-dashboard.js` | Hero、四个主入口、今日聆听、Next Up、For You、Discover | 卡片 hover、点击进入对应 surface、空态清晰 | listen stats、queue、recommendation |
| S005 | 顶部搜索壳 | `IDX:89-132`, `PB/07-search.js` | 顶部居中搜索框，结果 surface 覆盖首页 | 输入、清空、键盘、provider 切换 | provider search APIs |
| S006 | 账号胶囊 | `IDX:133-178`, `AC/*` | 左侧贴边、头像/VIP/登录态 | 自动隐藏、打开账号页、登录/退出 | login status、avatar、VIP |
| S007 | 歌单/队列侧面板 | `IDX:1024-1253`, `LY/01-*`, `PB/10-queue-actions.js` | 右侧抽屉、队列/歌单/播客 tabs | pin、随机、切换、清空、拖动排序 | queue、playlist、podcast |
| S008 | Bottom handle | `IDX:1255-1256`, shell CSS | 底部居中窄把手 | 展开/收起控制条，状态与 hover 同步 | shell visibility state |
| S009 | Bottom bar 总体 | `IDX:1257-1409`, playback CSS | 三段式固定底栏；上方 mini queue/progress；metadata/transport/utilities 对齐 | collapsed/expanded、hover、auto-hide、fullscreen | playback store、track、lyrics |
| S010 | Mini queue | `IDX:1257-1270`, `PB/10-queue-actions.js` | progress 之前的浮层，标题、数量、显式关闭键 | 打开、关闭、选曲、拖排、删除 | queue snapshot |
| S011 | Track metadata | `IDX:1274-1305` | 可点击封面、标题、歌手、badge 与内嵌 quality | 打开专辑/歌曲/歌手详情；喜欢、收藏 | Track、entitlement、quality |
| S012 | Overlay/modal 层 | `IDX` 中 account/detail/login/update overlays | 模态层级稳定、背景遮罩一致 | Escape、点击外部、焦点回收 | surface-specific state |
| S013 | Context menus | `IDX` 与 playback/library modules | 靠近触发点，不越界 | 右键/更多菜单、键盘关闭 | track/playlist actions |
| S014 | Toast / banner | `IDX`, `SH/*` | 非阻塞短消息；试听与自动换源有专用条 | 自动消失或显式关闭 | error/preview/recovery state |
| S015 | 响应式与显隐规则 | global CSS, shell modules | 小窗保持关键控制不重叠 | mouse idle、fullscreen、DIY、panel pin 联动 | viewport、cursor activity |

## Playback

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S016 | 播放/暂停 | `IDX:1321-1334`, `PB/13-playback-start-audio.js` | 中央主按钮 | user gesture 启动；图标/状态即时切换 | active audio owner |
| S017 | 上一首/下一首 | `IDX:1321-1339`, queue modules | 主按钮两侧 | mode-aware 切换；stale intent 不提交 | queue、mode |
| S018 | Progress / seek | `IDX:1400-1408`, playback modules | 底栏顶边细进度与时间 | pointer/keyboard seek、buffer/loading 状态 | media clock、duration |
| S019 | Volume / fade | `IDX:1360-1388`, audio graph modules | 音量 popover 内含 volume、淡入、淡出 | mute、slider、持久化、渐变 | gain、fade prefs |
| S020 | Quality selector | `IDX:1280-1294`, `PB/00-api-quality-output.js` | quality chip 位于标题 metadata 内 | 根据 entitlement disable/切换并重载 URL | quality availability、VIP |
| S021 | Playback mode | `IDX:1306-1312`, queue modules | transport 左侧 mode icon | loop/single/shuffle 循环与 tooltip | playback mode |
| S022 | Preview 提示 | `IDX` preview banner, `PB/*` | 明确试听范围与关闭入口 | 到达边界停止/切换，不伪装完整播放 | `previewRange`、measured duration |
| S023 | Loading 状态 | playback modules | 不破坏当前 owner 的局部 loading | supersede 与 generation 防旧请求覆盖 | song URL request |
| S024 | Playback error / fallback | `PB/11-provider-fallback.js` | 可理解错误与自动换源提示 | 有界重试、换源、保留 outgoing | provider error contract |
| S025 | End-of-track | `PB/09-*` 至 `13-*` | 无额外布局跳动 | 根据 mode/queue 前进或 Stream Next | ended event、queue |
| S026 | Gapless / crossfade | `PB/12-*`, `13-*` | 视觉控制不跳变 | 同专辑预热、双 deck 交接、失败回滚 | media URL、album identity |
| S027 | Stream continuation | playback stream modules | 队列尾部透明续拉 | 仅 stream tail 触发并防重复 | provider stream-next |
| S028 | Startup resume | `SH/05-startup-bindings.js` | 恢复 metadata/queue/progress | autoplay preference 决定是否播放 | last-playback snapshot |
| S029 | Output routing | `PB/00-*`, `08-*` | 音频设置中的设备选择 | default/mirror/virtual bridge 与恢复 | sink devices、Audio graph |
| S030 | Cuefield AutoMix | `IDX:1313-1320`, `PB/16-*` 至 `18-*`, `cuefield/**` | transport 内独立实验按钮与反馈面板 | enable/disable、plan、handoff、local feedback | beatmap、lyrics、queue、feedback |

## Stage Lyrics

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S031 | 舞台歌词布局 | `public/js/modules/02-visual/10-*` 至 `14-*` | 当前行居中、上下文行有稳定纵深 | 行切换保持空间连续 | LyricPayload、viewport |
| S032 | 字体与排版 | same + `IDX` lyric controls | 主/译文层级、字号、字重、换行一致 | font preset 实时生效 | font prefs、text metrics |
| S033 | 行切换视觉 | stage rendering modules | outgoing 与 incoming 原子接管，无闪空 | timing/easing 与播放时钟同步 | current lyric index |
| S034 | 翻译显示 | lyric parse/render modules | off/current/dual 等 upstream 模式 | 切换不重建无关场景 | translation lines |
| S035 | 逐字 Karaoke | lyric parser + mask textures | word progress mask 连续 | 逐字时间推进，不按 React frame 重排 | words/c0/c1/duration |
| S036 | 粒子与 glow | visual lyric modules | 有界 glow、spark 与 readability 层 | 随强度/行状态平滑变化 | visual prefs、audio frame |
| S037 | Camera / positioning | stage camera modules | stage/shelf mode、camera/presence/content 可调 | camera control 与自由镜头不冲突 | camera prefs |
| S038 | 歌词颜色 | `IDX` Visual Console lyrics sections | 主色、译文、glow 等色彩控件 | picker/重置/预设联动 | lyric color prefs |
| S039 | Cover interaction | stage + cover visual modules | cover/纹理与歌词舞台一致加载 | 换曲时旧纹理保留至新纹理 ready | Track.coverUrl、media URL |
| S040 | 空/回退歌词 | lyric parse/fallback modules | 无歌词时展示曲名/歌手而非空舞台 | stale request 不覆盖当前曲目 | Track、LyricPayload |
| S041 | 动画 timing | stage rendering modules | floating/smooth/glass/glitch 节奏一致 | 参数可切换且切换原子 | motion prefs、clock |
| S042 | 单曲歌词时差 | `IDX:1344-1358` | 底栏 popover 显示 ±0.1s 与 reset | 按歌曲保存/恢复 | track identity、offset pref |
| S043 | Transition 性能 | stage rendering/build modules | 切行无可感 hitch | raster/build/upload/disposal 分帧且可测 | CPU/GPU timing、cache |

## Visual System

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S044 | 默认视觉 | `public/js/modules/02-visual/**` | 默认封面粒子/舞台与上游一致 | 启动、换曲、空态稳定 | cover、audio frame |
| S045 | 视觉预设 | `IDX:354+`, `FX/00-preset-archive-data.js` | 9 个上游预设及其名称/缩略表达 | 单击原子应用整套参数 | FxState、visual prefs |
| S046 | Visual Console 外壳 | `IDX:329-354` | 右侧连续面板、标题 `视觉控制台`、自动隐藏 | FAB 打开、移开隐藏、DIY 联动 | panel state |
| S047 | Console 信息架构 | `IDX:342-1023`, `FX/**` | 上游连续 sections/折叠区，不是替代性 settings app | 搜索定位、section 展开、原顺序滚动 | settings catalog |
| S048 | Master / FX controls | `IDX` preset/master/FX sections | slider、toggle、canvas monitor 与参数同位 | input 即时更新，reset 有界 | FxState、audio metrics |
| S049 | 用户视觉存档 | `FX/00-preset-archive-data.js` | 多槽、名称、保存/应用、JSON/短码导入导出 | versioned persistence、校验、分享 | archive repository |
| S050 | Accent / tint / color lab | `IDX` accent/tint/color sections | 色板、picker、lab popover、home/icon accents | swatch 与 picker 同步 | color prefs、cover palette |
| S051 | Background media/color | `IDX` background sections | 背景色、图片/视频、清除与状态 | 导入、预览、撤销/恢复 | local media、Blob lifecycle |
| S052 | Cover picker / clarity | `IDX` cover sections | cover source/picker 与 clarity 控制 | custom cover、reset、track cover fallback | cover media URI |
| S053 | Lyric visual controls | `IDX` lyric sections | display/translation/motion/glitch/font/color 完整分组 | upstream option sets 与联动 | lyric prefs |
| S054 | Sonic Topography | `public/sonic-topography-preset.js`, beat modules | 地形、频谱 canvas、颜色/浮动控制 | preset、audio monitor、参数实时响应 | audio bins、licensed assets |
| S055 | Sonic Workshop | `public/sonic-workshop-preset.js`, vendor runtime | Workshop 场景、主题与媒体卡 | 冷加载、主题切换、disable 归零 | audio frame、cover |
| S056 | 3D Shelf | `public/js/modules/04-shelf/**` | 卡片、rows、detail panel、depth | 选择、滚动、camera mode、虚拟化 | library/queue tracks |
| S057 | 摄像头手势 | `IDX:928-933`, camera visual modules | 手势状态 HUD | permission、启停、掌推/捏合/握拳 | camera/model lifecycle |
| S058 | Wallpaper controls/library | `IDX:1657-1697`, `desktop/wallpaper-engine-library.js` | 搜索、grid、详情、星标、隐藏/恢复 | 导入 root、选择、预览、动作 | Wallpaper Engine library |
| S059 | Visual performance controls | `IDX` performance sections | background FPS、desktop lyrics FPS、quality controls | 选择档位并持久化 | frame scheduler、prefs |
| S060 | Hotkeys editor | `FX/06-hotkeys.js` | local/global 快捷键表、录入、冲突、重置 | capture、validate、persist、register | hotkey runtime |

## Library

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S061 | 本地音乐库 | `desktop/local-music-library.js`, library modules | 本地曲目与 provider 曲目一致可浏览 | 播放、删除、封面/歌词懒加载 | persistent local index |
| S062 | 导入入口 | `LY/05-upload-dragdrop.js` | 文件、目录、全局 drop、DIY 导入 | 多文件隔离错误、封面关联 | filesystem metadata |
| S063 | 启动水合 | local library + startup modules | 不阻塞首屏，恢复后列表稳定 | 损坏索引降级、跨重启一致 | disk index |
| S064 | Provider 歌单列表 | playlist shell modules | provider 分组与 counts/covers | 登录态刷新、打开 detail | playlist list API |
| S065 | 歌单详情 | `LY/02-playlist-detail.js` | header cover、metadata、虚拟化 tracks | pagination、播放、收藏、返回 | PlaylistDetail |
| S066 | 歌单/队列拖排 | queue/library modules | 清晰 drag affordance 与占位 | pointer/keyboard reorder、持久化或 provider mutation | queue/playlist authority |
| S067 | Favorites / liked songs | account/library modules | 收藏状态与 provider 归属可见 | like/check、失败回滚 | capability、like API |
| S068 | Album surfaces | search/detail modules, `server.js` album routes | album summary/detail、cover、artists、tracks | 从 metadata/search 打开并播放 | AlbumSummary/AlbumDetail |

## Search

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S069 | Search 主 surface | `PB/07-search.js` | overlay/result area 与上游密度一致 | debounce、cancel、close/back | search query |
| S070 | Provider switching | same | All、网易云、QQ、汽水、酷狗、Spotify/播客按上游能力呈现 | tab 切换保留每源状态 | capability、provider order |
| S071 | 独立分页 | `07-search.js:754,792-793,1086-1111` | 每 provider load-more/offset 状态 | 各源独立续页，不截断 All | provider offsets |
| S072 | 结果 rows/cards | search CSS/modules | cover、title、artist、album、quality/badge | hover/focus/keyboard 选择 | Track |
| S073 | Artist/song/album detail | detail modules | 详情 surface 有返回路径 | 从结果/底栏打开 | detail APIs |
| S074 | Inline actions | search modules | play、next、like、collect 与 capability 对齐 | optimistic state + rollback | provider capabilities |
| S075 | 空/loading/error | search modules | 各 provider 独立状态，不以全局空态覆盖 | retry、switch provider | request generations |

## Providers / Accounts

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S076 | QQ provider | `server.js`, `qq-vip-api.js`, `AC/*` | 搜索/歌单/登录/VIP/quality/cover 完整 | QR variants、like、playback | QQ auth/provider data |
| S077 | Netease provider | `server.js`, `AC/*` | 同上游账号与推荐入口 | QR/cookie、VIP、like、playback | Netease auth/provider data |
| S078 | Soda/Qishui provider | `qishui-*.js`, `AC/*` | 汽水身份、封面与 tier 状态 | QR、search、playback | Soda auth/provider data |
| S079 | Kugou provider | `kugou-api.js`, `server.js` | 酷狗 tab、QR、歌单/搜索 | 登录后请求与 logout | Kugou auth/provider data |
| S080 | Spotify provider | `spotify-api.js`, `IDX` provider entries | 一等 provider surface | OAuth/login、search/playback | Spotify API/auth |
| S081 | 登录 modal shell | `IDX`, `AC/01-*` 至 `04-*` | provider tabs、QR/cookie 状态和说明 | polling、确认、过期、关闭清理 | QR session |
| S082 | QR lifecycle | account modules | loading/scanned/confirmed/expired 明确 | 单 poller、取消、二次确认 | QR endpoints |
| S083 | Avatar / VIP / account state | account modules | avatar、nickname、VIP icon/label | refresh、错误保留已知 profile | LoginStatus |
| S084 | Provider order / logout | account modules | 可见顺序跨 account 和 login surface 一致 | drag/keyboard reorder、logout 清理 | preference、logout API |

## Recommendation / Home

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S085 | Home dashboard composition | `IDX:179-327`, `PB/03a-home-dashboard.js` | 上游四入口 + 双栏 dashboard 组合 | 导航与空态不漂移 | stats/queue/library |
| S086 | Recommendation cards | home/recommendation modules | cover、title、subtitle、kind 表达 | hover、play/open/refresh | RecommendationCard |
| S087 | Recommendation modules/layout | same | track/mixed/playlist 模块按上游排序 | module 级 loading/empty | RecommendationPage |
| S088 | Home hover/click | home modules | focus/hover 与 pointer hit area 一致 | cards 指向正确目标 | card kind/id |
| S089 | Cover rendering / refresh | home modules | refresh 后 cover 不闪坏图 | stale response 防护、局部 retry | recommendation covers |

## Desktop / Tauri 对应 Surface

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S090 | Tray / close behavior | `desktop/main.js` | tray menu 与窗口状态一致 | close-to-tray/exit、reopen、exact cleanup | lifecycle preference |
| S091 | Desktop lyrics | desktop main/overlay files | 锁定、穿透、拖动、字体/色彩 | 多屏/DPI、播放时钟同步 | lyric snapshot |
| S092 | Window behavior | `desktop/main.js` | bounds、fullscreen、always-on-top 正确 | restore、Explorer/monitor changes | native window state |
| S093 | Startup restore | startup/desktop modules | 首帧恢复不闪错曲 | quit→relaunch、autoplay gate | persisted checkpoint |
| S094 | Updater | desktop updater modules | 检查、下载、重启提示 | signed update、失败恢复 | release manifest/signature |
| S095 | Installer / N-1 upgrade | release/build config | 安装、覆盖升级、启动入口 | N-1→N 保留用户数据 | signed artifacts |
| S096 | Local file/media protocol | `desktop/local-music-library.js` | local audio/cover/lyrics 与远端一致 | Range、token、CSP、错误隔离 | registered local media |
| S097 | Wallpaper Engine runtime | `desktop/wallpaper-engine-runtime.js` | scene/static fallback 与 shell 融合 | attach/dispose/mute/recovery | WE process/library |
| S098 | WGC glass sampler | upstream Windows runtime | 真实采样供 glass/background | capture lifecycle、fallback 明确 | Windows Graphics Capture |

## Production-only Risk Surfaces

这些 surface 不属于上游产品目标，但在当前产品运行时可见或可达，因此必须进入 parity 总数。

| ID | Surface | Upstream source | 预期布局/视觉 | 预期交互与动画 | 数据依赖 |
| --- | --- | --- | --- | --- | --- |
| S099 | Visual audio debug overlay | 上游不存在 | production 不应创建或暴露 | 仅隔离开发构建允许 | analyser/debug samples |
| S100 | M4 parity fixture root | 上游不存在 | production URL 不应切入测试应用 | 仅测试 bundle/route 允许 | synthetic fixtures |
| S101 | Raw desktop diagnostics panel | 上游没有普通用户常驻内部计数面板 | 若作为产品诊断必须显式 opt-in 且默认零开销 | 用户明确开启后才 probe/render | diagnostics probes |

## 清单边界

本清单共 **101** 个用户可见或 production 可达 surface。它不把内部 class/module 数量当产品 surface，也不把当前代码中新增的每个设置项拆成独立产品能力。反之，只要 upstream 用户能直接看见、点击、依赖或感知其性能，便保留为独立条目。真实 provider、Windows、签名安装和歌词 transition 数值无法由静态浏览器替代，后续矩阵明确标为 `UNVERIFIED`，不借用旧文档的 `complete`。
