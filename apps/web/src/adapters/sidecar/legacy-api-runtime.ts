import type { SidecarClient } from "../../api/sidecar-client";
import type { ApiRuntimePort } from "../../ports/api-runtime-port";
import { getRuntimeConfig } from "../../tauri/runtime";

export interface LegacyApiRuntimeDependencies {
	getRuntimeConfig: typeof getRuntimeConfig;
}

const defaultDependencies: LegacyApiRuntimeDependencies = {
	getRuntimeConfig,
};

export function createLegacyApiRuntime(
	client: Pick<SidecarClient, "capabilities">,
	dependencies: LegacyApiRuntimeDependencies = defaultDependencies,
): ApiRuntimePort {
	return {
		async getConfig() {
			const config = await dependencies.getRuntimeConfig();
			return {
				appDataDir: config.appDataDir,
				appVersion: config.appVersion,
				schemaVersion: config.schemaVersion,
				updaterPublicKeyConfigured: config.updaterPublicKeyConfigured,
			};
		},
		capabilities: () => client.capabilities(),
	};
}
