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
import type { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '@podman-desktop/api';
import { InversifyBinding } from './inject/inversify-binding';
import { WslcExtension } from './wslc-extension';
import { WslcProviderManager } from './manager/wslc-provider-manager';

vi.mock(import('./inject/inversify-binding'));
vi.mock(import('./manager/wslc-provider-manager'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = {
  logError: vi.fn(),
  logUsage: vi.fn(),
} as unknown as TelemetryLogger;
const registerContainerProviderMock = vi.mocked(WslcProviderManager.prototype.registerContainerProvider);
const deactivateProviderManagerMock = vi.mocked(WslcProviderManager.prototype.deactivate);
const initBindingsMock = vi.mocked(InversifyBinding.prototype.initBindings);
const disposeBindingsMock = vi.mocked(InversifyBinding.prototype.dispose);

function setupBindings(providerManager = new WslcProviderManager()): Container {
  const container = {
    getAsync: vi.fn().mockResolvedValue(providerManager),
  } as unknown as Container;
  initBindingsMock.mockResolvedValue(container);
  return container;
}

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
    setupBindings();
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(registerContainerProviderMock).toHaveBeenCalledOnce();
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('activated');
  });

  test('reuses the in-flight activation on Windows', async () => {
    setupBindings();
    const extension = new WslcExtension(extensionContext);

    await Promise.all([extension.activate(), extension.activate()]);

    expect(InversifyBinding).toHaveBeenCalledOnce();
    expect(initBindingsMock).toHaveBeenCalledOnce();
    expect(registerContainerProviderMock).toHaveBeenCalledOnce();
  });

  test('does not initialize bindings or the provider manager off Windows', async () => {
    (env as { isWindows: boolean }).isWindows = false;
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(registerContainerProviderMock).not.toHaveBeenCalled();
    expect(InversifyBinding).not.toHaveBeenCalled();
    expect(WslcProviderManager).not.toHaveBeenCalled();
    expect(telemetryLogger.logError).toHaveBeenCalledWith('invalidPlatform');
  });

  test('deactivation during DI initialization prevents deferred registration and disposes bindings once', async () => {
    let finishInitialization!: (container: Container) => void;
    initBindingsMock.mockReturnValueOnce(
      new Promise<Container>((resolve) => {
        finishInitialization = resolve;
      }),
    );
    const providerManager = new WslcProviderManager();
    const container = {
      getAsync: vi.fn().mockResolvedValue(providerManager),
    } as unknown as Container;
    const extension = new WslcExtension(extensionContext);

    const activation = extension.activate();
    const deactivation = extension.deactivate();
    finishInitialization(container);

    await Promise.all([activation, deactivation]);

    expect(registerContainerProviderMock).not.toHaveBeenCalled();
    expect(disposeBindingsMock).toHaveBeenCalledOnce();
  });

  test('deactivation while deferred activation is pending prevents later registration', async () => {
    let notifyDeferredStarted!: () => void;
    let resumeDeferred!: () => void;
    const deferredStarted = new Promise<void>((resolve) => {
      notifyDeferredStarted = resolve;
    });
    const deferredGate = new Promise<void>((resolve) => {
      resumeDeferred = resolve;
    });
    class PausedDeferredActivation extends WslcExtension {
      protected override async deferActivate(): Promise<void> {
        notifyDeferredStarted();
        await deferredGate;
        await super.deferActivate();
      }
    }

    setupBindings();
    const extension = new PausedDeferredActivation(extensionContext);
    await extension.activate();
    await deferredStarted;

    const deactivation = extension.deactivate();
    resumeDeferred();
    await deactivation;

    expect(registerContainerProviderMock).not.toHaveBeenCalled();
    expect(disposeBindingsMock).toHaveBeenCalledOnce();
  });

  test('disposes bindings when activation fails', async () => {
    initBindingsMock.mockRejectedValueOnce(new Error('binding initialization failed'));
    const extension = new WslcExtension(extensionContext);

    await expect(extension.activate()).rejects.toThrow('binding initialization failed');

    expect(disposeBindingsMock).toHaveBeenCalledOnce();
  });

  test('deactivates the provider manager when the extension is deactivated', async () => {
    setupBindings();
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await extension.deactivate();

    expect(deactivateProviderManagerMock).toHaveBeenCalledOnce();
  });

  test('disposes bindings even when provider manager deactivation rejects', async () => {
    setupBindings();
    deactivateProviderManagerMock.mockRejectedValueOnce(new Error('provider deactivation failed'));
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await expect(extension.deactivate()).rejects.toThrow('provider deactivation failed');

    expect(disposeBindingsMock).toHaveBeenCalledOnce();
  });
});
