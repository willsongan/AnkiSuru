# AnkiSuru — Japanese Manga OCR, Study Reader & Anki Deck Builder

**AnkiSuru** is a local-first Japanese manga reader, speech-bubble OCR studio, offline dictionary breakdown tool, and native Anki `.apkg` flashcard builder. Drop in a manga folder or individual pages to detect speech bubbles in Japanese reading order (`Right → Left`), transcribe vertical and stylized manga lettering with **0.86% CER** Japanese-only Vision Encoder-Decoder OCR, inspect vocabulary and grammar instantly offline or with context-aware AI, and export saved words directly to Anki.

## Key Features

- **Distraction-Free Manga Reader & Select Text Overlay**: Read in light or `#121212` dark Material Design mode or press `F` for website fullscreen with smooth zoom (`+` / `−` / `0` / `Ctrl + Scroll`), 2D click-drag panning, double-click page extraction, and a top-most floating **Select Text** sentence popup (`S`).
- **Neural Speech-Bubble Boundary & SOTA v2 Japanese OCR**: Uses compact `RT-DETRv2` (`11.1 MB` INT8) or `Mokuro CTD` (`WebGPU`) boundary detection paired with `muscgab/manga-ocr-base-CPT` (`Manga OCR v2`, 6,817-character Japanese vocabulary), plus automatic `<90%` confidence highlighting and a cross-page **Review Queue** (`R`).
- **Instant 0ms Offline Romaji & Vocabulary Breakdown**: Powered client-side by `kuromoji.js` (`MeCab-IPADIC`), a `10ten` / `Yomitan`-inspired Japanese verb & adjective de-inflector, `OpenJLPT` (`IndexedDB`), and automatic `EDRDG JMdict` (`jmdict-simplified`) local server caching — zero API keys or per-bubble latency required.
- **Single-Bubble & Cross-Page Ordered Batch Study**: Optionally connect a Gemini API key to generate context-verified Hepburn Romaji, natural English translation, and structured vocabulary + grammar breakdowns for a single bubble or an ordered sequence of bubbles (`1 → 2 → 3…`) selected across multiple pages (`B` or `Shift + Click`).
- **Saved Vocabulary Flashcards & Native Anki `.apkg` Export**: Save individual words (`+ Save`) or whole bubbles (`+ Save All`), review them with interactive flip cards (`V`), and export a ready-to-import **Anki `.apkg`** SQLite3 package (Front: Kanji · Back: Romaji + Meaning) or UTF-8 tab-separated `.txt` deck.

## Quick Start

### 1. Local GPU / Multi-Core Server (Recommended)

- **Windows**: Double-click `run_windows.bat` (automatically detects NVIDIA CUDA, DirectML, or multi-core CPU, creates `.venv`, caches weights once under `~/.cache/ankisuru`, and opens `http://127.0.0.1:7860`).
- **macOS / Linux**:
  ```bash
  chmod +x run_unix.sh
  ./run_unix.sh
  ```

### 2. Browser-Only Multi-Worker Mode

Serve `static/` over any static HTTP server (or open the standalone HTML bundle) to run quantized `RT-DETRv2` / `Mokuro CTD` and `Manga OCR v2` (`ONNX Runtime Web` WebGPU + WASM Web Workers), offline `Kuromoji` Romaji, `OpenJLPT` Instant Vocab, and SQLite3 `.apkg` generation directly in your browser.

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `←` / `→` or `PageUp` / `PageDown` | Navigate between manga pages |
| `F` / `Esc` | Toggle website fullscreen reader / close active popup or mode |
| `+` / `−` / `0` / `Ctrl + Scroll` | Zoom in, zoom out, or reset page to Fit Screen |
| `S` (or double-click page) | Toggle **Select Text** overlay & floating sentence popup |
| `B` (or `Shift + Click` bubble) | Toggle **Batch Select** ordered cross-page bubble queue |
| `R` / `N` / `P` | Open `<90%` OCR **Review Queue** / jump to next or previous `<90%` bubble |
| `V` / `Space` | Open **Saved Vocabulary** tab / flip active review flashcard |

## Open-Source Acknowledgments, Models & Licenses

AnkiSuru stands on the shoulders of the open-source Japanese NLP, manga OCR, computer vision, and spaced-repetition communities. Every model, dictionary dataset, and runtime library used in this project is respectfully credited below under its original license:

### Japanese Manga OCR & Speech-Bubble Detection

