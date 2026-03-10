#!/usr/bin/env bash
# =============================================================================
# kaiban-distributed — Real-Time System Monitor
# =============================================================================
#
# Streams ALL system activity in one terminal:
#   • Redis Pub/Sub state events  (kaiban-state-events)
#   • Docker container logs       (gateway, researcher, writer, editor)
#   • LLM calls/responses         (extracted from KaibanJS agent logs)
#   • BullMQ queue lengths        (polled every 5 seconds)
#
# Usage:
#   ./scripts/monitor.sh                          # default settings
#   REDIS_URL=redis://localhost:6379 ./scripts/monitor.sh
#   COMPOSE_FILE=examples/blog-team/docker-compose.yml ./scripts/monitor.sh
#
# Requirements:
#   - redis-cli (install: sudo apt-get install redis-tools)
#   - docker compose
#   - jq (install: sudo apt-get install jq)
#   - node (for BullMQ queue inspection)
#
# Keyboard:
#   Ctrl-C  — stop all streams and exit
# =============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

# Auto-detect redis-cli: prefer native, fall back to docker exec
REDIS_CONTAINER="${REDIS_CONTAINER:-blog-team-redis-1}"
if command -v redis-cli &>/dev/null; then
  RCLI="redis-cli"
elif docker inspect "${REDIS_CONTAINER}" &>/dev/null 2>&1; then
  RCLI="docker exec -i ${REDIS_CONTAINER} redis-cli"
else
  RCLI=""
fi
COMPOSE_FILE="${COMPOSE_FILE:-examples/blog-team/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
LOG_TAIL="${LOG_TAIL:-100}"        # lines of existing logs to show on startup
QUEUE_POLL_SEC="${QUEUE_POLL_SEC:-5}"  # how often to poll queue depths

# Extract host/port from REDIS_URL
REDIS_HOST=$(python3 -c "from urllib.parse import urlparse; u=urlparse('${REDIS_URL}'); print(u.hostname or 'localhost')" 2>/dev/null || echo "localhost")
REDIS_PORT=$(python3 -c "from urllib.parse import urlparse; u=urlparse('${REDIS_URL}'); print(u.port or 6379)" 2>/dev/null || echo "6379")

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
ts() { date '+%H:%M:%S'; }

print_header() {
  echo ""
  echo -e "${BOLD}${WHITE}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${WHITE}║     kaiban-distributed  ·  Real-Time Monitor                 ║${NC}"
  echo -e "${BOLD}${WHITE}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo -e "${DIM}  Redis: ${REDIS_HOST}:${REDIS_PORT}   Compose: ${COMPOSE_FILE}${NC}"
  echo -e "${DIM}  Press Ctrl-C to stop${NC}"
  echo ""
}

check_deps() {
  local missing=()
  [[ -n "${RCLI:-}" ]] || command -v redis-cli &>/dev/null || missing+=("redis-cli (sudo apt install redis-tools) or ensure Docker container ${REDIS_CONTAINER} is running")
  command -v docker &>/dev/null    || missing+=("docker")
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}[monitor] Missing dependencies:${NC}"
    for dep in "${missing[@]}"; do echo -e "  ${RED}• ${dep}${NC}"; done
    echo ""
  fi
}

redis_available() {
  ${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" PING &>/dev/null 2>&1
}

docker_compose_running() {
  docker compose -f "${COMPOSE_FILE}" ps --quiet 2>/dev/null | grep -q .
}

# ── Stream: Redis Pub/Sub ─────────────────────────────────────────────────────
# Colour-code agent and task statuses in pub/sub output
colour_agent_status() {
  # $1 = status string
  case "$1" in
    IDLE)      echo -e "\033[2m${1}\033[0m" ;;          # dim grey
    EXECUTING) echo -e "\033[1;32m${1}\033[0m" ;;       # bold green
    THINKING)  echo -e "\033[1;34m${1}\033[0m" ;;       # bold blue
    ERROR)     echo -e "\033[1;31m${1}\033[0m" ;;       # bold red
    *)         echo "$1" ;;
  esac
}

colour_task_status() {
  case "$1" in
    DOING)              echo -e "\033[1;34m${1}\033[0m" ;;   # bold blue
    DONE)               echo -e "\033[1;32m${1}\033[0m" ;;   # bold green
    BLOCKED)            echo -e "\033[1;31m${1}\033[0m" ;;   # bold red
    AWAITING_VALIDATION) echo -e "\033[1;33m${1}\033[0m" ;;  # bold yellow
    TODO)               echo -e "\033[2m${1}\033[0m" ;;      # dim grey
    *)                  echo "$1" ;;
  esac
}

