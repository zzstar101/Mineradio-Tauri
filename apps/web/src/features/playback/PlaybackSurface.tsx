import type { ComponentProps, ReactElement } from "react";
import type { Track } from "@mineradio/shared";
import { BottomControlsHost } from "../../components/shell/BottomControlsHost";
import { PlaybackRuntimeHost } from "./PlaybackRuntimeHost";
import { PlaybackAudioSettings } from "./PlaybackAudioSettings";
import type { PlaybackAudioSettingsResult } from "./usePlaybackAudioSettings";
import type { PlaybackSessionRuntimeResult } from "./usePlaybackSessionRuntime";
import type { TrackCustomizationControllerResult } from "../customization/useTrackCustomizationController";

type CustomizationView = Pick<
  TrackCustomizationControllerResult,
  | "customLyricModalOpen"
  | "setCustomLyricModalOpen"
  | "customLyricText"
  | "setCustomLyricText"
  | "customLyricStatus"
  | "customLyricInputRef"
  | "currentCustomLyricText"
  | "saveCustomLyric"
  | "deleteCustomLyric"
>;

type TrialView = Pick<
  PlaybackSessionRuntimeResult,
  "trialBanner" | "dismissTrialBanner"
>;

export interface PlaybackSurfaceProps {
  controlsProps: ComponentProps<typeof BottomControlsHost>;
  audioSettings?: PlaybackAudioSettingsResult;
}

export interface PlaybackCustomizationOverlayProps {
  customization: CustomizationView;
  currentTrack: Track | null;
}

export interface PlaybackNoticeOverlayProps extends TrialView {
  toast: string | null;
  onOpenLogin(): void;
}

export interface PlaybackRuntimeSurfaceProps {
  runtimeProps: ComponentProps<typeof PlaybackRuntimeHost>;
}

export type PlaybackControllerRef = ComponentProps<
  typeof PlaybackRuntimeHost
>["controllerRef"];

export function PlaybackSurface({
  controlsProps,
  audioSettings,
}: PlaybackSurfaceProps): ReactElement {
  const renderVolumePanelExtras = audioSettings
    ? (active: boolean) => (
        <PlaybackAudioSettings settings={audioSettings} active={active} />
      )
    : controlsProps.renderVolumePanelExtras;
  return (
    <BottomControlsHost
      {...controlsProps}
      renderVolumePanelExtras={renderVolumePanelExtras}
    />
  );
}

export function PlaybackCustomizationOverlay({
  customization,
  currentTrack,
}: PlaybackCustomizationOverlayProps): ReactElement | null {
  const {
    customLyricModalOpen,
    setCustomLyricModalOpen,
    customLyricText,
    setCustomLyricText,
    customLyricStatus,
    customLyricInputRef,
    currentCustomLyricText,
    saveCustomLyric,
    deleteCustomLyric,
  } = customization;
  if (!customLyricModalOpen) return null;

  return (
    <div
      id="custom-lyric-modal"
      className="modal-mask show"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setCustomLyricModalOpen(false);
        }
      }}
    >
      <div
        className="modal custom-lyric-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-lyric-heading"
      >
        <h2 id="custom-lyric-heading">自定义歌词</h2>
        <div className="custom-lyric-track">
          <div id="custom-lyric-title" className="custom-lyric-title">
            {currentTrack?.title ?? "当前歌曲"}
          </div>
          <div id="custom-lyric-sub" className="custom-lyric-sub">
            {(currentTrack?.artists.join(" / ") || "") +
              (currentCustomLyricText
                ? " · 已保存自定义歌词"
                : " · 可粘贴 LRC 或逐行输入")}
          </div>
        </div>
        <textarea
          ref={customLyricInputRef}
          id="custom-lyric-input"
          className="custom-lyric-input"
          spellCheck={false}
          defaultValue={customLyricText}
          placeholder={
            "[00:12.00] 第一行歌词\n[00:16.50] 第二行歌词\n\n没有时间轴也可以，每一行会按歌曲时长自动铺开"
          }
          onChange={(event) => setCustomLyricText(event.currentTarget.value)}
        />
        <div
          id="custom-lyric-status"
          className={`custom-lyric-status ${customLyricStatus.tone ?? ""}`.trim()}
        >
          {customLyricStatus.text}
        </div>
        <div className="btn-row">
          <button className="modal-btn" type="button" onClick={deleteCustomLyric}>
            删除
          </button>
          <button
            className="modal-btn"
            type="button"
            onClick={() => setCustomLyricModalOpen(false)}
          >
            关闭
          </button>
          <button
            id="custom-lyric-save"
            className="modal-btn primary"
            type="button"
            onClick={saveCustomLyric}
          >
            保存使用
          </button>
        </div>
      </div>
    </div>
  );
}

export function PlaybackNoticeOverlay({
  trialBanner,
  dismissTrialBanner,
  toast,
  onOpenLogin,
}: PlaybackNoticeOverlayProps): ReactElement {
  return (
    <>
      <div
        id="trial-banner"
        className={trialBanner ? "show" : ""}
        data-provider={trialBanner?.provider ?? ""}
      >
        <svg
          className="ic"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span id="trial-text">{trialBanner?.text ?? "仅播放试听片段"}</span>
        <button
          id="trial-login-btn"
          className="login-link"
          type="button"
          style={{ display: trialBanner?.showLogin ? "" : "none" }}
          onClick={onOpenLogin}
        >
          扫码登录
        </button>
        <button
          className="close"
          type="button"
          aria-label="关闭试听提醒"
          onClick={dismissTrialBanner}
        >
          ×
        </button>
      </div>
      <div
        id="toast"
        className={toast ? "show" : ""}
        role="status"
        aria-live="polite"
      >
        {toast ?? ""}
      </div>
    </>
  );
}

export function PlaybackRuntimeSurface({
  runtimeProps,
}: PlaybackRuntimeSurfaceProps): ReactElement {
  return <PlaybackRuntimeHost {...runtimeProps} />;
}
