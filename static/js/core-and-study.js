"use strict";


// Configure ONNX Runtime Web for sandboxed iframe safety (no cross-origin SharedArrayBuffer worker needed)
if (window.ort && window.ort.env && window.ort.env.wasm) {
  window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';
  window.ort.env.wasm.numThreads = 1;
  window.ort.env.wasm.proxy = false;
}

// Verified Hugging Face ONNX & Vocab URLs
const LOW_CONF_THRESHOLD = 0.90;

const MODEL_URLS = {
  mocrCptEncoder: 'https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/encoder_model_quantized.onnx',
  mocrCptEncoderAlt: 'https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/encoder_model_q8.onnx',
  mocrCptDecoder: 'https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/decoder_model_merged_quantized.onnx',
  mocrCptDecoderAlt: 'https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/onnx/decoder_model_merged_q8.onnx',
  mocrCptVocab: 'https://huggingface.co/Quien1/manga-ocr-base-CPT-v2-ONNX/resolve/main/vocab.txt',
  mocrEncoder: 'https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/encoder_model_quantized.onnx',
  mocrDecoder: 'https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/decoder_model_merged_quantized.onnx',
  mocrVocab: 'https://huggingface.co/kha-white/manga-ocr-base/resolve/main/vocab.txt',
  rtdetrInt8Primary: 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx',
  rtdetrInt8Mirror: 'https://huggingface.co/Sundowner123/comic-text-and-bubble-detector/resolve/main/detector.onnx',
  ctdOnnx: 'https://huggingface.co/HighLiuk/japanese-onnx-models/resolve/main/comictextdetector.onnx'
};

function isMangaOcrFamily(engineName) {
  return engineName === 'manga-ocr-cpt' || engineName === 'manga-ocr';
}

function isBlockBelowReviewThreshold(blk, page) {
  if (!blk || blk.verified) return false;
  const hasTxt = Boolean((blk.text || '').trim());
  if (hasTxt && typeof blk.charConf === 'number') {
    return blk.charConf < LOW_CONF_THRESHOLD;
  }
  if (page && page.status === 'done' && !hasTxt) {
    return true;
  }
  return false;
}

function countPageReviewBlocks(page) {
  if (!page || !Array.isArray(page.blocks)) return 0;
  return page.blocks.filter((b) => isBlockBelowReviewThreshold(b, page)).length;
}

function countVolumeReviewBlocks() {
  return state.pages.reduce((acc, p) => acc + countPageReviewBlocks(p), 0);
}

const JP_HIRAGANA_RE = /[\u3041-\u3096\u309D-\u309F]/g;
const JP_KATAKANA_RE = /[\u30A1-\u30FA\u30FD-\u30FF]/g;
const JP_KANJI_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005]/g;
const LATIN_ALPHA_RE = /[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]/g;
const STROKE_ARTIFACT_ONLY_RE = /^[一二三川十口日ノハソンリヘくしつっー｜丨・/\\+=\-_.,…！？!?0-9０-９]+$/;

function isValidJapaneseMangaResult(text, conf) {
  const s = String(text || '').trim();
  if (!s) return false;

  const hira = (s.match(JP_HIRAGANA_RE) || []).length;
  const kata = (s.match(JP_KATAKANA_RE) || []).length;
  const kanji = (s.match(JP_KANJI_RE) || []).length;
  const jpCore = hira + kata + kanji;
  const latin = (s.match(LATIN_ALPHA_RE) || []).length;
  const numConf = typeof conf === 'number' ? conf : 0.85;

  // 1. Must contain at least 1 real Japanese character (drops English, digits, icons, '！？', '…')
  if (jpCore === 0) return false;

  // 2. Drop full/predominant English text even if 1-2 stylized letters misread as katakana
  if (latin >= 4 && latin > jpCore * 1.5) return false;
  if (latin >= 2 && hira === 0 && latin >= jpCore && numConf < 0.86) return false;

  // 3. Drop low-confidence hallucinations from drawings, icons, or empty space
  if (numConf < 0.52) return false;

  // 4. Drop simple geometric stroke-artifact hallucinations ('一', '川', 'ノ', '口') from line art
  if (jpCore <= 2 && STROKE_ARTIFACT_ONLY_RE.test(s) && numConf < 0.86) return false;

  // 5. Drop single-char low-confidence icon/art misreads
  if (jpCore === 1 && s.length <= 2 && numConf < 0.72) return false;

  return true;
}

function filterVisuallyPlausibleBoxesOnImage(imgEl, boxes) {
  if (!imgEl || !Array.isArray(boxes) || boxes.length === 0) return boxes || [];
  const origW = imgEl.naturalWidth || imgEl.width;
  const origH = imgEl.naturalHeight || imgEl.height;
  if (!origW || !origH) return boxes;

  const S = 64;
  const cvs = document.createElement('canvas');
  cvs.width = S;
  cvs.height = S;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });

  return boxes.filter((b) => {
    const bw = b.x2 - b.x1;
    const bh = b.y2 - b.y1;
    if (bw < 14 || bh < 14) return false;
    const aspect = Math.max(bw / Math.max(1, bh), bh / Math.max(1, bw));
    if (aspect > 22) return false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(imgEl, b.x1, b.y1, bw, bh, 0, 0, S, S);
    const rgba = ctx.getImageData(0, 0, S, S).data;
    const N = S * S;
    const lum = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const p = i * 4;
      const g = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      lum[i] = g;
      sum += g;
    }
    const mean = sum / N;
    let varSum = 0;
    for (let i = 0; i < N; i++) {
      const d = lum[i] - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / N);
    if (std < 8.5) return false;

    const sorted = Float32Array.from(lum).sort();
    const p05 = sorted[Math.floor(N * 0.05)];
    const p95 = sorted[Math.floor(N * 0.95)];
    if (p95 - p05 < 42) return false;

    const mid = 0.5 * (p05 + p95);
    let darkCnt = 0;
    for (let i = 0; i < N; i++) {
      if (lum[i] < mid) darkCnt++;
    }
    const darkRatio = darkCnt / N;
    if (darkRatio < 0.008 || darkRatio > 0.82) return false;
    return true;
  });
}

