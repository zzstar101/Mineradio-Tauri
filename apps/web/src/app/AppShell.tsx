import type {
  ComponentProps,
  ReactElement,
  RefObject,
} from "react";
import { SidecarRecoveryRuntime } from "./runtime/SidecarRecoveryRuntime";
import { UpdateHost } from "../components/shell/UpdateHost";
import { VisualGuideHost } from "../components/shell/VisualGuideHost";
import type { SplashHostProps } from "../visual/SplashHost";
import {
  AccountOverlaySurface,
  AccountSurface,
  type AccountOverlaySurfaceProps,
  type AccountSurfaceProps,
} from "../features/accounts/AccountSurface";
import {
  HomeSurface,
  type HomeSurfaceProps,
} from "../features/home/HomeSurface";
import {
  LibraryOverlaySurface,
  LibrarySurface,
  type LibrarySurfaceProps,
} from "../features/library/LibrarySurface";
import {
  PlaybackCustomizationOverlay,
  PlaybackNoticeOverlay,
  PlaybackRuntimeSurface,
  PlaybackSurface,
  type PlaybackCustomizationOverlayProps,
  type PlaybackNoticeOverlayProps,
  type PlaybackRuntimeSurfaceProps,
  type PlaybackSurfaceProps,
} from "../features/playback/PlaybackSurface";
import {
  VisualSurface,
  type VisualSurfaceProps,
} from "../features/visual/VisualSurface";

export interface DesktopTitlebarProps {
  maximized?: boolean;
  onGuide(): void;
  onDiy(): void;
  diyActive: boolean;
  onMinimize(): void;
  onToggleMaximize(): void;
  onClose(): void;
  updateProps: ComponentProps<typeof UpdateHost>;
}

function DesktopTitlebar({
  maximized,
  onGuide,
  onDiy,
  diyActive,
  onMinimize,
  onToggleMaximize,
  onClose,
  updateProps,
}: DesktopTitlebarProps): ReactElement {
  return (
    <div
      id="desktop-titlebar"
      aria-label="window controls"
      data-tauri-drag-region="true"
    >
      <div className="desktop-drag-region" data-tauri-drag-region="true">
        <div className="desktop-app-mark" aria-hidden="true" />
        <div className="desktop-app-title" aria-hidden="true" />
      </div>
      <div className="desktop-window-controls">
        <button
          id="visual-guide-btn"
          className="icon-btn"
          type="button"
          onClick={onGuide}
          title="查看使用引导"
          aria-label="查看使用引导"
        >
          ?
        </button>
        <UpdateHost {...updateProps} />
        <button
          id="diy-mode-btn"
          className={`desktop-mode-btn${diyActive ? " on" : ""}`}
          type="button"
          onClick={onDiy}
          title={diyActive ? "关闭 DIY 玩家模式" : "开启 DIY 玩家模式"}
          aria-label={diyActive ? "关闭 DIY 玩家模式" : "开启 DIY 玩家模式"}
          aria-pressed={diyActive}
        >
          DIY
        </button>
        <button
          className="desktop-window-btn"
          type="button"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h10" />
          </svg>
        </button>
        <button
          className="desktop-window-btn"
          type="button"
          onClick={onToggleMaximize}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3h8v8" />
              <path d="M3 5h8v8H3z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
            </svg>
          )}
        </button>
        <button
          className="desktop-window-btn close"
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export interface AppShellProps {
  sidecarRuntimeProps: ComponentProps<typeof SidecarRecoveryRuntime>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  localAudioAccept: string;
  onImportLocalFiles(files: FileList | null): void;
  titlebar: DesktopTitlebarProps;
  SplashComponent: (props: SplashHostProps) => ReactElement | null;
  splashVisible: boolean;
  onSplashDismissed(): void;
  visual: VisualSurfaceProps;
  home: HomeSurfaceProps;
  account: AccountSurfaceProps;
  guide: ComponentProps<typeof VisualGuideHost>;
  library: LibrarySurfaceProps;
  playback: PlaybackSurfaceProps;
  playbackCustomization: PlaybackCustomizationOverlayProps;
  libraryOverlay: Pick<LibrarySurfaceProps, "collect">;
  accountOverlay: AccountOverlaySurfaceProps;
  playbackNotices: PlaybackNoticeOverlayProps;
  playbackRuntime: PlaybackRuntimeSurfaceProps;
}

export function AppShell({
  sidecarRuntimeProps,
  fileInputRef,
  localAudioAccept,
  onImportLocalFiles,
  titlebar,
  SplashComponent,
  splashVisible,
  onSplashDismissed,
  visual,
  home,
  account,
  guide,
  library,
  playback,
  playbackCustomization,
  libraryOverlay,
  accountOverlay,
  playbackNotices,
  playbackRuntime,
}: AppShellProps): ReactElement {
  return (
    <>
      <SidecarRecoveryRuntime {...sidecarRuntimeProps} />
      <div id="desktop-window-shell">
        <input
          ref={fileInputRef}
          type="file"
          id="file-input"
          accept={localAudioAccept}
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            onImportLocalFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <DesktopTitlebar {...titlebar} />
        {splashVisible ? (
          <SplashComponent onDismissed={onSplashDismissed} />
        ) : null}
        <VisualSurface {...visual} />
        <HomeSurface {...home} />
        <AccountSurface {...account} />
        <VisualGuideHost {...guide} />
        <LibrarySurface {...library} />
        <PlaybackSurface {...playback} />
        <PlaybackCustomizationOverlay {...playbackCustomization} />
        <LibraryOverlaySurface {...libraryOverlay} />
        {/*
          账号登录弹窗按需挂载（M10 perf：关闭时不保留 useSyncExternalStore 订阅与副作用）。
          安全性：provider 顺序存放在模块级 sharedProviderOrderStore 单例中，
          常驻的 AccountSurface 使用同一单例并持续驱动 hydrate/commit 广播；
          弹窗重新挂载时 useSyncExternalStore 会立即读到最新快照。
        */}
        {accountOverlay.modalOpen ? (
          <AccountOverlaySurface {...accountOverlay} />
        ) : null}
        <PlaybackNoticeOverlay {...playbackNotices} />
      </div>
      <PlaybackRuntimeSurface {...playbackRuntime} />
    </>
  );
}
