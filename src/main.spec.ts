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

import type { ExtensionContext } from '@podman-desktop/api';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activate, deactivate } from './main';
import { WslcExtension } from './wslc-extension';

vi.mock(import('./wslc-extension'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const activateMock = vi.mocked(WslcExtension.prototype.activate);
const deactivateMock = vi.mocked(WslcExtension.prototype.deactivate);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  await deactivate();
});

describe('main lifecycle', () => {
  test('creates and activates the extension', async () => {
    await activate(extensionContext);

    expect(activateMock).toHaveBeenCalledOnce();
  });

  test('reuses the same extension instance on repeated activation', async () => {
    await activate(extensionContext);
    await activate(extensionContext);

    expect(WslcExtension).toHaveBeenCalledOnce();
    expect(activateMock).toHaveBeenCalledTimes(2);
  });

  test('clears the extension reference when deactivated before activation', async () => {
    await deactivate();

    expect(deactivateMock).not.toHaveBeenCalled();
    expect((global as Record<string, unknown>).wslcExtension).toBeUndefined();
  });

  test('clears the extension reference when deactivation rejects', async () => {
    await activate(extensionContext);
    deactivateMock.mockRejectedValueOnce(new Error('deactivation failed'));

    await expect(deactivate()).rejects.toThrow('deactivation failed');

    expect((global as Record<string, unknown>).wslcExtension).toBeUndefined();
  });
});
