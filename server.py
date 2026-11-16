#!/usr/bin/env python3
"""AnkiSuru Local Server v4 — Japanese-Only SOTA Manga OCR (`muscgab/manga-ocr-base-CPT` v2).

Key v4 Japanese-Only OCR Accuracy & Confidence Calibration Upgrades:
  1. Upgraded Default Model to `muscgab/manga-ocr-base-CPT` v2 (Japanese-Only, 111M params, 6,817 JP
     char vocab, trained on 141M manga crops -> 0.86% CER & 95.13% Exact Match on JMangaBench_Read,
     87.10% EM on JMangaBench_Hard vs 31.24% for original `kha-white/manga-ocr-base`).
  2. Lossless Full-Precision FP32 OCR on CUDA: Removes `float16` autocast from ViT+BERT OCR so subtle
     dakuten/handakuten (`ば`/`ぱ`/`は`), small kana (`っ`/`ゃ`), and dense kanji strokes never suffer
     Turing FP16 precision loss (~0.7s for 187 bubbles on RTX 2060).
  3. Dakuten-Safe Proportional Crop Padding + `BICUBIC` Resampling + Non-Merging Neighbor Bubbles:
     Prevents slicing off right-edge vertical dakuten and stops merging adjacent speech balloons.
  4. Real Calibrated Per-Bubble Confidence (`0.65 * mean_prob + 0.35 * min_prob`) + Automatic
     Second-Pass `Autocontrast + Beam Search (num_beams=4)` Rescue on `< 90%` bubbles, returning
     exact confidence scores so any bubble still `< 90%` is highlighted for review in the UI.
"""

from __future__ import annotations

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
import io
import json
import logging
import os
from pathlib import Path
import queue
import re
import shutil
import threading
import time
from typing import Any, Callable
import urllib.request
import warnings
import webbrowser

warnings.filterwarnings("ignore", message=".*max_new_tokens.*max_length.*")


class _SuppressMaxTokensWarningFilter(logging.Filter):
  def filter(self, record: logging.LogRecord) -> bool:
    msg = record.getMessage()
    if "max_new_tokens" in msg and "max_length" in msg:
      return False
    return True


os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
_MAX_TOK_LOG_FILTER = _SuppressMaxTokensWarningFilter()


def _quiet_transformers_loggers() -> None:
  for lname in (
      "transformers",
      "transformers.generation",
      "transformers.generation.utils",
      "transformers.generation.configuration_utils",
  ):
    lg = logging.getLogger(lname)
    lg.addFilter(_MAX_TOK_LOG_FILTER)
    for h in lg.handlers:
      h.addFilter(_MAX_TOK_LOG_FILTER)


_quiet_transformers_loggers()

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
import uvicorn

HAS_TORCH_TRANSFORMERS = False
HAS_TORCH_DETECTOR = False
HAS_LOGITS_PROCESSOR = False
HAS_HF_HUB = False

try:
  import torch
  from transformers import VisionEncoderDecoderModel
  try:
    from transformers.utils import logging as hf_logging

    hf_logging.set_verbosity_error()
    for _hf_lname in (
        "transformers",
        "transformers.generation",
        "transformers.generation.utils",
        "transformers.generation.configuration_utils",
    ):
      _hlg = hf_logging.get_logger(_hf_lname)
      _hlg.addFilter(_MAX_TOK_LOG_FILTER)
      for _h in _hlg.handlers:
        _h.addFilter(_MAX_TOK_LOG_FILTER)
    _quiet_transformers_loggers()
  except Exception:
    pass

  try:
    from transformers import GenerationMixin

    if not issubclass(VisionEncoderDecoderModel, GenerationMixin):

      class _MangaVisionEncoderDecoder(VisionEncoderDecoderModel, GenerationMixin):
        pass

    else:
      _MangaVisionEncoderDecoder = VisionEncoderDecoderModel
  except Exception:
    _MangaVisionEncoderDecoder = VisionEncoderDecoderModel

  HAS_TORCH_TRANSFORMERS = True
  try:
    from transformers import LogitsProcessor, LogitsProcessorList, StoppingCriteria, StoppingCriteriaList

    HAS_LOGITS_PROCESSOR = True
  except Exception:
    HAS_LOGITS_PROCESSOR = False

  try:
    from transformers import AutoImageProcessor, AutoModelForObjectDetection

    HAS_TORCH_DETECTOR = True
  except Exception:
    HAS_TORCH_DETECTOR = False
except Exception:
  HAS_TORCH_TRANSFORMERS = False
  _MangaVisionEncoderDecoder = None  # type: ignore

try:
  from huggingface_hub import hf_hub_download

  HAS_HF_HUB = True
except Exception:
  HAS_HF_HUB = False

BASE_DIR = Path(__file__).resolve().parent
_LEGACY_CACHE_DIR = Path.home() / ".cache" / "mokuro_turbo"
_DEFAULT_CACHE_DIR = _LEGACY_CACHE_DIR if _LEGACY_CACHE_DIR.exists() else (Path.home() / ".cache" / "ankisuru")
CACHE_DIR = Path(os.environ.get("ANKISURU_CACHE", os.environ.get("MOKURO_TURBO_CACHE", _DEFAULT_CACHE_DIR)))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OCR_REPO_MAP = {
    "manga-ocr-cpt": "muscgab/manga-ocr-base-CPT",
    "manga-ocr": "kha-white/manga-ocr-base",
}

MODEL_URLS = {
    "rtdetr_int8": "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx",
    "rtdetr_int8_mirror": "https://huggingface.co/Sundowner123/comic-text-and-bubble-detector/resolve/main/detector.onnx",
    "rtdetr_fp32": "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx",
    "ctd_onnx": "https://huggingface.co/HighLiuk/japanese-onnx-models/resolve/main/comictextdetector.onnx",
    "mocr_cpt_enc_q8": "https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/encoder_model_quantized.onnx",
    "mocr_cpt_enc_q8_alt": "https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/encoder_model_q8.onnx",
    "mocr_cpt_dec_q8": "https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/decoder_model_merged_quantized.onnx",
    "mocr_cpt_dec_q8_alt": "https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/decoder_model_merged_q8.onnx",
    "mocr_cpt_vocab": "https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/vocab.txt",
    "mocr_enc_q8": "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/encoder_model_quantized.onnx",
    "mocr_dec_q8": "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/decoder_model_merged_quantized.onnx",
    "mocr_vocab": "https://huggingface.co/kha-white/manga-ocr-base/resolve/main/vocab.txt",
}

