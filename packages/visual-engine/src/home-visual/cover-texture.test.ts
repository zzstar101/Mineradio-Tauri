import { beforeEach, expect, test } from "bun:test";
import { createBudgetTaskQueue, createCancellationScope, createVisualResourceLedger, createVisualResourceScope } from "../index";
import { countHomeCoverTextureCacheLeaseScopesForTests, createHomeCoverTextureController, coverTextureSizeForResolution, estimateHomeCoverTextureCacheBytes, prepareSquareCoverCanvas, resetHomeCoverTextureCacheForTests, trimHomeCoverTextureCache } from "./cover-texture";

const rejectionProcess = (globalThis as unknown as {
	process: {
		on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
		off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
	};
}).process;

function makeTexture(label: string) {
	return {
		label,
		image: { width: 4, height: 4, label },
		needsUpdate: false,
		disposed: false,
		dispose() {
			this.disposed = true;
		},
	};
}

function makeUniforms() {
	return {
		uCoverTex: { value: makeTexture("cover") },
		uPrevCoverTex: { value: makeTexture("prev") },
		uEdgeTex: { value: makeTexture("edge") },
		uColorMixT: { value: 1 },
		uHasCover: { value: 0 },
		uLoading: { value: 0 },
		uHasDepth: { value: 0 },
		uAiBoost: { value: 0 },
	};
}

beforeEach(() => {
	resetHomeCoverTextureCacheForTests();
});

test("setCoverUrl('') clears baseline cover-state uniforms without changing texture objects", () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async () => ({ width: 32, height: 32, src: "unused" }),
	});
	const coverTex = uniforms.uCoverTex.value;
	ctl.setCoverUrl("");
	expect(uniforms.uHasCover.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uHasDepth.value).toBe(0);
	expect(uniforms.uAiBoost.value).toBe(0);
	expect(uniforms.uCoverTex.value).toBe(coverTex);
});

test("setCoverUrl(url) loads the current cover image, marks texture dirty, and sets uHasCover", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const prepared: unknown[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 128, height: 96, src: url };
		},
		onCoverPrepared: (image) => prepared.push(image),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	expect(uniforms.uLoading.value).toBe(1);
	await ctl.whenIdle();
	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 128, height: 96, src: "https://img.example/a.jpg" });
	expect(prepared).toEqual([{ width: 128, height: 96, src: "https://img.example/a.jpg" }]);
	expect(uniforms.uCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
});

test("setCoverUrl(opaque custom URI) loads transport-owned cover sources without inspecting their route", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const source = "mineradio-image://cover/session-token/track-42";
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 96, height: 96, src: url };
		},
	});

	ctl.setCoverUrl(source);
	await ctl.whenIdle();

	expect(loaded).toEqual([source]);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 96, height: 96, src: source });
	expect(uniforms.uHasCover.value).toBe(1);
});

test("setCoverUrl(url) keeps the cover visible when cover-dependent color work throws", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 128, height: 128, src: url }),
		onCoverPrepared: () => {
			throw new Error("palette failed");
		},
	});

	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();

	expect(uniforms.uCoverTex.value.image).toEqual({ width: 128, height: 128, src: "https://img.example/a.jpg" });
	expect(uniforms.uCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
});

