@echo off
setlocal
cd /d "%~dp0"
title AnkiSuru Local Server
echo ============================================================
echo  AnkiSuru - Japanese Manga OCR ^& Study Reader (Local Server)
echo  Keep this window open in the background while reading!
echo ============================================================

if not exist ".venv" (
    echo [1/4] First-time setup: Creating private Python folder ^(.venv^)...
    python -m venv .venv
)

echo [2/4] Checking required Python packages...
.venv\Scripts\python.exe -m pip install --upgrade pip -q
.venv\Scripts\python.exe -m pip install -q --upgrade fastapi uvicorn python-multipart pillow numpy onnxruntime-directml transformers huggingface_hub safetensors

where nvidia-smi >nul 2>nul
if errorlevel 1 goto :verify_accel

echo [3/4] Checking NVIDIA graphics card ^(CUDA GPU^) support...
.venv\Scripts\python.exe -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul
if not errorlevel 1 goto :verify_accel

echo [NVIDIA GPU Detected] Installing GPU-accelerated PyTorch ^(first time only^)...
.venv\Scripts\python.exe -m pip uninstall -y torch torchvision torchaudio >nul 2>nul

.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
.venv\Scripts\python.exe -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul
if not errorlevel 1 goto :verify_accel

echo Trying cu128 PyTorch wheel index...
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul
if not errorlevel 1 goto :verify_accel

echo Trying cu124 PyTorch wheel index...
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124

:verify_accel
echo [4/4] Starting AnkiSuru ^& opening your browser...
.venv\Scripts\python.exe -c "import torch; print('>>> PyTorch:', torch.__version__, '| GPU Active:', torch.cuda.is_available(), '| Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU Mode')"
.venv\Scripts\python.exe server.py %*
pause
