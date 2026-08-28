import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { clampPreset, FX_DEFAULTS, type FxState, type FxStatePatch } from "@mineradio/visual-engine";
import { SettingsWorkbench } from "../features/settings/SettingsWorkbench";
import {
  buildLowSpecChanges,
  settingGroupMatches,
  type SettingsTabId,
} from "../features/settings/settings-catalog";
import {
  SettingsTransactionController,
  type SettingsValueChange,
} from "../features/settings/settings-transaction-controller";
import {
  SONIC_TOPOGRAPHY_SETTINGS_SEARCH_TERMS,
  SonicTopographyControls,
} from "./controls/SonicTopographyControls";
import {
  SONIC_WORKSHOP_SETTINGS_SEARCH_TERMS,
  SonicWorkshopControls,
} from "./controls/SonicWorkshopControls";
import {
  STAGE_LYRICS_SETTINGS_SEARCH_TERMS,
  StageLyricsControls,
} from "./controls/StageLyricsControls";
import {
  customLyricFontKey,
  readCustomLyricFonts,
  registerCustomLyricFont,
  removeCustomLyricFont,
  saveCustomLyricFont,
  type CustomLyricFontRecord,
} from "../desktop-lyrics/custom-lyric-font";

const FX_FAB_AUTO_HIDE_STORE_KEY = "mineradio-fx-fab-auto-hide-v1";
const RESET_EXCLUDED_SETTING_PATHS = new Set<keyof FxState>([
  "mouseActive",
  "mouseXy",
  "burstAmt",
  "vinylSpin",
  "particleDim",
  "backgroundImage",
  "backgroundMedia",
]);

const PRESETS = [
  { id: 0, name: "Emily", desc: "封面粒子 · 歌词舞台" },
  { id: 1, name: "隧穿", desc: "Tunnel drift" },
  { id: 2, name: "轨道", desc: "Orbit lines" },
  { id: 3, name: "虚空", desc: "Void field" },
  { id: 4, name: "黑胶", desc: "Vinyl pulse" },
  { id: 5, name: "星河", desc: "静默流光" },
  { id: 6, name: "安魂", desc: "骷髅 · YUI7W" },
  { id: 7, name: "声景", desc: "Sonic Topography" },
  { id: 8, name: "音域回响 Wallpaper Engine", desc: "CmzYa" },
] as const;

type NumberKey = Extract<keyof FxState, string>;
type BooleanKey = Extract<keyof FxState, string>;

