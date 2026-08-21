import { expect, test } from "bun:test";
import { SidecarClient, SidecarClientError } from "./sidecar-client";
import type { Track } from "@mineradio/shared";

await import("../../../../packages/visual-engine/src/runtime/happy-dom-preload");

const MEDIA_BASE = "mineradio-tauri://localhost";

interface ApiInvokeArgs {
	method: "GET" | "POST" | "DELETE";
	path: string;
	body: unknown;
}

type TauriApiHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** 覆盖 Tauri invoke 通道（`__TAURI_INTERNALS__.invoke`），断言走 `api_call` 命令。 */
function withTauriApi<T>(handler: TauriApiHandler, fn: () => Promise<T>): Promise<T> {
	const original = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
	(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
		invoke: (cmd: string, args: Record<string, unknown>) => {
			expect(cmd).toBe("api_call");
			return handler(args);
		},
	};
	return fn().finally(() => {
		if (original === undefined) {
			delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
		} else {
			(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = original;
		}
	});
}

function apiArgs(args: Record<string, unknown>): ApiInvokeArgs {
	return args as unknown as ApiInvokeArgs;
}

test("capabilities parses a valid success envelope", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toBe("/providers/capabilities");
		return {
			ok: true,
			data: {
				version: "0.1.0",
				providers: [
					{
						providerId: "netease",
						available: false,
						capabilities: [],
						message: "pending",
					},
				],
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const matrix = await client.capabilities();
		expect(matrix.version).toBe("0.1.0");
		expect(matrix.providers.length).toBe(1);
		expect(matrix.providers[0].providerId).toBe("netease");
	});
});

const SAMPLE_TRACK: Track = {
	provider: "netease",
	id: "t1",
	sourceId: "t1",
	title: "Song",
	artists: ["Artist"],
	album: "Album",
	coverUrl: "https://example.com/cover.jpg",
	qualityHints: ["standard"],
	playableState: "playable",
};

test("search parses a success envelope of Track[]", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/netease/search");
		expect(path).toContain("keyword=hello");
		expect(path).toContain("limit=30");
		return {
			ok: true,
			data: [SAMPLE_TRACK, { ...SAMPLE_TRACK, id: "t2", title: "Two" }],
		};
	}, async () => {
		const client = new SidecarClient();
		const tracks = await client.search("netease", "hello", 30);
		expect(tracks.length).toBe(2);
		expect(tracks[0].id).toBe("t1");
		expect(tracks[1].title).toBe("Two");
	});
});

test("searchAll uses the cross-source search endpoint", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/search");
		expect(path).toContain("keyword=hello");
		expect(path).toContain("limit=30");
		expect(path).not.toContain("/providers/");
		return { ok: true, data: [SAMPLE_TRACK] };
	}, async () => {
		const client = new SidecarClient();
		const tracks = await client.searchAll("hello", 30);
		expect(tracks[0].id).toBe("t1");
	});
});

test("weatherRadio calls sidecar weather radio endpoint with location params", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/weather/radio");
		expect(path).toContain("city=%E4%B8%8A%E6%B5%B7");
		expect(path).toContain("lat=31.23");
		return {
			ok: true,
			data: {
				ok: true,
				weather: {
					provider: "open-meteo",
					location: {
						name: "上海",
						country: "中国",
						admin1: "",
						latitude: 31.23,
						longitude: 121.47,
						timezone: "Asia/Shanghai",
						fallback: false,
					},
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
					mood: {
						key: "rain",
						title: "雨天电台",
						tagline: "留一点潮湿的空间给旋律",
						energy: 0.38,
						warmth: 0.42,
						focus: 0.64,
						melancholy: 0.66,
						keywords: ["雨天 R&B"],
					},
				},
				radio: {
					title: "雨天电台",
					subtitle: "留一点潮湿的空间给旋律",
					seedQueries: ["陈奕迅 阴天快乐"],
					songs: [SAMPLE_TRACK],
					updatedAt: 1,
				},
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const radio = await client.weatherRadio({ city: "上海", lat: 31.23, lon: 121.47 });
		expect(radio.weather.mood.title).toBe("雨天电台");
		expect(radio.radio.songs[0].id).toBe("t1");
	});
});

