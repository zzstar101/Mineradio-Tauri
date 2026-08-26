import { ACCOUNT_PROVIDER_ORDER_PREFERENCE, type JsonObject } from "../../preferences/keys";

/**
 * 上游 Mineradio v2.1.0 的账号 Provider 全集。
 * kugou / spotify 由 MineRadio-api 侧封锁（blocked_by），永不参与渲染，
 * 但允许出现在持久化 order 中，便于后续解锁时保留用户既有排序。
 */
export const PROVIDER_KEYS = [
	"netease",
	"qq",
	"soda",
	"kugou",
	"spotify",
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

/** 当前可渲染的账号 Provider；与 LOGIN_QR_PROVIDERS 保持一致。 */
export const AVAILABLE_PROVIDERS = ["netease", "qq", "soda"] as const;

export type AvailableProviderKey = (typeof AVAILABLE_PROVIDERS)[number];

const PROVIDER_KEY_SET: ReadonlySet<string> = new Set<string>(PROVIDER_KEYS);
const AVAILABLE_PROVIDER_SET: ReadonlySet<string> = new Set<string>(
	AVAILABLE_PROVIDERS,
);

export interface AccountProviderOrderState {
	order: ProviderKey[];
	visible: ProviderKey[];
}

/**
 * 归一化单个 Provider key：qishui → soda 内部别名、去空白、大小写不敏感。
 */
export function normalizeAccountProviderKey(key: unknown): ProviderKey | null {
	if (typeof key !== "string") return null;
	const candidate = key.trim().toLowerCase();
	if (!candidate) return null;
	const aliased = candidate === "qishui" ? "soda" : candidate;
	return PROVIDER_KEY_SET.has(aliased) ? (aliased as ProviderKey) : null;
}

function normalizeProviderSequence(raw: unknown[]): ProviderKey[] {
	const sequence: ProviderKey[] = [];
	const seen = new Set<ProviderKey>();
	for (const candidate of raw) {
		const key = normalizeAccountProviderKey(candidate);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		sequence.push(key);
		// order 数组长度以 PROVIDER_KEYS 全集为上限。
		if (sequence.length >= PROVIDER_KEYS.length) break;
	}
	return sequence;
}

/**
 * 归一化持久化的 Provider 排序记录：
 * - 丢弃未知 key、按先出现顺序去重；
 * - 追加缺失的 AVAILABLE provider（保证三个可用平台永远在列表里）；
 * - visible 只保留 AVAILABLE 子集；空 visible 表示没有任何平台被隐藏。
 */
export function normalizeAccountProviderList(
	value: unknown,
): AccountProviderOrderState {
	const record =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: null;
	const rawOrder = record && Array.isArray(record.order) ? record.order : [];
	const rawVisible =
		record && Array.isArray(record.visible) ? record.visible : [];

	const order = normalizeProviderSequence(rawOrder);
	const seen = new Set<ProviderKey>(order);
	for (const key of AVAILABLE_PROVIDERS) {
		if (!seen.has(key)) {
			seen.add(key);
			order.push(key);
		}
	}

	const visible: ProviderKey[] = [];
	const visibleSeen = new Set<ProviderKey>();
	for (const candidate of rawVisible) {
		const key = normalizeAccountProviderKey(candidate);
		if (
			!key ||
			!AVAILABLE_PROVIDER_SET.has(key) ||
			visibleSeen.has(key)
		) {
			continue;
		}
		visibleSeen.add(key);
		visible.push(key);
	}

	return { order, visible };
}

/**
 * 镜像上游 moveAccountProviderBefore：移除 provider 后插到 target 之前；
 * target 不在列表中（含 provider === target）则追加到末尾。
 */
export function moveBeforePure(
	order: readonly ProviderKey[],
	provider: ProviderKey,
	beforeProvider: ProviderKey,
): ProviderKey[] {
	const next = order.filter((key) => key !== provider);
	const targetIndex = next.indexOf(beforeProvider);
	if (targetIndex >= 0) {
		next.splice(targetIndex, 0, provider);
	} else {
		next.push(provider);
	}
	return next;
}

/** 渲染视图 = normalized(order) ∩ AVAILABLE，保持持久化顺序。 */
export function orderedAvailableProviders(
	order: readonly ProviderKey[],
): AvailableProviderKey[] {
	return order.filter((key): key is AvailableProviderKey =>
		AVAILABLE_PROVIDER_SET.has(key),
	);
}

/** 持久化前的 canonical 记录；schema 拒绝视为编程错误并抛出。 */
export function accountProviderOrderRecord(
	state: AccountProviderOrderState,
): JsonObject {
	const parsed = ACCOUNT_PROVIDER_ORDER_PREFERENCE.parse({
		version: 1,
		order: [...state.order],
		visible: [...state.visible],
	});
	if (!parsed) throw new Error("ACCOUNT_PROVIDER_ORDER_SCHEMA_INVALID");
	return parsed;
}

export function sameProviderSequence(
	left: readonly ProviderKey[],
	right: readonly ProviderKey[],
): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}
