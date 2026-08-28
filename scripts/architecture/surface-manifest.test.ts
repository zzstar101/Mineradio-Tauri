import { expect, test } from "bun:test";
import manifest from "../../docs/audit/2.1-surface-manifest.json";
import { validateSurfaceManifest } from "../parity/validate-surface-manifest.mjs";

test("2.1 parity authority contains exactly the canonical S001-S101 surface set", () => {
	expect(validateSurfaceManifest(manifest)).toEqual([]);
	expect(manifest.surfaces.map((surface) => surface.id)).toEqual(
		Array.from({ length: 101 }, (_, index) => `S${String(index + 1).padStart(3, "0")}`),
	);
});

test("RC readiness cannot be inferred from code presence alone", () => {
	const falsePositive = structuredClone(manifest) as typeof manifest;
	falsePositive.rcReady = true;
	falsePositive.surfaces = falsePositive.surfaces.map((surface) => ({
		...surface,
		blocker: false,
		productStatus: "CLOSE" as const,
		evidence: {
			...surface.evidence,
			codePresent: true,
			automatedVerified: true,
			visualVerified: false,
			fieldVerified: false,
		},
	}));

	expect(
		validateSurfaceManifest(falsePositive).some((error) =>
			error.includes("without visual and field evidence"),
		),
	).toBe(true);
});

test("P1 regression, debug leakage, or missing status forces RC readiness false", () => {
	for (const productStatus of ["REGRESSION", "DEBUG_LEAKAGE", "MISSING"] as const) {
		const falsePositive = structuredClone(manifest) as typeof manifest;
		falsePositive.rcReady = true;
		falsePositive.surfaces[0] = {
			...falsePositive.surfaces[0],
			severity: "P1",
			productStatus,
		};
		expect(
			validateSurfaceManifest(falsePositive).some((error) =>
				error.includes("rcReady must remain false"),
			),
		).toBe(true);
	}
});
