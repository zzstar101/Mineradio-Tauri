import { SidecarClient } from "../../api/sidecar-client";
import type {
	ApplicationPorts,
	ApplicationRuntimePort,
} from "../../ports/application-runtime-port";
import type { DesktopRuntimePort } from "../../ports/desktop-runtime-port";
import {
	getRuntimeConfig,
	type RuntimeConfig,
} from "../../tauri/runtime";
import { createTauriDesktopRuntime } from "../tauri/tauri-desktop-runtime";
import { createLegacyApiRuntime } from "./legacy-api-runtime";
import { createLegacyMediaUrl } from "./legacy-media-url";
import { createLegacySidecarServices } from "./legacy-sidecar-services";

export interface LegacyApplicationRuntimeDependencies {
	initialRuntimeConfig?: RuntimeConfig | null;
	loadRuntimeConfig?: () => Promise<RuntimeConfig>;
	createClient?: (config: RuntimeConfig) => SidecarClient;
	createDesktopRuntime?: () => DesktopRuntimePort;
}

export function createLegacyApplicationRuntime(
	dependencies: LegacyApplicationRuntimeDependencies = {},
): ApplicationRuntimePort {
	const loadRuntimeConfig = dependencies.loadRuntimeConfig ?? getRuntimeConfig;
	const createClient = dependencies.createClient
		?? ((config: RuntimeConfig) => new SidecarClient(config.sidecarBaseUrl, undefined, config.mediaProxyBase));
	const createDesktopRuntime = dependencies.createDesktopRuntime
		?? createTauriDesktopRuntime;

	return {
		async connect(): Promise<ApplicationPorts | null> {
			let config: RuntimeConfig;
			try {
				config = dependencies.initialRuntimeConfig ?? await loadRuntimeConfig();
			} catch {
				// 与既有启动行为一致：配置不可用时不发布伪造的 ready runtime。
				return null;
			}
			if (!config.sidecarBaseUrl) return null;

			// 单次连接只创建一个 client，确保所有 Ports 属于同一 transport generation。
			const client = createClient(config);
			return {
				music: createLegacySidecarServices(client),
				apiRuntime: createLegacyApiRuntime(client),
				mediaUrl: createLegacyMediaUrl(client),
				desktop: createDesktopRuntime(),
			};
		},
	};
}
