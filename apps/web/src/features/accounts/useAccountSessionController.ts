import { useCallback, useRef, useState } from "react";
import type { ProviderLoginStatus } from "@mineradio/shared";
import type { AccountPort } from "../../ports/music/account-port";
import { ACCOUNT_PROVIDERS, type AccountProviderId } from "./useLoginQrRuntime";

export type AccountStatusByProvider = Record<
	AccountProviderId,
	ProviderLoginStatus | null
>;

export interface AccountCookieImportLifecycle {
	onStored?(): void;
	onFinished?(): void;
}

export interface AccountSessionControllerOptions {
	accounts: AccountPort | null;
	syncProviderPlaylists(provider: AccountProviderId): Promise<void>;
	refreshHome(): Promise<unknown>;
	refreshLibrary(): void | Promise<void>;
	providerLabel(provider: AccountProviderId): string;
	showToast(message: string): void;
}

export interface AccountSessionControllerResult {
	statusByProvider: AccountStatusByProvider;
	acceptProviderStatus(status: ProviderLoginStatus): void;
	refreshProviderStatus(provider: AccountProviderId): Promise<void>;
	importProviderCookie(
		provider: AccountProviderId,
		cookie: string,
		lifecycle?: AccountCookieImportLifecycle,
	): Promise<void>;
	logoutProvider(provider: AccountProviderId): Promise<void>;
}

function createInitialStatusByProvider(): AccountStatusByProvider {
	const initial: Record<AccountProviderId, ProviderLoginStatus | null> = {
		netease: null,
		qq: null,
		kugou: null,
		soda: null,
	};
	return initial;
}

export function useAccountSessionController({
	accounts,
	syncProviderPlaylists,
	refreshHome,
	refreshLibrary,
	providerLabel,
	showToast,
}: AccountSessionControllerOptions): AccountSessionControllerResult {
	const [statusByProvider, setStatusByProvider] =
		useState<AccountStatusByProvider>(createInitialStatusByProvider);
	const dependenciesRef = useRef({
		accounts,
		syncProviderPlaylists,
		refreshHome,
		refreshLibrary,
		providerLabel,
		showToast,
	});
	dependenciesRef.current = {
		accounts,
		syncProviderPlaylists,
		refreshHome,
		refreshLibrary,
		providerLabel,
		showToast,
	};

	const acceptProviderStatus = useCallback((status: ProviderLoginStatus) => {
		if (!ACCOUNT_PROVIDERS.includes(status.provider)) {
			return;
		}
		setStatusByProvider((current) => ({
			...current,
			[status.provider]: status,
		}));
	}, []);

	const refreshProviderStatus = useCallback(async (provider: AccountProviderId) => {
		const dependencies = dependenciesRef.current;
		const { accounts: accountPort } = dependencies;
		if (!accountPort) {
			dependencies.showToast("API 未就绪，稍后再试");
			return;
		}
		try {
			const status = await accountPort.loginStatus(provider);
			acceptProviderStatus(status);
			if (status.loggedIn) void dependencies.syncProviderPlaylists(provider);
			else void dependencies.refreshLibrary();
			const label = dependencies.providerLabel(provider);
			dependencies.showToast(
				status.loggedIn
					? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`
					: `${label}未登录`,
			);
		} catch (error) {
			dependencies.showToast(
				error instanceof Error ? error.message : "登录状态读取失败",
			);
		}
	}, [acceptProviderStatus]);

	const importProviderCookie = useCallback(async (
		provider: AccountProviderId,
		cookie: string,
		lifecycle: AccountCookieImportLifecycle = {},
	) => {
		const dependencies = dependenciesRef.current;
		const { accounts: accountPort } = dependencies;
		const label = dependencies.providerLabel(provider);
		if (!accountPort) {
			dependencies.showToast("API 未就绪，稍后再试");
			return;
		}
		if (!cookie.trim()) {
			dependencies.showToast(`请粘贴${label} cookie`);
			return;
		}
		try {
			await accountPort.setSessionCookie(provider, cookie);
			lifecycle.onStored?.();
			const status = await accountPort.loginStatus(provider);
			acceptProviderStatus(status);
			if (status.loggedIn) {
				try {
					await dependencies.syncProviderPlaylists(provider);
					await dependencies.refreshHome();
				} catch {
					dependencies.showToast(`${label}已登录，歌单同步失败，可稍后刷新`);
				}
			} else {
				void dependencies.refreshLibrary();
			}
			dependencies.showToast(
				status.loggedIn
					? `${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`
					: `${label}会话已保存，但账号态未确认`,
			);
		} catch (error) {
			dependencies.showToast(
				error instanceof Error ? error.message : "手动导入失败",
			);
		} finally {
			lifecycle.onFinished?.();
		}
	}, [acceptProviderStatus]);

	const logoutProvider = useCallback(async (provider: AccountProviderId) => {
		const dependencies = dependenciesRef.current;
		const { accounts: accountPort } = dependencies;
		const label = dependencies.providerLabel(provider);
		if (!accountPort) {
			dependencies.showToast("API 未就绪，稍后再试");
			return;
		}
		try {
			await accountPort.logout(provider);
			acceptProviderStatus({ provider, loggedIn: false });
			void dependencies.refreshLibrary();
			dependencies.showToast(`${label}会话已清除`);
		} catch (error) {
			dependencies.showToast(
				error instanceof Error ? error.message : "退出登录失败",
			);
		}
	}, [acceptProviderStatus]);

	return {
		statusByProvider,
		acceptProviderStatus,
		refreshProviderStatus,
		importProviderCookie,
		logoutProvider,
	};
}
