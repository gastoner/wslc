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
  amd64: 'aa9f165652f28ed6d8011326bc088a1618b3cd3a57fa86b4e83e742a3378eb17',
  arm64: '45c77a377a73d001d2fd1774d3ef614269b7d41758c4b1f65740e89d5445567a',
};
