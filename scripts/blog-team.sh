#!/usr/bin/env bash
# =============================================================================
# kaiban-distributed — Blog Team Example Start/Stop orchestration wrapper
# =============================================================================
#
# This script manages the complete lifecycle of the "Blog Team" example.
# It handles starting Docker Compose, launching the board preview in browser,
# running the typescript orchestrator in the background, and starting the 
# real-time terminal monitor, all correctly mapped to either Redis or Kafka.
#
# Usage:
#   ./scripts/blog-team.sh start [--kafka]
#   ./scripts/blog-team.sh stop [--kafka]
# =============================================================================

set -e

COMMAND=$1
KAFKA_FLAG=${2:-""}

show_help() {
  echo "Usage: ./scripts/blog-team.sh [start|stop] [--kafka]"
  exit 1
}

if [[ "$COMMAND" != "start" && "$COMMAND" != "stop" ]]; then
  show_help
fi

# ── General Environment Setup ───────────────────────────────────────────────
export REDIS_URL="redis://localhost:6379"
export GATEWAY_URL="http://localhost:3000"
export TOPIC="AI Agents in 2025"

if [[ "$KAFKA_FLAG" == "--kafka" ]]; then
  COMPOSE_FILE="examples/blog-team/docker-compose.kafka.yml"
  export MESSAGING_DRIVER="kafka"
  export KAFKA_BROKERS="localhost:9092"
else
  COMPOSE_FILE="examples/blog-team/docker-compose.yml"
  export MESSAGING_DRIVER="bullmq"
fi

export COMPOSE_FILE

case "$COMMAND" in
  start)
    echo -e "\033[1;36mStarting the Blog Team Example (${MESSAGING_DRIVER})...\033[0m"

    # Stop any conflicting stacks seamlessly
    docker compose -f examples/blog-team/docker-compose.yml down --remove-orphans 2>/dev/null || true
    docker compose -f examples/blog-team/docker-compose.kafka.yml down --remove-orphans 2>/dev/null || true
    docker network prune --force 2>/dev/null

    # Start docker compose in detached mode
    echo "Booting Docker containers..."
    docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build

    echo "Waiting for api gateway at $GATEWAY_URL/health..."
    RETRIES=0
    while ! curl -s "$GATEWAY_URL/health" | grep -q '"status":"ok"'; do
      sleep 2
      RETRIES=$((RETRIES+1))
      if [ $RETRIES -gt 30 ]; then
        echo -e "\033[0;31mGateway failed to start in time. Aborting.\033[0m"
        exit 1
      fi
    done
    echo -e "\033[1;32mGateway is up!\033[0m"

    # Open the board preview
    BOARD_URL="file://$(pwd)/examples/blog-team/viewer/board.html"
    echo "Opening browser to $BOARD_URL"
    if command -v xdg-open &> /dev/null; then xdg-open "$BOARD_URL" >/dev/null 2>&1 &
    elif command -v open &> /dev/null; then open "$BOARD_URL" >/dev/null 2>&1 &
    elif command -v start &> /dev/null; then start "" "$BOARD_URL" >/dev/null 2>&1 &
    else echo "Please open $BOARD_URL manually in your browser."
    fi

    # Start monitor in the background
    echo "Starting real-time monitor in background..."
    export COMPOSE_FILE
    ./scripts/monitor.sh &
    MON_PID=$!
    echo $MON_PID > .blog-team-monitor.pid

    # Start orchestrator in the foreground (Interactive)
    echo -e "\n\033[1;36mStarting Orchestrator (Interactive mode)...\033[0m"
    sleep 2 # Let monitor print headers
    npx ts-node examples/blog-team/orchestrator.ts || true
    
    # Standard cleanup after orchestrator finishes or user hits Ctrl-C
    echo -e "\n\033[1;33mOrchestrator exited. Initiating teardown...\033[0m"
    ./scripts/blog-team.sh stop "$KAFKA_FLAG"
    ;;

  stop)
    echo -e "\033[1;33mStopping the Blog Team Example (${MESSAGING_DRIVER})...\033[0m"
    
    # 1. Kill background processes
    if [ -f .blog-team-orchestrator.pid ]; then
      kill "$(cat .blog-team-orchestrator.pid)" 2>/dev/null || true
      rm -f .blog-team-orchestrator.pid
    fi
    if [ -f .blog-team-monitor.pid ]; then
      kill "$(cat .blog-team-monitor.pid)" 2>/dev/null || true
      rm -f .blog-team-monitor.pid
    fi
    pkill -f "scripts/monitor.sh" 2>/dev/null || true
    pkill -f "examples/blog-team/orchestrator.ts" 2>/dev/null || true
    
    # 2. Stop Docker Compose dependencies
    docker compose -f "$COMPOSE_FILE" down --remove-orphans
    echo -e "\033[1;32mEnvironment stopped clean.\033[0m"
    ;;
esac
