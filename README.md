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

The extension creates the Windows named pipe `\\.\pipe\wslc_engine` and forwards its client streams to Socktainer at
`localhost:2375`. Socktainer is used as it exists in the bare `wslc-proxy` repository: it forwards Docker API streams to
the guest Docker daemon by running `wslc system session run /tmp/docker-relay`.

The extension only manages the proxy process and adapts Podman Desktop's named-pipe connection to Socktainer's TCP
listener. Docker API requests are forwarded transparently to the guest daemon; the proxy does not translate container
create/start or network-create requests into WSLC CLI commands, and it does not overlay native WSLC port data into
inspect responses. The separate `wslc` CLI remains available in PowerShell.

## Proxy artifacts

For development, the extension consumes externally built `socktainer.exe` and `docker-relay` files from a local
directory. Production packaging consumes a versioned ZIP containing those binaries and `manifest.json`, verified by
SHA-256. The supported pair is Windows/amd64 plus Linux/amd64.

For local development, build the two binaries from the unmodified `wslc-proxy` source into a temporary directory. Run
these commands in PowerShell from the extension repository:

```powershell
$proxyBin = "$env:TEMP\wslc-proxy-bin"
New-Item -ItemType Directory -Force $proxyBin | Out-Null
Push-Location ..\wslc-proxy
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go build -o "$proxyBin\socktainer.exe" ./cmd/socktainer
$env:GOOS = 'linux'
go build -o "$proxyBin\docker-relay" ./cmd/relay
Pop-Location
$env:WSLC_PROXY_BIN_DIR = $proxyBin
pnpm download-dependencies
```

This only builds the existing proxy source; the extension downloader verifies the binaries are PE Windows/amd64 and ELF
Linux/amd64 before copying them into `dist/bin/win32-x64/`. The extension repository does not compile or alter
`wslc-proxy`.

To build a local OCI image, stage those externally built binaries in the context and set the build argument:

```powershell
New-Item -ItemType Directory -Force build\proxy-binaries | Out-Null
Copy-Item "$proxyBin\*" build\proxy-binaries\
podman build -f build/Containerfile -t wslc-local `
  --build-arg WSLC_PROXY_BIN_DIR=build/proxy-binaries .
```

For production packaging, `pnpm download-dependencies` requires a published proxy release version and its SHA-256. The
bare `wslc-proxy` repository currently has no such release asset; the manual `next-build` workflow requires those values
and does not build from a moving proxy source branch.

## Limitations

Because Docker API writes go directly to the guest engine, this integration does not provide the WSLC-native Windows
port-relay and host-bind behavior requested by issue #1113. Compose, Docker-in-Docker, privileged containers, host socket
mounting, interactive attach/exec, `host.docker.internal`, and `--add-host` are also not provided by this integration.

## Development checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:check
pnpm format:check
pnpm test
pnpm build
```
