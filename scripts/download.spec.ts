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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BRIDGE_ARTIFACT_SHA256, type BridgeArtifactPins } from '../src/config/bridge-artifacts';
import { resolveBridgeArtifactDirectory, stageBridgeArtifacts } from './download';

const AMD64_FILE = 'wslc-bridge-windows-amd64.exe';
const ARM64_FILE = 'wslc-bridge-windows-arm64.exe';
const amd64Executable = createPeExecutable(0x8664);
const arm64Executable = createPeExecutable(0xaa64);
const fixturePins: BridgeArtifactPins = {
  amd64: sha256(amd64Executable),
  arm64: sha256(arm64Executable),
};

let root: string;
let sourceDirectory: string;
let outputBinDirectory: string;

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function createPeExecutable(machine: number): Buffer {
  const executable = Buffer.alloc(0x46);
  executable.write('MZ', 0, 'ascii');
  executable.writeUInt32LE(0x40, 0x3c);
  executable.write('PE\0\0', 0x40, 'binary');
  executable.writeUInt16LE(machine, 0x44);
  return executable;
}

function createManifest(
  amd64: Buffer = amd64Executable,
  arm64: Buffer = arm64Executable,
  artifacts?: unknown[],
): unknown {
  return {
    schemaVersion: 1,
    version: 'bridge-fixture',
    commit: '0123456789abcdef',
    buildDate: '2026-10-13T17:52:21Z',
    artifacts: artifacts ?? [
      { os: 'windows', arch: 'amd64', file: AMD64_FILE, sha256: sha256(amd64) },
      { os: 'windows', arch: 'arm64', file: ARM64_FILE, sha256: sha256(arm64) },
    ],
  };
}

function createChecksums(amd64: Buffer = amd64Executable, arm64: Buffer = arm64Executable): string {
  return `${sha256(amd64)}  ${AMD64_FILE}\n${sha256(arm64)}  ${ARM64_FILE}\n`;
}

