import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { EmptyHomeHost, buildHomeWaveFrame } from "./EmptyHomeHost";

test("EmptyHomeHost renders the Home 2.0 dashboard structure", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost));
	expect(html).toContain('id="empty-home"');
	expect(html).toContain('class="home-hero-inner daily-review-card"');
	expect(html).toContain("换一条");
	expect(html).toContain("选择 MP4");
	expect(html).toContain("展开播放器控制台");
	expect(html).toContain('class="home-right-pane"');
	expect(html).toContain('class="home-insight-dock"');
	expect(html).toContain('class="home-grid"');
	expect(html).toContain("本地音乐");
	expect(html).toContain("每日推荐");
	expect(html).toContain("Recent");
	expect(html).toContain("Continue");
	expect(html).toContain("Next Up");
	expect(html).toContain("For You");
	expect(html).toContain('class="home-rail-sections"');
	expect(html).not.toContain('id="home-weather-kicker"');
	expect(html).not.toContain("Mineradio · Your Library");
	expect(html).not.toContain('class="home-quick-row"');
	expect(html).not.toContain('class="home-visual generated"');
	expect(html).not.toContain('id="home-mosaic"');
	expect(html).not.toContain('class="home-tile-action"');
});

test("EmptyHomeHost keeps the Home 2.0 review and MP4 hero after logged-in data arrives", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [],
			playlists: [],
			podcasts: [],
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain("换一条");
	expect(html).toContain("选择 MP4");
	expect(html).not.toContain("🚧此处施工，敬请期待🚧");
});

test("EmptyHomeHost marks baseline Home loading placeholders with skeleton shimmer", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, { loading: true }));

	expect(html).toContain("home-tile home-skeleton");
});

test("buildHomeWaveFrame follows baseline 24 bar smoothed audio fallback", () => {
	let frame = buildHomeWaveFrame({ timeMs: 0, isPlaying: false });
	for (let tick = 1; tick <= 8; tick += 1) {
		frame = buildHomeWaveFrame({
			timeMs: tick * 80,
			isPlaying: true,
			positionMs: 4800 + tick * 80,
			durationMs: 180000,
		}, frame.smooth);
	}
	const heights = frame.bars.map((bar) => bar.height);

	expect(frame.bars.length).toBe(24);
	expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.1);
	expect(frame.bars.every((bar) => bar.height >= 4 && bar.opacity >= 0.32 && bar.opacity <= 1)).toBe(true);
});

test("EmptyHomeHost routes the baseline construction console chip", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		onOpenConsole={() => calls.push("console")}
	/>));

	(host.querySelector('[data-home-chip="console"]') as HTMLButtonElement).click();

	expect(calls).toEqual(["console"]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost renders baseline recent and profile summary into cards and rail", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [],
			playlists: [],
			podcasts: [],
			updatedAt: 1782656256000,
		},
		listenSummary: {
			recent: {
				plays: 2,
				track: { provider: "netease", id: "recent-1", sourceId: "recent-1", title: "最近一首", artists: ["Alice"], album: "", coverUrl: "https://img.example/recent.jpg", qualityHints: [], playableState: "playable" },
			},
			topArtist: { name: "Alice", plays: 3, coverUrl: "https://img.example/artist.jpg" },
			topSong: {
				plays: 2,
				track: { provider: "netease", id: "top-1", sourceId: "top-1", title: "最常听", artists: ["Alice"], album: "", coverUrl: "https://img.example/top.jpg", qualityHints: [], playableState: "playable" },
			},
			totalPlays: 5,
		},
	}));

	expect(html).toContain('id="home-continue-title">最近一首');
	expect(html).toContain('id="home-profile-title">Alice');
	expect(html).toContain("常听歌手 · 3 次");
	expect(html).toContain("最近一首");
	expect(html).toContain("https://img.example/recent.jpg");
});

