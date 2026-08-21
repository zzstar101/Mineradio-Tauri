import type { ReactElement, RefObject } from "react";
import type {
  ProviderId,
  ProviderLoginStatus,
  ProviderVipIcon,
} from "@mineradio/shared";
import { TopRightControls, VipBadge } from "../../components/shell/TopRightControls";
import type { AccountStatusByProvider } from "./useAccountSessionController";
import {
  LOGIN_QR_PROVIDERS,
  type LoginModalMode,
  type LoginProviderId,
  type LoginQrByProvider,
  type LoginQrStatusByProvider,
} from "./useLoginQrRuntime";

type AccountVipBadge = {
  text: string;
  icon?: ProviderVipIcon;
  iconUrl?: string;
};

function accountVipBadge(
  status: ProviderLoginStatus | null | undefined,
): AccountVipBadge | null {
  if (!status?.loggedIn) return null;
  const text =
    status.vipLabel?.trim() ||
    (status.vipLevel === "svip"
      ? "SVIP"
      : status.vipLevel === "vip"
        ? "VIP"
        : "");
  if (!text) return null;
  return {
    text,
    icon: status.vipIcon,
    iconUrl: status.vipIconUrl,
  };
}

function providerLabel(provider: ProviderId): string {
  if (provider === "netease") return "网易云";
  if (provider === "qq") return "QQ 音乐";
  return "汽水音乐";
}

function loginTitleForProvider(provider: ProviderId): string {
  if (provider === "netease") return "扫码登录网易云音乐";
  if (provider === "qq") return "扫码登录 QQ 音乐";
  return "扫码登录汽水音乐";
}

function loginDescriptionForProvider(provider: ProviderId): string {
  if (provider === "netease") {
    return "使用网易云音乐 App 扫码，可同步歌单、红心与播客。";
  }
  if (provider === "qq") {
    return "使用 QQ 音乐 App 扫码，可同步歌单和播放授权。";
  }
  return "使用汽水音乐 App 扫码，可同步歌单、收藏与播放授权。";
}

function qrLoadingMarkForProvider(provider: ProviderId): string {
  if (provider === "netease") return "NE";
  if (provider === "qq") return "QQ";
  return "SD";
}

function cookiePlaceholderForProvider(provider: ProviderId): string {
  if (provider === "netease") return "MUSIC_U=...; __csrf=...";
  if (provider === "qq") return "uin=...; qm_keyst=...; qqmusic_key=...";
  return "sid_tt=...; sessionid=...";
}

export interface AccountSurfaceProps {
  statuses: AccountStatusByProvider;
  dropdownOpen: boolean;
  capsuleAutoHide: boolean;
  onHome(): void;
  onAccountClick(): void;
  onHideCapsule(): void;
  onRefreshStatus(provider: LoginProviderId): void;
  onLogout(provider: LoginProviderId): void;
  onOpenSingleProvider(provider: LoginProviderId): void;
}

export interface AccountOverlaySurfaceProps {
  statuses: AccountStatusByProvider;
  modalOpen: boolean;
  modalMode: LoginModalMode;
  provider: LoginProviderId;
  manualCookieOpen: boolean;
  qrByProvider: LoginQrByProvider;
  qrStatusByProvider: LoginQrStatusByProvider;
  cookieInputRefs: Record<
    LoginProviderId,
    RefObject<HTMLTextAreaElement | null>
  >;
  onClose(): void;
  onProviderChange(provider: LoginProviderId): void;
  onManualCookieToggle(): void;
  onRefreshQr(provider: LoginProviderId): void;
  onRefreshStatus(provider: LoginProviderId): void;
  onImportCookie(provider: LoginProviderId): void;
  onLogout(provider: LoginProviderId): void;
  onOpenSingleProvider(provider: LoginProviderId): void;
}

function providerCollections(statuses: AccountStatusByProvider) {
  const logged = LOGIN_QR_PROVIDERS.flatMap((provider) => {
    const status = statuses[provider];
    return status?.loggedIn ? [{ provider, status }] : [];
  });
  const missing = LOGIN_QR_PROVIDERS.filter(
    (provider) => !statuses[provider]?.loggedIn,
  );
  return { logged, missing };
}

