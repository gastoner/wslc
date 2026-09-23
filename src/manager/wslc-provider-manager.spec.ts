/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type {
  ContainerProviderConnection,
  ExtensionContext,
  Logger,
  Provider,
  ProviderInstallation,
  ProviderUpdate,
  RunResult,
  TelemetryLogger,
} from '@podman-desktop/api';
import { process as podmanProcess, provider } from '@podman-desktop/api';
import { Container } from 'inversify';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '../inject/symbol';
import { WslVersionService } from './wsl-version-service';
import { WslcProviderManager } from './wslc-provider-manager';

const spawnMock = vi.hoisted(() => vi.fn());
const createServerMock = vi.hoisted(() => vi.fn());
vi.mock(import('node:child_process'), () => ({ spawn: spawnMock }));
vi.mock(import('node:net'), () => ({ createServer: createServerMock }));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = {
  logError: vi.fn(),
  logUsage: vi.fn(),
} as unknown as TelemetryLogger;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleTrace = console.trace;
const originalConsoleLog = console.log;

let updateStatus: ReturnType<typeof vi.fn>;
let updateVersion: ReturnType<typeof vi.fn>;
let registerInstallationMock: ReturnType<typeof vi.fn>;
let registerUpdateMock: ReturnType<typeof vi.fn>;
let registerConnectionMock: ReturnType<typeof vi.fn>;
let bridgeServer: EventEmitter & {
  listening: boolean;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let bridgeChild: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: EventEmitter;
  exitCode: number | undefined;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};
let bridgeClientHandler: ((socket: Socket) => void) | undefined;
let container: Container;
let manager: WslcProviderManager;
let wslcProvider: Provider;

async function waitForExecCalls(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(podmanProcess.exec).toHaveBeenCalledTimes(count);
  });
}

async function startProviderAndWaitForConnection(): Promise<ContainerProviderConnection> {
  await manager.registerContainerProvider();
  await waitForExecCalls(3);
  await vi.waitFor(() => {
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });
  return registerConnectionMock.mock.calls[0]?.[0] as ContainerProviderConnection;
}