function pruneNonJapaneseBlocksFromPage(page) {
  if (!page || !Array.isArray(page.blocks)) return 0;
  const before = page.blocks.length;
  page.blocks = page.blocks.filter((blk) => {
    if (blk.isManual || blk.verified) return true;
    return isValidJapaneseMangaResult(blk.text, blk.charConf);
  });
  const removed = before - page.blocks.length;
  if (removed > 0) {
    if (state.selectedBlockId && !page.blocks.some((b) => b.id === state.selectedBlockId)) {
      state.selectedBlockId = null;
    }
    updatePageFullText(page);
  }
  return removed;
}

const IMAGE_EXT_RE = /\.(jpe?g|jfif|pjpeg|pjp|png|webp|avif|bmp|gif)$/i;
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const HW_CORES = Math.max(2, Number(navigator.hardwareConcurrency) || 4);
const DEFAULT_DET_WORKERS = Math.min(6, Math.max(2, Math.floor(HW_CORES * 0.75)));
const DEFAULT_OCR_WORKERS = Math.min(4, Math.max(2, Math.floor(HW_CORES * 0.5)));

// Application State
const state = {
  pages: [],
  selectedPageId: null,
  selectedBlockId: null,
  activeOcrBlockIds: new Set(),
  isSampleSet: false,
  detectorMode: 'rtdetr-int8',
  ocrEngine: 'manga-ocr-cpt',
  autoPruneNonJp: true,
  filterLowConfOnly: false,
  readingOrder: 'rtl',
  workerPoolSetting: 'auto', // 'auto' | '1'..'8'
  nativeBackend: {
    url: (window.location && window.location.protocol && window.location.protocol.startsWith('http') && window.location.port === '7860')
      ? window.location.origin
      : 'http://127.0.0.1:7860',
    connected: false,
    info: null
  },
  showBoxes: true,
  liveTextMode: false,
  livePopupBlockId: null,
  showPopupRomaji: true,
  isViewerFullscreen: false,
  preFsShowBoxes: true,
  drawMode: false,
  zoom: 1.0,
  fitMode: true,
  activeTab: 'all', // 'all' | 'bubbles'
  includeHeaders: true,
  jpFontSize: 16,
  isExtracting: false,
  abortRequested: false,
  gemini: {
    apiKey: '',
    model: 'auto',
    resolvedAutoModel: null,
    activeTasks: new Map(), // blockId -> 'translate' | 'breakdown'
    isTranslatingPage: false
  }
};

// Multi-Worker Parallel Pool & Cached ML Runtimes
const runtime = {
  buffers: {},
  mocrVocabs: {},
  mocrVocabPromises: {},
  activeMocrVariant: null,
  bufferPromises: {},
  workerFlavor: null, // 'module' | 'classic' | 'none'
  workerSlots: [],
  slotWaiters: [],
  workerReqSeq: 0,
  mainFallbackSessions: { rtdetr: null, ctd: null, mocrEnc: null, mocrDec: null },
  hasWebGpu: false,
  tesseractScheduler: null,
  tesseractWorkers: [],
  activeFetchControllers: new Set()
};

