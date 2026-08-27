/** 推荐模块行的横向滚轮控制。
 *
 * 客户端交互约定：
 * - 鼠标悬停在模块行上滚动滚轮 → 行内横向滚动（隐藏原生横向滚动条）
 * - 悬停在空白区域滚动 → 页面照常上下滚动
 * - 行已到尽头时**吞掉事件、页面保持不动**：用"滚不动了"的体感告知到头，
 *   绝不交还给页面竖向滚动——否则用户会以"页面突然动了"才发现到头，非常难受
 *
 * 区域划分：右侧靠近竖向滚动条预留一条竖向滚动区（视口宽度的
 * VERTICAL_ZONE_RATIO 比例），光标落在该区域内时无论是否压在模块行上，
 * 滚轮一律固定为上下滚动，避免模块排布紧密时用户误触横向滚动。
 *
 * 用 document 级事件委托：主页预览与独立推荐页共用同一套类名，一处挂载全覆盖。
 */
const ROW_SELECTOR =
	".home-recommendation-track-row, .home-recommendation-netease-mixed-row, .home-recommendation-tile-row";

/** 右侧竖向滚动保留区：占布局视口宽度的比例，从右缘向左计 */
export const VERTICAL_ZONE_RATIO = 0.2;

export function attachRecommendationRowWheelScroll(
	doc: Document,
): () => void {
	const onWheel = (event: WheelEvent) => {
		// 右侧预留区固定上下滚动：不拦截、不改向
		if (
			event.clientX >
			doc.documentElement.clientWidth * (1 - VERTICAL_ZONE_RATIO)
		) {
			return;
		}
		const target = event.target as Element | null;
		const row = target?.closest?.(ROW_SELECTOR);
		if (!(row instanceof HTMLElement)) return;
		const maxScroll = row.scrollWidth - row.clientWidth;
		if (maxScroll <= 1) return;
		// 强制横向：到尽头也只吞掉事件让滚轮"空转"，页面纹丝不动
		event.preventDefault();
		const delta = event.deltaY;
		if (
			(delta > 0 && row.scrollLeft >= maxScroll - 1) ||
			(delta < 0 && row.scrollLeft <= 1)
		) {
			return;
		}
		row.scrollLeft = Math.max(0, Math.min(maxScroll, row.scrollLeft + delta));
	};

	doc.addEventListener("wheel", onWheel, { passive: false });
	return () => doc.removeEventListener("wheel", onWheel);
}
