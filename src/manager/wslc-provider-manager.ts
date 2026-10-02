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

import { request as httpRequest } from 'node:http';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { inject, injectable } from 'inversify';
import {
  type ContainerProviderConnection,
  type Disposable,
  type ExtensionContext,
  type Logger,
  type Provider,
  type ProviderConnectionStatus,
  type ProviderInstallation,
  type TelemetryLogger,
  process as podmanProcess,
  provider,
} from '@podman-desktop/api';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '../inject/symbol';
import { WslcProxyManager } from './wslc-proxy-manager';
import { WslVersionService } from './wsl-version-service';

const WSLC_EXECUTABLE = 'wslc.exe';

@injectable()
export class WslcProviderManager {
  static readonly PROVIDER_ID = 'wslc';

  @inject(ExtensionContextSymbol)
  private readonly extensionContext: ExtensionContext;

  @inject(TelemetryLoggerSymbol)
  private readonly telemetryLogger: TelemetryLogger;

  @inject(WslVersionService)
  private readonly wslVersionService: WslVersionService;

  @inject(WslcProxyManager)
  private readonly wslcProxyManager: WslcProxyManager;

  #wslcProvider: Provider | undefined;
  #bridgeServer: Server | undefined;
  #bridgeSockets = new Set<Socket>();
  #proxySockets = new Set<Socket>();
  #connectionDisposable: Disposable | undefined;
  #installationDisposable: Disposable | undefined;
  #updateDisposable: Disposable | undefined;
  #connectionStatus: ProviderConnectionStatus = 'stopped';
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<void> | undefined;
  #stopMonitoringStatus = false;
  #abortController: AbortController | undefined;
  #proxyStartupFailures = 0;

  async registerContainerProvider(): Promise<void> {
    if (this.#wslcProvider) {
      return;
    }

    this.#stopMonitoringStatus = false;
    this.#abortController = new AbortController();
    this.#proxyStartupFailures = 0;
    const wslcProvider = provider.createProvider({
      name: 'WSL Containers',
      id: WslcProviderManager.PROVIDER_ID,
      status: 'unknown',
      images: {
        icon: './icon.png',
        logo: './icon.png',
      },
    });
    this.#wslcProvider = wslcProvider;
    this.extensionContext.subscriptions.push(wslcProvider);

    this.monitorContainerSystemStatus(wslcProvider).catch((error: unknown) => {
      console.error('Error monitoring WSL Containers runtime', error);
    });
  }

  async updateContainerSystemStatus(wslcProvider: Provider): Promise<void> {
    if (this.#stopMonitoringStatus) {
      return;
    }

    let runtimeVersion: string;
    try {
      const { stdout } = await podmanProcess.exec(WSLC_EXECUTABLE, ['version']);
      runtimeVersion = String(stdout).trim();
    } catch (error: unknown) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.disposeInstallation();
      this.disposeUpdate();
      wslcProvider.updateVersion();
      wslcProvider.updateStatus('not-installed');
      this.registerInstallation();
      console.error('Error checking WSL Containers version', error);
      return;
    }

    this.disposeInstallation();
    wslcProvider.updateStatus('installed');
    this.telemetryLogger.logUsage('runtimeDetected', runtimeVersion ? { version: runtimeVersion } : undefined);

    let wslVersion: string | undefined;
    try {
      const result = await podmanProcess.exec('wsl', ['--version'], { encoding: 'utf16le' });
      wslVersion = this.wslVersionService.parseWslVersion(String(result.stdout));
    } catch (error: unknown) {
      console.warn('WSL version could not be detected', error);
    }

