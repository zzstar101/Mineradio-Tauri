import type { Track } from "@mineradio/shared";

/** 歌单详情单页数量（硬编码起步，后续可接入用户设置）。 */
export const HOME_PLAYLIST_PAGE_SIZE = 20;

/** 详情页底部常驻的空占位行数。 */
export const HOME_PLAYLIST_SKELETON_COUNT = 5;

/** 距底部多少像素内触发加载下一页。 */
export const HOME_PLAYLIST_LOAD_MORE_THRESHOLD_PX = 400;

/**
 * 把一页按它的请求 offset 直接写回列表：截断到 offset，再顺序补上该页。
 * 与"追加+去重"的区别：重复/陈旧的页只是覆盖自己那段区间，
 * 永远不会制造"没有新增"的假象，也就不会误判歌单已到尽头。
 */
export function applyPlaylistPageAtOffset(
	existing: Track[],
	offset: number,
	incoming: Track[],
): Track[] {
	if (incoming.length === 0) return existing;
	const base = Math.min(Math.max(0, offset), existing.length);
	return [...existing.slice(0, base), ...incoming];
}

/**
 * 是否还有下一页：
 * - 服务端 hasMore 权威信号优先（true/false 直接采信）；
 * - 未提供时退回启发式：空页/短页（服务端提前截断）/总数载满 → 判尽。
 *   注意短页判尽对"窗口内跳过不可用歌曲"的服务端会误判，
 *   因此只作为无信号时的兜底。
 */
export function playlistHasNextPage(input: {
	hasMore?: boolean | null;
	loadedCount: number;
	pageCount: number;
	pageSize: number;
	totalCount?: number | null;
}): boolean {
	if (input.hasMore != null) return input.hasMore;
	if (input.pageCount === 0) return false;
	if (input.totalCount != null && input.loadedCount >= input.totalCount) {
		return false;
	}
	if (input.pageCount < input.pageSize) return false;
	return true;
}
