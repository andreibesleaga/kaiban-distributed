import { propagation, context, ROOT_CONTEXT } from '@opentelemetry/api';

export function injectTraceContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

export function extractTraceContext(carrier: Record<string, string>): ReturnType<typeof propagation.extract> {
  return propagation.extract(ROOT_CONTEXT, carrier);
}
