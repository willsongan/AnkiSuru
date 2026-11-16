#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================================"
echo " AnkiSuru - Japanese Manga OCR & Study Reader (Local Server)"
echo " Keep this terminal open while using AnkiSuru!"
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
  echo "Detected NVIDIA GPU — checking CUDA PyTorch & Transformers..."
  $PIP_INSTALL --upgrade fastapi uvicorn python-multipart pillow numpy onnxruntime-gpu torch transformers huggingface_hub safetensors
elif [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  echo "Detected Apple Silicon — checking Metal MPS PyTorch packages..."
  $PIP_INSTALL --upgrade fastapi uvicorn python-multipart pillow numpy onnxruntime torch transformers huggingface_hub safetensors
else
  echo "Checking multi-core CPU server packages..."
  $PIP_INSTALL -r requirements.txt
fi

exec .venv/bin/python server.py "$@"