// DOM Elements
const el = {
  titleBanner: document.getElementById('titleBanner'),
  accelStatusBadge: document.getElementById('accelStatusBadge'),
  folderInput: document.getElementById('folderInput'),
  filesInput: document.getElementById('filesInput'),
  btnToggleSettings: document.getElementById('btnToggleSettings'),
  themeToggleCapsule: document.getElementById('themeToggleCapsule'),
  btnThemeLight: document.getElementById('btnThemeLight'),
  btnThemeDark: document.getElementById('btnThemeDark'),
  iconLightFilled: document.getElementById('iconLightFilled'),
  iconLightOutlined: document.getElementById('iconLightOutlined'),
  iconDarkFilled: document.getElementById('iconDarkFilled'),
  iconDarkOutlined: document.getElementById('iconDarkOutlined'),
  settingsSummaryChip: document.getElementById('settingsSummaryChip'),
  settingsPopover: document.getElementById('settingsPopover'),
  btnCloseSettings: document.getElementById('btnCloseSettings'),
  btnOpenStackModal: document.getElementById('btnOpenStackModal'),
  btnCloseStackModal: document.getElementById('btnCloseStackModal'),
  btnCloseStackModalBottom: document.getElementById('btnCloseStackModalBottom'),
  stackModal: document.getElementById('stackModal'),
  btnCopyCliCmd: document.getElementById('btnCopyCliCmd'),
  cliCommandBlock: document.getElementById('cliCommandBlock'),
  selectDetector: document.getElementById('selectDetector'),
  selectOcrEngine: document.getElementById('selectOcrEngine'),
  selectReadingOrder: document.getElementById('selectReadingOrder'),
  selectWorkerPoolSize: document.getElementById('selectWorkerPoolSize'),
  helperDetector: document.getElementById('helperDetector'),
  helperOcrEngine: document.getElementById('helperOcrEngine'),
  helperReadingOrder: document.getElementById('helperReadingOrder'),
  helperWorkerPool: document.getElementById('helperWorkerPool'),
  chkAutoPruneNonJp: document.getElementById('chkAutoPruneNonJp'),
  inputBackendUrl: document.getElementById('inputBackendUrl'),
  btnConnectBackend: document.getElementById('btnConnectBackend'),
  backendStatusText: document.getElementById('backendStatusText'),
  inputGeminiApiKey: document.getElementById('inputGeminiApiKey'),
  btnToggleGeminiKeyVis: document.getElementById('btnToggleGeminiKeyVis'),
  selectGeminiModel: document.getElementById('selectGeminiModel'),
  btnSaveGeminiKey: document.getElementById('btnSaveGeminiKey'),
  btnTestGeminiKey: document.getElementById('btnTestGeminiKey'),
  btnClearGeminiKey: document.getElementById('btnClearGeminiKey'),
  geminiKeyStatusText: document.getElementById('geminiKeyStatusText'),
  btnDetectAllBoxes: document.getElementById('btnDetectAllBoxes'),
  detectAllBoxesLabel: document.getElementById('detectAllBoxesLabel'),
  btnExtractPage: document.getElementById('btnExtractPage'),
  btnExtractAll: document.getElementById('btnExtractAll'),
  extractAllLabel: document.getElementById('extractAllLabel'),
  btnStopExtract: document.getElementById('btnStopExtract'),
  progressContainer: document.getElementById('progressContainer'),
  progressStatusText: document.getElementById('progressStatusText'),
  progressPercentText: document.getElementById('progressPercentText'),
  progressBarFill: document.getElementById('progressBarFill'),
  dropZoneRoot: document.getElementById('dropZoneRoot'),
  dragOverlay: document.getElementById('dragOverlay'),
  pagesSummaryCount: document.getElementById('pagesSummaryCount'),
  btnSidebarSamples: document.getElementById('btnSidebarSamples'),
  btnClearPages: document.getElementById('btnClearPages'),
  sidebarDropTarget: document.getElementById('sidebarDropTarget'),
  btnDropzoneFolder: document.getElementById('btnDropzoneFolder'),
  sampleNoticeBanner: document.getElementById('sampleNoticeBanner'),
  pageListContainer: document.getElementById('pageListContainer'),
  btnPrevPage: document.getElementById('btnPrevPage'),
  btnNextPage: document.getElementById('btnNextPage'),
  activePageTitle: document.getElementById('activePageTitle'),
  btnSelectTextMode: document.getElementById('btnSelectTextMode'),
  btnToggleBoxes: document.getElementById('btnToggleBoxes'),
  iconBoxesOn: document.getElementById('iconBoxesOn'),
  iconBoxesOff: document.getElementById('iconBoxesOff'),
  toggleBoxesSr: document.getElementById('toggleBoxesSr'),
  btnDrawBoxMode: document.getElementById('btnDrawBoxMode'),
  btnDeleteSelectedBox: document.getElementById('btnDeleteSelectedBox'),
  btnRedetectPage: document.getElementById('btnRedetectPage'),
  viewerSection: document.getElementById('viewerSection'),
  btnZoomOut: document.getElementById('btnZoomOut'),
  btnZoomFit: document.getElementById('btnZoomFit'),
  btnZoomIn: document.getElementById('btnZoomIn'),
  btnToggleFullscreen: document.getElementById('btnToggleFullscreen'),
  fsFloatingHud: document.getElementById('fsFloatingHud'),
  btnFsPrevPage: document.getElementById('btnFsPrevPage'),
  fsPageCounter: document.getElementById('fsPageCounter'),
  btnFsNextPage: document.getElementById('btnFsNextPage'),
  btnFsSelectText: document.getElementById('btnFsSelectText'),
  btnExitFullscreen: document.getElementById('btnExitFullscreen'),
  drawModeBanner: document.getElementById('drawModeBanner'),
  btnExitDrawMode: document.getElementById('btnExitDrawMode'),
  liveTextBanner: document.getElementById('liveTextBanner'),
  liveBannerStatusText: document.getElementById('liveBannerStatusText'),
  btnCopySelectedLiveText: document.getElementById('btnCopySelectedLiveText'),
  btnExitLiveTextMode: document.getElementById('btnExitLiveTextMode'),
  liveSelectionCard: document.getElementById('liveSelectionCard'),
  liveSelMetaLabel: document.getElementById('liveSelMetaLabel'),
  btnTogglePopupRomaji: document.getElementById('btnTogglePopupRomaji'),
  btnSelectWholeBubble: document.getElementById('btnSelectWholeBubble'),
  liveSelectionCopyChip: document.getElementById('liveSelectionCopyChip'),
  btnClearLiveSelection: document.getElementById('btnClearLiveSelection'),
  liveSelPreviewBody: document.getElementById('liveSelPreviewBody'),
  liveSelRomajiWrap: document.getElementById('liveSelRomajiWrap'),
  liveSelRomajiLabel: document.getElementById('liveSelRomajiLabel'),
  btnCopyPopupRomaji: document.getElementById('btnCopyPopupRomaji'),
  liveSelRomajiBody: document.getElementById('liveSelRomajiBody'),
  viewerViewport: document.getElementById('viewerViewport'),
  btnSideNavPrev: document.getElementById('btnSideNavPrev'),
  btnSideNavNext: document.getElementById('btnSideNavNext'),
  slideGestureHint: document.getElementById('slideGestureHint'),
  readerScrubberBar: document.getElementById('readerScrubberBar'),
  scrubberPageCounter: document.getElementById('scrubberPageCounter'),
  pageScrubberRange: document.getElementById('pageScrubberRange'),
  emptyViewerState: document.getElementById('emptyViewerState'),
  btnEmptyUploadFolder: document.getElementById('btnEmptyUploadFolder'),
  btnEmptyUploadFiles: document.getElementById('btnEmptyUploadFiles'),
  btnEmptyLoadSamples: document.getElementById('btnEmptyLoadSamples'),
  stageImageWrapper: document.getElementById('stageImageWrapper'),
  activePageImage: document.getElementById('activePageImage'),
  bboxOverlayLayer: document.getElementById('bboxOverlayLayer'),
  rubberBandBox: document.getElementById('rubberBandBox'),
  tabBtnAllText: document.getElementById('tabBtnAllText'),
  tabBtnPageBubbles: document.getElementById('tabBtnPageBubbles'),
  currentBubbleCountBadge: document.getElementById('currentBubbleCountBadge'),
  lowConfTabBadge: document.getElementById('lowConfTabBadge'),
  btnCopyAllText: document.getElementById('btnCopyAllText'),
  btnDownloadTxt: document.getElementById('btnDownloadTxt'),
  btnDownloadJson: document.getElementById('btnDownloadJson'),
  chkIncludeHeaders: document.getElementById('chkIncludeHeaders'),
  totalCharsStat: document.getElementById('totalCharsStat'),
  btnFontSmaller: document.getElementById('btnFontSmaller'),
  btnFontLarger: document.getElementById('btnFontLarger'),
  panelAllText: document.getElementById('panelAllText'),
  fullMangaTextarea: document.getElementById('fullMangaTextarea'),
  panelPageBubbles: document.getElementById('panelPageBubbles'),
  toastContainer: document.getElementById('toastContainer')
};