interface SliderDef {
  key: NumberKey;
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

interface ToggleDef {
  key: BooleanKey;
  id: string;
  label: string;
  disabled?: boolean;
  badge?: string;
  title?: string;
}

interface SegmentOption {
  value: string | number;
  label: string;
}

const MAIN_SLIDERS: SliderDef[] = [
  {
    key: "backgroundOpacity",
    id: "fx-bgopacity",
    label: "背景透明度",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "controlGlassChromaticOffset",
    id: "fx-glassaberration",
    label: "控制台玻璃色差",
    min: 0,
    max: 140,
    step: 1,
  },
  {
    key: "intensity",
    id: "fx-intensity",
    label: "律动强度",
    min: 0.2,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "depth",
    id: "fx-depth",
    label: "立体感",
    min: 0.2,
    max: 1.8,
    step: 0.01,
  },
  {
    key: "coverResolution",
    id: "fx-coverres",
    label: "封面清晰度",
    min: 0.75,
    max: 1.55,
    step: 0.01,
  },
  {
    key: "cinemaShake",
    id: "fx-cineshake",
    label: "镜头晃动",
    min: 0,
    max: 1.8,
    step: 0.01,
  },
  {
    key: "lyricGlowStrength",
    id: "fx-lyricglow",
    label: "歌词溢光",
    min: 0,
    max: 0.85,
    step: 0.01,
  },
];

const LYRIC_LAYOUT_SLIDERS: SliderDef[] = [
  {
    key: "lyricLetterSpacing",
    id: "fx-lyricspacing",
    label: "字间距",
    min: -0.04,
    max: 0.18,
    step: 0.005,
  },
  {
    key: "lyricLineHeight",
    id: "fx-lyriclineheight",
    label: "行距",
    min: 0.86,
    max: 1.35,
    step: 0.01,
  },
  {
    key: "lyricWeight",
    id: "fx-lyricweight",
    label: "字重",
    min: 500,
    max: 900,
    step: 50,
  },
  {
    key: "lyricScale",
    id: "fx-lyricscale",
    label: "歌词大小",
    min: 0.35,
    max: 1.65,
    step: 0.01,
  },
  {
    key: "lyricOffsetX",
    id: "fx-lyricx",
    label: "水平位置",
    min: -2,
    max: 2,
    step: 0.01,
  },
  {
    key: "lyricOffsetY",
    id: "fx-lyricy",
    label: "垂直位置",
    min: -1.2,
    max: 1.35,
    step: 0.01,
  },
  {
    key: "lyricOffsetZ",
    id: "fx-lyricz",
    label: "景深位置",
    min: -1.6,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "lyricTiltX",
    id: "fx-lyrictiltx",
    label: "上下角度",
    min: -42,
    max: 42,
    step: 1,
  },
  {
    key: "lyricTiltY",
    id: "fx-lyrictilty",
    label: "左右角度",
    min: -42,
    max: 42,
    step: 1,
  },
];

const DESKTOP_SLIDERS: SliderDef[] = [
  {
    key: "desktopLyricsSize",
    id: "fx-desktoplyricssize",
    label: "桌面歌词大小",
    min: 0.72,
    max: 1.55,
    step: 0.01,
  },
  {
    key: "desktopLyricsOpacity",
    id: "fx-desktoplyricsopacity",
    label: "桌面歌词透明",
    min: 0.28,
    max: 1,
    step: 0.01,
  },
  {
    key: "desktopLyricsY",
    id: "fx-desktoplyricsy",
    label: "桌面歌词高度",
    min: 0.08,
    max: 0.92,
    step: 0.01,
  },
];

const ADVANCED_SLIDERS: SliderDef[] = [
  {
    key: "point",
    id: "fx-point",
    label: "粒子尺寸",
    min: 0.5,
    max: 2.2,
    step: 0.01,
  },
  {
    key: "speed",
    id: "fx-speed",
    label: "流速",
    min: 0.2,
    max: 2.5,
    step: 0.01,
  },
  { key: "twist", id: "fx-twist", label: "扭曲", min: 0, max: 0.6, step: 0.01 },
  {
    key: "color",
    id: "fx-color",
    label: "色彩张力",
    min: 0.5,
    max: 2,
    step: 0.01,
  },
  {
    key: "bloomStrength",
    id: "fx-bloom",
    label: "溢光强度",
    min: 0,
    max: 1.6,
    step: 0.01,
  },
  {
    key: "scatter",
    id: "fx-scatter",
    label: "离散感",
    min: 0,
    max: 0.5,
    step: 0.01,
  },
  {
    key: "bgFade",
    id: "fx-bgfade",
    label: "背景压缩",
    min: 0,
    max: 1.2,
    step: 0.01,
  },
];

const OVERLAY_TOGGLES: ToggleDef[] = [
  { key: "cinema", id: "t-cinema", label: "电影镜头" },
  { key: "lyricGlow", id: "t-lyricGlow", label: "歌词溢光" },
  { key: "lyricGlowBeat", id: "t-lyricGlowBeat", label: "鼓点溢光" },
  { key: "lyricGlowParticles", id: "t-lyricGlowParticles", label: "歌词光粒" },
  { key: "lyricCameraLock", id: "t-lyricCameraLock", label: "歌词镜头绑定" },
  { key: "bloom", id: "t-bloom", label: "粒子溢光" },
  { key: "edge", id: "t-edge", label: "轮廓高亮" },
  {
    key: "aiDepth",
    id: "t-aidepth",
    label: "AI 立体增强",
    title: "首次会下载深度模型",
  },
  { key: "desktopLyrics", id: "t-desktopLyrics", label: "桌面歌词" },
  {
    key: "desktopLyricsClickThrough",
    id: "t-desktopLyricsClickThrough",
    label: "桌面歌词锁定",
  },
  {
    key: "desktopLyricsCinema",
    id: "t-desktopLyricsCinema",
    label: "桌面歌词电影震动",
  },
  {
    key: "desktopLyricsHighlight",
    id: "t-desktopLyricsHighlight",
    label: "桌面歌词高亮跟随",
  },
];

const SHELF_CONTENT_TOGGLES: ToggleDef[] = [
  {
    key: "shelfShowPodcasts",
    id: "t-shelfShowPodcasts",
    label: "显示播客歌单",
    title: "关闭后 3D 歌单架不显示播客收藏",
  },
  {
    key: "shelfMergeCollections",
    id: "t-shelfMergeCollections",
    label: "合并收藏歌单",
    title: "开启后我的歌单与收藏歌单按一条线连续滚动",
  },
];

const LYRIC_FONTS = [
  ["sans", "默认"],
  ["hei", "黑体"],
  ["song", "宋体"],
  ["bold-song", "粗宋"],
  ["stone-song", "石印宋"],
  ["kai-song", "楷宋"],
  ["serif-en", "Serif"],
  ["gothic", "Gothic"],
  ["editorial", "Editorial"],
  ["humanist", "Humanist"],
  ["mono", "等宽"],
  ["display", "标题"],
] as const;

/** 搜索词直接从控件 definition 派生，调整控件文案时索引同步更新。 */
export const VISUAL_SETTINGS_SEARCH_INDEX = Object.freeze({
  commonPresets: [
    "常用",
    "视觉预设",
    ...PRESETS.flatMap((preset) => [preset.name, preset.desc]),
  ],
  interface: [
    "界面",
    "颜色",
    "界面高亮",
    "视觉主色",
    "Home 填充",
    ...MAIN_SLIDERS.slice(0, 2).map((control) => control.label),
  ],
  commonMain: [
    "常用",
    "主控",
    ...MAIN_SLIDERS.slice(2).map((control) => control.label),
  ],
  lyrics: [
    "歌词",
    "歌词主色",
    "歌词高亮",
    "溢光色",
    "歌词字体",
    ...LYRIC_FONTS.map(([, label]) => label),
    ...LYRIC_LAYOUT_SLIDERS.map((control) => control.label),
  ],
  motion: [
    "动效",
    "叠加效果",
    "桌面帧数",
    ...OVERLAY_TOGGLES.map((control) => control.label),
    ...DESKTOP_SLIDERS.map((control) => control.label),
  ],
  nativeDesktop: [
    "系统",
    "桌面",
    "缓存",
    "诊断",
    "Wallpaper",
    "完整桌面",
  ],
  shelf: [
    "歌单架",
    "3D",
    "动态镜头",
    "静态镜头",
    "自动隐藏",
    "常驻",
    ...SHELF_CONTENT_TOGGLES.map((control) => control.label),
  ],
  visualEngines: [
    "动效",
    "声景",
    "频谱",
    ...STAGE_LYRICS_SETTINGS_SEARCH_TERMS,
    ...SONIC_TOPOGRAPHY_SETTINGS_SEARCH_TERMS,
    ...SONIC_WORKSHOP_SETTINGS_SEARCH_TERMS,
  ],
  systemAdvanced: [
    "系统",
    "性能",
    "低配",
    "后台",
    "画质",
    "高级参数",
    "自动优化",
    "保持运行",
    "停止释放",
    ...ADVANCED_SLIDERS.map((control) => control.label),
  ],
});

export function buildNativeDesktopSettingsSearchTerms(
  terms: readonly string[] = [],
): readonly string[] {
  if (!terms.length) return VISUAL_SETTINGS_SEARCH_INDEX.nativeDesktop;
  return [...VISUAL_SETTINGS_SEARCH_INDEX.nativeDesktop, ...terms];
}

export interface VisualControlPanelHostProps {
  preset?: number;
  intensity?: number;
  settings?: FxStatePatch;
  onPresetChange?: (preset: number) => void;
  onNumberSettingChange?: (key: keyof FxState, value: number) => void;
  onBooleanSettingChange?: (key: keyof FxState, value: boolean) => void;
  onStringSettingChange?: (key: keyof FxState, value: string) => void;
  onFxPatchChange?: (patch: FxStatePatch) => void;
  onSettingsTransaction?: (patch: FxStatePatch) => Promise<void> | void;
  initialFabAutoHide?: boolean;
  onFabAutoHideChange?: (value: boolean) => Promise<void> | void;
  onNotice?: (message: string) => void;
  desktopRuntimeSlot?: ReactElement | null;
  desktopRuntimeSearchTerms?: readonly string[];
  /** Wave 3: advanced audio / output routing surface（不占用 upstream bottom bar）。 */
  audioSettingsSlot?: ReactElement | null;
}

function readFxFabAutoHidePreference(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(FX_FAB_AUTO_HIDE_STORE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFxFabAutoHidePreference(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FX_FAB_AUTO_HIDE_STORE_KEY, value ? "1" : "0");
  } catch {
  }
}

function numberValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): number {
  if (key === "intensity" && typeof props.intensity === "number")
    return props.intensity;
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return typeof value === "number" ? value : 0;
}

function booleanValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): boolean {
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return value === true;
}

function stringValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): string {
  const value = props.settings?.[key] ?? FX_DEFAULTS[key];
  return typeof value === "string" ? value : "";
}

function hexSettingValue(
  props: VisualControlPanelHostProps,
  key: keyof FxState,
): string {
  const raw = props.settings?.[key] ?? FX_DEFAULTS[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  const normalized = value.startsWith("#") ? value : `#${value}`;
  const fallback = String(FX_DEFAULTS[key] ?? "#000000");
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

function readSettingPath(
  props: VisualControlPanelHostProps,
  path: string,
): unknown {
  const [root, ...segments] = path.split(".");
  if (!root) return undefined;
  let value: unknown =
    props.settings?.[root as keyof FxState] ?? FX_DEFAULTS[root as keyof FxState];
  for (const segment of segments) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function settingChangesFromPatch(
  props: VisualControlPanelHostProps,
  patch: FxStatePatch,
): Record<string, SettingsValueChange> {
  const changes: Record<string, SettingsValueChange> = {};
  const visit = (path: string, value: unknown): void => {
    const root = path.split(".")[0];
    if (
      (root === "stageLyrics" || root === "sonic" || root === "workshop") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(`${path}.${key}`, nested);
      }
      return;
    }
    changes[path] = { before: readSettingPath(props, path), after: value };
  };
  for (const [path, value] of Object.entries(patch)) visit(path, value);
  return changes;
}

function patchFromSettingValues(values: Record<string, unknown>): FxStatePatch {
  const patch: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    const [root, ...segments] = path.split(".");
    if (!root) continue;
    if (!segments.length) {
      patch[root] = value;
      continue;
    }
    let target = (patch[root] ??= {}) as Record<string, unknown>;
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        target[segment] = value;
      } else {
        target = (target[segment] ??= {}) as Record<string, unknown>;
      }
    }
  }
  return patch as FxStatePatch;
}

const SETTING_LABELS: Partial<Record<keyof FxState, string>> = {
  preset: "视觉预设",
  intensity: "律动强度",
  depth: "立体感",
  coverResolution: "封面清晰度",
  cinemaShake: "镜头晃动",
  backgroundOpacity: "背景透明度",
  performanceQuality: "画质档位",
  performanceBackground: "后台策略",
  shelf: "歌单架模式",
  shelfCameraMode: "歌单架镜头",
  shelfPresence: "歌单架显示",
  desktopLyrics: "桌面歌词",
};

function settingLabel(path: string): string {
  const root = path.split(".")[0] as keyof FxState | undefined;
  if (root === "stageLyrics") return "歌词舞台";
  if (root === "sonic") return "Sonic Topography";
  if (root === "workshop") return "音域回响 Wallpaper Engine";
  return (root && SETTING_LABELS[root]) || path;
}

function SettingsSection({
  tab,
  visible,
  children,
}: {
  tab: SettingsTabId;
  visible: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section data-settings-section={tab} hidden={!visible}>
      {children}
    </section>
  );
}

function Slider(props: {
  def: SliderDef;
  hostProps: VisualControlPanelHostProps;
  onNumberSettingChange?: (key: keyof FxState, value: number) => void;
}): ReactElement {
  const value = numberValue(props.hostProps, props.def.key);
  const lastEmittedRef = useRef<string | null>(null);
  const emit = useCallback(
    (raw: string) => {
      if (lastEmittedRef.current === raw) return;
      lastEmittedRef.current = raw;
      props.onNumberSettingChange?.(props.def.key, Number(raw));
    },
    [props],
  );
  return (
    <div className="fx-slider">
      <label htmlFor={props.def.id}>{props.def.label}</label>
      <input
        id={props.def.id}
        type="range"
        min={props.def.min}
        max={props.def.max}
        step={props.def.step}
        value={value}
        onInput={(event) => emit(event.currentTarget.value)}
        onChange={(event) => emit(event.currentTarget.value)}
      />
      <output>{formatOutput(value, props.def.step)}</output>
      <span aria-hidden="true" />
    </div>
  );
}

