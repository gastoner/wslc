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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProxyArtifactManifest } from './download';
import { installLocalProxyPair, installProxyArchive } from './download';

const manifest: ProxyArtifactManifest = {
  formatVersion: 1,
  version: 'v1.0.0',
  sourceRevision: '0123456789abcdef',
  hostArchitecture: 'windows/amd64',
  guestArchitecture: 'linux/amd64',
};

let root: string;
let outputDirectory: string;

function createArchive(manifestValue: unknown = manifest): Buffer {
  const zip = new AdmZip();
  zip.addFile('socktainer.exe', Buffer.from('windows-executable'));
  zip.addFile('docker-relay', Buffer.from('linux-relay'));
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifestValue)));
  return zip.toBuffer();
}

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'wslc-proxy-artifact-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('installProxyArchive', () => {
  beforeEach(async () => {
    outputDirectory = join(root, 'dist', 'bin', 'win32-x64');
  });

  test('verifies and installs the matching binary pair and manifest', async () => {
    const archive = createArchive();
    const checksum = createHash('sha256').update(archive).digest('hex');

    await installProxyArchive(archive, checksum, outputDirectory, 'v1.0.0');

    expect((await readFile(join(outputDirectory, 'socktainer.exe'))).toString()).toBe('windows-executable');
    expect((await readFile(join(outputDirectory, 'docker-relay'))).toString()).toBe('linux-relay');
    expect(JSON.parse((await readFile(join(outputDirectory, 'manifest.json'))).toString())).toEqual(manifest);
  });

  test('rejects a checksum mismatch without installing files', async () => {
    const archive = createArchive();

    await expect(installProxyArchive(archive, '0'.repeat(64), outputDirectory, 'v1.0.0')).rejects.toThrow(
      'checksum mismatch',
    );
    await expect(readFile(outputDirectory)).rejects.toThrow();
  });

  test('rejects an archive manifest for an unsupported guest architecture', async () => {
    const wrongArchitecture = createArchive({ ...manifest, guestArchitecture: 'linux/arm64' });
    const wrongArchitectureHash = createHash('sha256').update(wrongArchitecture).digest('hex');
    await expect(installProxyArchive(wrongArchitecture, wrongArchitectureHash, outputDirectory)).rejects.toThrow(
      'unsupported version or architecture',
    );
  });

  test('rejects an archive that is missing the companion relay', async () => {
    const zip = new AdmZip();
    zip.addFile('socktainer.exe', Buffer.from('exe'));
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const missingRelay = zip.toBuffer();
    const missingRelayHash = createHash('sha256').update(missingRelay).digest('hex');
    await expect(installProxyArchive(missingRelay, missingRelayHash, outputDirectory)).rejects.toThrow(
      'must contain socktainer.exe, docker-relay, and manifest.json',
    );
  });

  test('rejects unsafe archive paths', async () => {
    const zip = new AdmZip();
    zip.addFile('socktainer.exe', Buffer.from('exe'));
    zip.addFile('docker-relay', Buffer.from('relay'));
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    zip.addFile('../outside.txt', Buffer.from('unsafe'));
    const archive = zip.toBuffer();
    const checksum = createHash('sha256').update(archive).digest('hex');

    await expect(installProxyArchive(archive, checksum, outputDirectory)).rejects.toThrow('archive entry');
  });

  test('rejects a release manifest that does not match the pinned version', async () => {
    const archive = createArchive();
    const checksum = createHash('sha256').update(archive).digest('hex');

    await expect(installProxyArchive(archive, checksum, outputDirectory, 'v2.0.0')).rejects.toThrow(
      'does not match pinned version',
    );
    await expect(readFile(outputDirectory)).rejects.toThrow();
  });
});

describe('installLocalProxyPair', () => {
  beforeEach(async () => {
    outputDirectory = join(root, 'extension', 'dist', 'bin', 'win32-x64');
  });

  test('copies binaries with the required host and guest architecture', async () => {
    const sourceDirectory = join(root, 'wslc-proxy');
    await mkdir(sourceDirectory, { recursive: true });
    const executable = Buffer.alloc(0x46);
    executable.write('MZ', 0, 'ascii');
    executable.writeUInt32LE(0x40, 0x3c);
    executable.write('PE\0\0', 0x40, 'binary');
    executable.writeUInt16LE(0x8664, 0x44);
    const relay = Buffer.alloc(20);
    relay.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    relay.writeUInt16LE(0x3e, 18);
    await Promise.all([
      writeFile(join(sourceDirectory, 'socktainer.exe'), executable),
      writeFile(join(sourceDirectory, 'docker-relay'), relay),
    ]);

    await installLocalProxyPair(sourceDirectory, outputDirectory);

    expect(await readFile(join(outputDirectory, 'socktainer.exe'))).toEqual(executable);
    expect(await readFile(join(outputDirectory, 'docker-relay'))).toEqual(relay);
  });

  test('rejects a non-Windows executable without installing it', async () => {
    const sourceDirectory = join(root, 'wslc-proxy');
    await mkdir(sourceDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(sourceDirectory, 'socktainer.exe'), Buffer.from('not a PE executable')),
      writeFile(join(sourceDirectory, 'docker-relay'), Buffer.from('not used')),
    ]);

    await expect(installLocalProxyPair(sourceDirectory, outputDirectory)).rejects.toThrow('Windows/amd64');
    await expect(readFile(outputDirectory)).rejects.toThrow();
  });

  test('rejects a non-Linux relay without installing either binary', async () => {
    const sourceDirectory = join(root, 'wslc-proxy');
    await mkdir(sourceDirectory, { recursive: true });
    const executable = Buffer.alloc(0x46);
    executable.write('MZ', 0, 'ascii');
    executable.writeUInt32LE(0x40, 0x3c);
    executable.write('PE\0\0', 0x40, 'binary');
    executable.writeUInt16LE(0x8664, 0x44);
    await Promise.all([
      writeFile(join(sourceDirectory, 'socktainer.exe'), executable),
      writeFile(join(sourceDirectory, 'docker-relay'), Buffer.from('not an ELF binary')),
    ]);

    await expect(installLocalProxyPair(sourceDirectory, outputDirectory)).rejects.toThrow('Linux/amd64');
    await expect(readFile(outputDirectory)).rejects.toThrow();
  });
});
