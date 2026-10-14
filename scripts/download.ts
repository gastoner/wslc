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
import type { Stats } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_ARTIFACT_SHA256,
  type BridgeArchitecture,
  type BridgeArtifactPins,
} from '../src/config/bridge-artifacts';

export interface BridgeManifestArtifact {
  os: 'windows';
  arch: BridgeArchitecture;
  file: string;
  sha256: string;
}

export interface BridgeArtifactManifest {
  schemaVersion: 1;
  version: string;
  commit: string;
  buildDate: string;
  artifacts: BridgeManifestArtifact[];
}

const MAX_EXECUTABLE_SIZE = 128 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 64 * 1024;
const MAX_CHECKSUMS_SIZE = 4 * 1024;

const ARTIFACTS: Readonly<Record<BridgeArchitecture, { file: string; outputDirectory: string; machine: number }>> = {
  amd64: { file: 'wslc-bridge-windows-amd64.exe', outputDirectory: 'win32-x64', machine: 0x8664 },
  arm64: { file: 'wslc-bridge-windows-arm64.exe', outputDirectory: 'win32-arm64', machine: 0xaa64 },
};

export async function resolveBridgeArtifactDirectory(
  extensionRoot: string,
  environmentDirectory: string | undefined = process.env.WSLC_BRIDGE_ARTIFACT_DIR,
): Promise<string> {
  if (environmentDirectory !== undefined) {
    if (!environmentDirectory.trim()) {
      throw new Error('WSLC_BRIDGE_ARTIFACT_DIR must name a local artifact directory');
    }
    return resolve(environmentDirectory);
  }

  const buildArtifactDirectory = join(extensionRoot, 'build', 'bridge-artifacts');
  if (await isRegularFile(join(buildArtifactDirectory, 'bridge-manifest.json'))) {
    return buildArtifactDirectory;
  }

  return resolve(extensionRoot, '..', 'wslc-bridge', 'dist');
}

export async function stageBridgeArtifacts(
  sourceDirectory: string,
  outputBinDirectory: string,
  pins: BridgeArtifactPins = BRIDGE_ARTIFACT_SHA256,
): Promise<void> {
  const manifestContents = await readBoundedFile(
    join(sourceDirectory, 'bridge-manifest.json'),
    MAX_MANIFEST_SIZE,
    'bridge-manifest.json',
  );
  const checksumsContents = await readBoundedFile(
    join(sourceDirectory, 'checksums.txt'),
    MAX_CHECKSUMS_SIZE,
    'checksums.txt',
  );
  const manifest = parseManifest(manifestContents);
  validateManifest(manifest);
  const checksums = parseChecksums(checksumsContents);
  const artifacts = new Map<BridgeArchitecture, Buffer>();

  for (const architecture of ['amd64', 'arm64'] as const) {
    const artifact = manifest.artifacts.find((candidate) => candidate.arch === architecture);
    const expectedArtifact = ARTIFACTS[architecture];
    if (!artifact) {
      throw new Error(`bridge-manifest.json is missing the Windows/${architecture} artifact`);
    }

    const checksum = checksums.get(expectedArtifact.file);
    if (!checksum) {
      throw new Error(`checksums.txt is missing ${expectedArtifact.file}`);
    }
    const pinnedChecksum = pins[architecture];
    if (!/^[a-f\d]{64}$/i.test(pinnedChecksum)) {
      throw new Error(`The pinned Windows/${architecture} SHA-256 is invalid`);
    }
    if (artifact.sha256 !== checksum) {
      throw new Error(`Manifest/checksum mismatch for ${expectedArtifact.file}`);
    }
    if (artifact.sha256 !== pinnedChecksum.toLowerCase()) {
      throw new Error(`SHA-256 pin mismatch for Windows/${architecture}: expected ${pinnedChecksum}`);
    }

    const executable = await readBoundedFile(
      join(sourceDirectory, expectedArtifact.file),
      MAX_EXECUTABLE_SIZE,
      expectedArtifact.file,
    );
    const actualChecksum = createHash('sha256').update(executable).digest('hex');
    if (actualChecksum !== artifact.sha256) {
      throw new Error(`Executable checksum mismatch for ${expectedArtifact.file}`);
    }
    if (!isWindowsExecutableForMachine(executable, expectedArtifact.machine)) {
      throw new Error(`${expectedArtifact.file} is not a valid Windows PE executable for ${architecture}`);
    }
    artifacts.set(architecture, executable);
  }

  await replaceStagedArtifacts(outputBinDirectory, artifacts, manifestContents, checksumsContents);
}