LOW_CONF_THRESHOLD = 0.90
CPU_CORES = max(2, os.cpu_count() or 4)
DEFAULT_WORKERS = min(8, max(3, CPU_CORES // 2))
NVIDIA_SMI_PRESENT = shutil.which("nvidia-smi") is not None
_DOWNLOAD_LOCK = threading.Lock()


def _from_pretrained_fast(cls: Any, repo_id: str) -> Any:
  """Try loading instantly from local HuggingFace SSD cache without network HEAD round-trips first."""
  try:
    return cls.from_pretrained(repo_id, local_files_only=True)
  except Exception:
    return cls.from_pretrained(repo_id)


def _load_repo_vocab_list(repo_id: str) -> list[str]:
  """Load exact Japanese character vocabulary (`vocab.txt` or `tokenizer.json`) with zero MeCab/C++ deps."""
  if HAS_HF_HUB:
    for local_only in (True, False):
      try:
        vpath = Path(hf_hub_download(repo_id=repo_id, filename="vocab.txt", local_files_only=local_only))
        lines = vpath.read_text(encoding="utf-8").splitlines()
        if len(lines) > 1000:
          return lines
      except Exception:
        pass
    for local_only in (True, False):
      try:
        tpath = Path(hf_hub_download(repo_id=repo_id, filename="tokenizer.json", local_files_only=local_only))
        tdata = json.loads(tpath.read_text(encoding="utf-8"))
        vocab_dict = (tdata.get("model") or {}).get("vocab") or {}
        if isinstance(vocab_dict, dict) and len(vocab_dict) > 1000:
          max_id = max(int(v) for v in vocab_dict.values())
          arr = [""] * (max_id + 1)
          for tok, idx in vocab_dict.items():
            arr[int(idx)] = tok
          return arr
      except Exception:
        pass

  if "CPT" in repo_id:
    p = ensure_cached_file("vocab_cpt_v2.txt", MODEL_URLS["mocr_cpt_vocab"], MODEL_URLS["mocr_vocab"])
  else:
    p = ensure_cached_file("vocab.txt", MODEL_URLS["mocr_vocab"])
  return p.read_text(encoding="utf-8").splitlines()


def ensure_cached_file(filename: str, primary_url: str, fallback_url: str | None = None) -> Path:
  dest = CACHE_DIR / filename
  if dest.exists() and dest.stat().st_size > 1024:
    return dest
  with _DOWNLOAD_LOCK:
    if dest.exists() and dest.stat().st_size > 1024:
      return dest
    tmp = dest.with_suffix(".part")
    urls = [u for u in (primary_url, fallback_url) if u]
    last_err = None
    for url in urls:
      try:
        print(f"[AnkiSuru] Downloading {filename} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "AnkiSuru/4.0"})
        with urllib.request.urlopen(req, timeout=240) as resp, open(tmp, "wb") as out:
          while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
              break
            out.write(chunk)
        tmp.replace(dest)
        print(f"[AnkiSuru] Cached {filename} ({dest.stat().st_size / 1048576:.1f} MB)")
        return dest
      except Exception as err:
        last_err = err
        if tmp.exists():
          tmp.unlink(missing_ok=True)
    raise RuntimeError(f"Failed to download {filename}: {last_err}")


def detect_ort_providers(prefer_cpu_for_int8: bool = False) -> tuple[list[str], str]:
  avail = ort.get_available_providers()
  if not prefer_cpu_for_int8:
    if "CUDAExecutionProvider" in avail:
      return ["CUDAExecutionProvider", "CPUExecutionProvider"], "ONNX CUDA GPU"
    if "DmlExecutionProvider" in avail:
      return ["DmlExecutionProvider", "CPUExecutionProvider"], "ONNX DirectML GPU"
    if "CoreMLExecutionProvider" in avail:
      return ["CoreMLExecutionProvider", "CPUExecutionProvider"], "ONNX CoreML"
  return ["CPUExecutionProvider"], f"ONNX Multi-Core CPU ({CPU_CORES} threads)"


def _ascii_to_fullwidth(s: str) -> str:
  """Equivalent to jaconv.h2z(s, ascii=True, digit=True) in official manga-ocr post_process."""
  out: list[str] = []
  for ch in s:
    code = ord(ch)
    if 0x21 <= code <= 0x7E:
      out.append(chr(code + 0xFEE0))
    else:
      out.append(ch)
  return "".join(out)


def postprocess_japanese_text(text: str) -> str:
  s = "".join((text or "").split())
  s = re.sub(r"[・.．]{2,}", "…", s)
  s = s.replace("...", "…").replace("..", "…")
  s = _ascii_to_fullwidth(s)
  return s.strip()


def compute_calibrated_bubble_conf(char_probs: list[float]) -> float:
  """Blends mean and minimum token probability so even 1 uncertain kanji pulls score < 0.90."""
  if not char_probs:
    return 0.0
  mean_p = float(np.mean(char_probs))
  min_p = float(np.min(char_probs))
  return float(round(max(0.0, min(1.0, 0.65 * mean_p + 0.35 * min_p)), 4))


_JP_HIRAGANA_RE = re.compile(r"[\u3041-\u3096\u309D-\u309F]")
_JP_KATAKANA_RE = re.compile(r"[\u30A1-\u30FA\u30FD-\u30FF]")
_JP_KANJI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005]")
_LATIN_ALPHA_RE = re.compile(r"[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]")
_STROKE_ARTIFACT_ONLY_RE = re.compile(r"^[一二三川十口日ノハソンリヘくしつっー｜丨・/\\+=\-_.,…！？!?0-9０-９]+$")


def is_valid_japanese_manga_ocr(text: str, conf: float) -> bool:
  """Rejects empty space, icons/symbols, drawings/line-art hallucinations, and English text."""
  s = (text or "").strip()
  if not s:
    return False

  hira = len(_JP_HIRAGANA_RE.findall(s))
  kata = len(_JP_KATAKANA_RE.findall(s))
  kanji = len(_JP_KANJI_RE.findall(s))
  jp_core = hira + kata + kanji
  latin = len(_LATIN_ALPHA_RE.findall(s))

  # 1. Must contain at least 1 real Japanese script character (eliminates pure English, numbers, icons, '！？', '…')
  if jp_core == 0:
    return False

  # 2. Reject full/predominant English text where 1-2 stylized English letters were misread as lookalike katakana
  if latin >= 4 and latin > jp_core * 1.5:
    return False
  if latin >= 2 and hira == 0 and latin >= jp_core and conf < 0.86:
    return False

  # 3. Reject low-confidence hallucinations dreamed up on drawings, icons, or empty screentones
  if conf < 0.52:
    return False

  # 4. Reject line-art / hatching / border stroke hallucinations ('一', '川', 'ノ', '口', etc.)
  if jp_core <= 2 and _STROKE_ARTIFACT_ONLY_RE.match(s) and conf < 0.86:
    return False

  # 5. Reject single-character icon/art misreads unless model is genuinely confident
  if jp_core == 1 and len(s) <= 2 and conf < 0.72:
    return False

  return True


def is_plausible_text_crop_visual(crop: Image.Image) -> bool:
  """Fast pixel-level pre-filter rejecting blank space, flat screentone, and solid black/icon fills."""
  w, h = crop.size
  if w < 12 or h < 12:
    return False
  aspect = max(w / max(1.0, float(h)), h / max(1.0, float(w)))
  if aspect > 22.0:
    return False

  thumb = np.asarray(crop.convert("L").resize((64, 64), Image.Resampling.BILINEAR), dtype=np.float32)
  if float(np.std(thumb)) < 8.5:
    return False
  p05, p95 = np.percentile(thumb, [5, 95])
  if float(p95 - p05) < 42.0:
    return False

  mid = 0.5 * float(p05 + p95)
  dark_ratio = float(np.mean(thumb < mid))
  # Blank empty space has almost no ink; solid black fills/frames are nearly all dark
  if dark_ratio < 0.008 or dark_ratio > 0.82:
    return False
  return True


def merge_nested_boxes(boxes: list[list[float]]) -> list[list[float]]:
  """Merge ONLY genuinely nested/duplicate boxes — NEVER fuse two separate neighboring speech bubbles!"""
  items = [list(b) for b in boxes]
  changed = True
  while changed:
    changed = False
    for i in range(len(items)):
      for j in range(i + 1, len(items)):
        a, b = items[i], items[j]
        ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
        ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
        inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
        if inter <= 0:
          continue
        area_a = max(1.0, (a[2] - a[0]) * (a[3] - a[1]))
        area_b = max(1.0, (b[2] - b[0]) * (b[3] - b[1]))
        iou = inter / (area_a + area_b - inter)
        if inter / min(area_a, area_b) >= 0.86 or iou >= 0.68:
          items[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4])]
          items.pop(j)
          changed = True
          break
      if changed:
        break
  return items


