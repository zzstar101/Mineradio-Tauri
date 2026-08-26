import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPreferencesRepository } from "../../adapters/storage/memory-preferences-repository";
import {
	ACCOUNT_PROVIDER_ORDER_PREFERENCE,
} from "../../preferences/keys";
import type { JsonObject } from "../../preferences/keys";
import {
	createProviderOrderStore,
	useProviderOrderController,
	type AccountProviderOrderController,
	type ProviderOrderStore,
} from "./useProviderOrderController";

const reactTestEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

interface HarnessOptions {
	store?: ProviderOrderStore;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function storedRecord(value: unknown): Record<string, { schemaVersion: number; value: unknown }> {
	return {
		[ACCOUNT_PROVIDER_ORDER_PREFERENCE.name]: { schemaVersion: 1, value },
	};
}

interface HarnessHandle {
	controllerRef: { current: AccountProviderOrderController | null };
	unmount(): Promise<void>;
}

async function renderControllerHarness(
	repository: MemoryPreferencesRepository | null,
	options: HarnessOptions = {},
): Promise<HarnessHandle> {
	const controllerRef: { current: AccountProviderOrderController | null } = {
		current: null,
	};
	// 每个用例默认独立 store，避免共享单例跨用例泄漏状态。
	const store = options.store ?? createProviderOrderStore();
	function Harness() {
		controllerRef.current = useProviderOrderController({ repository, store });
		return null;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(React.createElement(Harness));
		await Promise.resolve();
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	return {
		controllerRef,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function captureWarnings(): { warnings: unknown[][]; restore(): void } {
	const warnings: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	return {
		warnings,
		restore: () => {
			console.warn = originalWarn;
		},
	};
}

test("a fresh controller hydrates the persisted order across a simulated restart", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const repository = new MemoryPreferencesRepository(
		storedRecord({
			version: 1,
			order: ["qq", "netease", "spotify", "soda"],
			visible: [],
		}),
	);

	const harness = await renderControllerHarness(repository);
	expect(harness.controllerRef.current?.ready).toBe(true);
	// kugou/spotify 属于被 MineRadio-api 封锁的 provider，永不进入渲染视图。
	expect(harness.controllerRef.current?.orderedProviders()).toEqual([
		"qq",
		"netease",
		"soda",
	]);
	expect(harness.controllerRef.current?.providerOrder).toEqual([
		"qq",
		"netease",
		"spotify",
		"soda",
	]);

	await harness.unmount();
});

test("defaults are used when nothing was persisted or the stored value is malformed", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

	const emptyHarness = await renderControllerHarness(
		new MemoryPreferencesRepository(),
	);
	expect(emptyHarness.controllerRef.current?.providerOrder).toEqual([
		"netease",
		"qq",
		"soda",
	]);
	expect(emptyHarness.controllerRef.current?.visibleProviders).toEqual([]);
	expect(emptyHarness.controllerRef.current?.hiddenProviders).toEqual([]);
	await emptyHarness.unmount();

	const warnings = captureWarnings();
	try {
		const malformedHarness = await renderControllerHarness(
			new MemoryPreferencesRepository(
				storedRecord({ version: 9, order: "garbage", visible: false }),
			),
		);
		expect(malformedHarness.controllerRef.current?.providerOrder).toEqual([
			"netease",
			"qq",
			"soda",
		]);
		await malformedHarness.unmount();
	} finally {
		warnings.restore();
	}
});

test("moves publish only after the canonical preference commit succeeds", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const committed = deferred<void>();
	const repository = new MemoryPreferencesRepository();
	const originalSet = repository.set.bind(repository);
	let writeCount = 0;
	repository.set = async <T,>(key: Parameters<typeof originalSet>[0], value: T) => {
		writeCount += 1;
		await committed.promise;
		await originalSet(key as never, value as never);
	};

	const harness = await renderControllerHarness(repository);
	expect(writeCount).toBe(0);

	let moveOutcome: boolean | undefined;
	await act(async () => {
		const pending = harness.controllerRef.current!.moveProviderBefore(
			"netease",
			"soda",
		);
		void pending.then((value) => {
			moveOutcome = value;
		});
		await Promise.resolve();
		await Promise.resolve();
	});

	// 提交未完成：写入已发起但状态保持旧顺序。
	expect(writeCount).toBe(1);
	expect(moveOutcome).toBe(undefined);
	expect(harness.controllerRef.current?.providerOrder).toEqual([
		"netease",
		"qq",
		"soda",
	]);

	await act(async () => {
		committed.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});

	expect(moveOutcome).toBe(true);
	expect(harness.controllerRef.current?.providerOrder).toEqual([
		"qq",
		"netease",
		"soda",
	]);
	const persisted = (await repository.get(
		ACCOUNT_PROVIDER_ORDER_PREFERENCE,
	)) as JsonObject;
	expect(persisted.order).toEqual(["qq", "netease", "soda"]);
	expect(persisted.version).toBe(1);

	await harness.unmount();
});

test("repository failures keep the visible order unchanged and only warn", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const repository = new MemoryPreferencesRepository(
		storedRecord({
			version: 1,
			order: ["soda", "netease", "qq"],
			visible: [],
		}),
	);
	repository.set = async () => {
		throw new Error("PREFERENCE_KEY_NOT_ALLOWED");
	};

	const warnings = captureWarnings();
	try {
		const harness = await renderControllerHarness(repository);
		let moveOutcome: boolean | undefined;
		await act(async () => {
			moveOutcome = await harness.controllerRef.current!.moveProviderBefore(
				"qq",
				"soda",
			);
		});

		expect(moveOutcome).toBe(false);
		expect(harness.controllerRef.current?.providerOrder).toEqual([
			"soda",
			"netease",
			"qq",
		]);
		expect(
			warnings.warnings.some((args) =>
				args.some((arg) => String(arg).includes("顺序保存失败")),
			),
		).toBe(true);

		await harness.unmount();
	} finally {
		warnings.restore();
	}
});

test("visible is validated on read and drives the derived hidden list without a dedicated toggle", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const repository = new MemoryPreferencesRepository(
		storedRecord({
			version: 1,
			order: ["netease", "qq", "soda"],
			visible: ["kugou", "soda", "soda"],
		}),
	);

	const harness = await renderControllerHarness(repository);
	expect(harness.controllerRef.current?.visibleProviders).toEqual(["soda"]);
	expect(harness.controllerRef.current?.hiddenProviders).toEqual([
		"netease",
		"qq",
	]);

	await harness.unmount();
});

test("two controllers sharing one store stay in sync without a zustand store", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	const repository = new MemoryPreferencesRepository();
	const store = createProviderOrderStore();

	const first = await renderControllerHarness(repository, { store });
	const second = await renderControllerHarness(null, { store });

	await act(async () => {
		await store.moveProviderBefore("qq", "netease");
	});

	// 默认顺序 [netease, qq, soda] → 把 qq 移到 netease 之前。
	const expected = ["qq", "netease", "soda"];
	expect(store.getSnapshot().state.order).toEqual(expected);
	expect(first.controllerRef.current?.providerOrder).toEqual(expected);
	expect(second.controllerRef.current?.providerOrder).toEqual(expected);
	expect(first.controllerRef.current?.orderedProviders()).toEqual(expected);

	await first.unmount();
	await second.unmount();
});
