import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ProviderId,
	ProviderLoginStatus,
} from "@mineradio/shared";
import type { AccountPort } from "../../ports/music/account-port";
import {
	LoginQrCoordinator,
	classifyLoginQrCheck,
} from "./login-qr-coordinator";

export const LOGIN_QR_PROVIDERS = ["netease", "qq", "soda"] as const satisfies readonly ProviderId[];

export type LoginProviderId = (typeof LOGIN_QR_PROVIDERS)[number];
export type LoginModalMode = "full" | "add-account" | "single-provider";
export type LoginQrTone = "idle" | "scan" | "fail" | "success" | "preview";

export interface LoginQrState {
	key: string;
	img: string;
	completed: boolean;
}

export interface LoginQrStatusState {
	text: string;
	tone: LoginQrTone;
}

export type LoginQrByProvider = Record<LoginProviderId, LoginQrState | null>;
export type LoginQrStatusByProvider = Record<LoginProviderId, LoginQrStatusState>;

export interface LoginQrRuntimeOptions {
	accounts: AccountPort | null;
	modalOpen: boolean;
	modalMode: LoginModalMode;
	provider: LoginProviderId;
	onProviderStatus(status: ProviderLoginStatus): void;
	syncProviderLibrary(provider: LoginProviderId): Promise<void>;
	refreshLibraryAfterLoggedOut(): void | Promise<void>;
	providerLabel(provider: LoginProviderId): string;
	showToast(message: string): void;
	pollIntervalMs?: number;
	scheduleInterval?: (callback: () => void, delayMs: number) => unknown;
	clearScheduledInterval?: (handle: unknown) => void;
}

export interface LoginQrRuntimeResult {
	qrByProvider: LoginQrByProvider;
	statusByProvider: LoginQrStatusByProvider;
	refreshProviderLoginQr(provider: LoginProviderId): Promise<void>;
	resetProviderLoginQr(): void;
}

const INITIAL_QR_STATUS: LoginQrStatusByProvider = {
	netease: { text: "正在生成二维码...", tone: "idle" },
	qq: { text: "正在生成二维码...", tone: "idle" },
	soda: { text: "正在生成二维码...", tone: "idle" },
};

function initialQrStatusForProvider(provider: LoginProviderId): LoginQrStatusState {
	return { ...INITIAL_QR_STATUS[provider] };
}

function qrInstructionForProvider(provider: LoginProviderId): string {
	if (provider === "qq") return "使用 QQ 音乐 App 扫码，然后在手机上确认登录";
	if (provider === "soda") return "使用汽水音乐 App 扫码，然后在手机上确认登录";
	return "使用网易云音乐 App 扫码，然后在手机上确认登录";
}

function qrScannedTextForProvider(provider: LoginProviderId): string {
	if (provider === "qq") return "已扫码，请在 QQ 音乐 App 上确认登录";
	if (provider === "soda") return "已扫码，请在汽水音乐 App 上确认登录";
	return "已扫码，请在手机上确认登录";
}

function createInitialQrByProvider(): LoginQrByProvider {
	return {
		netease: null,
		qq: null,
		soda: null,
	};
}

function createInitialStatusByProvider(): LoginQrStatusByProvider {
	return {
		netease: initialQrStatusForProvider("netease"),
		qq: initialQrStatusForProvider("qq"),
		soda: initialQrStatusForProvider("soda"),
	};
}

function defaultScheduleInterval(callback: () => void, delayMs: number): unknown {
	return window.setInterval(callback, delayMs);
}

function defaultClearScheduledInterval(handle: unknown): void {
	window.clearInterval(handle as number);
}

