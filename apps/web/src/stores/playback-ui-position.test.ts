import { expect, test } from "bun:test";
import {
	PLAYBACK_UI_POSITION_INTERVAL_MS,
	createPlaybackUiPositionGate,
} from "./playback-ui-position";

test("连续 60Hz 媒体时钟只向 React UI 发布约 8Hz 快照", () => {
	const gate = createPlaybackUiPositionGate(0);
	let publishes = 0;
	for (let frame = 1; frame <= 60; frame += 1) {
		const nowMs = frame * (1_000 / 60);
		const positionMs = nowMs;
		if (!gate.shouldPublish(positionMs, nowMs)) continue;
		gate.markPublished(positionMs, nowMs);
		publishes += 1;
	}

	expect(PLAYBACK_UI_POSITION_INTERVAL_MS).toBe(125);
	expect(publishes).toBeGreaterThanOrEqual(7);
	expect(publishes).toBeLessThanOrEqual(9);
});

test("seek 跳变绕过 UI 限流并立即发布", () => {
	const gate = createPlaybackUiPositionGate(5_000);
	gate.markPublished(5_000, 100);
	expect(gate.shouldPublish(5_050, 110)).toBe(false);
	expect(gate.shouldPublish(25_000, 110)).toBe(true);
});
