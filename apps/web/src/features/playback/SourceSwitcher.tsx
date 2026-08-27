import type { ProviderId } from "@mineradio/shared";
import type { ReactElement } from "react";

const PROVIDER_LABELS: Record<ProviderId, string> = {
	netease: "网易云",
	qq: "QQ",
	kugou: "酷狗",
	soda: "汽水",
};

export interface SourceSwitcherProps {
	currentProvider: ProviderId;
	availableProviders: readonly ProviderId[];
	busyProvider: ProviderId | null;
	disabled?: boolean;
	onSwitch(provider: ProviderId): void;
}

export function SourceSwitcher({
	currentProvider,
	availableProviders,
	busyProvider,
	disabled = false,
	onSwitch,
}: SourceSwitcherProps): ReactElement | null {
	const candidates = availableProviders.filter(
		(provider, index) =>
			provider !== currentProvider &&
			availableProviders.indexOf(provider) === index,
	);
	if (!candidates.length) return null;
	return (
		<div className="source-switcher" aria-label="切换音源">
			<span>音源</span>
			{candidates.map((provider) => (
				<button
					key={provider}
					type="button"
					data-source-provider={provider}
					disabled={disabled || busyProvider !== null}
					onClick={() => onSwitch(provider)}
				>
					{busyProvider === provider ? "匹配中…" : PROVIDER_LABELS[provider]}
				</button>
			))}
		</div>
	);
}
