import { useEffect, useState } from "react";
import type { FxState } from "@mineradio/visual-engine";
import type { ShelfMode } from "../../stores/shelf-store";
import {
  AI_DEPTH_STATUS_EVENT,
  type AiDepthStatusDetail,
} from "../../visual/ai-depth-estimator";
import { applyVisualThemeToRoot } from "../../visual/visual-theme";
import { attachRecommendationRowWheelScroll } from "../../features/recommendation/recommendation-wheel-scroll";

export interface AiDepthChipState {
  visible: boolean;
  text: string;
}

export function isHomeBlankDismissElement(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const home = target.closest("#empty-home");
  if (!home) return false;
  return !target.closest(
    [
      ".home-card",
      ".home-tile",
      ".home-chip",
      // 推荐卡片：有自己的点击交互（或即将有），不能被当成空白区 dismiss
      ".home-recommendation-card-track",
      ".home-recommendation-card-netease-mixed",
      ".home-recommendation-media",
      // 歌单详情页曲目行（div[role=button]，详情页期间 emptyHomeActive 仍为 true）
      ".home-detail-track",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      '[contenteditable="true"]',
      "#desktop-titlebar",
      "#search-area",
      "#top-right",
      "#bottom-bar",
      "#bottom-handle",
      "#fx-fab",
      "#fx-fab-hide-btn",
      "#fx-panel",
      "#playlist-panel",
      "#mini-queue-popover",
      "#visual-guide",
      "#upload-tip",
      "#toast",
      "#trial-banner",
      "#source-fallback-notice",
      "#ai-depth-chip",
      "#beat-chip",
      "#drop-overlay",
      ".modal-mask",
      ".modal",
      "#login-modal",
      ".track-detail-modal",
      ".cover-color-pop",
      ".color-lab-pop",
      ".quality-popover",
      ".volume-popover",
    ].join(","),
  );
}

export interface GlobalShellRuntimeOptions {
  diyMode: boolean;
  splashActive: boolean;
  emptyHomeActive: boolean;
  consoleVisible: boolean;
  homeControlsLocked: boolean;
  userCapsuleAutoHide: boolean;
  visualGuideOpen: boolean;
  searchDetailOpen: boolean;
  shelfMode: ShelfMode;
  visualFx: FxState;
  toast: string | null;
  miniQueueOpen: boolean;
  accountDropdownOpen: boolean;
  accountLoggedIn: boolean;
  clearToast(): void;
  setMiniQueue(open: boolean): void;
  setAccountDropdownOpen(open: boolean): void;
  dismissEmptyHome(): void;
  showToast(message: string): void;
  /** 左侧歌单面板 open 状态 setter：peek 通过它驱动 React 状态（可选） */
  setPlaylistPanelOpen?(open: boolean): void;
}

export interface GlobalShellRuntimeResult {
  userCapsulePeek: boolean;
  aiDepthChip: AiDepthChipState;
}