test("discoverHome GETs the baseline Home discover endpoint", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/discover/home");
		return {
			ok: true,
			data: {
				loggedIn: true,
				mode: "member",
				user: { provider: "netease", userId: "42", nickname: "tester", avatarUrl: "" },
				dailySongs: [SAMPLE_TRACK],
				playlists: [{
					provider: "netease",
					id: "p1",
					name: "我的歌单",
					coverUrl: "",
					trackCount: 1,
					trackIds: ["t1"],
					subscribed: false,
				}],
				podcasts: [],
				updatedAt: 1782656256000,
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const discover = await client.discoverHome();
		expect(discover.mode).toBe("member");
		expect(discover.dailySongs[0].id).toBe("t1");
		expect(discover.playlists[0].name).toBe("我的歌单");
	});
});

test("podcastSearch GETs baseline podcast search endpoint", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/podcast/search");
		expect(path).toContain("keywords=%E6%95%85%E4%BA%8B");
		expect(path).toContain("limit=18");
		return {
			ok: true,
			data: {
				podcasts: [{
					id: "r1",
					rid: "r1",
					name: "故事电台",
					coverUrl: "",
					description: "",
					djName: "",
					category: "",
					programCount: 0,
					subCount: 0,
				}],
				total: 1,
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const result = await client.podcastSearch("故事", 18);
		expect(result.podcasts[0].name).toBe("故事电台");
		expect(result.total).toBe(1);
	});
});

test("podcast library methods call hot detail programs and my endpoints", async () => {
	const seen: string[] = [];
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		seen.push(path);
		expect(method).toBe("GET");
		if (path.includes("/podcast/hot")) {
			return { ok: true, data: { podcasts: [], more: false } };
		}
		if (path.includes("/podcast/detail")) {
			return {
				ok: true,
				data: {
					podcast: {
						id: "r1",
						rid: "r1",
						name: "电台",
						coverUrl: "",
						description: "",
						djName: "",
						category: "",
						programCount: 0,
						subCount: 0,
					},
				},
			};
		}
		if (path.includes("/podcast/programs")) {
			return {
				ok: true,
				data: { radio: { id: "r1", rid: "r1", name: "电台" }, programs: [], more: false, total: 0 },
			};
		}
		if (path.includes("/podcast/my/items")) {
			return {
				ok: true,
				data: {
					loggedIn: false,
					key: "liked",
					title: "喜欢的声音",
					sub: "收藏或最近喜欢的声音",
					itemType: "voice",
					count: 0,
					coverUrl: "",
					items: [],
				},
			};
		}
		if (path.includes("/podcast/my")) {
			return { ok: true, data: { loggedIn: false, collections: [] } };
		}
		throw new Error(`unexpected ${path}`);
	}, async () => {
		const client = new SidecarClient();
		expect((await client.podcastHot(12, 24)).more).toBe(false);
		expect((await client.podcastDetail("r1")).podcast.name).toBe("电台");
		expect((await client.podcastPrograms("r1", 30, 0)).total).toBe(0);
		expect((await client.podcastMy()).loggedIn).toBe(false);
		expect((await client.podcastMyItems("liked", 36, 12)).key).toBe("liked");
	});

	expect(seen).toEqual([
		"/podcast/hot?limit=12&offset=24",
		"/podcast/detail?id=r1",
		"/podcast/programs?id=r1&limit=30&offset=0",
		"/podcast/my",
		"/podcast/my/items?key=liked&limit=36&offset=12",
	]);
});

test("podcastDjBeatmap GETs analyzer endpoint with encoded audio URL", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/podcast/dj-beatmap");
		expect(path).toContain("url=https%3A%2F%2Fmedia.example%2Fdj.mp3");
		expect(path).toContain("duration=120");
		expect(path).toContain("intro=18");
		return { ok: true, data: { ok: true, map: { beats: [1, 2] } } };
	}, async () => {
		const client = new SidecarClient();
		const result = await client.podcastDjBeatmap("https://media.example/dj.mp3", 120, 18);
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.map.beats)).toBe(true);
	});
});

