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
import { env } from '@podman-desktop/api';
import { WslcExtension } from './wslc-extension';
import { WslcProviderManager } from './manager/wslc-provider-manager';

vi.mock(import('./manager/wslc-provider-manager'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;

describe('WslcExtension', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (env as { isWindows: boolean }).isWindows = true;
    vi.mocked(env.createTelemetryLogger).mockReturnValue({
      logError: vi.fn(),
      logUsage: vi.fn(),
    } as unknown as TelemetryLogger);
  });

  it('registers the provider on Windows', async () => {
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(WslcProviderManager.prototype.registerContainerProvider).toHaveBeenCalledOnce();
  });

  it('does not register the provider on non-Windows platforms', async () => {
    (env as { isWindows: boolean }).isWindows = false;
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(WslcProviderManager.prototype.registerContainerProvider).not.toHaveBeenCalled();
  });

  it('delegates cleanup', async () => {
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await extension.deactivate();

    expect(WslcProviderManager.prototype.deactivate).toHaveBeenCalledOnce();
  });
});
