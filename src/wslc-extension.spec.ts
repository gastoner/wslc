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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '@podman-desktop/api';
import { WslcExtension } from './wslc-extension';
import { WslcProviderManager } from './manager/wslc-provider-manager';

vi.mock(import('./manager/wslc-provider-manager'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = {
  logError: vi.fn(),
  logUsage: vi.fn(),
} as unknown as TelemetryLogger;
const registerContainerProviderMock = vi.mocked(WslcProviderManager.prototype.registerContainerProvider);
const deactivateProviderManagerMock = vi.mocked(WslcProviderManager.prototype.deactivate);

beforeEach(() => {
  vi.resetAllMocks();
  (env as { isWindows: boolean }).isWindows = true;
  vi.mocked(env.createTelemetryLogger).mockReturnValue(telemetryLogger);
});

afterEach(() => {
  (env as { isWindows: boolean }).isWindows = true;
});

describe('WslcExtension', () => {
  test('registers the provider on Windows', async () => {
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(registerContainerProviderMock).toHaveBeenCalledOnce();
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('activated');
  });

  test('does not register the provider on non-Windows platforms', async () => {
    (env as { isWindows: boolean }).isWindows = false;
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(registerContainerProviderMock).not.toHaveBeenCalled();
    expect(telemetryLogger.logError).toHaveBeenCalledWith('invalidPlatform');
  });

  test('deactivates the provider manager when the extension is deactivated', async () => {
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await extension.deactivate();

    expect(deactivateProviderManagerMock).toHaveBeenCalledOnce();
  });
});
