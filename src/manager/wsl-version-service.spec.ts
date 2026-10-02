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
import { WslVersionService } from './wsl-version-service';

const service = new WslVersionService();

beforeEach(() => {
  vi.resetAllMocks();
});

describe('WslVersionService.parseWslVersion', () => {
  test('parses the WSL version line', () => {
    expect(service.parseWslVersion('WSL version: 2.9.3.0\nKernel version: 6.6.')).toBe('2.9.3.0');
  });

  test('returns undefined for unrecognized output', () => {
    expect(service.parseWslVersion('Windows version: 11.0.1')).toBeUndefined();
  });
});

describe('WslVersionService.isSupportedWslVersion', () => {
  test('uses 2.9.3 as the minimum supported WSL version', () => {
    expect(service.minimumVersion).toBe('2.9.3');
  });

  test.each([
    ['2.9.3', 'the minimum version'],
    ['2.10.0.0', 'a newer version'],
  ])('accepts %s as %s', (version) => {
    expect(service.isSupportedWslVersion(version)).toBeTruthy();
  });

  test.each([
    ['2.9.2.0', 'an older version'],
    ['not-a-version', 'malformed input'],
  ])('rejects %s as %s', (version) => {
    expect(service.isSupportedWslVersion(version)).toBeFalsy();
  });
});
