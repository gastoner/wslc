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

describe('bridgeConfiguration artifact metadata', () => {
  test('defines the artifact repository, archive, and binary names', () => {
    expect(bridgeConfiguration.repository).toBe('https://github.com/l0rd/wslc-proxy');
    expect(bridgeConfiguration.assetName).toBe('wslc-proxy-windows-amd64-linux-amd64.zip');
    expect(bridgeConfiguration.executableName).toBe('socktainer.exe');
    expect(bridgeConfiguration.relayName).toBe('docker-relay');
  });
});

describe('bridgeConfiguration bridge endpoints', () => {
  test('defines the Socktainer TCP endpoint', () => {
    expect(bridgeConfiguration.host).toBe('localhost');
    expect(bridgeConfiguration.port).toBe(2375);
  });

  test('defines the WSLC named pipe', () => {
    expect(bridgeConfiguration.pipeName).toBe(String.raw`\\.\pipe\wslc_engine`);
  });
});

describe('bridgeConfiguration monitoring and timeout settings', () => {
  test('defines the operational timeouts and retry limit', () => {
    expect(bridgeConfiguration.startupTimeoutMs).toBe(180_000);
    expect(bridgeConfiguration.requestTimeoutMs).toBe(5_000);
    expect(bridgeConfiguration.readinessPollIntervalMs).toBe(250);
    expect(bridgeConfiguration.shutdownTimeoutMs).toBe(10_000);
    expect(bridgeConfiguration.maxConsecutiveStartupFailures).toBe(3);
  });

  test('refreshes provider status every 30 seconds', () => {
    expect(bridgeConfiguration.refreshIntervalMs).toBe(30_000);
  });
});
