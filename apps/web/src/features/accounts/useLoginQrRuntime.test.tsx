import { expect, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ProviderId } from "@mineradio/shared";
import type { AccountPort } from "../../ports/music/account-port";
import {
	useLoginQrRuntime,
	type LoginQrRuntimeResult,
} from "./useLoginQrRuntime";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("opening a provider login modal generates its QR image through AccountPort", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const accounts = {
		async createLoginQrKey(provider: ProviderId) {
			calls.push(`key:${provider}`);
			return { provider, key: "ne-key" };
		},
		async createLoginQrImage(provider: ProviderId, key: string) {
			calls.push(`image:${provider}:${key}`);
			return {
				provider,
				key,
				img: "data:image/png;base64,ne",
			};
		},
		async checkLoginQr(provider: ProviderId, key: string) {
			return { provider, key, code: 801, loggedIn: false };
		},
	} as unknown as AccountPort;
	const runtimeRef: { current: LoginQrRuntimeResult | null } = { current: null };

	function Harness() {
		runtimeRef.current = useLoginQrRuntime({
			accounts,
			modalOpen: true,
			modalMode: "full",
			provider: "netease",
			onProviderStatus: () => undefined,
			syncProviderLibrary: async () => undefined,
			refreshLibraryAfterLoggedOut: () => undefined,
			providerLabel: () => "网易云",
			showToast: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && !runtimeRef.current?.qrByProvider.netease; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(calls).toEqual(["key:netease", "image:netease:ne-key"]);
	expect(runtimeRef.current?.qrByProvider.netease).toEqual({
		key: "ne-key",
		img: "data:image/png;base64,ne",
		completed: false,
	});
	expect(runtimeRef.current?.statusByProvider.netease).toEqual({
		text: "使用网易云音乐 App 扫码，然后在手机上确认登录",
		tone: "idle",
	});

	root.unmount();
	host.remove();
});

test("resetting QR state prevents a late image from being committed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const image = deferred<{
		provider: "netease";
		key: string;
		img: string;
	}>();
	let imageRequested = false;
	const accounts = {
		async createLoginQrKey() {
			return { provider: "netease", key: "stale-key" };
		},
		async createLoginQrImage() {
			imageRequested = true;
			return await image.promise;
		},
	} as unknown as AccountPort;
	const runtimeRef: { current: LoginQrRuntimeResult | null } = { current: null };
	const noOp = () => undefined;

	function Harness() {
		runtimeRef.current = useLoginQrRuntime({
			accounts,
			modalOpen: true,
			modalMode: "full",
			provider: "netease",
			onProviderStatus: noOp,
			syncProviderLibrary: async () => undefined,
			refreshLibraryAfterLoggedOut: noOp,
			providerLabel: () => "网易云",
			showToast: noOp,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && !imageRequested; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	runtimeRef.current!.resetProviderLoginQr();
	image.resolve({
		provider: "netease",
		key: "stale-key",
		img: "data:image/png;base64,stale",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(runtimeRef.current?.qrByProvider.netease).toBeNull();
	expect(runtimeRef.current?.statusByProvider.netease).toEqual({
		text: "正在生成二维码...",
		tone: "idle",
	});

	root.unmount();
	host.remove();
});

test("a successful QR check synchronizes account and library before completing", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const statusResponse = deferred<{
		provider: "qq";
		loggedIn: true;
		userId: string;
	}>();
	const events: string[] = [];
	const accounts = {
		async createLoginQrKey() {
			return { provider: "qq", key: "qq-key" };
		},
		async createLoginQrImage() {
			return { provider: "qq", key: "qq-key", img: "data:image/png;base64,qq" };
		},
		async checkLoginQr() {
			return {
				provider: "qq",
				key: "qq-key",
				code: 0,
				loggedIn: true,
				stored: true,
			};
		},
		async loginStatus() {
			events.push("login-status");
			return await statusResponse.promise;
		},
	} as unknown as AccountPort;
	const runtimeRef: { current: LoginQrRuntimeResult | null } = { current: null };
	const onProviderStatus = () => events.push("provider-status");
	const syncProviderLibrary = async () => {
		events.push("sync-library");
	};
	const showToast = (message: string) => events.push(`toast:${message}`);
	const noOp = () => undefined;
	const scheduleInterval = () => "timer";
	const clearScheduledInterval = () => undefined;

	function Harness() {
		runtimeRef.current = useLoginQrRuntime({
			accounts,
			modalOpen: true,
			modalMode: "single-provider",
			provider: "qq",
			onProviderStatus,
			syncProviderLibrary,
			refreshLibraryAfterLoggedOut: noOp,
			providerLabel: () => "QQ 音乐",
			showToast,
			scheduleInterval,
			clearScheduledInterval,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (
		let i = 0;
		i < 40 && runtimeRef.current?.statusByProvider.qq.text !== "登录成功，正在同步账号状态";
		i += 1
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(runtimeRef.current?.statusByProvider.qq.text).toBe("登录成功，正在同步账号状态");

	statusResponse.resolve({ provider: "qq", loggedIn: true, userId: "10001" });
	for (let i = 0; i < 8 && !runtimeRef.current?.qrByProvider.qq?.completed; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(events).toEqual([
		"login-status",
		"provider-status",
		"sync-library",
		"toast:QQ 音乐已登录: 10001",
	]);
	expect(runtimeRef.current?.qrByProvider.qq?.completed).toBe(true);
	expect(runtimeRef.current?.statusByProvider.qq).toEqual({
		text: "登录成功，歌单已同步",
		tone: "success",
	});

	root.unmount();
	host.remove();
});

test("interval ticks do not overlap an in-flight QR check and cleanup clears the timer", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const firstCheck = deferred<{
		provider: "soda";
		key: string;
		code: number;
		loggedIn: false;
	}>();
	let checkCount = 0;
	const intervalRef: { current: (() => void) | null } = { current: null };
	const cleared: unknown[] = [];
	const accounts = {
		async createLoginQrKey() {
			return { provider: "soda", key: "soda-key" };
		},
		async createLoginQrImage() {
			return { provider: "soda", key: "soda-key", img: "data:image/png;base64,soda" };
		},
		async checkLoginQr() {
			checkCount += 1;
			if (checkCount === 1) return await firstCheck.promise;
			return { provider: "soda", key: "soda-key", code: 801, loggedIn: false };
		},
	} as unknown as AccountPort;
	const noOp = () => undefined;
	const scheduleInterval = (callback: () => void) => {
		intervalRef.current = callback;
		return "soda-timer";
	};
	const clearScheduledInterval = (handle: unknown) => cleared.push(handle);

	function Harness() {
		useLoginQrRuntime({
			accounts,
			modalOpen: true,
			modalMode: "single-provider",
			provider: "soda",
			onProviderStatus: noOp,
			syncProviderLibrary: async () => undefined,
			refreshLibraryAfterLoggedOut: noOp,
			providerLabel: () => "汽水音乐",
			showToast: noOp,
			scheduleInterval,
			clearScheduledInterval,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && checkCount < 1; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	intervalRef.current?.();
	intervalRef.current?.();
	expect(checkCount).toBe(1);

	firstCheck.resolve({ provider: "soda", key: "soda-key", code: 801, loggedIn: false });
	await new Promise((resolve) => setTimeout(resolve, 0));
	intervalRef.current?.();
	for (let i = 0; i < 4 && checkCount < 2; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(checkCount).toBe(2);

	root.unmount();
	expect(cleared).toContain("soda-timer");
	host.remove();
});

test("QQ sub-methods pass their kind through to AccountPort using the qq provider", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const accounts = {
		async createLoginQrKey(provider: ProviderId, kind?: string) {
			calls.push(`key:${provider}:${kind}`);
			return { provider, key: "qm-key" };
		},
		async createLoginQrImage(provider: ProviderId, key: string, kind?: string) {
			calls.push(`image:${provider}:${key}:${kind}`);
			return { provider, key, img: "data:image/png;base64,qm" };
		},
		async checkLoginQr() {
			return { provider: "qq", key: "qm-key", code: 801, loggedIn: false };
		},
	} as unknown as AccountPort;
	const runtimeRef: { current: LoginQrRuntimeResult | null } = { current: null };

	function Harness() {
		runtimeRef.current = useLoginQrRuntime({
			accounts,
			modalOpen: true,
			modalMode: "full",
			provider: "qq_music",
			onProviderStatus: () => undefined,
			syncProviderLibrary: async () => undefined,
			refreshLibraryAfterLoggedOut: () => undefined,
			providerLabel: () => "QQ 音乐",
			showToast: () => undefined,
		});
		return null;
	}

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(<Harness />));
	for (let i = 0; i < 8 && !runtimeRef.current?.qrByProvider.qq_music; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	expect(calls).toEqual(["key:qq:qq_music", "image:qq:qm-key:qq_music"]);
	expect(runtimeRef.current?.qrByProvider.qq_music).toEqual({
		key: "qm-key",
		img: "data:image/png;base64,qm",
		completed: false,
	});
	expect(runtimeRef.current?.statusByProvider.qq_music).toEqual({
		text: "使用 QQ 音乐 App 扫码，然后在手机上确认登录",
		tone: "idle",
	});

	root.unmount();
	host.remove();
});