// -----------------------------------------------------------------------
// Utility Helpers: Toasts, Clipboard, Progress, IndexedDB Weight Cache
// -----------------------------------------------------------------------
function showToast(message, kind) {
  const toast = document.createElement('div');
  const bg = kind === 'error'
    ? 'bg-rose-600 text-white'
    : kind === 'warn'
    ? 'bg-amber-600 text-white'
    : 'bg-slate-900 text-white';
  toast.className = 'pointer-events-auto px-3.5 py-2.5 rounded shadow-md text-xs font-medium transition-opacity duration-300 max-w-xs ' + bg;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

async function copyTextSafe(text, label) {
  if (!text) {
    showToast('No Japanese text extracted yet to copy.', 'warn');
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(label || 'Copied Japanese text to clipboard!');
      return;
    }
  } catch (_err) {
    // Fallback for sandboxed iframes
  }
  const temp = document.createElement('textarea');
  temp.value = text;
  temp.style.position = 'fixed';
  temp.style.opacity = '0';
  document.body.appendChild(temp);
  temp.focus();
  temp.select();
  try {
    document.execCommand('copy');
    showToast(label || 'Copied Japanese text to clipboard!');
  } catch (_e) {
    showToast('Copy failed — select and press Ctrl+C.', 'error');
  }
  temp.remove();
}

function setProgress(visible, message, pct) {
  if (!visible) {
    el.progressContainer.classList.add('hidden');
    return;
  }
  el.progressContainer.classList.remove('hidden');
  if (message !== undefined) el.progressStatusText.textContent = message;
  if (pct !== undefined) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    el.progressPercentText.textContent = clamped + '%';
    el.progressBarFill.style.width = clamped + '%';
  }
}

// IndexedDB caching for ONNX weights (wrapped safely in try/catch for iframe sandboxes)
function openModelCacheDB() {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) return resolve(null);
      const req = window.indexedDB.open('mokuro_web_onnx_cache_v1', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_e) {
      resolve(null);
    }
  });
}

async function idbGet(key) {
  const db = await openModelCacheDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('blobs', 'readonly');
      const req = tx.objectStore('blobs').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (_e) {
      resolve(null);
    }
  });
}

async function idbPut(key, val) {
  const db = await openModelCacheDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch (_e) {
      resolve();
    }
  });
}

async function idbDelete(key) {
  const db = await openModelCacheDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch (_e) {
      resolve();
    }
  });
}

// -----------------------------------------------------------------------
// Gemini API Key Local Persistence & Manga Japanese Study Engine
// -----------------------------------------------------------------------
const GEMINI_STORAGE_KEY = 'mokuro_gemini_config_v1';
const GEMINI_FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];
const inMemoryStudyCache = new Map();

function hashStudyText(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '_' + str.length;
}

function maskApiKey(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 10) return '••••' + trimmed.slice(-3);
  return trimmed.slice(0, 4) + '••••' + trimmed.slice(-4);
}

