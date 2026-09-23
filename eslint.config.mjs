/*
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
 */

import podmanDesktop from '@podman-desktop/eslint-config';
import js from '@eslint/js';
import globals from 'globals';
import typescript from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...podmanDesktop,
  {
    ignores: ['dist/**', 'node_modules/**', 'build/**', '**/coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.ts'],
    extends: [typescript.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Methods keep an async signature even when they have nothing to await, so callers can
      // treat the provider and bridge managers uniformly.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      // Tests hand method references to matchers (e.g. `expect(obj.method)`), which the rule flags
      // even though nothing is ever called with a different receiver.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
]);
