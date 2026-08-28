import { expect, test } from "bun:test";
import { useProviderStore } from "./provider-store";

test("setMatrix derives provider status from the matrix", () => {
	useProviderStore.getState().reset();
	useProviderStore.getState().setMatrix({
		version: "0.1.0",
		providers: [
			{ providerId: "netease", registered: true, configured: true, available: false, fieldVerified: false, capabilities: [], message: "registered" },
			{ providerId: "qq", registered: true, configured: false, available: false, fieldVerified: false, capabilities: [], message: "pending" },
		],
		services: [],
	});
	const status = useProviderStore.getState().status;
	expect(status?.netease.registered).toBe(true);
	expect(status?.netease.available).toBe(false);
	expect(status?.netease.fieldVerified).toBe(false);
	expect(status?.netease.message).toBe("registered");
	expect(status?.qq.configured).toBe(false);
	expect(status?.qq.available).toBe(false);
	expect(status?.qq.message).toBe("pending");
});