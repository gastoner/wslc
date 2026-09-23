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

  constructor(extensionContext: ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  async activate(): Promise<void> {
    if (this.#providerManager) {
      return;
    }

    const telemetryLogger = env.createTelemetryLogger();
    this.#telemetryLogger = telemetryLogger;
    this.#inversifyBinding = new InversifyBinding(this.#extensionContext, telemetryLogger);

    try {
      this.#container = await this.#inversifyBinding.initBindings();
      const providerManager = await this.#container.getAsync(WslcProviderManager);
      this.#providerManager = providerManager;
    } catch (error: unknown) {
      console.error('WSL Containers extension activation failed', error);
      await this.#providerManager?.deactivate();
      await this.#inversifyBinding.dispose();
      this.#providerManager = undefined;
      this.#container = undefined;
      throw error;
    }

    this.deferActivate().catch((error: unknown) => {
      console.error('error in deferActivate', error);
    });
  }

  async deactivate(): Promise<void> {
    const providerManager = this.#providerManager;
    this.#providerManager = undefined;
    await providerManager?.deactivate();
    await this.#inversifyBinding?.dispose();
    this.#inversifyBinding = undefined;
    this.#container = undefined;
    this.#telemetryLogger = undefined;
  }

  protected async deferActivate(): Promise<void> {
    if (!env.isWindows) {
      this.#telemetryLogger?.logError('invalidPlatform');
      console.warn('WSL Containers extension not started: can only be activated on Windows');
      return;
    }

    console.log('WSL Containers extension activated on Windows');
    this.#telemetryLogger?.logUsage('activated');
    await this.#providerManager?.registerContainerProvider();
  }

  protected getContainer(): Container | undefined {
    return this.#container;
  }
}