function Segment(props: {
  id: string;
  keyName: keyof FxState;
  value: string | number;
  options: readonly SegmentOption[];
  dataName: string;
  onStringSettingChange?: (key: keyof FxState, value: string) => void;
  onNumberSettingChange?: (key: keyof FxState, value: number) => void;
}): ReactElement {
  return (
    <div className="fx-seg" id={props.id}>
      {props.options.map((option) => {
        const active = String(option.value) === String(props.value);
        const dataAttributes = { [`data-${props.dataName}`]: option.value };
        return (
          <button
            key={String(option.value)}
            type="button"
            className={active ? "active" : ""}
            {...dataAttributes}
            onClick={() => {
              if (typeof option.value === "number")
                props.onNumberSettingChange?.(props.keyName, option.value);
              else props.onStringSettingChange?.(props.keyName, option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function formatOutput(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  if (step < 0.01) return value.toFixed(3);
  return value.toFixed(2);
}

export function VisualControlPanelHost(
  props: VisualControlPanelHostProps,
): ReactElement {
  const [open, setOpen] = useState(false);
  const [autoHide, setAutoHide] = useState(() =>
    props.initialFabAutoHide ?? readFxFabAutoHidePreference(),
  );
  const [autoHideSaving, setAutoHideSaving] = useState(false);
  const [peek, setPeek] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTabId>("common");
  const [settingsQuery, setSettingsQuery] = useState("");
  const deferredSettingsQuery = useDeferredValue(settingsQuery);
  const [customFonts, setCustomFonts] = useState<CustomLyricFontRecord[]>(readCustomLyricFonts);
  const customFontInputRef = useRef<HTMLInputElement | null>(null);
  const revealArmedRef = useRef(true);
  const previousAutoHideRef = useRef(autoHide);
  const propsRef = useRef(props);
  const pendingValuesRef = useRef<Record<string, unknown>>({});
  const transactionControllerRef = useRef<SettingsTransactionController | null>(null);
  if (!transactionControllerRef.current) {
    transactionControllerRef.current = new SettingsTransactionController();
  }
  const transactionController = transactionControllerRef.current;
  propsRef.current = props;
  const subscribeHistory = useCallback(
    (listener: () => void) => transactionController.subscribe(listener),
    [transactionController],
  );
  const readHistory = useCallback(
    () => transactionController.getSnapshot(),
    [transactionController],
  );
  const settingsHistory = useSyncExternalStore(
    subscribeHistory,
    readHistory,
    readHistory,
  );
  const workshopActive = props.settings?.workshop?.active === true;
  const preset = workshopActive ? 8 : clampPreset(props.preset ?? 0);
  useEffect(() => {
    pendingValuesRef.current = {};
  }, [props.intensity, props.preset, props.settings]);

  const currentTrackedValue = useCallback((path: string): unknown => {
    if (Object.hasOwn(pendingValuesRef.current, path)) {
      return pendingValuesRef.current[path];
    }
    if (path === "preset") return clampPreset(propsRef.current.preset ?? 0);
    return readSettingPath(propsRef.current, path);
  }, []);

  const reportTransactionError = useCallback((error: unknown) => {
    propsRef.current.onNotice?.(
      error instanceof Error ? error.message : "设置保存失败",
    );
  }, []);

  const applySettingsPatch = useCallback(async (patch: FxStatePatch) => {
    const current = propsRef.current;
    if (current.onSettingsTransaction) {
      await current.onSettingsTransaction(patch);
      return;
    }
    if (current.onFxPatchChange) {
      current.onFxPatchChange(patch);
      return;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number") {
        if (key === "preset") current.onPresetChange?.(value);
        else current.onNumberSettingChange?.(key as keyof FxState, value);
      } else if (typeof value === "boolean") {
        current.onBooleanSettingChange?.(key as keyof FxState, value);
      } else if (typeof value === "string") {
        current.onStringSettingChange?.(key as keyof FxState, value);
      }
    }
  }, []);

  const trackMutation = useCallback((input: {
    label: string;
    changes: Record<string, SettingsValueChange>;
    mergeKey?: string;
    commit(): Promise<void> | void;
  }): Promise<boolean> => {
    const clearPendingValues = () => {
      for (const [path, change] of Object.entries(input.changes)) {
        if (Object.is(pendingValuesRef.current[path], change.after)) {
          delete pendingValuesRef.current[path];
        }
      }
    };
    return transactionController
      .apply({
        ...input,
        // 在事务真正获得串行 ownership 时重算 before；失败的前序 mutation
        // 不得成为后继 history 的虚构起点。
        resolveChanges: () => {
          const changes = Object.fromEntries(
            Object.entries(input.changes).map(([path, change]) => [
              path,
              { before: currentTrackedValue(path), after: change.after },
            ]),
          );
          for (const [path, change] of Object.entries(input.changes)) {
            pendingValuesRef.current[path] = change.after;
          }
          return changes;
        },
        commit: async () => {
          try {
            await input.commit();
          } catch (error) {
            // 必须在 controller 释放 ownership 前回收失败 shadow，后继 mutation 才能重算 canonical before。
            clearPendingValues();
            throw error;
          }
        },
      })
      .then((applied) => {
        if (!applied) clearPendingValues();
        return applied;
      })
      .catch((error) => {
        clearPendingValues();
        reportTransactionError(error);
        return false;
      });
  }, [currentTrackedValue, reportTransactionError, transactionController]);

  const trackedNumberChange = useCallback((key: keyof FxState, value: number) => {
    const path = String(key);
    trackMutation({
      label: `调整${settingLabel(path)}`,
      mergeKey: path,
      changes: { [path]: { before: currentTrackedValue(path), after: value } },
      commit: () => propsRef.current.onNumberSettingChange?.(key, value),
    });
  }, [currentTrackedValue, trackMutation]);

  const trackedBooleanChange = useCallback((key: keyof FxState, value: boolean) => {
    const path = String(key);
    trackMutation({
      label: `${value ? "开启" : "关闭"}${settingLabel(path)}`,
      changes: { [path]: { before: currentTrackedValue(path), after: value } },
      commit: () => propsRef.current.onBooleanSettingChange?.(key, value),
    });
  }, [currentTrackedValue, trackMutation]);

  const trackedStringChange = useCallback((key: keyof FxState, value: string) => {
    const path = String(key);
    trackMutation({
      label: `修改${settingLabel(path)}`,
      mergeKey: path.includes("Color") ? path : undefined,
      changes: { [path]: { before: currentTrackedValue(path), after: value } },
      commit: () => propsRef.current.onStringSettingChange?.(key, value),
    });
  }, [currentTrackedValue, trackMutation]);

  const trackedFxPatchChange = useCallback((patch: FxStatePatch) => {
    const changes = settingChangesFromPatch(propsRef.current, patch);
    const paths = Object.keys(changes);
    for (const path of paths) {
      const pending = pendingValuesRef.current[path];
      if (pending !== undefined) changes[path] = { ...changes[path]!, before: pending };
    }
    const gestureMergeKey =
      paths.length > 0 &&
      (paths.some((path) => /color/i.test(path)) ||
        paths.every((path) => typeof changes[path]?.after === "number"))
        ? `patch:${[...paths].sort().join("|")}`
        : undefined;
    trackMutation({
      label: paths.includes("preset")
        ? "切换视觉预设"
        : paths.some((path) => path.startsWith("sonic."))
          ? "调整 Sonic Topography"
          : paths.some((path) => path.startsWith("workshop."))
            ? "调整音域回响 Wallpaper Engine"
            : paths.some((path) => path.startsWith("stageLyrics."))
              ? "调整歌词舞台"
              : "调整视觉设置",
      changes,
      mergeKey: gestureMergeKey,
      commit: () => applySettingsPatch(patch),
    });
  }, [applySettingsPatch, trackMutation]);

  const restoreSettings = useCallback(async (values: Record<string, unknown>) => {
    const previous = new Map<
      string,
      { present: boolean; value: unknown }
    >();
    for (const [path, value] of Object.entries(values)) {
      previous.set(path, {
        present: Object.hasOwn(pendingValuesRef.current, path),
        value: pendingValuesRef.current[path],
      });
      pendingValuesRef.current[path] = value;
    }
    try {
      await applySettingsPatch(patchFromSettingValues(values));
    } catch (error) {
      for (const [path, snapshot] of previous) {
        if (snapshot.present) pendingValuesRef.current[path] = snapshot.value;
        else delete pendingValuesRef.current[path];
      }
      throw error;
    }
  }, [applySettingsPatch]);

  const undoSettings = useCallback(() => {
    void transactionController.undo(restoreSettings).catch(reportTransactionError);
  }, [reportTransactionError, restoreSettings, transactionController]);

  const rollbackSettingsTo = useCallback((entryId: string) => {
    void transactionController
      .rollbackTo(entryId, restoreSettings)
      .catch(reportTransactionError);
  }, [reportTransactionError, restoreSettings, transactionController]);

  const enableLowSpecMode = useCallback(() => {
    const current = Object.fromEntries(
      [
        "performanceQuality",
        "performanceBackground",
        "coverResolution",
        "aiDepth",
        "bloom",
        "backCover",
        "lyricGlowParticles",
        "particleLyrics",
      ].map((path) => [path, currentTrackedValue(path)]),
    ) as Parameters<typeof buildLowSpecChanges>[0];
    const changes = buildLowSpecChanges(current);
    void trackMutation({
      label: "启用低配模式",
      changes,
      commit: () =>
        applySettingsPatch(
          patchFromSettingValues(
            Object.fromEntries(
              Object.entries(changes).map(([path, change]) => [path, change.after]),
            ),
          ),
        ),
    }).then((applied) => {
      if (applied) {
        propsRef.current.onNotice?.("已启用低配模式，可从最近更改撤销");
      }
    });
  }, [applySettingsPatch, currentTrackedValue, trackMutation]);

  const resetPreferences = useCallback(() => {
    const resetPatch = Object.fromEntries(
      Object.entries(FX_DEFAULTS).filter(
        ([path]) => !RESET_EXCLUDED_SETTING_PATHS.has(path as keyof FxState),
      ),
    ) as FxStatePatch;
    const changes = Object.fromEntries(
      Object.entries(resetPatch).map(([path, after]) => [
        path,
        { before: currentTrackedValue(path), after },
      ]),
    );
    trackMutation({
      label: "重置全部可逆偏好",
      changes,
      commit: () => applySettingsPatch(resetPatch),
    });
  }, [applySettingsPatch, currentTrackedValue, trackMutation]);

  const sectionVisible = useCallback((
    tab: SettingsTabId,
    terms: readonly string[],
  ): boolean => {
    if (deferredSettingsQuery.trim()) {
      return settingGroupMatches(deferredSettingsQuery, terms);
    }
    return activeSettingsTab === tab;
  }, [activeSettingsTab, deferredSettingsQuery]);
  const nativeDesktopSearchTerms = buildNativeDesktopSettingsSearchTerms(
    props.desktopRuntimeSearchTerms,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("fx-fab-auto-hide", autoHide);
    document.body.classList.toggle("fx-fab-peek", autoHide && (peek || open));
    return () => {
      document.body.classList.remove("fx-fab-auto-hide", "fx-fab-peek");
    };
  }, [autoHide, open, peek]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!autoHide) {
      revealArmedRef.current = true;
      previousAutoHideRef.current = false;
      setPeek(false);
      return;
    }
    if (!previousAutoHideRef.current) revealArmedRef.current = false;
    previousAutoHideRef.current = true;
    const updateFromPointer = (event: MouseEvent) => {
      const nearBottomRight = event.clientX > window.innerWidth - 126 && event.clientY > window.innerHeight - 158;
      if (!nearBottomRight) revealArmedRef.current = true;
      setPeek(open || (nearBottomRight && revealArmedRef.current));
    };
    const clearPeek = () => {
      revealArmedRef.current = true;
      setPeek(false);
    };
    window.addEventListener("mousemove", updateFromPointer);
    window.addEventListener("mouseleave", clearPeek);
    return () => {
      window.removeEventListener("mousemove", updateFromPointer);
      window.removeEventListener("mouseleave", clearPeek);
    };
  }, [autoHide, open]);
  const changePreset = useCallback(
    (next: number) => {
      trackedFxPatchChange({
        preset: next,
        workshop: { active: next === 8 },
      });
    },
    [trackedFxPatchChange],
  );
  const toggleBoolean = useCallback(
    (def: ToggleDef) => {
      if (def.disabled) return;
      trackedBooleanChange(def.key, !booleanValue(props, def.key));
    },
    [props, trackedBooleanChange],
  );
  const toggle = (def: ToggleDef) => (
    <button
      key={def.id}
      type="button"
      id={def.id}
      className={`${booleanValue(props, def.key) ? "fx-toggle on" : "fx-toggle"}${def.disabled ? " dev-locked" : ""}`}
      disabled={def.disabled}
      title={def.title}
      onClick={() => toggleBoolean(def)}
    >
      <span>
        {def.label}
        {def.badge ? <em className="fx-dev-badge">{def.badge}</em> : null}
      </span>
      <span className="dot" />
    </button>
  );
  const slider = (def: SliderDef) => (
    <Slider
      key={def.id}
      def={def}
      hostProps={props}
      onNumberSettingChange={trackedNumberChange}
    />
  );
  const setUiAccentColor = useCallback(
    (color: string) => {
      trackedStringChange("uiAccentColor", color.toLowerCase());
    },
    [trackedStringChange],
  );
  const setHomeAccentColor = useCallback(
    (color: string) => {
      trackedStringChange("homeAccentColor", color.toLowerCase());
    },
    [trackedStringChange],
  );
  const toggleAutoHide = useCallback(async () => {
    if (autoHideSaving) return;
    const next = !autoHide;
    setAutoHideSaving(true);
    try {
      if (props.onFabAutoHideChange) {
        await props.onFabAutoHideChange(next);
      } else {
        saveFxFabAutoHidePreference(next);
      }
      revealArmedRef.current = !next;
      setAutoHide(next);
      setPeek(false);
      props.onNotice?.(next ? "视觉控制台按钮已自动隐藏" : "视觉控制台按钮已固定显示");
    } catch {
      props.onNotice?.("视觉控制台自动隐藏偏好保存失败");
    } finally {
      setAutoHideSaving(false);
    }
  }, [autoHide, autoHideSaving, props]);
  const resetUiAccentColor = useCallback(() => {
    trackedStringChange("uiAccentColor", FX_DEFAULTS.uiAccentColor);
  }, [trackedStringChange]);
  const resetHomeAccentColor = useCallback(() => {
    trackedStringChange("homeAccentColor", FX_DEFAULTS.homeAccentColor);
  }, [trackedStringChange]);
  const setVisualTintCustom = useCallback(
    (color: string) => {
      const visualTintColor = color.toLowerCase();
      trackedFxPatchChange({ visualTintMode: "custom", visualTintColor });
    },
    [trackedFxPatchChange],
  );
  const setVisualTintAuto = useCallback(() => {
    trackedStringChange("visualTintMode", "auto");
  }, [trackedStringChange]);
  const resetVisualTintColor = useCallback(() => {
    trackedFxPatchChange({
      visualTintMode: "auto",
      visualTintColor: FX_DEFAULTS.visualTintColor,
    });
  }, [trackedFxPatchChange]);
  const setLyricColorCustom = useCallback(
    (color: string) => {
      const lyricColor = color.toLowerCase();
      trackedFxPatchChange({ lyricColorMode: "custom", lyricColor });
    },
    [trackedFxPatchChange],
  );
  const setLyricColorAuto = useCallback(() => {
    trackedStringChange("lyricColorMode", "auto");
  }, [trackedStringChange]);
  const setLyricHighlightCustom = useCallback(
    (color: string) => {
      const lyricHighlightColor = color.toLowerCase();
      trackedFxPatchChange({
        lyricHighlightMode: "custom",
        lyricHighlightColor,
      });
    },
    [trackedFxPatchChange],
  );
  const setLyricHighlightAuto = useCallback(() => {
    trackedStringChange("lyricHighlightMode", "auto");
  }, [trackedStringChange]);
  const toggleLyricGlowLinked = useCallback(() => {
    trackedBooleanChange("lyricGlowLinked", !booleanValue(props, "lyricGlowLinked"));
  }, [props, trackedBooleanChange]);
  const setLyricGlowColor = useCallback(
    (color: string) => {
      trackedStringChange("lyricGlowColor", color.toLowerCase());
    },
    [trackedStringChange],
  );
  const importCustomLyricFont = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const record = await saveCustomLyricFont(file);
      await registerCustomLyricFont(customLyricFontKey(record));
      setCustomFonts(readCustomLyricFonts());
      trackedStringChange("lyricFont", customLyricFontKey(record));
      props.onNotice?.(`已载入字体：${record.name}`);
    } catch (error) {
      props.onNotice?.(error instanceof Error ? error.message : "字体载入失败");
    } finally {
      if (customFontInputRef.current) customFontInputRef.current.value = "";
    }
  }, [props, trackedStringChange]);
  const deleteCustomLyricFont = useCallback(async (record: CustomLyricFontRecord) => {
    try {
      if (
        stringValue(propsRef.current, "lyricFont") ===
        customLyricFontKey(record)
      ) {
        // 字体文件删除不可撤销；先提交安全 fallback，成功后才释放资源。
        await applySettingsPatch({ lyricFont: "sans" });
      }
      setCustomFonts(removeCustomLyricFont(record.id));
      propsRef.current.onNotice?.(`已删除字体：${record.name}`);
    } catch (error) {
      reportTransactionError(error);
    }
  }, [applySettingsPatch, reportTransactionError]);
  const uiAccentColor = hexSettingValue(props, "uiAccentColor");
  const homeAccentColor = hexSettingValue(props, "homeAccentColor");
  const visualTintColor = hexSettingValue(props, "visualTintColor");
  const visualTintAuto = stringValue(props, "visualTintMode") !== "custom";
  const lyricColor = hexSettingValue(props, "lyricColor");
  const lyricColorAuto = stringValue(props, "lyricColorMode") !== "custom";
  const lyricHighlightColor = hexSettingValue(props, "lyricHighlightColor");
  const lyricHighlightAuto = stringValue(props, "lyricHighlightMode") !== "custom";
  const lyricGlowColor = hexSettingValue(props, "lyricGlowColor");
  const lyricGlowLinked = booleanValue(props, "lyricGlowLinked");

  return (
    <>
      <button
        id="fx-fab"
        className={open ? "active" : ""}
        title="视觉控制台"
        aria-label="视觉控制台"
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="21"
          height="21"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M4 7h8" />
          <path d="M16 7h4" />
          <circle cx="14" cy="7" r="2" />
          <path d="M4 17h4" />
          <path d="M12 17h8" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      </button>
      <button
        id="fx-fab-hide-btn"
        className={autoHide ? "on" : ""}
        type="button"
        title={autoHide ? "取消自动隐藏视觉控制台" : "自动隐藏视觉控制台"}
        aria-label={autoHide ? "取消自动隐藏视觉控制台" : "自动隐藏视觉控制台"}
        aria-pressed={autoHide}
        disabled={autoHideSaving}
        onClick={() => void toggleAutoHide()}
      >
        {autoHide ? "›" : "‹"}
      </button>
      <div id="fx-panel" className={open ? "show" : ""}>
        <div className="fx-head">
          <div>
            <div className="fx-title">视觉控制台 · 设置工作台</div>
            <div className="fx-sub">MINERADIO VISUALS · 可逆偏好与运行时工具</div>
          </div>
        </div>

        <SettingsWorkbench
          activeTab={activeSettingsTab}
          query={settingsQuery}
          history={settingsHistory}
          onTabChange={setActiveSettingsTab}
          onQueryChange={setSettingsQuery}
          onUndo={undoSettings}
          onRollbackTo={rollbackSettingsTo}
          onEnableLowSpec={enableLowSpecMode}
          onResetPreferences={resetPreferences}
        />

        <SettingsSection
          tab="common"
          visible={sectionVisible("common", VISUAL_SETTINGS_SEARCH_INDEX.commonPresets)}
        >
          <div className="fx-section-label">视觉预设</div>
          <div className="preset-grid" id="preset-grid">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  preset === item.id ? "preset-card active" : "preset-card"
                }
                data-preset={item.id}
                onClick={() => changePreset(item.id)}
              >
                <span className="pc-icon">{item.id === 6 ? "✦" : "◌"}</span>
                <span className="pc-name">{item.name}</span>
                <span className="pc-desc">
                  {item.id === 6 ? (
                    <>
                      骷髅 · <span className="pc-yui7w">YUI7W</span>
                    </>
                  ) : (
                    item.desc
                  )}
                </span>
              </button>
            ))}
          </div>
        </SettingsSection>
        <SettingsSection
          tab="interface"
          visible={sectionVisible("interface", VISUAL_SETTINGS_SEARCH_INDEX.interface)}
        >
          <div className="fx-section-label">自定义颜色</div>
          <div className="lyric-color-row">
          <input
            id="ui-accent-picker"
            className="lyric-color-picker"
            type="color"
            value={uiAccentColor}
            onInput={(event) => setUiAccentColor(event.currentTarget.value)}
            title="界面高亮色"
          />
          <div className="fx-color-row-label">
            界面高亮
            <small id="ui-accent-value">
              {uiAccentColor.toUpperCase()}
            </small>
          </div>
          <button id="ui-accent-default-btn" className="fx-mini-btn ghost" type="button" onClick={resetUiAccentColor}>
            默认
          </button>
        </div>
        <div className="lyric-color-row visual-tint-row">
          <input
            id="visual-tint-picker"
            className="lyric-color-picker"
            type="color"
            value={visualTintColor}
            onInput={(event) => setVisualTintCustom(event.currentTarget.value)}
            title="视觉主色"
          />
          <div className="fx-color-row-label">
            视觉主色<small id="visual-tint-value">{visualTintAuto ? "封面取色" : visualTintColor.toUpperCase()}</small>
          </div>
          <button
            className={visualTintAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"}
            id="visual-tint-auto-btn"
            type="button"
            onClick={setVisualTintAuto}
          >
            封面
          </button>
          <button id="visual-tint-default-btn" className="fx-mini-btn ghost" type="button" onClick={resetVisualTintColor}>
            默认
          </button>
        </div>
        <div className="lyric-color-row">
          <input
            id="home-accent-picker"
            className="lyric-color-picker"
            type="color"
            value={homeAccentColor}
            onInput={(event) => setHomeAccentColor(event.currentTarget.value)}
            title="Home 填充色"
          />
          <div className="fx-color-row-label">
            Home 填充
            <small id="home-accent-value">
              {homeAccentColor.toUpperCase()}
            </small>
          </div>
          <button id="home-accent-default-btn" className="fx-mini-btn ghost" type="button" onClick={resetHomeAccentColor}>
            默认
          </button>
          </div>
          {MAIN_SLIDERS.slice(0, 2).map(slider)}
        </SettingsSection>
        <SettingsSection
          tab="common"
          visible={sectionVisible("common", VISUAL_SETTINGS_SEARCH_INDEX.commonMain)}
        >
          <div className="fx-section-label">主控</div>
          {MAIN_SLIDERS.slice(2).map(slider)}
        </SettingsSection>

        <SettingsSection
          tab="lyrics"
          visible={sectionVisible("lyrics", VISUAL_SETTINGS_SEARCH_INDEX.lyrics)}
        >
        <div className="fx-fold open" id="fx-lyric-fold">
          <div className="fx-fold-head">
            <span className="fx-fold-title">
              <strong>歌词外观</strong>
              <small>颜色 / 来源 / 位置</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-section-label">歌词颜色</div>
            <div className="lyric-color-row">
              <input
                id="lyric-color-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricColor}
                onInput={(event) => setLyricColorCustom(event.currentTarget.value)}
                title="歌词主色"
              />
              <div className="fx-color-row-label">
                歌词主色<small id="lyric-color-value">{lyricColorAuto ? "封面取色" : lyricColor.toUpperCase()}</small>
              </div>
              <button id="lyric-color-auto-btn" className={lyricColorAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={setLyricColorAuto}>
                封面
              </button>
            </div>
            <div className="lyric-color-row">
              <input
                id="lyric-highlight-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricHighlightColor}
                onInput={(event) => setLyricHighlightCustom(event.currentTarget.value)}
                title="歌词高亮色"
              />
              <div className="fx-color-row-label">
                歌词高亮<small id="lyric-highlight-value">{lyricHighlightAuto ? "封面取色" : lyricHighlightColor.toUpperCase()}</small>
              </div>
              <button id="lyric-highlight-auto-btn" className={lyricHighlightAuto ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={setLyricHighlightAuto}>
                封面
              </button>
            </div>
            <div className="lyric-color-row">
              <input
                id="lyric-glow-picker"
                className="lyric-color-picker"
                type="color"
                value={lyricGlowColor}
                onInput={(event) => setLyricGlowColor(event.currentTarget.value)}
                title="歌词溢光色"
              />
              <div className="fx-color-row-label">
                溢光色<small id="lyric-glow-value">{lyricGlowLinked ? "跟随高亮" : lyricGlowColor.toUpperCase()}</small>
              </div>
              <button id="lyric-glow-linked" className={lyricGlowLinked ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"} type="button" onClick={toggleLyricGlowLinked}>
                链接
              </button>
            </div>
            <div className="fx-section-label">歌词字体</div>
            <div className="fx-font-grid expanded" id="lyric-font-grid">
              {LYRIC_FONTS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  data-font={key}
                  className={
                    (props.settings?.lyricFont ?? FX_DEFAULTS.lyricFont) === key
                      ? "active"
                      : ""
                  }
                  onClick={() =>
                    trackedStringChange("lyricFont", key)
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              ref={customFontInputRef}
              className="fx-hidden-file-input"
              type="file"
              accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
              onChange={(event) => void importCustomLyricFont(event.currentTarget.files?.[0])}
            />
            <div className="fx-runtime-actions">
              <button
                type="button"
                className="fx-mini-btn ghost"
                onClick={() => customFontInputRef.current?.click()}
              >
                导入字体
              </button>
              {customFonts.map((record) => {
                const key = customLyricFontKey(record);
                const active = stringValue(props, "lyricFont") === key;
                return (
                  <span key={record.id} className="fx-custom-font-entry">
                    <button
                      type="button"
                      className={active ? "fx-mini-btn ghost active" : "fx-mini-btn ghost"}
                      onClick={() => trackedStringChange("lyricFont", key)}
                    >
                      {record.name}
                    </button>
                    <button
                      type="button"
                      className="fx-custom-font-remove"
                      aria-label={`删除字体 ${record.name}`}
                      data-undoable="false"
                      title="删除字体文件（不可撤销）"
                      onClick={() => void deleteCustomLyricFont(record)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
            {LYRIC_LAYOUT_SLIDERS.map(slider)}
          </div>
        </div>
        </SettingsSection>

        <SettingsSection
          tab="motion"
          visible={sectionVisible("motion", VISUAL_SETTINGS_SEARCH_INDEX.motion)}
        >
        <div className="fx-fold open" id="fx-overlay-fold">
          <div className="fx-fold-head">
            <span className="fx-fold-title">
              <strong>叠加效果</strong>
              <small>粒子 / 镜头 / 溢光</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-toggle-grid">{OVERLAY_TOGGLES.map(toggle)}</div>
            <div className="fx-section-label">桌面歌词</div>
            {DESKTOP_SLIDERS.map(slider)}
            <div className="fx-section-label">桌面帧数</div>
            <Segment
              id="desktop-lyrics-fps-seg"
              keyName="desktopLyricsFps"
              value={numberValue(props, "desktopLyricsFps")}
              dataName="desktop-lyrics-fps"
              options={[
                { value: 24, label: "24" },
                { value: 30, label: "30" },
                { value: 60, label: "60" },
                { value: 120, label: "120" },
                { value: 0, label: "无上限" },
              ]}
              onNumberSettingChange={trackedNumberChange}
            />
          </div>
        </div>
        </SettingsSection>

        <SettingsSection
          tab="system"
          visible={sectionVisible("system", nativeDesktopSearchTerms)}
        >
          {props.desktopRuntimeSlot ? (
            <div
              className="settings-native-boundary"
              data-settings-native-boundary
              data-undoable="false"
            >
              <div className="settings-native-boundary-head">
                <span>桌面与系统能力</span>
                <strong>系统操作不可撤销</strong>
              </div>
              <p>缓存清理、完整桌面、Wallpaper Engine 与其他系统动作不会进入设置历史。</p>
              <div className="settings-native-boundary-slot">
                {props.desktopRuntimeSlot}
              </div>
            </div>
          ) : null}
          {props.audioSettingsSlot ? (
            <div
              className="settings-native-boundary"
              data-settings-audio-boundary
              data-undoable="false"
            >
              <div className="settings-native-boundary-head">
                <span>音频与输出</span>
                <strong>Playback 2.0 扩展</strong>
              </div>
              <p>输出路由、镜像、虚拟桥接与 fade 参数（Tauri 扩展能力，不占用播放器底栏）。</p>
              <div className="settings-native-boundary-slot">
                {props.audioSettingsSlot}
              </div>
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          tab="shelf"
          visible={sectionVisible("shelf", VISUAL_SETTINGS_SEARCH_INDEX.shelf)}
        >
        <div className="fx-fold open" id="fx-stage-fold">
          <div className="fx-fold-head">
            <span className="fx-fold-title">
              <strong>3D 歌单架</strong>
              <small>模式 / 内容</small>
            </span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-fold-body">
            <div className="fx-section-label">3D 歌单架</div>
            <Segment
              id="shelf-seg"
              keyName="shelf"
              value={stringValue(props, "shelf") || "side"}
              dataName="shelf"
              options={[
                { value: "off", label: "关闭" },
                { value: "side", label: "侧栏" },
                { value: "stage", label: "舞台" },
              ]}
              onStringSettingChange={trackedStringChange}
            />
            <div className="fx-section-label">歌单架镜头</div>
            <Segment
              id="shelf-camera-seg"
              keyName="shelfCameraMode"
			  value={stringValue(props, "shelfCameraMode") || "dynamic"}
              dataName="shelf-camera"
              options={[
                { value: "dynamic", label: "动态镜头" },
                { value: "static", label: "静态镜头" },
              ]}
              onStringSettingChange={trackedStringChange}
            />
            <div className="fx-section-label">歌单架显示</div>
            <Segment
              id="shelf-presence-seg"
              keyName="shelfPresence"
              value={stringValue(props, "shelfPresence") || "always"}
              dataName="shelf-presence"
              options={[
                { value: "auto", label: "自动隐藏" },
                { value: "always", label: "常驻" },
              ]}
              onStringSettingChange={trackedStringChange}
            />
            <div className="fx-section-label">歌单架内容</div>
            <div className="fx-toggle-grid">
              {SHELF_CONTENT_TOGGLES.map(toggle)}
            </div>
          </div>
        </div>
        </SettingsSection>

        <SettingsSection
          tab="motion"
          visible={sectionVisible("motion", VISUAL_SETTINGS_SEARCH_INDEX.visualEngines)}
        >
          <StageLyricsControls
            settings={props.settings}
            onFxPatchChange={trackedFxPatchChange}
          />
          <SonicTopographyControls
            settings={props.settings}
            onFxPatchChange={trackedFxPatchChange}
          />
          {preset === 8 ? (
            <SonicWorkshopControls
              settings={props.settings}
              onFxPatchChange={trackedFxPatchChange}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection
          tab="system"
          visible={sectionVisible("system", VISUAL_SETTINGS_SEARCH_INDEX.systemAdvanced)}
        >
        <div className="fx-advanced open" id="fx-advanced">
          <div className="fx-advanced-head">
            <span>高级参数</span>
            <span className="arrow">▶</span>
          </div>
          <div className="fx-advanced-body">
            <div className="fx-section-label">直播 / 后台</div>
            <Segment
              id="performance-background-seg"
              keyName="performanceBackground"
              value={stringValue(props, "performanceBackground") || "auto"}
              dataName="performance-background"
              options={[
                { value: "auto", label: "自动优化" },
                { value: "keep", label: "保持运行" },
                { value: "release", label: "停止释放" },
              ]}
              onStringSettingChange={trackedStringChange}
            />
            <div className="fx-section-label">画质档位</div>
            <Segment
              id="performance-quality-seg"
              keyName="performanceQuality"
              value={stringValue(props, "performanceQuality") || "high"}
              dataName="performance-quality"
              options={[
                { value: "eco", label: "低" },
                { value: "balanced", label: "中" },
                { value: "high", label: "高" },
                { value: "ultra", label: "超高" },
              ]}
              onStringSettingChange={trackedStringChange}
            />
            {ADVANCED_SLIDERS.map(slider)}
          </div>
        </div>
        </SettingsSection>
      </div>
    </>
  );
}
