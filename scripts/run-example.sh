#!/usr/bin/env bash
# =============================================================================
# kaiban-distributed — Universal example runner (default Redis/BullMQ mode)
# =============================================================================
#
# Usage:
#   ./scripts/run-example.sh start <example-path>
#   ./scripts/run-example.sh stop  <example-path>
#
# Examples:
#   ./scripts/run-example.sh stop  examples/blog-team
#   ./scripts/run-example.sh start blog-team
#
# Behavior:
#   - Uses <example>/docker-compose.yml only
#   - Starts root/board with `npm run dev` on port 5173 first
#   - Runs the local orchestrator from <example>/orchestrator.ts
#   - Assumes default Redis/BullMQ mode (no Kafka, no monitor)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"

COMMAND="${1:-}"
EXAMPLE_INPUT="${2:-}"

usage() {
  echo "Usage: ./scripts/run-example.sh [start|stop] <example-path>"
  echo "Example paths may be 'examples/blog-team' or just 'blog-team'."
  exit 1
}

[[ "$COMMAND" == "start" || "$COMMAND" == "stop" ]] || usage
[[ -n "$EXAMPLE_INPUT" ]] || usage

normalise_example_path() {
  local input="$1"
  if [[ "$input" == examples/* ]]; then
    echo "$input"
  else
    echo "examples/$input"
  fi
}

EXAMPLE_PATH="$(normalise_example_path "$EXAMPLE_INPUT")"
EXAMPLE_DIR="$ROOT/$EXAMPLE_PATH"
COMPOSE_FILE="$EXAMPLE_DIR/docker-compose.yml"
ORCHESTRATOR_TS="$EXAMPLE_DIR/orchestrator.ts"
EXAMPLE_NAME="$(basename "$EXAMPLE_DIR")"
PID_FILE="$ROOT/.run-example-${EXAMPLE_NAME}.pid"
BOARD_DIR="$ROOT/board"
BOARD_PORT=5173
BOARD_PID_FILE="$ROOT/.run-example-${EXAMPLE_NAME}-board.pid"
BOARD_LOG_FILE="$ROOT/.run-example-${EXAMPLE_NAME}-board.log"

[[ -d "$EXAMPLE_DIR" ]] || { echo "ERROR: Example directory not found: $EXAMPLE_PATH"; exit 1; }
[[ -f "$COMPOSE_FILE" ]] || { echo "ERROR: Missing docker-compose.yml: $EXAMPLE_PATH"; exit 1; }
[[ -f "$ORCHESTRATOR_TS" ]] || { echo "ERROR: Missing orchestrator.ts: $EXAMPLE_PATH"; exit 1; }

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

COMPOSE_ENV_ARGS=()
if [[ -f "$ENV_FILE" ]]; then
  COMPOSE_ENV_ARGS+=(--env-file "$ENV_FILE")
fi

LLM_CREDENTIAL_ENV_NAMES=(
  OPENAI_API_KEY
  OPENROUTER_API_KEY
  ANTHROPIC_API_KEY
  GOOGLE_API_KEY
  MISTRAL_API_KEY
  GROQ_API_KEY
)

export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
export MESSAGING_DRIVER="bullmq"

wait_for_http() {
  local url="$1"
  local label="$2"
  local retries="${3:-30}"

  echo "Waiting for ${label} at ${url}..."
  until curl -sf "$url" >/dev/null 2>&1; do
    retries=$((retries - 1))
    [[ $retries -le 0 ]] && {
      echo "ERROR: ${label} did not become ready in time."
      exit 1
    }
    sleep 2
  done
  echo "${label} is healthy."
}

wait_for_gateway() {
  wait_for_http "$GATEWAY_URL/health" "Gateway"
}

wait_for_board() {
  wait_for_http "http://127.0.0.1:${BOARD_PORT}" "React board" 20
}

get_available_llm_credentials() {
  local key
  for key in "${LLM_CREDENTIAL_ENV_NAMES[@]}"; do
    if [[ -n "${!key:-}" ]]; then
      printf '%s\n' "$key"
    fi
  done
}

require_llm_credentials() {
  local available=()
  mapfile -t available < <(get_available_llm_credentials)

  if [[ ${#available[@]} -eq 0 ]]; then
    echo "ERROR: No LLM credential found in the shell or $ENV_FILE"
    echo "Expected one of: ${LLM_CREDENTIAL_ENV_NAMES[*]}"
    exit 1
  fi

  echo "LLM credentials available via: ${available[*]}"
}

probe_openrouter_key() {
  [[ -n "${OPENROUTER_API_KEY:-}" ]] || return 0

  local response_file http_code summary node_status
  response_file="$(mktemp)"
  http_code="$((0))"
  summary=""
  node_status=0

  http_code="$(curl -sS -o "$response_file" -w '%{http_code}' https://openrouter.ai/api/v1/key -H "Authorization: Bearer ${OPENROUTER_API_KEY}" || true)"
  if [[ "$http_code" != "200" ]]; then
    local body
    body="$(tr '\n' ' ' < "$response_file" | sed 's/[[:space:]]\+/ /g' | cut -c1-300)"
    rm -f "$response_file"
    echo "ERROR: OpenRouter key preflight failed (HTTP $http_code): ${body:-no response body}"
    exit 1
  fi

  summary="$(node - "$response_file" <<'NODE'
const fs = require('fs');

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const data = payload?.data ?? {};
const limitRemaining = data.limit_remaining;
const parts = [];

if (limitRemaining !== undefined && limitRemaining !== null) {
  parts.push(`limit_remaining=${limitRemaining}`);
}
if (data.limit_reset) parts.push(`limit_reset=${data.limit_reset}`);

console.log(parts.join(', '));

if (typeof limitRemaining === 'number' && limitRemaining <= 0) {
  process.exit(10);
}
NODE
)" || node_status=$?

  rm -f "$response_file"

  if [[ $node_status -eq 10 ]]; then
    echo "ERROR: OpenRouter key preflight failed: ${summary:-limit_remaining=0}"
    exit 1
  fi

  if [[ $node_status -ne 0 ]]; then
    echo "OpenRouter key preflight OK."
    return 0
  fi

  if [[ -n "$summary" ]]; then
    echo "OpenRouter key preflight OK (${summary})"
  else
    echo "OpenRouter key preflight OK."
  fi
}

list_worker_services() {
  docker compose -f "$COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" config --services \
    | grep -Ev '^(redis|gateway|orchestrator|monitor|kafka|zookeeper)$' || true
}

verify_worker_llm_credentials() {
  local worker_services=()
  mapfile -t worker_services < <(list_worker_services)

  if [[ ${#worker_services[@]} -eq 0 ]]; then
    return 0
  fi

  local service credential_name
  for service in "${worker_services[@]}"; do
    if credential_name="$(docker compose -f "$COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" exec -T "$service" sh -lc '
      for key in OPENAI_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY MISTRAL_API_KEY GROQ_API_KEY; do
        value=$(printenv "$key" 2>/dev/null || true)
        if [ -n "$value" ]; then
          printf "%s" "$key"
          exit 0
        fi
      done
      exit 1
    ' 2>/dev/null)"; then
      echo "[Guardrail] ${service} received ${credential_name}"
    else
      echo "ERROR: Service '${service}' is running without any LLM credential in its container env."
      echo "Check ${ENV_FILE} and the compose environment mapping before starting the orchestrator."
      exit 1
    fi
  done
}

start_board() {
  if curl -sf "http://127.0.0.1:${BOARD_PORT}" >/dev/null 2>&1; then
    echo "React board already running at http://localhost:${BOARD_PORT}"
    return
  fi

  [[ -d "$BOARD_DIR/node_modules" ]] || {
    echo "ERROR: Board dependencies are not installed. Run: cd board && npm install"
    exit 1
  }

  echo "Starting React board from $BOARD_DIR..."
  (
    cd "$BOARD_DIR"
    VITE_GATEWAY_URL="$GATEWAY_URL" npm run dev -- --host 127.0.0.1 --strictPort
  ) >"$BOARD_LOG_FILE" 2>&1 &

  local board_pid=$!
  echo "$board_pid" > "$BOARD_PID_FILE"
  wait_for_board
  echo "React board available at http://localhost:${BOARD_PORT}"
  echo "Board log: $BOARD_LOG_FILE"
}

stop_board() {
  if [[ -f "$BOARD_PID_FILE" ]]; then
    kill "$(cat "$BOARD_PID_FILE")" 2>/dev/null || true
    rm -f "$BOARD_PID_FILE"
  fi
}

stop_example() {
  echo "Stopping example: $EXAMPLE_PATH"
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  pkill -f "$EXAMPLE_PATH/orchestrator.ts" 2>/dev/null || true
  stop_board
  docker compose -f "$COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" down --remove-orphans 2>/dev/null || true
  echo "Example stopped."
}

if [[ "$COMMAND" == "stop" ]]; then
  stop_example
  exit 0
fi

cleanup() {
  local exit_code=$?
  rm -f "$PID_FILE"
  stop_board
  docker compose -f "$COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" down --remove-orphans 2>/dev/null || true
  exit $exit_code
}

trap cleanup EXIT INT TERM

echo "Starting example: $EXAMPLE_PATH"
echo "Using compose file: $COMPOSE_FILE"

require_llm_credentials
probe_openrouter_key

start_board
echo "Connect to the React board at http://localhost:${BOARD_PORT}"

docker compose -f "$COMPOSE_FILE" "${COMPOSE_ENV_ARGS[@]}" up -d --build --remove-orphans
wait_for_gateway
verify_worker_llm_credentials

cd "$ROOT"
npx ts-node "$EXAMPLE_PATH/orchestrator.ts" &
ORCH_PID=$!
echo "$ORCH_PID" > "$PID_FILE"

wait "$ORCH_PID"