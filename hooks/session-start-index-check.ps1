# session-start-index-check.ps1 -- v0.10.2
# ----------------------------------------
# SessionStart hook for Claude Code. Fires on every session start (startup /
# resume / compact / clear). Detects projects that haven't been indexed yet
# and spawns scripts/background-index.mjs in the background.
#
# Why this exists:
# On an EXISTING project (scenario 2: "user installs SC for the first time
# and runs Claude on half-built code"), no L0/L1 summaries exist. If the
# agent doesn't explicitly call zc_index_project, it falls back to full
# Reads -- spending ~3-4x more tokens. The v0.10.2 design is to detect this
# state at session start and start indexing without waiting for the agent.
#
# Graceful in all degenerate cases:
#   - SecureContext not installed → exit 0 silent
#   - CWD is not a project (no .git / package.json / etc.) → exit 0 silent
#   - Ollama not reachable → background indexer will fall back to truncation
#   - Already indexed → background indexer exits fast on its own precheck
#   - Already indexing → background indexer's precheck detects and exits
#
# Prints a <system-reminder> informing the agent that indexing is happening.

$ErrorActionPreference = 'Continue'

# ─── Precondition: SecureContext installed? ──────────────────────────────────

$scDist = if ($env:ZC_CTX_DIST) { $env:ZC_CTX_DIST } else { "$env:USERPROFILE\AI_projects\SecureContext\dist" }
$bgIndexer = Join-Path (Split-Path -Parent $scDist) "scripts\background-index.mjs"
if (-not (Test-Path $scDist) -or -not (Test-Path $bgIndexer)) { exit 0 }

# ─── Does CWD look like a project? ───────────────────────────────────────────
# Skip bare home / drive roots / etc. Only index directories with a project marker.

$projectPath = (Get-Location).Path
if ($projectPath -eq $env:USERPROFILE) { exit 0 }
if ($projectPath -match '^[A-Za-z]:[\\/]?$') { exit 0 }

$projectMarkers = @(
    '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
    '.venv', 'CLAUDE.md', 'tsconfig.json', 'pom.xml', 'build.gradle',
    'composer.json', 'Gemfile', 'requirements.txt'
)
$hasMarker = $false
foreach ($m in $projectMarkers) {
    if (Test-Path (Join-Path $projectPath $m)) { $hasMarker = $true; break }
}
if (-not $hasMarker) { exit 0 }

# ─── Probe indexing status via the node harness helper ──────────────────────
# Keeps a single source of truth (src/harness.ts getIndexingStatus) for what
# "indexed / indexing / not-indexed" means.

$probeScript = Join-Path (Split-Path -Parent $scDist) "scripts\probe-indexing-status.mjs"
if (-not (Test-Path $probeScript)) { exit 0 }

$probeOut = ""
try {
    $probeOut = & node $probeScript $projectPath 2>$null
} catch { exit 0 }

if (-not $probeOut) { exit 0 }

try {
    $status = $probeOut | ConvertFrom-Json
} catch { exit 0 }

# ─── Decision tree ───────────────────────────────────────────────────────────

switch ($status.state) {
    'error' {
        # Migration failure / corrupt DB / etc. — surface it so the agent knows
        # the harness isn't fully functional for this project.
        @"
<system-reminder>
[zc-ctx] SessionStart indexing probe hit an error: $($status.error)

This usually means the SQLite DB for this project is at an old schema that
can't be migrated automatically. Safe workarounds:
  - Run 'node SecureContext/scripts/setup-docker.mjs --health-only' to
    diagnose.
  - If the error mentions 'NOT NULL constraint', upgrade SC to v0.10.3+
    (which fixes migration 11's legacy-NULL handling).
  - Or delete the corrupt DB at ~/.claude/zc-ctx/sessions/<hash>.db and
    let SC recreate it fresh.

Agent work can still proceed — harness auto-indexing is disabled for this
project only. Other MCP tools still work.
</system-reminder>
"@ | Write-Output
        exit 0
    }
    'indexed' {
        # Nothing to do. Silent no-op. Full mode is available.
        exit 0
    }
    'indexing' {
        # Another indexer is already running (probably from a prior session
        # that hasn't finished yet). Just inform the agent.
        $pct = if ($status.totalFiles -and $status.totalFiles -gt 0) {
            [math]::Floor(($status.completedFiles / $status.totalFiles) * 100)
        } else { $null }
        $progressStr = if ($pct -ne $null) { "$($status.completedFiles)/$($status.totalFiles) files, $pct%" }
                       else { "$($status.completedFiles) files so far" }

        @"
<system-reminder>
[zc-ctx] Background indexing is already in progress for this project
($progressStr). Semantic L0/L1 summaries are being generated. Work can
proceed -- zc_file_summary(path) will return 'not indexed' for files
that haven't been processed yet, in which case fall back to Read.
</system-reminder>
"@ | Write-Output
        exit 0
    }
    'not-indexed' {
        # Read the MCP env from ~/.claude/settings.json so the background
        # indexer inherits ZC_OLLAMA_URL, ZC_SUMMARY_MODEL, etc. Without this,
        # the indexer would fall back to truncation even when Ollama is
        # reachable via the Docker port (11435).
        $mcpEnv = @{}
        $settingsPath = Join-Path $HOME ".claude\settings.json"
        if (Test-Path $settingsPath) {
            try {
                $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
                $zcCtxNode = $settings.mcpServers.PSObject.Properties['zc-ctx'].Value
                if ($zcCtxNode -and $zcCtxNode.env) {
                    foreach ($prop in $zcCtxNode.env.PSObject.Properties) {
                        $mcpEnv[$prop.Name] = $prop.Value
                    }
                }
            } catch {}
        }

        # Spawn background indexer, detached. Do not block session start.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName               = 'node'
        $psi.Arguments              = "`"$bgIndexer`" `"$projectPath`""
        $psi.UseShellExecute        = $false
        $psi.CreateNoWindow         = $true
        $psi.RedirectStandardOutput = $false
        $psi.RedirectStandardError  = $false
        # Inherit current env first
        foreach ($de in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
            $psi.EnvironmentVariables[$de.Key] = [string]$de.Value
        }
        # Then overlay MCP env (ZC_OLLAMA_URL, ZC_SUMMARY_MODEL, ZC_SUMMARY_KEEP_ALIVE, etc.)
        foreach ($key in $mcpEnv.Keys) {
            $psi.EnvironmentVariables[$key] = [string]$mcpEnv[$key]
        }
        try {
            [System.Diagnostics.Process]::Start($psi) | Out-Null
        } catch {
            # Couldn't spawn -- agent can still manually call zc_index_project()
            exit 0
        }

        @"
<system-reminder>
[zc-ctx] This project has no indexed source files yet. The SecureContext
background indexer just started -- it's summarizing every qualifying
source file via the local Ollama coder model and will take ~30-60s for a
typical repo.

DURING indexing:
  - zc_file_summary(path) may return 'not indexed' for files not yet
    processed. Fall back to Read for those.
  - Agent work is NOT blocked -- you can start the user's task immediately.
  - zc_recall_context / zc_status will show live progress in the banner.

AFTER indexing completes:
  - zc_file_summary becomes the fastest way to understand any file
    (~400 tok vs ~4000 for a full Read).
  - The PostEdit hook keeps summaries fresh on every Edit/Write.
</system-reminder>
"@ | Write-Output
        exit 0
    }
    default { exit 0 }
}