async function writeArtifactFixture(
  options: { manifest?: unknown; checksums?: string; amd64?: Buffer; arm64?: Buffer } = {},
): Promise<void> {
  const amd64 = options.amd64 ?? amd64Executable;
  const arm64 = options.arm64 ?? arm64Executable;
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(sourceDirectory, AMD64_FILE), amd64),
    writeFile(join(sourceDirectory, ARM64_FILE), arm64),
    writeFile(
      join(sourceDirectory, 'bridge-manifest.json'),
      JSON.stringify(options.manifest ?? createManifest(amd64, arm64)),
    ),
    writeFile(join(sourceDirectory, 'checksums.txt'), options.checksums ?? createChecksums(amd64, arm64)),
  ]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wslc-bridge-artifacts-test-'));
  sourceDirectory = join(root, 'source');
  outputBinDirectory = join(root, 'dist', 'bin');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stageBridgeArtifacts', () => {
  test('validates and stages both pinned PE architectures and the source metadata', async () => {
    await writeArtifactFixture();

    await stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins);

    expect(await readFile(join(outputBinDirectory, 'win32-x64', 'wslc-bridge.exe'))).toEqual(amd64Executable);
    expect(await readFile(join(outputBinDirectory, 'win32-arm64', 'wslc-bridge.exe'))).toEqual(arm64Executable);
    expect(await readFile(join(outputBinDirectory, 'bridge-manifest.json'), 'utf8')).toBe(
      JSON.stringify(createManifest()),
    );
    expect(await readFile(join(outputBinDirectory, 'checksums.txt'), 'utf8')).toBe(createChecksums());
  });

  test('uses the checked-in per-architecture digest pins', () => {
    expect(BRIDGE_ARTIFACT_SHA256).toEqual({
      amd64: 'aa9f165652f28ed6d8011326bc088a1618b3cd3a57fa86b4e83e742a3378eb17',
      arm64: '45c77a377a73d001d2fd1774d3ef614269b7d41758c4b1f65740e89d5445567a',
    });
  });

  test('requires a non-empty manifest version without pinning its value', async () => {
    await writeArtifactFixture({ manifest: { ...(createManifest() as object), version: '' } });

    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'invalid metadata',
    );
    await expect(readFile(outputBinDirectory)).rejects.toThrow();
  });

  test('rejects manifest entries that are missing, duplicated, or use an unsafe filename', async () => {
    const onlyAmd64 = createManifest(amd64Executable, arm64Executable, [
      { os: 'windows', arch: 'amd64', file: AMD64_FILE, sha256: sha256(amd64Executable) },
    ]);
    await writeArtifactFixture({ manifest: onlyAmd64 });
    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'exactly one Windows/amd64 and one Windows/arm64',
    );

    const duplicateAmd64 = createManifest(amd64Executable, arm64Executable, [
      { os: 'windows', arch: 'amd64', file: AMD64_FILE, sha256: sha256(amd64Executable) },
      { os: 'windows', arch: 'amd64', file: AMD64_FILE, sha256: sha256(amd64Executable) },
    ]);
    await writeArtifactFixture({ manifest: duplicateAmd64 });
    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'duplicate Windows/amd64',
    );

    const unsafeFilename = createManifest(amd64Executable, arm64Executable, [
      { os: 'windows', arch: 'amd64', file: '../outside.exe', sha256: sha256(amd64Executable) },
      { os: 'windows', arch: 'arm64', file: ARM64_FILE, sha256: sha256(arm64Executable) },
    ]);
    await writeArtifactFixture({ manifest: unsafeFilename });
    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'unexpected filename',
    );
  });

  test('rejects malformed checksums and manifest/checksum digest mismatches', async () => {
    await writeArtifactFixture({ checksums: `${sha256(amd64Executable)}  ${AMD64_FILE}\n` });
    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'exactly one checksum for each',
    );

    await writeArtifactFixture({
      checksums: `${sha256(amd64Executable)}  ${AMD64_FILE}\n${'0'.repeat(64)}  ${ARM64_FILE}\n`,
    });
    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, fixturePins)).rejects.toThrow(
      'Manifest/checksum mismatch',
    );
  });

  test('rejects a digest that differs from the static architecture pin', async () => {
    await writeArtifactFixture();

    await expect(
      stageBridgeArtifacts(sourceDirectory, outputBinDirectory, { ...fixturePins, arm64: '0'.repeat(64) }),
    ).rejects.toThrow('SHA-256 pin mismatch for Windows/arm64');
    await expect(readFile(outputBinDirectory)).rejects.toThrow();
  });

  test('rejects an executable whose PE machine does not match its manifest architecture', async () => {
    const wrongArm64Executable = createPeExecutable(0x8664);
    await writeArtifactFixture({ arm64: wrongArm64Executable });
    const pins = { ...fixturePins, arm64: sha256(wrongArm64Executable) };

    await expect(stageBridgeArtifacts(sourceDirectory, outputBinDirectory, pins)).rejects.toThrow(
      'not a valid Windows PE executable for arm64',
    );
    await expect(readFile(outputBinDirectory)).rejects.toThrow();
  });

  test('leaves the existing output untouched when validation of the second binary fails', async () => {
    const wrongArm64Executable = createPeExecutable(0x8664);
    await writeArtifactFixture({ arm64: wrongArm64Executable });
    const previousAmd64 = Buffer.from('existing-amd64');
    const previousArm64 = Buffer.from('existing-arm64');
    await mkdir(join(outputBinDirectory, 'win32-x64'), { recursive: true });
    await mkdir(join(outputBinDirectory, 'win32-arm64'), { recursive: true });
    await Promise.all([
      writeFile(join(outputBinDirectory, 'win32-x64', 'wslc-bridge.exe'), previousAmd64),
      writeFile(join(outputBinDirectory, 'win32-arm64', 'wslc-bridge.exe'), previousArm64),
    ]);

    await expect(
      stageBridgeArtifacts(sourceDirectory, outputBinDirectory, {
        ...fixturePins,
        arm64: sha256(wrongArm64Executable),
      }),
    ).rejects.toThrow('not a valid Windows PE executable for arm64');

    expect(await readFile(join(outputBinDirectory, 'win32-x64', 'wslc-bridge.exe'))).toEqual(previousAmd64);
    expect(await readFile(join(outputBinDirectory, 'win32-arm64', 'wslc-bridge.exe'))).toEqual(previousArm64);
  });
});

describe('resolveBridgeArtifactDirectory', () => {
  test('uses the explicit local artifact directory first', async () => {
    expect(await resolveBridgeArtifactDirectory(root, join(root, 'custom-artifacts'))).toBe(
      join(root, 'custom-artifacts'),
    );
  });

  test('prefers build/bridge-artifacts when it contains the manifest', async () => {
    const buildArtifactDirectory = join(root, 'build', 'bridge-artifacts');
    await mkdir(buildArtifactDirectory, { recursive: true });
    await writeFile(join(buildArtifactDirectory, 'bridge-manifest.json'), '{}');

    expect(await resolveBridgeArtifactDirectory(root, undefined)).toBe(buildArtifactDirectory);
  });

  test('falls back to the sibling bridge dist directory when no build manifest exists', async () => {
    expect(await resolveBridgeArtifactDirectory(root, undefined)).toBe(join(root, '..', 'wslc-bridge', 'dist'));
  });
});
