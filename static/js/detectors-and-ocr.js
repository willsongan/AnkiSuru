"use strict";

// -----------------------------------------------------------------------
// Detector 2A: Neural Turbo comic-text-and-bubble INT8 (Multi-Worker Pool)
// -----------------------------------------------------------------------
async function ensureRtdetrPoolReady(maxNeededSlots) {
  const buf = await getCachedBufferInMemory(
    'ogkalu_det_v4s_int8_v1',
    MODEL_URLS.rtdetrInt8Primary,
    MODEL_URLS.rtdetrInt8Mirror,
    'Neural Turbo Detector (11.1 MB)',
    2,
    24
  );
  const desired = getDesiredPoolSize('rtdetr');
  const needed = typeof maxNeededSlots === 'number' && maxNeededSlots > 0
    ? Math.min(desired, maxNeededSlots)
    : desired;
  const activeCount = await ensureWorkerPoolSize(needed);
  if (activeCount > 0) {
    const usable = runtime.workerSlots.slice(0, needed);
    const uninit = usable.filter((s) => !s.loaded.rtdetr);
    if (uninit.length > 0) {
      setProgress(true, 'Initializing Neural Turbo Detector (' + usable.length + (usable.length === 1 ? ' worker' : ' parallel workers') + ')…', 28);
      await Promise.all(uninit.map(async (slot) => {
        const copyBuf = buf.slice(0);
        await callSlot(slot, { type: 'init_rtdetr', modelBuf: copyBuf }, [copyBuf]);
        slot.loaded.rtdetr = true;
      }));
    }
    return 'pool';
  }
  if (!runtime.mainFallbackSessions.rtdetr) {
    runtime.mainFallbackSessions.rtdetr = await window.ort.InferenceSession.create(buf.slice(0), {
      executionProviders: ['wasm']
    });
  }
  return 'main';
}

