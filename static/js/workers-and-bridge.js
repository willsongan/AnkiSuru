"use strict";

// -----------------------------------------------------------------------
// Reading Order Sorter: Recursive Manga XY-Cut (Top-to-Bottom, Right-to-Left)
// -----------------------------------------------------------------------
function sortBlocksByReadingOrder(blocks, mode) {
  if (!blocks || blocks.length <= 1) return blocks || [];
  const copy = blocks.map((b) => ({ ...b }));
  if (mode === 'ttb') {
    copy.sort((a, b) => (a.y1 - b.y1) || (b.x2 - a.x2));
  } else if (mode === 'ltr') {
    const ordered = xyCutSort(copy, false);
    return ordered.map((b, i) => ({ ...b, index: i + 1 }));
  } else {
    const ordered = xyCutSort(copy, true);
    return ordered.map((b, i) => ({ ...b, index: i + 1 }));
  }
  return copy.map((b, i) => ({ ...b, index: i + 1 }));
}

function xyCutSort(items, rightToLeft) {
  if (items.length <= 1) return items;

  // 1. Try horizontal split (top-to-bottom panel rows)
  const byY = [...items].sort((a, b) => a.y1 - b.y1);
  let maxEndY = byY[0].y2;
  for (let i = 0; i < byY.length - 1; i++) {
    if (byY[i].y2 > maxEndY) maxEndY = byY[i].y2;
    if (byY[i + 1].y1 >= maxEndY - 4) {
      const topGroup = byY.slice(0, i + 1);
      const bottomGroup = byY.slice(i + 1);
      return [...xyCutSort(topGroup, rightToLeft), ...xyCutSort(bottomGroup, rightToLeft)];
    }
  }

  // 2. Try vertical split (right-to-left or left-to-right columns/panels)
  const byX = [...items].sort((a, b) => a.x1 - b.x1);
  let maxEndX = byX[0].x2;
  for (let i = 0; i < byX.length - 1; i++) {
    if (byX[i].x2 > maxEndX) maxEndX = byX[i].x2;
    if (byX[i + 1].x1 >= maxEndX - 4) {
      const leftGroup = byX.slice(0, i + 1);
      const rightGroup = byX.slice(i + 1);
      return rightToLeft
        ? [...xyCutSort(rightGroup, rightToLeft), ...xyCutSort(leftGroup, rightToLeft)]
        : [...xyCutSort(leftGroup, rightToLeft), ...xyCutSort(rightGroup, rightToLeft)];
    }
  }

  // 3. Fallback within overlapping cluster
  return [...items].sort((a, b) => {
    const ay = (a.y1 + a.y2) * 0.5;
    const by = (b.y1 + b.y2) * 0.5;
    const ax = (a.x1 + a.x2) * 0.5;
    const bx = (b.x1 + b.x2) * 0.5;
    return rightToLeft ? (ay - by) + (bx - ax) * 0.85 : (ay - by) + (ax - bx) * 0.85;
  });
}

