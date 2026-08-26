import {
	useCallback,
	useEffect,
	useMemo,
	useSyncExternalStore,
} from "react";
import type { PreferencesRepository } from "../../ports/preferences-repository";
import { ACCOUNT_PROVIDER_ORDER_PREFERENCE } from "../../preferences/keys";
import { createPreferencesRepository } from "../../preferences/create-preferences-repository";
import {
	AVAILABLE_PROVIDERS,
	sameProviderSequence,
	type AccountProviderOrderState,
	type AvailableProviderKey,
	type ProviderKey,
} from "./providerOrderCore";
import {
	accountProviderOrderRecord,
	moveBeforePure,
	normalizeAccountProviderList,
	orderedAvailableProviders,
} from "./providerOrderCore";

export {
	moveBeforePure,
	normalizeAccountProviderKey,
	normalizeAccountProviderList,
} from "./providerOrderCore";
export type {
	AccountProviderOrderState,
	AvailableProviderKey,
	ProviderKey,
} from "./providerOrderCore";

export interface ProviderOrderSnapshot {
	state: AccountProviderOrderState;
	ready: boolean;
}

function createDefaultSnapshot(): ProviderOrderSnapshot {
	return { state: normalizeAccountProviderList(null), ready: false };
}

/**
 * 账号 Provider 顺序的模块级外部存储（非 zustand）。
 * - canonical-commit-first：repository.set 成功后才发布新状态；
 * - 写失败只 console.warn，状态保持不变，绝不向上抛；
 * - hydration 与 commit 竞争用单调版本号仲裁，迟到的旧快照不会覆盖新提交。
 */
export class ProviderOrderStore {
	private snapshot: ProviderOrderSnapshot = createDefaultSnapshot();
	private listeners = new Set<() => void>();
	private repositoryPromise: Promise<PreferencesRepository> | null = null;
	private publishedVersion = 0;
	private tail: Promise<boolean> = Promise.resolve(true);

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): ProviderOrderSnapshot => this.snapshot;

	/** SSR（renderToString）路径要求的稳定快照；默认顺序是确定性的。 */
	getServerSnapshot = (): ProviderOrderSnapshot => this.snapshot;

	/** 幂等注入 repository；未注入时走应用统一的 preferences 工厂。 */
	attachRepository(repository?: PreferencesRepository | null): void {
		if (this.repositoryPromise) return;
		this.repositoryPromise = repository
			? Promise.resolve(repository)
			: createPreferencesRepository().catch((error) => {
					console.warn(
						"[accounts.providerOrder] 偏好存储初始化失败，使用默认顺序",
						error,
					);
					throw error;
				});
		void this.hydrateFromRepository();
	}

	moveProviderBefore(
		provider: ProviderKey,
		beforeProvider: ProviderKey,
	): Promise<boolean> {
		const run = (): Promise<boolean> =>
			this.commitMove(provider, beforeProvider);
		const next = this.tail.then(run, run);
		this.tail = next.then(
			() => true,
			() => true,
		);
		return next;
	}

	private requireRepository(): Promise<PreferencesRepository> {
		if (!this.repositoryPromise) this.attachRepository();
		return this.repositoryPromise as Promise<PreferencesRepository>;
	}

	private async hydrateFromRepository(): Promise<void> {
		const versionAtStart = this.publishedVersion;
		try {
			const repository = await this.requireRepository();
			const stored = await repository.get(ACCOUNT_PROVIDER_ORDER_PREFERENCE);
			// 迟到的 hydration 不能覆盖期间已发生的 commit。
			if (this.publishedVersion !== versionAtStart) return;
			this.publishSnapshot({
				state: normalizeAccountProviderList(stored),
				ready: true,
			});
		} catch (error) {
			if (this.publishedVersion !== versionAtStart) return;
			console.warn(
				"[accounts.providerOrder] 偏好读取失败，使用默认顺序",
				error,
			);
			this.publishSnapshot({
				state: normalizeAccountProviderList(null),
				ready: true,
			});
		}
	}

	private async commitMove(
		provider: ProviderKey,
		beforeProvider: ProviderKey,
	): Promise<boolean> {
		try {
			const repository = await this.requireRepository();
			const current = this.snapshot.state;
			const nextOrder = moveBeforePure(current.order, provider, beforeProvider);
			if (sameProviderSequence(nextOrder, current.order)) return false;
			const next: AccountProviderOrderState = {
				order: nextOrder,
				visible: current.visible,
			};
			await repository.set(
				ACCOUNT_PROVIDER_ORDER_PREFERENCE,
				accountProviderOrderRecord(next),
			);
			this.publishSnapshot({ state: next, ready: true });
			return true;
		} catch (error) {
			console.warn("[accounts.providerOrder] 顺序保存失败，保持当前顺序", error);
			return false;
		}
	}

	private publishSnapshot(next: ProviderOrderSnapshot): void {
		this.snapshot = next;
		this.publishedVersion += 1;
		for (const listener of this.listeners) listener();
	}
}

export function createProviderOrderStore(): ProviderOrderStore {
	return new ProviderOrderStore();
}

/** 应用运行时共享单例：dropdown 与登录弹窗共用同一份已提交顺序。 */
export const sharedProviderOrderStore = createProviderOrderStore();

export interface AccountProviderOrderController {
	ready: boolean;
	orderedProviders(): AvailableProviderKey[];
	providerOrder: ProviderKey[];
	visibleProviders: ProviderKey[];
	hiddenProviders: ProviderKey[];
	moveProviderBefore(
		provider: ProviderKey,
		beforeProvider: ProviderKey,
	): Promise<boolean>;
}

export interface ProviderOrderControllerOptions {
	/** DI 注入口；测试与未来 composition root 可显式传入。 */
	repository?: PreferencesRepository | null;
	/** DI 注入口：默认共享单例让 dropdown 与登录弹窗保持同一份顺序。 */
	store?: ProviderOrderStore;
}

export function useProviderOrderController(
	options: ProviderOrderControllerOptions = {},
): AccountProviderOrderController {
	const store = options.store ?? sharedProviderOrderStore;
	const repository = options.repository ?? null;

	useEffect(() => {
		store.attachRepository(repository);
	}, [repository, store]);

	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getServerSnapshot,
	);

	const orderedProviders = useMemo(
		() => orderedAvailableProviders(snapshot.state.order),
		[snapshot.state],
	);

	const hiddenProviders = useMemo(
		() =>
			snapshot.state.visible.length > 0
				? AVAILABLE_PROVIDERS.filter(
						(key) => !snapshot.state.visible.includes(key),
					)
				: [],
		[snapshot.state],
	);

	const moveProviderBefore = useCallback(
		(provider: ProviderKey, beforeProvider: ProviderKey) =>
			store.moveProviderBefore(provider, beforeProvider),
		[store],
	);

	return {
		ready: snapshot.ready,
		orderedProviders: () => orderedProviders,
		providerOrder: snapshot.state.order,
		visibleProviders: snapshot.state.visible,
		hiddenProviders,
		moveProviderBefore,
	};
}