test("setCoverUrl(data:image) accepts inline custom cover sources instead of clearing", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 32, height: 32, src: url };
		},
	});

	ctl.setCoverUrl(dataUrl);
	await ctl.whenIdle();

	expect(loaded).toEqual([dataUrl]);
	expect(ctl.getCurrentUrl()).toBe(dataUrl);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 32, height: 32, src: dataUrl });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("setCoverUrl(blob) accepts local object URLs used by imported cover images", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const blobUrl = "blob:http://localhost/local-cover";
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 48, height: 48, src: url };
		},
	});

	ctl.setCoverUrl(blobUrl);
	await ctl.whenIdle();

	expect(loaded).toEqual([blobUrl]);
	expect(ctl.getCurrentUrl()).toBe(blobUrl);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 48, height: 48, src: blobUrl });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("setCoverUrl(primary, fallback) uses the explicit direct fallback without parsing transport routes", async () => {
	const uniforms = makeUniforms();
	const originalImage = globalThis.Image;
	const originalFetch = globalThis.fetch;
	const originalCreateObjectUrl = URL.createObjectURL;
	const originalRevokeObjectUrl = URL.revokeObjectURL;
	const loaded: string[] = [];
	const direct = "http://p3.music.126.net/cover.jpg";
	const primary = "https://opaque-media.example/cover/token-1";

	class FakeImage {
		crossOrigin = "";
		decoding = "";
		width = 64;
		height = 64;
		naturalWidth = 64;
		naturalHeight = 64;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(value: string) {
			loaded.push(value);
			queueMicrotask(() => {
				if (value === direct) this.onload?.();
				else this.onerror?.();
			});
		}
	}

	globalThis.Image = FakeImage as unknown as typeof Image;
	globalThis.fetch = (async () => ({
		ok: true,
		headers: { get: () => "image/jpeg" },
		blob: async () => new Blob(["bad-proxy-image"], { type: "image/jpeg" }),
	})) as unknown as typeof fetch;
	URL.createObjectURL = () => "blob:http://127.0.0.1/bad-proxy-image";
	URL.revokeObjectURL = () => {};
	try {
		const ctl = createHomeCoverTextureController({
			uniforms: uniforms as never,
			createCanvas: (width, height) => ({ width, height, getContext: () => null }) as never,
		});
		ctl.setCoverUrl(primary, direct);
		await ctl.whenIdle();

		expect(loaded).toEqual([primary, "blob:http://127.0.0.1/bad-proxy-image", direct]);
		expect((uniforms.uCoverTex.value.image as { width: number }).width).toBe(64);
		expect((uniforms.uCoverTex.value.image as { height: number }).height).toBe(64);
		expect(uniforms.uHasCover.value).toBe(1);
	} finally {
		globalThis.Image = originalImage;
		globalThis.fetch = originalFetch;
		URL.createObjectURL = originalCreateObjectUrl;
		URL.revokeObjectURL = originalRevokeObjectUrl;
	}
});

test("setCoverUrl(primary, fallback) drops an unsafe fallback before invoking the loader", async () => {
	const uniforms = makeUniforms();
	const observedFallbacks: Array<string | undefined> = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url, _signal, fallbackUrl) => {
			observedFallbacks.push(fallbackUrl);
			return { width: 64, height: 64, src: url };
		},
	});

	ctl.setCoverUrl("mineradio-image://cover/token-1", "file:///Users/me/cover.png");
	await ctl.whenIdle();

	expect(observedFallbacks).toEqual([""]);
	expect(uniforms.uHasCover.value).toBe(1);
});

test("setCoverUrl(primary, fallback) does not reuse a cached image when only fallback changes", async () => {
	const uniforms = makeUniforms();
	const loadedFallbacks: string[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (_url, _signal, fallbackUrl) => {
			const resolved = String(fallbackUrl ?? "");
			loadedFallbacks.push(resolved);
			return { width: 64, height: 64, src: resolved };
		},
	});
	const primary = "mineradio-image://cover/stable-token";
	const fallbackA = "https://img.example/fallback-a.jpg";
	const fallbackB = "https://img.example/fallback-b.jpg";

	ctl.setCoverUrl(primary, fallbackA);
	await ctl.whenIdle();
	expect((uniforms.uCoverTex.value.image as { src?: string }).src).toBe(fallbackA);

	ctl.setCoverUrl(primary, fallbackB);
	await ctl.whenIdle();
	expect(loadedFallbacks).toEqual([fallbackA, fallbackB]);
	expect((uniforms.uCoverTex.value.image as { src?: string }).src).toBe(fallbackB);
});

test("setCoverUrl(unsupported scheme) preserves safety behavior by clearing without loading", async () => {
	const uniforms = makeUniforms();
	const loaded: string[] = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 32, height: 32, src: url };
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uHasCover.value).toBe(1);

	ctl.setCoverUrl("file:///Users/me/cover.png");
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(ctl.getCurrentUrl()).toBe("");
	expect(uniforms.uHasCover.value).toBe(0);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uHasDepth.value).toBe(0);
	expect(uniforms.uAiBoost.value).toBe(0);
});

test("setCoverUrl(next) snapshots the previous loaded cover into uPrevCoverTex before applying next", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	ctl.setCoverUrl("https://img.example/b.jpg");
	await ctl.whenIdle();
	expect(uniforms.uPrevCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/a.jpg" });
	expect(uniforms.uPrevCoverTex.value.needsUpdate).toBe(true);
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/b.jpg" });
	expect(uniforms.uColorMixT.value).toBe(0);
});

test("failed replacement keeps the last committed WebGL cover visible", async () => {
	const uniforms = makeUniforms();
	const committed = { width: 32, height: 32, src: "committed-a" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			if (url.endsWith("b.jpg")) throw new Error("invalid replacement");
			return committed;
		},
	});

	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	ctl.setCoverUrl("https://img.example/b.jpg");
	await ctl.whenIdle();

	expect(uniforms.uCoverTex.value.image).toBe(committed);
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uLoading.value).toBe(0);
});