async function detectComicTextRtdetrInt8(imgEl) {
  const origW = imgEl.naturalWidth || imgEl.width;
  const origH = imgEl.naturalHeight || imgEl.height;
  const mode = await ensureRtdetrPoolReady(1);

  const S = 640;
  const cvs = document.createElement('canvas');
  cvs.width = S;
  cvs.height = S;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, S, S);
  const rgba = ctx.getImageData(0, 0, S, S).data;

  const plane = S * S;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    input[i] = rgba[p] / 255.0;
    input[plane + i] = rgba[p + 1] / 255.0;
    input[2 * plane + i] = rgba[p + 2] / 255.0;
  }

  let rawBoxes = [];
  if (mode === 'pool') {
    const maxSlots = getDesiredPoolSize('rtdetr');
    const slot = await acquireWorkerSlot(maxSlots);
    try {
      if (!slot.loaded.rtdetr) {
        const copyBuf = runtime.buffers['ogkalu_det_v4s_int8_v1'].slice(0);
        await callSlot(slot, { type: 'init_rtdetr', modelBuf: copyBuf }, [copyBuf]);
        slot.loaded.rtdetr = true;
      }
      const res = await callSlot(
        slot,
        { type: 'run_rtdetr', inputBuf: input.buffer, origW, origH },
        [input.buffer]
      );
      rawBoxes = res.boxes || [];
    } finally {
      releaseSlot(slot);
    }
  } else {
    await new Promise((r) => requestAnimationFrame(r));
    const sess = runtime.mainFallbackSessions.rtdetr;
    const feeds = {};
    for (const name of sess.inputNames) {
      if (name.toLowerCase().includes('size')) {
        feeds[name] = new window.ort.Tensor('int64', BigInt64Array.from([BigInt(origW), BigInt(origH)]), [1, 2]);
      } else {
        feeds[name] = new window.ort.Tensor('float32', input, [1, 3, S, S]);
      }
    }
    const out = await sess.run(feeds);
    const labels = (out.labels || out[sess.outputNames[0]]).data;
    const boxes = (out.boxes || out[sess.outputNames[1]]).data;
    const scores = (out.scores || out[sess.outputNames[2]]).data;
    for (let i = 0; i < scores.length; i++) {
      const sc = Number(scores[i]);
      const lbl = Number(labels[i]);
      if (sc >= 0.30 && (lbl === 1 || lbl === 2)) {
        const bOff = i * 4;
        const x1 = Math.max(0, Number(boxes[bOff]) - 3);
        const y1 = Math.max(0, Number(boxes[bOff + 1]) - 3);
        const x2 = Math.min(origW, Number(boxes[bOff + 2]) + 3);
        const y2 = Math.min(origH, Number(boxes[bOff + 3]) + 3);
        if (x2 - x1 >= 8 && y2 - y1 >= 8) rawBoxes.push({ x1, y1, x2, y2, conf: sc });
      }
    }
  }

  const merged = mergeNestedBoxes(rawBoxes);
  if (merged.length === 0) return [];
  return merged.map((b) => ({
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

// -----------------------------------------------------------------------
// Detector 2B: Neural comic-text-detector ONNX (Multi-Worker Pool + WebGPU)
// -----------------------------------------------------------------------
async function ensureCtdPoolReady(maxNeededSlots) {
  const buf = await getCachedBufferInMemory(
    'ctd_onnx_v1',
    MODEL_URLS.ctdOnnx,
    null,
    'comic-text-detector ONNX (95 MB)',
    2,
    24
  );
  const desired = getDesiredPoolSize('ctd');
  const targetWorkers = typeof maxNeededSlots === 'number' && maxNeededSlots > 0
    ? Math.min(desired, maxNeededSlots)
    : desired;
  const activeCount = await ensureWorkerPoolSize(targetWorkers);
  if (activeCount > 0) {
    const usable = runtime.workerSlots.slice(0, targetWorkers);
    const uninit = usable.filter((s) => !s.loaded.ctd);
    if (uninit.length > 0) {
      setProgress(true, 'Compiling comic-text-detector across ' + usable.length + ' parallel workers…', 28);
      for (const slot of uninit) {
        try {
          const copyBuf = buf.slice(0);
          await callSlot(slot, { type: 'init_ctd', modelBuf: copyBuf }, [copyBuf]);
          slot.loaded.ctd = true;
        } catch (_oomErr) {
          if (usable.some((s) => s.loaded.ctd)) break;
          throw _oomErr;
        }
      }
    }
    return 'pool';
  }
  if (!runtime.mainFallbackSessions.ctd) {
    runtime.mainFallbackSessions.ctd = await window.ort.InferenceSession.create(buf.slice(0), {
      executionProviders: ['webgpu', 'wasm']
    }).catch(() => window.ort.InferenceSession.create(buf.slice(0), { executionProviders: ['wasm'] }));
  }
  return 'main';
}

async function detectComicTextOnnx(imgEl) {
  const origW = imgEl.naturalWidth || imgEl.width;
  const origH = imgEl.naturalHeight || imgEl.height;
  const mode = await ensureCtdPoolReady(1);

  const S = 1024;
  const ratio = Math.min(S / origW, S / origH);
  const newW = Math.round(origW * ratio);
  const newH = Math.round(origH * ratio);

  const cvs = document.createElement('canvas');
  cvs.width = S;
  cvs.height = S;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(imgEl, 0, 0, newW, newH);
  const rgba = ctx.getImageData(0, 0, S, S).data;

  const plane = S * S;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    input[i] = rgba[p] / 255.0;
    input[plane + i] = rgba[p + 1] / 255.0;
    input[2 * plane + i] = rgba[p + 2] / 255.0;
  }

  let kept = [];
  if (mode === 'pool') {
    const maxSlots = getDesiredPoolSize('ctd');
    const slot = await acquireWorkerSlot(maxSlots);
    try {
      if (!slot.loaded.ctd) {
        const copyBuf = runtime.buffers['ctd_onnx_v1'].slice(0);
        await callSlot(slot, { type: 'init_ctd', modelBuf: copyBuf }, [copyBuf]);
        slot.loaded.ctd = true;
      }
      const res = await callSlot(
        slot,
        { type: 'run_ctd', inputBuf: input.buffer, S, ratio, origW, origH },
        [input.buffer]
      );
      kept = res.boxes || [];
    } finally {
      releaseSlot(slot);
    }
  } else {
    await new Promise((r) => requestAnimationFrame(r));
    const session = runtime.mainFallbackSessions.ctd;
    const inName = session.inputNames[0];
    const blkName = session.outputNames.find((n) => n === 'blk') || session.outputNames[0];
    const outputs = await session.run(
      { [inName]: new window.ort.Tensor('float32', input, [1, 3, S, S]) },
      [blkName]
    );
    const blkTensor = outputs[blkName] || outputs[session.outputNames[0]];
    if (blkTensor) {
      const numPreds = blkTensor.dims[1];
      const stride = blkTensor.dims[2];
      const data = blkTensor.data;
      for (let i = 0; i < numPreds; i++) {
        const base = i * stride;
        const obj = data[base + 4];
        if (obj < 0.35) continue;
        const maxCls = stride > 5 ? Math.max(data[base + 5], data[base + 6] || 0) : 1.0;
        const score = obj * maxCls;
        if (score < 0.35) continue;
        const cx = data[base];
        const cy = data[base + 1];
        const bw = data[base + 2];
        const bh = data[base + 3];
        kept.push({
          x1: Math.max(0, (cx - bw * 0.5) / ratio - 4),
          y1: Math.max(0, (cy - bh * 0.5) / ratio - 4),
          x2: Math.min(origW, (cx + bw * 0.5) / ratio + 4),
          y2: Math.min(origH, (cy + bh * 0.5) / ratio + 4),
          conf: score
        });
      }
    }
  }

  const merged = mergeNestedBoxes(kept);
  if (merged.length === 0) return [];
  return merged.map((b) => ({
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

async function detectBlocksForPage(imgEl) {
  let blocks = [];
  if (state.detectorMode === 'ctd-onnx') {
    try {
      blocks = await detectComicTextOnnx(imgEl);
    } catch (err) {
      if (err && err.message === 'ABORTED') throw err;
      showToast('Mokuro CTD unavailable (' + err.message + '); using offline fallback.', 'warn');
      blocks = detectSpeechBubblesHeuristic(imgEl);
    }
  } else {
    try {
      blocks = await detectComicTextRtdetrInt8(imgEl);
    } catch (err) {
      if (err && err.message === 'ABORTED') throw err;
      showToast('RT-DETRv2 unavailable (' + err.message + '); using offline fallback.', 'warn');
      blocks = detectSpeechBubblesHeuristic(imgEl);
    }
  }
  blocks = filterVisuallyPlausibleBoxesOnImage(imgEl, blocks);
  return sortBlocksByReadingOrder(blocks, state.readingOrder);
}

// -----------------------------------------------------------------------
// OCR Engine 1: kha-white/manga-ocr ONNX (Parallel Multi-Worker Pool)
// -----------------------------------------------------------------------
async function loadMocrVocabForVariant(variant) {
  const isCpt = variant === 'manga-ocr-cpt';
  const idbKey = isCpt ? 'mocr_cpt_v2_vocab' : 'mocr_vocab_v1';
  const url = isCpt ? MODEL_URLS.mocrCptVocab : MODEL_URLS.mocrVocab;
  if (runtime.mocrVocabs[variant]) return runtime.mocrVocabs[variant];
  if (!runtime.mocrVocabPromises[variant]) {
    runtime.mocrVocabPromises[variant] = (async () => {
      try {
        const cached = await idbGet(idbKey);
        if (cached && Array.isArray(cached) && cached.length > 1000) {
          runtime.mocrVocabs[variant] = cached;
          return cached;
        }
        setProgress(true, 'Fetching Japanese OCR vocabulary (' + (isCpt ? '6,817' : '6,144') + ' tokens)…', 5);
        const vResp = await fetchAbortable(url, { mode: 'cors' });
        if (!vResp.ok) throw new Error('Vocab HTTP ' + vResp.status);
        const vText = await vResp.text();
        const lines = vText.split(/\r?\n/);
        runtime.mocrVocabs[variant] = lines;
        await idbPut(idbKey, lines);
        return lines;
      } finally {
        delete runtime.mocrVocabPromises[variant];
      }
    })();
  }
  return runtime.mocrVocabPromises[variant];
}

async function prefetchMangaOcrAssets() {
  let variant = 'manga-ocr-cpt';
  let encKey = variant === 'manga-ocr-cpt' ? 'mocr_cpt_enc_q8_v2' : 'mocr_enc_q8_v1';
  let decKey = variant === 'manga-ocr-cpt' ? 'mocr_cpt_dec_q8_v2' : 'mocr_dec_q8_v1';
  let encBuf = null;
  let decBuf = null;

  if (variant === 'manga-ocr-cpt') {
    try {
      const [, eBuf, dBuf] = await Promise.all([
        loadMocrVocabForVariant('manga-ocr-cpt'),
        getCachedBufferInMemory(
          encKey,
          MODEL_URLS.mocrCptEncoder,
          MODEL_URLS.mocrCptEncoderAlt,
          'manga-ocr-base-CPT v2 ViT Encoder',
          8,
          48
        ),
        getCachedBufferInMemory(
          decKey,
          MODEL_URLS.mocrCptDecoder,
          MODEL_URLS.mocrCptDecoderAlt,
          'manga-ocr-base-CPT v2 Japanese Decoder',
          58,
          26
        )
      ]);
      encBuf = eBuf;
      decBuf = dBuf;
    } catch (cptErr) {
      if (isAbortError(cptErr)) throw new Error('ABORTED');
      variant = 'manga-ocr';
      encKey = 'mocr_enc_q8_v1';
      decKey = 'mocr_dec_q8_v1';
    }
  }

  if (!encBuf || !decBuf) {
    const [, eBuf, dBuf] = await Promise.all([
      loadMocrVocabForVariant('manga-ocr'),
      getCachedBufferInMemory(
        encKey,
        MODEL_URLS.mocrEncoder,
        null,
        'manga-ocr ViT Encoder (87 MB)',
        8,
        48
      ),
      getCachedBufferInMemory(
        decKey,
        MODEL_URLS.mocrDecoder,
        null,
        'manga-ocr Japanese Decoder (30 MB)',
        58,
        26
      )
    ]);
    encBuf = eBuf;
    decBuf = dBuf;
  }

  runtime.activeMocrVariant = variant;
  runtime.activeMocrEncKey = encKey;
  runtime.activeMocrDecKey = decKey;
  return { variant, encKey, decKey, encBuf, decBuf };
}

async function ensureMangaOcrPoolReady(maxNeededSlots) {
  const { variant, encBuf, decBuf } = await prefetchMangaOcrAssets();
  const desired = getDesiredPoolSize('mocr');
  const targetWorkers = typeof maxNeededSlots === 'number' && maxNeededSlots > 0
    ? Math.min(desired, maxNeededSlots)
    : desired;
  const activeCount = await ensureWorkerPoolSize(targetWorkers);
  if (activeCount > 0) {
    const usable = runtime.workerSlots.slice(0, targetWorkers);
    const uninit = usable.filter((s) => s.loaded.mocrVariant !== variant);
    if (uninit.length > 0) {
      setProgress(true, 'Initializing Japanese OCR (' + usable.length + (usable.length === 1 ? ' worker' : ' parallel workers') + ')…', 88);
      let firstErr = null;
      await Promise.all(uninit.map(async (slot) => {
        try {
          const encCopy = encBuf.slice(0);
          const decCopy = decBuf.slice(0);
          await callSlot(
            slot,
            { type: 'init_mocr', encBuf: encCopy, decBuf: decCopy, forceReload: Boolean(slot.loaded.mocr) },
            [encCopy, decCopy]
          );
          slot.loaded.mocr = true;
          slot.loaded.mocrVariant = variant;
        } catch (oomErr) {
          if (!firstErr) firstErr = oomErr;
        }
      }));
      if (!usable.some((s) => s.loaded.mocrVariant === variant) && firstErr) {
        throw firstErr;
      }
    }
    return 'pool';
  }

  if (!runtime.mainFallbackSessions.mocrEnc || runtime.mainFallbackSessions.variant !== variant) {
    runtime.mainFallbackSessions.mocrEnc = await window.ort.InferenceSession.create(encBuf.slice(0), {
      executionProviders: ['wasm']
    });
    runtime.mainFallbackSessions.mocrDec = await window.ort.InferenceSession.create(decBuf.slice(0), {
      executionProviders: ['wasm']
    });
    runtime.mainFallbackSessions.variant = variant;
  }
  return 'main';
}

function postProcessMangaOcrText(rawStr) {
  if (!rawStr) return '';
  let s = rawStr.replace(/\s+/g, '');
  s = s.replace(/[・.．]{2,}/g, '…');
  // Convert half-width ASCII punctuation/digits/letters to full-width Japanese forms
  s = s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
  return s.trim();
}

function decodeTokenIdsToJapanese(ids) {
  const vocab = runtime.mocrVocabs[runtime.activeMocrVariant || 'manga-ocr'] || [];
  const special = new Set(['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]', '']);
  const chars = [];
  for (let i = 1; i < ids.length; i++) {
    let tok = vocab[ids[i]] || '';
    if (special.has(tok)) continue;
    if (tok.startsWith('##')) tok = tok.slice(2);
    chars.push(tok);
  }
  return postProcessMangaOcrText(chars.join(''));
}

async function recognizeCropMangaOcr(imgEl, box) {
  const mode = await ensureMangaOcrPoolReady(1);

  const S = 224;
  const cropW = Math.max(1, box.x2 - box.x1);
  const cropH = Math.max(1, box.y2 - box.y1);

  const cvs = document.createElement('canvas');
  cvs.width = S;
  cvs.height = S;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imgEl, box.x1, box.y1, cropW, cropH, 0, 0, S, S);

  const rgba = ctx.getImageData(0, 0, S, S).data;
  const plane = S * S;
  const pixelValues = new Float32Array(3 * plane);

  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    const gray = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
    const norm = gray / 127.5 - 1.0;
    pixelValues[i] = norm;
    pixelValues[plane + i] = norm;
    pixelValues[2 * plane + i] = norm;
  }

  if (mode === 'pool') {
    const maxSlots = getDesiredPoolSize('mocr');
    const slot = await acquireWorkerSlot(maxSlots);
    try {
      const activeVar = runtime.activeMocrVariant || 'manga-ocr';
      if (slot.loaded.mocrVariant !== activeVar) {
        const encCopy = runtime.buffers[runtime.activeMocrEncKey].slice(0);
        const decCopy = runtime.buffers[runtime.activeMocrDecKey].slice(0);
        await callSlot(
          slot,
          { type: 'init_mocr', encBuf: encCopy, decBuf: decCopy, forceReload: Boolean(slot.loaded.mocr) },
          [encCopy, decCopy]
        );
        slot.loaded.mocr = true;
        slot.loaded.mocrVariant = activeVar;
      }
      const res = await callSlot(slot, { type: 'run_mocr', inputBuf: pixelValues.buffer }, [pixelValues.buffer]);
      return {
        text: decodeTokenIdsToJapanese(res.ids || []),
        charConf: normalizeConf01(res.avgConf !== undefined ? res.avgConf : 0)
      };
    } finally {
      releaseSlot(slot);
    }
  }

  const encSess = runtime.mainFallbackSessions.mocrEnc;
  const decSess = runtime.mainFallbackSessions.mocrDec;
  const encOut = await encSess.run({
    [encSess.inputNames[0]]: new window.ort.Tensor('float32', pixelValues, [1, 3, S, S])
  });
  const hidden = encOut.last_hidden_state || encOut[encSess.outputNames[0]];
  const ids = [2];
  const probs = [];
  for (let step = 0; step < 160; step++) {
    if (state.abortRequested) throw new Error('ABORTED');
    if (step % 6 === 0) await new Promise((r) => requestAnimationFrame(r));
    const feeds = {};
    for (const name of decSess.inputNames) {
      if (name === 'input_ids') {
        feeds[name] = new window.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
      } else if (name === 'encoder_hidden_states') {
        feeds[name] = hidden;
      } else if (name === 'encoder_attention_mask') {
        const encSeq = hidden.dims[1] || 197;
        feeds[name] = new window.ort.Tensor('int64', new BigInt64Array(encSeq).fill(1n), [1, encSeq]);
      } else if (name === 'attention_mask') {
        feeds[name] = new window.ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
      } else if (name === 'use_cache_branch') {
        feeds[name] = new window.ort.Tensor('bool', [false], [1]);
      } else if (name.startsWith('past_key_values')) {
        feeds[name] = new window.ort.Tensor('float32', new Float32Array(0), [1, 12, 0, 64]);
      }
    }
    const decOut = await decSess.run(feeds);
    const logitsT = decOut.logits || decOut[decSess.outputNames[0]];
    const vocabSize = logitsT.dims[logitsT.dims.length - 1];
    const offset = (ids.length - 1) * vocabSize;
    const logits = logitsT.data;
    let bestId = 0;
    let bestLogit = -Infinity;
    for (let v = 0; v < vocabSize; v++) {
      const val = logits[offset + v];
      if (val > bestLogit) { bestLogit = val; bestId = v; }
    }
    let sumExp = 0;
    for (let v = 0; v < vocabSize; v++) sumExp += Math.exp(logits[offset + v] - bestLogit);
    if (bestId === 3 || bestId === 0) break;
    ids.push(bestId);
    probs.push(sumExp > 0 ? 1.0 / sumExp : 0);
  }
  const meanP = probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
  const minP = probs.length > 0 ? Math.min(...probs) : 0;
  const avgConf = probs.length > 0 ? Math.max(0, Math.min(1, 0.65 * meanP + 0.35 * minP)) : 0;
  return { text: decodeTokenIdsToJapanese(ids), charConf: avgConf };
}

async function recognizeSingleBlock(imgEl, box) {
  if (state.nativeBackend.connected) {
    try {
      const batchOut = await nativeOcrCropsBatch([{ imgEl, blk: box }]);
      if (batchOut && batchOut[0]) {
        return { text: batchOut[0].text || '', charConf: normalizeConf01(batchOut[0].conf) };
      }
    } catch (_e) {
      if (isAbortError(_e)) throw new Error('ABORTED');
      state.nativeBackend.connected = false;
      updateAccelBadgeText();
    }
  }
  return recognizeCropMangaOcr(imgEl, box);
}

// -----------------------------------------------------------------------
// Parallel Orchestrators (Multi-Page Detection & Lock-Free Multi-Bubble OCR)
// -----------------------------------------------------------------------
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not decode image'));
    im.src = src;
  });
}

function getFastDecodedPageImage(page) {
  if (
    page &&
    state.selectedPageId === page.id &&
    el.activePageImage &&
    el.activePageImage.complete &&
    el.activePageImage.naturalWidth > 0
  ) {
    return Promise.resolve(el.activePageImage);
  }
  return loadImageElement(page.url);
}

function setExtractingUI(running) {
  state.isExtracting = running;
  const noPages = state.pages.length === 0;
  el.btnDetectAllBoxes.disabled = running || noPages;
  el.btnExtractAll.disabled = running || noPages;
  el.btnExtractPage.disabled = running || !getSelectedPage();
  el.btnRedetectPage.disabled = running || !getSelectedPage();
  const stopSpan = el.btnStopExtract ? el.btnStopExtract.querySelector('span') : null;
  if (stopSpan) stopSpan.textContent = 'Stop';
  el.btnStopExtract.disabled = false;
  if (running) {
    el.btnStopExtract.classList.remove('hidden');
    el.btnStopExtract.classList.add('inline-flex');
    el.btnExtractAll.classList.add('opacity-60');
    el.btnDetectAllBoxes.classList.add('opacity-60');
  } else {
    el.btnStopExtract.classList.add('hidden');
    el.btnStopExtract.classList.remove('inline-flex');
    el.btnExtractAll.classList.remove('opacity-60');
    el.btnDetectAllBoxes.classList.remove('opacity-60');
  }
}

let lastTranscriptRefreshTs = 0;
function throttledRefreshRightPanel(force) {
  const now = performance.now();
  if (!force && now - lastTranscriptRefreshTs < 280) return;
  lastTranscriptRefreshTs = now;
  renderRightPanel();
}

async function runParallelPagesDetectionInternal(pagesToDetect, progressPrefix) {
  if (pagesToDetect.length === 0) return 0;
  let totalBoxes = 0;

  // Fast Path 1: Connected Local Native Python GPU / All-Core Server (pipelined 8-page chunks)
  if (state.nativeBackend.connected) {
    try {
      const chunkSize = 8;
      const chunks = [];
      for (let i = 0; i < pagesToDetect.length; i += chunkSize) {
        chunks.push(pagesToDetect.slice(i, i + chunkSize));
      }
      let chunkCursor = 0;
      let doneCount = 0;

      async function detectPipeConsumer() {
        while (true) {
          if (state.abortRequested) throw new Error('ABORTED');
          const cIdx = chunkCursor++;
          if (cIdx >= chunks.length) return;
          const chunk = chunks[cIdx];
          chunk.forEach((p) => {
            p.status = 'detecting';
            updatePageCardInPlace(p);
          });
          setProgress(
            true,
            progressPrefix + ' via AnkiSuru Server (' + doneCount + '/' + pagesToDetect.length + ' pages)…',
            (doneCount / pagesToDetect.length) * 100
          );
          const batchBoxes = await nativeDetectBatch(chunk);
          chunk.forEach((p, idx) => {
            const raw = (batchBoxes[idx] && batchBoxes[idx].boxes) || [];
            const mapped = raw.map((b) => ({
              id: 'blk_' + Math.random().toString(36).slice(2, 9),
              x1: Math.round(b[0]),
              y1: Math.round(b[1]),
              x2: Math.round(b[2]),
              y2: Math.round(b[3]),
              conf: typeof b[4] === 'number' ? b[4] : 0.9,
              text: '',
              charConf: null
            }));
            p.blocks = sortBlocksByReadingOrder(mapped, state.readingOrder);
            p.boxesDetected = true;
            p.status = 'detected';
            p.fullText = '';
            totalBoxes += p.blocks.length;
            doneCount++;
            updatePageCardInPlace(p);
            if (state.selectedPageId === p.id) renderOverlayBoxes();
          });
          setProgress(
            true,
            progressPrefix + ' via AnkiSuru Server (' + doneCount + '/' + pagesToDetect.length + ' pages)…',
            (doneCount / pagesToDetect.length) * 100
          );
        }
      }

      // 2 concurrent HTTP chunks keep CPU decode & detector 100% saturated
      await Promise.all(chunks.length === 1 ? [detectPipeConsumer()] : [detectPipeConsumer(), detectPipeConsumer()]);
      return totalBoxes;
    } catch (nativeErr) {
      if (isAbortError(nativeErr)) throw new Error('ABORTED');
      state.nativeBackend.connected = false;
      updateAccelBadgeText();
      showToast('Native server disconnected; switched to Browser Multi-Worker Pool.', 'warn');
    }
  }

  // Fast Path 2: Browser Multi-Worker Parallel Pool (right-sized to page count so 1-page extraction initializes 1 worker instantly)
  if (state.detectorMode === 'ctd-onnx') {
    await ensureCtdPoolReady(pagesToDetect.length);
  } else {
    await ensureRtdetrPoolReady(pagesToDetect.length);
  }

  const poolConcurrency = Math.min(
    pagesToDetect.length,
    Math.max(1, runtime.workerSlots.length || getDesiredPoolSize('rtdetr'))
  );

  let cursor = 0;
  let completed = 0;

  async function workerConsumer() {
    while (true) {
      if (state.abortRequested) throw new Error('ABORTED');
      const idx = cursor++;
      if (idx >= pagesToDetect.length) return;
      const page = pagesToDetect[idx];
      page.status = 'detecting';
      updatePageCardInPlace(page);

      setProgress(
        true,
        progressPrefix + ' (' + completed + '/' + pagesToDetect.length + ' done · ' + poolConcurrency + ' parallel threads)…',
        (completed / pagesToDetect.length) * 100
      );

      const imgEl = await getFastDecodedPageImage(page);
      page.blocks = await detectBlocksForPage(imgEl);
      page.boxesDetected = true;
      page.status = 'detected';
      page.fullText = '';
      totalBoxes += page.blocks.length;
      completed++;

      setProgress(
        true,
        progressPrefix + ' (' + completed + '/' + pagesToDetect.length + ' done · ' + poolConcurrency + ' parallel threads)…',
        (completed / pagesToDetect.length) * 100
      );
      updatePageCardInPlace(page);
      if (state.selectedPageId === page.id) {
        renderOverlayBoxes();
        throttledRefreshRightPanel(false);
      }
    }
  }

  await Promise.all(Array.from({ length: poolConcurrency }, () => workerConsumer()));
  return totalBoxes;
}

async function detectBoxesForAllPages(targetPages) {
  if (state.isExtracting || targetPages.length === 0) return;
  state.abortRequested = false;
  setExtractingUI(true);
  await acquireBackgroundKeepAlive();
  const t0 = performance.now();

  try {
    const totalBoxesFound = await runParallelPagesDetectionInternal(targetPages, 'Detecting boxes');
    if (targetPages.length > 0 && !targetPages.some((p) => p.id === state.selectedPageId)) {
      state.selectedPageId = targetPages[0].id;
    }
    const cur = getSelectedPage();
    if (cur) {
      state.selectedBlockId = cur.blocks[0] ? cur.blocks[0].id : null;
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    setProgress(true, 'Detected ' + totalBoxesFound + ' boxes across ' + targetPages.length + ' page(s) in ' + elapsed + 's!', 100);
    showToast('Detected ' + totalBoxesFound + ' boxes across ' + targetPages.length + ' page(s) in ' + elapsed + 's!');
    setTimeout(() => {
      if (!state.isExtracting) setProgress(false);
    }, 2200);
  } catch (err) {
    if (err && err.message === 'ABORTED') {
      showToast('Box detection stopped.', 'warn');
    } else {
      showToast('Box detection error: ' + (err ? err.message : 'Unknown error'), 'error');
    }
    for (const p of targetPages) {
      if (p.status === 'detecting') p.status = 'pending';
    }
    setProgress(false);
  } finally {
    releaseBackgroundKeepAlive();
    setExtractingUI(false);
    renderAll();
  }
}

async function quickExtractSinglePage(page) {
  const target = page || getSelectedPage();
  if (!target) return;
  if (state.isExtracting) {
    showToast('Extraction already running…', 'warn');
    return;
  }
  if (state.isViewerFullscreen) {
    const pIdx = state.pages.findIndex((p) => p.id === target.id);
    showToast('Extracting page ' + (pIdx >= 0 ? pIdx + 1 : '') + '…');
  }
  await extractPagesQueue([target]);
}

async function extractPagesQueue(targetPages) {
  if (state.isExtracting || targetPages.length === 0) return;
  state.abortRequested = false;
  state.activeOcrBlockIds.clear();
  setExtractingUI(true);
  // Non-blocking keep-alive acquisition so inference starts at 0ms without awaiting AudioContext/WakeLock
  acquireBackgroundKeepAlive().catch(() => {});
  const t0 = performance.now();
  let totalExtractedBubbles = 0;
  let totalPrunedBoxes = 0;

  try {
    // Ultra-Fast Path A: Whole-Page Pipelined Server Extraction (ZERO JS image decode, ZERO JS canvas.toBlob cropping!)
    let handledByServerPipeline = false;
    if (state.nativeBackend.connected) {
      try {
        // Sort any already-detected boxes into reading order before sending coordinates to server
        for (const p of targetPages) {
          if (p.boxesDetected && p.blocks && p.blocks.length > 1) {
            p.blocks = sortBlocksByReadingOrder(p.blocks, state.readingOrder);
          }
        }

        const chunkSize = 8;
        const chunks = [];
        for (let i = 0; i < targetPages.length; i += chunkSize) {
          chunks.push(targetPages.slice(i, i + chunkSize));
        }

        let chunkCursor = 0;
        let donePages = 0;

        async function serverPipeConsumer() {
          while (true) {
            if (state.abortRequested) throw new Error('ABORTED');
            const cIdx = chunkCursor++;
            if (cIdx >= chunks.length) return;
            const chunk = chunks[cIdx];
            chunk.forEach((p) => {
              p.status = p.boxesDetected ? 'recognizing' : 'detecting';
              updatePageCardInPlace(p);
            });

            setProgress(
              true,
              'Native GPU Batched Pipeline: ' + donePages + '/' + targetPages.length + ' pages completed…',
              (donePages / targetPages.length) * 100
            );

            const respData = await nativeExtractPagesChunk(chunk);
            if (state.abortRequested) throw new Error('ABORTED');
            const outPages = respData.pages || [];

            chunk.forEach((p, idx) => {
              const resP = outPages[idx] || {};
              if (!p.boxesDetected) {
                const rawBoxes = resP.boxes || [];
                const mapped = rawBoxes.map((b, bIdx) => ({
                  id: 'blk_' + Math.random().toString(36).slice(2, 9),
                  x1: Math.round(b[0]),
                  y1: Math.round(b[1]),
                  x2: Math.round(b[2]),
                  y2: Math.round(b[3]),
                  conf: typeof b[4] === 'number' ? b[4] : 0.9,
                  text: (resP.texts && resP.texts[bIdx]) || '',
                  charConf: normalizeConf01(resP.confs ? resP.confs[bIdx] : null),
                  ocrAttempted: true,
                  verified: false
                }));
                p.blocks = sortBlocksByReadingOrder(mapped, state.readingOrder);
                p.boxesDetected = true;
              } else {
                const texts = resP.texts || [];
                const confs = resP.confs || [];
                if (Array.isArray(resP.kept_indices)) {
                  const prevBlocks = p.blocks || [];
                  const nextBlocks = [];
                  resP.kept_indices.forEach((origIdx, kIdx) => {
                    const blk = prevBlocks[origIdx];
                    if (!blk) return;
                    blk.text = texts[kIdx] !== undefined ? texts[kIdx] : '';
                    blk.charConf = normalizeConf01(confs[kIdx]);
                    blk.ocrAttempted = true;
                    blk.verified = false;
                    nextBlocks.push(blk);
                  });
                  p.blocks = nextBlocks;
                } else {
                  (p.blocks || []).forEach((blk, bIdx) => {
                    blk.text = texts[bIdx] !== undefined ? texts[bIdx] : (blk.text || '');
                    blk.charConf = confs[bIdx] !== undefined ? normalizeConf01(confs[bIdx]) : normalizeConf01(blk.charConf);
                    blk.ocrAttempted = true;
                    blk.verified = false;
                  });
                }
              }
              let pagePruned = typeof resP.pruned_count === 'number' ? resP.pruned_count : 0;
              if (state.autoPruneNonJp) {
                pagePruned += pruneNonJapaneseBlocksFromPage(p);
              }
              totalPrunedBoxes += pagePruned;
              p.status = 'done';
              p.ocrCompleted = true;
              totalExtractedBubbles += (p.blocks ? p.blocks.length : 0);
              updatePageFullText(p);
              updatePageCardInPlace(p);
              if (state.selectedPageId === p.id) {
                renderOverlayBoxes();
              }
              donePages++;
            });

            const pps = (donePages / Math.max(0.1, (performance.now() - t0) / 1000)).toFixed(1);
            setProgress(
              true,
              'Native GPU Batched Pipeline: ' + donePages + '/' + targetPages.length + ' pages (' + pps + ' pages/s)…',
              (donePages / targetPages.length) * 100
            );
            throttledRefreshRightPanel(false);
          }
        }

        // Single direct request for 1-page instant extraction; 2-way pipeline for multi-page volumes
        await Promise.all(chunks.length === 1 ? [serverPipeConsumer()] : [serverPipeConsumer(), serverPipeConsumer()]);
        handledByServerPipeline = true;
      } catch (srvErr) {
        if (isAbortError(srvErr)) throw new Error('ABORTED');
        state.nativeBackend.connected = false;
        updateAccelBadgeText();
        showToast('Native server pipeline unavailable (' + srvErr.message + '); falling back to Browser Workers.', 'warn');
      }
    }

    // Fallback Path B: Browser Multi-Worker Pool with Overlapped OCR Prefetch & Zero-Redundant-Decode Fast Path
    if (!handledByServerPipeline) {
      const undetected = targetPages.filter((p) => !p.boxesDetected && (!p.blocks || p.blocks.length === 0));
      // Overlap OCR model download/IDB read concurrently with Stage 1 box detection!
      const ocrPrefetchPromise = undetected.length > 0
        ? prefetchMangaOcrAssets().catch(() => null)
        : null;
      if (undetected.length > 0) {
        await runParallelPagesDetectionInternal(undetected, 'Stage 1/2: Detecting boxes');
      }
      if (ocrPrefetchPromise) {
        await ocrPrefetchPromise;
      }

      const totalBubblesAll = targetPages.reduce((acc, p) => acc + ((p.blocks && p.blocks.length) || 0), 0);
      if (totalBubblesAll > 0) {
        await ensureMangaOcrPoolReady(totalBubblesAll);
      }

      let doneBubblesGlobal = 0;
      const windowPages = 12;

      for (let wStart = 0; wStart < targetPages.length; wStart += windowPages) {
        if (state.abortRequested) throw new Error('ABORTED');
        const pageSlice = targetPages.slice(wStart, wStart + windowPages);
        const windowJobs = [];
        const remainingPerPage = new Map();

        // Decode only up to 12 images in parallel (reusing already-decoded activePageImage in 0ms for active page!)
        await Promise.all(pageSlice.map(async (page) => {
          if (page.blocks && page.blocks.length > 1) {
            page.blocks = sortBlocksByReadingOrder(page.blocks, state.readingOrder);
          }
          if (!page.blocks || page.blocks.length === 0) {
            page.status = 'done';
            updatePageFullText(page);
            updatePageCardInPlace(page);
            return;
          }
          page.status = 'recognizing';
          updatePageCardInPlace(page);
          remainingPerPage.set(page.id, page.blocks.length);
          const imgEl = await getFastDecodedPageImage(page);
          for (let bIdx = 0; bIdx < page.blocks.length; bIdx++) {
            windowJobs.push({ page, imgEl, blk: page.blocks[bIdx] });
          }
        }));

        if (windowJobs.length === 0) continue;

        const activeWorkerCount = Math.max(
          1,
          runtime.workerSlots.filter((s) => s.loaded.mocr).length || getDesiredPoolSize('mocr')
        );
        const concurrency = Math.min(windowJobs.length, activeWorkerCount);
        let jobCursor = 0;

        async function bubbleConsumer() {
          while (true) {
            if (state.abortRequested) throw new Error('ABORTED');
            const jIdx = jobCursor++;
            if (jIdx >= windowJobs.length) return;
            const job = windowJobs[jIdx];

            state.activeOcrBlockIds.add(job.blk.id);
            if (state.selectedPageId === job.page.id) renderOverlayBoxes();

            const res = await recognizeSingleBlock(job.imgEl, job.blk);
            state.activeOcrBlockIds.delete(job.blk.id);
            job.blk.text = res.text;
            job.blk.charConf = normalizeConf01(res.charConf);
            job.blk.ocrAttempted = true;
            job.blk.verified = false;
            updatePageFullText(job.page);

            const left = (remainingPerPage.get(job.page.id) || 1) - 1;
            remainingPerPage.set(job.page.id, left);
            if (left <= 0) {
              if (state.autoPruneNonJp) {
                const prunedHere = pruneNonJapaneseBlocksFromPage(job.page);
                totalPrunedBoxes += prunedHere;
                totalExtractedBubbles = Math.max(0, totalExtractedBubbles - prunedHere);
              }
              job.page.status = 'done';
              job.page.ocrCompleted = true;
            }

            doneBubblesGlobal++;
            totalExtractedBubbles++;
            setProgress(
              true,
              'Recognizing Japanese (' + doneBubblesGlobal + '/' + Math.max(1, totalBubblesAll) + ' bubbles · ' + concurrency + ' parallel workers)…',
              (doneBubblesGlobal / Math.max(1, totalBubblesAll)) * 100
            );

            updatePageCardInPlace(job.page);
            if (state.selectedPageId === job.page.id) renderOverlayBoxes();
            throttledRefreshRightPanel(false);
          }
        }

        await Promise.all(Array.from({ length: concurrency }, () => bubbleConsumer()));
      }
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    const finalKeptBubbles = targetPages.reduce((acc, p) => acc + ((p.blocks && p.blocks.length) || 0), 0);
    const lowReviewTotal = targetPages.reduce((acc, p) => acc + countPageReviewBlocks(p), 0);
    const prunedSuffix = totalPrunedBoxes > 0 ? (' · auto-removed ' + totalPrunedBoxes + ' non-JP/false box(es)') : '';
    const reviewSuffix = lowReviewTotal > 0 ? (' · ' + lowReviewTotal + ' <90% for review') : '';
    const summaryMsg = 'Extracted ' + finalKeptBubbles + ' JP bubbles in ' + elapsed + 's' + prunedSuffix + reviewSuffix + '!';
    setProgress(true, summaryMsg, 100);
    showToast(summaryMsg, lowReviewTotal > 0 ? 'warn' : undefined);
    setTimeout(() => {
      if (!state.isExtracting) setProgress(false);
    }, 2200);
  } catch (err) {
    if (err && err.message === 'ABORTED') {
      showToast('Extraction stopped.', 'warn');
    } else {
      showToast('OCR error: ' + (err ? err.message : 'Unknown error'), 'error');
    }
    for (const p of targetPages) {
      if (p.status === 'detecting' || p.status === 'recognizing') {
        p.status = p.boxesDetected ? 'detected' : 'pending';
      }
    }
    setProgress(false);
  } finally {
    releaseBackgroundKeepAlive();
    state.activeOcrBlockIds.clear();
    setExtractingUI(false);
    renderAll();
  }
}

function updatePageFullText(page) {
  const lines = (page.blocks || [])
    .map((b) => (b.text || '').trim())
    .filter((t) => t.length > 0);
  page.fullText = lines.join('\n');
}

