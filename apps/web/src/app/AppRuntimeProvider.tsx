import {
	createContext,
	useContext,
	type ReactNode,
} from "react";
import type { AppServices } from "./app-services";

const missingServices = Symbol("missing-app-services");
const AppServicesContext = createContext<AppServices | null | typeof missingServices>(
	missingServices,
);

export interface AppRuntimeProviderProps {
	services: AppServices | null;
	children: ReactNode;
}

export function AppRuntimeProvider({
	services,
	children,
}: AppRuntimeProviderProps) {
	return (
		<AppServicesContext.Provider value={services}>
			{children}
		</AppServicesContext.Provider>
	);
}

export function useAppServices(): AppServices | null {
	const services = useContext(AppServicesContext);
	if (services === missingServices) {
		throw new Error("useAppServices 必须在 AppRuntimeProvider 内使用");
	}
	return services;
}

export function useOptionalAppServices(): AppServices | null {
	const services = useContext(AppServicesContext);
	return services === missingServices ? null : services;
}
