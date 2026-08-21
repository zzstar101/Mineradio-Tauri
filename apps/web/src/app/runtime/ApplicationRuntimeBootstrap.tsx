import { useEffect } from "react";
import type {
	CapabilityMatrix,
	ProviderId,
	ProviderLoginStatus,
} from "@mineradio/shared";
import type {
	ApplicationPorts,
	ApplicationRuntimePort,
} from "../../ports/application-runtime-port";

export interface ApplicationRuntimeBootstrapProps {
	applicationRuntime: ApplicationRuntimePort;
	loginProviders: readonly ProviderId[];
	onConnection: (ports: ApplicationPorts) => void;
	onCapabilities: (matrix: CapabilityMatrix) => void;
	onProviderStatus: (status: ProviderLoginStatus) => void;
	onRefreshLibrary: (ports: ApplicationPorts) => void;
}

/**
 * 启动时的一次性引导：连接运行时后同步能力矩阵、各 provider 登录态并刷新曲库。
 * 原 SidecarRecoveryRuntime 的健康轮询/重试/恢复通知已随 sidecar 进程移除；
 * `mineradio_api` in-process 初始化后常驻可用，无需心跳门禁。
 */
export function ApplicationRuntimeBootstrap({
	applicationRuntime,
	loginProviders,
	onConnection,
	onCapabilities,
	onProviderStatus,
	onRefreshLibrary,
}: ApplicationRuntimeBootstrapProps) {
	useEffect(() => {
		let cancelled = false;

		async function boot(): Promise<void> {
			let connectedPorts: ApplicationPorts | null;
			try {
				connectedPorts = await applicationRuntime.connect();
			} catch {
				return;
			}
			if (cancelled || !connectedPorts) return;
			const ports = connectedPorts;

			onConnection(ports);

			try {
				const capabilities = await ports.apiRuntime.capabilities();
				if (!cancelled) onCapabilities(capabilities);
			} catch {
				// 能力矩阵同步失败不阻断现有播放器启动。
			}
			if (cancelled) return;
			const statusResults = await Promise.allSettled(
				loginProviders.map((provider) => (
					// Promise.resolve().then 把同步抛错转成 rejection，避免某个 provider
					// 端口缺失/报错时阻断整个启动同步。
					Promise.resolve().then(() => ports.music.accounts.loginStatus(provider))
				)),
			);
			if (cancelled) return;
			for (const result of statusResults) {
				if (result.status === "fulfilled") onProviderStatus(result.value);
			}
			onRefreshLibrary(ports);
		}

		void boot();
		return () => {
			cancelled = true;
		};
	}, [
		applicationRuntime,
		loginProviders,
		onCapabilities,
		onConnection,
		onProviderStatus,
		onRefreshLibrary,
	]);

	return null;
}