test("search throws SidecarClientError on ok:false", async () => {
	await withTauriApi(async () => ({
		ok: false,
		error: { code: "PROVIDER_ERROR", message: "boom", retryable: false },
	}), async () => {
		const client = new SidecarClient();
		let caught: unknown = null;
		try {
			await client.search("netease", "x", 5);
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("PROVIDER_ERROR");
	});
});

test("songUrl POSTs the Track body and parses the SongUrlResult envelope", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/song-url");
		receivedBody = body;
		return {
			ok: true,
			data: { url: "https://proxied/a.mp3", proxied: true },
		};
	}, async () => {
		const client = new SidecarClient();
		const result = await client.songUrl(SAMPLE_TRACK);
		expect(result.url).toBe("https://proxied/a.mp3");
		expect(result.proxied).toBe(true);
		expect((receivedBody as { id: string }).id).toBe("t1");
	});
});

test("resolveSongUrl POSTs to the cross-source song-url endpoint", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/song-url");
		expect(path).not.toContain("/providers/");
		receivedBody = body;
		return {
			ok: true,
			data: { url: "https://media.example/a.mp3", proxied: false, requestedQuality: "lossless" },
		};
	}, async () => {
		const client = new SidecarClient();
		const result = await client.resolveSongUrl(SAMPLE_TRACK, "lossless");
		expect(result.proxied).toBe(false);
		expect(result.requestedQuality).toBe("lossless");
		expect(receivedBody).toEqual({ track: SAMPLE_TRACK, quality: "lossless" });
		if (!result.url) throw new Error("expected playable test url");
		expect(client.audioProxyUrl(result.url)).toBe(result.url);
	});
});

test("trackQualities POSTs the Track body and parses native quality options", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/qualities");
		receivedBody = body;
		return {
			ok: true,
			data: {
				provider: "netease",
				trackId: "t1",
				defaultQuality: "exhigh",
				qualities: [{
					provider: "netease",
					id: "exhigh",
					label: "极高",
					short: "HQ",
					requestQuality: "exhigh",
					level: "exhigh",
					br: 999000,
					source: "resolved",
				}],
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const result = await client.trackQualities(SAMPLE_TRACK);
		expect(receivedBody).toEqual(SAMPLE_TRACK);
		expect(result.defaultQuality).toBe("exhigh");
		expect(result.qualities[0].requestQuality).toBe("exhigh");
	});
});

test("proxiedUrl resolves relative proxied paths against the media protocol base", () => {
	const client = new SidecarClient();
	expect(client.proxiedUrl("/providers/soda/audio-proxy?url=https%3A%2F%2Fmedia.example%2Fsoda.m4a&playAuth=abc")).toBe(
		`${MEDIA_BASE}/providers/soda/audio-proxy?url=https%3A%2F%2Fmedia.example%2Fsoda.m4a&playAuth=abc`,
	);
	expect(client.proxiedUrl("https://cdn.example.com/already.mp3")).toBe("https://cdn.example.com/already.mp3");
});

