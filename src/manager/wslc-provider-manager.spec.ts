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

import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '../inject/symbol';
import { WslVersionService } from './wsl-version-service';
import { WslcBridgeManager } from './wslc-bridge-manager';
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

let updateStatus: ReturnType<typeof vi.fn>;
let updateVersion: ReturnType<typeof vi.fn>;
let registerInstallationMock: ReturnType<typeof vi.fn>;
let registerUpdateMock: ReturnType<typeof vi.fn>;
let registerConnectionMock: ReturnType<typeof vi.fn>;
let installationDisposable: { dispose: ReturnType<typeof vi.fn> };
let updateDisposable: { dispose: ReturnType<typeof vi.fn> };
let connectionDisposable: { dispose: ReturnType<typeof vi.fn> };
let container: Container;
let manager: WslcProviderManager;
let wslcProvider: Provider;
let bridgeReady: boolean;
let bridgeManager: WslcBridgeManager;
let unexpectedExit: ((error: Error) => void) | undefined;

function createRunError(message: string): Error {
  return Object.assign(new Error(message), {
    exitCode: 1,
    command: 'wslc.exe version',
    stdout: '',
    stderr: message,
    cancelled: false,
    killed: false,
  });
}

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
  extensionContext.subscriptions.length = 0;

  updateStatus = vi.fn();
  updateVersion = vi.fn();
  bridgeReady = false;
  unexpectedExit = undefined;
  bridgeManager = {
    isReady: vi.fn(() => bridgeReady),
    start: vi.fn(async (_signal: AbortSignal, onUnexpectedExit: (error: Error) => void) => {
      unexpectedExit = onUnexpectedExit;
      bridgeReady = true;
    }),
    ping: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      bridgeReady = false;
    }),
  } as unknown as WslcBridgeManager;

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

  execMock.mockImplementation(async (command, args) => {
    if (command === 'wsl' && args?.[0] === '--version') {
      return { command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' } as RunResult;
    }
    return { command: 'wslc.exe version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult;
  });

  container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
  container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
  container.bind(WslcBridgeManager).toConstantValue(bridgeManager);
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

  test('registers a ready Docker connection directly on the Windows named pipe', async () => {
    const connection = await startProviderAndWaitForConnection();

    expect(connection.name).toBe('WSL Containers');
    expect(connection.type).toBe('docker');
    expect(connection.endpoint).toEqual({ socketPath: bridgeConfiguration.pipeName });
    expect(connection.status()).toBe('started');
    expect(bridgeManager.start).toHaveBeenCalledOnce();
    expect(bridgeManager.start).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function));
    expect(bridgeManager.ping).toHaveBeenCalledOnce();
    expect(bridgeManager.isReady).toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith('ready');
  });

  test('waits for bridge health ping before registering its connection', async () => {
    let resolvePing!: () => void;
    vi.mocked(bridgeManager.ping).mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePing = resolve;
      }),
    );

    await manager.registerContainerProvider();
    await waitForExecCalls(3);
    await vi.waitFor(() => expect(bridgeManager.ping).toHaveBeenCalledOnce());
    expect(registerConnectionMock).not.toHaveBeenCalled();

    resolvePing();
    await vi.waitFor(() => expect(registerConnectionMock).toHaveBeenCalledOnce());
  });

  test('does not register a connection when the bridge does not become ready', async () => {
    vi.mocked(bridgeManager.start).mockImplementation(async () => {
      bridgeReady = false;
    });

    await manager.registerContainerProvider();
    await waitForExecCalls(3);
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('error'));

    expect(bridgeManager.ping).not.toHaveBeenCalled();
    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  test('marks WSLC not installed only when the executable is missing', async () => {
    execMock.mockRejectedValueOnce(createRunError('spawn wslc.exe ENOENT'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());

    expect(updateStatus).toHaveBeenCalledWith('not-installed');
    expect(updateVersion).toHaveBeenCalledOnce();
    expect(execMock).toHaveBeenCalledOnce();
    expect(bridgeManager.start).not.toHaveBeenCalled();
    expect(registerInstallationMock.mock.calls[0]?.[0]).toHaveProperty('install');
  });

  test('runs wsl --update from the installation action and refreshes provider status', async () => {
    execMock.mockRejectedValueOnce(createRunError('wslc.exe was not found'));

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

  test('sets provider error for an arbitrary WSLC command failure without registering installation', async () => {
    execMock.mockRejectedValueOnce(createRunError('wslc.exe version exited with code 1: access denied'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('error'));

    expect(registerInstallationMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith('not-installed');
    expect(bridgeManager.stop).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Error checking WSL Containers version', expect.any(Error));
  });

  test('sets provider error for empty or malformed successful version output', async () => {
    execMock.mockResolvedValueOnce({ command: 'wslc.exe version', stdout: 'not a version', stderr: '' } as RunResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('error'));

    expect(registerInstallationMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith('not-installed');
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('leaves Install registered when the WSL update command fails', async () => {
    execMock.mockRejectedValueOnce(createRunError('wslc not found')).mockRejectedValueOnce(new Error('update failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(registerInstallationMock).toHaveBeenCalledOnce());
    const installation = registerInstallationMock.mock.calls[0]?.[0] as ProviderInstallation;

    await expect(installation.install({ log: vi.fn() } as unknown as Logger)).rejects.toThrow('update failed');

    expect(updateStatus).toHaveBeenCalledWith('not-installed');
    expect(registerInstallationMock).toHaveBeenCalledOnce();
    expect(bridgeManager.start).not.toHaveBeenCalled();
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
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('runs wsl --update from the update action and refreshes provider status', async () => {
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
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('marks runtime stopped when the documented container-list probe fails', async () => {
    execMock
      .mockResolvedValueOnce({ command: 'wslc version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' } as RunResult)
      .mockRejectedValueOnce(new Error('runtime stopped'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalledWith('stopped'));

    expect(bridgeManager.start).not.toHaveBeenCalled();
    expect(registerConnectionMock).not.toHaveBeenCalled();
  });

  test('refreshes bridge health without registering a duplicate connection', async () => {
    await startProviderAndWaitForConnection();

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(bridgeManager.ping).toHaveBeenCalledTimes(2);
    expect(registerConnectionMock).toHaveBeenCalledOnce();
    expect(createServer).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });

  test('cleans up the registered connection after an unexpected bridge exit', async () => {
    await startProviderAndWaitForConnection();

    unexpectedExit?.(new Error('bridge exited'));
    await vi.waitFor(() => expect(connectionDisposable.dispose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(telemetryLogger.logUsage).toHaveBeenCalledWith('bridgeExited'));

    expect(bridgeManager.stop).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith('installed');
    expect(extensionContext.subscriptions).not.toContain(connectionDisposable);
  });

  test('does not overlap concurrent refreshes', async () => {
    await startProviderAndWaitForConnection();

    let resolveVersion!: (result: RunResult) => void;
    execMock.mockReturnValueOnce(
      new Promise<RunResult>((resolve) => {
        resolveVersion = resolve;
      }),
    );
    const firstRefresh = manager.refresh();
    await waitForExecCalls(4);
    const overlappingRefresh = manager.refresh();
    expect(execMock).toHaveBeenCalledTimes(4);

    resolveVersion({ command: 'wslc.exe version', stdout: 'wslc 0.1.0', stderr: '' } as RunResult);
    await Promise.all([firstRefresh, overlappingRefresh]);
    expect(execMock).toHaveBeenCalledTimes(6);
  });

  test('polls again after thirty seconds', async () => {
    await startProviderAndWaitForConnection();
    for (let flush = 0; flush < 10; flush += 1) {
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);
    await waitForExecCalls(6);
  });

  test('bounds consecutive bridge startup retries', async () => {
    vi.mocked(bridgeManager.start).mockRejectedValue(new Error('bridge startup failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(bridgeManager.start).toHaveBeenCalledTimes(1));
    for (let attempt = 2; attempt <= bridgeConfiguration.maxConsecutiveStartupFailures; attempt += 1) {
      await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);
      await vi.waitFor(() => expect(bridgeManager.start).toHaveBeenCalledTimes(attempt));
    }
    await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);

    expect(bridgeManager.start).toHaveBeenCalledTimes(bridgeConfiguration.maxConsecutiveStartupFailures);
    expect(updateStatus).toHaveBeenCalledWith('error');
  });

  test('stops only the bridge manager and disposes provider connection on deactivation', async () => {
    await startProviderAndWaitForConnection();

    await manager.deactivate();

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(bridgeManager.stop).toHaveBeenCalledOnce();
    expect(createServer).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });
});
