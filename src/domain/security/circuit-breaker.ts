// SPDX-License-Identifier: Apache-2.0
export interface ICircuitBreaker {
  recordSuccess(): void;
  recordFailure(): void;
  isOpen(): boolean;
}
