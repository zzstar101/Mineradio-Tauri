import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ProviderId,
	ProviderLoginStatus,
	QrLoginKind,
} from "@mineradio/shared";
import type { AccountPort } from "../../ports/music/account-port";
import {
	LoginQrCoordinator,
	classifyLoginQrCheck,
} from "./login-qr-coordinator";

/** 登录弹窗里的扫码入口：QQ 有三个（QQ App / QQ 音乐 App / 微信），其余平台各一个。 */
export const LOGIN_QR_PROVIDERS = [
	"netease",
	"qq",
	"qq_music",
	"wechat",
	"kugou",
	"soda",
] as const satisfies readonly QrLoginKind[];

export type LoginProviderId = (typeof LOGIN_QR_PROVIDERS)[number];
export type LoginModalMode = "full" | "add-account" | "single-provider";
export type LoginQrTone = "idle" | "scan" | "fail" | "success" | "preview";

/** 账号状态按 provider 归属；QQ 的三种扫码入口共用同一个 QQ 音乐账号。 */
export const ACCOUNT_PROVIDERS = ["netease", "qq", "kugou", "soda"] as const satisfies readonly ProviderId[];

export type AccountProviderId = (typeof ACCOUNT_PROVIDERS)[number];

export function providerForLogin(method: LoginProviderId): AccountProviderId {
	switch (method) {
		case "qq":
		case "qq_music":
		case "wechat":
			return "qq";
		case "netease":
			return "netease";
		case "kugou":
			return "kugou";
		case "soda":
			return "soda";
	}
}

/** 每个 provider 的默认扫码入口（用于“添加账号”时预选标签页）。 */
export function firstMethodForProvider(provider: AccountProviderId): LoginProviderId {
	switch (provider) {
		case "netease":
			return "netease";
		case "qq":
			return "qq";
		case "kugou":
			return "kugou";
		case "soda":
			return "soda";
	}
}

/** provider 下的扫码方法列表；只有 QQ 有多个（QQ App / QQ 音乐 App / 微信）。 */
export function loginMethodsForProvider(provider: AccountProviderId): LoginProviderId[] {
	return LOGIN_QR_PROVIDERS.filter((method) => providerForLogin(method) === provider);
}

export function loginMethodLabel(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "网易云";
		case "qq":
			return "QQ 扫码";
		case "qq_music":
			return "QQ 音乐";
		case "wechat":
			return "微信";
		case "kugou":
			return "酷狗";
		case "soda":
			return "汽水音乐";
	}
}

export function accountProviderLabel(provider: AccountProviderId): string {
	switch (provider) {
		case "netease":
			return "网易云";
		case "qq":
			return "QQ 音乐";
		case "kugou":
			return "酷狗";
		case "soda":
			return "汽水音乐";
	}
}

export function loginTitleForMethod(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "扫码登录网易云音乐";
		case "qq":
			return "扫码登录 QQ";
		case "qq_music":
			return "扫码登录 QQ 音乐";
		case "wechat":
			return "微信扫码登录";
		case "kugou":
			return "扫码登录酷狗音乐";
		case "soda":
			return "扫码登录汽水音乐";
	}
}

export function loginDescriptionForMethod(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "使用网易云音乐 App 扫码，可同步歌单、红心与播客。";
		case "qq":
			return "使用 QQ App 扫码，可同步歌单和播放授权。";
		case "qq_music":
			return "使用 QQ 音乐 App 扫码，可同步歌单和播放授权。";
		case "wechat":
			return "使用微信扫码，可同步歌单和播放授权。";
		case "kugou":
			return "使用酷狗音乐 App 扫码，可同步歌单和播放授权。";
		case "soda":
			return "使用汽水音乐 App 扫码，可同步歌单、收藏与播放授权。";
	}
}

export function qrLoadingMarkForMethod(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "NE";
		case "qq":
			return "QQ";
		case "qq_music":
			return "QM";
		case "wechat":
			return "WX";
		case "kugou":
			return "KG";
		case "soda":
			return "SD";
	}
}

export function cookiePlaceholderForProvider(provider: AccountProviderId): string {
	switch (provider) {
		case "netease":
			return "MUSIC_U=...; __csrf=...";
		case "qq":
			return "uin=...; qm_keyst=...; qqmusic_key=...";
		case "kugou":
			return "ticket=...; dfid=...";
		case "soda":
			return "sid_tt=...; sessionid=...";
	}
}

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
	qq_music: { text: "正在生成二维码...", tone: "idle" },
	wechat: { text: "正在生成二维码...", tone: "idle" },
	kugou: { text: "正在生成二维码...", tone: "idle" },
	soda: { text: "正在生成二维码...", tone: "idle" },
};

function initialQrStatusForProvider(provider: LoginProviderId): LoginQrStatusState {
	return { ...INITIAL_QR_STATUS[provider] };
}

function qrInstructionForMethod(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "使用网易云音乐 App 扫码，然后在手机上确认登录";
		case "qq":
			return "使用 QQ App 扫码，然后在手机上确认登录";
		case "qq_music":
			return "使用 QQ 音乐 App 扫码，然后在手机上确认登录";
		case "wechat":
			return "使用微信 App 扫码，然后在手机上确认登录";
		case "kugou":
			return "使用酷狗音乐 App 扫码，然后在手机上确认登录";
		case "soda":
			return "使用汽水音乐 App 扫码，然后在手机上确认登录";
	}
}

function qrScannedTextForMethod(method: LoginProviderId): string {
	switch (method) {
		case "netease":
			return "已扫码，请在网易云音乐 App 上确认登录";
		case "qq":
			return "已扫码，请在 QQ App 上确认登录";
		case "qq_music":
			return "已扫码，请在 QQ 音乐 App 上确认登录";
		case "wechat":
			return "已扫码，请在微信上确认登录";
		case "kugou":
			return "已扫码，请在酷狗音乐 App 上确认登录";
		case "soda":
			return "已扫码，请在汽水音乐 App 上确认登录";
	}
}

function createInitialQrByProvider(): LoginQrByProvider {
	return {
		netease: null,
		qq: null,
		qq_music: null,
		wechat: null,
		kugou: null,
		soda: null,
	};
}

function createInitialStatusByProvider(): LoginQrStatusByProvider {
	return {
		netease: initialQrStatusForProvider("netease"),
		qq: initialQrStatusForProvider("qq"),
		qq_music: initialQrStatusForProvider("qq_music"),
		wechat: initialQrStatusForProvider("wechat"),
		kugou: initialQrStatusForProvider("kugou"),
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
		const providerId = providerForLogin(target);
		try {
			const key = await accounts.createLoginQrKey(providerId, target);
			const image = await accounts.createLoginQrImage(providerId, key.key, target);
			if (!generationCoordinator.isGenerationCurrent(generationToken)) return;
			setProviderQr(target, {
				key: image.key || key.key,
				img: image.img,
				completed: false,
			});
			setProviderQrStatus(target, {
				text: qrInstructionForMethod(target),
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
		const providerId = providerForLogin(provider);
		const pollCoordinator = new LoginQrCoordinator();
		const check = async () => {
			if (!pollCoordinator.claimPoll()) return;
			try {
				const result = await accounts.checkLoginQr(providerId, activeKey, provider);
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
						status = await accounts.loginStatus(providerId);
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
						text: qrScannedTextForMethod(provider),
						tone: "scan",
					});
					return;
				}
				setProviderQrStatus(provider, {
					text: qrInstructionForMethod(provider),
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
