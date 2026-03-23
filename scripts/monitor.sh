#!/usr/bin/env bash
# =============================================================================
# kaiban-distributed — Universal Real-Time Monitor
# =============================================================================
# Compatible with: root stack · examples/
# and any other compose-based kaiban stack.
#
# Usage:
#   ./scripts/monitor.sh
#   COMPOSE_FILE=examples/global-research/docker-compose.yml ./scripts/monitor.sh
#   MESSAGING_DRIVER=kafka ./scripts/monitor.sh
#
# Env vars:
#   COMPOSE_FILE      path to docker-compose.yml  (auto-detected if unset)
#   REDIS_URL         redis://host:port            (default: redis://localhost:6379)
#   MESSAGING_DRIVER  bullmq | kafka               (default: bullmq)
#   LOG_TAIL          log history lines on start   (default: 50)
#   QUEUE_POLL_SEC    queue/lag poll interval (s)  (default: 5)
#   KAFKA_BROKERS     broker list                  (default: localhost:9092)
#
# Requirements: docker  •  redis-cli or running redis container  •  jq (optional)
# Ctrl-C to stop all streams.
# =============================================================================
set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
MESSAGING_DRIVER="${MESSAGING_DRIVER:-bullmq}"
LOG_TAIL="${LOG_TAIL:-50}"
QUEUE_POLL_SEC="${QUEUE_POLL_SEC:-5}"
KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"

# ── Auto-detect compose file ──────────────────────────────────────────────────
_find_compose() {
  local candidates=(
    "examples/global-research/docker-compose.yml"
    "examples/blog-team/docker-compose.yml"
    "docker-compose.yml"
  )
  # Prefer a stack with containers currently running
  for f in "${candidates[@]}"; do
    [[ -f "$f" ]] && docker compose -f "$f" ps -q 2>/dev/null | grep -q . && { echo "$f"; return; }
  done
  # Fallback: first file that exists
  for f in "${candidates[@]}"; do
    [[ -f "$f" ]] && { echo "$f"; return; }
  done
  echo "docker-compose.yml"
}
COMPOSE_FILE="${COMPOSE_FILE:-$(_find_compose)}"

# ── Parse Redis host/port from URL ────────────────────────────────────────────
REDIS_HOST=$(python3 -c "from urllib.parse import urlparse; u=urlparse('${REDIS_URL}'); print(u.hostname or 'localhost')" 2>/dev/null || echo "localhost")
REDIS_PORT=$(python3 -c "from urllib.parse import urlparse; u=urlparse('${REDIS_URL}'); print(u.port or 6379)" 2>/dev/null || echo "6379")

# ── Redis CLI: native (with host/port) or via docker exec ─────────────────────
_resolve_rcli() {
  if command -v redis-cli &>/dev/null; then
    echo "redis-cli -h ${REDIS_HOST} -p ${REDIS_PORT}"; return
  fi
  local ctr
  ctr=$(docker compose -f "${COMPOSE_FILE}" ps --format '{{.Name}}' 2>/dev/null | grep -i redis | head -1)
  if [[ -n "$ctr" ]] && docker inspect "$ctr" &>/dev/null 2>&1; then
    echo "docker exec -i ${ctr} redis-cli"; return
  fi
  echo ""
}
RCLI=$(_resolve_rcli)

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m';  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; WHITE='\033[1;37m'
DIM='\033[2m';     BOLD='\033[1m';     NC='\033[0m'
_SVC_COLORS=("$BLUE" "$GREEN" "$MAGENTA" "$YELLOW" "$CYAN" "$WHITE")

# Deterministic color for any string — consistent per service name across runs
_svc_color() {
  local s="$1" sum=0 i
  for ((i = 0; i < ${#s}; i++)); do (( sum += $(printf '%d' "'${s:i:1}") )) || true; done
  echo "${_SVC_COLORS[$((sum % ${#_SVC_COLORS[@]}))]}"
}

ts() { date '+%H:%M:%S'; }

# Color-coded status for agents and tasks (shared)
_colour_status() {
  case "$1" in
    EXECUTING|DOING)        echo -e "\033[1;32m$1\033[0m" ;;  # bold green
    THINKING)               echo -e "\033[1;34m$1\033[0m" ;;  # bold blue
    DONE|FINISHED)          echo -e "\033[1;32m$1\033[0m" ;;  # bold green
    BLOCKED|ERROR|ERRORED)  echo -e "\033[1;31m$1\033[0m" ;;  # bold red
    AWAITING_VALIDATION)    echo -e "\033[1;33m$1\033[0m" ;;  # bold yellow
    IDLE|TODO)              echo -e "\033[2m$1\033[0m" ;;      # dim
    *)                      echo "$1" ;;
  esac
}