stream_redis_pubsub() {
  echo -e "${CYAN}[pubsub]${NC} Subscribing to kaiban-state-events on ${REDIS_HOST}:${REDIS_PORT}..."
  ${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" SUBSCRIBE "kaiban-state-events" 2>/dev/null | \
  while IFS= read -r line; do
    if [[ "$line" == "message" ]] || [[ -z "$line" ]]; then continue; fi
    if [[ "$line" == "kaiban-state-events" ]]; then continue; fi

    # Parse and display agents + tasks with colour-coded statuses
    if command -v jq &>/dev/null 2>&1 && echo "$line" | jq . &>/dev/null 2>&1; then
      local workflow agents_out tasks_out
      workflow=$(echo "$line" | jq -r '.teamWorkflowStatus // ""' 2>/dev/null)
      
      # Agents line
      agents_out=""
      while IFS= read -r agent_line; do
        [[ -z "$agent_line" ]] && continue
        local name status
        name=$(echo "$agent_line" | jq -r '.name // .agentId // "?"' 2>/dev/null)
        status=$(echo "$agent_line" | jq -r '.status // "?"' 2>/dev/null)
        agents_out+="  \033[1m${name}\033[0m → $(colour_agent_status "$status")  "
      done < <(echo "$line" | jq -c '.agents[]?' 2>/dev/null)

      # Tasks line
      tasks_out=""
      while IFS= read -r task_line; do
        [[ -z "$task_line" ]] && continue
        local title status taskid
        title=$(echo "$task_line" | jq -r '.title // .taskId // "?" | .[0:35]' 2>/dev/null)
        status=$(echo "$task_line" | jq -r '.status // "?"' 2>/dev/null)
        tasks_out+="  \"${title}\" → $(colour_task_status "$status")  "
      done < <(echo "$line" | jq -c '.tasks[]?' 2>/dev/null)

      # Print
      if [[ -n "$workflow" ]]; then
        echo -e "${CYAN}$(ts) [workflow]${NC} ${workflow}"
      fi
      if [[ -n "$agents_out" ]]; then
        echo -e "${CYAN}$(ts) [agents  ]${NC}${agents_out}"
      fi
      if [[ -n "$tasks_out" ]]; then
        echo -e "${CYAN}$(ts) [tasks   ]${NC}${tasks_out}"
      fi
    else
      # Fallback: print raw
      echo -e "${CYAN}$(ts) [state:update]${NC} ${line:0:200}"
    fi
  done
}

# ── Stream: Docker logs ───────────────────────────────────────────────────────
stream_docker_logs() {
  if ! docker_compose_running; then
    echo -e "${YELLOW}[logs]${NC} Docker Compose services not running (start with: docker compose up -d)"
    return
  fi
  echo -e "${GREEN}[logs]${NC} Streaming Docker container logs..."

  docker compose -f "${COMPOSE_FILE}" logs \
    --follow \
    --timestamps \
    --tail "${LOG_TAIL}" 2>/dev/null | \
  while IFS= read -r line; do
    # Colour-code by service name
    local colour="${NC}"
    if   [[ "$line" == *"researcher"* ]]; then colour="${BLUE}"
    elif [[ "$line" == *"writer"*     ]]; then colour="${GREEN}"
    elif [[ "$line" == *"editor"*     ]]; then colour="${MAGENTA}"
    elif [[ "$line" == *"gateway"*    ]]; then colour="${YELLOW}"
    elif [[ "$line" == *"redis"*      ]]; then colour="${CYAN}"
    fi

    # Highlight LLM-related lines
    if [[ "$line" == *"executeThinking"* ]] || \
       [[ "$line" == *"finalAnswer"*     ]] || \
       [[ "$line" == *"THINKING"*        ]] || \
       [[ "$line" == *"LLM"*             ]] || \
       [[ "$line" == *"tokens"*          ]] || \
       [[ "$line" == *"model"*           ]]; then
      echo -e "${colour}${BOLD}$(ts) [LLM] ${line}${NC}"
    # Highlight errors
    elif [[ "$line" == *"Error"*   ]] || \
         [[ "$line" == *"error"*   ]] || \
         [[ "$line" == *"failed"*  ]] || \
         [[ "$line" == *"BLOCKED"* ]]; then
      echo -e "${RED}$(ts) [!ERR] ${line}${NC}"
    # Highlight completions
    elif [[ "$line" == *"DONE"*       ]] || \
         [[ "$line" == *"COMPLETE"*   ]] || \
         [[ "$line" == *"published"*  ]] || \
         [[ "$line" == *"completed"*  ]]; then
      echo -e "${GREEN}$(ts) [✓] ${line}${NC}"
    else
      echo -e "${colour}$(ts) ${line}${NC}"
    fi
  done
}

# ── Stream: BullMQ Queue Depths ───────────────────────────────────────────────
stream_queue_depths() {
  echo -e "${YELLOW}[queues]${NC} Polling BullMQ queue depths every ${QUEUE_POLL_SEC}s..."
  while true; do
    sleep "${QUEUE_POLL_SEC}"
    if ! redis_available; then continue; fi

    # BullMQ stores jobs in Redis sorted sets with keys like: bull:{queueName}:waiting
    local queues=(
      "kaiban-agents-researcher"
      "kaiban-agents-writer"
      "kaiban-agents-editor"
      "kaiban-events-completed"
      "kaiban-events-failed"
    )
    local summary=""
    for q in "${queues[@]}"; do
      local waiting
      waiting=$(${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" \
        LLEN "bull:${q}:wait" 2>/dev/null || echo "?")
      local active
      active=$(${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" \
        LLEN "bull:${q}:active" 2>/dev/null || echo "?")
      local failed
      failed=$(${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" \
        ZCARD "bull:${q}:failed" 2>/dev/null || echo "?")
      summary+="  ${q##*-}: wait=${waiting} active=${active} failed=${failed}"$'\n'
    done
    echo -e "${YELLOW}$(ts) [queues]${NC}\n${DIM}${summary}${NC}"
  done
}

# ── Stream: BullMQ Pub/Sub Completion Events ──────────────────────────────────
stream_bullmq_events() {
  # BullMQ publishes internal events on Redis keyspace / channel notifications
  # Subscribe to bull:* channels for completion events if keyspace notifications enabled
  echo -e "${MAGENTA}[events]${NC} Subscribing to BullMQ internal events..."
  ${RCLI} -h "${REDIS_HOST}" -p "${REDIS_PORT}" \
    PSUBSCRIBE "bull:*:completed" "bull:*:failed" "bull:*:active" 2>/dev/null | \
  while IFS= read -r line; do
    if [[ -z "$line" ]] || [[ "$line" == "pmessage" ]]; then continue; fi
    local colour="${NC}"
    if   [[ "$line" == *"completed"* ]]; then colour="${GREEN}"
    elif [[ "$line" == *"failed"*    ]]; then colour="${RED}"
    elif [[ "$line" == *"active"*    ]]; then colour="${BLUE}"
    fi
    [[ -z "$line" ]] || echo -e "${colour}$(ts) [bull:event] ${line}${NC}"
  done
}

# ── Cleanup ───────────────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo -e "${DIM}[monitor] Stopping all streams...${NC}"
  for pid in "${PIDS[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  echo -e "${DIM}[monitor] Done.${NC}"
  exit 0
}
trap cleanup INT TERM

# ── Main ──────────────────────────────────────────────────────────────────────
print_header
check_deps

# Check connectivity
if redis_available; then
  echo -e "${GREEN}✓ Redis reachable at ${REDIS_HOST}:${REDIS_PORT}${NC}"
else
  echo -e "${RED}✗ Redis NOT reachable at ${REDIS_HOST}:${REDIS_PORT}${NC}"
  echo -e "${DIM}  Start Redis: docker compose up -d redis${NC}"
fi

if docker_compose_running; then
  RUNNING=$(docker compose -f "${COMPOSE_FILE}" ps --format '{{.Service}}' 2>/dev/null | tr '\n' ' ')
  echo -e "${GREEN}✓ Docker services: ${RUNNING}${NC}"
else
  echo -e "${YELLOW}⚠ Docker services not running${NC}"
fi
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Launch all streams in background with prefixed output
(stream_redis_pubsub   2>&1 | sed "s/^/[pubsub] /") &
PIDS+=($!)

(stream_bullmq_events  2>&1 | sed "s/^/[bull]   /") &
PIDS+=($!)

(stream_queue_depths   2>&1 | sed "s/^/[queue]  /") &
PIDS+=($!)

(stream_docker_logs    2>&1) &
PIDS+=($!)

echo -e "${GREEN}[monitor] All streams started. Press Ctrl-C to stop.${NC}"
echo ""

# Wait for any to exit
wait
