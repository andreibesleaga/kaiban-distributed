export interface ICircuitBreaker {
  recordSuccess(): void;
  recordFailure(): void;
  isOpen(): boolean;
}
