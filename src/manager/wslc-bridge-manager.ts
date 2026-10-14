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
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { inject, injectable } from 'inversify';
import type { ExtensionContext } from '@podman-desktop/api';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol } from '../inject/symbol';

const MAX_READINESS_LINE_BYTES = 2_048;

interface BridgeReadinessEvent {
  event: 'ready';
  protocolVersion: 1;
  bridgeVersion: string;
  pipe: string;
  guestApiVersion: string;
}

export function resolveBridgeExecutable(extensionDirectory: string, architecture: string): string {
  let platformDirectory: string;
  switch (architecture) {
    case 'x64':
      platformDirectory = 'win32-x64';
      break;
    case 'arm64':
      platformDirectory = 'win32-arm64';
      break;
    default:
      throw new Error(`Unsupported Windows bridge architecture: ${architecture}`);
  }

  return resolve(extensionDirectory, 'dist', 'bin', platformDirectory, bridgeConfiguration.executableName);
}

function isReadinessEvent(value: unknown): value is BridgeReadinessEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const event = value as Record<string, unknown>;
  return (
    event.event === 'ready' &&
    event.protocolVersion === 1 &&
    typeof event.bridgeVersion === 'string' &&
    typeof event.pipe === 'string' &&
    typeof event.guestApiVersion === 'string'
  );
}