function updateGeminiSettingsStatusUI(customNote, isError) {
  const hasKey = Boolean((state.gemini.apiKey || '').trim());
  if (customNote) {
    el.geminiKeyStatusText.textContent = customNote;
    el.geminiKeyStatusText.className = 'font-medium ' + (isError ? 'text-rose-600' : 'text-emerald-700');
  } else if (hasKey) {
    const modelLabel = state.gemini.model === 'auto'
      ? (state.gemini.resolvedAutoModel ? 'Auto -> ' + state.gemini.resolvedAutoModel : 'Auto Flash')
      : state.gemini.model;
    el.geminiKeyStatusText.textContent =
      'Saved locally (' + maskApiKey(state.gemini.apiKey) + ' · ' + modelLabel + ')';
    el.geminiKeyStatusText.className = 'font-medium text-emerald-700';
  } else {
    el.geminiKeyStatusText.textContent = 'Not saved · Stored locally in browser only';
    el.geminiKeyStatusText.className = 'font-medium text-slate-500';
  }
  updateSettingsSummaryChip();
}

async function loadSavedGeminiConfig() {
  let loaded = null;
  try {
    const raw = window.localStorage ? window.localStorage.getItem(GEMINI_STORAGE_KEY) : null;
    if (raw) loaded = JSON.parse(raw);
  } catch (_e) {
    // Ignore sandboxed localStorage restriction; fall back to IndexedDB
  }
  if (!loaded || typeof loaded !== 'object') {
    try {
      const idbVal = await idbGet(GEMINI_STORAGE_KEY);
      if (idbVal && typeof idbVal === 'object') loaded = idbVal;
    } catch (_e2) {
      // Ignore
    }
  }
  if (loaded && typeof loaded === 'object') {
    state.gemini.apiKey = typeof loaded.apiKey === 'string' ? loaded.apiKey.trim() : '';
    state.gemini.model = typeof loaded.model === 'string' && loaded.model ? loaded.model : 'auto';
    el.inputGeminiApiKey.value = state.gemini.apiKey;
    if (Array.from(el.selectGeminiModel.options).some((o) => o.value === state.gemini.model)) {
      el.selectGeminiModel.value = state.gemini.model;
    }
  }
  updateGeminiSettingsStatusUI();
  if (state.activeTab === 'bubbles') {
    renderRightPanel();
  }
}

async function saveGeminiConfig(apiKey, model) {
  const cleanKey = (apiKey || '').trim();
  const cleanModel = model || 'auto';
  state.gemini.apiKey = cleanKey;
  state.gemini.model = cleanModel;
  state.gemini.resolvedAutoModel = null;

  const record = { apiKey: cleanKey, model: cleanModel, updatedAt: Date.now() };
  try {
    if (window.localStorage) {
      if (cleanKey) {
        window.localStorage.setItem(GEMINI_STORAGE_KEY, JSON.stringify(record));
      } else {
        window.localStorage.removeItem(GEMINI_STORAGE_KEY);
      }
    }
  } catch (_e) {
    // Sandboxed iframe fallback handled by IndexedDB below
  }
  if (cleanKey) {
    await idbPut(GEMINI_STORAGE_KEY, record);
  } else {
    await idbDelete(GEMINI_STORAGE_KEY);
  }
  updateGeminiSettingsStatusUI();
  if (state.activeTab === 'bubbles') {
    renderRightPanel();
  }
}

function promptForGeminiKeyInSettings() {
  suppressOutsideSettingsCloseUntil = performance.now() + 250;
  setSettingsOpen(true);
  setTimeout(() => {
    if (el.inputGeminiApiKey) el.inputGeminiApiKey.focus();
  }, 40);
  showToast('Paste and save your Gemini API key in Settings first.', 'warn');
}

async function discoverBestGeminiModel(apiKey) {
  const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey }
  });
  if (!resp.ok) {
    let errDetail = 'HTTP ' + resp.status;
    try {
      const j = await resp.json();
      if (j && j.error && j.error.message) errDetail = j.error.message;
    } catch (_e) { /* ignore */ }
    throw new Error(errDetail);
  }
  const data = await resp.json();
  const models = Array.isArray(data && data.models) ? data.models : [];
  const usable = models
    .filter((m) => {
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) return false;
      const id = String(m.name || '').replace(/^models\//, '').toLowerCase();
      if (!id.startsWith('gemini-')) return false;
      if (id.includes('tts') || id.includes('image') || id.includes('embedding') || id.includes('audio') || id.includes('live') || id.includes('veo')) {
        return false;
      }
      return true;
    })
    .map((m) => String(m.name || '').replace(/^models\//, ''));

  for (const preferred of GEMINI_FALLBACK_MODELS) {
    if (usable.includes(preferred)) return preferred;
  }
  const flashCandidate = usable.find((id) => id.includes('flash'));
  if (flashCandidate) return flashCandidate;
  if (usable.length > 0) return usable[0];
  throw new Error('No generateContent text model available for this API key.');
}

function parseGeminiJsonText(rawText) {
  const trimmed = String(rawText || '').trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(unfenced);
}

async function invokeGeminiModelJson(apiKey, modelId, systemPrompt, userPrompt, schema) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelId) + ':generateContent';
  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    let errMsg = 'HTTP ' + resp.status;
    try {
      const errJson = await resp.json();
      if (errJson && errJson.error && errJson.error.message) {
        errMsg = errJson.error.message;
      }
    } catch (_e) { /* ignore */ }
    const err = new Error(errMsg);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  const textPart = parts.find((p) => typeof p.text === 'string' && p.text.trim().length > 0);
  if (!textPart) {
    throw new Error('Gemini returned an empty response.');
  }
  return parseGeminiJsonText(textPart.text);
}

