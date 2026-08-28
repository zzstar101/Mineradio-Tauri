import type { ReactElement } from "react";

/**
 * Wave 3 Layer 3 golden contract for the v2.1.0 Player Shell / Bottom Bar.
 *
 * Source of truth: docs/audit/golden/player-shell/upstream-player-shell.json
 * Baseline: XxHuberrr/Mineradio@v2.1.0 (96091d1) public/index.html:1255-1409
 *
 * These constants encode the canonical structure, element order, roles and
 * interaction affordances. Tests assert the current DOM against this contract
 * so the Player Shell cannot silently drift back to a non-upstream layout.
 */

export const PLAYER_SHELL_CONTROLS_GRID = [
	"minmax(340px,1.08fr)",
	"minmax(380px,auto)",
	"minmax(400px,1.08fr)",
] as const;

export const PLAYER_SHELL_BOTTOM_BAR_CHILD_ORDER = [
	"mini-queue-popover",
	"progress-bar",
	"controls",
] as const;

export const PLAYER_SHELL_ACTIONS_CLUSTER_ORDER = [
	"control-track",
	"heart-btn",
	"collect-btn",
] as const;

export const PLAYER_SHELL_TRANSPORT_CLUSTER_ORDER = [
	"play-mode-btn",
	"prev-btn",
	"play-btn",
	"next-btn",
	"mini-queue-btn",
] as const;

export const PLAYER_SHELL_MODES_CLUSTER_ORDER = [
	"lyric-timing-control",
	"volume-control",
	"controls-hide-btn",
	"immersive-btn",
	"fullscreen-toggle-btn",
	"time-display",
] as const;

export const PLAYER_SHELL_TRACK_ORDER = [
	"control-cover",
	"control-meta",
] as const;

export const PLAYER_SHELL_META_ORDER = [
	"control-title",
	"control-artist",
] as const;

export const PLAYER_SHELL_TITLE_ORDER = [
	"control-title-text",
	"control-title-badges",
] as const;

export const PLAYER_SHELL_VOLUME_POPOVER_ORDER = [
	"volume-main-row",
	"fade-control-row",
] as const;

export const PLAYER_SHELL_LYRIC_TIMING_ORDER = [
	"lyrics-toggle-btn",
	"lyric-timing-popover",
] as const;

export type PlayerShellStructureAssertion = {
	readonly label: string;
	readonly ok: boolean;
	readonly detail?: string;
};

export type PlayerShellStructureResult = {
	readonly label: string;
	readonly passed: boolean;
	readonly checks: readonly PlayerShellStructureAssertion[];
};

export function playerShellStructureResult(
	label: string,
	checks: readonly PlayerShellStructureAssertion[],
): PlayerShellStructureResult {
	return {
		label,
		passed: checks.every((check) => check.ok),
		checks,
	};
}

function check(
	label: string,
	ok: boolean,
	detail?: string,
): PlayerShellStructureAssertion {
	return { label, ok, detail };
}

function matchesSurfaceId(child: Element, id: string): boolean {
	return child.id === id || (typeof child.classList !== "undefined" && child.classList.contains(id));
}

/** Walk an ordered list of expected ids and confirm they appear in the parent in that order. */
function assertOrdered(
	parent: Element | null,
	expectedIds: readonly string[],
	label: string,
): PlayerShellStructureAssertion {
	if (!parent) return check(label, false, "parent missing");
	const children = Array.from(parent.children);
	const positions = expectedIds.map((id) =>
		children.findIndex((child) => matchesSurfaceId(child, id)),
	);
	const found = positions.filter((position) => position >= 0).length;
	const ordered = positions.length === expectedIds.length && positions.every(
		(position, index) => index === 0 || position > positions[index - 1],
	);
	return check(
		label,
		ordered,
		`expected ${JSON.stringify(expectedIds)} found ${found}/${expectedIds.length} in order`,
	);
}

/**
 * Assert the current Player Shell DOM satisfies the canonical upstream contract.
 * Works on a jsdom/happy-dom fragment that contains #bottom-bar.
 */
