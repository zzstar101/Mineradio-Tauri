# Shared semantic fixtures

These fixtures preserve complete API-call envelopes (`{ ok, data, error }`) rather than minimal schema-only objects.

- `recommendation-pages-envelope.json`: serialized semantic result of the QQ recommendation mapper case `recommendation_standardizes_known_shelves_and_replaces_track_ids_with_mids` in `api/src/providers/qq/model.rs`. It covers playlist, track, mixed, stream, nullable collection state, and provider identity.
- `recommendation-pages-empty-envelope.json`: live `MineRadio-api@0b4153c9` response captured through `Api::recommendation_pages(true)` with no authenticated recommendation page available. This is a legitimate empty response, not a schema fallback.
- `weather-radio-envelope.json`: live `MineRadio-api@0b4153c9` response captured through `Api::weather_radio` for Shanghai/Asia-Hong_Kong and wrapped exactly as `api_bridge` does. It includes the weather snapshot plus real Soda/Netease/QQ Track shapes.
- `weather-radio-empty-envelope.json`: the same service contract with the legal no-search-results outcome (`radio.songs: []`), matching `WeatherRadioDeps::default()` semantics rather than a schema-error fallback.

Provider payloads remain user-owned API evidence. Update these files only from a captured/mapper-produced result; do not hand-wave schema failures with permissive parsing or empty fallbacks.