test("EmptyHomeHost routes baseline recent and profile cards", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		onPlayRecent={() => calls.push("recent")}
		onOpenInsight={() => calls.push("profile")}
		listenSummary={{
			recent: {
				plays: 1,
				track: { provider: "netease", id: "recent-1", sourceId: "recent-1", title: "最近一首", artists: ["Alice"], album: "", coverUrl: "", qualityHints: [], playableState: "playable" },
			},
			topArtist: { name: "Alice", plays: 1 },
			totalPlays: 1,
		}}
	/>));
	(host.querySelector('[data-home-card="continue"]') as HTMLButtonElement).click();
	(host.querySelector('[data-home-card="profile"]') as HTMLButtonElement).click();

	expect(calls).toEqual(["recent", "profile"]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost renders baseline logged-out starter tiles", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: false,
			user: null,
			dailySongs: [],
			playlists: [],
			podcasts: [],
			mode: "starter",
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain("登录同步歌单");
	expect(html).toContain("搜索一首歌");
	expect(html).toContain("导入本地音乐");
	expect(html).toContain("搜索播客");
	expect(html).toContain("看看视觉舞台");
});

test("EmptyHomeHost puts logged-out public recommendation playlists before starter actions", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: false,
			user: null,
			dailySongs: [],
			playlists: [
				{ provider: "netease", id: "pub-1", name: "公开推荐一", coverUrl: "https://img.example/pub1.jpg", trackCount: 30, trackIds: [], subscribed: false },
				{ provider: "netease", id: "pub-2", name: "公开推荐二", coverUrl: "https://img.example/pub2.jpg", trackCount: 18, trackIds: [], subscribed: false },
			],
			podcasts: [],
			mode: "starter",
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain('id="home-rail-title">推荐歌单与开始探索');
	expect(html.indexOf("公开推荐一")).toBeGreaterThan(-1);
	expect(html.indexOf("登录同步歌单")).toBeGreaterThan(-1);
	expect(html.indexOf("公开推荐一")).toBeLessThan(html.indexOf("登录同步歌单"));
});

test("EmptyHomeHost prefers baseline weather radio songs in the rail when discover is logged out", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: false,
			user: null,
			dailySongs: [],
			playlists: [],
			podcasts: [],
			mode: "starter",
			updatedAt: 1782656256000,
		},
		weatherRadio: {
			ok: true,
			weather: {
				provider: "open-meteo",
				location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
				label: "雨",
				weatherCode: 61,
				temperature: 22,
				apparentTemperature: 21,
				humidity: 88,
				precipitation: 1,
				cloudCover: 90,
				windSpeed: 6,
				windGusts: 10,
				isDay: 1,
				time: "",
				updatedAt: 1,
				error: "",
				mood: { key: "rain", title: "雨天电台", tagline: "留一点潮湿的空间给旋律", energy: 0.38, warmth: 0.42, focus: 0.64, melancholy: 0.66, keywords: ["雨天 R&B"] },
			},
			radio: {
				title: "雨天电台",
				subtitle: "留一点潮湿的空间给旋律",
				seedQueries: ["雨天 R&B"],
				updatedAt: 1,
				songs: [
					{ provider: "netease", id: "weather-1", sourceId: "weather-1", title: "Rain One", artists: ["Alice"], album: "", coverUrl: "https://img.example/rain.jpg", qualityHints: [], playableState: "playable" },
				],
			},
		},
	}));

	expect(html).toContain("Rain One");
	expect(html).toContain("Alice");
	expect(html).toContain("按供应商分组 · 点击即可播放");
	expect(html).not.toContain("登录同步歌单");
});

test("EmptyHomeHost renders discover songs, playlists, and podcasts into baseline cards and rail", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [
				{ provider: "netease", id: "1", sourceId: "1", title: "第一首", artists: ["A"], album: "", coverUrl: "https://img.example/a.jpg", qualityHints: [], playableState: "playable" },
				{ provider: "netease", id: "2", sourceId: "2", title: "第二首", artists: ["B"], album: "", coverUrl: "https://img.example/b.jpg", qualityHints: [], playableState: "playable" },
				{ provider: "netease", id: "3", sourceId: "3", title: "第三首", artists: ["C"], album: "", coverUrl: "", qualityHints: [], playableState: "playable" },
			],
			playlists: [{ provider: "netease", id: "p1", name: "我的歌单", coverUrl: "https://img.example/p.jpg", trackCount: 8, trackIds: [], subscribed: false }],
			podcasts: [{ id: "r1", rid: "r1", name: "热门播客", coverUrl: "", description: "", djName: "DJ", category: "音乐", programCount: 5, subCount: 0 }],
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain("第一首");
	expect(html).toContain("第二首");
	expect(html).toContain("第三首");
	expect(html).toContain("我的歌单");
	expect(html).toContain("热门播客");
	expect(html).toContain("按供应商分组 · 点击即可播放");
});

