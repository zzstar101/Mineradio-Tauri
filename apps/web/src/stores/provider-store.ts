import { create } from "zustand";
import type { CapabilityMatrix, ProviderId } from "@mineradio/shared";

export interface ProviderStatusInfo {
	registered: boolean;
	configured: boolean;
	available: boolean;
	fieldVerified: boolean;
	message?: string;
}

export interface ProviderState {
	matrix: CapabilityMatrix | null;
	status: Record<ProviderId, ProviderStatusInfo> | null;
	error: string | null;
	setMatrix: (matrix: CapabilityMatrix) => void;
	setError: (error: string | null) => void;
	reset: () => void;
}

function deriveStatus(matrix: CapabilityMatrix): Record<ProviderId, ProviderStatusInfo> {
	const result = {} as Record<ProviderId, ProviderStatusInfo>;
	for (const entry of matrix.providers) {
		result[entry.providerId] = {
			registered: entry.registered,
			configured: entry.configured,
			available: entry.available,
			fieldVerified: entry.fieldVerified,
			message: entry.message,
		};
	}
	return result;
}

export const useProviderStore = create<ProviderState>()((set) => ({
	matrix: null,
	status: null,
	error: null,
	setMatrix: (matrix) =>
		set({
			matrix,
			status: deriveStatus(matrix),
		}),
	setError: (error) => set({ error }),
	reset: () => set({ matrix: null, status: null, error: null }),
}));