    if (!wslVersion) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.disposeUpdate();
      console.warn('WSL version output could not be parsed');
      return;
    }

    wslcProvider.updateVersion(wslVersion);
    if (!this.wslVersionService.isSupportedWslVersion(wslVersion)) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.registerUpdate();
      wslcProvider.updateStatus('installed');
      return;
    }

    this.disposeUpdate();

    try {
      await podmanProcess.exec(WSLC_EXECUTABLE, ['container', 'list']);
    } catch (error: unknown) {
      await this.cleanupConnection();
      await this.stopBridge();
      wslcProvider.updateStatus('stopped');
      console.error('Error checking WSL Containers runtime status', error);
      return;
    }

    if (this.#connectionDisposable && this.wslcProxyManager.isReady()) {
      try {
        await this.pingNamedPipe();
        wslcProvider.updateStatus('ready');
        return;
      } catch (error: unknown) {
        await this.cleanupConnection();
        await this.stopBridge();
        console.warn('WSL Containers connection health check failed', error);
      }
    }

    if (this.#proxyStartupFailures >= bridgeConfiguration.maxConsecutiveStartupFailures) {
      wslcProvider.updateStatus('error');
      return;
    }

    try {
      await this.ensureBridge();
      this.#proxyStartupFailures = 0;
      if (!this.#stopMonitoringStatus) {
        wslcProvider.updateStatus('ready');
      }
    } catch (error: unknown) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.#proxyStartupFailures += 1;
      if (!this.#stopMonitoringStatus) {
        wslcProvider.updateStatus('error');
        this.telemetryLogger.logError('bridgeStartupFailed');
        console.error('WSL Containers bridge could not be started', error);
      }
    }
  }

  async monitorContainerSystemStatus(wslcProvider: Provider): Promise<void> {
    if (this.#stopMonitoringStatus) {
      return;
    }

    try {
      await this.refresh(wslcProvider);
    } catch (error: unknown) {
      console.trace('Error updating WSL Containers runtime status', error);
    }

    if (this.#stopMonitoringStatus) {
      return;
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      this.monitorContainerSystemStatus(wslcProvider).catch((error: unknown) => {
        console.error('Error monitoring WSL Containers runtime', error);
      });
    }, bridgeConfiguration.refreshIntervalMs);
  }

  async refresh(wslcProvider = this.#wslcProvider): Promise<void> {
    if (this.#stopMonitoringStatus || !wslcProvider) {
      return;
    }
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    const refreshPromise = this.updateContainerSystemStatus(wslcProvider).finally(() => {
      if (this.#refreshPromise === refreshPromise) {
        this.#refreshPromise = undefined;
      }
    });
    this.#refreshPromise = refreshPromise;
    return refreshPromise;
  }

  async cleanupConnection(): Promise<void> {
    this.#connectionStatus = 'stopped';
    const connectionDisposable = this.#connectionDisposable;
    connectionDisposable?.dispose();
    if (connectionDisposable) {
      const index = this.extensionContext.subscriptions.indexOf(connectionDisposable);
      if (index >= 0) {
        this.extensionContext.subscriptions.splice(index, 1);
      }
    }
    this.#connectionDisposable = undefined;
  }

  async deactivate(): Promise<void> {
    this.#stopMonitoringStatus = true;
    this.#abortController?.abort();
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    await this.#refreshPromise;
    this.disposeInstallation();
    this.disposeUpdate();
    await this.cleanupConnection();
    await this.stopBridge();
    this.#wslcProvider = undefined;
    this.#abortController = undefined;
  }

  private registerUpdate(): void {
    if (this.#updateDisposable || !this.#wslcProvider) {
      return;
    }

    const update = {
      version: this.wslVersionService.minimumVersion,
      update: async (logger: Logger): Promise<void> => {
        await this.updateWsl(logger, `Updating WSL to ${this.wslVersionService.minimumVersion} or newer`);
      },
    };
    this.#updateDisposable = this.#wslcProvider.registerUpdate(update);
    this.extensionContext.subscriptions.push(this.#updateDisposable);
  }

  private registerInstallation(): void {
    if (this.#installationDisposable || !this.#wslcProvider) {
      return;
    }

    const installation: ProviderInstallation = {
      install: async (logger: Logger): Promise<void> => {
        await this.updateWsl(logger, 'Installing WSL Containers prerequisites with wsl --update');
      },
    };
    this.#installationDisposable = this.#wslcProvider.registerInstallation(installation);
    this.extensionContext.subscriptions.push(this.#installationDisposable);
  }

  private async updateWsl(logger: Logger, message: string): Promise<void> {
    logger.log(message);
    await podmanProcess.exec('wsl', ['--update'], { encoding: 'utf16le' });
    await this.#refreshPromise;
    await this.refresh();
  }

  private disposeInstallation(): void {
    const installationDisposable = this.#installationDisposable;
    installationDisposable?.dispose();
    if (installationDisposable) {
      const index = this.extensionContext.subscriptions.indexOf(installationDisposable);
      if (index >= 0) {
        this.extensionContext.subscriptions.splice(index, 1);
      }
    }
    this.#installationDisposable = undefined;
  }

  private disposeUpdate(): void {
    const updateDisposable = this.#updateDisposable;
    updateDisposable?.dispose();
    if (updateDisposable) {
      const index = this.extensionContext.subscriptions.indexOf(updateDisposable);
      if (index >= 0) {
        this.extensionContext.subscriptions.splice(index, 1);
      }
    }
    this.#updateDisposable = undefined;
  }

  private async ensureBridge(): Promise<void> {
    const abortController = this.#abortController;
    if (!abortController || abortController.signal.aborted) {
      throw new Error('WSL Containers proxy startup was cancelled');
    }

    await this.wslcProxyManager.start(abortController.signal, (error) => this.handleProxyExit(error));

    if (!this.#bridgeServer?.listening) {
      const bridgeServer = createServer((socket) => this.proxyWslcSocket(bridgeServer, socket));
      this.#bridgeServer = bridgeServer;

      await new Promise<void>((resolveListening, rejectListening) => {
        const onListening = (): void => {
          bridgeServer.removeListener('error', onError);
          resolveListening();
        };
        const onError = (error: Error): void => {
          bridgeServer.removeListener('listening', onListening);
          rejectListening(error);
        };
        bridgeServer.once('listening', onListening);
        bridgeServer.once('error', onError);
        bridgeServer.listen(bridgeConfiguration.pipeName);
      }).catch((error: unknown) => {
        if (this.#bridgeServer === bridgeServer) {
          this.#bridgeServer = undefined;
        }
        throw error;
      });

      bridgeServer.on('error', (error: Error) => this.handleBridgeServerError(bridgeServer, error));
      this.telemetryLogger.logUsage('bridgeStarted');
    }

    await this.pingNamedPipe();
    await this.registerConnection();
  }

  private proxyWslcSocket(bridgeServer: Server, socket: Socket): void {
    if (this.#stopMonitoringStatus || this.#bridgeServer !== bridgeServer) {
      socket.destroy();
      return;
    }

    const proxySocket = createConnection({ host: bridgeConfiguration.host, port: bridgeConfiguration.port });
    this.#bridgeSockets.add(socket);
    this.#proxySockets.add(proxySocket);
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);

    const closePair = (): void => {
      this.#bridgeSockets.delete(socket);
      this.#proxySockets.delete(proxySocket);
      socket.destroy();
      proxySocket.destroy();
    };
    socket.once('error', (error: Error) => {
      console.error('WSL Containers named-pipe client error', error);
      closePair();
    });
    proxySocket.once('error', (error: Error) => {
      console.error('WSL Containers TCP proxy connection error', error);
      closePair();
    });
    socket.once('close', closePair);
    proxySocket.once('close', closePair);
  }

  private handleBridgeServerError(bridgeServer: Server, error: Error): void {
    if (this.#bridgeServer !== bridgeServer) {
      return;
    }

    console.error('WSL Containers named-pipe bridge failed', error);
    void this.cleanupConnection();
    void this.stopBridge();
    this.telemetryLogger.logUsage('bridgeExited');
    if (!this.#stopMonitoringStatus) {
      this.#wslcProvider?.updateStatus('installed');
    }
  }

  private handleProxyExit(error: Error): void {
    void (async () => {
      await this.cleanupConnection();
      await this.stopBridge();
      this.telemetryLogger.logUsage('bridgeExited');
      this.#proxyStartupFailures += 1;
      if (!this.#stopMonitoringStatus) {
        this.#wslcProvider?.updateStatus(
          this.#proxyStartupFailures >= bridgeConfiguration.maxConsecutiveStartupFailures ? 'error' : 'installed',
        );
        console.error('WSL Containers Socktainer process exited unexpectedly', error);
      }
    })();
  }

  private async pingNamedPipe(): Promise<void> {
    await new Promise<void>((resolvePing, rejectPing) => {
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
            if (response.statusCode === 200 && body.trim() === 'OK') {
              resolvePing();
              return;
            }
            rejectPing(new Error('WSL Containers named-pipe Docker API ping failed'));
          });
        },
      );

      request.setTimeout(bridgeConfiguration.requestTimeoutMs, () => {
        request.destroy(new Error('WSL Containers named-pipe Docker API ping timed out'));
      });
      request.once('error', rejectPing);
      request.end();
    });
  }

  private async registerConnection(): Promise<void> {
    if (!this.#wslcProvider || this.#connectionDisposable || this.#stopMonitoringStatus) {
      return;
    }

    this.#connectionStatus = 'started';
    const connection: ContainerProviderConnection = {
      name: 'WSL Containers',
      type: 'docker',
      status: (): ProviderConnectionStatus => this.#connectionStatus,
      endpoint: {
        socketPath: bridgeConfiguration.pipeName,
      },
    };
    this.#connectionDisposable = this.#wslcProvider.registerContainerProviderConnection(connection);
    this.extensionContext.subscriptions.push(this.#connectionDisposable);
    this.telemetryLogger.logUsage('connectionRegistered');
  }

  private async stopBridge(): Promise<void> {
    const bridgeServer = this.#bridgeServer;
    this.#bridgeServer = undefined;

    for (const socket of this.#bridgeSockets) {
      socket.destroy();
    }
    this.#bridgeSockets.clear();

    for (const socket of this.#proxySockets) {
      socket.destroy();
    }
    this.#proxySockets.clear();

    if (bridgeServer?.listening) {
      await new Promise<void>((resolveClose) => {
        bridgeServer.close(() => resolveClose());
      });
    }

    await this.wslcProxyManager.stop();
  }
}