export function useLoginQrRuntime({
	accounts,
	modalOpen,
	modalMode,
	provider,
	onProviderStatus,
	syncProviderLibrary,
	refreshLibraryAfterLoggedOut,
	providerLabel,
	showToast,
	pollIntervalMs = 1_800,
	scheduleInterval = defaultScheduleInterval,
	clearScheduledInterval = defaultClearScheduledInterval,
}: LoginQrRuntimeOptions): LoginQrRuntimeResult {
	const [qrByProvider, setQrByProvider] = useState<LoginQrByProvider>(createInitialQrByProvider);
	const [statusByProvider, setStatusByProvider] =
		useState<LoginQrStatusByProvider>(createInitialStatusByProvider);
	const generationCoordinatorRef = useRef<LoginQrCoordinator | null>(null);
	if (!generationCoordinatorRef.current) {
		generationCoordinatorRef.current = new LoginQrCoordinator();
	}
	const generationCoordinator = generationCoordinatorRef.current;
	const callbacksRef = useRef({
		onProviderStatus,
		syncProviderLibrary,
		refreshLibraryAfterLoggedOut,
		providerLabel,
		showToast,
	});
	callbacksRef.current = {
		onProviderStatus,
		syncProviderLibrary,
		refreshLibraryAfterLoggedOut,
		providerLabel,
		showToast,
	};

	const setProviderQr = useCallback((
		target: LoginProviderId,
		updater: LoginQrState | null | ((current: LoginQrState | null) => LoginQrState | null),
	) => {
		setQrByProvider((current) => ({
			...current,
			[target]: typeof updater === "function" ? updater(current[target]) : updater,
		}));
	}, []);

	const setProviderQrStatus = useCallback((
		target: LoginProviderId,
		status: LoginQrStatusState,
	) => {
		setStatusByProvider((current) => ({
			...current,
			[target]: status,
		}));
	}, []);

	const refreshProviderLoginQr = useCallback(async (target: LoginProviderId) => {
		const generationToken = generationCoordinator.beginGeneration();
		setProviderQr(target, null);
		setProviderQrStatus(target, initialQrStatusForProvider(target));
		if (!accounts) {
			setProviderQrStatus(target, { text: "API 未就绪，稍后再试", tone: "fail" });
			return;
		}
		try {
			const key = await accounts.createLoginQrKey(target);
			const image = await accounts.createLoginQrImage(target, key.key);
			if (!generationCoordinator.isGenerationCurrent(generationToken)) return;
			setProviderQr(target, {
				key: image.key || key.key,
				img: image.img,
				completed: false,
			});
			setProviderQrStatus(target, {
				text: qrInstructionForProvider(target),
				tone: "idle",
			});
		} catch (error) {
			if (!generationCoordinator.isGenerationCurrent(generationToken)) return;
			setProviderQrStatus(target, {
				text: error instanceof Error ? error.message : "二维码生成失败",
				tone: "fail",
			});
		}
	}, [accounts, generationCoordinator, setProviderQr, setProviderQrStatus]);

	const resetProviderLoginQr = useCallback(() => {
		generationCoordinator.invalidateGeneration();
		setQrByProvider(createInitialQrByProvider());
		setStatusByProvider(createInitialStatusByProvider());
	}, [generationCoordinator]);

	useEffect(() => {
		if (!modalOpen || modalMode === "add-account") return;
		void refreshProviderLoginQr(provider);
	}, [modalMode, modalOpen, provider, refreshProviderLoginQr]);

	useEffect(() => {
		const activeQr = qrByProvider[provider];
		if (
			!modalOpen ||
			modalMode === "add-account" ||
			!activeQr?.key ||
			activeQr.completed ||
			!accounts
		) {
			return;
		}

		let cancelled = false;
		const activeKey = activeQr.key;
		const pollCoordinator = new LoginQrCoordinator();
		const check = async () => {
			if (!pollCoordinator.claimPoll()) return;
			try {
				const result = await accounts.checkLoginQr(provider, activeKey);
				if (cancelled) return;
				const state = classifyLoginQrCheck(result);
				if (state === "success") {
					const callbacks = callbacksRef.current;
					setProviderQrStatus(provider, {
						text: "登录成功，正在同步账号状态",
						tone: "success",
					});
					let status: ProviderLoginStatus | null = null;
					try {
						status = await accounts.loginStatus(provider);
					} catch {
						status = null;
					}
					if (cancelled) return;
					const label = callbacks.providerLabel(provider);
					let providerPlaylistSyncFailed = false;
					if (status) {
						callbacks.onProviderStatus(status);
						if (status.loggedIn) {
							setProviderQrStatus(provider, {
								text: "登录成功，正在同步歌单",
								tone: "success",
							});
							try {
								await callbacks.syncProviderLibrary(provider);
							} catch {
								if (cancelled) return;
								providerPlaylistSyncFailed = true;
								setProviderQrStatus(provider, {
									text: "登录成功，歌单同步失败，可稍后刷新",
									tone: "success",
								});
							}
						} else {
							void callbacks.refreshLibraryAfterLoggedOut();
						}
					}
					if (cancelled) return;
					setProviderQr(provider, (current) => (
						current?.key === activeKey ? { ...current, completed: true } : current
					));
					if (status?.loggedIn) {
						setProviderQrStatus(provider, {
							text: providerPlaylistSyncFailed
								? "登录成功，歌单同步失败，可稍后刷新"
								: "登录成功，歌单已同步",
							tone: "success",
						});
						callbacks.showToast(`${label}已登录: ${status.nickname ?? status.userId ?? "账号"}`);
					} else {
						setProviderQrStatus(provider, {
							text: "登录成功，会话已保存，可刷新状态",
							tone: "success",
						});
						callbacks.showToast(`${label}会话已保存`);
					}
					return;
				}
				if (state === "expired") {
					setProviderQr(provider, (current) => (
						current?.key === activeKey ? { ...current, completed: true } : current
					));
					setProviderQrStatus(provider, {
						text: "二维码已过期，请刷新",
						tone: "fail",
					});
					return;
				}
				if (state === "scanned") {
					setProviderQrStatus(provider, {
						text: qrScannedTextForProvider(provider),
						tone: "scan",
					});
					return;
				}
				setProviderQrStatus(provider, {
					text: qrInstructionForProvider(provider),
					tone: "idle",
				});
			} catch {
				if (!cancelled) {
					setProviderQrStatus(provider, {
						text: "扫码状态读取失败",
						tone: "fail",
					});
				}
			} finally {
				pollCoordinator.releasePoll();
			}
		};

		const timer = scheduleInterval(() => {
			void check();
		}, pollIntervalMs);
		void check();
		return () => {
			cancelled = true;
			clearScheduledInterval(timer);
		};
	}, [
		accounts,
		clearScheduledInterval,
		modalMode,
		modalOpen,
		pollIntervalMs,
		provider,
		qrByProvider,
		scheduleInterval,
		setProviderQr,
		setProviderQrStatus,
	]);

	return {
		qrByProvider,
		statusByProvider,
		refreshProviderLoginQr,
		resetProviderLoginQr,
	};
}
