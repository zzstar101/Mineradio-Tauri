# MineRadio-Tauri

<p align="center">
  <img src="assets/icons/mine-radio-tauri.svg" width="128" height="128" alt="MineRadio-Tauri icon" />
</p>

MineRadio-Tauri is an immersive Windows desktop music player that combines weather radio, search and play functionality, a lyrics stage, particle visuals, and a 3D playlist rack to create a private, concert-like music experience.

The project is built on Tauri 2, with a layered architecture that separates frontend, desktop capabilities, local services, and shared types. It prioritizes a lightweight desktop experience, visual performance, playback stability, and local privacy.

## Core Features

- **Weather radio**: Curated listening experiences based on location, city, and weather conditions.
- **Multi-source search and play**: Supports NetEase Cloud Music and QQ Music integration.
- **Lyrics stage**: Real-time lyric synchronization, visual hierarchy, styling, and playback state interaction.
- **Immersive visuals**: Particle effects, Canvas/WebGL rendering, GSAP animations, and dynamic visual feedback during playback.
- **3D playlist rack**: A spatial interface for browsing, selecting, and managing playlists.
- **Desktop capabilities**: Window management, desktop lyrics, system integration, and optimized Windows experience.
- **Local service**: Sidecar processing for providers, music APIs, weather data, audio proxy, caching, and diagnostics.
- **Application updates**: Fixed GitHub Releases with a signed Rust Update Runtime for automatic updates.

## Technology Stack

- Tauri 2, Rust, WebView2
- Bun workspace
- Vite, TypeScript, React, Zustand
- Bun sidecar runtime
- Shared types, zod
- Canvas/WebGL/GSAP visual engine
- Rust Update Runtime + GitHub Releases + Minisign

## Local Development

### Prerequisites

- Windows 10/11
- Windows WebView2 Runtime
- Bun
- Rust (stable)
- Tauri 2 CLI

### Installation

```powershell
bun install
```

### Running Development Server

```powershell
bun run dev
```

### Building

```powershell
bun run build
```

### Common Checks

```powershell
bun run typecheck
bun test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

Note: Different workspaces or packages may have specific scripts. Refer to the scripts defined in the current module.

## Installing the Official Version

The official installation package is available exclusively from the [GitHub Releases](https://github.com/zzstar101/Mineradio-Tauri/releases) page of this repository. Windows may display a SmartScreen warning. Please verify that the download page and installation package originate from the official repository before proceeding. Do not disable Defender or SmartScreen to install this application.

## Project Structure

```text
MineRadio-Tauri/
├─ .github/
│  └─ ISSUE_TEMPLATE/   # Issue templates
├─ apps/
│  ├─ desktop/          # Tauri 2 desktop application
│  └─ web/              # Vite + React frontend
├─ assets/
│  └─ icons/            # Application icon source files
├─ packages/
│  ├─ shared/           # Shared types and zod schemas
│  └─ visual-engine/    # Canvas/WebGL/GSAP visual engine
├─ sidecars/
│  └─ api/              # Bun sidecar local service
└─ README.md
```

## Development Principles

- **React**: Manages UI state and user interactions, while the visual engine handles frame-by-frame rendering.
- **Rust/Tauri**: Controls window management, system capabilities, sidecar lifecycle, and updates.
- **Bun sidecar**: Handles providers, music APIs, weather data, audio proxy, caching, and diagnostics.
- **Shared package**: Manages cross-layer types, zod schemas, and API contracts.
- **Privacy**: User cookies, tokens, logs, and local privacy data must not be stored in the repository.

## Third-Party Music Platform Notice

MineRadio-Tauri is not an official client of NetEase Cloud Music, QQ Music, or Tencent Music Entertainment Group, nor is it affiliated with any music platform.

The integration of third-party platforms in this project is solely for personal learning, local client experience, and playback assistance for users' own accounts. Please comply with the terms of service, copyright rules, and membership benefits of the respective platforms. The project does not provide functionality to bypass payments, membership requirements, sound quality restrictions, or redistribute music content.

## User Data and Privacy

Login cookies, search history, custom covers, custom lyrics, rhythm analysis cache, and diagnostic logs should be stored locally within the application data directory or local storage.

Before submitting issues, pull requests, logs, or screenshots, ensure they do not contain cookies, tokens, account information, private links, local privacy paths, or personally identifiable information.

For more information, see [PRIVACY.md](./PRIVACY.md).

## Release and Operations

Before enabling or resuming official releases, repository administrators must complete the full department ban process outlined in the [Protected Release Process GitHub Administrator Runbook](./docs/release-runbook.md).

## Contributing

We welcome issues, pull requests, test feedback, and documentation improvements. Please read the [Contributing Guide](./CONTRIBUTING.md) before starting.

## Acknowledgments

MineRadio-Tauri was primarily designed and developed by XxHuberrr. Thanks to early testers, feedback providers, and friends who assisted with release preparations.

## Copyright and License

Copyright (C) 2026 XxHuberrr.

The original core code of this project is licensed under GPL-3.0-only. The Sonic Topography visual layer is based on documented source chains, maintainer-reviewed public collaboration evidence, and project decisions, and retains its separate `Non-Commercial Learning License` with personal non-commercial restrictions. This evidence does not constitute additional written authorization, sublicensing, or license relaxation. The complete source chain, applicable scope, and license text can be found in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The MineRadio-Tauri name, interface visual design, and original visual expressions are the property of the author. Third-party dependencies and services are governed by their respective licenses and service terms.
