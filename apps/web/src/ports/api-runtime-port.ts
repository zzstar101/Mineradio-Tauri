import type {
	CapabilityMatrix,
} from "@mineradio/shared";

export interface ApiRuntimeConfig {
	appDataDir: string;
	appVersion: string;
	schemaVersion: string;
	updaterPublicKeyConfigured: boolean;
}

export interface ApiRuntimePort {
	getConfig(): Promise<ApiRuntimeConfig>;
	capabilities(): Promise<CapabilityMatrix>;
}