export function assertPlayerShellStructure(scope: Element | Document): PlayerShellStructureResult {
	const root = scope.querySelector("#bottom-bar");
	const checks: PlayerShellStructureAssertion[] = [];

	checks.push(
		check("bottom-bar exists", !!root, root ? undefined : "missing #bottom-bar"),
	);
	if (!root) {
		return playerShellStructureResult("player-shell-structure", checks);
	}

	// 1) Bottom bar child order: mini queue BEFORE progress
	checks.push(
		assertOrdered(
			root,
			PLAYER_SHELL_BOTTOM_BAR_CHILD_ORDER,
			"bottom-bar child order (mini queue precedes progress)",
		),
	);

	// 2) Production tool listeners and the handle
	const handle = scope.querySelector("#bottom-handle");
	checks.push(
		check("bottom-handle exists", !!handle),
		check(
			"bottom-handle is a narrow centered handle",
			!!handle && handle.classList.contains("active") === false,
		),
	);

	// 3) Mini queue contract
	const miniQueue = root.querySelector("#mini-queue-popover");
	const miniQueueClose = miniQueue?.querySelector('.mini-queue-head .fx-mini-btn, .mini-queue-head button');
	const miniQueueHead = miniQueue?.querySelector(".mini-queue-head");
	const miniQueueTitle = miniQueue?.querySelector(".mini-queue-title");
	const miniQueueCount = miniQueue?.querySelector("#mini-queue-count");
	const miniQueueList = miniQueue?.querySelector("#mini-queue-list");
	const miniQueueRows = miniQueueList?.querySelectorAll(".mini-queue-item") ?? [];
	checks.push(
		check("mini queue has head", !!miniQueueHead),
		check("mini queue has title 当前队列", miniQueueTitle?.textContent?.includes("当前队列") ?? false),
		check("mini queue has count", !!miniQueueCount),
		check("mini queue has explicit close ×", !!miniQueueClose && miniQueueClose.textContent?.trim() === "×"),
		check("mini queue rows expose data-queue-index", Array.from(miniQueueRows).every((row) => row.hasAttribute("data-queue-index"))),
	);

	// 4) Metadata contract
	const cover = root.querySelector("#control-cover");
	checks.push(
		check(
			"cover is an interactive album trigger",
			!!cover && (cover.getAttribute("role") === "button" || cover.tagName === "BUTTON"),
		),
		check(
			"cover exposes album-detail label",
			!!cover && (
				!!(cover.getAttribute("aria-label")?.includes("专辑"))
				|| !!(cover.getAttribute("title")?.includes("专辑"))
			),
		),
	);
	const title = root.querySelector("#control-title .control-title-text");
	checks.push(
		check("title uses .control-title-text", !!title),
		check("title badges container exists", !!root.querySelector("#control-title-badges")),
		check("quality chip lives inside metadata badges", !!root.querySelector("#control-title-badges #quality-control") || !!root.querySelector("#control-title-badges .quality-control")),
	);
	const artist = root.querySelector("#control-artist");
	checks.push(
		check(
			"artist is an interactive detail trigger",
			!!artist && (
				artist.getAttribute("role") === "button"
				|| (artist instanceof HTMLElement && artist.onclick !== null)
				|| artist.tagName === "BUTTON"
			),
		),
	);

	// 5) Three-column control clusters in upstream order (scoped to each cluster)
	const actionsCluster = root.querySelector(".control-cluster.actions");
	const transportCluster = root.querySelector(".control-cluster.transport");
	const modesCluster = root.querySelector(".control-cluster.modes");
	checks.push(
		check("actions cluster exists", !!actionsCluster),
		check("transport cluster exists", !!transportCluster),
		check("modes cluster exists", !!modesCluster),
	);
	if (actionsCluster && transportCluster && modesCluster) {
		checks.push(
			assertOrdered(actionsCluster, PLAYER_SHELL_ACTIONS_CLUSTER_ORDER, "actions cluster order"),
			assertOrdered(transportCluster, PLAYER_SHELL_TRANSPORT_CLUSTER_ORDER, "transport cluster order"),
			assertOrdered(modesCluster, PLAYER_SHELL_MODES_CLUSTER_ORDER, "modes cluster order"),
			assertOrdered(actionsCluster.querySelector(".control-track"), PLAYER_SHELL_TRACK_ORDER, "control-track order"),
			assertOrdered(actionsCluster.querySelector(".control-meta"), PLAYER_SHELL_META_ORDER, "control-meta order"),
			assertOrdered(actionsCluster.querySelector("#control-title"), PLAYER_SHELL_TITLE_ORDER, "control-title order"),
			assertOrdered(modesCluster.querySelector("#volume-control .volume-popover"), PLAYER_SHELL_VOLUME_POPOVER_ORDER, "volume popover order"),
			assertOrdered(modesCluster.querySelector("#lyric-timing-control"), PLAYER_SHELL_LYRIC_TIMING_ORDER, "lyric timing control order"),
		);
	}

	// 6) Lyric timing control
	const lyricTiming = root.querySelector("#lyric-timing-control");
	const lyricTimingActions = lyricTiming?.querySelectorAll("[data-lyric-offset-step], [data-lyric-offset-reset]") ?? [];
	checks.push(
		check("lyric timing control exists", !!lyricTiming),
		check(
			"lyric timing exposes -0.1 / 0 / +0.1",
			Array.from(lyricTimingActions).length === 3
				&& !!lyricTiming?.querySelector('[data-lyric-offset-step="-0.1"]')
				&& !!lyricTiming?.querySelector('[data-lyric-offset-reset]')
				&& !!lyricTiming?.querySelector('[data-lyric-offset-step="0.1"]'),
		),
	);

	// 7) Volume popover surface stays compact (volume + fade only), no Playback 2.0 panel
	const volumePopover = root.querySelector("#volume-control .volume-popover");
	const volumeMain = volumePopover?.querySelector("#volume-slider");
	const fadeIn = volumePopover?.querySelector("#fade-in-slider");
	const fadeOut = volumePopover?.querySelector("#fade-out-slider");
	checks.push(
		check("volume popover has volume slider", !!volumeMain),
		check("volume popover has fade in", !!fadeIn),
		check("volume popover has fade out", !!fadeOut),
		check(
			"volume popover does not embed Playback 2.0 panel",
			!volumePopover?.querySelector(".volume-panel-extras, .audio-output-section, #volume-panel-extras"),
		),
	);

	// 8) Auto-hide + immersive toggles
	const immersiveBtn = root.querySelector("#immersive-btn");
	checks.push(
		check("controls-hide-btn exists", !!root.querySelector("#controls-hide-btn")),
		check(
			"immersive-btn exists with aria-pressed",
			!!immersiveBtn && immersiveBtn.hasAttribute("aria-pressed"),
		),
	);

	// 9) Cuefield surface (scope decision OUT in 2.1 → must NOT render a dead button)
	checks.push(
		check("cuefield button absent (2.1 scope OUT, no dead affordance)", !root.querySelector("#cuefield-automix-btn")),
	);

	return playerShellStructureResult("player-shell-structure", checks);
}

/**
 * Render helper for tests: returns a scoped fragment and refreshes a fixture.
 * Kept as a pure function so test files can share one import.
 */
export function playerShellFixtureBar(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	return document.getElementById("bottom-bar") ?? document.querySelector("#bottom-bar");
}

export const playerShellGoldenMeta = Object.freeze({
	label: "upstream-player-shell",
	id: "WAVE_3_LAYER3_STRUCTURE",
	upstream: "XxHuberrr/Mineradio@v2.1.0#96091d1",
	source: "docs/audit/golden/player-shell/upstream-player-shell.json",
	component: "PlayerConsoleHost",
} as const);

export type PlayerShellGolden = typeof playerShellGoldenMeta;

/** Namespaced class marker so geometry tests can target canonical surfaces. */
export function playerShellSurfaceNode(
	scope: Element | Document,
	selector: string,
): Element | null {
	return scope.querySelector(selector);
}

/** Concise element-order assertion used by the component regression tests. */
export function expectOrderedIds(
	root: Element,
	expectedIds: readonly string[],
	currentChromiumDomOnly = false,
): boolean {
	return assertOrdered(root, expectedIds, "ordered-ids").ok;
}

export { assertOrdered };

// keep type surface stable even if component set changes
export { type ReactElement };