test("EmptyHomeHost renders more than five playlist rail tiles without dropping later playlists", () => {
	const playlists = Array.from({ length: 8 }, (_, index) => ({
		provider: index % 2 ? "qq" as const : "netease" as const,
		id: `p${index + 1}`,
		name: `探索歌单 ${index + 1}`,
		coverUrl: `https://img.example/p${index + 1}.jpg`,
		trackCount: 10 + index,
		trackIds: [],
		subscribed: false,
	}));
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [],
			playlists,
			podcasts: [],
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain("探索歌单 1");
	expect(html).toContain("探索歌单 6");
	expect(html).toContain("探索歌单 8");
	expect(html).toContain("网易云音乐歌单");
	expect(html).toContain("QQ音乐歌单");
	expect(html.indexOf("网易云音乐歌单")).toBeLessThan(html.indexOf("QQ音乐歌单"));
	expect((html.match(/class="home-tile/g) ?? []).length).toBeGreaterThan(5);
});

test("EmptyHomeHost marks real Home card covers with the baseline has-cover class", () => {
	const html = renderToStaticMarkup(React.createElement(EmptyHomeHost, {
		discover: {
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [
				{ provider: "netease", id: "1", sourceId: "1", title: "第一首", artists: ["A"], album: "", coverUrl: "https://img.example/a.jpg", qualityHints: [], playableState: "playable" },
				{ provider: "netease", id: "2", sourceId: "2", title: "第二首", artists: ["B"], album: "", coverUrl: "https://img.example/b.jpg", qualityHints: [], playableState: "playable" },
			],
			playlists: [{ provider: "netease", id: "p1", name: "我的歌单", coverUrl: "https://img.example/p.jpg", trackCount: 8, trackIds: [], subscribed: false }],
			podcasts: [],
			updatedAt: 1782656256000,
		},
	}));

	expect(html).toContain('id="home-daily-art"');
	expect(/class="home-card-art has-cover" id="home-daily-art" style="background-image:url\(&quot;https:\/\/img\.example\/a\.jpg&quot;\)"/.test(html)).toBe(true);
	expect(/class="home-card-art has-cover" id="home-private-art" style="background-image:url\(&quot;https:\/\/img\.example\/b\.jpg&quot;\)"/.test(html)).toBe(true);
	expect(/class="home-card-art has-cover" id="home-weather-art" style="background-image:url\(&quot;https:\/\/img\.example\/p\.jpg&quot;\)"/.test(html)).toBe(true);
});

test("Home CSS keeps cover pseudo-elements without the extra bottom mask", async () => {
	const css = await fetch(new URL("../styles.css", import.meta.url)).then((response) => response.text());

	expect(css).toContain(".home-card-art::after");
	expect(css).toContain(".home-tile-cover:not(.has-cover)::before");
	expect(css).toContain(".home-tile-cover:not(.has-cover)::after");
	expect(css).toContain(".home-right-pane");
	expect(css).toContain(".home-rail-sections");
	expect(css).toContain("#empty-home.home-detail-active");
	expect(css).toContain(".home-playlist-detail");
	expect(css).toContain(".home-detail-tabs");
	expect(css).toContain(".home-detail-list-head");
	expect(css).toContain(".home-detail-list");
	expect(css).toContain("overflow-y: auto");
	expect(css).toContain("grid-template-columns: repeat(auto-fill, minmax(132px, 1fr))");
	expect(css).not.toContain(".home-tile-row::-webkit-scrollbar");
	expect(css).not.toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
	expect(css).not.toContain("body.empty-home-active::before");
});

test("EmptyHomeHost routes the private radio card to the baseline Home private callback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost onPlayPrivate={() => calls.push("private")} />));
	(host.querySelector('[data-home-card="private"]') as HTMLButtonElement).click();

	expect(calls).toEqual(["private"]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost routes weather song tiles to the baseline weather callback", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: number[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		discover={{ loggedIn: false, user: null, dailySongs: [], playlists: [], podcasts: [], mode: "starter", updatedAt: 1 }}
		weatherRadio={{
			ok: true,
			weather: {
				provider: "open-meteo",
				location: { name: "上海", country: "中国", admin1: "", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai", fallback: false },
				label: "雨",
				weatherCode: 61,
				temperature: 22,
				apparentTemperature: 21,
				humidity: 88,
				precipitation: 1,
				cloudCover: 90,
				windSpeed: 6,
				windGusts: 10,
				isDay: 1,
				time: "",
				updatedAt: 1,
				error: "",
				mood: { key: "rain", title: "雨天电台", tagline: "留一点潮湿的空间给旋律", energy: 0.38, warmth: 0.42, focus: 0.64, melancholy: 0.66, keywords: ["雨天 R&B"] },
			},
			radio: {
				title: "雨天电台",
				subtitle: "留一点潮湿的空间给旋律",
				seedQueries: ["雨天 R&B"],
				updatedAt: 1,
				songs: [
					{ provider: "netease", id: "weather-1", sourceId: "weather-1", title: "Rain One", artists: ["Alice"], album: "", coverUrl: "", qualityHints: [], playableState: "playable" },
				],
			},
		}}
		onPlayWeatherSong={(index) => calls.push(index)}
	/>));
	(host.querySelector(".home-tile") as HTMLButtonElement).click();

	expect(calls).toEqual([0]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost routes logged-out public playlist tiles through playlist callback indexes", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: number[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		discover={{
			loggedIn: false,
			user: null,
			dailySongs: [],
			playlists: [
				{ provider: "netease", id: "pub-1", name: "公开推荐一", coverUrl: "", trackCount: 30, trackIds: [], subscribed: false },
				{ provider: "netease", id: "pub-2", name: "公开推荐二", coverUrl: "", trackCount: 18, trackIds: [], subscribed: false },
			],
			podcasts: [],
			mode: "starter",
			updatedAt: 1,
		}}
		onOpenPlaylist={(index) => calls.push(index)}
	/>));
	const playlistTiles = Array.from(host.querySelectorAll(".home-tile"))
		.filter((tile) => tile.textContent?.includes("公开推荐"));
	(playlistTiles[1] as HTMLButtonElement).click();

	expect(calls).toEqual([1]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost groups provider playlists while preserving original playlist callback indexes", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: number[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		discover={{
			loggedIn: true,
			user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
			mode: "member",
			dailySongs: [],
			playlists: [
				{ provider: "netease", id: "n1", name: "网易歌单一", coverUrl: "", trackCount: 12, trackIds: [], subscribed: false },
				{ provider: "qq", id: "q1", name: "QQ歌单一", coverUrl: "", trackCount: 8, trackIds: [], subscribed: false },
				{ provider: "soda", id: "s1", name: "汽水歌单一", coverUrl: "", trackCount: 6, trackIds: [], subscribed: false },
			],
			podcasts: [],
			updatedAt: 1,
		}}
		onOpenPlaylist={(index) => calls.push(index)}
	/>));

	expect(host.querySelector('[data-home-provider="netease"]')?.textContent).toContain("网易歌单一");
	expect(host.querySelector('[data-home-provider="qq"]')?.textContent).toContain("QQ歌单一");
	expect(host.querySelector('[data-home-provider="soda"]')?.textContent).toContain("汽水歌单一");
	(host.querySelector('[data-home-provider="qq"] .home-tile') as HTMLButtonElement).click();

	expect(calls).toEqual([1]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost renders a full-screen playlist detail page and routes detail actions", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(<EmptyHomeHost
		playlistDetail={{
			playlist: { provider: "qq", id: "q1", name: "QQ 深夜歌单", coverUrl: "https://img.example/q.jpg", trackCount: 2, trackIds: [], subscribed: false },
			tracks: [
				{ provider: "qq", id: "song-1", sourceId: "song-1", title: "第一首", artists: ["Alice"], album: "Album", coverUrl: "", durationMs: 3000, qualityHints: [], playableState: "playable" },
				{ provider: "qq", id: "song-2", sourceId: "song-2", title: "第二首", artists: ["Bob"], album: "Album", coverUrl: "https://img.example/s2.jpg", durationMs: 65000, qualityHints: [], playableState: "playable" },
			],
		}}
		onClosePlaylistDetail={() => calls.push("back")}
		onPlayPlaylistDetail={(index) => calls.push(`play:${index}`)}
		onPlaylistDetailArtist={(artist) => calls.push(`artist:${artist}`)}
	/>));

	expect(host.querySelector("[data-home-playlist-detail]")).not.toBeNull();
	expect(host.textContent).toContain("QQ 深夜歌单");
	expect(host.textContent).toContain("QQ音乐");
	expect(host.textContent).toContain("已载入 2 首");
	expect(host.textContent).toContain("专辑");
	expect(host.querySelector(".home-detail-kicker")?.textContent).toBe("歌单");
	expect(host.textContent).toContain("首页歌单");
	expect(host.textContent).toContain("第一首");
	expect(host.textContent).toContain("第二首");
	expect(host.textContent).toContain("Album");
	expect(host.textContent).toContain("0:03");
	expect(host.textContent).not.toContain("🚧此处施工，敬请期待🚧");

	(host.querySelector(".home-detail-back") as HTMLButtonElement).click();
	(host.querySelector(".home-detail-play") as HTMLButtonElement).click();
	(host.querySelector('[data-home-detail-track="1"]') as HTMLButtonElement).click();
	(host.querySelector(".home-detail-artist") as HTMLButtonElement).click();

	expect(calls).toEqual(["back", "play:0", "play:1", "artist:Alice"]);
	root.unmount();
	host.remove();
});

