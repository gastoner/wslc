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

export type BridgeArchitecture = 'amd64' | 'arm64';

export type BridgeArtifactPins = Readonly<Record<BridgeArchitecture, string>>;

export interface BridgeRelease {
  readonly repository: string;
  readonly tag: string;
}

/**
 * The published bridge release the extension packages. Bumping the tag requires updating
 * BRIDGE_ARTIFACT_SHA256 with the digests from that release's checksums.txt.
 */
export const BRIDGE_RELEASE: BridgeRelease = {
  repository: 'gastoner/wslc-bridge',
  tag: 'v0.0.1',
};

export const BRIDGE_ARTIFACT_SHA256: BridgeArtifactPins = {
  amd64: 'b9f0a90e70c66e274fe6afdadf05ab48ce033a5ad645425c2d0d4affe052ed8a',
  arm64: '484e39febfdeb4c40b049966c7d6f18754974dc21d99942bfe7ac14d8dbf0fa5',
};