function parseManifest(contents: Buffer): BridgeArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString('utf8')) as unknown;
  } catch {
    throw new Error('bridge-manifest.json is invalid JSON');
  }

  if (!isRecord(parsed) || !hasExactKeys(parsed, ['schemaVersion', 'version', 'commit', 'buildDate', 'artifacts'])) {
    throw new Error('bridge-manifest.json does not match the required schema');
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.version !== 'string' ||
    typeof parsed.commit !== 'string' ||
    typeof parsed.buildDate !== 'string' ||
    !Array.isArray(parsed.artifacts)
  ) {
    throw new Error('bridge-manifest.json does not match the required schema');
  }

  const artifacts: BridgeManifestArtifact[] = [];
  for (const value of parsed.artifacts) {
    if (!isRecord(value) || !hasExactKeys(value, ['os', 'arch', 'file', 'sha256'])) {
      throw new Error('bridge-manifest.json contains an artifact with an invalid schema');
    }
    if (
      value.os !== 'windows' ||
      (value.arch !== 'amd64' && value.arch !== 'arm64') ||
      typeof value.file !== 'string' ||
      typeof value.sha256 !== 'string'
    ) {
      throw new Error('bridge-manifest.json contains an unsupported artifact');
    }
    artifacts.push({ os: value.os, arch: value.arch, file: value.file, sha256: value.sha256 });
  }

  return {
    schemaVersion: 1,
    version: parsed.version,
    commit: parsed.commit,
    buildDate: parsed.buildDate,
    artifacts,
  };
}

function validateManifest(manifest: BridgeArtifactManifest): void {
  if (
    !manifest.version ||
    manifest.version.length > 128 ||
    !manifest.commit ||
    manifest.commit.length > 128 ||
    !manifest.buildDate ||
    manifest.buildDate.length > 64
  ) {
    throw new Error('bridge-manifest.json has invalid metadata');
  }
  if (manifest.artifacts.length !== 2) {
    throw new Error('bridge-manifest.json must contain exactly one Windows/amd64 and one Windows/arm64 artifact');
  }

  const seenArchitectures = new Set<BridgeArchitecture>();
  for (const artifact of manifest.artifacts) {
    if (seenArchitectures.has(artifact.arch)) {
      throw new Error(`bridge-manifest.json contains a duplicate Windows/${artifact.arch} artifact`);
    }
    seenArchitectures.add(artifact.arch);

    const expectedArtifact = ARTIFACTS[artifact.arch];
    if (artifact.file !== expectedArtifact.file) {
      throw new Error(`bridge-manifest.json has an unexpected filename for Windows/${artifact.arch}`);
    }
    if (!/^[a-f\d]{64}$/.test(artifact.sha256)) {
      throw new Error(`bridge-manifest.json has an invalid SHA-256 for ${expectedArtifact.file}`);
    }
  }

  if (!seenArchitectures.has('amd64') || !seenArchitectures.has('arm64')) {
    throw new Error('bridge-manifest.json must contain exactly one Windows/amd64 and one Windows/arm64 artifact');
  }
}

