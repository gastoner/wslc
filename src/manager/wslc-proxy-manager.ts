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

import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { inject, injectable } from 'inversify';
import type { ExtensionContext } from '@podman-desktop/api';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol } from '../inject/symbol';

const MAX_READINESS_OUTPUT_LENGTH = 2_048;
const READY_MESSAGE = `Listening on ${bridgeConfiguration.host}:${bridgeConfiguration.port}`;
const KEEPALIVE_CONTAINER_NAME = 'socktainer-keepalive';

@injectable()
export class WslcProxyManager {
  @inject(ExtensionContextSymbol)
  private readonly extensionContext: ExtensionContext;

  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #ready = false;
  #stopping = false;
  #ownsRuntime = false;
  #unexpectedExit: ((error: Error) => void) | undefined;

  isReady(): boolean {
    return this.#ready && this.#child !== undefined;
  }

  async start(signal: AbortSignal, onUnexpectedExit: (error: Error) => void): Promise<void> {
    if (this.#stopPromise) {
      await this.#stopPromise;
    }
    if (this.isReady()) {
      return;
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#stopping = false;
    this.#unexpectedExit = onUnexpectedExit;
    const startPromise = this.startProxy(signal).finally(() => {
      if (this.#startPromise === startPromise) {
        this.#startPromise = undefined;
      }
    });
    this.#startPromise = startPromise;
    return startPromise;
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }
    const stopPromise = this.stopProxy().finally(() => {
      if (this.#stopPromise === stopPromise) {
        this.#stopPromise = undefined;
      }
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  private async stopProxy(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    const child = this.#child;
    try {
      if (child) {
        child.kill();
        await this.waitForClose(child, bridgeConfiguration.shutdownTimeoutMs);
        if (this.#child === child) {
          this.#child = undefined;
        }
      }
    } finally {
      if (this.#ownsRuntime) {
        await this.stopOwnedRuntime();
        this.#ownsRuntime = false;
      }
    }
  }

  private async startProxy(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error('Socktainer startup was cancelled');
    }

    const binaryDirectory = await this.resolveBinaryDirectory();
    await this.assertPortAvailable();

    const executablePath = resolve(binaryDirectory, bridgeConfiguration.executableName);
    const child = spawn(executablePath, [], {
      cwd: binaryDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#ownsRuntime = true;

    child.stderr?.resume();
    child.on('error', (error: Error) => this.handleProcessExit(child, error));
    child.once('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      const error = new Error(`Socktainer exited before shutdown (code ${String(code)}, signal ${String(signalName)})`);
      this.handleProcessExit(child, error);
    });

    try {
      await this.waitForReadiness(child, signal);
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  private async resolveBinaryDirectory(): Promise<string> {
    const extensionPath = this.extensionContext.extensionUri.fsPath;
    const directory = resolve(extensionPath, 'dist', 'bin', 'win32-x64');
    await Promise.all([
      access(resolve(directory, bridgeConfiguration.executableName)),
      access(resolve(directory, bridgeConfiguration.relayName)),
    ]).catch(() => {
      throw new Error(`Socktainer artifacts are missing from dist/bin/win32-x64`);
    });
    return directory;
  }

  private async assertPortAvailable(): Promise<void> {
    await new Promise<void>((resolveAvailable, rejectOccupied) => {
      const socket = createConnection({ host: bridgeConfiguration.host, port: bridgeConfiguration.port });
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        callback();
      };

      socket.setTimeout(bridgeConfiguration.requestTimeoutMs, () => {
        finish(() => rejectOccupied(new Error('Timed out checking whether Socktainer TCP port is available')));
      });
      socket.once('connect', () => {
        finish(() =>
          rejectOccupied(
            new Error(
              `TCP port ${bridgeConfiguration.port} is already accepting connections; refusing to use an unrelated service`,
            ),
          ),
        );
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') {
          finish(resolveAvailable);
          return;
        }
        finish(() => rejectOccupied(error));
      });
    });
  }

  private async waitForReadiness(child: ChildProcess, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolveReady, rejectNotReady) => {
      let output = '';
      let foundListeningMessage = false;
      let checking = false;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(startupTimer);
        clearInterval(pollTimer);
        child.stdout?.removeListener('data', onStdout);
        child.removeListener('error', onChildError);
        child.removeListener('close', onChildClose);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onStdout = (chunk: Buffer | string): void => {
        output += String(chunk);
        if (output.length > MAX_READINESS_OUTPUT_LENGTH && !output.includes('\n')) {
          output = output.slice(-MAX_READINESS_OUTPUT_LENGTH);
        }
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === READY_MESSAGE) {
            foundListeningMessage = true;
          }
        }
      };
      const checkReadiness = async (): Promise<void> => {
        if (!foundListeningMessage || checking) {
          return;
        }
        checking = true;
        try {
          await this.ping();
          if (settled) {
            return;
          }
          this.#ready = true;
          finish(resolveReady);
        } catch {
          if (!settled) {
            checking = false;
          }
        }
      };
      const onChildError = (error: Error): void => finish(() => rejectNotReady(error));
      const onChildClose = (code: number | null): void =>
        finish(() => rejectNotReady(new Error(`Socktainer exited before becoming ready (code ${String(code)})`)));
      const onAbort = (): void => finish(() => rejectNotReady(new Error('Socktainer startup was cancelled')));
      const startupTimer = setTimeout(
        () => finish(() => rejectNotReady(new Error('Timed out waiting for Socktainer readiness'))),
        bridgeConfiguration.startupTimeoutMs,
      );
      const pollTimer = setInterval(() => void checkReadiness(), bridgeConfiguration.readinessPollIntervalMs);

      child.stdout?.on('data', onStdout);
      child.once('error', onChildError);
      child.once('close', onChildClose);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async ping(): Promise<void> {
    await new Promise<void>((resolvePing, rejectPing) => {
      const request = httpRequest(
        {
          host: bridgeConfiguration.host,
          port: bridgeConfiguration.port,
          path: '/_ping',
          method: 'GET',
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.once('end', () => {
            if (response.statusCode === 200 && body.trim() === 'OK') {
              resolvePing();
              return;
            }
            rejectPing(new Error('Socktainer Docker API ping failed'));
          });
        },
      );

      request.setTimeout(bridgeConfiguration.requestTimeoutMs, () => {
        request.destroy(new Error('Socktainer Docker API ping timed out'));
      });
      request.once('error', rejectPing);
      request.end();
    });
  }

  private async stopOwnedRuntime(): Promise<void> {
    await this.runWslcCleanupCommand(['container', 'stop', KEEPALIVE_CONTAINER_NAME]);
    await this.runWslcCleanupCommand(['container', 'rm', KEEPALIVE_CONTAINER_NAME]);
  }

  private async runWslcCleanupCommand(args: string[]): Promise<void> {
    await new Promise<void>((resolveCleanup) => {
      const child = spawn('wslc.exe', args, {
        windowsHide: true,
        stdio: 'ignore',
      });
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveCleanup();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish();
      }, bridgeConfiguration.requestTimeoutMs);
      child.once('error', finish);
      child.once('close', finish);
    });
  }

  private handleProcessExit(child: ChildProcess, error: Error): void {
    if (this.#child !== child) {
      return;
    }

    const wasReady = this.#ready;
    this.#ready = false;
    this.#child = undefined;
    if (wasReady && !this.#stopping) {
      this.#unexpectedExit?.(error);
    }
  }

  private async waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    return new Promise<boolean>((resolveClosed) => {
      const onClose = (): void => {
        clearTimeout(timeout);
        resolveClosed(true);
      };
      const timeout = setTimeout(() => {
        child.removeListener('close', onClose);
        resolveClosed(false);
      }, timeoutMs);
      child.once('close', onClose);
    });
  }
}
