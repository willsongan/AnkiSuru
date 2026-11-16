# Mokuro Turbo Local Package v4 (Japanese-Only SOTA `manga-ocr-base-CPT` v2 + Full-GPU Engine)

This local package runs a native RTX CUDA / Apple Metal MPS / Multi-Core backend on `http://127.0.0.1:7860` paired with the full interactive manga reader & `<90%` OCR review UI.

## What's New in v4
- **Japanese-Only SOTA Model (`muscgab/manga-ocr-base-CPT` v2)**: Trained on 141M Japanese manga crops (6,817 Japanese char vocabulary), cutting Character Error Rate on `JMangaBench_Read` from `4.81%` down to **`0.86%`** (`95.13%` Exact Match; `87.10%` Exact Match on stylized/handwritten `JMangaBench_Hard` vs `31.24%` previously).
- **Lossless FP32 + Automatic 4-Beam Rescue**: Runs ViT+BERT OCR in full FP32 precision so dakuten (`ば`/`ぱ`/`は`), small kana (`っ`/`ゃ`), and dense kanji strokes never suffer FP16 rounding loss, and automatically runs a second-pass `autocontrast` + `num_beams=4` rescue on any bubble scoring `< 90%`.
- **`< 90%` Review Highlighting**: Calibrated token-probability confidence highlights any uncertain bubble (`< 90%`) in amber on the manga page, sidebar page list, and Page Bubbles review queue.

## Quick Start
- **Windows (NVIDIA RTX/GTX, AMD, Intel)**: Double-click `run_windows.bat`.
- **macOS / Linux**:
  ```bash
  chmod +x run_mac_linux.sh
  ./run_mac_linux.sh
  ```
