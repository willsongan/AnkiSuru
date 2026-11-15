#!/usr/bin/env python3
"""Mokuro Turbo Native Server — Multi-Core & GPU Batched Manga OCR Backend.

Eliminates single-thread browser bottlenecks by running:
  1. Parallel multi-page speech-bubble detection across a C++ ONNX Runtime / GPU session pool
     (supports CUDA, Windows DirectML, Apple CoreML, and multi-core CPU).
  2. Batched GPU VisionEncoderDecoder inference (PyTorch CUDA FP16 / Apple MPS with KV-cache,
     processing 24+ bubbles per forward pass) OR a multi-core C++ ONNX Runtime session pool
     decoding N bubbles simultaneously across all physical CPU cores.
  3. Serves the full web UI at http://127.0.0.1:7860 (with COOP/COEP + CORS + Private Network
     headers so both http://127.0.0.1:7860 and external browser tabs can connect).
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import queue
import re
import threading
import urllib.request
import webbrowser
from typing import Any

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import numpy as np
import onnxruntime as ort
from PIL import Image
import uvicorn

# Optional PyTorch + Transformers batched GPU/MPS engine (auto-used when installed with GPU)
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
DEFAULT_WORKERS = min(8, max(2, CPU_CORES // 2))
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
        print(f"[Mokuro Turbo] Downloading {filename} from {url} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "MokuroTurbo/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
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
  return ["CPUExecutionProvider"], f"ONNX Multi-Core CPU ({CPU_CORES} threads)"


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
  """Pool of independent C++ ONNX Runtime sessions for lock-free multi-page detection."""

  def __init__(self, num_workers: int) -> None:
    self.num_workers = num_workers
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
        providers, _ = detect_ort_providers(prefer_cpu_for_int8=False)
        pool_size = 1 if providers[0] != "CPUExecutionProvider" else min(self.num_workers, 4)
      else:
        model_path = ensure_cached_file(
            "detector-v4-s_int8.onnx",
            MODEL_URLS["rtdetr_int8"],
            MODEL_URLS["rtdetr_int8_mirror"],
        )
        providers, _ = detect_ort_providers(prefer_cpu_for_int8=True)
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

      # Default: ogkalu/comic-text-and-bubble-detector INT8 (640x640)
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


class HybridMangaOcrEngine:
  """Uses GPU-batched PyTorch KV-cache inference if available, else C++ ONNX multi-core pool."""

  def __init__(self, num_workers: int, force_onnx: bool = False) -> None:
    self.num_workers = num_workers
    self.intra_threads = max(1, CPU_CORES // num_workers)
    self.use_torch_gpu = False
    self.accelerator_label = ""
    self._init_lock = threading.Lock()
    self._ready = False
    self.executor = ThreadPoolExecutor(max_workers=num_workers)
    self._onnx_pool: queue.Queue[tuple[ort.InferenceSession, ort.InferenceSession]] = queue.Queue()
    self._vocab: list[str] = []

    if HAS_TORCH_TRANSFORMERS and not force_onnx:
      if torch.cuda.is_available():
        self.use_torch_gpu = True
        self.torch_device = "cuda"
        self.accelerator_label = f"PyTorch CUDA Batched ({torch.cuda.get_device_name(0)})"
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
        print(f"[Mokuro Turbo] Loading kha-white/manga-ocr-base on {self.torch_device} (batched Tensor-Core AMP + KV-cache)...")
        # Keep FP32 master weights so DeiT LayerNorm variance never overflows FP16 on Turing (RTX 20xx),
        # while torch.amp.autocast accelerates matmuls/convs on Tensor Cores!
        self.model = VisionEncoderDecoderModel.from_pretrained("kha-white/manga-ocr-base")
        self.model.to(self.torch_device)
        self.model.eval()
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

  def _decode_one_onnx(self, pil_img: Image.Image) -> dict[str, Any]:
    gray_rgb = pil_img.convert("L").convert("RGB").resize((224, 224), Image.Resampling.BILINEAR)
    arr = (np.asarray(gray_rgb, dtype=np.float32).transpose(2, 0, 1)[None, ...] / 127.5) - 1.0
    enc, dec = self._onnx_pool.get()
    try:
      enc_in = enc.get_inputs()[0].name
      hidden = enc.run(None, {enc_in: arr})[0]
      dec_inputs = [i.name for i in dec.get_inputs()]
      ids = [2]
      probs: list[float] = []
      for _ in range(160):
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

      special = {"[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", ""}
      chars: list[str] = []
      for tid in ids[1:]:
        tok = self._vocab[tid] if tid < len(self._vocab) else ""
        if tok in special:
          continue
        if tok.startswith("##"):
          tok = tok[2:]
        chars.append(tok)
      avg_conf = float(np.mean(probs)) if probs else 0.0
      return {"text": postprocess_japanese_text("".join(chars)), "conf": avg_conf}
    finally:
      self._onnx_pool.put((enc, dec))

  def recognize_batch(self, crops: list[Image.Image]) -> list[dict[str, Any]]:
    if not crops:
      return []
    self.ensure_loaded()

    if self.use_torch_gpu:
      results: list[dict[str, Any]] = []
      chunk_size = 24
      with torch.inference_mode():
        for i in range(0, len(crops), chunk_size):
          sub = crops[i : i + chunk_size]
          batch_np = np.stack([
              (np.asarray(c.convert("L").convert("RGB").resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32).transpose(2, 0, 1) / 127.5) - 1.0
              for c in sub
          ], axis=0)
          pixel_values = torch.from_numpy(batch_np).to(self.torch_device, non_blocking=True)
          if self.torch_device == "cuda":
            with torch.amp.autocast("cuda", dtype=torch.float16):
              gen_ids = self.model.generate(pixel_values, max_new_tokens=160, num_beams=1, use_cache=True)
          else:
            gen_ids = self.model.generate(pixel_values, max_new_tokens=160, num_beams=1, use_cache=True)
          special = {"[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", ""}
          for seq in gen_ids.tolist():
            chars = []
            for tid in seq:
              if tid == 3:
                break
              tok = self._vocab[tid] if 0 <= tid < len(self._vocab) else ""
              if tok in special:
                continue
              if tok.startswith("##"):
                tok = tok[2:]
              chars.append(tok)
            results.append({"text": postprocess_japanese_text("".join(chars)), "conf": 0.96})
      return results

    futures = [self.executor.submit(self._decode_one_onnx, c) for c in crops]
    return [f.result() for f in futures]


def build_app(workers: int, force_onnx: bool = False) -> FastAPI:
  app = FastAPI(title="Mokuro Turbo Native Server")
  det_pool = ParallelDetectorPool(num_workers=workers)
  ocr_engine = HybridMangaOcrEngine(num_workers=workers, force_onnx=force_onnx)

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
        "cpu_cores": CPU_CORES,
        "workers": workers,
    }

  @app.post("/api/detect_batch")
  async def api_detect_batch(
      files: list[UploadFile] = File(...),
      detector_mode: str = Form("rtdetr-int8"),
  ) -> dict[str, Any]:
    pil_pages: list[Image.Image] = []
    for up in files:
      raw = await up.read()
      pil_pages.append(Image.open(io.BytesIO(raw)))
    batch_boxes = det_pool.detect_batch(pil_pages, detector_mode)
    return {"ok": True, "pages": [{"boxes": b} for b in batch_boxes]}

  @app.post("/api/ocr_batch")
  async def api_ocr_batch(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    crops: list[Image.Image] = []
    for up in files:
      raw = await up.read()
      crops.append(Image.open(io.BytesIO(raw)))
    out = ocr_engine.recognize_batch(crops)
    return {"ok": True, "results": out}

  return app


def main() -> None:
  parser = argparse.ArgumentParser(description="Mokuro Turbo Local Multi-Core / GPU Server")
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=7860)
  parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Parallel worker threads")
  parser.add_argument("--onnx-only", action="store_true", help="Force C++ ONNX multi-core pool")
  parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser tab")
  args = parser.parse_args()

  app = build_app(workers=max(1, args.workers), force_onnx=args.onnx_only)
  url = f"http://{args.host}:{args.port}"
  print(f"\n========================================================")
  print(f" Mokuro Turbo Native Server listening at {url}")
  print(f" CPU Cores: {CPU_CORES} | Parallel Worker Pool: {args.workers}")
  print(f"========================================================\n")

  if not args.no_browser:
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()

  uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
  main()
