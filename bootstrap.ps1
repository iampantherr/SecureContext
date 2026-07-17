# SecureContext one-command bootstrap (Windows PowerShell):
#   iwr -useb https://raw.githubusercontent.com/iampantherr/SecureContext/main/bootstrap.ps1 | iex
# Clones (or updates) the repo into ~\SecureContext and runs the full installer.
$ErrorActionPreference = "Stop"
$dest = if ($env:SC_DIR) { $env:SC_DIR } else { Join-Path $env:USERPROFILE "SecureContext" }
if (-not (Get-Command git -ErrorAction SilentlyContinue))  { Write-Error "git is required"; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Node 20+ is required (https://nodejs.org)"; exit 1 }
if (Test-Path (Join-Path $dest ".git")) {
  Write-Host "Updating existing checkout at $dest…"
  git -C $dest pull --ff-only
} else {
  git clone https://github.com/iampantherr/SecureContext $dest
}
Set-Location $dest
node init.mjs @args
