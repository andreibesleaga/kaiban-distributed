# kaiban-distributed-board

Modern React board visualisation for **kaiban-distributed** — real-time agent & task
visualisation via Socket.io (React 19 + Vite + Zustand).

## Scripts

| Command                      | Description                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run dev`                | Start the Vite dev server                                                                         |
| `npm run build`              | Type-check + production build                                                                     |
| `npm run preview`            | Preview the production build                                                                      |
| `npm run typecheck`          | Type-check only (`tsc --noEmit`)                                                                  |
| `npm test`                   | Run the vitest test suite                                                                         |
| `npm run test:visual`        | Playwright visual tests (needs the dev server on :5173 and a gateway; see `playwright.config.ts`) |
| `npm run test:visual:update` | Regenerate the committed screenshot baseline                                                      |

## Production hosting

`npm run build` writes a static site to `dist/`. Browsers honour `X-Frame-Options` and
`X-Content-Type-Options` only as HTTP **response headers** (not as `<meta>` tags), so set these
on whatever serves `dist/` (the Vite dev server already sends them):

```
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Without `frame-ancestors` a hostile page can frame the board and trick a click on STOP ALL.

`?gateway=<url>` selects another gateway at run time. If `VITE_BOARD_TOKEN` is built in, the
board honours it only for the origin of `VITE_GATEWAY_URL`, so a link cannot send the token elsewhere.

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

These jsdom checks **do not cover colour contrast**: jsdom loads no CSS, so axe reports
`color-contrast` as "incomplete" rather than as a violation. Contrast is checked in a real
browser by two Playwright specs that run axe's `color-contrast` rule on the rendered page, with
a stub gateway on a random port (no dev server or gateway needed):
`npm run test:visual -- board-contrast` (React board) and
`npm run test:visual -- viewers-control` (the static viewers).

Run them with the rest of the suite:

```bash
npm test
```

To add a11y coverage for a new component, render it (with minimal props/store state)
and add an `expect(await axe(container)).toHaveNoViolations()` assertion in that file.
