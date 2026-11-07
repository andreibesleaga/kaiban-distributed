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
| `npm run test:visual`        | Playwright tests. `board-visual` and `board-control` need the dev server on :5173 and a gateway; `board-contrast`, `board-dialogs`, `viewers-control` and `viewers-visual` start their own stub gateway (and Vite server where needed) and need nothing running (see `playwright.config.ts`). Not run in CI |
| `npm run test:visual:update` | Regenerate the committed screenshot baseline                                                      |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_GATEWAY_URL` | `http://localhost:3000` | Gateway the board connects to. In `npm run dev` the Vite proxy forwards `/socket.io` to it. |
| `VITE_BOARD_TOKEN` | none | Board token for a gateway with `BOARD_JWT_SECRET`; also needed for the STOP ALL button. **Local development only:** it is compiled into the bundle, so anyone who can load a production build can read it, and it can stop every task. In production, put the board behind your own access control and do not build with a real token. |

## What you see

Agent cards and task cards in the Kanban columns, the event log and the economics panel. With
`CONTROL_PLANE_ENABLED=true` on the gateway there is also a STOP ALL button with a confirmation
dialog, an alert bar for a refused or unconfirmed stop, a banner for the last stop, and a "Stopped"
badge on stopped tasks in the Blocked column. Human decisions on a review (PUBLISH, REVISE,
REJECT) are buttons in the workflow banner. [EXAMPLES.md](../EXAMPLES.md), Example 7, walks through it.

## Production hosting

`npm run build` writes a static site to `dist/`. Browsers honour `X-Frame-Options` and
`X-Content-Type-Options` only as HTTP **response headers** (not as `<meta>` tags), so set these
on whatever serves `dist/` (the Vite dev server already sends them):

```
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY            # legacy browsers
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Without `frame-ancestors` a hostile page can frame the board and trick a click on STOP ALL.

`?gateway=<url>` selects another gateway at run time. If `VITE_BOARD_TOKEN` is built in, the
board honours it only for the origin of `VITE_GATEWAY_URL`, so a link cannot send the token elsewhere.
(`VITE_BOARD_TOKEN` is for local development only; see Settings.)

## Testing

Tests use **vitest** + **@testing-library/react**. The default test environment is
`happy-dom` (see `vitest.config.ts`).

### Accessibility (a11y)

Automated accessibility checks live in `src/__tests__/a11y.test.tsx`. They render the
key UI components (`KanbanBoard`, `AgentCard`, `AgentGrid`, `EventLog`,
`EconomicsPanel`, `Header`) and, in `src/__tests__/a11y-stop-all.test.tsx`, the STOP ALL dialog, and assert that [axe-core](https://github.com/dequelabs/axe-core)
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