test("stale cover loads are ignored when a newer URL is requested", async () => {
	const uniforms = makeUniforms();
	const resolvers: Array<(image: unknown) => void> = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: (url) => new Promise((resolve) => {
			resolvers.push(() => resolve({ width: 32, height: 32, src: url }));
		}),
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	ctl.setCoverUrl("https://img.example/b.jpg");
	resolvers[0]?.({});
	await Promise.resolve();
	expect(uniforms.uHasCover.value).toBe(0);
	resolvers[1]?.({});
	await ctl.whenIdle();
	expect(uniforms.uCoverTex.value.image).toEqual({ width: 32, height: 32, src: "https://img.example/b.jpg" });
	expect(uniforms.uHasCover.value).toBe(1);
});

test("wake retries an uncommitted requested cover while retaining the last committed cover", async () => {
	const uniforms = makeUniforms();
	const aUrl = "https://img.example/committed-a.jpg";
	const bUrl = "https://img.example/requested-b.jpg";
	const aImage = { width: 32, height: 32, label: "A" };
	const staleB = { width: 32, height: 32, label: "B-stale" };
	const committedB = { width: 32, height: 32, label: "B" };
	const loads: string[] = [];
	const pendingB: Array<{
		resolve(image: typeof committedB): void;
		signal?: AbortSignal;
	}> = [];
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: (url, signal) => {
			loads.push(url);
			if (url === aUrl) return Promise.resolve(aImage);
			return new Promise((resolve) => { pendingB.push({ resolve, signal }); });
		},
	});
	ctl.setCoverUrl(aUrl);
	await ctl.whenIdle();
	expect(uniforms.uCoverTex.value.image).toBe(aImage);

	ctl.setCoverUrl(bUrl);
	expect(loads).toEqual([aUrl, bUrl]);
	expect(uniforms.uCoverTex.value.image).toBe(aImage);
	ctl.setRuntimeActive(false);
	expect(pendingB[0]?.signal?.aborted).toBe(true);
	ctl.setRuntimeActive(true);

	ctl.setCoverUrl(bUrl);
	expect(loads).toEqual([aUrl, bUrl, bUrl]);
	expect(uniforms.uCoverTex.value.image).toBe(aImage);
	ctl.setCoverUrl(bUrl);
	expect(loads).toEqual([aUrl, bUrl, bUrl]);

	pendingB[0]?.resolve(staleB);
	await Promise.resolve();
	await Promise.resolve();
	expect(uniforms.uCoverTex.value.image).toBe(aImage);
	pendingB[1]?.resolve(committedB);
	await ctl.whenIdle();

	expect(uniforms.uPrevCoverTex.value.image).toBe(aImage);
	expect(uniforms.uCoverTex.value.image).toBe(committedB);
	ctl.setCoverUrl(bUrl);
	expect(loads).toEqual([aUrl, bUrl, bUrl]);
});

test("changing covers aborts the previous runtime loader", () => {
	const uniforms = makeUniforms();
	const signals: AbortSignal[] = [];
	const cancellationScope = createCancellationScope("covers");
	const resourceScope = createVisualResourceScope("cover-resources");
	const ledger = createVisualResourceLedger({
		budget: { textureBytes: 1_000_000, geometryBytes: 1_000_000, meshCount: 100, queuedTaskCost: 10, cacheBytes: 10_000_000 },
	});
	const taskQueue = createBudgetTaskQueue({ ledger, resourceScope, cancellationScope });
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: (_url, signal) => {
			if (!signal) throw new Error("expected a runtime abort signal");
			signals.push(signal);
			return new Promise(() => {});
		},
		runtime: { cancellationScope, taskQueue, resourceScope },
	});

	ctl.setCoverUrl("https://img.example/old.jpg");
	taskQueue.runSlice(1);
	ctl.setCoverUrl("https://img.example/new.jpg");

	expect(signals[0]?.aborted).toBe(true);
});

test("advanceColorMix moves uColorMixT toward 1 over the baseline color mix duration", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		colorMixDurationMs: 1000,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	ctl.advanceColorMix(0.25);
	expect(uniforms.uColorMixT.value).toBeCloseTo(0.25, 5);
	ctl.advanceColorMix(0.75);
	expect(uniforms.uColorMixT.value).toBe(1);
});