test("EmptyHomeHost keeps discover and weather failures local and routes independent retries", async () => {
	await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	flushSync(() => root.render(
		<EmptyHomeHost
			discoverError="推荐服务离线"
			weatherRadioError="天气服务离线"
			onRetryDiscover={() => calls.push("discover")}
			onRetryWeatherRadio={() => calls.push("weather")}
		/>,
	));

	expect(host.querySelector('[data-home-error="discover"]')?.textContent).toContain("推荐服务离线");
	expect(host.querySelector('[data-home-error="weather"]')?.textContent).toContain("天气服务离线");
	(host.querySelector('[data-home-error="discover"] button') as HTMLButtonElement).click();
	(host.querySelector('[data-home-error="weather"] button') as HTMLButtonElement).click();
	expect(calls).toEqual(["discover", "weather"]);

	root.unmount();
	host.remove();
});

test("EmptyHomeHost distinguishes unavailable native services from schema or provider failures", () => {
	const html = renderToStaticMarkup(
		<EmptyHomeHost servicesUnavailableReason="推荐与天气电台仅在 MineRadio 桌面运行时可用" />,
	);
	expect(html).toContain('data-home-unavailable="native-runtime"');
	expect(html).toContain("推荐与天气电台仅在 MineRadio 桌面运行时可用");
	expect(html).not.toContain("推荐预览载入失败");
	expect(html).not.toContain("天气电台载入失败");
});

test("Home playlist detail renders a fully loaded 600-track surface without virtualization", () => {
	const tracks = Array.from({ length: 600 }, (_, index) => ({
		provider: "netease" as const,
		id: `large-${index}`,
		sourceId: `large-${index}`,
		title: `曲目 ${index}`,
		artists: ["歌手"],
		album: "专辑",
		coverUrl: "",
		durationMs: 180_000,
		qualityHints: [],
		playableState: "playable" as const,
	}));
	const html = renderToStaticMarkup(
		<EmptyHomeHost
			playlistDetail={{
				key: "netease:large",
				playlist: {
					provider: "netease",
					id: "large",
					name: "大型歌单",
					coverUrl: "",
					trackCount: tracks.length,
					trackIds: tracks.map((track) => track.id),
					subscribed: false,
				},
				tracks,
				loading: false,
			}}
		/>,
	);

	// 分页懒加载下行数有限，详情列表停用 padding 型虚拟化（与 flex gap 布局冲突，
	// 曾导致越过阈值后列表塌缩成单个渲染窗口），改为全量渲染。
	expect(html).not.toContain('data-virtualized="true"');
	expect((html.match(/class="home-detail-track"/g) ?? []).length).toBe(600);
	expect(html).toContain("曲目 599");
});
