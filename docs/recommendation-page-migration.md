# Recommendation Page Migration Plan

## Goal

Replace the single-source `DiscoverHomeResponse` flow with provider-owned
`RecommendationPage` data in two stages:

1. Home preview: show only the first `RecommendationModule` for each provider.
2. Recommendation page: later, show all modules from all providers when the
   user opens “推荐” from the title bar.

This document scopes stage 1. It does not implement the standalone
recommendation page yet.

## Current State

### Backend capability already exists

- `Api::recommendation_pages(refresh)` aggregates successful provider pages.
- `CrossSourceResolver` iterates registered providers and ignores providers
  that return an error or do not implement recommendations.
- Netease and QQ currently implement `recommendation_page`. Kugou and Soda use
  the trait default `NOT_IMPLEMENTED`.
- Rust `RecommendationPage` is:

```text
provider: ProviderId
list: Vec<RecommendationModule>
```

Each module is:

```text
title: String
list: Vec<RecommendationCard>
```

Each card is:

```text
id, title, subtitle, kind, cover_url, collected
```

### Frontend still consumes old Discover Home

- The transport calls `/discover/home` and validates
  `DiscoverHomeResponseSchema`.
- `DiscoverPort.discoverHome()` exposes that response to home code.
- `useHomeController` stores it as `discover`, refreshes it on login changes,
  and derives playback queues and playlist details from it.
- `useHomeDashboardController` builds `forYou` primarily from listen history
  plus `dailySongs`.
- `EmptyHomeHost` builds generic tiles and provider-specific playlist rails
  from `dailySongs`, `playlists`, and `podcasts`.
- Weather radio, starter actions, listen history, podcast search/detail, and
  local/import flows are independent of provider recommendation data and must
  remain available during migration.

## Design Principle

Do not force every provider into the old `dailySongs / playlists / podcasts`
shape. That loses module semantics and makes future provider-specific modules
harder to represent.

Instead, keep `RecommendationModule` as the presentation unit:

- Home preview renders one section per provider.
- Each section uses only that provider’s first module (`list[0]`).
- A missing provider is omitted; it does not create an empty placeholder.
- A provider whose first module has no cards is also omitted.
- Card interaction depends on `RecommendationType`; do not infer behavior from
  position or title.

## Stage 1: Home Preview Migration

### 1. Shared contract

Create a new frontend schema file, preferably
`packages/shared/src/recommendation.ts`:

```ts
export const RecommendationCardSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  subtitle: z.string().default(""),
  kind: z.enum(["Track", "Stream", "Playlist", "Unknown"]).default("Unknown"),
  coverUrl: z.string().default(""),
  collected: z.boolean().nullable().optional(),
});

export const RecommendationModuleSchema = z.object({
  title: z.string().default(""),
  list: z.array(RecommendationCardSchema).default([]),
});

export const RecommendationPageSchema = z.object({
  provider: ProviderIdSchema,
  list: z.array(RecommendationModuleSchema).default([]),
});
```

Export it from `packages/shared/src/index.ts`. Keep the existing discover
schema unchanged until the full cutover.

The enum values intentionally preserve the current serde unit-variant names.
If we want lowercase wire values such as `"track"`, that must be introduced as
an explicit API contract change with Rust-side tests; it is not part of this
migration.

### 2. Transport route

Expose the existing aggregate method through the desktop bridge:

```text
GET /recommendations/pages?refresh=false
```

Implementation:

- Call `mineradio_api::Api::recommendation_pages(refresh)`.
- Return `Vec<RecommendationPage>` directly through the normal success envelope.
- Do not add provider-specific fallbacks in the bridge.

Then add:

```ts
async recommendationPages(options?: { refresh?: boolean }): Promise<RecommendationPage[]>
```

to `SidecarClient`, validate it with `RecommendationPageArraySchema`, and call
it from the legacy sidecar services adapter.

### 3. Port boundary

Extend `DiscoverPort` without removing `discoverHome()` yet:

```ts
recommendationPages(options?: { refresh?: boolean }): Promise<RecommendationPage[]>;
```

Implement it in `legacy-sidecar-services.ts`. Update the port conformance test
and any stub ports used by tests.

A narrower alternative is a separate `RecommendationPort`. For stage 1 this is
unnecessary because discovery/home is already the consumer and both operations
belong to the same application area.

### 4. Home state controller

Add recommendation state beside the old discover state:

```ts
const [recommendations, setRecommendations] = useState<RecommendationPage[]>([]);
const [recommendationsLoading, setRecommendationsLoading] = useState(false);
const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
```

Add `refreshRecommendations()` with request-generation protection matching
`refreshDiscover()`. Load it in the same effect that loads Discover Home, but
keep failures separate:

- Old Discover failure must not block recommendation preview.
- New recommendation failure must not break weather radio or starter home.

