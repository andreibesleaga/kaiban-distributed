// Type augmentation so `expect(...).toHaveNoViolations()` (registered at runtime
// via `expect.extend(axeMatchers)` in the a11y tests) is known to TypeScript.
// Mirrors @testing-library/jest-dom's vitest augmentation: vitest 4 resolves
// matchers from the `vitest` module's Assertion interface (the shipped
// `vitest-axe/extend-expect` augments the legacy `Vi` global, which vitest 4 no
// longer reads). The `import 'vitest'` keeps this file a module augmentation.
import 'vitest';
import { type AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends AxeMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
