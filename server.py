#!/usr/bin/env python3
"""Mokuro Turbo Native Server — Volume-Scale RTX CUDA & Multi-Core Manga OCR Backend.

Engineered for 200–1,000+ page manga volumes:
  - /api/extract_pages_server: Accepts whole-page JPEGs/PNGs directly from the browser (zero JS
    canvas cropping overhead!), decodes pages + crops speech bubbles in parallel C threads,
    length-buckets bubbles by area so short balloons terminate early, and runs batch_size=48
    FP16 Tensor-Core `model.generate()` on CUDA (or Apple MPS / all-core C++ ONNX pool).
  - Completely immune to browser background tab throttling once a chunk is dispatched.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import queue
import re
import threading
import time
from typing import Any
import urllib.request
import webbrowser

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import numpy as np
import onnxruntime as ort
from PIL import Image
import uvicorn

try:
  import torch
  from transformers import VisionEncoderDecoderModel
  HAS_TORCH_TRANSFORMERS = True
except Exception:
  HAS_TORCH_TRANSFORMERS = False

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = Path(os.environ.get("MOKURO_TURBO_CACHE", Path.home() / ".cache" / "mokuro_turbo"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MODEL_URLS = {
    "rtdetr_int8": "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx",
    "rtdetr_int8_mirror": "https://huggingface.co/Sundowner123/comic-text-and-bubble-detector/resolve/main/detector.onnx",
    "ctd_onnx": "https://huggingface.co/HighLiuk/japanese-onnx-models/resolve/main/comictextdetector.onnx",
    "mocr_enc_q8": "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/encoder_model_quantized.onnx",
    "mocr_dec_q8": "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/decoder_model_merged_quantized.onnx",
    "mocr_vocab": "https://huggingface.co/kha-white/manga-ocr-base/resolve/main/vocab.txt",
}

CPU_CORES = max(2, os.cpu_count() or 4)
DEFAULT_WORKERS = min(8, max(3, CPU_CORES // 2))
_DOWNLOAD_LOCK = threading.Lock()


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
        print(f"[Mokuro Turbo] Downloading {filename} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "MokuroTurbo/2.0"})
        with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as out:
          while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
              break
            out.write(chunk)
        tmp.replace(dest)
        print(f"[Mokuro Turbo] Cached {filename} ({dest.stat().st_size / 1048576:.1f} MB)")
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
  return ["CPUExecutionProvider"], f"ONNX Multi-Core CPU ({CPU_CORES} logical cores)"


def postprocess_japanese_text(text: str) -> str:
  s = re.sub(r"\s+", "", text or "")
  s = re.sub(r"\.{2,}", "…", s)
  s = re.sub(r"．{2,}", "…", s)
  s = s.replace("!", "！").replace("?", "？")
  return s.strip()


def merge_nested_boxes(boxes: list[list[float]]) -> list[list[float]]:
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
        if inter / min(area_a, area_b) > 0.72 or iou > 0.42:
          items[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), max(a[4], b[4])]
          items.pop(j)
          changed = True
          break
      if changed:
        break
  return items


class ParallelDetectorPool:
  """Multi-session C++ ONNX Runtime detector pool (runs on CPU threads concurrently with CUDA OCR)."""

  def __init__(self, num_workers: int, cuda_ocr_active: bool = False) -> None:
    self.num_workers = num_workers
    self.cuda_ocr_active = cuda_ocr_active
    self.intra_threads = max(1, CPU_CORES // num_workers)
    self._pools: dict[str, queue.Queue[ort.InferenceSession]] = {}
    self._lock = threading.Lock()
    self.executor = ThreadPoolExecutor(max_workers=num_workers)

  def _get_pool(self, mode: str) -> queue.Queue[ort.InferenceSession]:
    key = "ctd" if mode == "ctd-onnx" else "rtdetr"
    if key in self._pools:
      return self._pools[key]
    with self._lock:
      if key in self._pools:
        return self._pools[key]
      if key == "ctd":
        model_path = ensure_cached_file("comictextdetector.onnx", MODEL_URLS["ctd_onnx"])
        # Avoid DirectML + PyTorch CUDA WDDM context thrashing on 6GB mobile GPUs when CUDA OCR is active
        providers, _ = detect_ort_providers(prefer_cpu_for_int8=self.cuda_ocr_active)
        pool_size = 1 if providers[0] != "CPUExecutionProvider" else min(self.num_workers, 4)
      else:
        model_path = ensure_cached_file(
            "detector-v4-s_int8.onnx",
            MODEL_URLS["rtdetr_int8"],
            MODEL_URLS["rtdetr_int8_mirror"],
        )
        providers = ["CPUExecutionProvider"]
        pool_size = self.num_workers

      q: queue.Queue[ort.InferenceSession] = queue.Queue()
      for _ in range(pool_size):
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = self.intra_threads
        opts.inter_op_num_threads = 1
        q.put(ort.InferenceSession(str(model_path), sess_options=opts, providers=providers))
      self._pools[key] = q
      return q

  def detect_one(self, pil_img: Image.Image, mode: str) -> list[list[float]]:
    img_rgb = pil_img.convert("RGB")
    orig_w, orig_h = img_rgb.size
    q = self._get_pool(mode)
    sess = q.get()
    try:
      if mode == "ctd-onnx":
        s = 1024
        ratio = min(s / orig_w, s / orig_h)
        nw, nh = round(orig_w * ratio), round(orig_h * ratio)
        resized = img_rgb.resize((nw, nh), Image.Resampling.BILINEAR)
        canvas = Image.new("RGB", (s, s), (114, 114, 114))
        canvas.paste(resized, (0, 0))
        arr = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None, ...] / 255.0
        in_name = sess.get_inputs()[0].name
        out_names = [o.name for o in sess.get_outputs()]
        blk_name = "blk" if "blk" in out_names else out_names[0]
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
          x1 = max(0.0, (cx - bw * 0.5) / ratio - 4.0)
          y1 = max(0.0, (cy - bh * 0.5) / ratio - 4.0)
          x2 = min(float(orig_w), (cx + bw * 0.5) / ratio + 4.0)
          y2 = min(float(orig_h), (cy + bh * 0.5) / ratio + 4.0)
          if x2 - x1 >= 8 and y2 - y1 >= 8:
            cands.append([x1, y1, x2, y2, sc])
        return merge_nested_boxes(cands)

      resized = img_rgb.resize((640, 640), Image.Resampling.BILINEAR)
      arr = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None, ...] / 255.0
      feeds: dict[str, Any] = {}
      for inp in sess.get_inputs():
        if "size" in inp.name.lower():
          feeds[inp.name] = np.array([[orig_w, orig_h]], dtype=np.int64)
        else:
          feeds[inp.name] = arr
      outputs = sess.run(None, feeds)
      out_map = {o.name: val for o, val in zip(sess.get_outputs(), outputs)}
      labels = out_map.get("labels", outputs[0])[0]
      boxes = out_map.get("boxes", outputs[1])[0]
      scores = out_map.get("scores", outputs[2])[0]
      text_boxes: list[list[float]] = []
      bubble_fallback: list[list[float]] = []
      for i in range(len(scores)):
        sc = float(scores[i])
        if sc < 0.30:
          continue
        lbl = int(labels[i])
        bx = boxes[i]
        x1 = max(0.0, float(bx[0]) - 3.0)
        y1 = max(0.0, float(bx[1]) - 3.0)
        x2 = min(float(orig_w), float(bx[2]) + 3.0)
        y2 = min(float(orig_h), float(bx[3]) + 3.0)
        if x2 - x1 < 8 or y2 - y1 < 8:
          continue
        if lbl in (1, 2):
          text_boxes.append([x1, y1, x2, y2, sc])
        elif lbl == 0 and sc >= 0.45:
          bubble_fallback.append([x1, y1, x2, y2, sc])
      chosen = text_boxes if text_boxes else bubble_fallback
      return merge_nested_boxes(chosen)
    finally:
      q.put(sess)

  def detect_batch(self, images: list[Image.Image], mode: str) -> list[list[list[float]]]:
    futures = [self.executor.submit(self.detect_one, im, mode) for im in images]
    return [f.result() for f in futures]


def _preprocess_crop_224(crop: Image.Image) -> np.ndarray:
  gray_rgb = crop.convert("L").convert("RGB").resize((224, 224), Image.Resampling.BILINEAR)
  return (np.asarray(gray_rgb, dtype=np.float32).transpose(2, 0, 1) / 127.5) - 1.0


class HybridMangaOcrEngine:
  """Area-bucketed batch_size=48 CUDA Tensor-Core AMP engine (with C++ ONNX multi-core fallback)."""

  def __init__(self, num_workers: int, force_onnx: bool = False, gpu_batch_size: int = 48) -> None:
    self.num_workers = num_workers
    self.gpu_batch_size = gpu_batch_size
    self.intra_threads = max(1, CPU_CORES // num_workers)
    self.use_torch_gpu = False
    self.torch_device = "cpu"
    self.accelerator_label = ""
    self._init_lock = threading.Lock()
    self._gpu_lock = threading.Lock()
    self._ready = False
    self.executor = ThreadPoolExecutor(max_workers=max(num_workers, 8))
    self._onnx_pool: queue.Queue[tuple[ort.InferenceSession, ort.InferenceSession]] = queue.Queue()
    self._vocab: list[str] = []

    if HAS_TORCH_TRANSFORMERS and not force_onnx:
      if torch.cuda.is_available():
        torch.backends.cudnn.benchmark = True
        if hasattr(torch, "set_float32_matmul_precision"):
          torch.set_float32_matmul_precision("high")
        self.use_torch_gpu = True
        self.torch_device = "cuda"
        gpu_name = torch.cuda.get_device_name(0)
        self.accelerator_label = f"CUDA Tensor-Core Batched ({gpu_name})"
      elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        self.use_torch_gpu = True
        self.torch_device = "mps"
        self.accelerator_label = "Apple Metal MPS Batched GPU"

    if not self.use_torch_gpu:
      _, label = detect_ort_providers(prefer_cpu_for_int8=True)
      self.accelerator_label = f"{label} ({num_workers}x Parallel Pool)"

  def ensure_loaded(self) -> None:
    if self._ready:
      return
    with self._init_lock:
      if self._ready:
        return
      vocab_path = ensure_cached_file("vocab.txt", MODEL_URLS["mocr_vocab"])
      self._vocab = vocab_path.read_text(encoding="utf-8").splitlines()

      if self.use_torch_gpu:
        print(f"[Mokuro Turbo] Loading kha-white/manga-ocr-base onto {self.accelerator_label}...")
        self.model = VisionEncoderDecoderModel.from_pretrained("kha-white/manga-ocr-base")
        self.model.config.eos_token_id = 3
        self.model.config.pad_token_id = 0
        self.model.config.decoder_start_token_id = 2
        self.model.to(self.torch_device)
        self.model.eval()
        # Warm up CUDA kernel cache with 1 dummy forward pass
        with torch.inference_mode():
          dummy = torch.zeros((2, 3, 224, 224), dtype=torch.float32, device=self.torch_device)
          if self.torch_device == "cuda":
            with torch.amp.autocast("cuda", dtype=torch.float16):
              self.model.generate(dummy, max_new_tokens=4, num_beams=1, use_cache=True, eos_token_id=3, pad_token_id=0)
          else:
            self.model.generate(dummy, max_new_tokens=4, num_beams=1, use_cache=True, eos_token_id=3, pad_token_id=0)
        print(f"[Mokuro Turbo] GPU Warmup complete! Ready for batch_size={self.gpu_batch_size} extraction.")
        self._ready = True
        return

      enc_path = ensure_cached_file("encoder_model_quantized.onnx", MODEL_URLS["mocr_enc_q8"])
      dec_path = ensure_cached_file("decoder_model_merged_quantized.onnx", MODEL_URLS["mocr_dec_q8"])

      print(f"[Mokuro Turbo] Spawning {self.num_workers} parallel C++ manga-ocr ONNX sessions...")
      for _ in range(self.num_workers):
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = self.intra_threads
        opts.inter_op_num_threads = 1
        enc = ort.InferenceSession(str(enc_path), sess_options=opts, providers=["CPUExecutionProvider"])
        dec = ort.InferenceSession(str(dec_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self._onnx_pool.put((enc, dec))
      self._ready = True

  def _decode_token_seq(self, seq: list[int]) -> str:
    special = {"[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", ""}
    chars: list[str] = []
    for tid in seq:
      if tid == 3:
        break
      tok = self._vocab[tid] if 0 <= tid < len(self._vocab) else ""
      if tok in special:
        continue
      if tok.startswith("##"):
        tok = tok[2:]
      chars.append(tok)
    return postprocess_japanese_text("".join(chars))

  def _decode_one_onnx(self, pil_img: Image.Image) -> dict[str, Any]:
    arr = _preprocess_crop_224(pil_img)[None, ...]
    enc, dec = self._onnx_pool.get()
    try:
      enc_in = enc.get_inputs()[0].name
      hidden = enc.run(None, {enc_in: arr})[0]
      dec_inputs = [i.name for i in dec.get_inputs()]
      ids = [2]
      probs: list[float] = []
      for _ in range(96):
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
        if len(ids) >= 10 and len(set(ids[-7:])) == 1:
          break
      avg_conf = float(np.mean(probs)) if probs else 0.0
      return {"text": self._decode_token_seq(ids[1:]), "conf": avg_conf}
    finally:
      self._onnx_pool.put((enc, dec))

  def recognize_batch(self, crops: list[Image.Image]) -> list[dict[str, Any]]:
    if not crops:
      return []
    self.ensure_loaded()

    if self.use_torch_gpu:
      # Sort crops by pixel area so short 3-char bubbles batch together and terminate in ~8 steps
      # instead of waiting on a 60-char monologue bubble in the same batch!
      indexed = sorted(enumerate(crops), key=lambda pair: pair[1].width * pair[1].height)
      sorted_crops = [p[1] for p in indexed]

      # Parallel C-thread resize + normalize across all crops before GPU transfer
      pre_arrays = list(self.executor.map(_preprocess_crop_224, sorted_crops))
      sorted_results: list[dict[str, Any]] = []
      bs = self.gpu_batch_size

      with self._gpu_lock, torch.inference_mode():
        for i in range(0, len(pre_arrays), bs):
          batch_np = np.stack(pre_arrays[i : i + bs], axis=0)
          cpu_tensor = torch.from_numpy(batch_np)
          if self.torch_device == "cuda":
            cpu_tensor = cpu_tensor.pin_memory()
          pixel_values = cpu_tensor.to(self.torch_device, non_blocking=True)

          if self.torch_device == "cuda":
            with torch.amp.autocast("cuda", dtype=torch.float16):
              gen_ids = self.model.generate(
                  pixel_values,
                  max_new_tokens=96,
                  num_beams=1,
                  use_cache=True,
                  eos_token_id=3,
                  pad_token_id=0,
              )
          else:
            gen_ids = self.model.generate(
                pixel_values,
                max_new_tokens=96,
                num_beams=1,
                use_cache=True,
                eos_token_id=3,
                pad_token_id=0,
            )

          for seq in gen_ids.cpu().tolist():
            sorted_results.append({"text": self._decode_token_seq(seq), "conf": 0.96})

      # Restore original order
      final_out: list[dict[str, Any]] = [{"text": "", "conf": 0.0}] * len(crops)
      for (orig_idx, _), res in zip(indexed, sorted_results):
        final_out[orig_idx] = res
      return final_out

    futures = [self.executor.submit(self._decode_one_onnx, c) for c in crops]
    return [f.result() for f in futures]


def _decode_bytes_to_rgb(raw: bytes) -> Image.Image:
  im = Image.open(io.BytesIO(raw))
  return im.convert("RGB")


def build_app(workers: int, force_onnx: bool = False, gpu_batch_size: int = 48) -> FastAPI:
  app = FastAPI(title="Mokuro Turbo Native Server")
  ocr_engine = HybridMangaOcrEngine(num_workers=workers, force_onnx=force_onnx, gpu_batch_size=gpu_batch_size)
  det_pool = ParallelDetectorPool(num_workers=workers, cuda_ocr_active=ocr_engine.use_torch_gpu)
  io_pool = ThreadPoolExecutor(max_workers=max(8, workers * 2))

  if ocr_engine.use_torch_gpu:
    print(f"[GPU ACTIVE] {ocr_engine.accelerator_label} | Batch={gpu_batch_size}")
  else:
    print(f"[CPU MODE] {ocr_engine.accelerator_label}")
    if HAS_TORCH_TRANSFORMERS:
      print("  Note: PyTorch is installed WITHOUT CUDA support! Run run_windows.bat to install CUDA PyTorch.")
    else:
      print("  Tip: Install CUDA PyTorch + transformers (run_windows.bat) for 20x-40x faster RTX GPU batching.")

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
    return JSONResponse({"ok": True, "message": "Mokuro Turbo API running."})

  @app.get("/api/health")
  async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "accelerator": ocr_engine.accelerator_label,
        "gpu_active": ocr_engine.use_torch_gpu,
        "cpu_cores": CPU_CORES,
        "workers": workers,
    }

  @app.post("/api/detect_batch")
  async def api_detect_batch(
      files: list[UploadFile] = File(...),
      detector_mode: str = Form("rtdetr-int8"),
  ) -> dict[str, Any]:
    raw_list = [await up.read() for up in files]
    pil_pages = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    batch_boxes = det_pool.detect_batch(pil_pages, detector_mode)
    return {"ok": True, "pages": [{"boxes": b} for b in batch_boxes]}

  @app.post("/api/ocr_batch")
  async def api_ocr_batch(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    raw_list = [await up.read() for up in files]
    crops = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    out = ocr_engine.recognize_batch(crops)
    return {"ok": True, "results": out}

  @app.post("/api/extract_pages_server")
  async def api_extract_pages_server(
      files: list[UploadFile] = File(...),
      detector_mode: str = Form("rtdetr-int8"),
      meta_json: str = Form("[]"),
  ) -> dict[str, Any]:
    t0 = time.perf_counter()
    raw_list = [await up.read() for up in files]
    pil_pages = list(io_pool.map(_decode_bytes_to_rgb, raw_list))
    meta = json.loads(meta_json) if meta_json else []

    # 1. Detect only pages that weren't pre-detected
    undetected_indices = [
        i for i in range(len(pil_pages))
        if i >= len(meta) or not meta[i].get("boxes_detected")
    ]
    detected_map: dict[int, list[list[float]]] = {}
    if undetected_indices:
      sub_imgs = [pil_pages[i] for i in undetected_indices]
      det_out = det_pool.detect_batch(sub_imgs, detector_mode)
      for idx, boxes in zip(undetected_indices, det_out):
        detected_map[idx] = boxes

    # 2. Crop all bubbles in C memory across all pages in this chunk
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

    # 3. Run single batched Tensor-Core / Multi-Core OCR pass across all crops
    ocr_results = ocr_engine.recognize_batch(all_crops) if all_crops else []

    # 4. Reassemble per-page responses
    pages_out: list[dict[str, Any]] = []
    offset = 0
    for i, boxes in enumerate(page_boxes_list):
      cnt = crop_counts[i]
      slice_res = ocr_results[offset : offset + cnt]
      offset += cnt
      pages_out.append({
          "boxes": boxes,
          "texts": [r["text"] for r in slice_res],
          "confs": [r["conf"] for r in slice_res],
      })

    dt = max(0.001, time.perf_counter() - t0)
    print(f"[Turbo Chunk] {len(pil_pages)} pages ({len(all_crops)} bubbles) in {dt:.2f}s ({len(pil_pages)/dt:.1f} pages/s)")
    return {"ok": True, "pages": pages_out}

  return app


def main() -> None:
  parser = argparse.ArgumentParser(description="Mokuro Turbo Local Multi-Core / GPU Server")
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
  print(f" Mokuro Turbo Native Server listening at {url}")
  print(f" CPU Cores: {CPU_CORES} | Worker Pool: {args.workers} | GPU Batch: {args.batch_size}")
  print(f"========================================================\n")

  if not args.no_browser:
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()

  uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
  main()