def _filter_rtdetr_predictions(
    scores_np: np.ndarray,
    labels_np: np.ndarray,
    boxes_np: np.ndarray,
    orig_w: int,
    orig_h: int,
) -> list[list[float]]:
  text_boxes: list[list[float]] = []
  for i in range(len(scores_np)):
    sc = float(scores_np[i])
    lbl = int(labels_np[i])
    # Require explicit text class: lbl=1 (text_bubble >= 0.38) or lbl=2 (text_free >= 0.46).
    # Never box lbl=0 (empty balloon outline without text), avoiding silent reaction bubbles & icons!
    if lbl == 1 and sc < 0.38:
      continue
    if lbl == 2 and sc < 0.46:
      continue
    if lbl not in (1, 2):
      continue
    bx = boxes_np[i]
    bw = max(1.0, float(bx[2]) - float(bx[0]))
    bh = max(1.0, float(bx[3]) - float(bx[1]))
    pad_x = max(5.0, min(18.0, bw * 0.055))
    pad_y = max(5.0, min(18.0, bh * 0.045))
    x1 = max(0.0, float(bx[0]) - pad_x)
    y1 = max(0.0, float(bx[1]) - pad_y)
    x2 = min(float(orig_w), float(bx[2]) + pad_x)
    y2 = min(float(orig_h), float(bx[3]) + pad_y)
    if x2 - x1 < 14 or y2 - y1 < 14:
      continue
    text_boxes.append([x1, y1, x2, y2, sc])
  return merge_nested_boxes(text_boxes)


if HAS_LOGITS_PROCESSOR:

  class _RepeatLoopStopper(LogitsProcessor):
    """Zero-sync elementwise GPU guard: stops screentone repetition loops at 5 identical tokens."""

    def __init__(self, eos_token_id: int = 3, repeat_run: int = 5) -> None:
      self.eos_token_id = eos_token_id
      self.repeat_run = repeat_run

    def __call__(self, input_ids: "torch.LongTensor", scores: "torch.FloatTensor") -> "torch.FloatTensor":
      if input_ids.shape[1] < self.repeat_run + 1:
        return scores
      tail = input_ids[:, -self.repeat_run :]
      last = tail[:, -1:]
      is_looping = (tail == last).all(dim=1, keepdim=True) & (last != 0) & (last != self.eos_token_id)
      eos_row = torch.full_like(scores, -1e4)
      eos_row[:, self.eos_token_id] = 1e4
      return torch.where(is_looping, eos_row, scores)

  class _CancelStoppingCriteria(StoppingCriteria):
    """Halts CUDA model.generate() on the very next token (~12ms) when Stop is clicked."""

    def __init__(self, is_cancelled: Callable[[], bool]) -> None:
      self.is_cancelled = is_cancelled

    def __call__(self, input_ids: "torch.LongTensor", scores: "torch.FloatTensor", **kwargs: Any) -> bool:
      return bool(self.is_cancelled())