test("setCoverUrl(url) builds the baseline edge/depth texture and advances depth uniforms", async () => {
	const uniforms = makeUniforms();
	const edgeCanvas = { width: 256, height: 256, label: "edge-depth" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: (image) => {
			expect((image as { src: string }).src).toBe("https://img.example/a.jpg");
			return edgeCanvas as never;
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(edgeCanvas);
	expect(uniforms.uEdgeTex.value.needsUpdate).toBe(true);
	expect(uniforms.uHasDepth.value).toBe(0);
	ctl.advanceDepth(0.09);
	expect(uniforms.uHasDepth.value).toBeCloseTo(0.5, 5);
	expect(uniforms.uAiBoost.value).toBeCloseTo(0.275, 5);
	ctl.advanceDepth(0.09);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setCoverUrl(url) boosts depth to the baseline AI target when aiDepth is enabled and an AI depth canvas is available", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const mergedCanvas = { width: 256, height: 256, label: "merged-ai-depth" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async (image) => {
			expect((image as { src: string }).src).toBe("https://img.example/a.jpg");
			return aiCanvas as never;
		},
		mergeAiDepth: (heuristic, ai) => {
			expect(heuristic).toBe(heuristicCanvas);
			expect(ai).toBe(aiCanvas);
			return mergedCanvas as never;
		},
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(mergedCanvas);
	ctl.advanceDepth(0.36);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(1);
});

test("setCoverUrl(url) applies the cover before waiting for slow AI depth work", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	let resolveAi: ((image: typeof aiCanvas) => void) | null = null;
	const aiPending = new Promise<typeof aiCanvas>((resolve) => {
		resolveAi = resolve;
	});
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => aiPending,
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await Promise.resolve();
	await Promise.resolve();

	expect(uniforms.uCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/a.jpg" });
	expect(uniforms.uHasCover.value).toBe(1);
	expect(uniforms.uLoading.value).toBe(0);
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);

	const finishAi = resolveAi as ((image: typeof aiCanvas) => void) | null;
	if (!finishAi) throw new Error("expected pending AI depth resolver");
	finishAi(aiCanvas);
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(aiCanvas);
});

test("setCoverUrl(url) keeps the heuristic depth target when aiDepth is enabled but AI estimation returns null", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => null,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);
	ctl.advanceDepth(0.18);
	expect(uniforms.uHasDepth.value).toBe(1);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setCoverUrl(url) keeps the heuristic depth target when AI depth merge returns null", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async () => ({ width: 64, height: 64 }),
		buildEdgeDepth: () => heuristicCanvas as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => aiCanvas as never,
		mergeAiDepth: () => null,
	});

	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();

	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);
	ctl.advanceDepth(0.18);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setAiDepthEnabled(true) reuses the prepared cover and heuristic depth while running AI depth", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const loaded: string[] = [];
	let depthBuilds = 0;
	let aiRuns = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: false,
		estimateAiDepth: async () => {
			aiRuns += 1;
			return aiCanvas as never;
		},
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(aiRuns).toBe(0);

	ctl.setAiDepthEnabled(true);
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(depthBuilds).toBe(1);
	expect(aiRuns).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(aiCanvas);
});

test("setAiDepthEnabled(false) reuses heuristic depth and ignores stale in-flight AI depth", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const aiResolver: { current?: (value: typeof aiCanvas) => void } = {};
	const loaded: string[] = [];
	let depthBuilds = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: true,
		estimateAiDepth: async () => new Promise<typeof aiCanvas>((resolve) => {
			aiResolver.current = resolve;
		}),
		mergeAiDepth: (_heuristic, ai) => ai,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await Promise.resolve();

	ctl.setAiDepthEnabled(false);
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);

	aiResolver.current?.(aiCanvas);
	await Promise.resolve();
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(depthBuilds).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);
	expect(uniforms.uAiBoost.value).toBe(0);
	ctl.advanceDepth(0.18);
	expect(uniforms.uAiBoost.value).toBe(0.55);
});

test("setAiDepthEnabled(true) reuses cached AI depth after the current cover was already enhanced", async () => {
	const uniforms = makeUniforms();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const mergedAiCanvas = { width: 256, height: 256, label: "merged-ai-depth" };
	const loaded: string[] = [];
	let depthBuilds = 0;
	let aiRuns = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loaded.push(url);
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: true,
		estimateAiDepth: async () => {
			aiRuns += 1;
			return aiCanvas as never;
		},
		mergeAiDepth: () => mergedAiCanvas as never,
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(mergedAiCanvas);

	ctl.setAiDepthEnabled(false);
	await ctl.whenIdle();
	expect(uniforms.uEdgeTex.value.image).toBe(heuristicCanvas);

	ctl.setAiDepthEnabled(true);
	await ctl.whenIdle();

	expect(loaded).toEqual(["https://img.example/a.jpg"]);
	expect(depthBuilds).toBe(1);
	expect(aiRuns).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(mergedAiCanvas);
});

