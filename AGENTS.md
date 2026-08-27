# MineRadio-Tauri Agent Guide

## Project Contract

- This is a Bun + Tauri desktop music player. The root workspace contains `apps/web`, `apps/desktop`, and shared frontend packages.
- The user owns the external API implementation in `api/`. Do not invent, redesign, or implement new provider APIs without an explicit request. Any externally visible API behavior must be manually verified by the user before it is treated as supported.
- `apps/` is the client: `apps/web` is the React frontend, and `apps/desktop/src-tauri` is the Rust desktop shell. Keep API ownership, frontend ports, and desktop shell responsibilities separate.
- Read `CONTEXT.md` before playback, audio, visual, runtime, or media-URL work. It defines frozen domain language and invariants.

## Repository Map

```text
api/                     User-owned external API implementation and provider/QR-login domain code.
apps/web/                React UI and application runtime composition.
apps/desktop/src-tauri/  Tauri shell, native desktop runtimes, IPC commands, and media protocols.
packages/shared/         Zod schemas and frontend/Rust-facing DTO contracts.
packages/visual-engine/  Three.js/GSAP visual engine; consumes opaque audio frames and media URIs only.
scripts/architecture/    Boundary and command-contract tests that enforce the architecture.
scripts/ci/              Release, updater manifest, provenance, and verification scripts.
docs/                    Release, parity, and architecture documentation.
```

## Frontend Architecture

- `src/ports/` defines stable application boundaries. Business modules depend on these typed interfaces, not concrete transports.
- `src/adapters/` implements those ports. `adapters/sidecar` owns the legacy application runtime and `SidecarClient`; `adapters/tauri` owns desktop IPC-backed capabilities.
- `src/api/sidecar-client.ts` is a concrete transport client and may only be referenced by `src/api/` and `src/adapters/sidecar/`.
- `src/app/` composes the shell and bootstraps `ApplicationPorts`. `ApplicationRuntimeBootstrap` connects runtime, loads capabilities, refreshes provider status, and refreshes the library.
- `src/features/` contains feature controllers and surfaces such as accounts, search, playback, library, likes, home, settings, updater, and wallpaper engine.
- `src/audio/` owns the playback audio runtime and `PlayerController`. `PlaybackAudioRuntime` is the only production owner of `MediaElementSource`, decks, gain, analyser, fade, output routing, and related timers.
- `src/stores/` holds Zustand state for playback, lyrics, providers, shelf, UI, search, and visuals.
- `src/visual/` and `packages/visual-engine/` consume readonly audio snapshots and opaque media URIs. They must not inspect transport URLs or own audio graphs.
- `packages/shared/` is the contract layer. Validate transport responses with its Zod schemas; do not duplicate DTO definitions locally.

## Desktop Shell Architecture

- `src/main.rs` starts `mineradio_tauri_lib::run()`; `src/lib.rs` initializes state, SQLite, cache/runtime settings, the in-process `mineradio_api::Api`, Tauri plugins, media protocols, windows, tray, and the command registry.
- `src/api_bridge.rs` maps the frontend `api_call` route contract onto the user-owned `mineradio_api` crate and returns `{ ok, data }` / `{ ok, error }` envelopes.
- `src/commands/` contains thin Tauri command adapters. Put policy and native work in the corresponding `src/runtime/` or `src/app/` module, not in the command file.
- Major native runtime groups include preferences/database, cache, diagnostics, hotkeys, windows/full desktop mode, desktop lyrics, updater, and Wallpaper Engine integration.
- `mineradio-tauri://` handles media URIs; `mineradio-wallpaper://` handles wallpaper media. Treat produced URIs as opaque in the frontend.
- `scripts/architecture/` encodes command lists, serialization contracts, transport boundaries, audio ownership rules, and desktop runtime expectations as executable checks. Some historical contract files can lag the active branch; inspect the current sources before treating a failing legacy assertion as a regression caused by your change.

## API Boundary Rules

- Treat `api/` as the user-owned source of truth. The desktop `api_bridge.rs` is a mapping layer, not a place to add provider behavior.
- Do not add a new provider capability, endpoint, DTO, QR-login flow, or error contract without an explicit request and user-verified upstream behavior.
- Do not guess provider endpoints, signatures, auth material, or response shapes. Ask for evidence or a user-tested sample.
- Keep frontend feature code behind ports. Do not let components call Tauri APIs or concrete transport clients directly.
- Keep capability-driven UI aligned with the declared capability matrix. Do not expose an action merely because a backend method exists.

## Development Commands

Use Bun 1.3.x from the repository root:

```bash
bun run dev          # Tauri development app
bun run web:build    # Typecheck and build the web frontend
bun run typecheck    # Typecheck shared packages and web app
bun run test         # Workspace frontend, architecture, CI, and performance tests
```

Rust/API-focused checks:

```bash
cargo test --manifest-path api/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Run the narrowest relevant test first. For architecture-sensitive changes, run the matching `scripts/architecture/*.test.ts` file before the full suite.

## Change Discipline

- Preserve the existing layered architecture. Prefer extending an existing port/adapter/runtime with the smallest focused change.
- Do not refactor unrelated modules, reformat unrelated files, delete pre-existing dead code, or “improve” neighboring behavior.
- Respect frozen contracts documented in `CONTEXT.md` and enforced under `scripts/architecture/`.
- For provider/API work, state the assumed upstream behavior and wait for user confirmation when it is uncertain.
- For UI work, keep DTO validation in `packages/shared`, state in stores, orchestration in feature hooks/controllers, and presentation in surfaces/components.
- For desktop work, keep command files thin and put lifecycle, policy, and platform interaction in runtime modules.

## Verification Checklist

- Run the relevant Bun test(s), typecheck, and Rust tests for touched crates.
- Run architecture tests when changing imports, transports, commands, audio ownership, media URLs, visual inputs, updater behavior, or desktop runtime behavior.
- Do not mark provider/API behavior complete without the user’s manual verification.
- Report anything intentionally left untouched, including known unrelated failures or formatting drift.