| Project / Model | Authors & Maintainers | Role in AnkiSuru | License |
| :--- | :--- | :--- | :--- |
| [muscgab/manga-ocr-base-CPT](https://huggingface.co/muscgab/manga-ocr-base-CPT) | `muscgab` | Default **Manga OCR v2** Vision Encoder-Decoder continually pre-trained on Japanese manga crops (0.86% CER, 6,817 JP vocab) | Apache-2.0 |
| [Quien1/manga-ocr-base-CPT-v2-ONNX](https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX) | `Quien1` | Quantized INT8 ONNX encoder & merged decoder weights for browser Web Worker OCR | Apache-2.0 |
| [kha-white/manga-ocr](https://github.com/kha-white/manga-ocr) ([manga-ocr-base](https://huggingface.co/kha-white/manga-ocr-base)) | Maciej Budyś (`kha-white`) | Foundational Vision Encoder-Decoder manga OCR architecture, character vocabulary, and local fallback model | Apache-2.0 |
| [kha-white/mokuro](https://github.com/kha-white/mokuro) | Maciej Budyś (`kha-white`) | Pioneering selectable Japanese manga reader pipeline and `.json` coordinate transcript schema inspiration | GPL-3.0 |
| [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) | Oghenekome Kalu (`ogkalu`) | Default **RT-DETRv2** (`11.1 MB` INT8 & FP32 640px) comic text and speech-bubble boundary detector | Apache-2.0 |
| [dmMaze/comic-text-detector](https://github.com/dmMaze/comic-text-detector) & [HighLiuk/japanese-onnx-models](https://huggingface.co/HighLiuk/japanese-onnx-models) | `dmMaze`, `HighLiuk` | **Mokuro CTD** YOLOv5 / DBNet comic text-block detector and ONNX WebGPU model export | GPL-3.0 |

### Japanese Morphology, De-inflection & Lexical Dictionaries

| Project / Dataset | Authors & Maintainers | Role in AnkiSuru | License |
| :--- | :--- | :--- | :--- |
| [takuyaa/kuromoji.js](https://github.com/takuyaa/kuromoji.js/) ([Atilika Kuromoji](https://www.atilika.org/) + **MeCab-IPADIC**) | Takuya Asano, Atilika Inc., NAIST & IPA | Client-side Japanese morphological segmentation, POS tagging, and kana readings for 0ms Offline Romaji & Instant Vocab | Apache-2.0 / IPADIC (BSD-style) |
| [EDRDG JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) | Jim Breen & the Electronic Dictionary Research and Development Group (EDRDG) | Comprehensive Japanese-English lexical dictionary entries, readings, parts of speech, and glosses | CC BY-SA 4.0 |
| [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified) | Dmitry Shpika (`scriptin`) | Structured JSON build of EDRDG JMdict powering `server.py`'s local SSD dictionary index (`/api/jmdict_lookup`) | CC BY-SA 4.0 (data) / MIT (code) |
| [evanclan/OpenJLPT](https://github.com/evanclan/OpenJLPT) | `evanclan` | JMdict-verified JLPT N5–N1 vocabulary dataset (`7,811` entries) cached in browser `IndexedDB` for instant offline lookup | CC BY-SA 4.0 |
| [birchill/10ten-ja-reader](https://github.com/birchill/10ten-ja-reader) & [yomidevs/yomitan](https://github.com/yomidevs/yomitan) ([Yomitan Wiki](https://yomitan.wiki/)) | Brian Birtles (`birchill`) & Yomitan Contributors | Linguistic reference and design inspiration for rule-based Japanese verb, adjective, and colloquial manga contraction de-inflection | GPL-3.0 |

### ML Inference Runtimes, Web UI, Server & Spaced Repetition

| Library / Platform | Authors & Maintainers | Role in AnkiSuru | License |
| :--- | :--- | :--- | :--- |
| [ONNX Runtime](https://onnxruntime.ai/) ([microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)) | Microsoft Corporation & Contributors | `onnxruntime-web` WebGPU / WASM browser workers and multi-core Python ONNX execution | MIT |
| [PyTorch](https://github.com/pytorch/pytorch) | PyTorch Contributors / Linux Foundation | Lossless FP32 CUDA, DirectML, Apple Metal MPS, and multi-core CPU inference in `server.py` | BSD-3-Clause |
| [Hugging Face Transformers](https://github.com/huggingface/transformers) & [huggingface_hub](https://github.com/huggingface/huggingface_hub) | Hugging Face Inc. & Contributors | `VisionEncoderDecoderModel` generation, `<90%` beam-search rescue (`num_beams=4`), and local checkpoint caching | Apache-2.0 |
| [FastAPI](https://github.com/fastapi/fastapi) & [Uvicorn](https://github.com/encode/uvicorn) | Sebastián Ramírez (`tiangolo`) & Encode | Asynchronous local Python HTTP bridge for batched GPU OCR, JMdict lookup, and `.apkg` packaging | MIT / BSD-3-Clause |
| [Pillow](https://github.com/python-pillow/Pillow) & [NumPy](https://github.com/numpy/numpy) | Jeffrey A. Clark (Alex) & Pillow / NumPy Contributors | Bicubic dakuten-safe bubble cropping, autocontrast preprocessing, and NMS tensor math | MIT-CMU / BSD-3-Clause |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) & Google Fonts (**Roboto**, **Roboto Mono**, **Noto Sans JP**) | Tailwind Labs Inc. & Google Fonts Contributors | Responsive Material Design layout and Japanese / monospace typography | MIT / SIL OFL 1.1 |
| [Anki](https://apps.ankiweb.net/) ([ankitects/anki](https://github.com/ankitects/anki)) | Damien Elmes & Ankitects Pty Ltd | Open SQLite3 `.apkg` (`collection.anki2` + `media`) flashcard package format targeted by the vocabulary exporter | AGPL-3.0 |

> **Dictionary Attribution Notice (CC BY-SA 4.0)**: Instant vocabulary glosses in AnkiSuru incorporate data from the [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) dictionary files, which are the property of the Electronic Dictionary Research and Development Group (EDRDG) and are used in conformance with the Group's [CC BY-SA 4.0 license](https://www.edrdg.org/edrdg/licence.html), via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) and [OpenJLPT](https://github.com/evanclan/OpenJLPT).
