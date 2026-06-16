# kaiban-distributed-board

Modern React board visualisation for **kaiban-distributed** — real-time agent & task
visualisation via Socket.io (React 18 + Vite + Zustand).

## Scripts

| Command          | Description                              |
| ---------------- | ---------------------------------------- |
| `npm run dev`    | Start the Vite dev server                |
| `npm run build`  | Type-check + production build            |
| `npm run preview`| Preview the production build             |
| `npm test`       | Run the vitest test suite                |

## Testing

Tests use **vitest** + **@testing-library/react**. The default test environment is
`happy-dom` (see `vitest.config.ts`).

### Accessibility (a11y)

Automated accessibility checks live in `src/__tests__/a11y.test.tsx`. They render the
key UI components (`KanbanBoard`, `AgentCard`, `AgentGrid`, `EventLog`,
`EconomicsPanel`, `Header`) and assert that [axe-core](https://github.com/dequelabs/axe-core)
finds **no violations**, via [`vitest-axe`](https://github.com/chaance/vitest-axe)
(`expect(await axe(container)).toHaveNoViolations()`).

These specs opt into the `jsdom` environment with a per-file
`// @vitest-environment jsdom` pragma, because axe-core needs a more complete DOM than
`happy-dom` provides. `vitest-axe` and `jsdom` are dev-only dependencies.

Run them with the rest of the suite:

```bash
npm test
```

To add a11y coverage for a new component, render it (with minimal props/store state)
and add an `expect(await axe(container)).toHaveNoViolations()` assertion in that file.