async function callGeminiStructuredJson(systemPrompt, userPrompt, schema) {
  // Also check unsaved key typed into input box so users don't get stuck if they forgot to press Save
  let apiKey = (state.gemini.apiKey || '').trim();
  if (!apiKey && el.inputGeminiApiKey && el.inputGeminiApiKey.value.trim()) {
    await saveGeminiConfig(el.inputGeminiApiKey.value.trim(), el.selectGeminiModel.value);
    apiKey = state.gemini.apiKey;
  }
  if (!apiKey) {
    promptForGeminiKeyInSettings();
    const noKeyErr = new Error('NO_API_KEY');
    throw noKeyErr;
  }

  const chosen = state.gemini.model || 'auto';
  const candidates = [];
  if (chosen === 'auto') {
    if (state.gemini.resolvedAutoModel) {
      candidates.push(state.gemini.resolvedAutoModel);
    }
    for (const m of GEMINI_FALLBACK_MODELS) {
      if (!candidates.includes(m)) candidates.push(m);
    }
  } else {
    candidates.push(chosen);
  }

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const modelId = candidates[i];
    try {
      const parsed = await invokeGeminiModelJson(apiKey, modelId, systemPrompt, userPrompt, schema);
      if (chosen === 'auto' && state.gemini.resolvedAutoModel !== modelId) {
        state.gemini.resolvedAutoModel = modelId;
        updateGeminiSettingsStatusUI();
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      // On 404 / model-not-found, query ListModels once to discover the user's active Flash model
      if (err && (err.status === 404 || /not found|not supported/i.test(err.message || ''))) {
        try {
          const discovered = await discoverBestGeminiModel(apiKey);
          if (discovered && !candidates.includes(discovered)) {
            const parsed = await invokeGeminiModelJson(apiKey, discovered, systemPrompt, userPrompt, schema);
            state.gemini.resolvedAutoModel = discovered;
            updateGeminiSettingsStatusUI('Saved locally (' + maskApiKey(apiKey) + ' · ' + discovered + ')');
            return parsed;
          }
        } catch (_discErr) {
          // Continue through remaining fallback models
        }
        if (chosen === 'auto') continue;
      }
      break;
    }
  }
  throw lastErr || new Error('Gemini API request failed.');
}

async function getCachedBubbleStudy(jpText) {
  const norm = (jpText || '').trim();
  if (!norm) return null;
  const key = 'gemini_study_v1_' + hashStudyText(norm);
  if (inMemoryStudyCache.has(key)) return inMemoryStudyCache.get(key);
  const stored = await idbGet(key);
  if (stored && stored.sourceText === norm) {
    inMemoryStudyCache.set(key, stored);
    return stored;
  }
  return null;
}

async function putCachedBubbleStudy(jpText, studyObj) {
  const norm = (jpText || '').trim();
  if (!norm || !studyObj) return;
  const key = 'gemini_study_v1_' + hashStudyText(norm);
  const payload = {
    sourceText: norm,
    romaji: studyObj.romaji || '',
    english: studyObj.english || '',
    nuance: studyObj.nuance || '',
    breakdown: studyObj.breakdown || null,
    updatedAt: Date.now()
  };
  inMemoryStudyCache.set(key, payload);
  await idbPut(key, payload);
}

function buildPageDialogueContext(page, targetBlkId) {
  if (!page || !Array.isArray(page.blocks)) return '';
  const lines = [];
  page.blocks.forEach((b, i) => {
    const t = (b.text || '').trim();
    if (!t) return;
    const marker = b.id === targetBlkId ? ' [TARGET BUBBLE]' : '';
    lines.push('#' + (i + 1) + marker + ': ' + t);
  });
  return lines.join('\n');
}

const TRANSLATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    romaji: { type: 'STRING', description: 'Natural Hepburn romaji with word spacing and long vowels for the target Japanese manga speech bubble.' },
    english: { type: 'STRING', description: 'Natural, context-aware English manga dialogue translation.' },
    nuance: { type: 'STRING', description: 'Brief 1-line note on speaker tone, politeness/slang, or implied subject (empty string if straightforward).' }
  },
  required: ['romaji', 'english', 'nuance']
};

const BREAKDOWN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    romaji: { type: 'STRING', description: 'Natural Hepburn romaji with word spacing.' },
    english: { type: 'STRING', description: 'Natural English translation in manga context.' },
    nuance: { type: 'STRING', description: 'Brief tone/register note.' },
    vocab: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          surface: { type: 'STRING', description: 'Exact word or morpheme as it appears in the bubble.' },
          reading: { type: 'STRING', description: 'Hiragana reading.' },
          romaji: { type: 'STRING', description: 'Hepburn romaji for this word.' },
          dictForm: { type: 'STRING', description: 'Dictionary base form (leave same as surface if unchanged).' },
          pos: { type: 'STRING', description: 'Concise part of speech + JLPT hint if applicable, e.g. Potential Verb · N4, Particle, Slang.' },
          meaning: { type: 'STRING', description: 'Clear English meaning in this context.' }
        },
        required: ['surface', 'reading', 'romaji', 'dictForm', 'pos', 'meaning']
      }
    },
    grammar: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          pattern: { type: 'STRING', description: 'Grammar point, conjugation, contraction, or sentence-ending particle used.' },
          level: { type: 'STRING', description: 'Level or register tag, e.g. N5, N4, Casual, Masculine/Feminine.' },
          explanation: { type: 'STRING', description: 'Clear learner-friendly explanation of how it works here.' }
        },
        required: ['pattern', 'level', 'explanation']
      }
    }
  },
  required: ['romaji', 'english', 'nuance', 'vocab', 'grammar']
};

