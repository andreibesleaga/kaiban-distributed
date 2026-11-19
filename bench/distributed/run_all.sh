#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Runs M1-M4 strictly one after another (runs would compete for the same CPUs), then builds RESULTS.md.
# Needs Docker Compose v2 and a built library (npm ci && npm run build in the repository root). About 2.5 h.
set -u
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
COMPOSE="docker compose -f docker-compose.bench.yml"
export BENCH_ALLOW_FLUSH=1   # the harness empties the bench Redis before each run
mkdir -p logs results
$COMPOSE up -d --wait || { echo "Docker could not start Redis/Kafka: stop and check ports 6379, 9092, 2181"; exit 2; }
FAILED=()
run() { # run <log name> <script> [args...]
  local n=$1; shift
  echo "=== $n $(date -u +%FT%TZ)"
  node "$@" > "logs/$n.log" 2> "logs/$n.err.log"
  local rc=$?
  echo "exit $rc"
  [ $rc -eq 0 ] || FAILED+=("$n (exit $rc)")
}
run m1_redis         m12.cjs --driver redis
run m2_kafka         m12.cjs --driver kafka
run m2_kafka_p4      m12.cjs --driver kafka --workers 8 --partitions 4
run m3               m3.cjs
run m4_redis_default m4.cjs --driver redis --profile default
run m4_redis_short   m4.cjs --driver redis --profile short
run m4_kafka_default m4.cjs --driver kafka --profile default
node make-results.cjs > logs/make-results.log 2>&1 || FAILED+=("make-results (exit $?)")
$COMPOSE down
echo "=== done $(date -u +%FT%TZ)"
if [ ${#FAILED[@]} -gt 0 ]; then echo "FAILED steps: ${FAILED[*]}"; exit 1; fi