// -----------------------------------------------------------------------
// Detector 1: Fast Manga Speech-Bubble & Glyph Cluster Detector (0 MB)
// -----------------------------------------------------------------------
function detectSpeechBubblesHeuristic(imgEl) {
  const origW = imgEl.naturalWidth || imgEl.width;
  const origH = imgEl.naturalHeight || imgEl.height;
  if (!origW || !origH) return [];

  const maxDim = 960;
  const scale = Math.min(1, maxDim / Math.max(origW, origH));
  const W = Math.max(32, Math.round(origW * scale));
  const H = Math.max(32, Math.round(origH * scale));

  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;

  const N = W * H;
  const gray = new Uint8Array(N);
  // Integral image of bright pixels (gray >= 198) for O(1) local white-balloon neighborhood check
  const brightIntegral = new Int32Array((W + 1) * (H + 1));

  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    const rowOff = y * W;
    const intOff = (y + 1) * (W + 1);
    const prevIntOff = y * (W + 1);
    for (let x = 0; x < W; x++) {
      const p = (rowOff + x) * 4;
      const lum = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
      gray[rowOff + x] = lum;
      if (lum >= 198) rowSum++;
      brightIntegral[intOff + x + 1] = brightIntegral[prevIntOff + x + 1] + rowSum;
    }
  }

  function rectBrightRatio(x1, y1, x2, y2) {
    const ax1 = Math.max(0, x1);
    const ay1 = Math.max(0, y1);
    const ax2 = Math.min(W, x2);
    const ay2 = Math.min(H, y2);
    const area = (ax2 - ax1) * (ay2 - ay1);
    if (area <= 0) return 0;
    const stride = W + 1;
    const sum =
      brightIntegral[ay2 * stride + ax2] -
      brightIntegral[ay1 * stride + ax2] -
      brightIntegral[ay2 * stride + ax1] +
      brightIntegral[ay1 * stride + ax1];
    return sum / area;
  }

  // Connected components on dark ink pixels (gray < 120)
  const visited = new Uint8Array(N);
  const stack = new Int32Array(N);
  const glyphs = [];

  const maxGlyphW = Math.max(14, W * 0.095);
  const maxGlyphH = Math.max(14, H * 0.095);

  for (let idx = 0; idx < N; idx++) {
    if (visited[idx] || gray[idx] >= 120) continue;
    visited[idx] = 1;
    let sp = 0;
    stack[sp++] = idx;

    let minX = idx % W;
    let maxX = minX;
    let minY = (idx / W) | 0;
    let maxY = minY;
    let count = 0;

    while (sp > 0) {
      const cur = stack[--sp];
      count++;
      const cx = cur % W;
      const cy = (cur / W) | 0;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      // 8-neighbors
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        const nRow = ny * W;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= W) continue;
          const nIdx = nRow + nx;
          if (!visited[nIdx] && gray[nIdx] < 120) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (count < 5) continue;
    if (bw > maxGlyphW || bh > maxGlyphH) continue;
    if (bw < 2 && bh < 4) continue;
    const fill = count / (bw * bh);
    if (fill < 0.07 || fill > 0.94) continue;
    const aspect = bw / bh;
    if (aspect < 0.12 || aspect > 8.0) continue;

    // Check surrounding bright balloon/caption background
    const pad = Math.max(4, Math.round(Math.max(bw, bh) * 0.35));
    const brightFrac = rectBrightRatio(minX - pad, minY - pad, maxX + pad + 1, maxY + pad + 1);
    if (brightFrac < 0.50) continue;

    glyphs.push({
      x1: minX,
      y1: minY,
      x2: maxX + 1,
      y2: maxY + 1,
      cx: (minX + maxX + 1) * 0.5,
      cy: (minY + maxY + 1) * 0.5,
      size: Math.max(bw, bh)
    });
  }

  if (glyphs.length === 0) {
    return [{
      id: 'blk_' + Math.random().toString(36).slice(2, 9),
      x1: 0,
      y1: 0,
      x2: origW,
      y2: origH,
      conf: 0.5,
      text: '',
      charConf: null
    }];
  }

  // Check if segment between two glyph centers crosses a continuous dark border line
  function crossesDarkWall(g1, g2) {
    const x0 = Math.round(g1.cx);
    const y0 = Math.round(g1.cy);
    const x1 = Math.round(g2.cx);
    const y1 = Math.round(g2.cy);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (steps < 4) return false;
    let whiteSeen = false;
    let darkAfterWhite = 0;
    let whiteAfterDark = false;
    for (let s = 2; s < steps - 1; s++) {
      const px = Math.round(x0 + ((x1 - x0) * s) / steps);
      const py = Math.round(y0 + ((y1 - y0) * s) / steps);
      const lum = gray[py * W + px];
      if (!whiteSeen) {
        if (lum > 200) whiteSeen = true;
      } else if (darkAfterWhite === 0) {
        if (lum < 110) darkAfterWhite = 1;
      } else if (!whiteAfterDark) {
        if (lum < 110) darkAfterWhite++;
        else if (lum > 200) whiteAfterDark = true;
      }
    }
    // If path goes white -> thin dark wall -> white and midpoint area isn't bright, avoid merging across balloons
    if (whiteSeen && whiteAfterDark && darkAfterWhite >= 2 && darkAfterWhite <= 7) {
      const mx = Math.round((x0 + x1) * 0.5);
      const my = Math.round((y0 + y1) * 0.5);
      if (gray[my * W + mx] < 120) return true;
    }
    return false;
  }

  // Union-Find clustering of glyphs into speech bubbles / text blocks
  const parent = new Int32Array(glyphs.length);
  for (let i = 0; i < glyphs.length; i++) parent[i] = i;
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function unite(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < glyphs.length; i++) {
    const a = glyphs[i];
    for (let j = i + 1; j < glyphs.length; j++) {
      const b = glyphs[j];
      const refSize = Math.max(a.size, b.size, 10);
      const gapX = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
      const gapY = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
      if (gapX <= refSize * 1.45 && gapY <= refSize * 1.45) {
        if (!crossesDarkWall(a, b)) {
          unite(i, j);
        }
      }
    }
  }

  const clusterMap = new Map();
  for (let i = 0; i < glyphs.length; i++) {
    const r = find(i);
    const g = glyphs[i];
    if (!clusterMap.has(r)) {
      clusterMap.set(r, { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, count: 1, sumSize: g.size });
    } else {
      const c = clusterMap.get(r);
      if (g.x1 < c.x1) c.x1 = g.x1;
      if (g.y1 < c.y1) c.y1 = g.y1;
      if (g.x2 > c.x2) c.x2 = g.x2;
      if (g.y2 > c.y2) c.y2 = g.y2;
      c.count++;
      c.sumSize += g.size;
    }
  }

  let rawBoxes = [];
  for (const c of clusterMap.values()) {
    const cw = c.x2 - c.x1;
    const ch = c.y2 - c.y1;
    if (c.count < 2 && Math.max(cw, ch) < 14) continue;
    if (cw < 8 || ch < 8) continue;
    const pad = Math.max(5, Math.round((c.sumSize / c.count) * 0.42));
    rawBoxes.push({
      x1: Math.max(0, (c.x1 - pad) / scale),
      y1: Math.max(0, (c.y1 - pad) / scale),
      x2: Math.min(origW, (c.x2 + pad) / scale),
      y2: Math.min(origH, (c.y2 + pad) / scale),
      conf: Math.min(0.98, 0.65 + c.count * 0.03)
    });
  }

  rawBoxes = mergeNestedBoxes(rawBoxes);
  if (rawBoxes.length === 0) {
    rawBoxes.push({ x1: 0, y1: 0, x2: origW, y2: origH, conf: 0.5 });
  }

  return rawBoxes.map((b) => ({
    id: 'blk_' + Math.random().toString(36).slice(2, 9),
    x1: Math.round(b.x1),
    y1: Math.round(b.y1),
    x2: Math.round(b.x2),
    y2: Math.round(b.y2),
    conf: b.conf,
    text: '',
    charConf: null
  }));
}

