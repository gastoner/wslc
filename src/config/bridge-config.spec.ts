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

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeConfiguration } from './bridge-config';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('bridgeConfiguration runtime', () => {
  test('defines the bridge binary and WSLC pipe', () => {
    expect(bridgeConfiguration.executableName).toBe('wslc-bridge.exe');
    expect(bridgeConfiguration.pipeName).toBe(String.raw`\\.\pipe\wslc_engine`);
  });
});

describe('bridgeConfiguration monitoring and timeout settings', () => {
  test('defines the operational timeouts and retry limit', () => {
    expect(bridgeConfiguration.startupTimeoutMs).toBe(180_000);
    expect(bridgeConfiguration.requestTimeoutMs).toBe(5_000);
    expect(bridgeConfiguration.shutdownTimeoutMs).toBe(10_000);
    expect(bridgeConfiguration.maxConsecutiveStartupFailures).toBe(3);
  });

  test('refreshes provider status every 30 seconds', () => {
    expect(bridgeConfiguration.refreshIntervalMs).toBe(30_000);
  });
});
