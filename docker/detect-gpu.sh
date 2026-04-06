#!/usr/bin/env bash
# Detects GPU type. Returns: nvidia | amd | apple | cpu

# macOS Apple Silicon
if [[ "$(uname)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  echo "apple"
  exit 0
fi

# NVIDIA — check nvidia-smi OR /dev/nvidia0
if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
  echo "nvidia"
  exit 0
fi
if [ -e /dev/nvidia0 ]; then
  echo "nvidia"
  exit 0
fi
# Check Docker NVIDIA runtime
if docker info 2>/dev/null | grep -q "nvidia"; then
  echo "nvidia"
  exit 0
fi

# AMD ROCm — check /dev/kfd (ROCm device) or rocm-smi
if [ -e /dev/kfd ] && [ -e /dev/dri ]; then
  echo "amd"
  exit 0
fi
if command -v rocm-smi &>/dev/null && rocm-smi &>/dev/null; then
  echo "amd"
  exit 0
fi

# Intel Arc / other — no Docker support yet, CPU fallback
echo "cpu"
