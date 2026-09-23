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

import { vi } from 'vitest';

export const env = {
  isWindows: true,
  createTelemetryLogger: vi.fn(() => ({
    logError: vi.fn(),
    logUsage: vi.fn(),
  })),
};

export const process = {
  exec: vi.fn(async () => ({ stdout: 'wslc 0.1.0', stderr: '' })),
};

export const provider = {
  createProvider: vi.fn(() => ({
    updateStatus: vi.fn(),
    updateVersion: vi.fn(),
    registerUpdate: vi.fn(() => ({ dispose: vi.fn() })),
    registerContainerProviderConnection: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
};