const PAGE_BATCH_TRANSLATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bubbleNumber: { type: 'INTEGER' },
          romaji: { type: 'STRING' },
          english: { type: 'STRING' },
          nuance: { type: 'STRING' }
        },
        required: ['bubbleNumber', 'romaji', 'english', 'nuance']
      }
    }
  },
  required: ['items']
};

async function requestBubbleTranslation(page, blk, forceRefresh) {
  const jp = (blk && blk.text ? blk.text : '').trim();
  if (!jp) {
    showToast('Extract Japanese text for this bubble first.', 'warn');
    return;
  }
  if (state.gemini.activeTasks.has(blk.id)) return;

  if (!forceRefresh) {
    const cached = await getCachedBubbleStudy(jp);
    if (cached && cached.english && cached.romaji) {
      blk.study = {
        sourceText: jp,
        romaji: cached.romaji,
        english: cached.english,
        nuance: cached.nuance || '',
        breakdown: (blk.study && blk.study.sourceText === jp && blk.study.breakdown) || cached.breakdown || null,
        showTranslation: true,
        showBreakdown: Boolean(blk.study && blk.study.showBreakdown)
      };
      renderRightPanel();
      return;
    }
  }

  state.gemini.activeTasks.set(blk.id, 'translate');
  renderRightPanel();

  try {
    const sysPrompt =
      'You are an expert Japanese manga translator and linguistics tutor. ' +
      'Given a Japanese manga speech bubble (plus surrounding bubbles on the same page for context), ' +
      'output accurate word-spaced Hepburn romaji (using macrons like ō/ū where appropriate), ' +
      'a natural idiomatic English translation fitting the manga context, and a concise register/nuance note.';
    const ctx = buildPageDialogueContext(page, blk.id);
    const userPrompt =
      'Surrounding page bubbles in reading order:\n' + (ctx || jp) +
      '\n\nTarget Japanese bubble to translate & romanize:\n' + jp;

    const res = await callGeminiStructuredJson(sysPrompt, userPrompt, TRANSLATE_SCHEMA);
    const existingBreakdown = (!forceRefresh && blk.study && blk.study.sourceText === jp)
      ? blk.study.breakdown
      : null;

    blk.study = {
      sourceText: jp,
      romaji: res.romaji || '',
      english: res.english || '',
      nuance: res.nuance || '',
      breakdown: existingBreakdown,
      showTranslation: true,
      showBreakdown: Boolean(existingBreakdown && blk.study && blk.study.showBreakdown)
    };
    await putCachedBubbleStudy(jp, blk.study);
  } catch (err) {
    if (!err || err.message !== 'NO_API_KEY') {
      showToast('Gemini translation failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.gemini.activeTasks.delete(blk.id);
    renderRightPanel();
  }
}

async function requestBubbleBreakdown(page, blk, forceRefresh) {
  const jp = (blk && blk.text ? blk.text : '').trim();
  if (!jp) {
    showToast('Extract Japanese text for this bubble first.', 'warn');
    return;
  }
  if (state.gemini.activeTasks.has(blk.id)) return;

  if (!forceRefresh) {
    const cached = await getCachedBubbleStudy(jp);
    if (cached && cached.breakdown && Array.isArray(cached.breakdown.vocab)) {
      blk.study = {
        sourceText: jp,
        romaji: cached.romaji || (blk.study && blk.study.romaji) || '',
        english: cached.english || (blk.study && blk.study.english) || '',
        nuance: cached.nuance || (blk.study && blk.study.nuance) || '',
        breakdown: cached.breakdown,
        showTranslation: true,
        showBreakdown: true
      };
      renderRightPanel();
      return;
    }
  }

  state.gemini.activeTasks.set(blk.id, 'breakdown');
  renderRightPanel();

  try {
    const sysPrompt =
      'You are an expert Japanese language teacher specializing in learning Japanese through real manga dialogue. ' +
      'Break down the target Japanese manga speech bubble thoroughly for a learner: ' +
      '1) Provide spaced Hepburn romaji and natural English translation. ' +
      '2) List every vocabulary word / key particle / compound in order of appearance with hiragana reading, romaji, dictionary base form, part-of-speech + JLPT level tag, and contextual English meaning. ' +
      '3) Explain every grammar structure, verb/adjective conjugation, colloquial manga contraction (e.g. てる, ちゃう, ん, ぞ, わね, のか), or omitted subject clearly.';
    const ctx = buildPageDialogueContext(page, blk.id);
    const userPrompt =
      'Surrounding page bubbles in reading order:\n' + (ctx || jp) +
      '\n\nTarget Japanese bubble for full vocabulary & grammar breakdown:\n' + jp;

    const res = await callGeminiStructuredJson(sysPrompt, userPrompt, BREAKDOWN_SCHEMA);
    blk.study = {
      sourceText: jp,
      romaji: res.romaji || (blk.study && blk.study.romaji) || '',
      english: res.english || (blk.study && blk.study.english) || '',
      nuance: res.nuance || (blk.study && blk.study.nuance) || '',
      breakdown: {
        vocab: Array.isArray(res.vocab) ? res.vocab : [],
        grammar: Array.isArray(res.grammar) ? res.grammar : []
      },
      showTranslation: true,
      showBreakdown: true
    };
    await putCachedBubbleStudy(jp, blk.study);
  } catch (err) {
    if (!err || err.message !== 'NO_API_KEY') {
      showToast('Gemini breakdown failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.gemini.activeTasks.delete(blk.id);
    renderRightPanel();
  }
}

async function requestPageBatchTranslation(page) {
  if (!page || !Array.isArray(page.blocks) || state.gemini.isTranslatingPage) return;
  const targets = page.blocks
    .map((blk, idx) => ({ blk, num: idx + 1, jp: (blk.text || '').trim() }))
    .filter((item) => item.jp.length > 0);
  if (targets.length === 0) {
    showToast('Extract Japanese text on this page first before translating.', 'warn');
    return;
  }

  state.gemini.isTranslatingPage = true;
  renderRightPanel();

  try {
    const numberedLines = targets.map((t) => 'Bubble #' + t.num + ': ' + t.jp).join('\n');
    const sysPrompt =
      'You are an expert Japanese manga translator. Translate and romanize every numbered speech bubble on this manga page in context. ' +
      'Use natural word-spaced Hepburn romaji and idiomatic English dialogue matching each bubbleNumber.';
    const userPrompt = 'Manga page speech bubbles in reading order:\n' + numberedLines;

    const res = await callGeminiStructuredJson(sysPrompt, userPrompt, PAGE_BATCH_TRANSLATE_SCHEMA);
    const mapByNum = new Map();
    (Array.isArray(res.items) ? res.items : []).forEach((it) => {
      mapByNum.set(Number(it.bubbleNumber), it);
    });

    for (const t of targets) {
      const matched = mapByNum.get(t.num);
      if (!matched) continue;
      const prevBreakdown = (t.blk.study && t.blk.study.sourceText === t.jp) ? t.blk.study.breakdown : null;
      t.blk.study = {
        sourceText: t.jp,
        romaji: matched.romaji || '',
        english: matched.english || '',
        nuance: matched.nuance || '',
        breakdown: prevBreakdown,
        showTranslation: true,
        showBreakdown: Boolean(prevBreakdown && t.blk.study && t.blk.study.showBreakdown)
      };
      await putCachedBubbleStudy(t.jp, t.blk.study);
    }
    showToast('Translated ' + targets.length + ' bubble(s) on this page!');
  } catch (err) {
    if (!err || err.message !== 'NO_API_KEY') {
      showToast('Page translation failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.gemini.isTranslatingPage = false;
    renderRightPanel();
  }
}

function isAbortError(err) {
  if (state.abortRequested) return true;
  if (!err) return false;
  return err.message === 'ABORTED' || err.name === 'AbortError';
}

async function fetchAbortable(url, options) {
  if (state.abortRequested) throw new Error('ABORTED');
  const ctrl = new AbortController();
  runtime.activeFetchControllers.add(ctrl);
  try {
    const merged = Object.assign({}, options || {}, { signal: ctrl.signal });
    const resp = await fetch(url, merged);
    if (state.abortRequested) throw new Error('ABORTED');
    return resp;
  } catch (err) {
    if (isAbortError(err)) throw new Error('ABORTED');
    throw err;
  } finally {
    runtime.activeFetchControllers.delete(ctrl);
  }
}

async function fetchWithProgressCached(cacheKey, url, label, basePct, spanPct) {
  const cached = await idbGet(cacheKey);
  if (cached && cached.byteLength > 1024) {
    setProgress(true, 'Loaded cached ' + label, basePct + spanPct);
    return cached;
  }
  setProgress(true, 'Downloading ' + label + ' (cached after 1st load)…', basePct);
  const resp = await fetchAbortable(url, { mode: 'cors' });
  if (!resp.ok) {
    throw new Error('Failed to download ' + label + ' (HTTP ' + resp.status + ')');
  }
  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  if (!resp.body || !resp.body.getReader) {
    const buf = await resp.arrayBuffer();
    await idbPut(cacheKey, buf);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    let readRes;
    try {
      readRes = await reader.read();
    } catch (readErr) {
      if (isAbortError(readErr)) throw new Error('ABORTED');
      throw readErr;
    }
    const { done, value } = readRes;
    if (done) break;
    if (state.abortRequested) {
      try { await reader.cancel(); } catch (_e) { /* ignore */ }
      throw new Error('ABORTED');
    }
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      const ratio = received / total;
      const mbDone = (received / 1048576).toFixed(1);
      const mbTotal = (total / 1048576).toFixed(1);
      setProgress(
        true,
        'Downloading ' + label + ': ' + mbDone + ' / ' + mbTotal + ' MB',
        basePct + ratio * spanPct
      );
    } else {
      const mbDone = (received / 1048576).toFixed(1);
      setProgress(true, 'Downloading ' + label + ': ' + mbDone + ' MB', basePct + spanPct * 0.5);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  const buffer = out.buffer;
  await idbPut(cacheKey, buffer);
  return buffer;
}

