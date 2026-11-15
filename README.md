# Mokuro Turbo Local Package (Multi-Core C++ & GPU Batched Manga OCR)

This local package removes browser WebAssembly limits by running a native multi-core C++ ONNX Runtime / PyTorch GPU backend on `http://127.0.0.1:7860` paired with the full interactive web UI.

## Quick Start (1 Click / 1 Command)

- **Windows (NVIDIA RTX/GTX, AMD, Intel)**: Double-click `run_windows.bat`.
  - Automatically detects NVIDIA GPUs (including RTX 2060 / 30xx / 40xx laptops via `nvidia-smi`), installs CUDA `torch` from PyTorch's wheel index **and** `transformers` from PyPI in separate steps, and opens `http://127.0.0.1:7860`.
- **macOS / Linux**:
  ```bash
  chmod +x run_mac_linux.sh
  ./run_mac_linux.sh
  ```

## Manual NVIDIA CUDA Install (Windows `.venv`)

Important: Do **not** put `transformers` on the same `--index-url` line as `torch`, because `download.pytorch.org` only hosts PyTorch wheels (not PyPI packages like `transformers`). Run them as two separate commands:

```bat
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
.venv\Scripts\python.exe -m pip install transformers huggingface_hub
```
*(If your Python version is 3.13+, `cu126` or `cu128` provides prebuilt Windows wheels supporting Turing `sm_75` RTX 2060 through Blackwell GPUs.)*

## Custom Worker Thread Count

```bash
.venv\Scripts\python.exe server.py --workers 6 --port 7860
```
