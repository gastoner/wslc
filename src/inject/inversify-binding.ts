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

import type { ExtensionContext, TelemetryLogger } from '@podman-desktop/api';
import { Container } from 'inversify';
import { managersModule } from '../manager/manager-module';
import { WslcProviderManager } from '../manager/wslc-provider-manager';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from './symbol';

export class InversifyBinding {
  #container: Container | undefined;

  constructor(
    readonly extensionContext: ExtensionContext,
    readonly telemetryLogger: TelemetryLogger,
  ) {}

  async initBindings(): Promise<Container> {
    this.#container = new Container();
    this.#container.bind(ExtensionContextSymbol).toConstantValue(this.extensionContext);
    this.#container.bind(TelemetryLoggerSymbol).toConstantValue(this.telemetryLogger);
    await this.#container.load(managersModule);
    await this.#container.getAsync(WslcProviderManager);
    return this.#container;
  }

  async dispose(): Promise<void> {
    if (this.#container) {
      await this.#container.unbindAll();
      this.#container = undefined;
    }
  }
}