export function AccountSurface({
  statuses,
  dropdownOpen,
  capsuleAutoHide,
  onHome,
  onAccountClick,
  onHideCapsule,
  onRefreshStatus,
  onLogout,
  onOpenSingleProvider,
}: AccountSurfaceProps): ReactElement {
  const { logged, missing } = providerCollections(statuses);
  const topStatus =
    LOGIN_QR_PROVIDERS.map((provider) => statuses[provider]).find(
      (status) => status?.loggedIn,
    ) ?? null;
  const topVipBadge = accountVipBadge(topStatus);

  return (
    <>
      <TopRightControls
        onHome={onHome}
        onLogin={onAccountClick}
        onHideCapsule={onHideCapsule}
        capsuleAutoHide={capsuleAutoHide}
        loggedIn={topStatus !== null}
        accountLabel={topStatus?.nickname ?? topStatus?.userId ?? undefined}
        accountAvatarUrl={topStatus?.avatarUrl}
        accountVipLevel={topStatus?.vipLevel}
        accountVipLabel={topVipBadge?.text}
        accountVipIcon={topVipBadge?.icon}
        accountVipIconUrl={topVipBadge?.iconUrl}
      />
      {dropdownOpen && logged.length > 0 ? (
        <div
          id="account-dropdown"
          className="account-dropdown"
          role="menu"
          aria-label="账号信息"
        >
          <div className="account-dropdown-title">账号信息</div>
          <div className="account-dropdown-list">
            {logged.map(({ provider, status }) => {
              const displayName = status.nickname ?? status.userId ?? "已登录";
              const vipBadge = accountVipBadge(status);
              return (
                <div
                  key={provider}
                  id={`account-dropdown-provider-${provider}`}
                  className={`account-dropdown-row account-pill ${provider}`}
                >
                  {status.avatarUrl ? (
                    <img
                      className="account-dropdown-avatar"
                      src={status.avatarUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="account-dropdown-avatar fallback"
                      aria-hidden="true"
                    >
                      {displayName.trim().slice(0, 1) || "账"}
                    </span>
                  )}
                  <div className="account-dropdown-main">
                    <div className="account-dropdown-provider">
                      {providerLabel(provider)}
                      {vipBadge ? (
                        <VipBadge
                          text={vipBadge.text}
                          icon={vipBadge.icon}
                          iconUrl={vipBadge.iconUrl}
                        />
                      ) : null}
                    </div>
                    <div className="account-dropdown-name">{displayName}</div>
                  </div>
                  <div className="account-dropdown-actions">
                    <button
                      type="button"
                      onClick={() => onRefreshStatus(provider)}
                    >
                      刷新
                    </button>
                    <button type="button" onClick={() => onLogout(provider)}>
                      退出
                    </button>
                  </div>
                </div>
              );
            })}
            {missing.length > 0 ? (
              <div className="account-dropdown-divider" />
            ) : null}
            {missing.map((provider) => (
              <button
                key={provider}
                id={`account-add-provider-${provider}`}
                className={`account-dropdown-add ${provider}`}
                type="button"
                onClick={() => onOpenSingleProvider(provider)}
              >
                <span>添加 {providerLabel(provider)}</span>
                <span>
                  {statuses[provider]?.loggedIn === false
                    ? "登录已失效"
                    : "扫码登录"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AccountOverlaySurface({
  statuses,
  modalOpen,
  modalMode,
  provider,
  manualCookieOpen,
  qrByProvider,
  qrStatusByProvider,
  cookieInputRefs,
  onClose,
  onProviderChange,
  onManualCookieToggle,
  onRefreshQr,
  onRefreshStatus,
  onImportCookie,
  onLogout,
  onOpenSingleProvider,
}: AccountOverlaySurfaceProps): ReactElement | null {
  if (!modalOpen) return null;
  const { logged, missing } = providerCollections(statuses);
  const loggedSummaries = logged.map(
    ({ provider: id, status }) =>
      `${providerLabel(id)} ${status.nickname ?? status.userId ?? "已登录"}`,
  );
  const activeQr = qrByProvider[provider];
  const activeQrStatus = qrStatusByProvider[provider];
  const activeStatus = statuses[provider];

  return (
    <div
      id="login-modal"
      className="modal-mask show"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal dual-login-modal${modalMode === "add-account" ? " add-account-modal" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
      >
        {modalMode === "full" ? (
          <div className="login-platform-tabs" id="login-platform-tabs">
            {LOGIN_QR_PROVIDERS.map((id) => (
              <button
                key={id}
                id={`login-provider-${id}`}
                className={`${id}${provider === id ? " active" : ""}`}
                type="button"
                onClick={() => onProviderChange(id)}
                aria-selected={provider === id}
              >
                {providerLabel(id)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="login-intro">
          <div className="login-intro-kicker">Mineradio</div>
          <div className="login-intro-title">音乐播放器，也是一座视觉舞台</div>
          <div className="login-intro-body">
            搜索或导入一首歌即可播放；登录后会同步歌单、红心和播客，登录态会保存在本机数据目录。
          </div>
        </div>
        {modalMode === "add-account" ? (
          <>
            <h2 id="login-modal-title">
              {missing.length > 0 ? "添加账号" : "账号信息"}
            </h2>
            <div id="login-modal-desc" className="desc">
              {missing.length > 0
                ? `当前已登录 ${loggedSummaries.join("、") || "一个音乐平台"}，选择要添加的平台。`
                : `当前已登录 ${loggedSummaries.join("、") || "全部音乐平台"}，可刷新状态或退出账号。`}
            </div>
            <div
              id="login-add-account-panel"
              className="login-add-account-panel"
            >
              {logged.map(({ provider: id, status }) => (
                <div
                  key={id}
                  id={`logged-login-provider-${id}`}
                  className={`login-account-card ${id}`}
                >
                  <div className="login-account-card-main">
                    <span className="login-add-provider-name">
                      {providerLabel(id)}
                    </span>
                    <span className="login-add-provider-meta">
                      {status.nickname ?? status.userId ?? "已登录"}
                    </span>
                  </div>
                  <div className="login-account-actions">
                    <button
                      className="modal-btn"
                      type="button"
                      onClick={() => onRefreshStatus(id)}
                    >
                      刷新
                    </button>
                    <button
                      className="modal-btn"
                      type="button"
                      onClick={() => onLogout(id)}
                    >
                      退出
                    </button>
                  </div>
                </div>
              ))}
              {missing.map((id) => (
                <button
                  key={id}
                  id={`add-login-provider-${id}`}
                  className={`login-add-provider-card ${id}`}
                  type="button"
                  onClick={() => onOpenSingleProvider(id)}
                >
                  <span className="login-add-provider-name">
                    {providerLabel(id)}
                  </span>
                  <span className="login-add-provider-meta">
                    {statuses[id]?.loggedIn === false
                      ? "登录已失效"
                      : "扫码添加这个账号"}
                  </span>
                </button>
              ))}
            </div>
            <div className="btn-row">
              <button className="modal-btn" type="button" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="login-modal-title">{loginTitleForProvider(provider)}</h2>
            <div id="login-modal-desc" className="desc">
              {loginDescriptionForProvider(provider)}
            </div>
            <div id="qr-shell" className="qr-shell">
              {activeQr?.img ? (
                <img
                  id="qr-img"
                  src={activeQr.img}
                  alt={`${providerLabel(provider)}登录二维码`}
                />
              ) : (
                <div className="qr-loading-mark" aria-hidden="true">
                  {qrLoadingMarkForProvider(provider)}
                </div>
              )}
            </div>
            <div id="qr-status" className={activeQrStatus.tone}>
              {activeQrStatus.text}
            </div>
            <div className="account-status-line">
              {activeStatus?.loggedIn
                ? `已登录 ${activeStatus.nickname ?? activeStatus.userId ?? ""}`
                : "未确认登录"}
            </div>
            <div
              id="qq-cookie-panel"
              className={`qq-cookie-panel${manualCookieOpen ? " show" : ""}`}
            >
              <textarea
                ref={cookieInputRefs[provider]}
                id={`${provider}-cookie-input`}
                className="qq-cookie-input"
                spellCheck={false}
                autoComplete="off"
                placeholder={cookiePlaceholderForProvider(provider)}
              />
              <div className="qq-cookie-actions">
                <div className="qq-cookie-note">
                  手动导入只会写入本机会话。
                </div>
                <button
                  className="modal-btn primary"
                  type="button"
                  onClick={() => onImportCookie(provider)}
                >
                  保存
                </button>
              </div>
            </div>
            <div className="btn-row">
              <button className="modal-btn" type="button" onClick={onClose}>
                关闭
              </button>
              <button
                id="refresh-qr-btn"
                className="modal-btn primary"
                type="button"
                onClick={() => onRefreshQr(provider)}
              >
                刷新二维码
              </button>
              <button
                id="qq-cookie-toggle-btn"
                className="modal-btn show"
                type="button"
                onClick={onManualCookieToggle}
              >
                手动导入
              </button>
              <button
                className="modal-btn"
                type="button"
                onClick={() => onRefreshStatus(provider)}
              >
                刷新状态
              </button>
              <button
                className="modal-btn"
                type="button"
                onClick={() => onLogout(provider)}
              >
                退出
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