test("setCoverUrl(url) reuses prepared cover heuristic and AI depth across controllers", async () => {
	resetHomeCoverTextureCacheForTests();
	const heuristicCanvas = { width: 256, height: 256, label: "heuristic" };
	const aiCanvas = { width: 256, height: 256, label: "ai-depth" };
	const mergedAiCanvas = { width: 256, height: 256, label: "merged-ai-depth" };
	let loadCount = 0;
	let depthBuilds = 0;
	let aiRuns = 0;
	let mergeCount = 0;
	const makeController = (uniforms: ReturnType<typeof makeUniforms>) => createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => {
			loadCount += 1;
			return { width: 64, height: 64, src: url };
		},
		buildEdgeDepth: () => {
			depthBuilds += 1;
			return heuristicCanvas as never;
		},
		aiDepthEnabled: true,
		estimateAiDepth: async () => {
			aiRuns += 1;
			return aiCanvas as never;
		},
		mergeAiDepth: () => {
			mergeCount += 1;
			return mergedAiCanvas as never;
		},
	});
	const firstUniforms = makeUniforms();
	const first = makeController(firstUniforms);
	first.setCoverUrl("https://img.example/shared-depth.jpg");
	await first.whenIdle();
	expect(firstUniforms.uEdgeTex.value.image).toBe(mergedAiCanvas);

	const secondUniforms = makeUniforms();
	const second = makeController(secondUniforms);
	second.setCoverUrl("https://img.example/shared-depth.jpg");
	await second.whenIdle();

	expect(loadCount).toBe(1);
	expect(depthBuilds).toBe(1);
	expect(aiRuns).toBe(1);
	expect(mergeCount).toBe(1);
	expect(secondUniforms.uCoverTex.value.image).toEqual({ width: 64, height: 64, src: "https://img.example/shared-depth.jpg" });
	expect(secondUniforms.uEdgeTex.value.image).toBe(mergedAiCanvas);
});

test("a cache hit reconciles image leases into the current resource scope", async () => {
	const makeTrackingScope = (name: string) => {
		const raw = createVisualResourceScope(name);
		const handles: Array<{ disposed: boolean }> = [];
		const disposeCounts: number[] = [];
		const scope = {
			get name() { return raw.name; },
			get closed() { return raw.closed; },
			isOpen: () => raw.isOpen(),
			register(registration: Parameters<typeof raw.register>[0]) {
				const index = disposeCounts.push(0) - 1;
				const handle = raw.register({
					...registration,
					dispose() {
						disposeCounts[index] += 1;
						registration.dispose();
					},
				});
				handles.push(handle);
				return handle;
			},
			createChild: (childName: string) => raw.createChild(childName),
			releaseRetention: (retention: Parameters<typeof raw.releaseRetention>[0]) => raw.releaseRetention(retention),
			dispose: () => raw.dispose(),
		};
		return { scope, handles, disposeCounts };
	};
	const firstScope = makeTrackingScope("first-cover-cache");
	const secondScope = makeTrackingScope("second-cover-cache");
	const heuristic = { width: 16, height: 16 };
	let loads = 0;
	const makeController = (resourceScope: typeof firstScope.scope) => createHomeCoverTextureController({
		uniforms: makeUniforms() as never,
		loadImage: async () => { loads += 1; return { width: 8, height: 8 }; },
		buildEdgeDepth: () => heuristic as never,
		runtime: { resourceScope: resourceScope as never },
	});
	const first = makeController(firstScope.scope);
	first.setCoverUrl("https://img.example/reconcile.jpg");
	await first.whenIdle();
	const bytes = estimateHomeCoverTextureCacheBytes();
	expect(firstScope.handles.length).toBe(2);
	firstScope.scope.dispose();
	expect(firstScope.handles.every((handle) => handle.disposed)).toBe(true);

	const secondUniforms = makeUniforms();
	const second = createHomeCoverTextureController({
		uniforms: secondUniforms as never,
		loadImage: async () => { loads += 1; return { width: 8, height: 8 }; },
		buildEdgeDepth: () => heuristic as never,
		runtime: { resourceScope: secondScope.scope as never },
	});
	second.setCoverUrl("https://img.example/reconcile.jpg");
	await second.whenIdle();

	expect(loads).toBe(1);
	expect(secondUniforms.uHasCover.value).toBe(1);
	expect(secondScope.handles.length).toBe(2);
	expect(secondScope.handles.every((handle) => !handle.disposed)).toBe(true);
	expect(estimateHomeCoverTextureCacheBytes()).toBe(bytes);
	trimHomeCoverTextureCache(0);
	expect(firstScope.disposeCounts).toEqual([1, 1]);
	expect(secondScope.disposeCounts).toEqual([1, 1]);
});

