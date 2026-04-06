#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Start the SecureContext Docker stack with automatic GPU detection.

.DESCRIPTION
  Modes:
    ollama-only  — Only Ollama GPU embedding server (original behaviour)
    full         — Full production stack: PostgreSQL + API server + Ollama
    prod         — Full stack + nginx reverse proxy

  All modes auto-detect GPU and apply the correct GPU override.

.EXAMPLE
  .\docker\start.ps1                        # full stack, auto-detect GPU
  .\docker\start.ps1 -Mode ollama-only      # only Ollama (dev, local SQLite)
  .\docker\start.ps1 -Mode prod             # full stack + nginx
  .\docker\start.ps1 -GpuMode nvidia        # force NVIDIA
  .\docker\start.ps1 -Stop                  # stop everything
  .\docker\start.ps1 -Logs                  # tail all logs
#>
param(
  [ValidateSet("ollama-only","full","prod")]
  [string]$Mode = "full",

  [ValidateSet("auto","nvidia","amd","cpu")]
  [string]$GpuMode = "auto",

  [switch]$Pull,
  [switch]$Stop,
  [switch]$Logs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeBase = Join-Path $ScriptDir "docker-compose.yml"
$ComposeProd = Join-Path $ScriptDir "docker-compose.prod.yml"

# ── Stop ──────────────────────────────────────────────────────────────────────
if ($Stop) {
  Write-Host "Stopping SecureContext stack..." -ForegroundColor Yellow
  $args = @("-f", $ComposeBase)
  if ($Mode -eq "prod" -and (Test-Path $ComposeProd)) { $args += @("-f", $ComposeProd) }
  docker compose @args down
  exit 0
}

# ── Logs ──────────────────────────────────────────────────────────────────────
if ($Logs) {
  docker compose -f $ComposeBase logs -f
  exit 0
}

# ── GPU detection ─────────────────────────────────────────────────────────────
if ($GpuMode -eq "auto") {
  Write-Host "Detecting GPU..." -ForegroundColor Cyan
  $GpuMode = & (Join-Path $ScriptDir "detect-gpu.ps1")
  Write-Host "Detected GPU: $GpuMode" -ForegroundColor Green
}

# ── Compose file selection ────────────────────────────────────────────────────
$composeArgs = @("-f", $ComposeBase)

# GPU overlay
$gpuOverride = Join-Path $ScriptDir "docker-compose.$GpuMode.yml"
if (Test-Path $gpuOverride) {
  $composeArgs += @("-f", $gpuOverride)
  Write-Host "GPU profile: $GpuMode" -ForegroundColor Green
} else {
  Write-Host "GPU mode: cpu (no override file for '$GpuMode')" -ForegroundColor Yellow
}

# Prod overlay (nginx)
if ($Mode -eq "prod") {
  if (Test-Path $ComposeProd) {
    $composeArgs += @("-f", $ComposeProd)
    Write-Host "Production overlay: nginx enabled" -ForegroundColor Green
  } else {
    Write-Host "Warning: docker-compose.prod.yml not found — skipping nginx" -ForegroundColor Yellow
  }
}

# ── Env file ──────────────────────────────────────────────────────────────────
$envFile    = Join-Path $ScriptDir ".env"
$envExample = Join-Path $ScriptDir ".env.example"
if (-not (Test-Path $envFile)) {
  if (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Host "Created .env from .env.example — EDIT IT before proceeding (set passwords + keys)." -ForegroundColor Yellow
    if ($Mode -ne "ollama-only") {
      Write-Host "Required: POSTGRES_PASSWORD and ZC_API_KEY must be changed from defaults." -ForegroundColor Red
    }
  }
}

# ── Validate required env vars ────────────────────────────────────────────────
if ($Mode -ne "ollama-only") {
  $envContent = Get-Content $envFile -ErrorAction SilentlyContinue | Out-String
  if ($envContent -match "POSTGRES_PASSWORD=changeme" -or $envContent -match "ZC_API_KEY=changeme") {
    Write-Host ""
    Write-Host "ERROR: Default passwords detected in .env — do NOT deploy with default credentials." -ForegroundColor Red
    Write-Host "Edit docker/.env and set strong values for POSTGRES_PASSWORD and ZC_API_KEY." -ForegroundColor Red
    Write-Host ""
    exit 1
  }
}

# ── Build API server image (only in full/prod mode) ───────────────────────────
if ($Mode -ne "ollama-only") {
  Write-Host "Building SecureContext API server image..." -ForegroundColor Cyan
  docker compose @composeArgs build sc-api
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Check output above." -ForegroundColor Red
    exit 1
  }
}