function mergeNestedBoxes(boxes) {
  const list = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ix1 = Math.max(a.x1, b.x1);
        const iy1 = Math.max(a.y1, b.y1);
        const ix2 = Math.min(a.x2, b.x2);
        const iy2 = Math.min(a.y2, b.y2);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        if (inter <= 0) continue;
        const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
        const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
        const minArea = Math.min(areaA, areaB);
        const iou = inter / (areaA + areaB - inter);
        if (inter / minArea >= 0.86 || iou >= 0.68) {
          a.x1 = Math.min(a.x1, b.x1);
          a.y1 = Math.min(a.y1, b.y1);
          a.x2 = Math.max(a.x2, b.x2);
          a.y2 = Math.max(a.y2, b.y2);
          a.conf = Math.max(a.conf, b.conf);
          list.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return list;
}

// -----------------------------------------------------------------------
// Non-Blocking Background Web Worker (WebGPU + WASM SIMD) for Neural Models
// Eliminates main-thread UI freezes during page detection & OCR decoding
// -----------------------------------------------------------------------
const SHARED_WORKER_BODY = [
  "let hasWebGpu = false;",
  "let rtdetrSession = null;",
  "let ctdSession = null;",
  "let ctdSavedBuf = null;",
  "let ctdEp = 'wasm';",
  "let mocrEnc = null;",
  "let mocrDec = null;",
  "",
  "async function probeGpu() {",
  "  try {",
  "    if (self.navigator && self.navigator.gpu) {",
  "      const adapter = await self.navigator.gpu.requestAdapter();",
  "      hasWebGpu = Boolean(adapter);",
  "    }",
  "  } catch (_e) { hasWebGpu = false; }",
  "  return hasWebGpu;",
  "}",
  "",
  "function parseRtdetrOutputs(session, outputs, origW, origH) {",
  "  const labelsT = outputs.labels || outputs[session.outputNames[0]];",
  "  const boxesT = outputs.boxes || outputs[session.outputNames[1]];",
  "  const scoresT = outputs.scores || outputs[session.outputNames[2]];",
  "  if (!labelsT || !boxesT || !scoresT) return [];",
  "  const labels = labelsT.data;",
  "  const boxes = boxesT.data;",
  "  const scores = scoresT.data;",
  "  const count = scores.length;",
  "  const textBoxes = [];",
  "  const bubbleFallback = [];",
  "  for (let i = 0; i < count; i++) {",
  "    const sc = Number(scores[i]);",
  "    if (sc < 0.32) continue;",
  "    const lbl = Number(labels[i]);",
  "    const bOff = i * 4;",
  "    const bw = Math.max(1, Number(boxes[bOff + 2]) - Number(boxes[bOff]));",
  "    const bh = Math.max(1, Number(boxes[bOff + 3]) - Number(boxes[bOff + 1]));",
  "    const padX = Math.max(5, Math.min(18, bw * 0.055));",
  "    const padY = Math.max(5, Math.min(18, bh * 0.045));",
  "    const x1 = Math.max(0, Number(boxes[bOff]) - padX);",
  "    const y1 = Math.max(0, Number(boxes[bOff + 1]) - padY);",
  "    const x2 = Math.min(origW, Number(boxes[bOff + 2]) + padX);",
  "    const y2 = Math.min(origH, Number(boxes[bOff + 3]) + padY);",
  "    if (x2 - x1 < 14 || y2 - y1 < 14) continue;",
  "    if (lbl === 1 && sc >= 0.38) {",
  "      textBoxes.push({ x1, y1, x2, y2, conf: sc });",
  "    } else if (lbl === 2 && sc >= 0.46) {",
  "      textBoxes.push({ x1, y1, x2, y2, conf: sc });",
  "    }",
  "  }",
  "  return textBoxes;",
  "}",
  "",
  "function parseCtdYoloBoxes(blkTensor, S, ratio, origW, origH) {",
  "  if (!blkTensor) return [];",
  "  const numPreds = blkTensor.dims[1];",
  "  const stride = blkTensor.dims[2];",
  "  const data = blkTensor.data;",
  "  let maxCoord = 0;",
  "  for (let i = 0; i < Math.min(numPreds, 500); i++) {",
  "    const v = data[i * stride + 2];",
  "    if (v > maxCoord) maxCoord = v;",
  "  }",
  "  const coordMul = maxCoord <= 2.0 ? S : 1.0;",
  "  const candidates = [];",
  "  const padPx = 4;",
  "  for (let i = 0; i < numPreds; i++) {",
  "    const base = i * stride;",
  "    const obj = data[base + 4];",
  "    if (obj < 0.35) continue;",
  "    let maxCls = 1.0;",
  "    if (stride > 5) {",
  "      maxCls = 0;",
  "      for (let c = 5; c < stride; c++) {",
  "        if (data[base + c] > maxCls) maxCls = data[base + c];",
  "      }",
  "    }",
  "    const score = obj * maxCls;",
  "    if (score < 0.35) continue;",
  "    const cx = data[base] * coordMul;",
  "    const cy = data[base + 1] * coordMul;",
  "    const bw = data[base + 2] * coordMul;",
  "    const bh = data[base + 3] * coordMul;",
  "    const x1 = Math.max(0, (cx - bw * 0.5) / ratio - padPx);",
  "    const y1 = Math.max(0, (cy - bh * 0.5) / ratio - padPx);",
  "    const x2 = Math.min(origW, (cx + bw * 0.5) / ratio + padPx);",
  "    const y2 = Math.min(origH, (cy + bh * 0.5) / ratio + padPx);",
  "    if (x2 - x1 >= 8 && y2 - y1 >= 8) {",
  "      candidates.push({ x1, y1, x2, y2, conf: score });",
  "    }",
  "  }",
  "  candidates.sort((a, b) => b.conf - a.conf);",
  "  const kept = [];",
  "  for (const cand of candidates) {",
  "    let suppressed = false;",
  "    for (const k of kept) {",
  "      const ix1 = Math.max(cand.x1, k.x1);",
  "      const iy1 = Math.max(cand.y1, k.y1);",
  "      const ix2 = Math.min(cand.x2, k.x2);",
  "      const iy2 = Math.min(cand.y2, k.y2);",
  "      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);",
  "      if (inter > 0) {",
  "        const areaA = (cand.x2 - cand.x1) * (cand.y2 - cand.y1);",
  "        const areaB = (k.x2 - k.x1) * (k.y2 - k.y1);",
  "        if (inter / (areaA + areaB - inter) > 0.35) { suppressed = true; break; }",
  "      }",
  "    }",
  "    if (!suppressed) kept.push(cand);",
  "  }",
  "  return kept;",
  "}",
  "",
  "self.onmessage = async (ev) => {",
  "  const msg = ev.data || {};",
  "  const reqId = msg.reqId;",
  "  try {",
  "    if (msg.type === 'ping') {",
  "      const gpu = await probeGpu();",
  "      self.postMessage({ reqId, ok: true, hasWebGpu: gpu });",
  "      return;",
  "    }",
  "    if (msg.type === 'init_rtdetr') {",
  "      if (!rtdetrSession) {",
  "        // INT8 quantized graph executes fastest on SIMD WASM without GPU-CPU partition copies",
  "        rtdetrSession = await ort.InferenceSession.create(msg.modelBuf, {",
  "          executionProviders: ['wasm'],",
  "          graphOptimizationLevel: 'all'",
  "        });",
  "      }",
  "      self.postMessage({ reqId, ok: true });",
  "      return;",
  "    }",
  "    if (msg.type === 'run_rtdetr') {",
  "      const inputArr = new Float32Array(msg.inputBuf);",
  "      const feeds = {};",
  "      for (const name of rtdetrSession.inputNames) {",
  "        if (name.toLowerCase().includes('size')) {",
  "          feeds[name] = new ort.Tensor('int64', BigInt64Array.from([BigInt(msg.origW), BigInt(msg.origH)]), [1, 2]);",
  "        } else {",
  "          feeds[name] = new ort.Tensor('float32', inputArr, [1, 3, 640, 640]);",
  "        }",
  "      }",
  "      const out = await rtdetrSession.run(feeds);",
  "      const boxes = parseRtdetrOutputs(rtdetrSession, out, msg.origW, msg.origH);",
  "      self.postMessage({ reqId, ok: true, boxes });",
  "      return;",
  "    }",
  "    if (msg.type === 'init_ctd') {",
  "      if (!ctdSession) {",
  "        await probeGpu();",
  "        if (hasWebGpu) {",
  "          try {",
  "            ctdSavedBuf = msg.modelBuf.slice(0);",
  "            ctdSession = await ort.InferenceSession.create(msg.modelBuf, {",
  "              executionProviders: ['webgpu', 'wasm'],",
  "              graphOptimizationLevel: 'all'",
  "            });",
  "            ctdEp = 'webgpu';",
  "          } catch (_gpuErr) {",
  "            ctdSession = null;",
  "          }",
  "        }",
  "        if (!ctdSession) {",
  "          const fallbackBuf = ctdSavedBuf || msg.modelBuf;",
  "          ctdSavedBuf = null;",
  "          ctdSession = await ort.InferenceSession.create(fallbackBuf, {",
  "            executionProviders: ['wasm'],",
  "            graphOptimizationLevel: 'all'",
  "          });",
  "          ctdEp = 'wasm';",
  "        }",
  "      }",
  "      self.postMessage({ reqId, ok: true, ep: ctdEp });",
  "      return;",
  "    }",
  "    if (msg.type === 'run_ctd') {",
  "      const S = msg.S;",
  "      const inputArr = new Float32Array(msg.inputBuf);",
  "      let outputs = null;",
  "      let blkName = ctdSession.outputNames.find((n) => n === 'blk') || ctdSession.outputNames[0];",
  "      try {",
  "        const inName = ctdSession.inputNames[0];",
  "        // Prune UNet (seg) and DBNet (det) heads by fetching ONLY the YOLOv5 blk output!",
  "        outputs = await ctdSession.run(",
  "          { [inName]: new ort.Tensor('float32', inputArr, [1, 3, S, S]) },",
  "          [blkName]",
  "        );",
  "        ctdSavedBuf = null;",
  "      } catch (runErr) {",
  "        if (ctdEp === 'webgpu' && ctdSavedBuf) {",
  "          ctdSession = await ort.InferenceSession.create(ctdSavedBuf, {",
  "            executionProviders: ['wasm'],",
  "            graphOptimizationLevel: 'all'",
  "          });",
  "          ctdSavedBuf = null;",
  "          ctdEp = 'wasm';",
  "          blkName = ctdSession.outputNames.find((n) => n === 'blk') || ctdSession.outputNames[0];",
  "          const inName2 = ctdSession.inputNames[0];",
  "          outputs = await ctdSession.run(",
  "            { [inName2]: new ort.Tensor('float32', inputArr, [1, 3, S, S]) },",
  "            [blkName]",
  "          );",
  "        } else {",
  "          throw runErr;",
  "        }",
  "      }",
  "      const blkTensor = outputs[blkName] || outputs[ctdSession.outputNames[0]];",
  "      const boxes = parseCtdYoloBoxes(blkTensor, S, msg.ratio, msg.origW, msg.origH);",
  "      self.postMessage({ reqId, ok: true, boxes, ep: ctdEp });",
  "      return;",
  "    }",
  "    if (msg.type === 'init_mocr') {",
  "      if (!mocrEnc || msg.forceReload) {",
  "        mocrEnc = await ort.InferenceSession.create(msg.encBuf, {",
  "          executionProviders: ['wasm'],",
  "          graphOptimizationLevel: 'all'",
  "        });",
  "      }",
  "      if (!mocrDec || msg.forceReload) {",
  "        mocrDec = await ort.InferenceSession.create(msg.decBuf, {",
  "          executionProviders: ['wasm'],",
  "          graphOptimizationLevel: 'all'",
  "        });",
  "      }",
  "      self.postMessage({ reqId, ok: true });",
  "      return;",
  "    }",
  "    if (msg.type === 'run_mocr') {",
  "      const pixelValues = new Float32Array(msg.inputBuf);",
  "      const encIn = mocrEnc.inputNames[0];",
  "      const encOut = await mocrEnc.run({ [encIn]: new ort.Tensor('float32', pixelValues, [1, 3, 224, 224]) });",
  "      const hidden = encOut.last_hidden_state || encOut[mocrEnc.outputNames[0]];",
  "      const ids = [2];",
  "      const probs = [];",
  "      for (let step = 0; step < 160; step++) {",
  "        const feeds = {};",
  "        for (const name of mocrDec.inputNames) {",
  "          if (name === 'input_ids') {",
  "            feeds[name] = new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);",
  "          } else if (name === 'encoder_hidden_states') {",
  "            feeds[name] = hidden;",
  "          } else if (name === 'encoder_attention_mask') {",
  "            const encSeq = hidden.dims[1] || 197;",
  "            feeds[name] = new ort.Tensor('int64', new BigInt64Array(encSeq).fill(1n), [1, encSeq]);",
  "          } else if (name === 'attention_mask') {",
  "            feeds[name] = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);",
  "          } else if (name === 'use_cache_branch') {",
  "            feeds[name] = new ort.Tensor('bool', [false], [1]);",
  "          } else if (name.startsWith('past_key_values')) {",
  "            feeds[name] = new ort.Tensor('float32', new Float32Array(0), [1, 12, 0, 64]);",
  "          }",
  "        }",
  "        const decOut = await mocrDec.run(feeds);",
  "        const logitsT = decOut.logits || decOut[mocrDec.outputNames[0]];",
  "        const vocabSize = logitsT.dims[logitsT.dims.length - 1];",
  "        const offset = (ids.length - 1) * vocabSize;",
  "        const logits = logitsT.data;",
  "        let bestId = 0;",
  "        let bestLogit = -Infinity;",
  "        for (let v = 0; v < vocabSize; v++) {",
  "          const val = logits[offset + v];",
  "          if (val > bestLogit) { bestLogit = val; bestId = v; }",
  "        }",
  "        let sumExp = 0;",
  "        for (let v = 0; v < vocabSize; v++) sumExp += Math.exp(logits[offset + v] - bestLogit);",
  "        const tokenProb = sumExp > 0 ? 1.0 / sumExp : 0;",
  "        if (bestId === 3 || bestId === 0) break;",
  "        ids.push(bestId);",
  "        probs.push(tokenProb);",
  "        if (ids.length >= 10) {",
  "          const tail = ids.slice(-7);",
  "          if (tail.every((t) => t === tail[0])) break;",
  "        }",
  "      }",
  "      const meanP = probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;",
  "      const minP = probs.length > 0 ? Math.min(...probs) : 0;",
  "      const avgConf = probs.length > 0 ? Math.max(0, Math.min(1, 0.65 * meanP + 0.35 * minP)) : 0;",
  "      self.postMessage({ reqId, ok: true, ids, avgConf });",
  "      return;",
  "    }",
  "    throw new Error('Unknown worker command: ' + msg.type);",
  "  } catch (err) {",
  "    self.postMessage({ reqId, ok: false, error: err ? (err.message || String(err)) : 'Worker error' });",
  "  }",
  "};"
].join('\n');

function setupOrtEnvSnippet() {
  return [
    "ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';",
    "ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;",
    "ort.env.wasm.proxy = false;"
  ].join('\n');
}

// -----------------------------------------------------------------------
// Multi-Worker Parallel Pool + Native Local GPU/Multi-Core Server Bridge
// -----------------------------------------------------------------------
function getDesiredPoolSize(taskKind) {
  if (state.workerPoolSetting !== 'auto') {
    const parsed = parseInt(state.workerPoolSetting, 10) || 2;
    // Guard 117MB manga-ocr / 95MB ctd WASM memory when user picks high count on modest RAM
    if (taskKind === 'mocr' || taskKind === 'ctd') return Math.min(parsed, 6);
    return Math.min(parsed, 8);
  }
  if (taskKind === 'mocr' || taskKind === 'ctd') return DEFAULT_OCR_WORKERS;
  return DEFAULT_DET_WORKERS;
}

function attachSlotRouting(slot) {
  slot.worker.onmessage = (ev) => {
    const data = ev.data || {};
    const entry = slot.pending.get(data.reqId);
    if (!entry) return;
    slot.pending.delete(data.reqId);
    if (data.ok) entry.resolve(data);
    else entry.reject(new Error(data.error || 'Worker error'));
  };
  slot.worker.onerror = (err) => {
    for (const [, entry] of slot.pending) {
      entry.reject(new Error(err && err.message ? err.message : 'Worker crashed'));
    }
    slot.pending.clear();
  };
}

function callSlot(slot, payload, transfers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reqId = ++runtime.workerReqSeq;
    const timer = timeoutMs
      ? setTimeout(() => {
          slot.pending.delete(reqId);
          reject(new Error('Worker timed out'));
        }, timeoutMs)
      : null;
    slot.pending.set(reqId, {
      resolve: (val) => {
        if (timer) clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
    slot.worker.postMessage({ ...payload, reqId }, transfers || []);
  });
}

async function spawnOneWorkerSlot(slotIndex) {
  if (runtime.workerFlavor !== 'classic' && runtime.workerFlavor !== 'none') {
    try {
      const modCode = [
        "import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/esm/ort.webgpu.min.mjs';",
        setupOrtEnvSnippet(),
        SHARED_WORKER_BODY
      ].join('\n');
      const blobUrl = URL.createObjectURL(new Blob([modCode], { type: 'text/javascript' }));
      const w = new Worker(blobUrl, { type: 'module' });
      const slot = {
        id: slotIndex,
        worker: w,
        busy: false,
        pending: new Map(),
        loaded: { rtdetr: false, ctd: false, mocr: false },
        hasWebGpu: false
      };
      attachSlotRouting(slot);
      const pong = await callSlot(slot, { type: 'ping' }, [], 3500);
      URL.revokeObjectURL(blobUrl);
      slot.hasWebGpu = Boolean(pong.hasWebGpu);
      runtime.workerFlavor = 'module';
      if (slot.hasWebGpu) runtime.hasWebGpu = true;
      return slot;
    } catch (_e) {
      if (runtime.workerFlavor === 'module') throw _e;
    }
  }

  if (runtime.workerFlavor !== 'none') {
    try {
      const classicCode = [
        "importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.min.js');",
        setupOrtEnvSnippet(),
        SHARED_WORKER_BODY
      ].join('\n');
      const blobUrl = URL.createObjectURL(new Blob([classicCode], { type: 'application/javascript' }));
      const w = new Worker(blobUrl);
      const slot = {
        id: slotIndex,
        worker: w,
        busy: false,
        pending: new Map(),
        loaded: { rtdetr: false, ctd: false, mocr: false },
        hasWebGpu: false
      };
      attachSlotRouting(slot);
      await callSlot(slot, { type: 'ping' }, [], 3500);
      URL.revokeObjectURL(blobUrl);
      runtime.workerFlavor = 'classic';
      return slot;
    } catch (_e2) {
      runtime.workerFlavor = 'none';
    }
  }
  return null;
}

function updateAccelBadgeText() {
  if (!el.accelStatusBadge) return;
  if (state.nativeBackend.connected && state.nativeBackend.info) {
    el.accelStatusBadge.textContent = 'Server · ' + (state.nativeBackend.info.accelerator || 'Connected');
    return;
  }
  const n = runtime.workerSlots.length;
  if (n > 0) {
    el.accelStatusBadge.textContent = (runtime.hasWebGpu ? 'WebGPU · ' : '') + n + (n === 1 ? ' Worker' : ' Workers');
  } else if (runtime.workerFlavor === 'none') {
    el.accelStatusBadge.textContent = 'Main Thread';
  }
}

async function ensureWorkerPoolSize(targetCount) {
  if (runtime.workerFlavor === 'none') return 0;
  const missing = targetCount - runtime.workerSlots.length;
  if (missing > 0) {
    const baseIdx = runtime.workerSlots.length;
    const creations = [];
    for (let i = 0; i < missing; i++) {
      creations.push(spawnOneWorkerSlot(baseIdx + i).catch(() => null));
    }
    const created = await Promise.all(creations);
    for (const slot of created) {
      if (slot) runtime.workerSlots.push(slot);
    }
  }
  updateAccelBadgeText();
  return runtime.workerSlots.length;
}

async function ensureAiWorker() {
  const count = await ensureWorkerPoolSize(getDesiredPoolSize('rtdetr'));
  return count > 0;
}

function releaseSlot(slot) {
  slot.busy = false;
  while (runtime.slotWaiters.length > 0) {
    const waiter = runtime.slotWaiters.shift();
    if (state.abortRequested) {
      try { waiter.reject(new Error('ABORTED')); } catch (_e) { /* ignore */ }
      continue;
    }
    if (!slot.busy) {
      slot.busy = true;
      waiter.resolve(slot);
      return;
    }
  }
}

function acquireWorkerSlot(maxSlotsAllowed) {
  if (state.abortRequested) {
    return Promise.reject(new Error('ABORTED'));
  }
  const usable = runtime.workerSlots.slice(0, maxSlotsAllowed);
  const free = usable.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve, reject) => {
    runtime.slotWaiters.push({ resolve, reject });
  });
}

