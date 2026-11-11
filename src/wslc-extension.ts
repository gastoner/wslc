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

import { env, type ExtensionContext, type TelemetryLogger } from '@podman-desktop/api';
import type { Container } from 'inversify';
import { InversifyBinding } from './inject/inversify-binding';
import { WslcProviderManager } from './manager/wslc-provider-manager';

export class WslcExtension {
  readonly #extensionContext: ExtensionContext;
  #providerManager: WslcProviderManager | undefined;
  #inversifyBinding: InversifyBinding | undefined;
  #container: Container | undefined;
  #telemetryLogger: TelemetryLogger | undefined;
  #activationPromise: Promise<void> | undefined;
  #deferredActivationPromise: Promise<void> | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #deactivationPromise: Promise<void> | undefined;
  #deactivationRequested = false;

  constructor(extensionContext: ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  async activate(): Promise<void> {
    if (this.#activationPromise) {
      return this.#activationPromise;
    }

    if (this.#deactivationRequested) {
      return;
    }

    if (!env.isWindows) {
      const telemetryLogger = env.createTelemetryLogger();
      telemetryLogger.logError('invalidPlatform');
      console.warn('WSL Containers extension not started: can only be activated on Windows');
      this.#activationPromise = Promise.resolve();
      return;
    }

    this.#activationPromise = this.activateOnWindows();
    return this.#activationPromise;
  }

  private async activateOnWindows(): Promise<void> {
    const telemetryLogger = env.createTelemetryLogger();
    this.#telemetryLogger = telemetryLogger;
    this.#inversifyBinding = new InversifyBinding(this.#extensionContext, telemetryLogger);

    try {
      this.#container = await this.#inversifyBinding.initBindings();
      const providerManager = await this.#container.getAsync(WslcProviderManager);
      this.#providerManager = providerManager;
    } catch (error: unknown) {
      console.error('WSL Containers extension activation failed', error);
      try {
        await this.cleanup();
      } catch (cleanupError: unknown) {
        console.error('WSL Containers extension activation cleanup failed', cleanupError);
      }
      throw error;
    }

    if (this.#deactivationRequested) {
      return;
    }

    this.#deferredActivationPromise = this.deferActivate().catch((error: unknown) => {
      console.error('error in deferActivate', error);
    });
  }

  async deactivate(): Promise<void> {
    this.#deactivationRequested = true;
    if (!this.#deactivationPromise) {
      this.#deactivationPromise = this.deactivateAndCleanup();
    }
    return this.#deactivationPromise;
  }

  private async deactivateAndCleanup(): Promise<void> {
    try {
      await this.#activationPromise;
    } catch {
      // Activation reports its own failure to the caller; deactivation still cleans up.
    }

    try {
      await this.#deferredActivationPromise;
    } catch {
      // Deferred activation errors are logged by activateOnWindows.
    }

    await this.cleanup();
  }

  private cleanup(): Promise<void> {
    if (this.#cleanupPromise) {
      return this.#cleanupPromise;
    }

    const providerManager = this.#providerManager;
    const inversifyBinding = this.#inversifyBinding;
    this.#providerManager = undefined;
    this.#inversifyBinding = undefined;
    this.#container = undefined;

    const cleanupPromise = Promise.resolve().then(async () => {
      try {
        await providerManager?.deactivate();
      } finally {
        try {
          await inversifyBinding?.dispose();
        } finally {
          this.#telemetryLogger = undefined;
        }
      }
    });
    this.#cleanupPromise = cleanupPromise;
    return cleanupPromise;
  }

  protected async deferActivate(): Promise<void> {
    if (this.#deactivationRequested) {
      return;
    }

    console.log('WSL Containers extension activated on Windows');
    this.#telemetryLogger?.logUsage('activated');
    if (this.#deactivationRequested) {
      return;
    }
    await this.#providerManager?.registerContainerProvider();
  }

  protected getContainer(): Container | undefined {
    return this.#container;
  }
}
