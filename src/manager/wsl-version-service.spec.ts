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

import { describe, expect, it } from 'vitest';
import { WslVersionService } from './wsl-version-service';

describe('WslVersionService', () => {
  const service = new WslVersionService();

  it('parses the WSL version line', () => {
    expect(service.parseWslVersion('WSL version: 2.9.3.0\nKernel version: 6.6.')).toBe('2.9.3.0');
  });

  it('returns undefined for unrecognized output', () => {
    expect(service.parseWslVersion('Windows version: 11.0.1')).toBeUndefined();
  });

  it('accepts the minimum and newer WSL versions', () => {
    expect(service.minimumVersion).toBe('2.9.3');
    expect(service.isSupportedWslVersion('2.9.3')).toBe(true);
    expect(service.isSupportedWslVersion('2.10.0.0')).toBe(true);
  });

  it('rejects older and malformed WSL versions', () => {
    expect(service.isSupportedWslVersion('2.9.2.0')).toBe(false);
    expect(service.isSupportedWslVersion('not-a-version')).toBe(false);
  });
});
