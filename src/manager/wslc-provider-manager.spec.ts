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
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '../inject/symbol';
import { WslcProxyManager } from './wslc-proxy-manager';
import { WslVersionService } from './wsl-version-service';
import { WslcProviderManager } from './wslc-provider-manager';

vi.mock(import('node:net'));
vi.mock(import('node:http'));

const createProviderMock = vi.mocked(provider.createProvider);
const execMock = vi.mocked(podmanProcess.exec);

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
let installationDisposable: { dispose: ReturnType<typeof vi.fn> };
let updateDisposable: { dispose: ReturnType<typeof vi.fn> };
let connectionDisposable: { dispose: ReturnType<typeof vi.fn> };
let bridgeServer: EventEmitter & {
  listening: boolean;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let proxySocket: Duplex;
let proxyWrittenChunks: Buffer[];
let bridgeClientHandler: ((socket: Socket) => void) | undefined;
let container: Container;
let manager: WslcProviderManager;
let wslcProvider: Provider;
let proxyReady: boolean;
let proxyManager: WslcProxyManager;

async function waitForExecCalls(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(execMock).toHaveBeenCalledTimes(count);
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
  proxyReady = false;
  proxyManager = {
    isReady: vi.fn(() => proxyReady),
    start: vi.fn(async () => {
      proxyReady = true;
    }),
    stop: vi.fn(async () => {
      proxyReady = false;
    }),
  } as unknown as WslcProxyManager;
  installationDisposable = { dispose: vi.fn() };
  updateDisposable = { dispose: vi.fn() };
  connectionDisposable = { dispose: vi.fn() };
  registerInstallationMock = vi.fn().mockReturnValue(installationDisposable);
  registerUpdateMock = vi.fn().mockReturnValue(updateDisposable);
  registerConnectionMock = vi.fn().mockReturnValue(connectionDisposable);
  wslcProvider = {
    updateStatus,
    updateVersion,
    registerInstallation: registerInstallationMock,
    registerUpdate: registerUpdateMock,
    registerContainerProviderConnection: registerConnectionMock,
    dispose: vi.fn(),
  } as unknown as Provider;
  createProviderMock.mockReturnValue(wslcProvider);

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
  vi.mocked(createServer).mockImplementation((options, connectionListener) => {
    bridgeClientHandler = (options as unknown as ((socket: Socket) => void) | undefined) ?? connectionListener;
    return bridgeServer as never;
  });

  proxyWrittenChunks = [];
  proxySocket = new Duplex({
    read: () => {},
    write: (chunk, _encoding, callback) => {
      proxyWrittenChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  vi.mocked(createConnection).mockReturnValue(proxySocket as never);
  vi.mocked(request).mockImplementation((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.setTimeout = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        setEncoding: ReturnType<typeof vi.fn>;
      };
      response.statusCode = 200;
      response.setEncoding = vi.fn();
      const responseCallback = callback as unknown as ((response: EventEmitter) => void) | undefined;
      responseCallback?.(response);
      queueMicrotask(() => {
        response.emit('data', 'OK');
        response.emit('end');
      });
    });
    return request as never;
  });

  execMock.mockResolvedValue({
    command: 'wslc.exe version',
    stdout: 'WSL version: 2.9.3.0',
    stderr: '',
  } as RunResult);

  container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
  container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
  container.bind(WslcProxyManager).toConstantValue(proxyManager);
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

describe('WslcProviderManager', () => {
  test('creates the provider with the expected icon metadata', async () => {
    await startProviderAndWaitForConnection();
    expect(createProviderMock).toHaveBeenCalledWith({
      name: 'WSL Containers',
      id: 'wslc',
      status: 'unknown',
      images: { icon: './icon.png', logo: './icon.png' },
    });
  });

  test('probes WSLC, the WSL version, and runtime containers during startup', async () => {
    await startProviderAndWaitForConnection();

    expect(execMock).toHaveBeenNthCalledWith(1, 'wslc.exe', ['version']);
    expect(execMock).toHaveBeenNthCalledWith(2, 'wsl', ['--version'], { encoding: 'utf16le' });
    expect(execMock).toHaveBeenNthCalledWith(3, 'wslc.exe', ['container', 'list']);
  });

  test('registers a ready Docker connection on the WSLC named pipe', async () => {
    const connection = await startProviderAndWaitForConnection();

    expect(createServer).toHaveBeenCalledOnce();
    expect(bridgeServer.listen).toHaveBeenCalledWith(String.raw`\\.\pipe\wslc_engine`);
    expect(connection.type).toBe('docker');
    expect(connection.endpoint).toEqual({ socketPath: String.raw`\\.\pipe\wslc_engine` });
    expect(proxyManager.start).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      { socketPath: String.raw`\\.\pipe\wslc_engine`, path: '/_ping', method: 'GET' },
      expect.any(Function),
    );
    expect(updateStatus).toHaveBeenCalledWith('ready');
  });

  test('proxies named-pipe client traffic through the Socktainer TCP endpoint', async () => {
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
    const forwardedResponse = new Promise<Buffer>((resolveResponse) => {
      socket.once('finish', () => resolveResponse(Buffer.concat(responseChunks)));
    });

    bridgeClientHandler?.(socket as unknown as Socket);
    socket.push(request);

    expect(createConnection).toHaveBeenCalledWith({ host: 'localhost', port: 2375 });
    await vi.waitFor(() => expect(Buffer.concat(proxyWrittenChunks)).toEqual(request));

    proxySocket.push(response);
    proxySocket.push(null);
    expect(await forwardedResponse).toEqual(response);

    socket.destroy();
  });

  describe('when wslc.exe is missing', () => {
    beforeEach(() => {
      execMock.mockRejectedValueOnce(new Error('not found'));
    });

    test('marks the provider not installed and registers an installation action', async () => {
      await manager.registerContainerProvider();
      await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());

      expect(updateStatus).toHaveBeenCalledWith('not-installed');
      expect(execMock).toHaveBeenCalledOnce();
      expect(createServer).not.toHaveBeenCalled();
      expect(registerInstallationMock.mock.calls[0]?.[0]).toHaveProperty('install');
    });

    test('installs WSL and refreshes the provider after the installation action runs', async () => {
      await manager.registerContainerProvider();
      await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());

      const installation = registerInstallationMock.mock.calls[0]?.[0] as ProviderInstallation;
      const installPromise = installation.install({ log: vi.fn() } as unknown as Logger);
      await waitForExecCalls(5);
      await installPromise;

      expect(execMock).toHaveBeenCalledWith('wsl', ['--update'], { encoding: 'utf16le' });
      expect(installationDisposable.dispose).toHaveBeenCalledOnce();
      expect(registerConnectionMock).toHaveBeenCalledOnce();
    });
  });

  test('leaves Install registered when the WSL update command fails', async () => {
    execMock.mockRejectedValueOnce(new Error('wslc not found')).mockRejectedValueOnce(new Error('update failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());
    const installation = registerInstallationMock.mock.calls[0]?.[0] as ProviderInstallation;

    await expect(installation.install({ log: vi.fn() } as unknown as Logger)).rejects.toThrow('update failed');

    expect(updateStatus).toHaveBeenCalledWith('not-installed');
    expect(registerInstallationMock).toHaveBeenCalledOnce();
    expect(createServer).not.toHaveBeenCalled();
  });

  test('keeps WSLC installed and registers an update for an older WSL version', async () => {
    execMock
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.2.0', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerUpdateMock).toHaveBeenCalledOnce());

    const update = registerUpdateMock.mock.calls[0]?.[0] as ProviderUpdate;
    expect(update.version).toBe('2.9.3');
    expect(updateStatus).toHaveBeenCalledWith('installed');
    expect(registerInstallationMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(createServer).not.toHaveBeenCalled();
  });

  test('updates WSL and refreshes provider status', async () => {
    execMock
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.2.0', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerUpdateMock).toHaveBeenCalledOnce());
    const update = registerUpdateMock.mock.calls[0]?.[0] as ProviderUpdate;
    const updatePromise = update.update({ log: vi.fn() } as unknown as Logger);
    await waitForExecCalls(6);
    await updatePromise;

    expect(execMock).toHaveBeenCalledWith('wsl', ['--update'], { encoding: 'utf16le' });
    expect(execMock).toHaveBeenCalledWith('wslc.exe', ['container', 'list']);
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });

  test('does not start a bridge when WSL version output cannot be parsed', async () => {
    execMock
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'unrecognized output', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(execMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('installed'));

    expect(registerUpdateMock).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  test('marks runtime stopped when the documented container-list probe fails', async () => {
    execMock
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' } as RunResult)
      .mockRejectedValueOnce(new Error('runtime stopped'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('stopped'));

    expect(createServer).not.toHaveBeenCalled();
    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  test('does not create another named pipe or connection after a monitoring refresh', async () => {
    await startProviderAndWaitForConnection();

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(createServer).toHaveBeenCalledOnce();
    expect(registerConnectionMock).toHaveBeenCalledOnce();
  });

  test('does not register a connection if the named pipe fails to listen', async () => {
    bridgeServer.listen = vi.fn(() => {
      queueMicrotask(() => bridgeServer.emit('error', new Error('pipe unavailable')));
    });

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('error'));

    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  test('closes the named pipe, TCP clients, and Socktainer process on deactivation', async () => {
    await startProviderAndWaitForConnection();
    const socket = new PassThrough();
    bridgeClientHandler?.(socket as unknown as Socket);

    await manager.deactivate();

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBeTruthy();
    expect(proxySocket.destroyed).toBeTruthy();
    expect(proxyManager.stop).toHaveBeenCalledOnce();
    expect(bridgeServer.close).toHaveBeenCalledOnce();
  });
});
