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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InversifyBinding } from './inversify-binding';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from './symbol';
import { WslVersionService } from '../manager/wsl-version-service';
import { WslcProviderManager } from '../manager/wslc-provider-manager';

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = {
  logError: vi.fn(),
  logUsage: vi.fn(),
} as unknown as TelemetryLogger;

describe('InversifyBinding', () => {
  let binding: InversifyBinding;

  beforeEach(() => {
    vi.resetAllMocks();
    binding = new InversifyBinding(extensionContext, telemetryLogger);
  });

  it('loads the manager and its dependencies', async () => {
    const container = await binding.initBindings();

    expect(container.get(ExtensionContextSymbol)).toBe(extensionContext);
    expect(container.get(TelemetryLoggerSymbol)).toBe(telemetryLogger);
    expect(container.get(WslVersionService)).toBeInstanceOf(WslVersionService);
    expect(container.get(WslcProviderManager)).toBeInstanceOf(WslcProviderManager);
  });

  it('disposes the container safely', async () => {
    await binding.initBindings();

    await binding.dispose();
    await binding.dispose();

    expect(true).toBe(true);
  });
});
