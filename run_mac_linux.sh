#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo " Mokuro Turbo Native Server (Multi-Core + GPU Accelerator)"
echo "============================================================"

if command -v uv >/dev/null 2>&1; then
  if [ ! -d ".venv" ]; then
    uv venv .venv
  fi
  PIP_INSTALL="uv pip install --python .venv/bin/python"
else
  if [ ! -d ".venv" ]; then
    python3 -m venv .venv
  fi
  .venv/bin/python -m pip install --upgrade pip -q
  PIP_INSTALL=".venv/bin/python -m pip install -q"
fi

if command -v nvidia-smi >/dev/null 2>&1 && [ "$(uname -s)" = "Linux" ]; then
  echo "Detected NVIDIA GPU — installing onnxruntime-gpu + server packages..."
  $PIP_INSTALL fastapi uvicorn python-multipart pillow numpy onnxruntime-gpu
elif [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  echo "Detected Apple Silicon — installing Metal MPS + CoreML server packages..."
  $PIP_INSTALL fastapi uvicorn python-multipart pillow numpy onnxruntime torch transformers
else
  echo "Installing native multi-core C++ ONNX Runtime server packages..."
  $PIP_INSTALL -r requirements.txt
fi

exec .venv/bin/python server.py "$@"