function parseChecksums(contents: Buffer): Map<string, string> {
  const lines = contents.toString('utf8').trimEnd().split(/\r?\n/);
  const checksums = new Map<string, string>();
  const expectedFiles = new Set(Object.values(ARTIFACTS).map((artifact) => artifact.file));
  for (const line of lines) {
    const match = /^([a-f\d]{64}) {2}([^\s]+)$/.exec(line);
    if (!match) {
      throw new Error('checksums.txt contains an invalid entry');
    }
    const [, checksum, file] = match;
    if (!expectedFiles.has(file)) {
      throw new Error(`checksums.txt contains an unexpected filename: ${file}`);
    }
    if (checksums.has(file)) {
      throw new Error(`checksums.txt contains a duplicate entry for ${file}`);
    }
    checksums.set(file, checksum);
  }
  if (checksums.size !== expectedFiles.size) {
    throw new Error('checksums.txt must contain exactly one checksum for each Windows bridge artifact');
  }
  return checksums;
}

function isWindowsExecutableForMachine(contents: Buffer, machine: number): boolean {
  if (contents.length < 0x40 || contents.toString('ascii', 0, 2) !== 'MZ') {
    return false;
  }
  const headerOffset = contents.readUInt32LE(0x3c);
  return (
    headerOffset >= 0x40 &&
    headerOffset <= contents.length - 6 &&
    contents.toString('ascii', headerOffset, headerOffset + 4) === 'PE\0\0' &&
    contents.readUInt16LE(headerOffset + 4) === machine
  );
}

async function readBoundedFile(path: string, maximumSize: number, displayName: string): Promise<Buffer> {
  let fileStat: Stats;
  try {
    fileStat = await stat(path);
  } catch {
    throw new Error(`${displayName} was not found`);
  }
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maximumSize) {
    throw new Error(`${displayName} has an invalid size or is not a regular file`);
  }
  const contents = await readFile(path);
  if (contents.length <= 0 || contents.length > maximumSize) {
    throw new Error(`${displayName} has an invalid size`);
  }
  return contents;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(record, key));
}

async function replaceStagedArtifacts(
  outputBinDirectory: string,
  artifacts: ReadonlyMap<BridgeArchitecture, Buffer>,
  manifestContents: Buffer,
  checksumsContents: Buffer,
): Promise<void> {
  const parentDirectory = dirname(outputBinDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(parentDirectory, '.bridge-artifacts-staging-'));
  let backupDirectory: string | undefined;
  let movedExistingOutput = false;
  let installed = false;

  try {
    for (const architecture of ['amd64', 'arm64'] as const) {
      const artifact = artifacts.get(architecture);
      if (!artifact) {
        throw new Error(`Validated Windows/${architecture} artifact is missing`);
      }
      const targetDirectory = join(stagingDirectory, ARTIFACTS[architecture].outputDirectory);
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, 'wslc-bridge.exe'), artifact);
    }
    await Promise.all([
      writeFile(join(stagingDirectory, 'bridge-manifest.json'), manifestContents),
      writeFile(join(stagingDirectory, 'checksums.txt'), checksumsContents),
    ]);

    let outputExists = false;
    try {
      await stat(outputBinDirectory);
      outputExists = true;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }

    if (outputExists) {
      backupDirectory = await mkdtemp(join(parentDirectory, '.bridge-artifacts-backup-'));
      await rm(backupDirectory, { recursive: true, force: true });
      await rename(outputBinDirectory, backupDirectory);
      movedExistingOutput = true;
    }

    await rename(stagingDirectory, outputBinDirectory);
    installed = true;
  } catch (error: unknown) {
    if (movedExistingOutput && backupDirectory && !installed) {
      try {
        await rename(backupDirectory, outputBinDirectory);
        movedExistingOutput = false;
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          'Failed to install bridge artifacts and restore previous output',
        );
      }
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (backupDirectory && (!movedExistingOutput || installed)) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const outputBinDirectory = join(extensionRoot, 'dist', 'bin');
  resolveBridgeArtifactDirectory(extensionRoot)
    .then((sourceDirectory) => stageBridgeArtifacts(sourceDirectory, outputBinDirectory))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
