# AGENTS.md

Instructions for coding agents working in this repository. People start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); [llms.txt](llms.txt) is the short map.

## Layout

| Path | What it holds |
| --- | --- |
| `src/domain/` | entities, errors, the `Result<T, E>` type; no framework imports |
| `src/application/` | the actor runtime (`AgentActor`) |
| `src/adapters/` | the gateway (Express, Socket.io) and state publishers |
| `src/infrastructure/` | messaging drivers (BullMQ/Redis, Kafka), KaibanJS bridge, A2A and MCP federation, security, telemetry |
| `src/shared/` | the `kaiban-distributed/shared` entry point used by the examples |
| `src/main/` | `index.ts` picks the role from `ROLE`; `gateway.ts` and `worker.ts` are the two roles |
| `src/index.ts` | the public library API (tracked in `etc/*.api.md`) |
| `tests/unit/` | Vitest unit tests (100 % coverage gate); `tests/e2e/` needs Docker |
| `board/` | the React Kanban board, a separate package with its own lockfile |
| `examples/` | blog-team and global-research |
| `docs/` | architecture, API spec, security, deployment guides, ADRs (`docs/decisions/`) |

## Commands

```bash
npm ci                    # install; never npm install (it rewrites the lockfile)
npm run build             # tsc -> dist/
npm run lint              # ESLint, zero warnings, complexity <= 10
npm run typecheck         # tsc --noEmit
npm run lint:arch         # madge: no circular imports
npm run api:check         # public API must match etc/*.api.md
npm run test:coverage     # unit tests; fails below 100 % of src/**
cd board && npm ci && npm test
npm run lockfile:check    # after any lockfile change
```

One test file: `npx vitest run --config vitest.config.mts tests/unit/<path>.test.ts`.

## Rules

- Install with `npm ci`. Change lockfiles only with npm 11.17.0, then run `npm run lockfile:check`.
- Keep coverage of `src/**` at 100 % (lines, branches, functions, statements). Add the test with the change.
- Never publish from a local machine. Releases go through the tag-triggered workflows
  ([docs/RELEASE.md](docs/RELEASE.md)).
- `main` is protected: work on a branch and open a pull request.
- No `any`; program to `IMessagingDriver`, never to BullMQ or Kafka directly.
- The state and HITL channels stay on Redis Pub/Sub whatever `MESSAGING_DRIVER` is.
- Security controls stay opt-in and default-off. Configuration comes from environment variables;
  document a new one in `.env.example`.
- A public API change needs `npm run api:update` and the updated `etc/*.api.md` in the same pull request.
- Architecture decisions are recorded as ADRs in `docs/decisions/`.
