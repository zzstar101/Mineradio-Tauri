import type {
	ProviderId,
	ProviderLoginQrCheck,
	ProviderLoginQrImage,
	ProviderLoginQrKey,
	ProviderLoginStatus,
	ProviderLogoutAck,
	ProviderSessionCookieAck,
	QrLoginKind,
} from "@mineradio/shared";

export type { QrLoginKind };

export interface AccountPort {
	loginStatus(provider: ProviderId): Promise<ProviderLoginStatus>;
	createLoginQrKey(provider: ProviderId, kind?: QrLoginKind): Promise<ProviderLoginQrKey>;
	createLoginQrImage(provider: ProviderId, key: string, kind?: QrLoginKind): Promise<ProviderLoginQrImage>;
	checkLoginQr(provider: ProviderId, key: string, kind?: QrLoginKind): Promise<ProviderLoginQrCheck>;
	setSessionCookie(provider: ProviderId, cookie: string): Promise<ProviderSessionCookieAck>;
	clearSessionCookie(provider: ProviderId): Promise<ProviderSessionCookieAck>;
	logout(provider: ProviderId): Promise<ProviderLogoutAck>;
}