test("disposing a resource scope detaches its cache lease bucket without a future hit or trim", async () => {
	const resourceScope = createVisualResourceScope("detached-cover-cache");
	const heuristic = { width: 16, height: 16 };
	const ctl = createHomeCoverTextureController({
		uniforms: makeUniforms() as never,
		loadImage: async () => ({ width: 8, height: 8 }),
		buildEdgeDepth: () => heuristic as never,
		runtime: { resourceScope },
	});
	ctl.setCoverUrl("https://img.example/detach-scope.jpg");
	await ctl.whenIdle();
	const bytes = estimateHomeCoverTextureCacheBytes();
	expect(countHomeCoverTextureCacheLeaseScopesForTests()).toBe(1);

	resourceScope.dispose();

	expect(countHomeCoverTextureCacheLeaseScopesForTests()).toBe(0);
	expect(estimateHomeCoverTextureCacheBytes()).toBe(bytes);
});

test("coverTextureSizeForResolution preserves baseline 256/384/512 thresholds", () => {
	expect(coverTextureSizeForResolution(0.75)).toBe(256);
	expect(coverTextureSizeForResolution(1.09)).toBe(256);
	expect(coverTextureSizeForResolution(1.10)).toBe(384);
	expect(coverTextureSizeForResolution(1.31)).toBe(384);
	expect(coverTextureSizeForResolution(1.32)).toBe(512);
	expect(coverTextureSizeForResolution(1.55)).toBe(512);
});

test("prepareSquareCoverCanvas crops the image center into a baseline square texture canvas", () => {
	const drawCalls: unknown[][] = [];
	const canvas = {
		width: 0,
		height: 0,
		getContext(type: string) {
			expect(type).toBe("2d");
			return {
				drawImage(...args: unknown[]) {
					drawCalls.push(args);
				},
			};
		},
	};
	const image = { naturalWidth: 800, naturalHeight: 600 };
	const result = prepareSquareCoverCanvas(image as never, {
		coverResolution: 1.55,
		createCanvas: () => canvas as never,
	});
	expect(result).toBe(canvas);
	expect(canvas.width).toBe(512);
	expect(canvas.height).toBe(512);
	expect(drawCalls).toEqual([[image, 100, 0, 600, 600, 0, 0, 512, 512]]);
});

test("dispose prevents a late unabortable cover load from publishing or entering cache", async () => {
	const uniforms = makeUniforms();
	const originalImage = uniforms.uCoverTex.value.image;
	let resolve: ((image: { width: number; height: number }) => void) | undefined;
	let preparedCalls = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: () => new Promise((done) => { resolve = done; }),
		onCoverPrepared: () => { preparedCalls += 1; },
	});
	ctl.setCoverUrl("https://img.example/late.jpg");
	ctl.dispose();
	resolve?.({ width: 64, height: 64 });
	await Promise.resolve();
	await Promise.resolve();

	expect(uniforms.uCoverTex.value.image).toBe(originalImage);
	expect(preparedCalls).toBe(0);
	expect(estimateHomeCoverTextureCacheBytes()).toBe(0);
	await ctl.whenIdle();
});

test("a stale queued AI result is rejected before the merger can mutate heuristic depth", async () => {
	const uniforms = makeUniforms();
	const cancellationScope = createCancellationScope("covers");
	const resourceScope = createVisualResourceScope("cover-resources");
	const ledger = createVisualResourceLedger({ budget: { textureBytes: 1_000_000, geometryBytes: 1_000_000, meshCount: 100, queuedTaskCost: 10, cacheBytes: 10_000_000 } });
	const taskQueue = createBudgetTaskQueue({ ledger, resourceScope, cancellationScope });
	let resolveAi: ((image: { width: number; height: number }) => void) | undefined;
	let merges = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async (url) => ({ width: 64, height: 64, src: url }),
		buildEdgeDepth: () => ({ width: 64, height: 64 }) as never,
		aiDepthEnabled: true,
		estimateAiDepth: () => new Promise((done) => { resolveAi = done; }),
		mergeAiDepth: (heuristic) => { merges += 1; return heuristic; },
		runtime: { cancellationScope, taskQueue, resourceScope },
	});
	ctl.setCoverUrl("https://img.example/a.jpg");
	taskQueue.runSlice(1);
	await Promise.resolve();
	await Promise.resolve();
	taskQueue.runSlice(1);
	ctl.setCoverUrl("https://img.example/b.jpg");
	resolveAi?.({ width: 64, height: 64 });
	await Promise.resolve();
	await Promise.resolve();

	expect(merges).toBe(0);
});

