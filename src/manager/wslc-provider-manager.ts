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

import {
  type ContainerProviderConnection,
  type Disposable,
  type ExtensionContext,
  type Logger,
  type Provider,
  type ProviderConnectionStatus,
  type ProviderInstallation,
  process as podmanProcess,
  provider,
  type TelemetryLogger,
} from '@podman-desktop/api';
import { inject, injectable } from 'inversify';
import { bridgeConfiguration } from '../config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '../inject/symbol';
import { WslVersionService } from './wsl-version-service';
import { WslcBridgeManager } from './wslc-bridge-manager';

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

  @inject(WslcBridgeManager)
  private readonly wslcBridgeManager: WslcBridgeManager;

  #wslcProvider: Provider | undefined;
  #connectionDisposable: Disposable | undefined;
  #installationDisposable: Disposable | undefined;
  #updateDisposable: Disposable | undefined;
  #connectionStatus: ProviderConnectionStatus = 'stopped';
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<void> | undefined;
  #stopMonitoringStatus = false;
  #abortController: AbortController | undefined;
  #bridgeStartupFailures = 0;

  async registerContainerProvider(): Promise<void> {
    if (this.#wslcProvider) {
      return;
    }

    this.#stopMonitoringStatus = false;
    this.#abortController = new AbortController();
    this.#bridgeStartupFailures = 0;
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
      this.disposeUpdate();
      this.disposeInstallation();
      if (this.isMissingExecutable(error)) {
        wslcProvider.updateVersion();
        wslcProvider.updateStatus('not-installed');
        this.registerInstallation();
        console.error('WSL Containers runtime executable is not installed', error);
        return;
      }

      wslcProvider.updateStatus('error');
      console.error('Error checking WSL Containers version', error);
      return;
    }

    if (!runtimeVersion || !/\d+(?:\.\d+){1,3}/.test(runtimeVersion)) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.disposeInstallation();
      this.disposeUpdate();
      wslcProvider.updateStatus('error');
      console.error('WSL Containers version output was empty or malformed', runtimeVersion);
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
      wslcProvider.updateStatus('error');
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

    if (this.#connectionDisposable && this.wslcBridgeManager.isReady()) {
      try {
        await this.wslcBridgeManager.ping();
        wslcProvider.updateStatus('ready');
        return;
      } catch (error: unknown) {
        await this.cleanupConnection();
        await this.stopBridge();
        console.warn('WSL Containers bridge health check failed', error);
      }
    }

    if (this.#bridgeStartupFailures >= bridgeConfiguration.maxConsecutiveStartupFailures) {
      wslcProvider.updateStatus('error');
      return;
    }

    try {
      await this.ensureBridge();
      this.#bridgeStartupFailures = 0;
      if (!this.#stopMonitoringStatus) {
        wslcProvider.updateStatus('ready');
      }
    } catch (error: unknown) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.#bridgeStartupFailures += 1;
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

  private isMissingExecutable(error: unknown): boolean {
    return (
      error instanceof Error &&
      /ENOENT|not found|not recognized as an internal or external command|cannot find the file specified/i.test(
        error.message,
      )
    );
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
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const wasReady = this.wslcBridgeManager.isReady();
    await this.wslcBridgeManager.start(abortController.signal, (error) => this.handleBridgeExit(error));
    if (!this.wslcBridgeManager.isReady()) {
      throw new Error('WSL Containers bridge exited before becoming ready');
    }
    if (!wasReady) {
      this.telemetryLogger.logUsage('bridgeStarted');
    }

    await this.wslcBridgeManager.ping();
    if (!this.wslcBridgeManager.isReady() || this.#stopMonitoringStatus || abortController.signal.aborted) {
      throw new Error('WSL Containers bridge stopped before connection registration');
    }
    await this.registerConnection();
  }

  private handleBridgeExit(error: Error): void {
    void (async () => {
      await this.cleanupConnection();
      await this.stopBridge();
      this.telemetryLogger.logUsage('bridgeExited');
      this.#bridgeStartupFailures += 1;
      if (!this.#stopMonitoringStatus) {
        this.#wslcProvider?.updateStatus(
          this.#bridgeStartupFailures >= bridgeConfiguration.maxConsecutiveStartupFailures ? 'error' : 'installed',
        );
        console.error('WSL Containers bridge process exited unexpectedly', error);
      }
    })();
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
    await this.wslcBridgeManager.stop();
  }
}
