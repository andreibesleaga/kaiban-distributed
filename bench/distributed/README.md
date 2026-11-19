# Distributed measurements

Runtime measurements of the Redis (BullMQ) and Kafka drivers with a stub model. No LLM and no public network is used.
Recorded results are in `results/`, the tables in `RESULTS.md` (generated from `results/` by `make-results.cjs`).

The chaos suite is not part of this folder: run it with `npm run test:e2e:chaos` in the repository root.

## What is measured

| Id | What | Script | Time (16-core laptop) |
|---|---|---|---|
| M1 | Redis: throughput and latency p50/p95 for 1, 2, 4, 8 worker processes; 200 tasks; stub model 0 ms and 500 ms; 5 repetitions | `m12.cjs --driver redis` | about 18 min |
| M2 | Same with Kafka (topic with 8 partitions), plus N=8 with 4 partitions | `m12.cjs --driver kafka` | about 22 min + 3 min |
| M3 | Broker overhead: direct in-process call vs one worker behind the broker (sequential and burst at 0 ms, sequential check at 500 ms) | `m3.cjs` | about 7 min |
| M4 | Crash recovery: `kill -9` of the worker that runs the k-th task, 30 crashes per setting (Redis default, Redis short lock/stall, Kafka default) | `m4.cjs` | about 32 + 3 + 20 min |

Everything runs one step at a time on purpose: parallel runs would compete for the same CPUs. Whole run: about 2.5 h.

## Prerequisites

- Linux (tested on WSL2), Node 22+, Docker with Compose v2.
- In the repository root: `npm ci && npm run build`. The harness imports only the built `dist/`; it has no `package.json` of its own and
  resolves BullMQ, KafkaJS and ioredis from the repository `node_modules`.
- Docker images `redis:7-alpine`, `confluentinc/cp-kafka:7.6.0`, `confluentinc/cp-zookeeper:7.6.0` (pulled once).
- A quiet machine on mains power: a laptop on battery throttles the processor, and anything else running changes the 0 ms numbers.
- Ports 6379, 9092 and 2181 on localhost must be free. The harness flushes Redis and deletes its own Kafka topics, so use a bench-only broker.

## Reproduce

```bash
cd bench/distributed
./run_all.sh     # starts Redis + Kafka, runs M1-M4 one after another, builds RESULTS.md, stops the containers
```

Logs go to `logs/` (git-ignored; Kafka client logs are verbose). Raw per-run data goes to `results/*.json`; these and `RESULTS.md` are the
recorded run and are meant to be committed. `run_all.sh` exits non-zero and names the failed steps if any step fails.
The repository root is found relative to the scripts.

## Run a single cell

With the containers up (`docker compose -f docker-compose.bench.yml up -d --wait`) and `export BENCH_ALLOW_FLUSH=1`
(the Redis runs empty the Redis on port 6379 with FLUSHALL, so the variable confirms it is the bench broker):

```bash
node m12.cjs --driver kafka --workers 4 --latency 0 --reps 5 --name try       # M1/M2 cell; add --partitions 4 for Kafka
node m3.cjs --driver redis --reps 1                                            # M3 for one driver
node m4.cjs --driver redis --profile short --crashes 5 --name try_m4           # M4; --profile default|short
node make-results.cjs                                                          # rebuild RESULTS.md from results/
docker compose -f docker-compose.bench.yml down
```

A table with a spread above 20 % can be repeated once with `node m12.cjs --driver kafka --latency 0 --name m2_kafka_L0_rerun`;
`make-results.cjs` shows that file as an extra table when it exists. Delete any `try*` result files before rebuilding `RESULTS.md`
if you do not want them kept.

## Files

- `lib.cjs` shared helpers (library import, statistics, infrastructure reset, machine info); `worker.cjs` one worker process
  (library `AgentActor` + driver + stub model); `load.cjs` one load run; `m12.cjs`, `m3.cjs`, `m4.cjs` the measurements;
  `make-results.cjs` builds `RESULTS.md`; `run_all.sh` runs everything.
- `docker-compose.bench.yml` project `kaiban-bench`: same images as the repository compose file, without its CPU/memory caps,
  Kafka with 8 partitions (the repository default is 4) and `group.initial.rebalance.delay.ms=0`.

## Design notes

- Workers are separate Node processes (`child_process.fork`), each with its own driver; one task at a time per worker (library default).
- Latency is measured in the client process, from the publish call to the arrival of the completion event on the library completed channel.
- Every time is read from the machine's monotonic clock (`process.hrtime`), which all processes share and which wall-clock corrections
  (NTP, a virtual machine's time sync) do not step. Times stamped in a worker and in the client can therefore be subtracted.
- Fixed seeds: task payloads (1000+rep for M1/M2, 2000+rep for M3) and crash positions (4242). Timings still vary from run to run.
- Redis state is flushed before each run; the Kafka task topic is created fresh per run and deleted after; consumer groups are unique per run.
- Shorter stall settings exist only for BullMQ (`lockDuration`, `stalledInterval` pass through the driver options). `KafkaDriver` does not expose
  session, heartbeat or rebalance timeouts, so Kafka is measured with the KafkaJS defaults only.
- Node may print `TimeoutNegativeWarning` during runs; all tasks still complete.

## Limits

Single machine, loopback network, one broker per driver; the model is a stub with a fixed latency; burst latency includes queue waiting;
one task at a time per worker; the 5 s overhead share in M3 is computed, not measured; M4 kills one worker process only (no broker failure,
no network partition); the Kafka session timeout is not configurable through the driver. More in `RESULTS.md`.
