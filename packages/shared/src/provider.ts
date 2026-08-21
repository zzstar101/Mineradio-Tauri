import { z } from "zod";

export const ProviderIdSchema = z.enum(["netease", "qq", "kugou", "soda"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** 二维码登录协议种类，与 Rust 侧 `QrLoginKind` 对应；QQ 有三种扫码入口。 */
export type QrLoginKind = "netease" | "qq" | "qq_music" | "wechat" | "kugou" | "soda";

export const ProviderCapabilitySchema = z.enum([
  "search",
  "songUrl",
  "lyric",
  "playlistList",
  "playlistDetail",
  "loginStatus",
  "logout",
  "like",
  "comment",
  "podcast",
  "quality"
]);

export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
