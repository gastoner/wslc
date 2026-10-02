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
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExtensionContext } from '@podman-desktop/api';
import { Container } from 'inversify';
import { ExtensionContextSymbol } from '../inject/symbol';
import { WslcProxyManager } from './wslc-proxy-manager';

vi.mock(import('node:fs/promises'));
vi.mock(import('node:child_process'));
vi.mock(import('node:net'));
vi.mock(import('node:http'));

interface MockSocket extends EventEmitter {
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

let manager: WslcProxyManager;
let child: MockChild;
let portCheckSocket: MockSocket;
let unexpectedExit: (error: Error) => void;
let cleanupCommandArgs: string[][];

function createReadyHttpRequest(): void {
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
}

beforeEach(() => {
  vi.resetAllMocks();
  cleanupCommandArgs = [];
  vi.mocked(access).mockResolvedValue(undefined);
  portCheckSocket = new EventEmitter() as MockSocket;
  portCheckSocket.setTimeout = vi.fn();
  portCheckSocket.destroy = vi.fn();
  vi.mocked(createConnection).mockImplementation(() => {
    queueMicrotask(() => portCheckSocket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return portCheckSocket as unknown as import('node:net').Socket;
  });
  createReadyHttpRequest();

  child = new EventEmitter() as MockChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 1;
    child.emit('close', 1, null);
  });
  vi.mocked(spawn).mockImplementation((command: string, args: readonly string[]) => {
    if (command === 'wslc.exe') {
      cleanupCommandArgs.push([...args]);
      const cleanupChild = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
      cleanupChild.kill = vi.fn();
      queueMicrotask(() => cleanupChild.emit('close', 0, null));
      return cleanupChild as never;
    }
    return child as never;
  });

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue({
    extensionUri: { fsPath: '/extension' },
  } as unknown as ExtensionContext);
  container.bind(WslcProxyManager).toSelf();
  manager = container.get(WslcProxyManager);
  unexpectedExit = vi.fn<(error: Error) => void>();
});

afterEach(async () => {
  await manager.stop();
});

describe('WslcProxyManager', () => {
  test('starts the proxy after its listening marker and Docker API ping succeed', async () => {
    const signal = new AbortController().signal;
    const startPromise = manager.start(signal, unexpectedExit);

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenNthCalledWith(1, '/extension/dist/bin/win32-x64/socktainer.exe', [], {
      cwd: '/extension/dist/bin/win32-x64',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.write('Starting wslc session...\nListening on localhost:2375\n');

    await startPromise;

    expect(manager.isReady()).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      { host: 'localhost', port: 2375, path: '/_ping', method: 'GET' },
      expect.any(Function),
    );
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('refuses to start when another process already owns the TCP endpoint', async () => {
    vi.mocked(createConnection).mockImplementation(() => {
      const socket = new EventEmitter() as MockSocket;
      socket.setTimeout = vi.fn();
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit('connect'));
      return socket as unknown as import('node:net').Socket;
    });

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'already accepting connections',
    );

    expect(spawn).not.toHaveBeenCalled();
  });

  test('reports an unexpected process exit and clears readiness', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write('Listening on localhost:2375\n');
    await startPromise;

    child.exitCode = 1;
    child.emit('close', 1, null);

    expect(manager.isReady()).toBeFalsy();
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });

  test('stops the proxy and cleans its fixed-name keepalive container', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write('Listening on localhost:2375\n');
    await startPromise;

    await manager.stop();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(cleanupCommandArgs).toEqual([
      ['container', 'stop', 'socktainer-keepalive'],
      ['container', 'rm', 'socktainer-keepalive'],
    ]);
    expect(manager.isReady()).toBeFalsy();
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('reports missing packaged proxy assets before spawning the proxy', async () => {
    vi.mocked(access).mockRejectedValue(new Error('not found'));

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'Socktainer artifacts are missing',
    );

    expect(spawn).not.toHaveBeenCalled();
  });
});
