# Blog Team

A sequential pipeline: Ava (researcher), Kai (writer) and Morgan (editor) each run as their own worker, then a human decides to publish, revise or reject.

Start it from the repository root:

```bash
./scripts/blog-team.sh start [--kafka] [--docker]
```

Full steps and environment variables: [EXAMPLES.md](../../EXAMPLES.md), Example 1. Test walkthrough with pass criteria: [docs/testing/BLOG_TEAM_TEST.md](../../docs/testing/BLOG_TEAM_TEST.md).

Files:

- `orchestrator.ts` and `phases.ts`: the workflow (research, write, review, human decision).
- `team-config.ts` and `researcher-node.ts`, `writer-node.ts`, `editor-node.ts`: the three agents.
- `viewer/`: the standalone live board (`viewer/board.html`).
- `docker-compose.yml`, `docker-compose.kafka.yml`, `infra/`: the stack (BullMQ or Kafka).
