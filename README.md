# AnkiSuru

**AnkiSuru** is an ongoing project for reading raw Japanese manga and learning Japanese from speech bubbles.

> **Project Status (Work in Progress):** Automatic Anki flashcard creation is the long-term end goal of this project and is still far away. Right now, AnkiSuru focuses on **manga reading, Japanese OCR extraction, and Gemini-powered English translation, Romaji, and vocabulary/grammar breakdowns**.

## Quick Start

1. Install **Python 3.10–3.12** from [Python Downloads](https://www.python.org/downloads/) — on Windows, make sure to check **"Add python.exe to PATH"** on the first installer screen.
2. Start the local server:
   - **Windows:** Double-click **`run_windows.bat`** *(if Windows shows a SmartScreen prompt, click **More info → Run anyway**)*.
   - **Mac / Linux:** Run `chmod +x run_mac_linux.sh && ./run_mac_linux.sh` in Terminal.
3. Wait a few minutes on the **very first launch** while it sets up `.venv` and downloads the AI models (~500 MB). Your browser will open automatically at `http://127.0.0.1:7860` — keep the console window open in the background while using the app.

## What You Can Do Right Now

- **Load & Read Manga:** Drop a folder or page images into the left sidebar and flip pages by clicking the side margins, swiping, or using arrow keys.
- **Extract Japanese Text:** Click **Extract All Japanese Text** to detect speech bubbles and read the Japanese dialogue (non-Japanese/empty boxes are filtered out automatically, and `<90%` uncertain reads are highlighted in yellow for quick review).
- **Translate & Break Down Grammar (Gemini API):** Paste a free API key from [Google AI Studio](https://aistudio.google.com/apikey) into **Settings** (saved locally in your browser), then click **EN + Romaji** or **Vocab & Grammar** on any bubble in **Page Bubbles**.

## Credits

Built with open-source manga models [muscgab/manga-ocr-base-CPT](https://huggingface.co/muscgab/manga-ocr-base-CPT) ([kha-white/manga-ocr](https://github.com/kha-white/manga-ocr)) and [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector).