# ── Connectivity helpers ──────────────────────────────────────────────────────
_redis_ok()   { [[ -n "$RCLI" ]] && $RCLI PING &>/dev/null; }
_compose_ok() { docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; }

# ── Stream: Redis state events ────────────────────────────────────────────────
stream_state() {
  if [[ -z "$RCLI" ]]; then
    echo -e "${YELLOW}$(ts) [state] redis-cli unavailable — skipping pub/sub stream${NC}"; return
  fi
  echo -e "${CYAN}$(ts) [state] Subscribing to kaiban-state-events on ${REDIS_HOST}:${REDIS_PORT}...${NC}"
  $RCLI SUBSCRIBE "kaiban-state-events" 2>/dev/null \
  | while IFS= read -r line; do
      [[ -z "$line" || "$line" =~ ^(message|subscribe|kaiban-state-events|[0-9]+$) ]] && continue
      if command -v jq &>/dev/null && echo "$line" | jq . &>/dev/null 2>&1; then
        local wf
        wf=$(echo "$line" | jq -r '.teamWorkflowStatus // empty' 2>/dev/null)
        [[ -n "$wf" ]] && echo -e "${CYAN}$(ts) [workflow] ${wf}${NC}"

        while IFS= read -r a; do
          [[ -z "$a" ]] && continue
          local name stat
          name=$(echo "$a" | jq -r '.name // .agentId // "?"')
          stat=$(echo "$a" | jq -r '.status // "?"')
          echo -e "${CYAN}$(ts) [agent   ] ${BOLD}${name}${NC} → $(_colour_status "$stat")"
        done < <(echo "$line" | jq -c '.agents[]?' 2>/dev/null)

        while IFS= read -r t; do
          [[ -z "$t" ]] && continue
          local title stat
          title=$(echo "$t" | jq -r '(.title // .taskId // "?")[0:40]')
          stat=$(echo "$t" | jq -r '.status // "?"')
          echo -e "${CYAN}$(ts) [task    ] \"${title}\" → $(_colour_status "$stat")"
        done < <(echo "$line" | jq -c '.tasks[]?' 2>/dev/null)
      else
        echo -e "${CYAN}$(ts) [state   ] ${line:0:200}${NC}"
      fi
    done
}

# ── Stream: Docker compose logs (all services, colored by service name) ───────
stream_logs() {
  if ! _compose_ok; then
    echo -e "${YELLOW}$(ts) [logs] No running services in ${COMPOSE_FILE}${NC}"; return
  fi
  echo -e "${GREEN}$(ts) [logs] Streaming logs from ${COMPOSE_FILE}...${NC}"
  docker compose -f "$COMPOSE_FILE" logs --follow --timestamps --tail "$LOG_TAIL" 2>/dev/null \
  | while IFS= read -r line; do
      # Extract service name from "service-1  | ..." prefix for coloring
      local col="$NC" svc=""
      [[ "$line" =~ ^([a-zA-Z][a-zA-Z0-9_-]+)-[0-9]+[[:space:]]*\| ]] && svc="${BASH_REMATCH[1]}"
      [[ -n "$svc" ]] && col="$(_svc_color "$svc")"

      if   [[ "$line" =~ Error|error|failed|BLOCKED|ERRORED ]]; then
        echo -e "${RED}$(ts) ${line}${NC}"
      elif [[ "$line" =~ DONE|FINISHED|completed|published ]]; then
        echo -e "${GREEN}$(ts) ${line}${NC}"
      elif [[ "$line" =~ THINKING|LLM|tokens|model|executeThinking|finalAnswer ]]; then
        echo -e "${col}${BOLD}$(ts) [LLM] ${line}${NC}"
      else
        echo -e "${col}$(ts) ${line}${NC}"
      fi
    done
}

