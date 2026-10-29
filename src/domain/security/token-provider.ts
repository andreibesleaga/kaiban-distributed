// SPDX-License-Identifier: Apache-2.0
export interface ITokenProvider {
  getToken(service: string, taskId: string): Promise<string | undefined>;
}