@injectable()
export class WslcBridgeManager {
  @inject(ExtensionContextSymbol)
  private readonly extensionContext: ExtensionContext;

  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #ready = false;
  #stopping = false;
  #generation = 0;
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
    const generation = ++this.#generation;
    const startPromise = this.startBridge(signal, generation).finally(() => {
      if (this.#startPromise === startPromise) {
        this.#startPromise = undefined;
      }
    });
    this.#startPromise = startPromise;
    return startPromise;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('WSL Containers bridge ping was cancelled');
    }

    await new Promise<void>((resolvePing, rejectPing) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const request = httpRequest(
        {
          socketPath: bridgeConfiguration.pipeName,
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
            if (response.statusCode === 200 && body === 'OK') {
              finish(resolvePing);
              return;
            }
            finish(() => rejectPing(new Error('WSL Containers bridge Docker API ping failed')));
          });
          response.once('error', (error: Error) => finish(() => rejectPing(error)));
        },
      );
      const onAbort = (): void => {
        request.destroy(new Error('WSL Containers bridge ping was cancelled'));
      };
      const timeout = setTimeout(() => {
        request.destroy(new Error('WSL Containers bridge Docker API ping timed out'));
      }, bridgeConfiguration.requestTimeoutMs);

      request.once('error', (error: Error) => finish(() => rejectPing(error)));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.end();
    });
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }
    const stopPromise = this.stopBridge().finally(() => {
      if (this.#stopPromise === stopPromise) {
        this.#stopPromise = undefined;
      }
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  private async startBridge(signal: AbortSignal, generation: number): Promise<void> {
    if (signal.aborted) {
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const executablePath = resolveBridgeExecutable(this.extensionContext.extensionUri.fsPath, arch());
    await access(executablePath).catch(() => {
      throw new Error(`WSL Containers bridge executable is missing: ${executablePath}`);
    });
    if (signal.aborted || this.#stopping || this.#generation !== generation) {
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const child = spawn(executablePath, ['serve', '--pipe', bridgeConfiguration.pipeName, '--shutdown-on-stdin-eof'], {
      cwd: dirname(executablePath),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stderr?.resume();
    child.on('error', (error: Error) => this.handleProcessError(child, generation, error));
    child.once('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      const error = new Error(`WSL Containers bridge exited (code ${String(code)}, signal ${String(signalName)})`);
      this.handleProcessClose(child, generation, error);
    });

    try {
      await this.waitForReadiness(child, signal);
      if (this.#child !== child || this.#generation !== generation || this.#stopping || signal.aborted) {
        throw new Error('WSL Containers bridge exited before startup completed');
      }
      this.#ready = true;
    } catch (error: unknown) {
      if (this.#generation === generation) {
        await this.stop();
      } else {
        await this.reapChild(child);
      }
      throw error;
    }
  }

  private async waitForReadiness(child: ChildProcess, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolveReady, rejectNotReady) => {
      let partialLine = Buffer.alloc(0);
      let settled = false;
      let checkingPing = false;

      const cleanup = (): void => {
        clearTimeout(startupTimer);
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
      const onReadinessLine = (line: Buffer): void => {
        const normalizedLine = line.at(-1) === 13 ? line.subarray(0, -1) : line;
        let parsed: unknown;
        try {
          parsed = JSON.parse(normalizedLine.toString('utf8')) as unknown;
        } catch {
          return;
        }
        if (!isReadinessEvent(parsed) || checkingPing) {
          return;
        }
        if (parsed.pipe !== bridgeConfiguration.pipeName) {
          finish(() => rejectNotReady(new Error(`WSL Containers bridge announced unexpected pipe ${parsed.pipe}`)));
          return;
        }
        checkingPing = true;
        this.ping(signal).then(
          () => finish(resolveReady),
          (error: unknown) =>
            finish(() =>
              rejectNotReady(error instanceof Error ? error : new Error('WSL Containers bridge ping failed')),
            ),
        );
      };
      const onStdout = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let remaining = Buffer.concat([partialLine, bytes]);
        let newlineIndex = remaining.indexOf(10);
        while (newlineIndex !== -1) {
          const line = remaining.subarray(0, newlineIndex);
          if (line.length > MAX_READINESS_LINE_BYTES) {
            finish(() => rejectNotReady(new Error('WSL Containers bridge readiness line exceeded 2048 bytes')));
            return;
          }
          onReadinessLine(line);
          if (settled) {
            return;
          }
          remaining = remaining.subarray(newlineIndex + 1);
          newlineIndex = remaining.indexOf(10);
        }

        if (remaining.length > MAX_READINESS_LINE_BYTES) {
          finish(() => rejectNotReady(new Error('WSL Containers bridge readiness line exceeded 2048 bytes')));
          return;
        }
        partialLine = remaining;
      };
      const onChildError = (error: Error): void => finish(() => rejectNotReady(error));
      const onChildClose = (code: number | null): void =>
        finish(() => rejectNotReady(new Error(`WSL Containers bridge exited before readiness (code ${String(code)})`)));
      const onAbort = (): void =>
        finish(() => rejectNotReady(new Error('WSL Containers bridge startup was cancelled')));
      const startupTimer = setTimeout(
        () => finish(() => rejectNotReady(new Error('Timed out waiting for WSL Containers bridge readiness'))),
        bridgeConfiguration.startupTimeoutMs,
      );

      child.stdout?.on('data', onStdout);
      child.once('error', onChildError);
      child.once('close', onChildClose);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async stopBridge(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    const child = this.#child;
    if (!child) {
      return;
    }

    await this.reapChild(child);
    if (this.#child === child) {
      this.#child = undefined;
    }
  }

  private async reapChild(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const closePromise = this.waitForClose(child, bridgeConfiguration.shutdownTimeoutMs);
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
    if (await closePromise) {
      return;
    }

    child.kill();
    await this.waitForClose(child, bridgeConfiguration.shutdownTimeoutMs);
  }

  private async waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    return new Promise<boolean>((resolveClosed) => {
      const onClose = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const finish = (closed: boolean): void => {
        clearTimeout(timeout);
        child.removeListener('close', onClose);
        resolveClosed(closed);
      };
      child.once('close', onClose);
    });
  }

  private handleProcessError(child: ChildProcess, generation: number, error: Error): void {
    if (this.#child !== child || this.#generation !== generation) {
      return;
    }

    const wasReady = this.#ready;
    this.#ready = false;
    if (wasReady && !this.#stopping) {
      this.#unexpectedExit?.(error);
    }
  }

  private handleProcessClose(child: ChildProcess, generation: number, error: Error): void {
    if (this.#child !== child || this.#generation !== generation) {
      return;
    }

    const wasReady = this.#ready;
    this.#ready = false;
    this.#child = undefined;
    if (wasReady && !this.#stopping) {
      this.#unexpectedExit?.(error);
    }
  }
}
