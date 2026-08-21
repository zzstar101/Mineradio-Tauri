import { expect, test } from "bun:test";
import { SidecarClientError, type SidecarClient } from "../../api/sidecar-client";
import { createLegacyApiRuntime } from "./legacy-api-runtime";

const runtimeDependencies = {
	getRuntimeConfig: async () => ({
		mediaProxyBase: "mineradio-tauri://localhost",
		appDataDir: "D:/app-data",
		appVersion: "0.1.0",
		schemaVersion: "1",
		updaterPublicKeyConfigured: true,
	}),
};

test("legacy API runtime hides transport addresses and delegates capabilities", async () => {
	const calls: string[] = [];
	const client = {
		async capabilities() {
			calls.push("capabilities");
			return { providers: {} };
		},
	} as unknown as Pick<SidecarClient, "capabilities">;
	const runtime = createLegacyApiRuntime(client, runtimeDependencies);

	const config = await runtime.getConfig();
	await runtime.capabilities();

	expect(config).toEqual({
		appDataDir: "D:/app-data",
		appVersion: "0.1.0",
		schemaVersion: "1",
		updaterPublicKeyConfigured: true,
	});
	expect("sidecarBaseUrl" in config).toBe(false);
	expect(calls).toEqual(["capabilities"]);
});

test("legacy API runtime preserves capabilities result and error identity", async () => {
	const result = Object.freeze({ providers: {} });
	const successCalls: string[] = [];
	const successClient = new Proxy({}, {
		get(_target, property) {
			return () => {
				successCalls.push(String(property));
				return Promise.resolve(result);
			};
		},
	}) as Pick<SidecarClient, "capabilities">;
	const successRuntime = createLegacyApiRuntime(successClient, runtimeDependencies);

	expect(await successRuntime.capabilities()).toBe(result);
	expect(successCalls).toEqual(["capabilities"]);

	const error = new SidecarClientError({
		code: "NETWORK",
		message: "sidecar 连接失败，请稍后重试",
		retryable: true,
		rawMessage: "Failed to fetch",
	});
	const failureCalls: string[] = [];
	const failureClient = new Proxy({}, {
		get(_target, property) {
			return () => {
				failureCalls.push(String(property));
				return Promise.reject(error);
			};
		},
	}) as Pick<SidecarClient, "capabilities">;
	const failureRuntime = createLegacyApiRuntime(failureClient, runtimeDependencies);
	let caught: unknown;
	try {
		await failureRuntime.capabilities();
	} catch (caughtError) {
		caught = caughtError;
	}

	expect(caught).toBe(error);
	expect(failureCalls).toEqual(["capabilities"]);
});
