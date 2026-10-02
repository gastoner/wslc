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
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { bridgeConfiguration } from '../src/config/bridge-config';

export interface ProxyArtifactManifest {
  formatVersion: 1;
  version: string;
  sourceRevision: string;
  hostArchitecture: 'windows/amd64';
  guestArchitecture: 'linux/amd64';
}

const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024;
const MAX_EXECUTABLE_SIZE = 128 * 1024 * 1024;
const MAX_RELAY_SIZE = 128 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 64 * 1024;

export class Downloader {
  async downloadAndExtract(): Promise<void> {
    const localArchive = process.env.WSLC_PROXY_ARCHIVE;
    const localBinaryDirectory = process.env.WSLC_PROXY_BIN_DIR;
    const version = process.env.WSLC_PROXY_VERSION ?? bridgeConfiguration.version;
    const expectedSha256 = process.env.WSLC_PROXY_SHA256 ?? bridgeConfiguration.sha256;
    const assetName = bridgeConfiguration.assetName;

    if (!assetName) {
      throw new Error('WSLC proxy asset name is not configured');
    }
    const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'win32-x64');
    if (localBinaryDirectory) {
      await installLocalProxyPair(resolve(localBinaryDirectory), outputDirectory);
      return;
    }
    if (localArchive) {
      if (!expectedSha256 || !/^[a-f\d]{64}$/i.test(expectedSha256)) {
        throw new Error('WSLC_PROXY_SHA256 must provide the local proxy ZIP SHA-256');
      }
      const localPath = resolve(localArchive);
      const file = await stat(localPath);
      if (file.size > MAX_ARCHIVE_SIZE) {
        throw new Error('Socktainer release archive exceeds 512 MiB');
      }
      await installProxyArchive(await readFile(localPath), expectedSha256, outputDirectory, version);
      return;
    }

    if (version && expectedSha256) {
      if (!/^[a-f\d]{64}$/i.test(expectedSha256)) {
        throw new Error('WSLC_PROXY_SHA256 must contain exactly 64 hexadecimal characters');
      }
      const archive = await this.downloadRelease(version, assetName);
      await installProxyArchive(archive, expectedSha256, outputDirectory, version);
      return;
    }