function terminateAiWorkerForStop() {
  for (const slot of runtime.workerSlots) {
    try { slot.worker.terminate(); } catch (_e) { /* ignore */ }
    for (const [, entry] of slot.pending) {
      try { entry.reject(new Error('ABORTED')); } catch (_e) { /* ignore */ }
    }
    slot.pending.clear();
  }
  runtime.workerSlots = [];

  // Reject ALL queued slotWaiters so Promise.all consumers never deadlock on Stop!
  const waiting = runtime.slotWaiters.splice(0, runtime.slotWaiters.length);
  for (const waiter of waiting) {
    try { waiter.reject(new Error('ABORTED')); } catch (_e) { /* ignore */ }
  }

  state.activeOcrBlockIds.clear();
}

function triggerImmediateStop() {
  if (!state.isExtracting || state.abortRequested) return;
  state.abortRequested = true;

  // 1. Instant 0ms visual feedback on Stop button & progress strip
  const stopSpan = el.btnStopExtract ? el.btnStopExtract.querySelector('span') : null;
  if (stopSpan) stopSpan.textContent = 'Stopping…';
  if (el.btnStopExtract) el.btnStopExtract.disabled = true;
  setProgress(true, 'Stopping immediately…', 100);

  // 2. Abort all active HTTP sockets (Native Turbo Server chunks & weight downloads)
  for (const ctrl of Array.from(runtime.activeFetchControllers)) {
    try { ctrl.abort(); } catch (_e) { /* ignore */ }
  }
  runtime.activeFetchControllers.clear();

  // 3. Signal Local Native Turbo Server to halt active CUDA/CPU batch immediately
  if (state.nativeBackend.connected && state.nativeBackend.url) {
    fetch(state.nativeBackend.url + '/api/cancel', {
      method: 'POST',
      mode: 'cors',
      keepalive: true
    }).catch(() => {});
  }

  // 4. Terminate browser workers & reject all pending slot promises
  terminateAiWorkerForStop();
}

