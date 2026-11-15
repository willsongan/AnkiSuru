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

echo [2/3] Checking core server packages...
.venv\Scripts\python.exe -m pip install --upgrade pip -q
.venv\Scripts\python.exe -m pip install -q fastapi uvicorn python-multipart pillow numpy onnxruntime-directml transformers huggingface_hub

where nvidia-smi >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    .venv\Scripts\python.exe -c "import torch; assert torch.cuda.is_available()" >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        echo [NVIDIA GPU Detected] Replacing CPU PyTorch with CUDA PyTorch for RTX Tensor Cores...
        .venv\Scripts\python.exe -m pip uninstall -y torch torchvision torchaudio >nul 2>nul
        .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
        if %ERRORLEVEL% NEQ 0 (
            echo Trying cu128 wheel index...
            .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
        )
        if %ERRORLEVEL% NEQ 0 (
            echo Trying cu124 wheel index...
            .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124
        )
    )
)

echo [3/3] Verifying Hardware Acceleration & Starting Server...
.venv\Scripts\python.exe -c "import torch; print('>>> PyTorch CUDA Enabled:', torch.cuda.is_available(), '| GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU ONLY')" 2>nul
.venv\Scripts\python.exe server.py %*
pause
