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

export const BRIDGE_ARTIFACT_SHA256: BridgeArtifactPins = {
  amd64: '0372c9a5c226ac9a79f6860f0b2ff07adfc90774cbdef1d95e6f9d0115b2a16a',
  arm64: '9807683cf3f33996de8de4a49f643b03fad60f40031dd71930d34d6b69384945',
};