test("whenIdle settles for queue denial, queued cancellation, and task failure", async () => {
	const makeRuntime = () => {
		const cancellationScope = createCancellationScope("covers");
		const resourceScope = createVisualResourceScope("cover-resources");
		const ledger = createVisualResourceLedger({ budget: { textureBytes: 1, geometryBytes: 1, meshCount: 1, queuedTaskCost: 1, cacheBytes: 1 } });
		return { cancellationScope, resourceScope, taskQueue: createBudgetTaskQueue({ ledger, resourceScope, cancellationScope }) };
	};
	const deniedRuntime = makeRuntime();
	deniedRuntime.resourceScope.dispose();
	const denied = createHomeCoverTextureController({ uniforms: makeUniforms() as never, runtime: deniedRuntime });
	denied.setCoverUrl("https://img.example/denied.jpg");
	await denied.whenIdle();

	const cancelledRuntime = makeRuntime();
	const cancelled = createHomeCoverTextureController({ uniforms: makeUniforms() as never, loadImage: () => new Promise(() => {}), runtime: cancelledRuntime });
	cancelled.setCoverUrl("https://img.example/cancelled.jpg");
	cancelled.setRuntimeActive(false);
	await cancelled.whenIdle();

	const failedRuntime = makeRuntime();
	const failed = createHomeCoverTextureController({ uniforms: makeUniforms() as never, loadImage: async () => { throw new Error("broken"); }, runtime: failedRuntime });
	failed.setCoverUrl("https://img.example/failed.jpg");
	failedRuntime.taskQueue.runSlice(1);
	await failed.whenIdle();
});

test("direct AI commit failure settles without an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
	rejectionProcess.on("unhandledRejection", onUnhandled);
	try {
		const uniforms = makeUniforms();
		const heuristic = { width: 16, height: 16, label: "heuristic" };
		const ctl = createHomeCoverTextureController({
			uniforms: uniforms as never,
			loadImage: async () => ({ width: 16, height: 16 }),
			buildEdgeDepth: () => heuristic as never,
			aiDepthEnabled: true,
			estimateAiDepth: async () => ({ width: 16, height: 16, label: "ai" }) as never,
			mergeAiDepth: () => { throw new Error("merge boom"); },
		});
		ctl.setCoverUrl("https://img.example/direct-commit-failure.jpg");

		await ctl.whenIdle();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(unhandled).toEqual([]);
		expect(uniforms.uEdgeTex.value.image).toBe(heuristic);
	} finally {
		rejectionProcess.off("unhandledRejection", onUnhandled);
	}
});

test("a direct aborted AI task ignores its late result so the newer task remains resumable", async () => {
	const uniforms = makeUniforms();
	const heuristic = { width: 16, height: 16, label: "heuristic" };
	const enhanced = { width: 16, height: 16, label: "enhanced" };
	const resolvers: Array<(image: typeof enhanced) => void> = [];
	const signals: AbortSignal[] = [];
	let aiRuns = 0;
	let merges = 0;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async () => ({ width: 16, height: 16 }),
		buildEdgeDepth: () => heuristic as never,
		aiDepthEnabled: true,
		estimateAiDepth: async (_image, signal) => {
			aiRuns += 1;
			if (signal) signals.push(signal);
			return await new Promise<typeof enhanced>((resolve) => { resolvers.push(resolve); });
		},
		mergeAiDepth: (_base, ai) => { merges += 1; return ai; },
	});
	const url = "https://img.example/direct-late-ai.jpg";
	ctl.setCoverUrl(url);
	for (let index = 0; index < 10 && aiRuns < 1; index += 1) await Promise.resolve();
	expect(aiRuns).toBe(1);

	ctl.setAiDepthEnabled(false);
	ctl.setAiDepthEnabled(true);
	expect(aiRuns).toBe(2);
	expect(signals[0]?.aborted).toBe(true);
	resolvers[0]?.(enhanced);
	await Promise.resolve();
	await Promise.resolve();

	ctl.setRuntimeActive(false);
	expect(signals[1]?.aborted).toBe(true);
	ctl.setRuntimeActive(true);
	ctl.setCoverUrl(url);
	expect(aiRuns).toBe(3);

	resolvers[2]?.(enhanced);
	await ctl.whenIdle();
	resolvers[1]?.(enhanced);
	await Promise.resolve();
	await Promise.resolve();
	expect(merges).toBe(1);
	expect(uniforms.uEdgeTex.value.image).toBe(enhanced);
});