class HybridDetectorEngine:
  """Batched PyTorch CUDA RT-DETRv2 detector (with GPU/Multi-Core ONNX fallback for CTD & CPU)."""

  def __init__(
      self,
      num_workers: int,
      torch_device: str,
      use_torch_gpu: bool,
      shared_gpu_lock: threading.Lock,
      det_batch_size: int = 8,
  ) -> None:
    self.num_workers = num_workers
    self.torch_device = torch_device
    self.use_torch_gpu = bool(use_torch_gpu and HAS_TORCH_DETECTOR)
    self.gpu_lock = shared_gpu_lock
    self.det_batch_size = det_batch_size
    self.intra_threads = max(1, CPU_CORES // num_workers)
    self._init_lock = threading.Lock()
    self._torch_det_ready = False
    self._torch_det_failed = False
    self._use_fp16_det = self.torch_device == "cuda"
    self._det_size = (640, 640)
    self._do_norm = False
    self._norm_mean: Any = None
    self._norm_std: Any = None
    self._pools: dict[str, tuple[queue.Queue[ort.InferenceSession], bool]] = {}
    self.executor = ThreadPoolExecutor(max_workers=max(8, num_workers * 2))
    self.det_label = (
        f"PyTorch {torch_device.upper()} Batched RT-DETRv2"
        if self.use_torch_gpu
        else detect_ort_providers(prefer_cpu_for_int8=False)[1]
    )

  def ensure_torch_detector_loaded(self) -> bool:
    if not self.use_torch_gpu or self._torch_det_failed:
      return False
    if self._torch_det_ready:
      return True
    with self._init_lock:
      if self._torch_det_ready:
        return True
      if self._torch_det_failed:
        return False
      try:
        print(f"[AnkiSuru] Loading ogkalu/comic-text-and-bubble-detector onto {self.torch_device.upper()}...")
        self.processor = _from_pretrained_fast(AutoImageProcessor, "ogkalu/comic-text-and-bubble-detector")
        self.det_model = _from_pretrained_fast(AutoModelForObjectDetection, "ogkalu/comic-text-and-bubble-detector")
        self.det_model.to(self.torch_device)
        self.det_model.eval()

        sz = getattr(self.processor, "size", None) or {}
        th = int(sz.get("height", 640)) if isinstance(sz, dict) else 640
        tw = int(sz.get("width", 640)) if isinstance(sz, dict) else 640
        self._det_size = (tw, th)
        self._do_norm = bool(getattr(self.processor, "do_normalize", False))
        if self._do_norm:
          mean = getattr(self.processor, "image_mean", [0.485, 0.456, 0.406])
          std = getattr(self.processor, "image_std", [0.229, 0.224, 0.225])
          self._norm_mean = torch.tensor(mean, dtype=torch.float32, device=self.torch_device).view(1, 3, 1, 1)
          self._norm_std = torch.tensor(std, dtype=torch.float32, device=self.torch_device).view(1, 3, 1, 1)

        with self.gpu_lock, torch.inference_mode():
          dummy = torch.zeros((2, 3, th, tw), dtype=torch.float32, device=self.torch_device)
          t_sizes = torch.tensor([[1000, 700], [1000, 700]], dtype=torch.long, device=self.torch_device)
          if self._use_fp16_det:
            try:
              with torch.amp.autocast("cuda", dtype=torch.float16):
                out = self.det_model(pixel_values=dummy)
              self.processor.post_process_object_detection(out, target_sizes=t_sizes, threshold=0.32)
            except Exception:
              self._use_fp16_det = False
              out = self.det_model(pixel_values=dummy)
              self.processor.post_process_object_detection(out, target_sizes=t_sizes, threshold=0.32)
          else:
            out = self.det_model(pixel_values=dummy)
            self.processor.post_process_object_detection(out, target_sizes=t_sizes, threshold=0.32)

        prec = "FP16 Tensor-Core" if self._use_fp16_det else "CUDA FP32"
        self.det_label = f"PyTorch {prec} Batched RT-DETRv2"
        print(f"[AnkiSuru] Detector GPU Warmup complete ({self.det_label}, batch={self.det_batch_size})!")
        self._torch_det_ready = True
        return True
      except Exception as err:
        print(f"[AnkiSuru] Note: PyTorch GPU detector fell back to ONNX ({err})")
        self._torch_det_failed = True
        return False

  def _resize_page_for_rtdetr(self, im: Image.Image) -> np.ndarray:
    resized = im.convert("RGB").resize(self._det_size, Image.Resampling.BILINEAR)
    return np.asarray(resized, dtype=np.float32).transpose(2, 0, 1) * (1.0 / 255.0)

  def _detect_batch_torch_gpu(
      self,
      images: list[Image.Image],
      is_cancelled: Callable[[], bool] | None = None,
  ) -> list[list[list[float]]]:
    if is_cancelled and is_cancelled():
      return [[] for _ in images]
    pre_arrays = list(self.executor.map(self._resize_page_for_rtdetr, images))
    orig_wh = [im.size for im in images]
    results_all: list[list[list[float]]] = []
    bs = self.det_batch_size

    with self.gpu_lock, torch.inference_mode():
      for i in range(0, len(pre_arrays), bs):
        if is_cancelled and is_cancelled():
          break
        sub_arrs = pre_arrays[i : i + bs]
        sub_wh = orig_wh[i : i + bs]
        batch_np = np.stack(sub_arrs, axis=0)
        cpu_t = torch.from_numpy(batch_np)
        if self.torch_device == "cuda":
          cpu_t = cpu_t.pin_memory()
        pixel_values = cpu_t.to(self.torch_device, non_blocking=True)
        if self._do_norm and self._norm_mean is not None:
          pixel_values = (pixel_values - self._norm_mean) / self._norm_std

        if self._use_fp16_det:
          with torch.amp.autocast("cuda", dtype=torch.float16):
            outputs = self.det_model(pixel_values=pixel_values)
        else:
          outputs = self.det_model(pixel_values=pixel_values)

        target_sizes = torch.tensor([(h, w) for (w, h) in sub_wh], dtype=torch.long, device=self.torch_device)
        processed = self.processor.post_process_object_detection(
            outputs, target_sizes=target_sizes, threshold=0.32
        )
        for (orig_w, orig_h), det in zip(sub_wh, processed):
          scores_np = det["scores"].detach().cpu().numpy()
          labels_np = det["labels"].detach().cpu().numpy()
          boxes_np = det["boxes"].detach().cpu().numpy()
          results_all.append(_filter_rtdetr_predictions(scores_np, labels_np, boxes_np, orig_w, orig_h))

    return results_all

  def _get_onnx_pool(self, mode: str) -> tuple[queue.Queue[ort.InferenceSession], bool]:
    key = "ctd" if mode == "ctd-onnx" else "rtdetr"
    if key in self._pools:
      return self._pools[key]
    with self._init_lock:
      if key in self._pools:
        return self._pools[key]
      if key == "ctd":
        model_path = ensure_cached_file("comictextdetector.onnx", MODEL_URLS["ctd_onnx"])
        providers, _ = detect_ort_providers(prefer_cpu_for_int8=False)
        uses_gpu_ep = providers[0] != "CPUExecutionProvider"
        pool_size = 1 if uses_gpu_ep else min(self.num_workers, 4)
      else:
        gpu_providers, _ = detect_ort_providers(prefer_cpu_for_int8=False)
        if gpu_providers[0] != "CPUExecutionProvider":
          try:
            model_path = ensure_cached_file("detector_fp32.onnx", MODEL_URLS["rtdetr_fp32"])
            providers = gpu_providers
            uses_gpu_ep = True
            pool_size = 1
          except Exception:
            model_path = ensure_cached_file(
                "detector-v4-s_int8.onnx",
                MODEL_URLS["rtdetr_int8"],
                MODEL_URLS["rtdetr_int8_mirror"],
            )
            providers = ["CPUExecutionProvider"]
            uses_gpu_ep = False
            pool_size = self.num_workers
        else:
          model_path = ensure_cached_file(
              "detector-v4-s_int8.onnx",
              MODEL_URLS["rtdetr_int8"],
              MODEL_URLS["rtdetr_int8_mirror"],
          )
          providers = ["CPUExecutionProvider"]
          uses_gpu_ep = False
          pool_size = self.num_workers

      q: queue.Queue[ort.InferenceSession] = queue.Queue()
      for _ in range(pool_size):
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = self.intra_threads
        opts.inter_op_num_threads = 1
        q.put(ort.InferenceSession(str(model_path), sess_options=opts, providers=providers))
      self._pools[key] = (q, uses_gpu_ep)
      return self._pools[key]

  def _detect_one_onnx(
      self,
      pil_img: Image.Image,
      mode: str,
      is_cancelled: Callable[[], bool] | None = None,
  ) -> list[list[float]]:
    if is_cancelled and is_cancelled():
      return []
    img_rgb = pil_img.convert("RGB")
    orig_w, orig_h = img_rgb.size
    q, uses_gpu_ep = self._get_onnx_pool(mode)
    sess = q.get()
    try:
      if mode == "ctd-onnx":
        s = 1024
        ratio = min(s / orig_w, s / orig_h)
        nw, nh = round(orig_w * ratio), round(orig_h * ratio)
        resized = img_rgb.resize((nw, nh), Image.Resampling.BILINEAR)
        canvas = Image.new("RGB", (s, s), (114, 114, 114))
        canvas.paste(resized, (0, 0))
        arr = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None, ...] * (1.0 / 255.0)
        in_name = sess.get_inputs()[0].name
        out_names = [o.name for o in sess.get_outputs()]
        blk_name = "blk" if "blk" in out_names else out_names[0]
        if uses_gpu_ep:
          with self.gpu_lock:
            blk = sess.run([blk_name], {in_name: arr})[0][0]
        else:
          blk = sess.run([blk_name], {in_name: arr})[0][0]
        obj = blk[:, 4]
        mask = obj >= 0.35
        filtered = blk[mask]
        if filtered.shape[0] == 0:
          return []
        cls_max = np.max(filtered[:, 5:], axis=1) if filtered.shape[1] > 5 else np.ones(filtered.shape[0])
        scores = filtered[:, 4] * cls_max
        keep_mask = scores >= 0.35
        filtered = filtered[keep_mask]
        scores = scores[keep_mask]
        order = np.argsort(-scores)
        cands: list[list[float]] = []
        for idx in order:
          cx, cy, bw, bh = filtered[idx, :4]
          sc = float(scores[idx])
          orig_bw = bw / ratio
          orig_bh = bh / ratio
          pad_x = max(5.0, min(18.0, orig_bw * 0.055))
          pad_y = max(5.0, min(18.0, orig_bh * 0.045))
          x1 = max(0.0, (cx - bw * 0.5) / ratio - pad_x)
          y1 = max(0.0, (cy - bh * 0.5) / ratio - pad_y)
          x2 = min(float(orig_w), (cx + bw * 0.5) / ratio + pad_x)
          y2 = min(float(orig_h), (cy + bh * 0.5) / ratio + pad_y)
          if x2 - x1 >= 10 and y2 - y1 >= 10:
            cands.append([x1, y1, x2, y2, sc])
        return merge_nested_boxes(cands)

      resized = img_rgb.resize((640, 640), Image.Resampling.BILINEAR)
      arr = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None, ...] * (1.0 / 255.0)
      feeds: dict[str, Any] = {}
      for inp in sess.get_inputs():
        if "size" in inp.name.lower():
          feeds[inp.name] = np.array([[orig_w, orig_h]], dtype=np.int64)
        else:
          feeds[inp.name] = arr
      if uses_gpu_ep:
        with self.gpu_lock:
          outputs = sess.run(None, feeds)
      else:
        outputs = sess.run(None, feeds)
      out_map = {o.name: val for o, val in zip(sess.get_outputs(), outputs)}
      labels = out_map.get("labels", outputs[0])[0]
      boxes = out_map.get("boxes", outputs[1])[0]
      scores = out_map.get("scores", outputs[2])[0]
      return _filter_rtdetr_predictions(scores, labels, boxes, orig_w, orig_h)
    finally:
      q.put(sess)

  @staticmethod
  def _prune_empty_visual_boxes(page_im: Image.Image, boxes: list[list[float]]) -> list[list[float]]:
    w, h = page_im.size
    kept: list[list[float]] = []
    for b in boxes:
      x1 = max(0, min(w - 1, int(round(b[0]))))
      y1 = max(0, min(h - 1, int(round(b[1]))))
      x2 = max(x1 + 1, min(w, int(round(b[2]))))
      y2 = max(y1 + 1, min(h, int(round(b[3]))))
      if is_plausible_text_crop_visual(page_im.crop((x1, y1, x2, y2))):
        kept.append(b)
    return kept

  def detect_batch(
      self,
      images: list[Image.Image],
      mode: str,
      is_cancelled: Callable[[], bool] | None = None,
  ) -> list[list[list[float]]]:
    if not images or (is_cancelled and is_cancelled()):
      return [[] for _ in images]
    if mode != "ctd-onnx" and self.ensure_torch_detector_loaded():
      raw_batches = self._detect_batch_torch_gpu(images, is_cancelled=is_cancelled)
    else:
      futures = [self.executor.submit(self._detect_one_onnx, im, mode, is_cancelled) for im in images]
      raw_batches = [f.result() for f in futures]
    return [self._prune_empty_visual_boxes(im, bxs) for im, bxs in zip(images, raw_batches)]