export function useGlobalShellRuntime({
  diyMode,
  splashActive,
  emptyHomeActive,
  consoleVisible,
  homeControlsLocked,
  userCapsuleAutoHide,
  visualGuideOpen,
  searchDetailOpen,
  shelfMode,
  visualFx,
  toast,
  miniQueueOpen,
  accountDropdownOpen,
  accountLoggedIn,
  clearToast,
  setMiniQueue,
  setAccountDropdownOpen,
  dismissEmptyHome,
  showToast,
  setPlaylistPanelOpen,
}: GlobalShellRuntimeOptions): GlobalShellRuntimeResult {
  const [userCapsulePeek, setUserCapsulePeek] = useState(false);
  const [aiDepthChip, setAiDepthChip] = useState<AiDepthChipState>({
    visible: false,
    text: "AI 深度估计…",
  });

  // 推荐模块行：滚轮横滑替代横向滚动条（空白区域不受影响）
  useEffect(
    () => attachRecommendationRowWheelScroll(document),
    [],
  );

  // 左侧歌单面板：一个"常开=强制"变量 + 普通规则。
  // - 常开（pinned）：强制展开，鼠标移动完全忽略
  // - 取消常开：强制解除，普通规则接管——光标仍在面板列内则原地保持，
  //   移出该列即收起
  // - 普通规则：贴左缘（视口宽 5%）弹出；面板同宽的左列为保持区，
  //   越过右缘收回。peek 只通过 setPlaylistPanelOpen 驱动 React 状态，
  //   不手工改 DOM 类，避免与渲染互相覆盖。
  useEffect(() => {
    if (!setPlaylistPanelOpen || typeof window === "undefined") return;
    let frame = 0;
    let peekOwned = false; // 当前展开是否由 peek 打开/接手
    let prevPinned = false;
    const evaluate = (event: MouseEvent) => {
      const panel = document.getElementById("playlist-panel");
      if (!panel) return;
      const pinned = panel.classList.contains("pinned");
      const shown = panel.classList.contains("show");
      const justUnpinned = prevPinned && !pinned;
      prevPinned = pinned;
      if (pinned) return; // 强制展开：忽略一切鼠标变化

      // 从常开切回非常开的瞬间：接手遗留的展开状态，交还普通规则
      if (justUnpinned && shown) peekOwned = true;

      const triggerX = document.documentElement.clientWidth * 0.05;
      const rect = panel.getBoundingClientRect();
      const inColumn = event.clientX <= Math.max(triggerX, rect.right);

      if (inColumn) {
        if (!shown) {
          peekOwned = true;
          setPlaylistPanelOpen(true);
        }
        return;
      }
      // 列外只收走自己打开/接手的展开，不碰外部路径打开的面板
      if (shown && peekOwned) {
        peekOwned = false;
        setPlaylistPanelOpen(false);
      }
    };
    const onMouseMove = (event: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => evaluate(event));
    };
    const onMouseLeaveWindow = () => {
      cancelAnimationFrame(frame);
      const panel = document.getElementById("playlist-panel");
      if (peekOwned && panel && !panel.classList.contains("pinned")) {
        peekOwned = false;
        setPlaylistPanelOpen(false);
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseleave", onMouseLeaveWindow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeaveWindow);
    };
  }, [setPlaylistPanelOpen]);

  useEffect(() => {
    if (accountLoggedIn) return;
    setAccountDropdownOpen(false);
  }, [accountLoggedIn, setAccountDropdownOpen]);

  useEffect(() => {
    if (!accountDropdownOpen || typeof document === "undefined") return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const dropdown = document.getElementById("account-dropdown");
      const topRight = document.getElementById("top-right");
      if (dropdown?.contains(target) || topRight?.contains(target)) return;
      setAccountDropdownOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
    };
  }, [accountDropdownOpen, setAccountDropdownOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleAiDepthStatus = (event: Event) => {
      const detail = (event as CustomEvent<AiDepthStatusDetail>).detail;
      if (!detail) return;
      if (detail.toast) showToast(detail.toast);
      setAiDepthChip((current) => ({
        visible: detail.visible,
        text: detail.text || current.text || "AI 深度估计…",
      }));
    };
    window.addEventListener(AI_DEPTH_STATUS_EVENT, handleAiDepthStatus);
    return () => {
      window.removeEventListener(AI_DEPTH_STATUS_EVENT, handleAiDepthStatus);
    };
  }, [showToast]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    applyVisualThemeToRoot(document.documentElement, visualFx);
  }, [visualFx]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("diy-mode-preload", diyMode);
    document.documentElement.classList.toggle("simple-mode-preload", !diyMode);
    document.body.classList.toggle("diy-mode", diyMode);
    document.body.classList.toggle("simple-mode", !diyMode);
    return () => {
      document.documentElement.classList.remove(
        "diy-mode-preload",
        "simple-mode-preload",
      );
      document.body.classList.remove("diy-mode", "simple-mode");
    };
  }, [diyMode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("splash-active", splashActive);
    document.body.classList.toggle("empty-home-active", emptyHomeActive);
    document.body.classList.toggle("controls-visible", consoleVisible);
    document.body.classList.toggle("home-wallpaper-preview", emptyHomeActive);
    document.body.classList.toggle("home-controls-locked", homeControlsLocked);
    document.body.classList.toggle(
      "user-capsule-auto-hide",
      userCapsuleAutoHide,
    );
    document.body.classList.toggle(
      "user-capsule-peek",
      userCapsuleAutoHide && userCapsulePeek,
    );
    document.body.classList.toggle("visual-guide-active", visualGuideOpen);
    document.body.classList.toggle("search-detail-open", searchDetailOpen);
    return () => {
      document.body.classList.remove(
        "splash-active",
        "empty-home-active",
        "controls-visible",
        "home-wallpaper-preview",
        "home-controls-locked",
        "user-capsule-auto-hide",
        "user-capsule-peek",
        "visual-guide-active",
        "search-detail-open",
      );
    };
  }, [
    consoleVisible,
    emptyHomeActive,
    homeControlsLocked,
    searchDetailOpen,
    splashActive,
    userCapsuleAutoHide,
    userCapsulePeek,
    visualGuideOpen,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!userCapsuleAutoHide) {
      setUserCapsulePeek(false);
      return;
    }
    const updateFromPointer = (event: MouseEvent) => {
      setUserCapsulePeek(
        event.clientX > window.innerWidth - 112 && event.clientY < 126,
      );
    };
    const clearPeek = () => setUserCapsulePeek(false);
    window.addEventListener("mousemove", updateFromPointer);
    window.addEventListener("mouseleave", clearPeek);
    return () => {
      window.removeEventListener("mousemove", updateFromPointer);
      window.removeEventListener("mouseleave", clearPeek);
    };
  }, [userCapsuleAutoHide]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const stageMode = shelfMode === "stage";
    const searchArea = document.getElementById("search-area");
    const bottomBar = document.getElementById("bottom-bar");
    searchArea?.classList.toggle("stage-mode", stageMode);
    bottomBar?.classList.toggle("stage-mode", stageMode);
    return () => {
      searchArea?.classList.remove("stage-mode");
      bottomBar?.classList.remove("stage-mode");
    };
  }, [shelfMode]);

  useEffect(() => {
    if (!emptyHomeActive || typeof document === "undefined") return;
    const onBlankClick = (event: MouseEvent) => {
      if (!isHomeBlankDismissElement(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      dismissEmptyHome();
    };
    document.addEventListener("click", onBlankClick, true);
    return () => document.removeEventListener("click", onBlankClick, true);
  }, [dismissEmptyHome, emptyHomeActive]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => clearToast(), 2600);
    return () => window.clearTimeout(timer);
  }, [clearToast, toast]);

  useEffect(() => {
    if (!miniQueueOpen || typeof document === "undefined") return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("#bottom-bar")) return;
      setMiniQueue(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [miniQueueOpen, setMiniQueue]);

  return { userCapsulePeek, aiDepthChip };
}
