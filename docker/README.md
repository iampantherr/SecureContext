# SecureContext Docker Stack

Runs the full SecureContext production stack in Docker with automatic GPU detection.
Supports NVIDIA, AMD ROCm, and CPU-only modes.

## What Gets Started

| Container | Name | Purpose |
|---|---|---|
| PostgreSQL + pgvector | `securecontext-postgres` | All persistent data (memory, KB, tokens, broadcasts) |
| SecureContext API | `securecontext-api` | HTTP API — agents connect here in remote mode |
| Ollama | `securecontext-ollama` | GPU-accelerated embedding model server |
| Model init (exits) | `securecontext-ollama-init` | Pulls `nomic-embed-text` on first boot, then exits |
| nginx (prod only) | `securecontext-nginx` | Reverse proxy with rate limiting and security headers |

All containers are prefixed `securecontext-` so they are easily identifiable and
won't be confused with containers from other projects.

## Prerequisites

- Docker Desktop 4.x+ (WSL2 backend on Windows)
- NVIDIA: NVIDIA Container Runtime installed (`docker info` shows `nvidia` runtime)
- AMD: ROCm-compatible GPU on Linux only

## Quick Start

```powershell
# Windows — full stack (PostgreSQL + API + Ollama), auto GPU detect
cd C:\path\to\SecureContext
.\docker\start.ps1
```

```bash
# Linux / macOS
cd /path/to/SecureContext
chmod +x docker/detect-gpu.sh docker/start.sh
./docker/start.sh
```

On first run the launcher will:
1. Copy `.env.example` → `.env` if no `.env` exists
2. Prompt you to set `POSTGRES_PASSWORD` and `ZC_API_KEY` (refuses default credentials)
3. Auto-detect your GPU and apply the correct overlay
4. Build the `securecontext-api` Docker image from source
5. Start all containers and pull `nomic-embed-text` into the Ollama volume

## Modes

```powershell
# Windows
.\docker\start.ps1                       # full stack (default)
.\docker\start.ps1 -Mode ollama-only     # Ollama only — use with local SQLite
.\docker\start.ps1 -Mode prod            # full stack + nginx reverse proxy
.\docker\start.ps1 -GpuMode nvidia       # force NVIDIA GPU
.\docker\start.ps1 -Stop                 # stop all containers
.\docker\start.ps1 -Logs                 # tail all logs
```

```bash
# Linux / macOS
./docker/start.sh                        # full stack (default)
./docker/start.sh --mode ollama-only     # Ollama only
./docker/start.sh --mode prod            # full stack + nginx
./docker/start.sh --gpu nvidia           # force NVIDIA GPU
./docker/start.sh --stop                 # stop all containers
./docker/start.sh --logs                 # tail all logs
```

## Auto-Restart on System Reboot

All containers use `restart: unless-stopped` — they come back automatically
whenever the Docker daemon restarts.

**Windows:** Docker Desktop → Settings → General → enable **"Start Docker Desktop when you sign in"**
*(Do this once. After that, all SecureContext containers restart on every reboot.)*

**Linux:** `sudo systemctl enable docker` *(run once after installing Docker)*

**Mac:** Docker Desktop → Settings → General → enable **"Start at Login"**

## Verifying the Stack

```bash
# Health check (API server)
curl http://localhost:3099/health
# → {"status":"ok","version":"..."}

# Ollama model loaded
curl http://localhost:11434/api/tags
# → {"models":[{"name":"nomic-embed-text:latest",...}]}

# List running SecureContext containers
docker ps --filter name=securecontext
```

## Agent Configuration (Remote Mode)

Once the stack is running, set these in each Claude agent's environment:

```bash
ZC_API_URL=http://localhost:3099
ZC_API_KEY=<value of ZC_API_KEY from docker/.env>
```

The MCP plugin will proxy all storage operations to the API server instead of
reading local SQLite files directly.

## Environment Variables

Edit `docker/.env` to customise ports and settings:

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | *(required)* | PostgreSQL password — must be changed |
| `ZC_API_KEY` | *(required)* | API server auth key — must be changed |
| `POSTGRES_DB` | `securecontext` | Database name |
| `POSTGRES_USER` | `scuser` | Database user |
| `POSTGRES_PORT` | `5432` | Host port for PostgreSQL |
| `SC_API_PORT` | `3099` | Host port for SecureContext API |
| `OLLAMA_PORT` | `11434` | Host port for Ollama |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model to pull and use |
| `ZC_GPU_MODE` | `auto` | Force GPU mode: `auto \| nvidia \| amd \| cpu` |
| `OLLAMA_NUM_THREADS` | `4` | CPU threads (CPU mode only) |

## Stopping

```powershell
.\docker\start.ps1 -Stop   # Windows
```
```bash
./docker/start.sh --stop   # Linux / macOS
```

Model data persists in the `securecontext-ollama-models` Docker volume.
Database data persists in the `securecontext-postgres-data` Docker volume.
Neither is deleted on stop — only `docker volume rm` removes them.
