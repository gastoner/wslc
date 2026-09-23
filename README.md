# WSL Containers Extension

This Podman Desktop extension provides a Windows container provider for Microsoft's WSL Containers (WSLC) runtime.

WSLC is currently a public preview and requires a recent WSL prerelease. Install or update it from an elevated
PowerShell terminal:

```powershell
wsl --update --pre-release
```

Open a new terminal after the update and verify the runtime:

```powershell
wslc version
```

The extension is intended for Windows 10 and Windows 11. Windows Server 2025 has community validation; Windows
Server 2022 is not currently supported.

The extension checks `wslc.exe version`, then checks the WSL package version. If `wslc.exe` is unavailable, the provider
is marked not installed and exposes Podman Desktop's Install action, which runs `wsl --update --pre-release` and
refreshes provider detection. If WSLC is installed but WSL is older than `2.9.3`, the provider remains installed, does
not start the bridge, and exposes an Update action that runs the same command. If the WSL version cannot be detected,
the provider remains installed without registering a connection or update action.

After the version check passes, the extension runs `wslc.exe container list` to verify the runtime before starting the
named-pipe endpoint. This documented command can initialize a WSLC session. The extension listens on
`\\.\pipe\wslc_engine` and starts `wslc.exe system session run docker system dial-stdio` for each Docker API client.

## Architecture

WSLC's Docker daemon runs inside the WSL guest and is not exposed directly to the Windows host. The extension provides a
Windows named pipe and forwards each Docker API stream through `wslc.exe system session run docker system dial-stdio`.
This allows Podman Desktop to use the WSLC Docker API without a separately packaged bridge executable.

## Limitations

Version 1 does not support Compose, Docker-in-Docker, mounting the host Docker socket, privileged containers, restart
policies, `host.docker.internal`, `--add-host`, or interactive exec.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```
