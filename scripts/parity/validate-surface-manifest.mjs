export const PRODUCT_STATUSES = Object.freeze([
	"EXACT",
	"CLOSE",
	"PARTIAL",
	"MISSING",
	"REGRESSION",
	"DEBUG_LEAKAGE",
	"UNVERIFIED",
]);

export const SURFACE_SEVERITIES = Object.freeze(["P0", "P1", "P2"]);

const RC_BLOCKING_P1_STATUSES = new Set([
	"REGRESSION",
	"DEBUG_LEAKAGE",
	"MISSING",
]);

export function validateSurfaceManifest(manifest) {
	const errors = [];
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		return ["manifest must be an object"];
	}
	if (manifest.rcReady !== true && manifest.rcReady !== false) {
		errors.push("rcReady must be boolean");
	}
	const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : [];
	if (surfaces.length !== 101) {
		errors.push(`surface count must be 101 (received ${surfaces.length})`);
	}

	const ids = new Set();
	for (const [index, surface] of surfaces.entries()) {
		const label = surface?.id ?? `index ${index}`;
		if (!/^S\d{3}$/.test(surface?.id ?? "")) {
			errors.push(`${label}: invalid surface id`);
		} else if (ids.has(surface.id)) {
			errors.push(`${surface.id}: duplicate surface id`);
		} else {
			ids.add(surface.id);
		}
		if (typeof surface?.name !== "string" || !surface.name.trim()) {
			errors.push(`${label}: name is required`);
		}
		if (!SURFACE_SEVERITIES.includes(surface?.severity)) {
			errors.push(`${label}: invalid severity ${surface?.severity}`);
		}
		if (!PRODUCT_STATUSES.includes(surface?.productStatus)) {
			errors.push(`${label}: invalid productStatus ${surface?.productStatus}`);
		}
		if (typeof surface?.blocker !== "boolean") {
			errors.push(`${label}: blocker must be boolean`);
		}
		if (typeof surface?.ownerArea !== "string" || !surface.ownerArea.trim()) {
			errors.push(`${label}: ownerArea is required`);
		}
		if (typeof surface?.notes !== "string") {
			errors.push(`${label}: notes must be a string`);
		}
		for (const field of [
			"codePresent",
			"automatedVerified",
			"visualVerified",
			"fieldVerified",
		]) {
			if (typeof surface?.evidence?.[field] !== "boolean") {
				errors.push(`${label}: evidence.${field} must be boolean`);
			}
		}
	}

	for (let index = 1; index <= 101; index += 1) {
		const expected = `S${String(index).padStart(3, "0")}`;
		if (!ids.has(expected)) errors.push(`${expected}: canonical surface is missing`);
	}

	const blockingP1 = surfaces.filter((surface) =>
		surface?.severity === "P1" && RC_BLOCKING_P1_STATUSES.has(surface?.productStatus),
	);
	if (blockingP1.length > 0 && manifest.rcReady !== false) {
		errors.push(
			`rcReady must remain false while P1 blocking statuses exist: ${blockingP1.map((surface) => surface.id).join(", ")}`,
		);
	}

	if (manifest.rcReady === true) {
		const missingProductEvidence = surfaces.filter((surface) =>
			surface?.evidence?.codePresent === true &&
			(surface?.evidence?.visualVerified !== true || surface?.evidence?.fieldVerified !== true),
		);
		if (missingProductEvidence.length > 0) {
			errors.push(
			`rcReady cannot be inferred from code presence without visual and field evidence: ${missingProductEvidence.map((surface) => surface.id).join(", ")}`,
		);
		}
		const explicitBlockers = surfaces.filter((surface) => surface?.blocker === true);
		if (explicitBlockers.length > 0) {
			errors.push(
			`rcReady cannot be true while explicit blockers exist: ${explicitBlockers.map((surface) => surface.id).join(", ")}`,
		);
		}
	}

	return errors;
}
