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

import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { bridgeConfiguration } from '../src/config/bridge-config';

const optional = process.argv.includes('--optional');
const { repository, version, assetName, sha256, executableName } = bridgeConfiguration;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, '..', 'dist', 'bin');
const outputPath = join(outputDirectory, executableName);

class Downloader {
  async downloadAndExtract(): Promise<void> {
    if (!version || !assetName || !sha256) {
      if (optional) {
        console.warn('WSLC bridge release is not configured; skipping optional download');
        return;
      }
      throw new Error(
        `WSLC bridge release is not configured. Set the pinned release version, asset name, and SHA-256 after #1113 publishes the binary. Source prototype: ${repository}`,
      );
    }

    await mkdir(outputDirectory, { recursive: true });
    const archivePath = join(outputDirectory, `${assetName}.download`);
    const downloadUrl = `${repository}/releases/download/${version}/${assetName}`;

    try {
      await this.downloadFile(downloadUrl, archivePath);
      await this.verifyChecksum(archivePath, sha256);
      if (assetName.toLowerCase().endsWith('.exe')) {
        await copyFile(archivePath, outputPath);
      } else {
        await this.extractZip(archivePath, outputDirectory);
      }
      await access(outputPath);
    } finally {
      await unlink(archivePath).catch(() => undefined);
    }
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${url} (${response.status})`);
    }

    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }

  private async verifyChecksum(filePath: string, expectedSha256: string): Promise<void> {
    const contents = await readFile(filePath);
    const actualSha256 = createHash('sha256').update(contents).digest('hex');
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new Error(`Bridge checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
    }
  }

  private async extractZip(filePath: string, targetDirectory: string): Promise<void> {
    const archive = new AdmZip(filePath);
    for (const entry of archive.getEntries()) {
      const entryPath = resolve(targetDirectory, entry.entryName);
      const relativePath = relative(targetDirectory, entryPath);
      if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || relativePath.includes(`..${sep}`)) {
        throw new Error(`Refusing to extract unsafe archive path: ${entry.entryName}`);
      }
      if (!entry.isDirectory && basename(entry.entryName) === executableName) {
        archive.extractEntryTo(entry, targetDirectory, false, true);
      }
    }
  }
}

new Downloader().downloadAndExtract().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
