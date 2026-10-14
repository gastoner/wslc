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
  executableName: string;
  pipeName: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxConsecutiveStartupFailures: number;
  refreshIntervalMs: number;
}

export const pipeName = String.raw`\\.\pipe\wslc_engine`;
export const executableName = 'wslc-bridge.exe';

export const bridgeConfiguration: BridgeConfiguration = {
  executableName,
  pipeName,
  startupTimeoutMs: 180_000,
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 10_000,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};
