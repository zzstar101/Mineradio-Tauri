import { expect, test } from "bun:test";
import {
	AVAILABLE_PROVIDERS,
	PROVIDER_KEYS,
	accountProviderOrderRecord,
	moveBeforePure,
	normalizeAccountProviderKey,
	normalizeAccountProviderList,
	orderedAvailableProviders,
	sameProviderSequence,
	type ProviderKey,
} from "./providerOrderCore";
import { ACCOUNT_PROVIDER_ORDER_PREFERENCE } from "../../preferences/keys";

test("normalizeAccountProviderKey accepts known keys and the qishui alias", () => {
	expect(normalizeAccountProviderKey("netease")).toBe("netease");
	expect(normalizeAccountProviderKey(" qq ")).toBe("qq");
	expect(normalizeAccountProviderKey("SODA")).toBe("soda");
	expect(normalizeAccountProviderKey("qishui")).toBe("soda");
	expect(normalizeAccountProviderKey("Qishui")).toBe("soda");
	expect(normalizeAccountProviderKey("kugou")).toBe("kugou");
	expect(normalizeAccountProviderKey("spotify")).toBe("spotify");
});

test("normalizeAccountProviderKey rejects unknown or malformed keys", () => {
	expect(normalizeAccountProviderKey("apple-music")).toBeNull();
	expect(normalizeAccountProviderKey("")).toBeNull();
	expect(normalizeAccountProviderKey("   ")).toBeNull();
	expect(normalizeAccountProviderKey(42)).toBeNull();
	expect(normalizeAccountProviderKey(null)).toBeNull();
	expect(normalizeAccountProviderKey({ id: "qq" })).toBeNull();
});

test("normalizeAccountProviderList drops unknown keys, dedupes preserve-first and appends missing available providers", () => {
	const normalized = normalizeAccountProviderList({
		order: ["qq", "unknown-provider", "qq", "netease"],
		visible: [],
	});
	expect(normalized.order).toEqual(["qq", "netease", "kugou", "soda"]);
	expect(normalized.visible).toEqual([]);
});

test("normalizeAccountProviderList maps the qishui alias onto soda in both arrays", () => {
	const normalized = normalizeAccountProviderList({
		order: ["qishui", "netease", "qq"],
		visible: ["qishui"],
	});
	expect(normalized.order).toEqual(["soda", "netease", "qq", "kugou"]);
	expect(normalized.visible).toEqual(["soda"]);
});

test("normalizeAccountProviderList keeps blocked providers in order but excludes them from visible", () => {
	const normalized = normalizeAccountProviderList({
		order: ["kugou", "spotify", "netease", "qq", "soda"],
		visible: ["kugou", "spotify", "qq"],
	});
	expect(normalized.order).toEqual([
		"kugou",
		"spotify",
		"netease",
		"qq",
		"soda",
	]);
	expect(normalized.visible).toEqual(["kugou", "qq"]);
});

test("normalizeAccountProviderList caps the order array at PROVIDER_KEYS length", () => {
	const noisy = [...PROVIDER_KEYS, "netease", "qq", "soda"];
	const normalized = normalizeAccountProviderList({ order: noisy });
	expect(normalized.order.length).toBe(PROVIDER_KEYS.length);
	expect(normalized.order).toEqual([...PROVIDER_KEYS]);
});

test("normalizeAccountProviderList falls back to defaults on malformed input", () => {
	for (const malformed of [
		null,
		undefined,
		42,
		"qq",
		{ order: "qq", visible: [] },
		{ order: [1, true], visible: {} },
	]) {
		const normalized = normalizeAccountProviderList(malformed);
		expect(normalized.order).toEqual([...AVAILABLE_PROVIDERS]);
		expect(normalized.visible).toEqual([]);
	}
});

test("empty visible means nothing is hidden; validated visible drives hidden set", () => {
	const nothingHidden = normalizeAccountProviderList({ order: [], visible: [] });
	expect(nothingHidden.visible).toEqual([]);

	const partial = normalizeAccountProviderList({ order: [], visible: ["soda"] });
	expect(partial.visible).toEqual(["soda"]);
	expect(orderedAvailableProviders(partial.order)).toEqual([
		"netease",
		"qq",
		"kugou",
		"soda",
	]);
});

test("moveBeforePure mirrors upstream moveAccountProviderBefore semantics", () => {
	const base = ["netease", "qq", "soda"] as const;

	// 移除 provider 后插到 target 之前。
	expect(moveBeforePure([...base], "soda", "netease")).toEqual([
		"soda",
		"netease",
		"qq",
	]);
	// target 是 provider 自己的直接后继 → 移除后插回原位，等于无变化。
	expect(moveBeforePure([...base], "netease", "qq")).toEqual([
		"netease",
		"qq",
		"soda",
	]);

	// target 不在列表中 → 追加到末尾。
	expect(moveBeforePure([...base], "netease", "kugou")).toEqual([
		"qq",
		"soda",
		"netease",
	]);

	// provider === target：移除后 target 缺失 → 按契约追加到末尾。
	expect(moveBeforePure([...base], "netease", "netease")).toEqual([
		"qq",
		"soda",
		"netease",
	]);
});

test("moveBeforePure preserves the relative order of untouched providers", () => {
	const order: ProviderKey[] = ["spotify", "netease", "kugou", "qq", "soda"];
	expect(moveBeforePure(order, "kugou", "spotify")).toEqual([
		"kugou",
		"spotify",
		"netease",
		"qq",
		"soda",
	]);
});

test("sameProviderSequence compares element-wise", () => {
	const seq = (...keys: ProviderKey[]): ProviderKey[] => keys;
	expect(sameProviderSequence(seq("qq", "netease"), seq("qq", "netease"))).toBe(
		true,
	);
	expect(sameProviderSequence(seq("qq", "netease"), seq("netease", "qq"))).toBe(
		false,
	);
	expect(sameProviderSequence(seq("qq"), seq("qq", "netease"))).toBe(false);
});

test("canonical record round-trips through the typed preference key", () => {
	const state = normalizeAccountProviderList({
		order: ["qishui", "spotify", "qq", "netease", "soda"],
		visible: ["soda"],
	});
	const record = accountProviderOrderRecord(state);
	expect(record).toEqual({
		version: 1,
		order: ["soda", "spotify", "qq", "netease", "kugou"],
		visible: ["soda"],
	});
	expect(ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse(record)).toEqual(record);

	const stored = ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse(record);
	expect(normalizeAccountProviderList(stored)).toEqual(state);
});

test("typed preference key rejects records without version 1 shape", () => {
	expect(
		ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse({ version: 2, order: [], visible: [] }),
	).toBe(undefined);
	expect(
		ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse({ version: 1, order: "qq" }),
	).toBe(undefined);
	expect(
		ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse({ version: 1 }),
	).toBe(undefined);
	expect(ACCOUNT_PROVIDER_ORDER_PREFERENCE.defaultValue()).toEqual({
		version: 1,
		order: [],
		visible: [],
	});
});