// Deduplicated shared buffer downloader so N parallel workers never download the same file twice
async function getCachedBufferInMemory(cacheKey, primaryUrl, fallbackUrl, label, basePct, spanPct) {
  if (runtime.buffers[cacheKey] && runtime.buffers[cacheKey].byteLength > 1024) {
    return runtime.buffers[cacheKey];
  }
  if (runtime.bufferPromises[cacheKey]) {
    return runtime.bufferPromises[cacheKey];
  }
  runtime.bufferPromises[cacheKey] = (async () => {
    try {
      const buf = await fetchWithProgressCached(cacheKey, primaryUrl, label, basePct, spanPct);
      runtime.buffers[cacheKey] = buf;
      return buf;
    } catch (err) {
      if (err && err.message === 'ABORTED') throw err;
      if (!fallbackUrl) throw err;
      const buf = await fetchWithProgressCached(cacheKey, fallbackUrl, label, basePct, spanPct);
      runtime.buffers[cacheKey] = buf;
      return buf;
    } finally {
      delete runtime.bufferPromises[cacheKey];
    }
  })();
  return runtime.bufferPromises[cacheKey];
}

// -----------------------------------------------------------------------
// Optional Local Native Python Multi-Core / GPU Server Auto-Bridge
// -----------------------------------------------------------------------
async function probeNativeBackend(customUrl, silent) {
  const cleanUrl = String(customUrl || state.nativeBackend.url || 'http://127.0.0.1:7860').replace(/\/+$/, '');
  state.nativeBackend.url = cleanUrl;
  if (el.inputBackendUrl) el.inputBackendUrl.value = cleanUrl;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), silent ? 850 : 3000);
  try {
    const healthUrl = cleanUrl + '/api/health';
    const resp = await fetch(healthUrl, { method: 'GET', mode: 'cors', signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const info = await resp.json();
    if (info && info.ok) {
      state.nativeBackend.connected = true;
      state.nativeBackend.info = info;
      if (el.backendStatusText) {
        if (info.gpu_warning) {
          el.backendStatusText.className = 'text-[11px] font-semibold text-amber-700';
          el.backendStatusText.textContent = 'CPU Mode Warning: ' + info.gpu_warning;
        } else {
          const detNote = info.det_accelerator ? ' + ' + info.det_accelerator : '';
          el.backendStatusText.className = 'text-[11px] font-semibold text-emerald-700';
          el.backendStatusText.textContent =
            'Connected: ' + (info.accelerator || 'Native GPU') + detNote;
        }
      }
      updateAccelBadgeText();
      if (typeof updateSettingsSummaryChip === 'function') updateSettingsSummaryChip();
      if (info.gpu_warning) {
        showToast('NVIDIA GPU found without CUDA PyTorch — run updated run_windows.bat for 25x speedup!', 'warn');
      } else if (!silent) {
        showToast('Connected to Local AnkiSuru Server (' + (info.accelerator || 'Active') + ')!');
      }
      if (info.warming_up) {
        setTimeout(() => { probeNativeBackend(cleanUrl, true); }, 2500);
      }
      return true;
    }
  } catch (_e) {
    clearTimeout(timer);
  }

  state.nativeBackend.connected = false;
  state.nativeBackend.info = null;
  if (el.backendStatusText) {
    el.backendStatusText.className = 'text-[11px] font-medium text-slate-500';
    el.backendStatusText.textContent = silent
      ? 'Browser workers active (connect for local GPU)'
      : 'No server at ' + cleanUrl + ' · using browser workers';
  }
  updateAccelBadgeText();
  if (typeof updateSettingsSummaryChip === 'function') updateSettingsSummaryChip();
  if (!silent) showToast('Local server not detected at ' + cleanUrl + '. Using Browser Multi-Worker Pool.', 'warn');
  return false;
}

async function urlToBlob(srcUrl) {
  const r = await fetch(srcUrl);
  return r.blob();
}

function cropImageToPngBlob(imgEl, box) {
  return new Promise((resolve) => {
    const cw = Math.max(1, Math.round(box.x2 - box.x1));
    const ch = Math.max(1, Math.round(box.y2 - box.y1));
    const cvs = document.createElement('canvas');
    cvs.width = cw;
    cvs.height = ch;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(imgEl, box.x1, box.y1, cw, ch, 0, 0, cw, ch);
    cvs.toBlob((b) => resolve(b), 'image/png');
  });
}

async function nativeDetectBatch(pagesSubset) {
  const fd = new FormData();
  fd.append('detector_mode', state.detectorMode);
  for (let i = 0; i < pagesSubset.length; i++) {
    const blob = await getPageFileOrBlob(pagesSubset[i]);
    fd.append('files', blob, pagesSubset[i].name || ('page_' + i + '.png'));
  }
  const endpoint = state.nativeBackend.url + '/api/detect_batch';
  const resp = await fetchAbortable(endpoint, { method: 'POST', mode: 'cors', body: fd });
  if (!resp.ok) throw new Error('Native detect HTTP ' + resp.status);
  const data = await resp.json();
  if (data && data.cancelled) throw new Error('ABORTED');
  return data.pages || [];
}

// Background Tab Anti-Sleep Keep-Alive:
// Holds an inaudible (-100 dB) Web Audio stream + Web Lock + Screen WakeLock while a job runs
// so Chrome/Edge/Firefox will NOT throttle or freeze the tab when minimized or in the background.
const keepAliveState = {
  audioCtx: null,
  osc: null,
  wakeLock: null,
  lockRelease: null
};

async function acquireBackgroundKeepAlive() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !keepAliveState.audioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001; // -100 dB completely silent
      osc.frequency.value = 20;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      keepAliveState.audioCtx = ctx;
      keepAliveState.osc = osc;
    }
  } catch (_e) { /* ignore */ }

  try {
    if (navigator.locks && navigator.locks.request && !keepAliveState.lockRelease) {
      navigator.locks.request('mokuro_active_batch_job', () => new Promise((res) => {
        keepAliveState.lockRelease = res;
      })).catch(() => {});
    }
  } catch (_e) { /* ignore */ }

  try {
    if (navigator.wakeLock && navigator.wakeLock.request && !keepAliveState.wakeLock) {
      keepAliveState.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    }
  } catch (_e) { /* ignore */ }
}