# ── Stream: BullMQ queue depths (auto-discovered from Redis) ──────────────────
stream_bullmq() {
  if [[ -z "$RCLI" ]]; then
    echo -e "${YELLOW}$(ts) [queues] redis-cli unavailable — skipping queue monitor${NC}"; return
  fi
  echo -e "${YELLOW}$(ts) [queues] Polling BullMQ queues every ${QUEUE_POLL_SEC}s...${NC}"
  while true; do
    sleep "$QUEUE_POLL_SEC"
    _redis_ok || continue
    # Discover queues dynamically from Redis key pattern
    local queues=()
    while IFS= read -r key; do
      local q="${key#bull:}"; q="${q%:wait}"
      [[ -n "$q" ]] && queues+=("$q")
    done < <($RCLI KEYS "bull:*:wait" 2>/dev/null | sort)
    [[ ${#queues[@]} -eq 0 ]] && continue

    local out=""
    for q in "${queues[@]}"; do
      local w a f
      w=$($RCLI LLEN "bull:${q}:wait"   2>/dev/null || echo "?")
      a=$($RCLI LLEN "bull:${q}:active" 2>/dev/null || echo "?")
      f=$($RCLI ZCARD "bull:${q}:failed" 2>/dev/null || echo "?")
      out+="  ${q}: wait=${w} active=${a} failed=${f}\n"
    done
    echo -e "${YELLOW}$(ts) [queues]\n${DIM}${out}${NC}"
  done
}

# ── Stream: BullMQ internal completion events (requires keyspace notifications)
stream_bullmq_events() {
  [[ -z "$RCLI" ]] && return
  echo -e "${MAGENTA}$(ts) [bull] Subscribing to BullMQ completion events...${NC}"
  $RCLI PSUBSCRIBE "bull:*:completed" "bull:*:failed" "bull:*:active" 2>/dev/null \
  | while IFS= read -r line; do
      [[ -z "$line" || "$line" == "pmessage" || "$line" =~ ^[0-9]+$ ]] && continue
      local col="$NC"
      [[ "$line" == *"completed"* ]] && col="$GREEN"
      [[ "$line" == *"failed"*    ]] && col="$RED"
      [[ "$line" == *"active"*    ]] && col="$BLUE"
      echo -e "${col}$(ts) [bull  ] ${line}${NC}"
    done
}

# ── Stream: Kafka consumer lag (groups auto-discovered from container) ─────────
stream_kafka() {
  local kafka_ctr
  kafka_ctr=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}}' 2>/dev/null \
    | grep -i kafka | grep -v zookeeper | head -1)
  if [[ -z "$kafka_ctr" ]]; then
    echo -e "${YELLOW}$(ts) [kafka] No kafka container found in ${COMPOSE_FILE}${NC}"; return
  fi
  echo -e "${YELLOW}$(ts) [kafka] Polling Kafka consumer lags every ${QUEUE_POLL_SEC}s...${NC}"
  while true; do
    sleep "$QUEUE_POLL_SEC"
    docker exec "$kafka_ctr" echo ok &>/dev/null || continue
    local groups=()
    while IFS= read -r g; do [[ -n "$g" ]] && groups+=("$g"); done \
      < <(docker exec "$kafka_ctr" kafka-consumer-groups \
            --bootstrap-server "$KAFKA_BROKERS" --list 2>/dev/null | grep kaiban | sort)
    local out=""
    for g in "${groups[@]}"; do
      local lag
      lag=$(docker exec "$kafka_ctr" kafka-consumer-groups \
              --bootstrap-server "$KAFKA_BROKERS" --describe --group "$g" 2>/dev/null \
            | awk '/[0-9]/ {sum+=$6} END {print sum+0}')
      out+="  ${g}: lag=${lag}\n"
    done
    [[ -n "$out" ]] && echo -e "${YELLOW}$(ts) [kafka ]\n${DIM}${out}${NC}"
  done
}

# ── Header ────────────────────────────────────────────────────────────────────
print_header() {
  echo ""
  echo -e "${BOLD}${WHITE}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${WHITE}║     kaiban-distributed  ·  Universal Monitor                 ║${NC}"
  echo -e "${BOLD}${WHITE}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo -e "${DIM}  Compose : ${COMPOSE_FILE}${NC}"
  echo -e "${DIM}  Redis   : ${REDIS_HOST}:${REDIS_PORT}  Driver: ${MESSAGING_DRIVER}${NC}"
  echo ""
  if _redis_ok; then
    echo -e "${GREEN}  ✓ Redis reachable${NC}"
  else
    echo -e "${RED}  ✗ Redis not reachable${NC} ${DIM}— start: docker compose -f ${COMPOSE_FILE} up -d redis${NC}"
  fi
  if _compose_ok; then
    local svcs
    svcs=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}}' 2>/dev/null | sort -u | tr '\n' ' ')
    echo -e "${GREEN}  ✓ Running: ${svcs}${NC}"
  else
    echo -e "${YELLOW}  ⚠ No running services${NC} ${DIM}— start: docker compose -f ${COMPOSE_FILE} up -d${NC}"
  fi
  echo ""
  echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${DIM}  Ctrl-C to stop all streams${NC}"
  echo ""
}

# ── Cleanup ───────────────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo -e "${DIM}[monitor] Stopping...${NC}"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  exit 0
}
trap cleanup INT TERM

# ── Main ──────────────────────────────────────────────────────────────────────
print_header

(stream_state  2>&1) & PIDS+=($!)
(stream_logs   2>&1) & PIDS+=($!)

if [[ "$MESSAGING_DRIVER" == "kafka" ]]; then
  (stream_kafka          2>&1) & PIDS+=($!)
else
  (stream_bullmq         2>&1) & PIDS+=($!)
  (stream_bullmq_events  2>&1) & PIDS+=($!)
fi

wait
