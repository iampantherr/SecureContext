#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SecureContext Docker stack launcher
#
# Modes:
#   ollama-only  — Only Ollama embedding server (local SQLite, no PostgreSQL)
#   full         — Full stack: PostgreSQL + API server + Ollama  [DEFAULT]
#   prod         — Full stack + nginx reverse proxy
#
# Usage:
#   ./docker/start.sh                        # full stack, auto GPU detect
#   ./docker/start.sh --mode ollama-only     # Ollama only (dev)
#   ./docker/start.sh --mode prod            # full stack + nginx
#   ./docker/start.sh --gpu nvidia           # force NVIDIA GPU
#   ./docker/start.sh --stop                 # stop all containers
#   ./docker/start.sh --logs                 # tail all logs
#   ./docker/start.sh --pull                 # pull latest images
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_BASE="$SCRIPT_DIR/docker-compose.yml"
COMPOSE_PROD="$SCRIPT_DIR/docker-compose.prod.yml"

MODE="full"
GPU_MODE="auto"
STOP=false
LOGS=false
PULL=false

# ── Parse arguments ────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)    MODE="$2";     shift 2 ;;
    --gpu)     GPU_MODE="$2"; shift 2 ;;
    --stop)    STOP=true;     shift   ;;
    --logs)    LOGS=true;     shift   ;;
    --pull)    PULL=true;     shift   ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validate mode ──────────────────────────────────────────────────────────────
case "$MODE" in
  ollama-only|full|prod) ;;
  *) echo "ERROR: --mode must be ollama-only, full, or prod" >&2; exit 1 ;;
esac

# ── Stop ──────────────────────────────────────────────────────────────────────
if $STOP; then
  echo "Stopping SecureContext containers..."
  ARGS=("-f" "$COMPOSE_BASE")
  [[ "$MODE" == "prod" && -f "$COMPOSE_PROD" ]] && ARGS+=("-f" "$COMPOSE_PROD")
  docker compose "${ARGS[@]}" down
  echo "All SecureContext containers stopped."
  exit 0
fi

# ── Logs ──────────────────────────────────────────────────────────────────────
if $LOGS; then
  docker compose -f "$COMPOSE_BASE" logs -f
  exit 0
fi

# ── GPU detection ──────────────────────────────────────────────────────────────
if [[ "$GPU_MODE" == "auto" ]]; then
  echo "Detecting GPU..."
  GPU_MODE="$("$SCRIPT_DIR/detect-gpu.sh")"
  echo "Detected: $GPU_MODE"
fi

# Apple Silicon — recommend native Ollama, fall back to CPU
if [[ "$GPU_MODE" == "apple" ]]; then
  echo ""
  echo "Apple Silicon detected."
  echo "Tip: native Ollama gives best Metal GPU performance:"
  echo "  brew install ollama && ollama serve"
  echo ""
  echo "Falling back to CPU Docker mode..."
  GPU_MODE="cpu"
fi

# ── Compose file selection ─────────────────────────────────────────────────────
COMPOSE_ARGS=("-f" "$COMPOSE_BASE")

GPU_OVERRIDE="$SCRIPT_DIR/docker-compose.$GPU_MODE.yml"
if [[ -f "$GPU_OVERRIDE" ]]; then
  COMPOSE_ARGS+=("-f" "$GPU_OVERRIDE")
  echo "GPU profile: $GPU_MODE"
else
  echo "GPU mode: cpu (no override file for '$GPU_MODE')"
fi

if [[ "$MODE" == "prod" ]]; then
  if [[ -f "$COMPOSE_PROD" ]]; then
    COMPOSE_ARGS+=("-f" "$COMPOSE_PROD")
    echo "Production overlay: nginx enabled"
  else
    echo "Warning: docker-compose.prod.yml not found — skipping nginx" >&2
  fi
fi

# ── Env file ───────────────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo ""
    echo "Created docker/.env from .env.example"
    echo "IMPORTANT: Edit docker/.env and set strong values for:"
    echo "  POSTGRES_PASSWORD  and  ZC_API_KEY"
    echo ""
  else
    echo "ERROR: docker/.env not found and no .env.example to copy from." >&2
    exit 1
  fi
