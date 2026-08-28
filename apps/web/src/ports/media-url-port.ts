export interface MediaUrlOptions {
	cacheBust?: boolean;
	now?: number;
}

/**
 * 可直接交给渲染运行时的图片来源。
 * URI 对调用方保持不透明；fallback 只描述加载顺序，不暴露 transport。
 */
export interface MediaImageSource {
	readonly uri: string;
	readonly logicalSource?: string;
	readonly fallbackUri?: string;
}

export interface MediaUrlPort {
	audioProxyUrl(url: string): string;
	playableUrl(url: string): string;
	imageSource(url: string, options?: MediaUrlOptions): MediaImageSource;
	/** 兼容现有只消费单个 URI 的调用方。 */
	imageUrl(url: string, options?: MediaUrlOptions): string;
}
