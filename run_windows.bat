@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  Mokuro Turbo Native Server v3 (Full-GPU Detection + OCR)
echo ============================================================

if not exist ".venv" (
    echo [1/4] Creating Python virtual environment...
    python -m venv .venv
)

echo [2/4] Ensuring latest server ^& HuggingFace Transformers packages...
.venv\Scripts\python.exe -m pip install --upgrade pip -q
.venv\Scripts\python.exe -m pip install -q --upgrade fastapi uvicorn python-multipart pillow numpy onnxruntime-directml transformers huggingface_hub safetensors

where nvidia-smi >nul 2>nul
if errorlevel 1 goto :verify_accel

echo [3/4] Checking NVIDIA CUDA PyTorch support...
.venv\Scripts\python.exe -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul
if not errorlevel 1 goto :verify_accel

echo [NVIDIA GPU Detected] Installing CUDA-enabled PyTorch for RTX Tensor Cores...
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
echo [4/4] Verifying Hardware Acceleration ^& Launching Server...
.venv\Scripts\python.exe -c "import torch; print('>>> PyTorch:', torch.__version__, '| CUDA Active:', torch.cuda.is_available(), '| Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU ONLY')"
.venv\Scripts\python.exe server.py %*
pause