describe('WslcProviderManager', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    console.error = vi.fn();
    console.warn = vi.fn();
    console.trace = vi.fn();
    console.log = vi.fn();
    extensionContext.subscriptions.length = 0;

    updateStatus = vi.fn();
    updateVersion = vi.fn();
    registerInstallationMock = vi.fn(() => ({ dispose: vi.fn() }));
    registerUpdateMock = vi.fn(() => ({ dispose: vi.fn() }));
    registerConnectionMock = vi.fn(() => ({ dispose: vi.fn() }));
    wslcProvider = {
      updateStatus,
      updateVersion,
      registerInstallation: registerInstallationMock,
      registerUpdate: registerUpdateMock,
      registerContainerProviderConnection: registerConnectionMock,
      dispose: vi.fn(),
    } as unknown as Provider;
    vi.mocked(provider.createProvider).mockReturnValue(wslcProvider);

    bridgeServer = new EventEmitter() as EventEmitter & {
      listening: boolean;
      listen: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    bridgeServer.listening = false;
    bridgeServer.listen = vi.fn(() => {
      bridgeServer.listening = true;
      queueMicrotask(() => bridgeServer.emit('listening'));
    });
    bridgeServer.close = vi.fn((callback: () => void) => {
      bridgeServer.listening = false;
      callback();
    });
    bridgeClientHandler = undefined;
    createServerMock.mockImplementation((connectionListener: (socket: Socket) => void) => {
      bridgeClientHandler = connectionListener;
      return bridgeServer;
    });

    bridgeChild = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: EventEmitter;
      exitCode: number | undefined;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    bridgeChild.stdin = new PassThrough();
    bridgeChild.stdout = new PassThrough();
    bridgeChild.stderr = new EventEmitter();
    bridgeChild.exitCode = undefined;
    bridgeChild.killed = false;
    bridgeChild.kill = vi.fn(() => {
      bridgeChild.killed = true;
    });
    spawnMock.mockReturnValue(bridgeChild);

    vi.mocked(podmanProcess.exec).mockResolvedValue({
      command: 'wslc.exe version',
      stdout: 'WSL version: 2.9.3.0',
      stderr: '',
    } as RunResult);

    container = new Container();
    container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
    container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
    container.bind(WslVersionService).toSelf();
    container.bind(WslcProviderManager).toSelf();
    manager = container.get(WslcProviderManager);
  });

  afterEach(async () => {
    await manager.deactivate();
    await container.unbindAll();
    vi.clearAllTimers();
    vi.useRealTimers();
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.trace = originalConsoleTrace;
    console.log = originalConsoleLog;
  });

  it('creates the provider with icon metadata and registers its named-pipe connection', async () => {
    const connection = await startProviderAndWaitForConnection();

    expect(provider.createProvider).toHaveBeenCalledWith({
      name: 'WSL Containers',
      id: 'wslc',
      status: 'unknown',
      images: { icon: './icon.png', logo: './icon.png' },
    });
    expect(podmanProcess.exec).toHaveBeenNthCalledWith(1, 'wslc.exe', ['version']);
    expect(podmanProcess.exec).toHaveBeenNthCalledWith(2, 'wsl', ['--version'], { encoding: 'utf16le' });
    expect(podmanProcess.exec).toHaveBeenNthCalledWith(3, 'wslc.exe', ['container', 'list']);
    expect(createServerMock).toHaveBeenCalledOnce();
    expect(bridgeServer.listen).toHaveBeenCalledWith(String.raw`\\.\pipe\wslc_engine`);
    expect(connection.type).toBe('docker');
    expect(connection.endpoint).toEqual({ socketPath: String.raw`\\.\pipe\wslc_engine` });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('proxies named-pipe client traffic through the WSLC dial-stdio process', async () => {
    await startProviderAndWaitForConnection();
    const request = Buffer.from('GET /v1.45/images/json HTTP/1.1\r\nHost: localhost\r\n\r\n');
    const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]');
    const responseChunks: Buffer[] = [];
    const socket = new Duplex({
      read: () => {},
      write: (chunk: Buffer, _encoding, callback) => {
        responseChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const forwardedRequest = new Promise<Buffer>((resolveRequest) => {
      bridgeChild.stdin.once('data', (data: Buffer) => resolveRequest(data));
    });
    const forwardedResponse = new Promise<Buffer>((resolveResponse) => {
      socket.once('finish', () => resolveResponse(Buffer.concat(responseChunks)));
    });

    bridgeClientHandler?.(socket as unknown as Socket);
    socket.push(request);

    expect(spawnMock).toHaveBeenCalledWith('wslc.exe', ['system', 'session', 'run', 'docker', 'system', 'dial-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(await forwardedRequest).toEqual(request);

    bridgeChild.stdout.end(response);
    expect(await forwardedResponse).toEqual(response);

    socket.destroy();
    await vi.waitFor(() => expect(bridgeChild.kill).toHaveBeenCalledOnce());
  });

  it('marks the provider not installed and registers Install when wslc.exe is missing', async () => {
    vi.mocked(podmanProcess.exec).mockRejectedValueOnce(new Error('not found'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());

    expect(updateStatus).toHaveBeenCalledWith('not-installed');
    expect(podmanProcess.exec).toHaveBeenCalledOnce();
    expect(createServerMock).not.toHaveBeenCalled();

    const installation = registerInstallationMock.mock.calls[0]?.[0] as ProviderInstallation;
    const installationDisposable = registerInstallationMock.mock.results[0]?.value as {
      dispose: ReturnType<typeof vi.fn>;
    };
    const installPromise = installation.install({ log: vi.fn() } as unknown as Logger);
    await waitForExecCalls(5);
    await installPromise;

    expect(podmanProcess.exec).toHaveBeenCalledWith('wsl', ['--update', '--pre-release'], { encoding: 'utf16le' });
    expect(installationDisposable.dispose).toHaveBeenCalledOnce();
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });

  it('leaves Install registered when the WSL update command fails', async () => {
    vi.mocked(podmanProcess.exec)
      .mockRejectedValueOnce(new Error('wslc not found'))
      .mockRejectedValueOnce(new Error('update failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());
    const installation = registerInstallationMock.mock.calls[0]?.[0] as ProviderInstallation;

    await expect(installation.install({ log: vi.fn() } as unknown as Logger)).rejects.toThrow('update failed');

    expect(updateStatus).toHaveBeenCalledWith('not-installed');
    expect(registerInstallationMock).toHaveBeenCalledOnce();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('keeps WSLC installed and registers an update for an older WSL version', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.2.0', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerUpdateMock).toHaveBeenCalledOnce());

    const update = registerUpdateMock.mock.calls[0]?.[0] as ProviderUpdate;
    expect(update.version).toBe('2.9.3');
    expect(updateStatus).toHaveBeenCalledWith('installed');
    expect(registerInstallationMock).not.toHaveBeenCalled();
    expect(podmanProcess.exec).toHaveBeenCalledTimes(2);
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('updates WSL and refreshes provider status', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.2.0', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerUpdateMock).toHaveBeenCalledOnce());
    const update = registerUpdateMock.mock.calls[0]?.[0] as ProviderUpdate;
    const updatePromise = update.update({ log: vi.fn() } as unknown as Logger);
    await waitForExecCalls(6);
    await updatePromise;

    expect(podmanProcess.exec).toHaveBeenCalledWith('wsl', ['--update', '--pre-release'], { encoding: 'utf16le' });
    expect(podmanProcess.exec).toHaveBeenCalledWith('wslc.exe', ['container', 'list']);
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });

  it('does not start a bridge when WSL version output cannot be parsed', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'unrecognized output', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(podmanProcess.exec).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('installed'));

    expect(registerUpdateMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it('marks runtime stopped when the documented container-list probe fails', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' } as RunResult)
      .mockRejectedValueOnce(new Error('runtime stopped'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('stopped'));

    expect(createServerMock).not.toHaveBeenCalled();
    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  it('does not create another named pipe or connection after a monitoring refresh', async () => {
    await startProviderAndWaitForConnection();

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(createServerMock).toHaveBeenCalledOnce();
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });

  it('does not register a connection if the named pipe fails to listen', async () => {
    bridgeServer.listen = vi.fn(() => {
      queueMicrotask(() => bridgeServer.emit('error', new Error('pipe unavailable')));
    });

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('error'));

    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  it('closes the named pipe and kills active dial-stdio children on deactivation', async () => {
    await startProviderAndWaitForConnection();
    const connectionDisposable = registerConnectionMock.mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> };
    const socket = new PassThrough();
    bridgeClientHandler?.(socket as unknown as Socket);

    await manager.deactivate();

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    expect(bridgeChild.kill).toHaveBeenCalledOnce();
    expect(bridgeServer.close).toHaveBeenCalledOnce();
  });
});
