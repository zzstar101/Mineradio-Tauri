import { useCallback, useRef } from "react";

/** 上游 FLIP 动画参数：.26s cubic-bezier(.18,.86,.24,1)，280ms 后清理。 */
export const FLIP_TRANSITION = "transform .26s cubic-bezier(.18,.86,.24,1)";
export const FLIP_CLEANUP_MS = 280;
export const FLIP_THRESHOLD_PX = 0.5;
export const PROVIDER_DRAG_THRESHOLD_PX = 4;

export interface FlipSnapshotEntry {
	key: string;
	top: number;
	left: number;
}

export interface FlipDelta {
	dx: number;
	dy: number;
}

export interface FlipTrackedElement {
	key: string;
	el: Element;
}

interface PendingFlip {
	snapshot: FlipSnapshotEntry[];
	signature: string;
}

/** DOM 读取：抓取各 tracked 元素的当前几何位置。 */
export function captureFlipSnapshot(
	entries: Iterable<FlipTrackedElement>,
): FlipSnapshotEntry[] {
	const snapshot: FlipSnapshotEntry[] = [];
	for (const { key, el } of entries) {
		const rect = el.getBoundingClientRect();
		snapshot.push({ key, top: rect.top, left: rect.left });
	}
	return snapshot;
}

/**
 * 纯数学：对比前后两次快照，返回每个 key 的反向位移（FLIP 的 Invert 步骤）。
 * |dx|、|dy| 都小于 threshold 时跳过该元素。
 */
export function computeFlipDeltas(
	before: readonly FlipSnapshotEntry[],
	after: readonly FlipSnapshotEntry[],
	threshold: number = FLIP_THRESHOLD_PX,
): Map<string, FlipDelta> {
	const deltas = new Map<string, FlipDelta>();
	const beforeByKey = new Map(before.map((entry) => [entry.key, entry]));
	for (const entry of after) {
		const previous = beforeByKey.get(entry.key);
		if (!previous) continue;
		const dx = previous.left - entry.left;
		const dy = previous.top - entry.top;
		if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) continue;
		deltas.set(entry.key, { dx, dy });
	}
	return deltas;
}

/** 纯函数：key 序列签名，用于识别“快照后顺序其实没变”的情况。 */
export function flipSignature(entries: Iterable<{ key: string }>): string {
	let signature = "";
	for (const entry of entries) signature += `${entry.key}|`;
	return signature;
}

/** 从容器中收集带 data-flip-key 标记的可动画元素。 */
export function flipEntriesFromContainer(
	container: Element | null,
): FlipTrackedElement[] {
	if (!container) return [];
	const entries: FlipTrackedElement[] = [];
	for (const child of container.querySelectorAll("[data-flip-key]")) {
		const key = child.getAttribute("data-flip-key");
		if (!key) continue;
		entries.push({ key, el: child });
	}
	return entries;
}

function applyFlipTransforms(
	tracked: readonly FlipTrackedElement[],
	deltas: ReadonlyMap<string, FlipDelta>,
): boolean {
	const moved: HTMLElement[] = [];
	for (const { key, el } of tracked) {
		const delta = deltas.get(key);
		if (!delta || !(el instanceof HTMLElement)) continue;
		el.style.transition = "none";
		el.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
		moved.push(el);
	}
	if (moved.length === 0) return false;
	requestAnimationFrame(() => {
		for (const el of moved) {
			el.style.transition = FLIP_TRANSITION;
			el.style.transform = "";
		}
		window.setTimeout(() => {
			for (const el of moved) el.style.transition = "";
		}, FLIP_CLEANUP_MS);
	});
	return true;
}

export interface FlipReorderController {
	/** 状态更新前调用：记录当前几何快照与 key 签名。 */
	capture(entries: Iterable<FlipTrackedElement>): void;
	/** 提交后的 useLayoutEffect 中调用：消费快照并播放 FLIP；返回是否触发动画。 */
	replay(entries: Iterable<FlipTrackedElement>): boolean;
}

/**
 * 可复用的 FLIP 重排控制器：
 * capture() 在调用 setState / commit 前执行，replay() 在重渲染提交后执行。
 * 快照一次性消费；若顺序签名未变化则静默丢弃，避免失败回滚后误播动画。
 */
export function useFlipReorder(): FlipReorderController {
	const pendingRef = useRef<PendingFlip | null>(null);

	const capture = useCallback((entries: Iterable<FlipTrackedElement>) => {
		pendingRef.current = {
			snapshot: captureFlipSnapshot(entries),
			signature: flipSignature(entries),
		};
	}, []);

	const replay = useCallback((entries: Iterable<FlipTrackedElement>): boolean => {
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (!pending) return false;
		const tracked = [...entries];
		if (flipSignature(tracked) === pending.signature) return false;
		const after = captureFlipSnapshot(tracked);
		const deltas = computeFlipDeltas(pending.snapshot, after);
		if (deltas.size === 0) return false;
		return applyFlipTransforms(tracked, deltas);
	}, []);

	return { capture, replay };
}