function releaseBackgroundKeepAlive() {
  if (keepAliveState.osc) {
    try { keepAliveState.osc.stop(); keepAliveState.osc.disconnect(); } catch (_e) { /* ignore */ }
    keepAliveState.osc = null;
  }
  if (keepAliveState.audioCtx) {
    try { keepAliveState.audioCtx.close(); } catch (_e) { /* ignore */ }
    keepAliveState.audioCtx = null;
  }
  if (keepAliveState.lockRelease) {
    try { keepAliveState.lockRelease(); } catch (_e) { /* ignore */ }
    keepAliveState.lockRelease = null;
  }
  if (keepAliveState.wakeLock) {
    try { keepAliveState.wakeLock.release(); } catch (_e) { /* ignore */ }
    keepAliveState.wakeLock = null;
  }
}

async function getPageFileOrBlob(page) {
  if (page.rawFile) return page.rawFile;
  return urlToBlob(page.url);
}

async function nativeOcrCropsBatch(cropJobs) {
  const fd = new FormData();
  fd.append('ocr_model', state.ocrEngine);
  const blobs = await Promise.all(cropJobs.map((job) => cropImageToPngBlob(job.imgEl, job.blk)));
  for (let i = 0; i < blobs.length; i++) {
    fd.append('files', blobs[i], 'crop_' + i + '.png');
  }
  const endpoint = state.nativeBackend.url + '/api/ocr_batch';
  const resp = await fetchAbortable(endpoint, { method: 'POST', mode: 'cors', body: fd });
  if (!resp.ok) throw new Error('Native OCR HTTP ' + resp.status);
  const data = await resp.json();
  if (data && data.cancelled) throw new Error('ABORTED');
  return data.results || [];
}