test("imageProxyUrl mirrors baseline cover proxy URL construction for remote covers only", () => {
	const client = new SidecarClient();
	expect(client.imageProxyUrl("https://img.example/a.jpg")).toBe(`${MEDIA_BASE}/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg`);
	expect(client.imageProxyUrl("http://img.example/a.jpg")).toBe(`${MEDIA_BASE}/image-proxy?url=http%3A%2F%2Fimg.example%2Fa.jpg`);
	expect(client.imageProxyUrl("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
	expect(client.imageProxyUrl("blob:http://local/abc")).toBe("blob:http://local/abc");
	expect(client.imageProxyUrl("file:///tmp/a.jpg")).toBe("");
	expect(client.imageProxyUrl("")).toBe("");
});

test("imageProxyUrl supports baseline cache-bust parameter", () => {
	const client = new SidecarClient();
	expect(client.imageProxyUrl("https://img.example/a.jpg", true, 12345)).toBe(`${MEDIA_BASE}/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg&v=12345`);
});

test("lyric POSTs the Track body and parses the LyricPayload envelope", async () => {
	let called = false;
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/lyric");
		called = true;
		return {
			ok: true,
			data: {
				provider: "netease",
				trackId: "t1",
				lines: [{ timeMs: 0, text: "hello" }],
				hasTranslation: false,
				isWordByWord: false,
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const lyric = await client.lyric(SAMPLE_TRACK);
		expect(lyric.trackId).toBe("t1");
		expect(lyric.lines.length).toBe(1);
		expect(lyric.lines[0].text).toBe("hello");
	});
	expect(called).toBe(true);
});

test("playlistDetail GETs the playlist by id", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/netease/playlists/p10");
		return {
			ok: true,
			data: {
				provider: "netease",
				id: "p10",
				name: "Hot",
				trackCount: 2,
				trackIds: ["t1", "t2"],
				tracks: [SAMPLE_TRACK],
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const detail = await client.playlistDetail("netease", "p10");
		expect(detail.name).toBe("Hot");
		expect(detail.tracks.length).toBe(1);
		expect(detail.tracks[0].id).toBe("t1");
	});
});

test("playlistList GETs provider playlists and parses playlist summaries", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/qq/playlists");
		return {
			ok: true,
			data: [
				{
					provider: "qq",
					id: "201",
					name: "我喜欢",
					coverUrl: "http://cover/like.jpg",
					trackCount: 8,
					trackIds: [],
				},
			],
		};
	}, async () => {
		const client = new SidecarClient();
		const playlists = await client.playlistList("qq");
		expect(playlists.length).toBe(1);
		expect(playlists[0].provider).toBe("qq");
		expect(playlists[0].id).toBe("201");
		expect(playlists[0].name).toBe("我喜欢");
	});
});

test("importSharedPlaylist POSTs share text and parses import result", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/shared-playlist/import");
		receivedBody = body;
		return {
			ok: true,
			data: {
				provider: "qq",
				playlist: {
					provider: "qq",
					id: "7167576049",
					name: "QQ Share",
					coverUrl: "",
					trackCount: 1,
					trackIds: ["q1"],
					subscribed: false,
					sourceUrl: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049",
				},
				tracks: [{ ...SAMPLE_TRACK, provider: "qq", id: "q1", sourceId: "q1" }],
				trackCount: 1,
				loadedCount: 1,
				partial: false,
				partialReason: "",
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const result = await client.importSharedPlaylist({ text: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049" });
		expect(receivedBody).toEqual({ text: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=7167576049" });
		expect(result.playlist.id).toBe("7167576049");
		expect(result.loadedCount).toBe(1);
	});
});

test("likeSong POSTs provider like mutation and parses ack", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/like");
		receivedBody = body;
		return {
			ok: true,
			data: { provider: "netease", id: "100", liked: true, code: 200 },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.likeSong("netease", "100", true);
		expect(receivedBody).toEqual({ id: "100", liked: true });
		expect(ack).toEqual({ provider: "netease", id: "100", liked: true, code: 200 });
	});
});

test("checkSongLikes GETs comma-separated ids and parses liked map", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/netease/like-check?ids=100%2C200");
		return {
			ok: true,
			data: { provider: "netease", ids: ["100", "200"], liked: { "100": true, "200": false } },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.checkSongLikes("netease", ["100", "200"]);
		expect(ack.liked["100"]).toBe(true);
		expect(ack.liked["200"]).toBe(false);
	});
});

test("addSongToPlaylist POSTs playlist add mutation and parses ack", async () => {
	let receivedBody: unknown = null;
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/playlists/add-song");
		receivedBody = body;
		return {
			ok: true,
			data: { provider: "netease", playlistId: "p1", trackId: "100", success: true, code: 200 },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.addSongToPlaylist("netease", "p1", "100");
		expect(receivedBody).toEqual({ playlistId: "p1", trackId: "100" });
		expect(ack.success).toBe(true);
	});
});

