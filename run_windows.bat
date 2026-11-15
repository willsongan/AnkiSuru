@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  Mokuro Turbo Native Server (RTX CUDA + Multi-Core Engine)
echo ============================================================

if not exist ".venv" (
    echo [1/3] Creating Python virtual environment...
    python -m venv .venv
)

echo [2/3] Installing core server and DirectML/ONNX packages...
.venv\Scripts\python.exe -m pip install --upgrade pip -q
.venv\Scripts\python.exe -m pip install -q fastapi uvicorn python-multipart pillow numpy onnxruntime-directml

where nvidia-smi >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    .venv\Scripts\python.exe -c "import torch; assert torch.cuda.is_available()" >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        echo [NVIDIA GPU Detected] Installing CUDA PyTorch + Transformers in 2 separate steps...
        .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
        if %ERRORLEVEL% NEQ 0 (
            echo Trying cu128 wheel index for newer Python...
            .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
        )
        if %ERRORLEVEL% NEQ 0 (
            echo Trying cu124 wheel index...
            .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124
        )
    )
    .venv\Scripts\python.exe -m pip install -q transformers huggingface_hub
)

echo [3/3] Starting Mokuro Turbo Server...
.venv\Scripts\python.exe server.py %*
pause
