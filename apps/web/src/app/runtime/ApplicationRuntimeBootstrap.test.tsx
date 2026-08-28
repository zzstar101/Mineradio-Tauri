import { expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { CapabilityMatrix, ProviderLoginStatus } from "@mineradio/shared";
import type {
	ApplicationPorts,
	ApplicationRuntimePort,
} from "../../ports/application-runtime-port";
import { ApplicationRuntimeBootstrap } from "./ApplicationRuntimeBootstrap";

test("ApplicationRuntimeBootstrap performs the one-shot boot sync without health gating", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const capabilityMatrix = { providers: {} } as CapabilityMatrix;
	const loginStatus = {
		provider: "netease",
		loggedIn: true,
	} as ProviderLoginStatus;
	const ports = {
		apiRuntime: {
			getConfig: async () => {
				throw new Error("测试不应重新读取配置");
			},
			capabilities: async () => {
				calls.push("capabilities");
				return capabilityMatrix;
			},
		},
		music: {
			accounts: {
				loginStatus: async (provider: string) => {
					calls.push(`login:${provider}`);
					return loginStatus;
				},
			},
		},
	} as unknown as ApplicationPorts;
	const applicationRuntime: ApplicationRuntimePort = {
		async connect() {
			calls.push("connect");
			return ports;
		},
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	try {
		flushSync(() => root.render(
			<ApplicationRuntimeBootstrap
				applicationRuntime={applicationRuntime}
				loginProviders={["netease"]}
				onConnection={(connected) => {
					expect(connected).toBe(ports);
					calls.push("connection");
				}}
				onUnavailable={() => { calls.push("unavailable"); }}
				onCapabilities={() => { calls.push("matrix"); }}
				onProviderStatus={() => { calls.push("provider-status"); }}
				onRefreshLibrary={(connected) => {
					expect(connected).toBe(ports);
					calls.push("library");
				}}
			/>,
		));
		for (let index = 0; index < 12; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(calls).toEqual([
			"connect",
			"connection",
			"capabilities",
			"matrix",
			"login:netease",
			"provider-status",
			"library",
		]);
		expect(calls).not.toContain("health");
	} finally {
		flushSync(() => root.unmount());
		host.remove();
	}
});

test("ApplicationRuntimeBootstrap reports an unavailable native runtime without publishing ports", async () => {
	await import("../../../../../packages/visual-engine/src/runtime/happy-dom-preload");
	const calls: string[] = [];
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	flushSync(() => root.render(
		<ApplicationRuntimeBootstrap
			applicationRuntime={{ connect: async () => null }}
			loginProviders={[]}
			onConnection={() => { calls.push("connection"); }}
			onUnavailable={() => { calls.push("unavailable"); }}
			onCapabilities={() => { calls.push("matrix"); }}
			onProviderStatus={() => { calls.push("provider-status"); }}
			onRefreshLibrary={() => { calls.push("library"); }}
		/>,
	));
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(calls).toEqual(["unavailable"]);
	flushSync(() => root.unmount());
	host.remove();
});