On success, normalize ordering by the canonical provider order:

```text
netease -> qq -> kugou -> soda
```

Preserve duplicates only if the backend returns them; normally the aggregate
returns at most one page per provider.

### 5. Preview policy

Add a pure policy module, for example
`apps/web/src/features/home/home-recommendation-preview-policy.ts`.

Suggested model:

```ts
export interface HomeProviderPreview {
  provider: ProviderId;
  title: string;
  cards: RecommendationCard[];
}

export function buildHomeRecommendationPreviews(
  pages: RecommendationPage[],
): HomeProviderPreview[];
```

Rules:

1. Select `page.list[0]`.
2. Ignore empty titles/cards according to the UI rules below.
3. Limit each preview to a fixed number of cards (start with 8).
4. Order providers canonically.
5. Return no entry for unavailable providers.

Keep this logic pure so it can be covered by table tests.

### 6. UI integration

For stage 1, render one rail per provider above or beside the existing home
rails, depending on the final visual hierarchy. Each rail contains:

- Provider label as the section title.
- First module title as the section note when different from the provider name.
- Cards in a horizontal rail using the existing home tile/cover styling where
  possible.

Suggested component split:

- `features/home/HomeProviderPreviewSection.tsx`: one provider rail.
- `features/home/HomeProviderPreviewList.tsx`: maps previews to sections.

Keep `EmptyHomeHost` focused on composition rather than adding another large
mapping branch.

### 7. Interaction mapping

Because `RecommendationCard` does not carry a playable `Track`, stage 1 should
not pretend every card can start playback.

Implement conservative interactions:

- `Playlist`: open playlist detail via the existing library port using
  `card.id`.
- `Track` / `Stream`: show “该推荐内容需要后续接入播放详情” or trigger search by
  title if product explicitly accepts fuzzy behavior. Default to the explicit
  not-ready toast/search path until user confirms desired UX.
- `Unknown`: no navigation; show a neutral toast.

If the user wants direct Track playback now, the API contract needs to change:
either embed `Track` in recommendation cards or expose a typed
`resolve_recommendation_card(provider, card)` operation. Do not guess this API.

### 8. Login and refresh behavior

Refresh recommendation preview when:

- Application runtime becomes ready.
- A provider transitions between logged out and logged in.
- User explicitly retries after an error.

Use `refresh=false` for normal loads. Use cache-clearing refresh only after a
successful login/session change or an explicit user retry action.

Do not clear all provider caches merely because one provider changed; the
current auth session layer already clears that provider’s
`recommendation_page` cache.

## Testing Plan

### Contract tests

- `packages/shared/src/recommendation.test.ts`
  - Accepts Netease/QQ-shaped payloads.
  - Applies defaults.
  - Rejects invalid providers.

### Client tests

Extend `sidecar-client.test.ts`:

- Requests `GET /recommendations/pages?refresh=false`.
- Parses a multi-provider payload.
- Throws normalized errors on failure envelopes.

### Port tests

Update music services conformance:

- `discover.recommendationPages` delegates options correctly.

### Policy tests

Cover:

- One preview per provider.
- Only the first module is used.
- Canonical ordering.
- Empty module/card filtering.
- Maximum card count.
- Unknown/unavailable providers are omitted.

### Controller tests

Cover:

- Loads recommendations alongside old Discover.
- Stale responses are discarded.
- Recommendation failure leaves old home usable.
- Provider login transition triggers refresh.

### UI tests

Cover:

- Logged-in multi-provider home renders one section per provider.
- Only the first module appears per provider.
- Empty provider result has no section.
- Playlist card invokes playlist detail.
- Unknown card does not navigate.

## Rollout Sequence

1. Add shared schemas and exports.
2. Add desktop bridge route.
3. Extend client, port, and legacy service adapter.
4. Add pure preview policy + tests.
5. Add home state/controller wiring.
6. Render provider preview rails while retaining old Discover behavior.
7. Manually verify Netease/QQ preview against real accounts.
8. After visual/product confirmation, remove replaced old Discover fields in a
   separate cutover commit.

## Explicit Non-Goals

- No standalone recommendation page in this stage.
- No removal of `DiscoverPort.discoverHome()` yet.
- No invented Kugou/Soda recommendation APIs.
- No automatic conversion of every recommendation card into a playable track.
- No new cross-source matching logic.
- No changes to frozen playback/audio ownership.

## Open Questions

1. Should Track/Stream cards search by title as a temporary action, or display
   “not ready”?
2. How many cards should the home preview show per provider?
3. Where exactly should provider rails appear relative to continue listening,
   daily songs, playlists, podcasts, and weather radio?
4. Should the standalone “推荐” page eventually support manual refresh, or only
   login-driven cache invalidation?