// High-Speed Zero-JS-Crop Server Pipeline: sends raw page JPEGs/PNGs + box coords directly to Python/CUDA
async function nativeExtractPagesChunk(pagesChunk) {
  const fd = new FormData();
  fd.append('detector_mode', state.detectorMode);
  fd.append('ocr_model', state.ocrEngine);
  fd.append('auto_prune_non_jp', state.autoPruneNonJp ? 'true' : 'false');
  const meta = [];
  for (let i = 0; i < pagesChunk.length; i++) {
    const p = pagesChunk[i];
    const blob = await getPageFileOrBlob(p);
    fd.append('files', blob, p.name || ('page_' + i + '.jpg'));
    meta.push({
      boxes_detected: Boolean(p.boxesDetected),
      boxes: (p.blocks || []).map((b) => [b.x1, b.y1, b.x2, b.y2, b.conf || 0.9]),
      manual_flags: (p.blocks || []).map((b) => Boolean(b.isManual))
    });
  }
  fd.append('meta_json', JSON.stringify(meta));
  const endpoint = state.nativeBackend.url + '/api/extract_pages_server';
  const resp = await fetchAbortable(endpoint, { method: 'POST', mode: 'cors', body: fd });
  if (!resp.ok) throw new Error('Server extract HTTP ' + resp.status);
  const data = await resp.json();
  if (data && data.cancelled) throw new Error('ABORTED');
  return data;
}

