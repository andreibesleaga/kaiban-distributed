#!/usr/bin/env bash
# =============================================================================
# kaiban-distributed — Global Research Swarm example lifecycle script
# =============================================================================
#
# Usage:
#   ./scripts/global-research.sh start [--chaos] [--searchers N]
#   ./scripts/global-research.sh stop
#   ./scripts/global-research.sh board          # serve board only
#
# Options:
#   --chaos       Enable CHAOS_MODE (20% searcher crash rate)
#   --searchers N Number of parallel searchers (default: 4)
# =============================================================================

set -e

COMMAND=${1:-start}
CHAOS_MODE=false
NUM_SEARCHERS=4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="examples/global-research/docker-compose.yml"
ENV_FILE=".env"
BOARD_DIR="examples/global-research/viewer"
BOARD_PORT=8080

# ── Parse flags ──────────────────────────────────────────────────────────────
shift || true
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --chaos)       CHAOS_MODE=true ;;
    --searchers)   NUM_SEARCHERS="${2:-4}"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# ── Load .env ────────────────────────────────────────────────────────────────
if [[ -f "$ROOT/$ENV_FILE" ]]; then
  set -a; source "$ROOT/$ENV_FILE"; set +a
fi

export CHAOS_MODE
export NUM_SEARCHERS
export QUERY="${QUERY:-The Future of AI Agents}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
export MESSAGING_DRIVER="${MESSAGING_DRIVER:-bullmq}"

# ── Helpers ──────────────────────────────────────────────────────────────────

wait_for_gateway() {
  echo "  Waiting for gateway at $GATEWAY_URL..."
  local retries=30
  until curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; do
    retries=$((retries - 1))
    [[ $retries -le 0 ]] && { echo "ERROR: Gateway did not start in time."; exit 1; }
    sleep 3
  done
  echo "  ✓ Gateway healthy"
}

serve_board() {
  echo ""
  echo "  Board: http://localhost:$BOARD_PORT/board.html"
  echo "         (Ctrl+C to stop the board server)"
  echo ""
  cd "$ROOT/$BOARD_DIR"
  if command -v python3 &>/dev/null; then
    python3 -m http.server "$BOARD_PORT" --bind 127.0.0.1 2>/dev/null &
    BOARD_PID=$!
    echo "  Board server PID: $BOARD_PID"
    cd "$ROOT"
  else
    echo "  (install python3 to auto-serve board.html)"
    cd "$ROOT"
  fi
}

open_board() {
  local url="http://localhost:$BOARD_PORT/board.html"
  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" &>/dev/null &
  elif command -v open &>/dev/null; then
    open "$url" &>/dev/null &
  else
    echo "  Open manually: $url"
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────────

if [[ "$COMMAND" == "stop" ]]; then
  echo "Stopping Global Research Swarm..."
  docker compose -f "$ROOT/$COMPOSE_FILE" --env-file "$ROOT/$ENV_FILE" down
  echo "Done."
  exit 0
fi

if [[ "$COMMAND" == "board" ]]; then
  serve_board
  open_board
  wait $BOARD_PID 2>/dev/null
  exit 0
fi

# ── start ─────────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " KAIBAN DISTRIBUTED — Global Research Swarm"
echo "══════════════════════════════════════════════════════════════════════"
echo ""
echo "  Query:      $QUERY"
echo "  Searchers:  $NUM_SEARCHERS"
echo "  Chaos mode: $CHAOS_MODE"
echo "  Transport:  $MESSAGING_DRIVER"
echo ""

# Build TypeScript
echo "── Building TypeScript ────────────────────────────────────────────────"
cd "$ROOT" && npm run build
echo "  ✓ Build complete"

# Start Docker services
echo ""
echo "── Starting Docker Compose ────────────────────────────────────────────"
docker compose \
  -f "$ROOT/$COMPOSE_FILE" \
  --env-file "$ROOT/$ENV_FILE" \
  up -d --build --remove-orphans \
  --scale searcher="$NUM_SEARCHERS"

echo ""
wait_for_gateway

# Wait for agents to subscribe to queues
echo "  Waiting 10s for agents to register..."
sleep 10

# Serve the board
echo ""
echo "── Live Board ─────────────────────────────────────────────────────────"
serve_board
open_board

# Run the orchestrator locally
echo ""
echo "── Running Orchestrator ───────────────────────────────────────────────"
echo "  Query: \"$QUERY\""
echo "  Tip:   Board is live at http://localhost:$BOARD_PORT/board.html"
echo ""

BOARD_PID_SAVED=${BOARD_PID:-}

cleanup() {
  echo ""
  echo "── Stopping services ──────────────────────────────────────────────────"
  [[ -n "$BOARD_PID_SAVED" ]] && kill "$BOARD_PID_SAVED" 2>/dev/null || true
  docker compose \
    -f "$ROOT/$COMPOSE_FILE" \
    --env-file "$ROOT/$ENV_FILE" \
    down
  echo "Done."
}
trap cleanup EXIT INT TERM

node "$ROOT/dist/examples/global-research/orchestrator.js"