test("setProviderSessionCookie POSTs cookie and accepts ack without retaining cookie", async () => {
	let receivedBody: unknown = null;
	const secret = "MUSIC_U=web-secret";
	await withTauriApi(async (args) => {
		const { method, path, body } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/session-cookie");
		receivedBody = body;
		return {
			ok: true,
			data: { provider: "netease", stored: true },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.setProviderSessionCookie("netease", secret);
		expect(ack).toEqual({ provider: "netease", stored: true });
		expect(receivedBody).toEqual({ cookie: secret });
		expect(JSON.stringify(ack)).not.toContain(secret);
	});
});

test("clearProviderSessionCookie DELETEs cookie and accepts clear ack", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("DELETE");
		expect(path).toContain("/providers/qq/session-cookie");
		return {
			ok: true,
			data: { provider: "qq", stored: false },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.clearProviderSessionCookie("qq");
		expect(ack).toEqual({ provider: "qq", stored: false });
	});
});

test("Netease QR login helpers parse key image and check responses", async () => {
	const seen: string[] = [];
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		seen.push(path);
		expect(method).toBe("GET");
		if (path.includes("/providers/netease/login-qr-key")) {
			return { ok: true, data: { provider: "netease", key: "qr-key-1" } };
		}
		if (path.includes("/providers/netease/login-qr-create")) {
			expect(path).toContain("key=qr-key-1");
			return {
				ok: true,
				data: { provider: "netease", key: "qr-key-1", img: "data:image/png;base64,abc" },
			};
		}
		if (path.includes("/providers/netease/login-qr-check")) {
			expect(path).toContain("key=qr-key-1");
			return {
				ok: true,
				data: { provider: "netease", key: "qr-key-1", code: 801, loggedIn: false },
			};
		}
		throw new Error(`unexpected path ${path}`);
	}, async () => {
		const client = new SidecarClient();
		expect(await client.createProviderLoginQrKey("netease")).toEqual({
			provider: "netease",
			key: "qr-key-1",
		});
		expect(await client.createProviderLoginQrImage("netease", "qr-key-1")).toEqual({
			provider: "netease",
			key: "qr-key-1",
			img: "data:image/png;base64,abc",
		});
		expect(await client.checkProviderLoginQr("netease", "qr-key-1")).toEqual({
			provider: "netease",
			key: "qr-key-1",
			code: 801,
			loggedIn: false,
		});
	});
	expect(seen.length).toBe(3);
});

test("QQ QR login helpers call QQ provider routes and parse responses", async () => {
	const seen: string[] = [];
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		seen.push(path);
		expect(method).toBe("GET");
		if (path.includes("/providers/qq/login-qr-key")) {
			return { ok: true, data: { provider: "qq", key: "qr_sig_1|1987342677" } };
		}
		if (path.includes("/providers/qq/login-qr-create")) {
			expect(path).toContain("key=qr_sig_1%7C1987342677");
			return {
				ok: true,
				data: { provider: "qq", key: "qr_sig_1|1987342677", img: "data:image/png;base64,qq" },
			};
		}
		if (path.includes("/providers/qq/login-qr-check")) {
			expect(path).toContain("key=qr_sig_1%7C1987342677");
			return {
				ok: true,
				data: { provider: "qq", key: "qr_sig_1|1987342677", code: 67, loggedIn: false, scanned: true },
			};
		}
		throw new Error(`unexpected path ${path}`);
	}, async () => {
		const client = new SidecarClient();
		expect(await client.createProviderLoginQrKey("qq")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
		});
		expect(await client.createProviderLoginQrImage("qq", "qr_sig_1|1987342677")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
			img: "data:image/png;base64,qq",
		});
		expect(await client.checkProviderLoginQr("qq", "qr_sig_1|1987342677")).toEqual({
			provider: "qq",
			key: "qr_sig_1|1987342677",
			code: 67,
			loggedIn: false,
			scanned: true,
		});
	});
	expect(seen.length).toBe(3);
});