test("the global cache keeps 18 LRU entries and promotes hits", async () => {
	let loads = 0;
	const makeController = () => createHomeCoverTextureController({
		uniforms: makeUniforms() as never,
		loadImage: async (url) => { loads += 1; return { width: 8, height: 8, src: url }; },
	});
	for (let index = 0; index < 18; index += 1) {
		const ctl = makeController();
		ctl.setCoverUrl(`https://img.example/${index}.jpg`);
		await ctl.whenIdle();
	}
	const hit = makeController();
	hit.setCoverUrl("https://img.example/0.jpg");
	await hit.whenIdle();
	const newest = makeController();
	newest.setCoverUrl("https://img.example/18.jpg");
	await newest.whenIdle();
	const retained = makeController();
	retained.setCoverUrl("https://img.example/0.jpg");
	await retained.whenIdle();
	const evicted = makeController();
	evicted.setCoverUrl("https://img.example/1.jpg");
	await evicted.whenIdle();

	expect(loads).toBe(20);
});

test("cache byte estimates deduplicate identical heuristic and AI objects", async () => {
	const sharedDepth = { width: 32, height: 16 };
	const ctl = createHomeCoverTextureController({
		uniforms: makeUniforms() as never,
		loadImage: async () => ({ width: 8, height: 4 }),
		buildEdgeDepth: () => sharedDepth as never,
		aiDepthEnabled: true,
		estimateAiDepth: async () => sharedDepth as never,
		mergeAiDepth: (heuristic) => heuristic,
	});
	ctl.setCoverUrl("https://img.example/dedup.jpg");
	await ctl.whenIdle();

	expect(estimateHomeCoverTextureCacheBytes()).toBe(8 * 4 * 4 + 32 * 16 * 4);
});

test("trim(0) releases cache references without changing visible uniforms", async () => {
	const uniforms = makeUniforms();
	const ctl = createHomeCoverTextureController({ uniforms: uniforms as never, loadImage: async () => ({ width: 8, height: 8 }) });
	ctl.setCoverUrl("https://img.example/visible.jpg");
	await ctl.whenIdle();
	const texture = uniforms.uCoverTex.value;
	const image = texture.image;

	trimHomeCoverTextureCache(0);

	expect(estimateHomeCoverTextureCacheBytes()).toBe(0);
	expect(uniforms.uCoverTex.value).toBe(texture);
	expect(uniforms.uCoverTex.value.image).toBe(image);
	expect(uniforms.uHasCover.value).toBe(1);
});

test("cache registration denial still displays the current cover", async () => {
	const uniforms = makeUniforms();
	const denyingScope = {
		isOpen: () => true,
		register() { throw new Error("budget denied"); },
	} as never;
	const ctl = createHomeCoverTextureController({
		uniforms: uniforms as never,
		loadImage: async () => ({ width: 8, height: 8 }),
		runtime: { resourceScope: denyingScope },
	});
	ctl.setCoverUrl("https://img.example/denied-cache.jpg");
	await ctl.whenIdle();

	expect(uniforms.uHasCover.value).toBe(1);
	expect(estimateHomeCoverTextureCacheBytes()).toBe(0);
});

test("eviction and repeated trim dispose every cache lease exactly once", async () => {
	const disposeCounts: number[] = [];
	const resourceScope = {
		isOpen: () => true,
		register() {
			const index = disposeCounts.push(0) - 1;
			let disposed = false;
			return {
				get disposed() { return disposed; },
				dispose() {
					if (!disposed) disposeCounts[index] += 1;
					disposed = true;
					return { disposed: 1, errors: [] };
				},
			};
		},
	} as never;
	for (let index = 0; index < 19; index += 1) {
		const ctl = createHomeCoverTextureController({ uniforms: makeUniforms() as never, loadImage: async () => ({ width: 8, height: 8 }), runtime: { resourceScope } });
		ctl.setCoverUrl(`https://img.example/lease-${index}.jpg`);
		await ctl.whenIdle();
	}
	expect(disposeCounts.filter((count) => count === 1)).toHaveLength(1);
	trimHomeCoverTextureCache(0);
	trimHomeCoverTextureCache(0);
	expect(disposeCounts.every((count) => count === 1)).toBe(true);
});
