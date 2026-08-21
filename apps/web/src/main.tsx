import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import {
	createProductionTauriPlaybackQuiescenceAdapter,
	type TauriPlaybackQuiescenceAdapter,
} from "./adapters/tauri/tauri-playback-quiescence-adapter";
import {
	createDisabledUpdateRuntimePort,
	createTauriUpdateRuntimePort,
	type DisposableUpdateRuntimePort,
} from "./adapters/tauri/tauri-update-runtime";
import {
	applyHydratedShellPreferencesSnapshot,
	loadHydratedShellPreferencesSnapshot,
} from "./app/runtime/useShellPreferences";
import { DesktopLyricsRoot, isDesktopLyricsRoute } from "./desktop-lyrics/DesktopLyricsRoot";
import {
	createHomeListenLegacyPreferenceMapping,
	createPreferencesHomeListenRepository,
} from "./features/home/home-preferences-adapter";
import { configureSearchPreferences } from "./features/search/search-session-runtime";
import { createUpdateExperienceController } from "./features/updater/update-experience-controller";
import { createPreferencesRepository } from "./preferences/create-preferences-repository";
import "./styles.css";

const isM4ParityRoute = new URLSearchParams(window.location.search).get("m4-parity") === "1";

async function createApplicationRoot(): Promise<React.ReactNode> {
	if (isDesktopLyricsRoute(window.location)) {
		document.body.classList.add("desktop-lyrics-root");
		return <DesktopLyricsRoot />;
	}
	if (isM4ParityRoute) {
		return React.createElement(
			React.lazy(() =>
				import("./visual/parity/M4ParityRoot").then((module) => ({
					default: module.M4ParityRoot,
				})),
			),
		);
	}
	// 更新 Port/Controller 的生命周期属于 bootstrap；StrictMode 重挂不能重建 native listener。
	let updateRuntime: DisposableUpdateRuntimePort;
	try {
		updateRuntime = await createTauriUpdateRuntimePort();
	} catch (error) {
		// 更新链故障不得阻止播放器、离线能力或运行时启动。
		console.warn("updater bootstrap failed; continuing with updates disabled", error);
		updateRuntime = createDisabledUpdateRuntimePort();
	}
	// 四个 Web quiescence listener 全部安装并触发 reconcile 后，React 才开始挂载播放 Runtime。
	let playbackQuiescenceAdapter: TauriPlaybackQuiescenceAdapter | null = null;
	try {
		playbackQuiescenceAdapter =
			await createProductionTauriPlaybackQuiescenceAdapter();
	} catch (error) {
		// 缺少静默桥只会让安装事务 fail closed，不能阻断普通播放启动。
		console.warn("updater quiescence bootstrap failed; continuing with updates disabled", error);
		updateRuntime.dispose();
		updateRuntime = createDisabledUpdateRuntimePort();
	}
	const updateController = createUpdateExperienceController(updateRuntime);
	window.addEventListener("pagehide", () => {
		playbackQuiescenceAdapter?.dispose();
		updateController.dispose();
		updateRuntime.dispose();
	}, { once: true });
	try {
		const preferences = await createPreferencesRepository({
			additionalLegacyMappings: [createHomeListenLegacyPreferenceMapping()],
		});
		await configureSearchPreferences(preferences);
		const hydratedPreferences =
			await loadHydratedShellPreferencesSnapshot(preferences);
		// React 首次读取 Zustand 前先应用 canonical 快照，避免 legacy 首帧闪回。
		applyHydratedShellPreferencesSnapshot(hydratedPreferences);
		const homeListenRepository =
			await createPreferencesHomeListenRepository(preferences);
		return (
			<App
				updateController={updateController}
				playbackQuiescenceAdapter={playbackQuiescenceAdapter}
				preferences={preferences}
				hydratedPreferences={hydratedPreferences}
				homeListenRepository={homeListenRepository}
			/>
		);
	} catch (error) {
		// 偏好存储故障不能阻止播放器启动；各 legacy Adapter 仍可回退读取。
		console.warn("M8 preferences bootstrap failed", error);
		return (
			<App
				updateController={updateController}
				playbackQuiescenceAdapter={playbackQuiescenceAdapter}
			/>
		);
	}
}

void createApplicationRoot().then((root) => {
	createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<React.Suspense fallback={null}>{root}</React.Suspense>
		</React.StrictMode>,
	);
});