test("loginStatus parses a cookie-free provider profile summary", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/netease/login-status");
		return {
			ok: true,
			data: {
				provider: "netease",
				loggedIn: true,
				nickname: "tester",
				userId: "42",
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const status = await client.loginStatus("netease");
		expect(status.loggedIn).toBe(true);
		expect(status.nickname).toBe("tester");
		expect(JSON.stringify(status)).not.toContain("MUSIC_U");
		expect(JSON.stringify(status)).not.toContain("cookie");
	});
});

test("loginStatus parses Netease VIP profile metadata", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("GET");
		expect(path).toContain("/providers/netease/login-status");
		return {
			ok: true,
			data: {
				provider: "netease",
				loggedIn: true,
				nickname: "tester",
				userId: "42",
				vipType: 11,
				vipLevel: "svip",
				isVip: true,
				isSvip: true,
				vipLabel: "黑胶SVIP·陆",
				vipIcon: "netease-svip",
				vipIconUrl: "https://example.com/vip.png",
				vipTier: 6,
				vipLevelName: "陆",
			},
		};
	}, async () => {
		const client = new SidecarClient();
		const status = await client.loginStatus("netease");
		expect(status.vipType).toBe(11);
		expect(status.vipLevel).toBe("svip");
		expect(status.isVip).toBe(true);
		expect(status.isSvip).toBe(true);
		expect(status.vipLabel).toBe("黑胶SVIP·陆");
		expect(status.vipIcon).toBe("netease-svip");
		expect(status.vipIconUrl).toBe("https://example.com/vip.png");
		expect(status.vipTier).toBe(6);
		expect(status.vipLevelName).toBe("陆");
		expect(JSON.stringify(status)).not.toContain("MUSIC_U");
		expect(JSON.stringify(status)).not.toContain("cookie");
	});
});

test("logout posts to provider logout and parses ack", async () => {
	await withTauriApi(async (args) => {
		const { method, path } = apiArgs(args);
		expect(method).toBe("POST");
		expect(path).toContain("/providers/netease/logout");
		return {
			ok: true,
			data: { provider: "netease", loggedOut: true },
		};
	}, async () => {
		const client = new SidecarClient();
		const ack = await client.logout("netease");
		expect(ack).toEqual({ provider: "netease", loggedOut: true });
	});
});

test("request preserves provider failure envelope on ok:false responses", async () => {
	await withTauriApi(async () => ({
		ok: false,
		error: {
			code: "LOGIN_REQUIRED",
			message: "需要登录后播放",
			provider: "qq",
			retryable: true,
			action: "login",
			playbackKeyReady: false,
			reason: "login_required",
			qqCode: 104003,
			rawMessage: "no vkey",
			tried: ["无损 FLAC · F000abc.flac"],
			restriction: {
				provider: "qq",
				category: "login_required",
				action: "login",
				message: "需要登录后播放",
				code: 104003,
				rawMessage: "no vkey",
				missingPlaybackKey: true,
			},
		},
	}), async () => {
		const client = new SidecarClient();
		let caught: unknown = null;
		try {
			await client.resolveSongUrl({ ...SAMPLE_TRACK, provider: "qq" });
		} catch (e) {
			caught = e;
		}
		expect(caught instanceof SidecarClientError).toBe(true);
		expect((caught as SidecarClientError).code).toBe("LOGIN_REQUIRED");
		expect((caught as SidecarClientError).provider).toBe("qq");
		expect((caught as SidecarClientError).retryable).toBe(true);
		expect((caught as SidecarClientError).action).toBe("login");
		expect((caught as SidecarClientError).playbackKeyReady).toBe(false);
		expect((caught as SidecarClientError).reason).toBe("login_required");
		expect((caught as SidecarClientError).qqCode).toBe(104003);
		expect((caught as SidecarClientError).rawMessage).toBe("no vkey");
		expect((caught as SidecarClientError).tried).toEqual(["无损 FLAC · F000abc.flac"]);
	});
});
