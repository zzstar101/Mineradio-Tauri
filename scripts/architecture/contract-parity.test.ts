import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// scripts/ 不在工作区依赖解析范围内，直接引 shared 源码
import {
	PlaylistDetailSchema,
	RecommendationPageSchema,
	SongUrlResultSchema,
	TrackSchema,
} from "../../packages/shared/src/index";

/**
 * 前后端契约对拍（bun run 前硬性门禁，见根 package.json 的 contracts 脚本）。
 *
 * 金样 `packages/shared/contracts/rust-contracts.json` 由
 * api/tests/contract_goldens.rs 用真实 Rust 序列化生成；
 * 本测试保证：
 *   1. zod schema 能解析金样（Rust 发的字段前端必须认识、类型必须匹配）
 *   2. 字段集双向校验：
 *      - 金样里的每个字段都必须在 schema 中声明（防止 Rust 加字段前端漏接）
 *      - schema 中必填字段金样里必须存在（防止 Rust 删字段前端还当必填读）
 *
 * 契约有意的变更流程见 api/tests/contract_goldens.rs 头部注释。
 */
const goldens = JSON.parse(
	readFileSync(
		new URL("../../packages/shared/contracts/rust-contracts.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>;

const CONTRACT_SCHEMAS = {
	SongUrlResult: SongUrlResultSchema,
	Track: TrackSchema,
	PlaylistDetail: PlaylistDetailSchema,
	RecommendationPage: RecommendationPageSchema,
} as const;

function shapeKeysOf(schema: object): Map<string, boolean> {
	const shape = (schema as { shape: Record<string, { isOptional?: () => boolean }> }).shape;
	return new Map(Object.entries(shape).map(([key, field]) => [key, Boolean(field.isOptional?.())]));
}

for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
	test(`rust-contract ${name} 与前端 zod schema 对拍`, () => {
		const golden = goldens[name];
		expect(golden).toBeDefined();

		const parsed = schema.safeParse(golden);
		expect(parsed.success).toBe(true);

		const goldenKeys = new Set(Object.keys(golden as object));
		const shape = shapeKeysOf(schema);

		for (const key of goldenKeys) {
			expect(shape.has(key)).toBe(true);
		}
		for (const [key, isOptional] of shape) {
			if (!isOptional) {
				expect(goldenKeys.has(key)).toBe(true);
			}
		}
	});
}