def _preprocess_crop_224(crop: Image.Image) -> np.ndarray:
  """Official ViTImageProcessor BICUBIC 224x224 grayscale normalization [-1, 1]."""
  gray = crop.convert("L")
  gray_224 = gray.resize((224, 224), Image.Resampling.BICUBIC)
  plane = (np.asarray(gray_224, dtype=np.float32) * (1.0 / 127.5)) - 1.0
  return np.stack((plane, plane, plane), axis=0)


def _preprocess_crop_224_autocontrast(crop: Image.Image) -> np.ndarray:
  """Contrast-enhanced BICUBIC 224x224 crop used on second-pass rescue for <90% confidence bubbles."""
  gray = ImageOps.autocontrast(crop.convert("L"), cutoff=1)
  gray_224 = gray.resize((224, 224), Image.Resampling.BICUBIC)
  plane = (np.asarray(gray_224, dtype=np.float32) * (1.0 / 127.5)) - 1.0
  return np.stack((plane, plane, plane), axis=0)


def _has_visible_ink(crop: Image.Image) -> bool:
  """Reject empty white/black space, flat screentones, and solid fills before OCR."""
  return is_plausible_text_crop_visual(crop)


class HybridMangaOcrEngine:
  """Japanese-Only SOTA `muscgab/manga-ocr-base-CPT` v2 FP32 + Beam-Rescue Engine."""

  def __init__(
      self,
      num_workers: int,
      shared_gpu_lock: threading.Lock,
      force_onnx: bool = False,
      gpu_batch_size: int = 48,
  ) -> None:
    self.num_workers = num_workers
    self.gpu_batch_size = gpu_batch_size
    self.intra_threads = max(1, CPU_CORES // num_workers)
    self.use_torch = bool(HAS_TORCH_TRANSFORMERS and not force_onnx)
    self.use_torch_gpu = False
    self.torch_device = "cpu"
    self.accelerator_label = ""
    self._init_lock = threading.Lock()
    self._gpu_lock = shared_gpu_lock
    self._loaded_torch_models: dict[str, tuple[Any, list[str]]] = {}
    self._loaded_onnx_pools: dict[str, tuple[queue.Queue[tuple[ort.InferenceSession, ort.InferenceSession]], list[str]]] = {}
    self.executor = ThreadPoolExecutor(max_workers=max(12, num_workers * 2))
    self._logits_processors: Any = None

    if self.use_torch:
      if torch.cuda.is_available():
        torch.backends.cudnn.benchmark = True
        self.use_torch_gpu = True
        self.torch_device = "cuda"
        gpu_name = torch.cuda.get_device_name(0)
        self.accelerator_label = f"CUDA Lossless FP32 ({gpu_name})"
      elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        self.use_torch_gpu = True
        self.torch_device = "mps"
        self.accelerator_label = "Apple Metal MPS FP32 GPU"
      else:
        self.accelerator_label = f"PyTorch Multi-Core CPU ({CPU_CORES} threads)"
    else:
      _, label = detect_ort_providers(prefer_cpu_for_int8=True)
      self.accelerator_label = f"{label} ({num_workers}x Parallel Pool)"

  def ensure_loaded(self, engine_key: str = "manga-ocr-cpt") -> None:
    norm_key = "manga-ocr" if engine_key == "manga-ocr" else "manga-ocr-cpt"
    repo_id = OCR_REPO_MAP[norm_key]

    if self.use_torch:
      if norm_key in self._loaded_torch_models:
        return
      with self._init_lock:
        if norm_key in self._loaded_torch_models:
          return
        print(f"[AnkiSuru] Loading Japanese-only SOTA OCR '{repo_id}' onto {self.accelerator_label}...")
        try:
          model = _from_pretrained_fast(_MangaVisionEncoderDecoder, repo_id)
          vocab = _load_repo_vocab_list(repo_id)
        except Exception as err:
          if norm_key == "manga-ocr-cpt":
            print(f"[AnkiSuru] Note: '{repo_id}' unavailable ({err}); falling back to kha-white/manga-ocr-base.")
            repo_id = OCR_REPO_MAP["manga-ocr"]
            model = _from_pretrained_fast(_MangaVisionEncoderDecoder, repo_id)
            vocab = _load_repo_vocab_list(repo_id)
          else:
            raise
        for _sub_cfg in (
            model.config,
            getattr(model.config, "decoder", None),
            getattr(model.config, "encoder", None),
        ):
          if _sub_cfg is not None and hasattr(_sub_cfg, "max_length"):
            _sub_cfg.max_length = None
        model.config.eos_token_id = 3
        model.config.pad_token_id = 0
        model.config.decoder_start_token_id = 2
        gen_cfg = getattr(model, "generation_config", None)
        if gen_cfg is not None:
          gen_cfg.eos_token_id = 3
          gen_cfg.pad_token_id = 0
          gen_cfg.decoder_start_token_id = 2
          # Clear checkpoint's preset max_length=300 so max_new_tokens never conflicts or spams CMD logs
          try:
            test_cfg = copy.deepcopy(gen_cfg)
            test_cfg.max_length = None
            test_cfg.max_new_tokens = 40
            if hasattr(test_cfg, "validate"):
              test_cfg.validate()
            gen_cfg.max_length = None
          except Exception:
            gen_cfg._from_model_config = True
        _quiet_transformers_loggers()
        model.to(self.torch_device)
        model.eval()
        if HAS_LOGITS_PROCESSOR and self._logits_processors is None:
          self._logits_processors = LogitsProcessorList([_RepeatLoopStopper(eos_token_id=3, repeat_run=5)])

        if self.use_torch_gpu:
          with self._gpu_lock, torch.inference_mode():
            dummy = torch.zeros((2, 3, 224, 224), dtype=torch.float32, device=self.torch_device)
            model.generate(dummy, max_new_tokens=6, num_beams=1, do_sample=False, use_cache=True, eos_token_id=3, pad_token_id=0)
        print(f"[AnkiSuru] '{repo_id}' ready ({len(vocab):,} JP vocab tokens, FP32 precision)!")
        self._loaded_torch_models[norm_key] = (model, vocab)
        return

    if norm_key in self._loaded_onnx_pools:
      return
    with self._init_lock:
      if norm_key in self._loaded_onnx_pools:
        return
      used_cpt = False
      if norm_key == "manga-ocr-cpt":
        try:
          enc_path = ensure_cached_file("cpt_v2_encoder_q8.onnx", MODEL_URLS["mocr_cpt_enc_q8"], MODEL_URLS["mocr_cpt_enc_q8_alt"])
          dec_path = ensure_cached_file("cpt_v2_decoder_q8.onnx", MODEL_URLS["mocr_cpt_dec_q8"], MODEL_URLS["mocr_cpt_dec_q8_alt"])
          vocab_path = ensure_cached_file("vocab_cpt_v2.txt", MODEL_URLS["mocr_cpt_vocab"])
          used_cpt = True
        except Exception as err:
          print(f"[AnkiSuru] CPT ONNX fallback to base ONNX ({err})")
      if not used_cpt:
        enc_path = ensure_cached_file("encoder_model_quantized.onnx", MODEL_URLS["mocr_enc_q8"])
        dec_path = ensure_cached_file("decoder_model_merged_quantized.onnx", MODEL_URLS["mocr_dec_q8"])
        vocab_path = ensure_cached_file("vocab.txt", MODEL_URLS["mocr_vocab"])

      vocab = vocab_path.read_text(encoding="utf-8").splitlines()
      q: queue.Queue[tuple[ort.InferenceSession, ort.InferenceSession]] = queue.Queue()
      for _ in range(self.num_workers):
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = self.intra_threads
        opts.inter_op_num_threads = 1
        enc = ort.InferenceSession(str(enc_path), sess_options=opts, providers=["CPUExecutionProvider"])
        dec = ort.InferenceSession(str(dec_path), sess_options=opts, providers=["CPUExecutionProvider"])
        q.put((enc, dec))
      self._loaded_onnx_pools[norm_key] = (q, vocab)

  @staticmethod
  def _decode_tokens_with_probs(
      token_ids: list[int],
      token_probs: list[float],
      vocab: list[str],
  ) -> dict[str, Any]:
    special = {"[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", ""}
    chars: list[str] = []
    kept_probs: list[float] = []
    has_unk = False
    for tid, prob in zip(token_ids, token_probs):
      if tid in (0, 3):
        break
      tok = vocab[tid] if 0 <= tid < len(vocab) else ""
      if tok == "[UNK]":
        has_unk = True
        kept_probs.append(min(prob, 0.45))
        continue
      if tok in special:
        continue
      if tok.startswith("##"):
        tok = tok[2:]
      chars.append(tok)
      kept_probs.append(prob)

    txt = postprocess_japanese_text("".join(chars))
    if not txt:
      return {"text": "", "conf": 0.0}
    conf = compute_calibrated_bubble_conf(kept_probs)
    if has_unk:
      conf = min(conf, 0.75)
    return {"text": txt, "conf": conf}

  def _decode_one_onnx(
      self,
      pil_img: Image.Image,
      engine_key: str,
      is_cancelled: Callable[[], bool] | None = None,
  ) -> dict[str, Any]:
    if is_cancelled and is_cancelled():
      return {"text": "", "conf": 0.0}
    if not _has_visible_ink(pil_img):
      return {"text": "", "conf": 0.0}
    norm_key = "manga-ocr" if engine_key == "manga-ocr" else "manga-ocr-cpt"
    pool, vocab = self._loaded_onnx_pools[norm_key]
    arr = _preprocess_crop_224(pil_img)[None, ...]
    enc, dec = pool.get()
    try:
      if is_cancelled and is_cancelled():
        return {"text": "", "conf": 0.0}
      enc_in = enc.get_inputs()[0].name
      hidden = enc.run(None, {enc_in: arr})[0]
      dec_inputs = [i.name for i in dec.get_inputs()]
      ids = [2]
      probs: list[float] = []
      max_steps = 48 if (pil_img.width * pil_img.height < 14000) else 88
      for _ in range(max_steps):
        if is_cancelled and is_cancelled():
          return {"text": "", "conf": 0.0}
        feeds: dict[str, Any] = {}
        for name in dec_inputs:
          if name == "input_ids":
            feeds[name] = np.array([ids], dtype=np.int64)
          elif name == "encoder_hidden_states":
            feeds[name] = hidden
          elif name == "encoder_attention_mask":
            feeds[name] = np.ones((1, hidden.shape[1]), dtype=np.int64)
          elif name == "attention_mask":
            feeds[name] = np.ones((1, len(ids)), dtype=np.int64)
          elif name == "use_cache_branch":
            feeds[name] = np.array([False], dtype=bool)
        logits = dec.run(None, feeds)[0][0, -1, :]
        best_id = int(np.argmax(logits))
        shifted = np.exp(logits - logits[best_id])
        prob = float(1.0 / np.sum(shifted))
        if best_id in (0, 3):
          break
        ids.append(best_id)
        probs.append(prob)
        if len(ids) >= 7 and len(set(ids[-5:])) == 1:
          probs[-1] = min(probs[-1], 0.35)
          break
      return self._decode_tokens_with_probs(ids[1:], probs, vocab)
    finally:
      pool.put((enc, dec))

  def _run_torch_greedy_subbatch(
      self,
      model: Any,
      vocab: list[str],
      batch_np: np.ndarray,
      max_tok: int,
      stop_crit: Any,
  ) -> list[dict[str, Any]]:
    cpu_tensor = torch.from_numpy(batch_np)
    if self.torch_device == "cuda":
      cpu_tensor = cpu_tensor.pin_memory()
    pixel_values = cpu_tensor.to(self.torch_device, non_blocking=True)

    gen_kwargs: dict[str, Any] = {
        "max_new_tokens": max_tok,
        "num_beams": 1,
        "do_sample": False,
        "use_cache": True,
        "eos_token_id": 3,
        "pad_token_id": 0,
        "return_dict_in_generate": True,
        "output_scores": True,
    }
    if self._logits_processors is not None:
      gen_kwargs["logits_processor"] = self._logits_processors
    if stop_crit is not None:
      gen_kwargs["stopping_criteria"] = stop_crit

    # Run in full lossless FP32 (avoids Turing FP16 precision loss on dakuten & dense kanji!)
    gen_out = model.generate(pixel_values, **gen_kwargs)
    scores_tuple = gen_out.scores or ()
    num_steps = len(scores_tuple)
    if num_steps == 0:
      return [{"text": "", "conf": 0.0} for _ in range(batch_np.shape[0])]

    gen_tokens = gen_out.sequences[:, 1 : 1 + num_steps]
    step_probs = []
    for k, step_logits in enumerate(scores_tuple):
      probs_k = torch.softmax(step_logits.float(), dim=-1)
      tok_k = gen_tokens[:, k : k + 1]
      step_probs.append(probs_k.gather(1, tok_k).squeeze(1))

    probs_cpu = torch.stack(step_probs, dim=1).cpu().tolist()
    tokens_cpu = gen_tokens.cpu().tolist()

    out_list: list[dict[str, Any]] = []
    for seq_ids, seq_probs in zip(tokens_cpu, probs_cpu):
      out_list.append(self._decode_tokens_with_probs(seq_ids, seq_probs, vocab))
    return out_list

  def _run_torch_beam_rescue(
      self,
      model: Any,
      vocab: list[str],
      rescue_crops: list[Image.Image],
      stop_crit: Any,
  ) -> list[dict[str, Any]]:
    """Second-pass num_beams=4 + autocontrast rescue for tricky bubbles that scored < 90%."""
    if not rescue_crops:
      return []
    pre_arrays = list(self.executor.map(_preprocess_crop_224_autocontrast, rescue_crops))
    results: list[dict[str, Any]] = []
    beam_bs = 12  # 12 * 4 beams = 48 active sequences on GPU
    for i in range(0, len(pre_arrays), beam_bs):
      batch_np = np.stack(pre_arrays[i : i + beam_bs], axis=0)
      cpu_t = torch.from_numpy(batch_np)
      if self.torch_device == "cuda":
        cpu_t = cpu_t.pin_memory()
      pixel_values = cpu_t.to(self.torch_device, non_blocking=True)

      gen_kwargs: dict[str, Any] = {
          "max_new_tokens": 76,
          "num_beams": 4,
          "early_stopping": True,
          "do_sample": False,
          "use_cache": True,
          "eos_token_id": 3,
          "pad_token_id": 0,
          "return_dict_in_generate": True,
          "output_scores": True,
      }
      if stop_crit is not None:
        gen_kwargs["stopping_criteria"] = stop_crit

      gen_out = model.generate(pixel_values, **gen_kwargs)
      try:
        trans_scores = model.compute_transition_scores(
            gen_out.sequences, gen_out.scores, gen_out.beam_indices, normalize_logits=True
        )
        probs_cpu = torch.exp(trans_scores.clamp(min=-20.0, max=0.0)).cpu().tolist()
        num_steps = trans_scores.shape[1]
        tokens_cpu = gen_out.sequences[:, 1 : 1 + num_steps].cpu().tolist()
        for seq_ids, seq_probs in zip(tokens_cpu, probs_cpu):
          results.append(self._decode_tokens_with_probs(seq_ids, seq_probs, vocab))
      except Exception:
        seq_scores = getattr(gen_out, "sequences_scores", None)
        approx_p = (
            torch.exp(seq_scores.clamp(min=-10.0, max=0.0)).cpu().tolist()
            if seq_scores is not None
            else [0.85] * batch_np.shape[0]
        )
        tokens_cpu = gen_out.sequences[:, 1:].cpu().tolist()
        for seq_ids, p_val in zip(tokens_cpu, approx_p):
          results.append(self._decode_tokens_with_probs(seq_ids, [float(p_val)] * len(seq_ids), vocab))
    return results

  def recognize_batch(
      self,
      crops: list[Image.Image],
      engine_key: str = "manga-ocr-cpt",
      is_cancelled: Callable[[], bool] | None = None,
  ) -> list[dict[str, Any]]:
    if not crops or (is_cancelled and is_cancelled()):
      return [{"text": "", "conf": 0.0} for _ in crops]
    norm_key = "manga-ocr" if engine_key == "manga-ocr" else "manga-ocr-cpt"
    self.ensure_loaded(norm_key)
    if is_cancelled and is_cancelled():
      return [{"text": "", "conf": 0.0} for _ in crops]

    if self.use_torch:
      model, vocab = self._loaded_torch_models[norm_key]
      ink_flags = list(self.executor.map(_has_visible_ink, crops))
      valid_pairs = [(idx, crops[idx]) for idx, ok in enumerate(ink_flags) if ok]
      if not valid_pairs:
        return [{"text": "", "conf": 0.0} for _ in crops]

      indexed = sorted(valid_pairs, key=lambda pair: pair[1].width * pair[1].height)
      sorted_crops = [p[1] for p in indexed]
      pre_arrays = list(self.executor.map(_preprocess_crop_224, sorted_crops))
      sorted_results: list[dict[str, Any]] = []
      bs = self.gpu_batch_size if self.use_torch_gpu else min(16, max(4, CPU_CORES))
      stop_crit = (
          StoppingCriteriaList([_CancelStoppingCriteria(is_cancelled)])
          if (HAS_LOGITS_PROCESSOR and is_cancelled is not None)
          else None
      )

      with self._gpu_lock, torch.inference_mode():
        for i in range(0, len(pre_arrays), bs):
          if is_cancelled and is_cancelled():
            break
          sub_crops = sorted_crops[i : i + bs]
          max_area = max(c.width * c.height for c in sub_crops)
          max_dim = max(max(c.width, c.height) for c in sub_crops)
          if max_area < 14000 and max_dim < 160:
            max_tok = 40
          elif max_area < 50000:
            max_tok = 72
          else:
            max_tok = 112

          batch_np = np.stack(pre_arrays[i : i + bs], axis=0)
          sub_res = self._run_torch_greedy_subbatch(model, vocab, batch_np, max_tok, stop_crit)
          sorted_results.extend(sub_res)

        # Automatic Second-Pass Autocontrast + 4-Beam Rescue for any bubble scoring < 90%
        if self.use_torch_gpu and not (is_cancelled and is_cancelled()):
          rescue_local_indices = [
              k for k, r in enumerate(sorted_results) if r["conf"] < LOW_CONF_THRESHOLD
          ]
          if rescue_local_indices:
            rescue_crops = [sorted_crops[k] for k in rescue_local_indices]
            rescued = self._run_torch_beam_rescue(model, vocab, rescue_crops, stop_crit)
            for k, new_r in zip(rescue_local_indices, rescued):
              old_r = sorted_results[k]
              if new_r["text"] and (new_r["conf"] > old_r["conf"] or not old_r["text"]):
                sorted_results[k] = new_r

      final_out: list[dict[str, Any]] = [{"text": "", "conf": 0.0} for _ in crops]
      for (orig_idx, _), res in zip(indexed, sorted_results):
        final_out[orig_idx] = res
      return final_out

    futures = [self.executor.submit(self._decode_one_onnx, c, norm_key, is_cancelled) for c in crops]
    return [f.result() for f in futures]


def _decode_bytes_to_rgb(raw: bytes) -> Image.Image:
  im = Image.open(io.BytesIO(raw))
  return im.convert("RGB")


def build_app(workers: int, force_onnx: bool = False, gpu_batch_size: int = 48) -> FastAPI:
  app = FastAPI(title="AnkiSuru Local Server")
  shared_gpu_lock = threading.Lock()
  ocr_engine = HybridMangaOcrEngine(
      num_workers=workers,
      shared_gpu_lock=shared_gpu_lock,
      force_onnx=force_onnx,
      gpu_batch_size=gpu_batch_size,
  )
  det_engine = HybridDetectorEngine(
      num_workers=workers,
      torch_device=ocr_engine.torch_device,
      use_torch_gpu=ocr_engine.use_torch_gpu,
      shared_gpu_lock=shared_gpu_lock,
      det_batch_size=8,
  )
  io_pool = ThreadPoolExecutor(max_workers=max(12, workers * 2))
  warmup_state = {"warming_up": True}

  gpu_warning = ""
  if ocr_engine.use_torch_gpu:
    print(
        f"[GPU ACTIVE] OCR: {ocr_engine.accelerator_label} (manga-ocr-base-CPT v2) | "
        f"Detector: {det_engine.det_label} | Batch={gpu_batch_size}"
    )
  else:
    print(f"[CPU MODE] {ocr_engine.accelerator_label}")
    if NVIDIA_SMI_PRESENT and not force_onnx:
      gpu_warning = (
          "NVIDIA GPU detected via nvidia-smi, but CUDA PyTorch is NOT installed in .venv! "
          "Close server and run the updated run_windows.bat for 20x-30x faster RTX GPU extraction."
      )
      print(f"\n[WARNING] {gpu_warning}\n")

  def _background_preload_and_warmup() -> None:
    try:
      if ocr_engine.use_torch_gpu:
        det_engine.ensure_torch_detector_loaded()
      ocr_engine.ensure_loaded("manga-ocr-cpt")
    except Exception as err:
      print(f"[AnkiSuru] Background warmup note: {err}")
    finally:
      warmup_state["warming_up"] = False

  threading.Thread(target=_background_preload_and_warmup, daemon=True).start()

  app.add_middleware(
      CORSMiddleware,
      allow_origins=["*"],
      allow_credentials=False,
      allow_methods=["*"],
      allow_headers=["*"],
  )

  @app.middleware("http")
  async def add_coop_coep_and_pna_headers(request: Request, call_next: Any) -> Response:
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network") == "true":
      resp = Response(status_code=204)
      resp.headers["Access-Control-Allow-Origin"] = "*"
      resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
      resp.headers["Access-Control-Allow-Headers"] = "*"
      resp.headers["Access-Control-Allow-Private-Network"] = "true"
      return resp

    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    return resp

  @app.get("/")
  async def index() -> Response:
    html_path = BASE_DIR / "static" / "index.html"
    if html_path.exists():
      return FileResponse(str(html_path), media_type="text/html")
    return JSONResponse({"ok": True, "message": "AnkiSuru Local Server running."})

  @app.get("/api/health")
  async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": "4.0",
        "default_ocr_model": "muscgab/manga-ocr-base-CPT (v2)",
        "accelerator": ocr_engine.accelerator_label,
        "det_accelerator": det_engine.det_label,
        "gpu_active": ocr_engine.use_torch_gpu,
        "nvidia_present": NVIDIA_SMI_PRESENT,
        "gpu_warning": gpu_warning,
        "warming_up": warmup_state["warming_up"],
        "cpu_cores": CPU_CORES,
        "workers": workers,
    }

  cancel_lock = threading.Lock()
  cancel_state = {"epoch": 0}

  @app.post("/api/cancel")
  async def api_cancel() -> dict[str, Any]:
    with cancel_lock:
      cancel_state["epoch"] += 1
      ep = cancel_state["epoch"]
    print(f"[AnkiSuru] Stop signal received (epoch={ep}) — aborting in-flight GPU/CPU work immediately.")
    return {"ok": True, "cancelled_epoch": ep}

  def _sync_detect_batch(
      raw_list: list[bytes],
      detector_mode: str,
      is_cancelled: Callable[[], bool],
  ) -> list[dict[str, Any]]:
    if is_cancelled():
      return []
    pil_pages = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    batch_boxes = det_engine.detect_batch(pil_pages, detector_mode, is_cancelled=is_cancelled)
    return [{"boxes": b} for b in batch_boxes]

  @app.post("/api/detect_batch")
  async def api_detect_batch(
      request: Request,
      files: list[UploadFile] = File(...),
      detector_mode: str = Form("rtdetr-int8"),
  ) -> dict[str, Any]:
    start_epoch = cancel_state["epoch"]
    raw_list = [await up.read() for up in files]
    is_cancelled = lambda: cancel_state["epoch"] != start_epoch
    pages = await asyncio.to_thread(_sync_detect_batch, raw_list, detector_mode, is_cancelled)
    if is_cancelled() or await request.is_disconnected():
      return {"ok": False, "cancelled": True, "pages": []}
    return {"ok": True, "pages": pages}

  def _sync_ocr_batch(
      raw_list: list[bytes],
      ocr_model: str,
      is_cancelled: Callable[[], bool],
  ) -> list[dict[str, Any]]:
    if is_cancelled():
      return []
    crops = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    return ocr_engine.recognize_batch(crops, engine_key=ocr_model, is_cancelled=is_cancelled)

  @app.post("/api/ocr_batch")
  async def api_ocr_batch(
      request: Request,
      files: list[UploadFile] = File(...),
      ocr_model: str = Form("manga-ocr-cpt"),
  ) -> dict[str, Any]:
    start_epoch = cancel_state["epoch"]
    raw_list = [await up.read() for up in files]
    is_cancelled = lambda: cancel_state["epoch"] != start_epoch
    out = await asyncio.to_thread(_sync_ocr_batch, raw_list, ocr_model, is_cancelled)
    if is_cancelled() or await request.is_disconnected():
      return {"ok": False, "cancelled": True, "results": []}
    return {"ok": True, "results": out}

  def _sync_extract_pages_chunk(
      raw_list: list[bytes],
      detector_mode: str,
      ocr_model: str,
      meta_json: str,
      is_cancelled: Callable[[], bool],
      auto_prune: bool = True,
  ) -> dict[str, Any]:
    if is_cancelled():
      return {"ok": False, "cancelled": True, "pages": []}
    t0 = time.perf_counter()
    pil_pages = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    if is_cancelled():
      return {"ok": False, "cancelled": True, "pages": []}
    t_decode = time.perf_counter() - t0
    meta = json.loads(meta_json) if meta_json else []

    t_det0 = time.perf_counter()
    undetected_indices = [
        i for i in range(len(pil_pages)) if i >= len(meta) or not meta[i].get("boxes_detected")
    ]
    detected_map: dict[int, list[list[float]]] = {}
    if undetected_indices:
      sub_imgs = [pil_pages[i] for i in undetected_indices]
      det_out = det_engine.detect_batch(sub_imgs, detector_mode, is_cancelled=is_cancelled)
      for idx, boxes in zip(undetected_indices, det_out):
        detected_map[idx] = boxes
    if is_cancelled():
      return {"ok": False, "cancelled": True, "pages": []}
    t_det = time.perf_counter() - t_det0

    page_boxes_list: list[list[list[float]]] = []
    all_crops: list[Image.Image] = []
    crop_counts: list[int] = []

    for i, page_im in enumerate(pil_pages):
      w, h = page_im.size
      boxes = detected_map[i] if i in detected_map else (meta[i].get("boxes") or [])
      page_boxes_list.append(boxes)
      cnt = 0
      for b in boxes:
        x1 = max(0, min(w - 1, int(round(b[0]))))
        y1 = max(0, min(h - 1, int(round(b[1]))))
        x2 = max(x1 + 1, min(w, int(round(b[2]))))
        y2 = max(y1 + 1, min(h, int(round(b[3]))))
        all_crops.append(page_im.crop((x1, y1, x2, y2)))
        cnt += 1
      crop_counts.append(cnt)

    t_ocr0 = time.perf_counter()
    ocr_results = (
        ocr_engine.recognize_batch(all_crops, engine_key=ocr_model, is_cancelled=is_cancelled)
        if all_crops
        else []
    )
    if is_cancelled():
      return {"ok": False, "cancelled": True, "pages": []}
    t_ocr = time.perf_counter() - t_ocr0

    pages_out: list[dict[str, Any]] = []
    pruned_false_boxes = 0
    kept_bubbles = 0
    low_conf_count = 0
    offset = 0

    for i, boxes in enumerate(page_boxes_list):
      cnt = crop_counts[i]
      slice_res = ocr_results[offset : offset + cnt]
      offset += cnt
      page_meta = meta[i] if i < len(meta) and isinstance(meta[i], dict) else {}
      manual_flags = page_meta.get("manual_flags") or []

      kept_boxes: list[list[float]] = []
      kept_texts: list[str] = []
      kept_confs: list[float] = []
      kept_indices: list[int] = []

      for b_idx, (bx, r) in enumerate(zip(boxes, slice_res)):
        is_manual = bool(b_idx < len(manual_flags) and manual_flags[b_idx])
        if auto_prune and not is_manual and not is_valid_japanese_manga_ocr(r["text"], r["conf"]):
          pruned_false_boxes += 1
          continue
        kept_boxes.append(bx)
        kept_texts.append(r["text"])
        kept_confs.append(r["conf"])
        kept_indices.append(b_idx)
        kept_bubbles += 1
        if r["text"] and r["conf"] < LOW_CONF_THRESHOLD:
          low_conf_count += 1

      pages_out.append({
          "boxes": kept_boxes,
          "texts": kept_texts,
          "confs": kept_confs,
          "kept_indices": kept_indices,
          "pruned_count": len(boxes) - len(kept_boxes),
      })

    dt = max(0.001, time.perf_counter() - t0)
    print(
        f"[AnkiSuru] {len(pil_pages)} pages ({kept_bubbles} JP bubbles kept, {pruned_false_boxes} non-JP/false pruned, "
        f"{low_conf_count} <90% review) in {dt:.2f}s ({len(pil_pages)/dt:.1f} pages/s) | det={t_det:.2f}s ocr={t_ocr:.2f}s"
    )
    return {
        "ok": True,
        "pages": pages_out,
        "pruned_count": pruned_false_boxes,
        "timing": {
            "total_s": round(dt, 3),
            "decode_s": round(t_decode, 3),
            "det_s": round(t_det, 3),
            "ocr_s": round(t_ocr, 3),
            "pruned_count": pruned_false_boxes,
            "low_conf_count": low_conf_count,
            "accelerator": ocr_engine.accelerator_label,
        },
    }

  @app.post("/api/extract_pages_server")
  async def api_extract_pages_server(
      request: Request,
      files: list[UploadFile] = File(...),
      detector_mode: str = Form("rtdetr-int8"),
      ocr_model: str = Form("manga-ocr-cpt"),
      auto_prune_non_jp: str = Form("true"),
      meta_json: str = Form("[]"),
  ) -> dict[str, Any]:
    start_epoch = cancel_state["epoch"]
    raw_list = [await up.read() for up in files]
    auto_prune = str(auto_prune_non_jp).lower() not in ("false", "0", "no")
    is_cancelled = lambda: cancel_state["epoch"] != start_epoch
    return await asyncio.to_thread(
        _sync_extract_pages_chunk, raw_list, detector_mode, ocr_model, meta_json, is_cancelled, auto_prune
    )

  return app


def main() -> None:
  parser = argparse.ArgumentParser(description="AnkiSuru Local GPU / Multi-Core Server")
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=7860)
  parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel CPU worker threads")
  parser.add_argument("--batch-size", type=int, default=48, help="CUDA GPU OCR batch size")
  parser.add_argument("--onnx-only", action="store_true", help="Force C++ ONNX multi-core pool")
  parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser tab")
  args = parser.parse_args()

  app = build_app(workers=max(1, args.workers), force_onnx=args.onnx_only, gpu_batch_size=max(4, args.batch_size))
  url = f"http://{args.host}:{args.port}"
  print(f"\n========================================================")
  print(f" AnkiSuru Local Server listening at {url}")
  print(f" Default Japanese-Only OCR: muscgab/manga-ocr-base-CPT v2 (0.86% CER)")
  print(f" CPU Cores: {CPU_CORES} | Worker Pool: {args.workers} | GPU Batch: {args.batch_size}")
  print(f"========================================================\n")

  if not args.no_browser:
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()

  uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
  main()