    const siblingProxyDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wslc-proxy');
    await installLocalProxyPair(siblingProxyDirectory, outputDirectory);
  }

  private async downloadRelease(version: string, assetName: string): Promise<Buffer> {
    const url = `${bridgeConfiguration.repository}/releases/download/${encodeURIComponent(version)}/${assetName}`;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download pinned Socktainer asset (${response.status})`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalLength += value.byteLength;
      if (totalLength > MAX_ARCHIVE_SIZE) {
        await reader.cancel();
        throw new Error('Socktainer release archive exceeds 512 MiB');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, totalLength);
  }
}

export async function installLocalProxyPair(sourceDirectory: string, outputDirectory: string): Promise<void> {
  const executable = await readFile(join(sourceDirectory, 'socktainer.exe')).catch(() => {
    throw new Error(`socktainer.exe was not found in ${sourceDirectory}`);
  });
  const relay = await readFile(join(sourceDirectory, 'docker-relay')).catch(() => {
    throw new Error(`docker-relay was not found in ${sourceDirectory}`);
  });
  if (!isWindowsAMD64Executable(executable)) {
    throw new Error('socktainer.exe must be built for Windows/amd64 from the wslc-proxy repository');
  }
  if (!isLinuxAMD64Executable(relay)) {
    throw new Error('docker-relay must be built for Linux/amd64 from the wslc-proxy repository');
  }
  await replaceProxyFiles(outputDirectory, {
    'socktainer.exe': executable,
    'docker-relay': relay,
  });
}

function isWindowsAMD64Executable(contents: Buffer): boolean {
  if (contents.length < 0x40 || contents.toString('ascii', 0, 2) !== 'MZ') {
    return false;
  }
  const headerOffset = contents.readUInt32LE(0x3c);
  return (
    headerOffset + 6 <= contents.length &&
    contents.toString('ascii', headerOffset, headerOffset + 4) === 'PE\0\0' &&
    contents.readUInt16LE(headerOffset + 4) === 0x8664
  );
}

function isLinuxAMD64Executable(contents: Buffer): boolean {
  return (
    contents.length >= 20 &&
    contents[0] === 0x7f &&
    contents.toString('ascii', 1, 4) === 'ELF' &&
    contents[4] === 2 &&
    contents[5] === 1 &&
    contents.readUInt16LE(18) === 0x3e
  );
}

export async function installProxyArchive(
  archive: Buffer,
  expectedSha256: string,
  outputDirectory: string,
  expectedVersion?: string,
): Promise<void> {
  if (archive.length > MAX_ARCHIVE_SIZE) {
    throw new Error('Socktainer release archive exceeds 512 MiB');
  }
  const actualSha256 = createHash('sha256').update(archive).digest('hex');
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Socktainer checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
  }

  const entries = new Map<string, Buffer>();
  for (const entry of new AdmZip(archive).getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const name = entry.entryName;
    if (basename(name) !== name || name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new Error(`Refusing unsafe Socktainer archive path: ${name}`);
    }
    if (!['socktainer.exe', 'docker-relay', 'manifest.json'].includes(name)) {
      throw new Error(`Unexpected Socktainer archive entry: ${name}`);
    }
    if (entries.has(name)) {
      throw new Error(`Socktainer archive contains duplicate ${name}`);
    }
    const maximumSize =
      name === 'socktainer.exe' ? MAX_EXECUTABLE_SIZE : name === 'docker-relay' ? MAX_RELAY_SIZE : MAX_MANIFEST_SIZE;
    if (entry.header.size <= 0 || entry.header.size > maximumSize) {
      throw new Error(`Socktainer archive entry ${name} has an invalid size`);
    }
    const contents = entry.getData();
    if (contents.length === 0 || contents.length > maximumSize) {
      throw new Error(`Socktainer archive entry ${name} has an invalid size`);
    }
    entries.set(name, contents);
  }

  const executable = entries.get('socktainer.exe');
  const relay = entries.get('docker-relay');
  const manifestContents = entries.get('manifest.json');
  if (!executable || !relay || !manifestContents) {
    throw new Error('Socktainer ZIP must contain socktainer.exe, docker-relay, and manifest.json at its root');
  }

  let manifest: ProxyArtifactManifest;
  try {
    manifest = JSON.parse(manifestContents.toString('utf8')) as ProxyArtifactManifest;
  } catch {
    throw new Error('Socktainer manifest.json is invalid JSON');
  }
  if (
    manifest.formatVersion !== 1 ||
    !manifest.version ||
    !manifest.sourceRevision ||
    manifest.hostArchitecture !== 'windows/amd64' ||
    manifest.guestArchitecture !== 'linux/amd64'
  ) {
    throw new Error('Socktainer manifest has an unsupported version or architecture');
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`Socktainer manifest version ${manifest.version} does not match pinned version ${expectedVersion}`);
  }

  await replaceProxyFiles(outputDirectory, {
    'socktainer.exe': executable,
    'docker-relay': relay,
    'manifest.json': manifestContents,
  });
}

async function replaceProxyFiles(outputDirectory: string, files: Record<string, Buffer>): Promise<void> {
  const parentDirectory = dirname(outputDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(parentDirectory, '.socktainer-staging-'));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) => writeFile(join(stagingDirectory, name), contents)),
    );
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, outputDirectory);
    await Promise.all([
      access(join(outputDirectory, 'socktainer.exe')),
      access(join(outputDirectory, 'docker-relay')),
      ...(files['manifest.json'] ? [access(join(outputDirectory, 'manifest.json'))] : []),
    ]);
  } catch (error: unknown) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  new Downloader().downloadAndExtract().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