# ── Pull or up ────────────────────────────────────────────────────────────────
if ($Pull) {
  $composeArgs += "pull"
} else {
  $composeArgs += @("up", "-d", "--remove-orphans")
}

$modeLabel = switch ($Mode) {
  "ollama-only" { "Ollama embedding server" }
  "full"        { "Full stack (PostgreSQL + API + Ollama)" }
  "prod"        { "Production stack (PostgreSQL + API + Ollama + nginx)" }
}

Write-Host "Starting: $modeLabel ($GpuMode GPU)..." -ForegroundColor Cyan
docker compose @composeArgs

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to start. Check Docker logs with: .\docker\start.ps1 -Logs" -ForegroundColor Red
  exit 1
}

# ── Post-start summary ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║           SecureContext stack is running                     ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# Read port values from .env with defaults
$envLines     = Get-Content $envFile -ErrorAction SilentlyContinue
$scApiPort    = (($envLines | Select-String '^SC_API_PORT=')    -replace '^SC_API_PORT=',    '') | Select-Object -First 1
$postgresPort = (($envLines | Select-String '^POSTGRES_PORT=')  -replace '^POSTGRES_PORT=',  '') | Select-Object -First 1
$ollamaPort   = (($envLines | Select-String '^OLLAMA_PORT=')    -replace '^OLLAMA_PORT=',    '') | Select-Object -First 1
if (-not $scApiPort)    { $scApiPort    = "3099" }
if (-not $postgresPort) { $postgresPort = "5432" }
if (-not $ollamaPort)   { $ollamaPort   = "11434" }

switch ($Mode) {
  "ollama-only" {
    Write-Host "  Ollama:     http://localhost:$ollamaPort"
    Write-Host "  Mode:       Local SQLite (MCP plugin reads DB directly)"
    Write-Host ""
    Write-Host "  Set in your Claude agent environment:"
    Write-Host "    ZC_OLLAMA_URL=http://localhost:${ollamaPort}/api/embeddings"
  }
  { $_ -in "full","prod" } {
    $apiEndpoint = if ($Mode -eq "prod") { "http://localhost:80 (via nginx)" } else { "http://localhost:$scApiPort" }
    Write-Host "  API server: $apiEndpoint"
    Write-Host "  Ollama:     http://localhost:$ollamaPort (internal to stack)"
    Write-Host "  PostgreSQL: localhost:$postgresPort"
    Write-Host ""
    Write-Host "  Set these in each agent's environment to use remote mode:"
    Write-Host "    ZC_API_URL=http://localhost:$scApiPort"
    Write-Host "    ZC_API_KEY=<your ZC_API_KEY from docker/.env>"
    Write-Host ""
    Write-Host "  Health check:"
    Write-Host "    curl http://localhost:$scApiPort/health"
  }
}

Write-Host ""
Write-Host "  SecureContext container names (safe to identify, do not stop these):" -ForegroundColor Cyan
Write-Host "    securecontext-postgres    — database"
Write-Host "    securecontext-api         — API server"
Write-Host "    securecontext-ollama      — embedding model server"
if ($Mode -eq "prod") { Write-Host "    securecontext-nginx       — reverse proxy" }
Write-Host ""
Write-Host "  Auto-restart on system reboot:" -ForegroundColor Cyan
Write-Host "    Containers use 'restart: unless-stopped' — they restart automatically"
Write-Host "    whenever the Docker daemon starts."
Write-Host ""
Write-Host "    Windows: Docker Desktop → Settings → General → 'Start Docker Desktop when you sign in'"
Write-Host "             (Enable this once and all SecureContext containers restart on every reboot)"
Write-Host ""
Write-Host "  Logs:   .\docker\start.ps1 -Logs"
Write-Host "  Stop:   .\docker\start.ps1 -Stop"
