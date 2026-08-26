import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderLoginStatus } from "@mineradio/shared";
import type { RefObject } from "react";
import { MemoryPreferencesRepository } from "../../adapters/storage/memory-preferences-repository";
import { ACCOUNT_PROVIDER_ORDER_PREFERENCE } from "../../preferences/keys";
import {
	AccountOverlaySurface,
	AccountSurface,
} from "./AccountSurface";
import type { AccountStatusByProvider } from "./useAccountSessionController";
import {
	type LoginProviderId,
	type LoginQrByProvider,
	type LoginQrStatusByProvider,
} from "./useLoginQrRuntime";
import {
	createProviderOrderStore,
	type ProviderOrderStore,
} from "./useProviderOrderController";

const reactTestEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function loggedInStatus(nickname: string): ProviderLoginStatus {
	return {
		loggedIn: true,
		nickname,
		userId: nickname,
	} as unknown as ProviderLoginStatus;
}

function allLoggedIn(): AccountStatusByProvider {
	return {
		netease: loggedInStatus("网易账号"),
		qq: loggedInStatus("QQ账号"),
		soda: loggedInStatus("汽水账号"),
	};
}

interface IsolatedOrderFixture {
	repository: MemoryPreferencesRepository;
	store: ProviderOrderStore;
	flush(): Promise<void>;
}

async function createIsolatedOrderFixture(
	order: string[],
): Promise<IsolatedOrderFixture> {
	const repository = new MemoryPreferencesRepository({
		[ACCOUNT_PROVIDER_ORDER_PREFERENCE.name]: {
			schemaVersion: 1,
			value: { version: 1, order, visible: [] },
		},
	});
	const store = createProviderOrderStore();
	store.attachRepository(repository);
	const flush = async () => {
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});
	};
	await flush();
	return { repository, store, flush };
}

test("account dropdown rows render in the persisted provider order", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const fixture = await createIsolatedOrderFixture(["soda", "netease", "qq"]);

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			React.createElement(AccountSurface, {
				statuses: allLoggedIn(),
				dropdownOpen: true,
				capsuleAutoHide: false,
				onHome: () => undefined,
				onAccountClick: () => undefined,
				onHideCapsule: () => undefined,
				onRefreshStatus: () => undefined,
				onLogout: () => undefined,
				onOpenSingleProvider: () => undefined,
				providerOrderStore: fixture.store,
			}),
		);
	});

	const rowKeys = [
		...host.querySelectorAll("#account-dropdown .account-dropdown-row"),
	].map((row) => row.getAttribute("data-flip-key"));
	expect(rowKeys).toEqual(["soda", "netease", "qq"]);
	// 行可聚焦，支持 Alt+方向键重排。
	for (const row of host.querySelectorAll("#account-dropdown .account-dropdown-row")) {
		expect(row.getAttribute("tabindex")).toBe("0");
	}

	await act(async () => root.unmount());
	host.remove();
});

test("Alt+ArrowDown on a focused row reorders providers through the same commit path", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const fixture = await createIsolatedOrderFixture(["soda", "netease", "qq"]);

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			React.createElement(AccountSurface, {
				statuses: allLoggedIn(),
				dropdownOpen: true,
				capsuleAutoHide: false,
				onHome: () => undefined,
				onAccountClick: () => undefined,
				onHideCapsule: () => undefined,
				onRefreshStatus: () => undefined,
				onLogout: () => undefined,
				onOpenSingleProvider: () => undefined,
				providerOrderStore: fixture.store,
			}),
		);
	});

	const sodaRow = host.querySelector<HTMLElement>(
		"#account-dropdown-provider-soda",
	);
	expect(sodaRow).not.toBeNull();
	// happy-dom 预加载只绑定 window，不绑定事件构造器全局。
	const KeyboardEventCtor = (
		window as unknown as {
			KeyboardEvent: new (type: string, init?: KeyboardEventInit) => Event;
		}
	).KeyboardEvent;
	await act(async () => {
		sodaRow!.dispatchEvent(
			new KeyboardEventCtor("keydown", {
				key: "ArrowDown",
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
	await fixture.flush();

	// soda 与 netease 交换位置：等价于 moveProviderBefore(netease, soda)。
	const rowKeys = [
		...host.querySelectorAll("#account-dropdown .account-dropdown-row"),
	].map((row) => row.getAttribute("data-flip-key"));
	expect(rowKeys).toEqual(["netease", "soda", "qq"]);

	const persisted = (await fixture.repository.get(
		ACCOUNT_PROVIDER_ORDER_PREFERENCE,
	)) as { order: string[] };
	expect(persisted.order).toEqual(["netease", "soda", "qq"]);

	await act(async () => root.unmount());
	host.remove();
});

test("login modal platform tabs follow the same persisted order", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const fixture = await createIsolatedOrderFixture(["soda", "netease", "qq"]);

	const qrStatus: LoginQrStatusByProvider = {
		netease: { text: "", tone: "idle" },
		qq: { text: "", tone: "idle" },
		soda: { text: "", tone: "idle" },
	};
	const qrByProvider: LoginQrByProvider = {
		netease: null,
		qq: null,
		soda: null,
	};
	const cookieInputRefs: Record<
		LoginProviderId,
		RefObject<HTMLTextAreaElement | null>
	> = {
		netease: { current: null },
		qq: { current: null },
		soda: { current: null },
	};

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			React.createElement(AccountOverlaySurface, {
				statuses: allLoggedIn(),
				modalOpen: true,
				modalMode: "full",
				provider: "netease",
				manualCookieOpen: false,
				qrByProvider,
				qrStatusByProvider: qrStatus,
				cookieInputRefs,
				onClose: () => undefined,
				onProviderChange: () => undefined,
				onManualCookieToggle: () => undefined,
				onRefreshQr: () => undefined,
				onRefreshStatus: () => undefined,
				onImportCookie: () => undefined,
				onLogout: () => undefined,
				onOpenSingleProvider: () => undefined,
				providerOrderStore: fixture.store,
			}),
		);
	});

	const tabIds = [...host.querySelectorAll("#login-platform-tabs button")].map(
		(tab) => tab.id,
	);
	expect(tabIds).toEqual([
		"login-provider-soda",
		"login-provider-netease",
		"login-provider-qq",
	]);

	await act(async () => root.unmount());
	host.remove();
});
