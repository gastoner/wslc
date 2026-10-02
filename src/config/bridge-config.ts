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

export interface BridgeConfiguration {
  repository: string;
  version: string | undefined;
  assetName: string | undefined;
  sha256: string | undefined;
  executableName: string;
  relayName: string;
  host: string;
  port: number;
  pipeName: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  readinessPollIntervalMs: number;
  shutdownTimeoutMs: number;
  maxConsecutiveStartupFailures: number;
  refreshIntervalMs: number;
}

const pipeName = String.raw`\\.\pipe\wslc_engine`;

export const bridgeConfiguration: BridgeConfiguration = {
  repository: 'https://github.com/l0rd/wslc-proxy',
  version: undefined,
  assetName: 'wslc-proxy-windows-amd64-linux-amd64.zip',
  sha256: undefined,
  executableName: 'socktainer.exe',
  relayName: 'docker-relay',
  host: 'localhost',
  port: 2375,
  pipeName,
  startupTimeoutMs: 180_000,
  requestTimeoutMs: 5_000,
  readinessPollIntervalMs: 250,
  shutdownTimeoutMs: 10_000,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};
