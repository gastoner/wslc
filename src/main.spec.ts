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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from './main';
import { WslcExtension } from './wslc-extension';

vi.mock(import('./wslc-extension'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;

describe('main lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await deactivate();
  });

  it('activates the extension on Windows', async () => {
    await activate(extensionContext);

    expect(WslcExtension.prototype.activate).toHaveBeenCalledOnce();
  });

  it('reuses the same extension instance on repeated activation', async () => {
    await activate(extensionContext);
    await activate(extensionContext);

    expect(WslcExtension).toHaveBeenCalledOnce();
    expect(WslcExtension.prototype.activate).toHaveBeenCalledTimes(2);
  });

  it('deactivates safely before activation', async () => {
    await deactivate();

    expect((global as Record<string, unknown>).wslcExtension).toBeUndefined();
  });
});