fi

# ── Validate credentials ───────────────────────────────────────────────────────
if [[ "$MODE" != "ollama-only" ]]; then
  if grep -qE "^POSTGRES_PASSWORD=changeme|^ZC_API_KEY=changeme" "$ENV_FILE"; then
    echo ""
    echo "ERROR: Default credentials detected in docker/.env" >&2
    echo "Do NOT deploy with default passwords. Edit docker/.env and set:" >&2
    echo "  POSTGRES_PASSWORD=<strong password>" >&2
    echo "  ZC_API_KEY=<strong key>" >&2
    echo ""
    echo "Generate a key: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"" >&2
    echo ""
    exit 1
  fi
fi

# ── Build API image (full/prod only) ──────────────────────────────────────────
if [[ "$MODE" != "ollama-only" ]]; then
  echo "Building SecureContext API server image..."
  docker compose "${COMPOSE_ARGS[@]}" build sc-api
fi

# ── Start ──────────────────────────────────────────────────────────────────────
case "$MODE" in
  ollama-only) MODE_LABEL="Ollama embedding server only" ;;
  full)        MODE_LABEL="Full stack (PostgreSQL + API + Ollama)" ;;
  prod)        MODE_LABEL="Production stack (PostgreSQL + API + Ollama + nginx)" ;;
esac

echo "Starting: $MODE_LABEL ($GPU_MODE GPU)..."

if $PULL; then
  docker compose "${COMPOSE_ARGS[@]}" pull
else
  docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans
fi

# ── Post-start summary ─────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           SecureContext stack is running                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Load port values from .env (with defaults)
SC_API_PORT=$(grep -E '^SC_API_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "3099")
SC_API_PORT="${SC_API_PORT:-3099}"
POSTGRES_PORT=$(grep -E '^POSTGRES_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "5432")
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
OLLAMA_PORT=$(grep -E '^OLLAMA_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "11434")
OLLAMA_PORT="${OLLAMA_PORT:-11434}"

case "$MODE" in
  ollama-only)
    echo "  Ollama:     http://localhost:$OLLAMA_PORT"
    echo "  Mode:       Local SQLite (MCP plugin reads DB directly)"
    echo ""
    echo "  Set in your Claude agent environment:"
    echo "    ZC_OLLAMA_URL=http://localhost:$OLLAMA_PORT/api/embeddings"
    ;;
  full|prod)
    API_ENDPOINT="http://localhost:$SC_API_PORT"
    [[ "$MODE" == "prod" ]] && API_ENDPOINT="http://localhost:80 (via nginx)"
    echo "  API server: $API_ENDPOINT"
    echo "  Ollama:     http://localhost:$OLLAMA_PORT (internal to stack)"
    echo "  PostgreSQL: localhost:$POSTGRES_PORT"
    echo ""
    echo "  Set these in each agent's environment to use remote mode:"
    echo "    ZC_API_URL=http://localhost:${SC_API_PORT}"
    echo "    ZC_API_KEY=<your ZC_API_KEY from docker/.env>"
    echo ""
    echo "  Health check:"
    echo "    curl http://localhost:${SC_API_PORT}/health"
    ;;
esac

echo ""
echo "  SecureContext container names (safe to identify, do not stop these):"
echo "    securecontext-postgres    — database"
echo "    securecontext-api         — API server"
echo "    securecontext-ollama      — embedding model server"
[[ "$MODE" == "prod" ]] && echo "    securecontext-nginx       — reverse proxy"
echo ""

# ── Auto-start reminder ────────────────────────────────────────────────────────
echo "  Auto-restart on system reboot:"
echo "    Containers use 'restart: unless-stopped' — they restart automatically"
echo "    whenever the Docker daemon starts."
echo ""
echo "    Linux:  sudo systemctl enable docker   (run once, then reboot-safe)"
echo "    Mac:    Docker Desktop → Settings → General → 'Start at Login'"
echo ""
echo "  Stop:   ./docker/start.sh --stop"
echo "  Logs:   ./docker/start.sh --logs"
echo ""
