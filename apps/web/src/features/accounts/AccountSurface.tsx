import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  RefObject,
} from "react";
import type {
  ProviderId,
  ProviderLoginStatus,
  ProviderVipIcon,
} from "@mineradio/shared";
import { TopRightControls, VipBadge } from "../../components/shell/TopRightControls";
import type { AccountStatusByProvider } from "./useAccountSessionController";
import {
  type LoginModalMode,
  type LoginProviderId,
  type LoginQrByProvider,
  type LoginQrStatusByProvider,
} from "./useLoginQrRuntime";
import { useFlipReorder, flipEntriesFromContainer } from "./useFlipReorder";
import {
	useProviderOrderController,
	type ProviderOrderStore,
} from "./useProviderOrderController";

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
  /** DI 注入口；缺省时使用应用共享单例。 */
  providerOrderStore?: ProviderOrderStore;
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
  /** DI 注入口；缺省时使用应用共享单例。 */
  providerOrderStore?: ProviderOrderStore;
}

function providerCollections(
  statuses: AccountStatusByProvider,
  orderedProviders: readonly LoginProviderId[],
) {
  const logged = orderedProviders.flatMap((provider) => {
    const status = statuses[provider];
    return status?.loggedIn ? [{ provider, status }] : [];
  });
  const missing = orderedProviders.filter(
    (provider) => !statuses[provider]?.loggedIn,
  );
  return { logged, missing };
}

/** 上游 topAccountPillClickSuppressed 同款阈值：位移超过 4px 才视为拖拽。 */
const PROVIDER_DRAG_THRESHOLD_PX = 4;

function providerKeyFromPoint(x: number, y: number): LoginProviderId | null {
  if (
    typeof document === "undefined" ||
    typeof document.elementFromPoint !== "function"
  ) {
    return null;
  }
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof Element)) return null;
  const row = element.closest("[data-flip-key]");
  if (!row) return null;
  const key = row.getAttribute("data-flip-key");
  return key === "netease" || key === "qq" || key === "soda" ? key : null;
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
  providerOrderStore,
}: AccountSurfaceProps): ReactElement {
  const orderController = useProviderOrderController({
    store: providerOrderStore,
  });
  const flip = useFlipReorder();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [draggingProvider, setDraggingProvider] =
    useState<LoginProviderId | null>(null);
  const suppressNextClickRef = useRef(false);

  const orderedProviders = orderController.orderedProviders();
  const { logged, missing } = providerCollections(statuses, orderedProviders);
  const topStatus =
    orderedProviders
      .map((provider) => statuses[provider])
      .find((status) => status?.loggedIn) ?? null;
  const topVipBadge = accountVipBadge(topStatus);

  const collectRows = useCallback(
    () => flipEntriesFromContainer(listRef.current),
    [],
  );

  useLayoutEffect(() => {
    flip.replay(collectRows());
  });

  const beginProviderRowDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, provider: LoginProviderId) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (active) return;
        const distance = Math.hypot(
          moveEvent.clientX - startX,
          moveEvent.clientY - startY,
        );
        if (distance < PROVIDER_DRAG_THRESHOLD_PX) return;
        active = true;
        setDraggingProvider(provider);
      };
      const finish = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        if (!active) return;
        // 上游 topAccountPillClickSuppressed：真实拖拽后吞掉紧随的 click。
        suppressNextClickRef.current = true;
        setDraggingProvider(null);
        const target = providerKeyFromPoint(upEvent.clientX, upEvent.clientY);
        flip.capture(collectRows());
        if (target && target !== provider) {
          void orderController.moveProviderBefore(provider, target);
        }
      };
      const cancel = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        if (active) setDraggingProvider(null);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [collectRows, flip, orderController],
  );

  const handleProviderRowKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLDivElement>,
      provider: LoginProviderId,
      index: number,
    ) => {
      if (!event.altKey) return;
      if (event.key === "ArrowUp") {
        const target = orderedProviders[index - 1];
        if (!target) return;
        event.preventDefault();
        flip.capture(collectRows());
        void orderController.moveProviderBefore(provider, target);
      } else if (event.key === "ArrowDown") {
        const target = orderedProviders[index + 1];
        if (!target) return;
        event.preventDefault();
        flip.capture(collectRows());
        void orderController.moveProviderBefore(target, provider);
      }
    },
    [collectRows, flip, orderedProviders, orderController],
  );

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
          <div
            className="account-dropdown-list"
            ref={listRef}
            onClickCapture={(event) => {
              if (!suppressNextClickRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              suppressNextClickRef.current = false;
            }}
          >
            {logged.map(({ provider, status }, index) => {
              const displayName = status.nickname ?? status.userId ?? "已登录";
              const vipBadge = accountVipBadge(status);
              const isDragging = draggingProvider === provider;
              return (
                <div
                  key={provider}
                  id={`account-dropdown-provider-${provider}`}
                  className={`account-dropdown-row account-pill ${provider}`}
                  data-flip-key={provider}
                  tabIndex={0}
                  aria-label={`${providerLabel(provider)}账号，可拖拽或使用 Alt+方向键调整顺序`}
                  style={{
                    cursor: isDragging ? "grabbing" : "grab",
                    userSelect: "none",
                    ...(isDragging ? { opacity: 0.55 } : {}),
                  }}
                  onPointerDown={(event) =>
                    beginProviderRowDrag(event, provider)
                  }
                  onKeyDown={(event) =>
                    handleProviderRowKeyDown(event, provider, index)
                  }
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
  providerOrderStore,
}: AccountOverlaySurfaceProps): ReactElement | null {
  const orderController = useProviderOrderController({
    store: providerOrderStore,
  });
  if (!modalOpen) return null;
  const orderedProviders = orderController.orderedProviders();
  const { logged, missing } = providerCollections(statuses, orderedProviders);
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
            {orderedProviders.map((id) => (
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
            搜索或导入一首歌即可播放；登录后会同步歌单、红心和播客，登录态会保存在本机 sidecar 数据目录。
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
                  手动导入只会写入本机 sidecar 会话。
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
