import { expect, test } from "bun:test";
import {
	FLIP_CLEANUP_MS,
	FLIP_THRESHOLD_PX,
	captureFlipSnapshot,
	computeFlipDeltas,
	flipEntriesFromContainer,
	flipSignature,
} from "./useFlipReorder";

function entry(key: string, left: number, top: number) {
	return { key, left, top };
}

test("computeFlipDeltas returns inverse translations for moved keys", () => {
	const before = [entry("netease", 10, 0), entry("qq", 10, 60), entry("soda", 10, 120)];
	const after = [entry("soda", 10, 0), entry("netease", 10, 60), entry("qq", 10, 120)];
	const deltas = computeFlipDeltas(before, after);
	expect(deltas.get("netease")).toEqual({ dx: 0, dy: -60 });
	expect(deltas.get("qq")).toEqual({ dx: 0, dy: -60 });
	expect(deltas.get("soda")).toEqual({ dx: 0, dy: 120 });
});

test("computeFlipDeltas skips sub-pixel movement below the upstream threshold", () => {
	expect(FLIP_THRESHOLD_PX).toBe(0.5);
	const before = [
		entry("still", 4.2, 8.1),
		entry("tiny", 4.2, 8.1),
		entry("moved", 0, 0),
	];
	const after = [
		entry("still", 4.6, 8.4), // |dx|、|dy| 均 < 0.5 → 跳过
		entry("tiny", 4.7, 8.6), // dy = 0.5，达到阈值 → 保留
		entry("moved", 3, 9),
	];
	const deltas = computeFlipDeltas(before, after);
	expect(deltas.has("still")).toBe(false);
	expect(deltas.get("tiny")).toEqual({ dx: -0.5, dy: -0.5 });
	expect(deltas.get("moved")).toEqual({ dx: -3, dy: -9 });
});

test("computeFlipDeltas supports a custom threshold", () => {
	const before = [entry("a", 0, 0), entry("b", 0, 0)];
	const after = [entry("a", 2, 0), entry("b", 0, 2)];
	expect(computeFlipDeltas(before, after, 4).size).toBe(0);
	expect(computeFlipDeltas(before, after, 1).size).toBe(2);
});

test("computeFlipDeltas ignores keys that only exist in the after snapshot", () => {
	const before = [entry("old", 0, 0)];
	const after = [entry("new", 0, 0), entry("old", 5, 5)];
	const deltas = computeFlipDeltas(before, after);
	expect(deltas.size).toBe(1);
	expect(deltas.has("new")).toBe(false);
});

test("flipSignature is order-sensitive and stable for identical sequences", () => {
	const first = [{ key: "netease" }, { key: "qq" }, { key: "soda" }];
	const same = [{ key: "netease" }, { key: "qq" }, { key: "soda" }];
	const reordered = [{ key: "soda" }, { key: "qq" }, { key: "netease" }];
	expect(flipSignature(first)).toBe(flipSignature(same));
	expect(flipSignature(first)).not.toBe(flipSignature(reordered));
	expect(flipSignature([])).toBe("");
});

test("captureFlipSnapshot reads element rects into comparable entries", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	const first = document.createElement("div");
	first.setAttribute("data-flip-key", "netease");
	const second = document.createElement("div");
	second.setAttribute("data-flip-key", "qq");
	container.append(first, second);

	const snapshot = captureFlipSnapshot([
		{ key: "netease", el: first },
		{ key: "qq", el: second },
	]);
	expect(snapshot.map((item) => item.key)).toEqual(["netease", "qq"]);
	for (const item of snapshot) {
		expect(typeof item.top).toBe("number");
		expect(typeof item.left).toBe("number");
	}
});

test("flipEntriesFromContainer collects only data-flip-key children in DOM order", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const container = document.createElement("div");
	const row = document.createElement("div");
	row.setAttribute("data-flip-key", "soda");
	const unmarked = document.createElement("div");
	const emptyMark = document.createElement("span");
	emptyMark.setAttribute("data-flip-key", "");
	container.append(row, unmarked, emptyMark);

	const entries = flipEntriesFromContainer(container);
	expect(entries.map(({ key }) => key)).toEqual(["soda"]);
	expect(flipEntriesFromContainer(null)).toEqual([]);
});

test("cleanup window stays inside the upstream animation budget", () => {
	expect(FLIP_CLEANUP_MS).toBe(280);
});
