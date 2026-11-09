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

import { isBuiltin } from 'node:module';
import { join } from 'node:path';

import { defineConfig } from 'vite';

const packageRoot = import.meta.dirname;

export default defineConfig({
  root: packageRoot,
  build: {
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
    assetsDir: '.',
    lib: {
      entry: join(packageRoot, 'src/extension.ts'),
      formats: ['cjs'],
    },
    rolldownOptions: {
      external: (id: string): boolean => id === '@podman-desktop/api' || isBuiltin(id),
      output: {
        entryFileNames: '[name].cjs',
      },
    },
    emptyOutDir: true,
    reportCompressedSize: false,
  },
});
