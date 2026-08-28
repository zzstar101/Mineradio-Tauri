import { useEffect, useRef, useState } from "react";

/**
 * Mini queue long-press drag reorder (upstream S010/S066 semantics).
 *
 * Upstream: long-press a `.mini-queue-item` (~520ms) to lift it, drag to the
 * target row, release to reorder. Pointer travel beyond 9px before lift
 * cancels. Click after a drag/reorder is suppressed so the play click cannot
 * fire accidentally. Index math is index-based so a virtualized
 * `#mini-queue-list` keeps working (rows carry `data-queue-index`).
 */
export interface MiniQueueReorderOptions {
	containerRef: React.RefObject<HTMLElement | null>;
	rowSelector?: string;
	indexAttr?: string;
	enabled: boolean;
	longPressMs?: number;
	moveCancelPx?: number;
	onMove(fromIndex: number, toIndex: number): void;
	timers?: {
		setTimeout: typeof window.setTimeout;
		clearTimeout: typeof window.clearTimeout;
	};
}

export interface MiniQueueReorderState {
	active: boolean;
	draggingIndex: number | null;
}

export function useMiniQueueReorder({
	containerRef,
	rowSelector = ".mini-queue-item",
	indexAttr = "data-queue-index",
	enabled,
	longPressMs = 520,
	moveCancelPx = 9,
	onMove,
	timers,
}: MiniQueueReorderOptions): MiniQueueReorderState {
	const setTimeoutRef =
		timers?.setTimeout
		?? (globalThis.setTimeout
			? globalThis.setTimeout.bind(globalThis)
			: ((() => 0) as typeof window.setTimeout));
	const clearTimeoutRef =
		timers?.clearTimeout
		?? (globalThis.clearTimeout
			? globalThis.clearTimeout.bind(globalThis)
			: ((() => undefined) as typeof window.clearTimeout));
	const onMoveRef = useRef(onMove);
	onMoveRef.current = onMove;

	const [state, setState] = useState<MiniQueueReorderState>({
		active: false,
		draggingIndex: null,
	});
	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !enabled) return;

		let timer = 0;
		let active = false;
		let fromIndex = -1;
		let startX = 0;
		let startY = 0;
		let suppressClickUntil = 0;

		const clearTimer = () => {
			if (timer) {
				clearTimeoutRef(timer as unknown as number);
				timer = 0;
			}
		};
		const syncState = (nextActive: boolean, nextIndex: number | null) => {
			active = nextActive;
			fromIndex = nextActive ? fromIndex : nextIndex ?? -1;
			setState((current) =>
				current.active === nextActive && current.draggingIndex === nextIndex
					? current
					: { active: nextActive, draggingIndex: nextIndex },
			);
		};
		const endDrag = (suppressClick: boolean) => {
			if (suppressClick && active) suppressClickUntil = performance.now() + 520;
			clearTimer();
			const wasActive = active;
			syncState(false, null);
			if (wasActive || active) {
				document.body.classList.remove("panel-reordering");
				container
					.querySelectorAll(".is-reordering, .reorder-pressing")
					.forEach((node) => node.classList.remove("is-reordering", "reorder-pressing"));
			}
		};

		const blockedTarget = (target: EventTarget | null): boolean => {
			if (!(target instanceof Element)) return true;
			return !!target.closest("button,a,input,textarea,select");
		};

		const onPointerDown = (event: PointerEvent) => {
			if (active) return;
			if (event.pointerType === "touch" && event.isPrimary === false) return;
			if (blockedTarget(event.target)) return;
			const row = (event.target as Element).closest(rowSelector);
			if (!row || !container.contains(row)) return;
			const index = Number(row.getAttribute(indexAttr));
			if (!Number.isFinite(index)) return;

			startX = event.clientX;
			startY = event.clientY;
			fromIndex = index;

			clearTimer();
			timer = setTimeoutRef(() => {
				timer = 0;
				active = true;
				row.classList.add("is-reordering");
				row.classList.add("reorder-pressing");
				document.body.classList.add("panel-reordering");
				try {
					row.setPointerCapture?.(event.pointerId);
				} catch {
					/* capture best-effort */
				}
				setState({ active: true, draggingIndex: fromIndex });
			}, longPressMs) as unknown as number;
		};

		const onPointerMove = (event: PointerEvent) => {
			if (timer && fromIndex >= 0) {
				const dx = event.clientX - startX;
				const dy = event.clientY - startY;
				if (Math.hypot(dx, dy) > moveCancelPx) {
					fromIndex = -1;
					clearTimer();
				}
			}
		};

		const onPointerUp = (event: PointerEvent) => {
			if (!active) {
				clearTimer();
				fromIndex = -1;
				return;
			}
			const sourceIndex = fromIndex;
			let toIndex = sourceIndex;
			const hit = document.elementFromPoint(event.clientX, event.clientY);
			const targetRow = hit?.closest(rowSelector);
			const targetIndex = Number(targetRow?.getAttribute(indexAttr));
			if (Number.isFinite(targetIndex) && targetIndex !== sourceIndex) toIndex = targetIndex;
			endDrag(true);
			if (sourceIndex >= 0 && toIndex >= 0 && toIndex !== sourceIndex) {
				onMoveRef.current(sourceIndex, toIndex);
			}
		};

		const onPointerCancel = () => endDrag(false);
		const onClickCapture = (event: MouseEvent) => {
			if (suppressClickUntil > performance.now()) {
				event.preventDefault();
				event.stopPropagation();
			}
		};

		container.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
		document.addEventListener("click", onClickCapture, true);
		return () => {
			clearTimer();
			container.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			document.removeEventListener("click", onClickCapture, true);
			document.body.classList.remove("panel-reordering");
		};
	}, [clearTimeoutRef, containerRef, enabled, indexAttr, longPressMs, moveCancelPx, rowSelector, setTimeoutRef]);

	void stateRef;
	return state;
}