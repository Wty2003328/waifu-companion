/**
 * Vitest setup — runs once before any test file.
 *
 * - Wires `@testing-library/jest-dom` into `expect` so component tests
 *   can use matchers like `.toBeInTheDocument()` and `.toHaveTextContent()`.
 * - Adds an `afterEach(cleanup)` hook. Without it the rendered DOM from
 *   each test leaks into the next, and `getByRole(...)` finds duplicates.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
