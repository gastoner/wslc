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

The bridge serves Docker API reads from the Docker daemon in the WSLC guest. The read plane includes `/_ping`, `/version`,
`/containers/json`, container inspect, logs, stats, `/images/json`, and image inspect. Container list and inspect responses
overlay Windows host-port mappings from native WSLC list output. Container create/start/stop/remove, image pull,
network create/remove, and non-interactive exec use `wslc.exe` so Windows port relay and host binds are applied.

## Bridge binaries and local builds

The bridge is built independently in the sibling `wslc-bridge` project. The extension never
compiles Go. It packages both pinned Windows executables and selects one at runtime:

```text
dist/bin/win32-x64/wslc-bridge.exe   (Node x64)
dist/bin/win32-arm64/wslc-bridge.exe (Node ARM64)
```

The bridge manifest and SHA-256 checksum file pin the exact binary bytes. The extension staging script verifies the
manifest, both checksums, and each PE machine type before writing either executable. It stages both artifacts
transactionally; it does not download an unpinned branch or use a TCP fallback.

For local extension development from PowerShell:

```powershell
$env:WSLC_BRIDGE_ARTIFACT_DIR = (Resolve-Path ..\wslc-bridge\dist).Path
pnpm install --frozen-lockfile
pnpm download-dependencies
pnpm build
```

For a local OCI build, place the four bridge `dist` files in the container context, then build:

```powershell
New-Item -ItemType Directory -Force build\bridge-artifacts | Out-Null
Copy-Item "$env:WSLC_BRIDGE_ARTIFACT_DIR\*" build\bridge-artifacts\
podman build -f build/Containerfile -t wslc-local .
```

The manual `build-next` workflow accepts a base URL for a hosted bridge artifact directory and downloads only the four
named files before the same manifest/hash/PE validation. No published bridge release URL is assumed; the artifacts must
be staged or hosted before running that workflow.

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

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:check
pnpm format:check
pnpm test
pnpm build
```
