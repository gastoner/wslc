# WSL Containers Extension

This Podman Desktop extension exposes Microsoft's WSL Containers (WSLC) runtime through a Docker-compatible container
provider on Windows.

## Prerequisites

Install or update WSL from an elevated PowerShell terminal:

```powershell
wsl --update
```

Open a new terminal and verify WSLC:

```powershell
wslc version
```

The extension is intended for Windows 10 and Windows 11. Windows Server 2025 has community validation; Windows Server
2022 is not currently supported. The required WSL package version is 2.9.3 or newer.

## Architecture

The extension launches the standalone `wslc-bridge.exe` for the host architecture. The bridge owns the Windows named
pipe `\\.\pipe\wslc_engine`; Podman Desktop registers that path directly as the `WSL Containers` Docker connection.
There is no TCP listener, extension-side socket server, Docker context, or Linux relay.

The Podman Desktop provider uses the raw Windows pipe path. For a Docker CLI client, the equivalent endpoint is
`npipe:////./pipe/wslc_engine` (for example, `$env:DOCKER_HOST = 'npipe:////./pipe/wslc_engine'`).

The bridge routes each Docker API call to one of WSLC's two planes:

- **`wslc.exe`.** Anything that needs WSLC policy, the Windows port relay, Windows binds, or WSLC lifecycle tracking:
  - containers: create, start, stop, restart, kill, remove, prune
  - images: pull, push, build, load, import, tag, remove, prune
  - networks and volumes: create, remove, prune, plus network connect/disconnect
- **The Docker daemon in the WSLC guest.** Reads and in-container operations:
  - lists and inspects, logs, stats, events
  - pause/unpause, export
  - attach and exec, including the interactive terminal tab

Container list and inspect responses overlay Windows host-port mappings from native WSLC list output. See the bridge
README for the full route table and WSL version gates.

## Bridge binaries and local builds

The bridge is built and released independently by
[`wslc-bridge`](https://github.com/gastoner/wslc-bridge); the extension never compiles Go.
`pnpm download-dependencies` fetches both pinned Windows executables from that repository's release and selects one at
runtime:

```text
dist/bin/win32-x64/wslc-bridge.exe   (Node x64)
dist/bin/win32-arm64/wslc-bridge.exe (Node ARM64)
```

`src/config/bridge-artifacts.ts` records the release (`BRIDGE_RELEASE`) and the per-architecture SHA-256 pins
(`BRIDGE_ARTIFACT_SHA256`). The staging script verifies the release manifest, both checksums, the pins, and each PE
machine type before writing either executable. It stages both artifacts transactionally; it does not download an
unpinned branch or use a TCP fallback.

Artifact sources are resolved in this order:

1. `WSLC_BRIDGE_ARTIFACT_DIR` — an explicit local directory.
2. `build/bridge-artifacts` — when it contains `bridge-manifest.json`.
3. `../wslc-bridge/dist` — only outside CI, for local development against a sibling checkout.
4. The pinned GitHub release — the hosted-build default (`CI=true` skips step 3).

`WSLC_BRIDGE_RELEASE_REPOSITORY` and `WSLC_BRIDGE_RELEASE_TAG` override the release recorded in source, and
`GITHUB_TOKEN` is forwarded when set.

For local extension development from PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm download-dependencies
pnpm build
```

The `Containerfile` runs the same download, so pre-staging is only needed when you want to build an image from locally
produced binaries:

```powershell
New-Item -ItemType Directory -Force build\bridge-artifacts | Out-Null
Copy-Item "..\wslc-bridge\dist\*" build\bridge-artifacts\
podman build -t wslc-local .
```

### Releasing a new bridge version

1. Run the `release` workflow in [`wslc-bridge`](https://github.com/gastoner/wslc-bridge) with the new version. It runs
   vet and tests, cross-builds both Windows executables, and attaches
   `wslc-bridge-windows-{amd64,arm64}.exe`, `checksums.txt`, and `bridge-manifest.json` to the release.
2. Copy both digests from that release's `checksums.txt` into `BRIDGE_ARTIFACT_SHA256` and update
   `BRIDGE_RELEASE.tag` in `src/config/bridge-artifacts.ts`.
3. Release the extension; the image build downloads and verifies the new bridge.

To build and diagnose the standalone executable directly, see the sibling bridge project's README. On Windows, the
extension starts it, waits for its JSON readiness record and named-pipe health check, polls it every 30 seconds, and
requests graceful shutdown by closing its stdin when the extension deactivates.

## Testing on Windows without a Docker CLI

After staging the bridge artifacts and building the extension, open Podman Desktop and enable **Settings → Preferences →
Extensions → Development mode**. In **Extensions → Local extensions**, add this extension folder. Podman Desktop will
start the bridge and register the `WSL Containers` provider; you do not need `docker.exe` or `podman.exe` to use the UI.

For API-level verification without either CLI, run the PowerShell smoke test from the sibling bridge checkout while the
extension is active:

```powershell
..\wslc-bridge\scripts\smoke-test.ps1
```

It connects directly to the named pipe and tests public image pull, create/start, Windows port relay and bind mount,
inspect/list overlays, logs, stats, exec exit codes, and network lifecycle.

## Limitations

Private-registry credentials, Compose, Docker-in-Docker, host Docker socket mounts, privileged mode, restart policies,
`host.docker.internal`, `--add-host`, and interactive exec are not supported. The bridge implements the selected Docker
API surface rather than every Engine API route; unsupported requests return an explicit error. ARM64 artifacts are
cross-built; validate them on ARM64 Windows hardware before claiming runtime support.

## Development checks

Prerequisites: Node.js 24 from [`.nvmrc`](.nvmrc) and the pinned pnpm version from [`package.json`](package.json).
Every workflow installs Node with `node-version-file: .nvmrc`, so bumping `.nvmrc` is enough for CI. The `Containerfile`
base image (`ubi10/nodejs-24`) and `package.json` `engines.node` are not derived from it and must be updated by hand in
the same change.

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:check
pnpm format:check
pnpm test
pnpm build
```

`pnpm format:fix` and `pnpm lint:fix` rewrite files in place. `pnpm watch` rebuilds on change.
