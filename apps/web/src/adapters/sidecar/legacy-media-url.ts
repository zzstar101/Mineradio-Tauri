import type { SidecarClient } from "../../api/sidecar-client";
import type {
	MediaImageSource,
	MediaUrlOptions,
	MediaUrlPort,
} from "../../ports/media-url-port";
import { inspectCoverSource } from "@mineradio/shared";

export function createLegacyMediaUrl(
	client: Pick<SidecarClient, "audioProxyUrl"> &
		Partial<Pick<SidecarClient, "imageProxyUrl" | "proxiedUrl">>,
): MediaUrlPort {
	const imageSource = (
		url: string,
		options?: MediaUrlOptions,
	): MediaImageSource => {
		const inspected = inspectCoverSource(url);
		if (inspected.kind === "empty" || inspected.kind === "invalid") {
			return { uri: "", logicalSource: "" };
		}
		const uri = inspected.kind === "remote"
			? typeof client.imageProxyUrl === "function"
				? client.imageProxyUrl(
					inspected.normalized,
					options?.cacheBust ?? false,
					options?.now ?? Date.now(),
				)
				: ""
			: inspected.normalized;
		return {
			uri,
			logicalSource: inspected.normalized,
		};
	};
	return {
		audioProxyUrl: (url) => client.audioProxyUrl(url),
		playableUrl: (url) => typeof client.proxiedUrl === "function"
			? client.proxiedUrl(url)
			: url,
		imageSource,
		imageUrl: (url, options) => imageSource(url, options).uri,
	};
}
