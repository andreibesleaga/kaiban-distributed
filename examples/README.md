# Examples

Two runnable examples live in this repository. Each runs every agent as its own worker
process, talking over Redis/BullMQ (or Kafka), with the Kanban board showing each task move
in real time. Run one example at a time on the same Redis. Setup, environment variables and
commands are in [EXAMPLES.md](../EXAMPLES.md).

| Example | What it shows | Start |
|---|---|---|
| [blog-team](blog-team/) | A sequential pipeline: researcher, writer and editor agents, then a human decision (publish, revise or reject) on the board | `./scripts/blog-team.sh start` |
| [global-research](global-research/README.md) | Fan-out / fan-in: N competing searcher agents, then a writer, a governance reviewer, an editor and a human decision; `--searchers N` and `--chaos` flags | `./scripts/global-research.sh start` |

Any example can also be started with the generic runner:
`./scripts/run-example.sh start examples/<name>`.

## More examples

[kaiban-distributed-examples](https://github.com/andreibesleaga/kaiban-distributed-examples)
is a separate repository of runnable examples built on the published `kaiban-distributed`
package. Each ports a KaibanJS example onto the distributed actor model:

| Example | Topology |
|---|---|
| Trip Planning | sequential pipeline of three agents, each its own worker |
| GitHub Release Social Media Team | heterogeneous fan-out / fan-in: one input, four different writers, one reviewer |
| RAG Product Knowledge Base | a retrieval tool wired into a distributed agent |
| Resume Creation | the smallest sequential pipeline, two agents: a starting point |

It also carries a shared viewer, Docker infrastructure and deployment notes.
