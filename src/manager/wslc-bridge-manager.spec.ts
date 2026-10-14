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

import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { arch } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExtensionContext } from '@podman-desktop/api';
import { Container } from 'inversify';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol } from '../inject/symbol';
import { resolveBridgeExecutable, WslcBridgeManager } from './wslc-bridge-manager';

vi.mock(import('node:fs/promises'));
vi.mock(import('node:child_process'));
vi.mock(import('node:http'));
vi.mock(import('node:os'));

interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

let manager: WslcBridgeManager;
let child: MockChild;
let unexpectedExit: (error: Error) => void;

function createSuccessfulHttpRequest(): void {
  vi.mocked(request).mockImplementation((_options, callback) => {
    const httpRequest = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    httpRequest.destroy = vi.fn((error?: Error) => {
      if (error) {
        queueMicrotask(() => httpRequest.emit('error', error));
      }
      return httpRequest;
    });
    httpRequest.end = vi.fn(() => {
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
      return httpRequest;
    });
    return httpRequest as never;
  });
}

function readinessRecord(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    event: 'ready',
    protocolVersion: 1,
    bridgeVersion: 'test-bridge-version',
    pipe: bridgeConfiguration.pipeName,
    guestApiVersion: '1.0.0',
    ...overrides,
  })}\r\n`;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(arch).mockReturnValue('x64');
  vi.mocked(access).mockResolvedValue(undefined);
  createSuccessfulHttpRequest();

  child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 1;
    child.emit('close', 1, null);
    return true;
  });
  child.stdin.once('finish', () => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    });
  });
  vi.mocked(spawn).mockReturnValue(child as never);

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue({
    extensionUri: { fsPath: '/extension' },
  } as unknown as ExtensionContext);
  container.bind(WslcBridgeManager).toSelf();
  manager = container.get(WslcBridgeManager);
  unexpectedExit = vi.fn<(error: Error) => void>();
});

afterEach(async () => {
  await manager.stop();
});

describe('resolveBridgeExecutable', () => {
  test('resolves x64 to the win32-x64 bridge executable', () => {
    expect(resolveBridgeExecutable('/extension', 'x64')).toBe('/extension/dist/bin/win32-x64/wslc-bridge.exe');
  });

  test('resolves arm64 to the win32-arm64 bridge executable', () => {
    expect(resolveBridgeExecutable('/extension', 'arm64')).toBe('/extension/dist/bin/win32-arm64/wslc-bridge.exe');
  });

  test('rejects unsupported architectures', () => {
    expect(() => resolveBridgeExecutable('/extension', 'ia32')).toThrow(
      'Unsupported Windows bridge architecture: ia32',
    );
  });
});

describe('WslcBridgeManager', () => {
  test('coalesces concurrent starts into one bridge process', async () => {
    const signal = new AbortController().signal;
    const firstStart = manager.start(signal, unexpectedExit);
    const secondStart = manager.start(signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(readinessRecord());

    await Promise.all([firstStart, secondStart]);

    expect(spawn).toHaveBeenCalledOnce();
    expect(manager.isReady()).toBe(true);
  });

  test('spawns the bridge and becomes ready after a complete ready record and named-pipe ping', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(spawn).toHaveBeenCalledWith(
      '/extension/dist/bin/win32-x64/wslc-bridge.exe',
      ['serve', '--pipe', bridgeConfiguration.pipeName, '--shutdown-on-stdin-eof'],
      {
        cwd: '/extension/dist/bin/win32-x64',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    expect(child.stderr.readableFlowing).toBe(true);

    const record = readinessRecord();
    child.stdout.write(record.slice(0, 17));
    child.stdout.write(record.slice(17));
    await startPromise;

    expect(manager.isReady()).toBe(true);
    expect(request).toHaveBeenCalledWith(
      { socketPath: bridgeConfiguration.pipeName, path: '/_ping', method: 'GET' },
      expect.any(Function),
    );
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('rejects unsupported host architecture before spawning', async () => {
    vi.mocked(arch).mockReturnValue('ia32');

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'Unsupported Windows bridge architecture: ia32',
    );

    expect(spawn).not.toHaveBeenCalled();
  });

  test('requires the packaged executable before spawning', async () => {
    vi.mocked(access).mockRejectedValue(new Error('not found'));

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'WSL Containers bridge executable is missing',
    );

    expect(spawn).not.toHaveBeenCalled();
  });

  test('accepts a ready bridge without requiring an exact bridge version', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(readinessRecord({ bridgeVersion: 'newer-bridge-build' }));

    await startPromise;
    expect(request).toHaveBeenCalledOnce();
    expect(manager.isReady()).toBe(true);
  });

  test('closes stdin on stop and ignores the expected process close', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(readinessRecord());
    await startPromise;

    await manager.stop();

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('kills the owned bridge if graceful stdin shutdown times out', async () => {
    const originalShutdownTimeout = bridgeConfiguration.shutdownTimeoutMs;
    bridgeConfiguration.shutdownTimeoutMs = 0;
    try {
      const startPromise = manager.start(new AbortController().signal, unexpectedExit);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.stdout.write(readinessRecord());
      await startPromise;
      child.stdin.removeAllListeners('finish');

      await manager.stop();

      expect(child.stdin.writableEnded).toBe(true);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(unexpectedExit).not.toHaveBeenCalled();
    } finally {
      bridgeConfiguration.shutdownTimeoutMs = originalShutdownTimeout;
    }
  });

  test('reports an unexpected process error only once', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(readinessRecord());
    await startPromise;

    child.emit('error', new Error('process error'));
    child.exitCode = 1;
    child.emit('close', 1, null);

    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });
});
