import type { ComponentProps, ReactElement } from "react";
import { PlaylistPanelHost } from "../../components/shell/PlaylistPanelHost";
import type { LibraryControllerResult } from "./useLibraryController";
import { useCoverSourceResolver } from "../../cover/resolved-cover-source";

type CollectController = Pick<
  LibraryControllerResult,
  | "collectTarget"
  | "collectBusyPlaylistId"
  | "writableCollectPlaylists"
  | "closeCollectPicker"
  | "collectToPlaylist"
>;

export interface LibrarySurfaceProps {
  panelProps: ComponentProps<typeof PlaylistPanelHost>;
  collect: CollectController;
}

export function LibrarySurface({
  panelProps,
}: LibrarySurfaceProps): ReactElement {
  return <PlaylistPanelHost {...panelProps} />;
}

export function LibraryOverlaySurface({
  collect,
}: Pick<LibrarySurfaceProps, "collect">): ReactElement | null {
  const resolveCover = useCoverSourceResolver();
  const {
    collectTarget,
    collectBusyPlaylistId,
    writableCollectPlaylists,
    closeCollectPicker,
    collectToPlaylist,
  } = collect;

  return collectTarget ? (
        <div
          id="collect-modal"
          className="modal-mask show"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeCollectPicker();
          }}
        >
          <div
            className="modal collect-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collect-modal-title"
          >
            <h2 id="collect-modal-title">收藏到歌单</h2>
            <div id="collect-current" className="collect-current">
              {resolveCover(collectTarget.coverUrl).uri ? (
                <img src={resolveCover(collectTarget.coverUrl).uri} alt="" />
              ) : (
                <div className="cover-placeholder" />
              )}
              <div className="collect-current-meta">
                <div className="collect-title">{collectTarget.title}</div>
                <div className="collect-sub">
                  {collectTarget.artists.join(" / ")}
                </div>
              </div>
            </div>
            <div id="collect-list" className="collect-list">
              {writableCollectPlaylists.length > 0 ? (
                writableCollectPlaylists.map((playlist) => (
                  <button
                    key={`${playlist.provider}:${playlist.id}`}
                    type="button"
                    className={
                      collectBusyPlaylistId === playlist.id
                        ? "collect-item busy"
                        : "collect-item"
                    }
                    data-collect-pid={playlist.id}
                    onClick={() => void collectToPlaylist(playlist.id)}
                  >
                    {resolveCover(playlist.coverUrl).uri ? (
                      <img src={resolveCover(playlist.coverUrl).uri} alt="" />
                    ) : (
                      <div className="cover-placeholder" />
                    )}
                    <div className="collect-current-meta">
                      <div className="collect-title">{playlist.name}</div>
                      <div className="collect-sub">
                        {playlist.trackCount ?? 0} 首
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="collect-empty">还没有可写入的歌单</div>
              )}
            </div>
            <div className="btn-row">
              <button
                className="modal-btn"
                type="button"
                onClick={closeCollectPicker}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null;
}
