#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Detects the best available GPU runtime for Ollama.
  Returns: "nvidia" | "amd" | "cpu"
#>

param([switch]$Verbose)

function Write-Status($msg) {
  if ($Verbose) { Write-Host "[GPU-DETECT] $msg" -ForegroundColor Cyan }
}

# --- NVIDIA check ---
Write-Status "Checking for NVIDIA GPU..."
$nvidiaSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  $output = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
  if ($LASTEXITCODE -eq 0 -and $output) {
    Write-Status "NVIDIA GPU found: $output"
    return "nvidia"
  }
}

# Check via Docker runtime list (nvidia runtime registered = NVIDIA toolkit present)
Write-Status "Checking Docker NVIDIA runtime..."
$dockerInfo = docker info --format "{{json .Runtimes}}" 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($dockerInfo -and $dockerInfo.nvidia) {
  Write-Status "NVIDIA Docker runtime found"
  return "nvidia"
}

# --- AMD check (ROCm) ---
Write-Status "Checking for AMD GPU..."
$rocmSmi = Get-Command "rocm-smi" -ErrorAction SilentlyContinue
if ($rocmSmi) {
  $rocmOut = & rocm-smi 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Status "AMD GPU found via rocm-smi"
    return "amd"
  }
}

# WMI fallback for AMD detection
$gpuInfo = Get-WmiObject Win32_VideoController 2>$null | Where-Object { $_.Name -match "AMD|Radeon" }
if ($gpuInfo) {
  Write-Status "AMD GPU found via WMI: $($gpuInfo.Name)"
  # AMD ROCm Docker only works on Linux — fall back to CPU on Windows
  Write-Status "Note: AMD ROCm Docker requires Linux. Falling back to CPU mode."
}

# --- CPU fallback ---
Write-Status "No GPU runtime detected. Using CPU."
return "cpu"
