import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DESKTOP_COMMAND_REGISTRATION_ORDER,
	D2_UPDATE_RUNTIME_COMMANDS,
	D2_UPDATE_RUNTIME_INTERFACES,
	FROZEN_DESKTOP_COMMANDS,
	FROZEN_DESKTOP_ERROR_STRINGS,
	FROZEN_DESKTOP_COMMAND_INTERFACES,
	FROZEN_DESKTOP_SERIALIZATION_CONTRACTS,
	M5_ADDITIVE_DESKTOP_COMMANDS,
	M6_ADDITIVE_DESKTOP_COMMANDS,
	M7_ADDITIVE_DESKTOP_COMMANDS,
	M8_ADDITIVE_DESKTOP_COMMANDS,
	M10_ADDITIVE_DESKTOP_COMMANDS,
	PLAYBACK_SESSION_ADDITIVE_DESKTOP_COMMANDS,
	M8_DESKTOP_COMMAND_INTERFACES,
	parseDesktopCommandManifest,
	parseFrozenDesktopErrorStrings,
	parseFrontendDesktopInvokes,
	parseRustSerializationContracts,
	parseTauriCommandInterfaces,
} from "./desktop-command-manifest.mjs";

const sourceRoot = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));
const frozenContractSources = [
	"app/state.rs",
	"db.rs",
	"runtime/updater/mod.rs",
	"runtime/hotkeys.rs",
	"runtime/window_contract.rs",
	"runtime/desktop_lyrics.rs",
	"commands/runtime.rs",
	"commands/updater.rs",
	"commands/window.rs",
	"commands/dialogs.rs",
	"commands/login.rs",
].map((name) => readFileSync(join(sourceRoot, name), "utf8"));

test("M5/M6/M7/M8 preserves frozen desktop commands and only adds approved manifests", () => {
	const source = readFileSync(`${sourceRoot}/lib.rs`, "utf8");
	const commands = parseDesktopCommandManifest(source);

	expect(commands).toEqual(DESKTOP_COMMAND_REGISTRATION_ORDER);
	expect(new Set(commands)).toEqual(
		new Set([
			...FROZEN_DESKTOP_COMMANDS,
			...M5_ADDITIVE_DESKTOP_COMMANDS,
			...M6_ADDITIVE_DESKTOP_COMMANDS,
			...M7_ADDITIVE_DESKTOP_COMMANDS,
			...M8_ADDITIVE_DESKTOP_COMMANDS,
			...M10_ADDITIVE_DESKTOP_COMMANDS,
			...PLAYBACK_SESSION_ADDITIVE_DESKTOP_COMMANDS,
			...D2_UPDATE_RUNTIME_COMMANDS,
		]),
	);
});

test("frozen command parameter and return interfaces match the approved fixture", () => {
	const commandSource = readdirSync(`${sourceRoot}/commands`)
		.filter((name) => name.endsWith(".rs"))
		.map((name) => readFileSync(join(sourceRoot, "commands", name), "utf8"))
		.join("\n");
	const interfaces = parseTauriCommandInterfaces(commandSource);

	for (const [command, expected] of Object.entries(FROZEN_DESKTOP_COMMAND_INTERFACES)) {
		expect(interfaces[command]).toBe(expected);
	}
	for (const [command, expected] of Object.entries(M8_DESKTOP_COMMAND_INTERFACES)) {
		expect(interfaces[command]).toBe(expected);
	}
	for (const [command, expected] of Object.entries(D2_UPDATE_RUNTIME_INTERFACES)) {
		expect(interfaces[command]).toBe(expected);
	}
});

test("frozen command serialization shape and serde casing match the approved fixture", () => {
	const contracts = parseRustSerializationContracts(frozenContractSources.join("\n"));
	for (const [name, expected] of Object.entries(FROZEN_DESKTOP_SERIALIZATION_CONTRACTS)) {
		expect(contracts[name]).toEqual(expected);
	}
});

test("frozen deterministic command errors match the approved fixture", () => {
	expect(parseFrozenDesktopErrorStrings(frozenContractSources.join("\n")))
		.toEqual([...FROZEN_DESKTOP_ERROR_STRINGS].sort());
});

test("every literal frontend desktop invoke is registered in the Rust manifest", () => {
	const webSources = [
		"../../apps/web/src/tauri/runtime.ts",
		"../../apps/web/src/adapters/tauri/tauri-update-runtime.ts",
		"../../apps/web/src/adapters/tauri/tauri-playback-session.ts",
		"../../apps/web/src/tauri/db.ts",
		"../../apps/web/src/adapters/tauri/tauri-preferences.ts",
		"../../apps/web/src/desktop-lyrics/desktop-lyrics-bridge.ts",
	].map((relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
	const invokes = new Set(webSources.flatMap(parseFrontendDesktopInvokes));
	invokes.add("login_netease_complete");
	invokes.add("login_qq_complete");
	const registered = new Set([
		...FROZEN_DESKTOP_COMMANDS,
		...M5_ADDITIVE_DESKTOP_COMMANDS,
		...M6_ADDITIVE_DESKTOP_COMMANDS,
		...M7_ADDITIVE_DESKTOP_COMMANDS,
		...M8_ADDITIVE_DESKTOP_COMMANDS,
		...M10_ADDITIVE_DESKTOP_COMMANDS,
		...PLAYBACK_SESSION_ADDITIVE_DESKTOP_COMMANDS,
		...D2_UPDATE_RUNTIME_COMMANDS,
	]);

	for (const command of invokes) expect(registered.has(command)).toBe(true);
});

test("M5 command adapters are domain modules instead of a monolithic commands.rs", () => {
	expect(existsSync(`${sourceRoot}/commands.rs`)).toBe(false);
	for (const module of [
		"mod.rs",
		"runtime.rs",
		"updater.rs",
		"hotkeys.rs",
		"dialogs.rs",
		"login.rs",
		"desktop_lyrics.rs",
		"window.rs",
		"window_runtime.rs",
		"cache.rs",
		"diagnostics.rs",
		"wallpaper_engine.rs",
		"preferences.rs",
	]) {
		expect(existsSync(`${sourceRoot}/commands/${module}`)).toBe(true);
	}
});
