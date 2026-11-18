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

function normalizeConf01(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  let n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/%/g, '').trim());
  if (!Number.isFinite(n)) return null;
  if (n > 1.0 && n <= 100.0) n = n / 100.0;
  return Math.max(0, Math.min(1, n));
}

function formatOcrConfPercent(raw) {
  const c = normalizeConf01(raw);
  if (c === null) return null;
  // Floor values below 0.90 so e.g. 0.896 always displays as 89% (never misleadingly rounded to 90%)
  return c < LOW_CONF_THRESHOLD ? Math.floor(c * 100) : Math.round(c * 100);
}

function isBlockBelowReviewThreshold(blk, page) {
  if (!blk || blk.verified) return false;
  const c = normalizeConf01(blk.charConf);
  if (c !== null) {
    return c < LOW_CONF_THRESHOLD;
  }
  const hasTxt = Boolean((blk.text || '').trim());
  if (hasTxt && blk.ocrAttempted) {
    return true;
  }
  if (!hasTxt && (blk.ocrAttempted || (page && (page.status === 'done' || page.ocrCompleted)))) {
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

function isPageAlreadyExtracted(page) {
  if (!page) return false;
  if (page.status === 'done' || page.ocrCompleted) return true;
  return Array.isArray(page.blocks) && page.blocks.some(
    (b) => Boolean((b.text || '').trim()) || Boolean(b.ocrAttempted)
  );
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
  filterReviewPagesOnly: false,
  reviewQueuePageId: null,
  reviewSortMode: 'page', // 'page' | 'conf'
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
  batchSelectMode: false,
  batchQueue: [], // [{ pageId, blockId }] in exact user-selected order across pages
  batchStudyResult: null,
  batchStudyExpanded: false,
  isRunningBatchStudy: false,
  showPopupRomaji: false,
  isViewerFullscreen: false,
  preFsShowBoxes: true,
  drawMode: false,
  zoom: 1.0,
  fitMode: true,
  activeTab: 'all', // 'all' | 'bubbles' | 'review' | 'vocab'
  savedVocab: [],
  savedVocabRev: 0,
  vocabViewMode: 'list', // 'list' | 'cards'
  vocabSearchQuery: '',
  vocabDeckName: 'AnkiSuru Manga Vocabulary',
  vocabCardIndex: 0,
  vocabCardFlipped: false,
  vocabEditingId: null,
  vocabShowAddForm: false,
  vocabConfirmClear: false,
  isExportingAnki: false,
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
  btnSidebarReviewFilter: document.getElementById('btnSidebarReviewFilter'),
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
  btnToolbarReviewJump: document.getElementById('btnToolbarReviewJump'),
  btnSelectTextMode: document.getElementById('btnSelectTextMode'),
  btnBatchSelectMode: document.getElementById('btnBatchSelectMode'),
  batchSelectBtnLabel: document.getElementById('batchSelectBtnLabel'),
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
  btnFsZoomOut: document.getElementById('btnFsZoomOut'),
  btnFsZoomFit: document.getElementById('btnFsZoomFit'),
  btnFsZoomIn: document.getElementById('btnFsZoomIn'),
  btnFsSelectText: document.getElementById('btnFsSelectText'),
  btnFsBatchSelect: document.getElementById('btnFsBatchSelect'),
  fsBatchBtnLabel: document.getElementById('fsBatchBtnLabel'),
  btnExitFullscreen: document.getElementById('btnExitFullscreen'),
  drawModeBanner: document.getElementById('drawModeBanner'),
  btnExitDrawMode: document.getElementById('btnExitDrawMode'),
  liveTextBanner: document.getElementById('liveTextBanner'),
  liveBannerStatusText: document.getElementById('liveBannerStatusText'),
  btnCopySelectedLiveText: document.getElementById('btnCopySelectedLiveText'),
  btnExitLiveTextMode: document.getElementById('btnExitLiveTextMode'),
  batchSelectBanner: document.getElementById('batchSelectBanner'),
  batchBannerStatusText: document.getElementById('batchBannerStatusText'),
  btnBannerExitBatch: document.getElementById('btnBannerExitBatch'),
  liveSelectionCard: document.getElementById('liveSelectionCard'),
  liveSelMetaLabel: document.getElementById('liveSelMetaLabel'),
  btnVerifyPopupBubble: document.getElementById('btnVerifyPopupBubble'),
  btnDeletePopupBubble: document.getElementById('btnDeletePopupBubble'),
  btnTogglePopupRomaji: document.getElementById('btnTogglePopupRomaji'),
  btnPopupBreakdown: document.getElementById('btnPopupBreakdown'),
  btnPopupBatchToggle: document.getElementById('btnPopupBatchToggle'),
  btnPopupSaveWord: document.getElementById('btnPopupSaveWord'),
  btnPopupSaveAllVocab: document.getElementById('btnPopupSaveAllVocab'),
  btnPopupRefreshStudy: document.getElementById('btnPopupRefreshStudy'),
  btnSelectWholeBubble: document.getElementById('btnSelectWholeBubble'),
  liveSelectionCopyChip: document.getElementById('liveSelectionCopyChip'),
  btnClearLiveSelection: document.getElementById('btnClearLiveSelection'),
  liveSelPreviewBody: document.getElementById('liveSelPreviewBody'),
  liveSelRomajiWrap: document.getElementById('liveSelRomajiWrap'),
  liveSelRomajiLabel: document.getElementById('liveSelRomajiLabel'),
  btnCopyPopupRomaji: document.getElementById('btnCopyPopupRomaji'),
  liveSelRomajiBody: document.getElementById('liveSelRomajiBody'),
  liveSelEnglishWrap: document.getElementById('liveSelEnglishWrap'),
  liveSelEnglishLabel: document.getElementById('liveSelEnglishLabel'),
  btnCopyPopupStudyRomaji: document.getElementById('btnCopyPopupStudyRomaji'),
  btnCopyPopupEnglish: document.getElementById('btnCopyPopupEnglish'),
  liveSelStudyRomajiBody: document.getElementById('liveSelStudyRomajiBody'),
  liveSelEnglishBody: document.getElementById('liveSelEnglishBody'),
  liveSelNuanceBody: document.getElementById('liveSelNuanceBody'),
  liveSelBreakdownWrap: document.getElementById('liveSelBreakdownWrap'),
  liveSelBreakdownLabel: document.getElementById('liveSelBreakdownLabel'),
  liveSelBreakdownBody: document.getElementById('liveSelBreakdownBody'),
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
  tabBtnReviewQueue: document.getElementById('tabBtnReviewQueue'),
  reviewQueueCountBadge: document.getElementById('reviewQueueCountBadge'),
  tabBtnSavedVocab: document.getElementById('tabBtnSavedVocab'),
  savedVocabCountBadge: document.getElementById('savedVocabCountBadge'),
  btnCopyAllText: document.getElementById('btnCopyAllText'),
  btnDownloadTxt: document.getElementById('btnDownloadTxt'),
  btnDownloadJson: document.getElementById('btnDownloadJson'),
  chkIncludeHeaders: document.getElementById('chkIncludeHeaders'),
  totalCharsStat: document.getElementById('totalCharsStat'),
  btnFontSmaller: document.getElementById('btnFontSmaller'),
  btnFontLarger: document.getElementById('btnFontLarger'),
  globalReviewBanner: document.getElementById('globalReviewBanner'),
  globalReviewBannerText: document.getElementById('globalReviewBannerText'),
  btnBannerOpenReview: document.getElementById('btnBannerOpenReview'),
  btnBannerNextReview: document.getElementById('btnBannerNextReview'),
  panelAllText: document.getElementById('panelAllText'),
  fullMangaTextarea: document.getElementById('fullMangaTextarea'),
  panelPageBubbles: document.getElementById('panelPageBubbles'),
  panelReviewQueue: document.getElementById('panelReviewQueue'),
  panelSavedVocab: document.getElementById('panelSavedVocab'),
  batchStudyDock: document.getElementById('batchStudyDock'),
  batchDockCountBadge: document.getElementById('batchDockCountBadge'),
  batchDockHintText: document.getElementById('batchDockHintText'),
  btnRunBatchStudy: document.getElementById('btnRunBatchStudy'),
  btnToggleBatchResults: document.getElementById('btnToggleBatchResults'),
  btnBatchUndoLast: document.getElementById('btnBatchUndoLast'),
  btnClearBatchQueue: document.getElementById('btnClearBatchQueue'),
  btnCloseBatchDock: document.getElementById('btnCloseBatchDock'),
  batchSequenceStrip: document.getElementById('batchSequenceStrip'),
  batchStudyResultsPanel: document.getElementById('batchStudyResultsPanel'),
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
  if (state.isViewerFullscreen && typeof setViewerFullscreen === 'function') {
    setViewerFullscreen(false);
  }
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
  const key = 'gemini_study_v2_' + hashStudyText(norm);
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
  const key = 'gemini_study_v2_' + hashStudyText(norm);
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
    english: { type: 'STRING', description: 'Natural, context-aware English manga dialogue translation.' },
    nuance: { type: 'STRING', description: 'Brief 1-line note on speaker tone, politeness/slang, or implied subject (empty string if straightforward).' }
  },
  required: ['english', 'nuance']
};

const VOCAB_ITEM_SCHEMA_DEF = {
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
};

const GRAMMAR_ITEM_SCHEMA_DEF = {
  type: 'OBJECT',
  properties: {
    pattern: { type: 'STRING', description: 'Grammar point, conjugation, contraction, or sentence-ending particle used.' },
    level: { type: 'STRING', description: 'Level or register tag, e.g. N5, N4, Casual, Masculine/Feminine.' },
    explanation: { type: 'STRING', description: 'Clear learner-friendly explanation of how it works here.' }
  },
  required: ['pattern', 'level', 'explanation']
};

const BREAKDOWN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    romaji: { type: 'STRING', description: 'Context-verified word-spaced Revised Hepburn romaji for the entire bubble (choosing exact kanji readings & character names from manga context).' },
    english: { type: 'STRING', description: 'Natural English translation in manga context.' },
    nuance: { type: 'STRING', description: 'Brief tone/register note.' },
    vocab: { type: 'ARRAY', items: VOCAB_ITEM_SCHEMA_DEF },
    grammar: { type: 'ARRAY', items: GRAMMAR_ITEM_SCHEMA_DEF }
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
          romaji: { type: 'STRING', description: 'Context-verified word-spaced Revised Hepburn romaji.' },
          english: { type: 'STRING' },
          nuance: { type: 'STRING' }
        },
        required: ['bubbleNumber', 'romaji', 'english', 'nuance']
      }
    }
  },
  required: ['items']
};

const ORDERED_BATCH_STUDY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    connectedRomaji: { type: 'STRING', description: 'Full connected Revised Hepburn romaji across the user-ordered bubble sequence.' },
    connectedEnglish: { type: 'STRING', description: 'Seamless natural English translation of the entire user-ordered bubble sequence read together.' },
    contextNote: { type: 'STRING', description: 'Concise note explaining how split sentences, speakers, or implied subjects connect across the ordered bubbles.' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          stepNumber: { type: 'INTEGER', description: '1-based step number matching the user-selected order.' },
          romaji: { type: 'STRING', description: 'Context-verified word-spaced Revised Hepburn romaji for this bubble.' },
          english: { type: 'STRING', description: 'Context-aware English translation for this bubble.' },
          nuance: { type: 'STRING', description: 'Brief tone/speaker/clause-continuity note.' },
          vocab: { type: 'ARRAY', items: VOCAB_ITEM_SCHEMA_DEF },
          grammar: { type: 'ARRAY', items: GRAMMAR_ITEM_SCHEMA_DEF }
        },
        required: ['stepNumber', 'romaji', 'english', 'nuance', 'vocab', 'grammar']
      }
    }
  },
  required: ['connectedRomaji', 'connectedEnglish', 'contextNote', 'items']
};

function notifyStudyViewsUpdated(blockId) {
  renderRightPanel();
  if (typeof renderBatchStudyDock === 'function') {
    renderBatchStudyDock();
  }
  if (
    state.liveTextMode &&
    (!blockId || state.livePopupBlockId === blockId) &&
    typeof syncLiveSelectionUI === 'function'
  ) {
    syncLiveSelectionUI();
    if (typeof positionOpenLivePopup === 'function') {
      requestAnimationFrame(positionOpenLivePopup);
    }
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
    if (cached && cached.breakdown && Array.isArray(cached.breakdown.vocab) && cached.romaji) {
      blk.study = {
        sourceText: jp,
        romaji: cached.romaji || '',
        english: cached.english || (blk.study && blk.study.english) || '',
        nuance: cached.nuance || (blk.study && blk.study.nuance) || '',
        breakdown: cached.breakdown,
        showTranslation: true,
        showBreakdown: true
      };
      notifyStudyViewsUpdated(blk.id);
      return;
    }
  }

  state.gemini.activeTasks.set(blk.id, 'breakdown');
  notifyStudyViewsUpdated(blk.id);

  try {
    const sysPrompt =
      'You are an expert Japanese language teacher specializing in learning Japanese through real manga dialogue. ' +
      'In a single response, translate, romanize, and break down the target Japanese manga speech bubble thoroughly for a learner: ' +
      '1) Provide context-verified word-spaced Revised Hepburn romaji (carefully disambiguating kanji homographs, character names, and contractions in context), a natural English translation, and a brief register/nuance note. ' +
      '2) List every vocabulary word / key particle / compound in order of appearance with hiragana reading, romaji, dictionary base form, part-of-speech + JLPT level tag, and contextual English meaning. ' +
      '3) Explain every grammar structure, verb/adjective conjugation, colloquial manga contraction (e.g. てる, ちゃう, ん, ぞ, わね, のか), or omitted subject clearly.';
    const ctx = buildPageDialogueContext(page, blk.id);
    const userPrompt =
      'Surrounding page bubbles in reading order:\n' + (ctx || jp) +
      '\n\nTarget Japanese bubble for English + verified Romaji + vocabulary & grammar breakdown:\n' + jp;

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
      showToast('Study breakdown failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.gemini.activeTasks.delete(blk.id);
    notifyStudyViewsUpdated(blk.id);
  }
}

function requestBubbleTranslation(page, blk, forceRefresh) {
  return requestBubbleBreakdown(page, blk, forceRefresh);
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
  notifyStudyViewsUpdated(null);

  try {
    const numberedLines = targets.map((t) => 'Bubble #' + t.num + ': ' + t.jp).join('\n');
    const sysPrompt =
      'You are an expert Japanese manga translator. Translate and romanize every numbered speech bubble on this manga page in context. ' +
      'Provide context-verified word-spaced Revised Hepburn romaji (resolving exact kanji readings in context) and natural English dialogue matching each bubbleNumber.';
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
    showToast('Translated ' + targets.length + ' bubble(s) with verified Romaji!');
  } catch (err) {
    if (!err || err.message !== 'NO_API_KEY') {
      showToast('Page translation failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.gemini.isTranslatingPage = false;
    notifyStudyViewsUpdated(null);
  }
}

// -----------------------------------------------------------------------
// Ordered Cross-Page Batch Bubble Queue & Connected Context Study Engine
// -----------------------------------------------------------------------
function resolveBatchQueueEntries() {
  const valid = [];
  const nextQueue = [];
  (state.batchQueue || []).forEach((entry) => {
    if (!entry || !entry.pageId || !entry.blockId) return;
    const pageIdx = state.pages.findIndex((p) => p.id === entry.pageId);
    if (pageIdx < 0) return;
    const page = state.pages[pageIdx];
    const blkIdx = (page.blocks || []).findIndex((b) => b.id === entry.blockId);
    if (blkIdx < 0) return;
    const blk = page.blocks[blkIdx];
    const text = (blk.text || '').trim();
    if (!text) return;
    nextQueue.push({ pageId: page.id, blockId: blk.id });
    valid.push({
      step: valid.length + 1,
      pageIdx,
      page,
      blkIdx,
      bubbleNum: blkIdx + 1,
      blk,
      text
    });
  });
  if (nextQueue.length !== (state.batchQueue ? state.batchQueue.length : 0)) {
    state.batchQueue = nextQueue;
  }
  return valid;
}

function getBlockBatchOrderIndex(blockId) {
  if (!blockId || !Array.isArray(state.batchQueue) || state.batchQueue.length === 0) return -1;
  return state.batchQueue.findIndex((item) => item.blockId === blockId);
}

function toggleBlockInBatchQueue(pageId, blockId) {
  if (!pageId || !blockId) return -1;
  const page = state.pages.find((p) => p.id === pageId);
  const blk = page && Array.isArray(page.blocks) ? page.blocks.find((b) => b.id === blockId) : null;
  if (!blk || !(blk.text || '').trim()) {
    showToast('Extract Japanese text on this bubble first before adding to Batch.', 'warn');
    return -1;
  }

  const existingIdx = getBlockBatchOrderIndex(blockId);
  if (existingIdx >= 0) {
    state.batchQueue.splice(existingIdx, 1);
    notifyBatchQueueUpdated();
    return -1;
  }

  state.batchQueue.push({ pageId, blockId });
  const newOrder = state.batchQueue.length;
  notifyBatchQueueUpdated();
  return newOrder;
}

function removeBatchStepAt(idx) {
  if (idx < 0 || idx >= state.batchQueue.length) return;
  state.batchQueue.splice(idx, 1);
  if (state.batchQueue.length === 0) {
    state.batchStudyResult = null;
    state.batchStudyExpanded = false;
  }
  notifyBatchQueueUpdated();
}

function clearBatchStudyQueue() {
  state.batchQueue = [];
  state.batchStudyResult = null;
  state.batchStudyExpanded = false;
  notifyBatchQueueUpdated();
}

function notifyBatchQueueUpdated() {
  resolveBatchQueueEntries();
  if (typeof renderOverlayBoxes === 'function') renderOverlayBoxes();
  if (typeof renderRightPanel === 'function' && state.activeTab === 'bubbles') renderRightPanel();
  if (typeof renderBatchStudyDock === 'function') renderBatchStudyDock();
  if (state.liveTextMode && state.livePopupBlockId && typeof syncLiveSelectionUI === 'function') {
    syncLiveSelectionUI();
  }
}

async function requestOrderedBatchStudy() {
  const entries = resolveBatchQueueEntries();
  if (entries.length === 0) {
    showToast('Click speech bubbles in reading order first to build a batch.', 'warn');
    return;
  }
  if (state.isRunningBatchStudy) return;

  state.isRunningBatchStudy = true;
  state.batchStudyExpanded = true;
  if (typeof renderBatchStudyDock === 'function') renderBatchStudyDock();

  try {
    const orderedLines = entries.map(
      (e) => 'Step ' + e.step + ' (Page ' + (e.pageIdx + 1) + ', Bubble #' + e.bubbleNum + '): ' + e.text
    ).join('\n');

    const sysPrompt =
      'You are an expert Japanese manga translator and language teacher. ' +
      'The user manually selected the following speech bubbles in EXACT reading sequence across panels/pages so that split sentences, cross-bubble clauses, speaker turns, and omitted pronouns connect with full context. ' +
      'Use the full sequence together to disambiguate every kanji reading accurately! ' +
      '1) Provide connectedRomaji (Revised Hepburn), connectedEnglish (how the full sequence reads smoothly together), and a concise contextNote explaining how the bubbles connect. ' +
      '2) For EVERY step (matching stepNumber 1..' + entries.length + '), provide context-verified word-spaced Revised Hepburn romaji, natural English translation, nuance/continuity note, complete vocabulary list (surface, reading, romaji, dictForm, pos, meaning), and grammar explanations.';

    const userPrompt =
      'User-selected speech bubbles in exact reading order (' + entries.length + ' bubble(s)):\n' + orderedLines;

    const res = await callGeminiStructuredJson(sysPrompt, userPrompt, ORDERED_BATCH_STUDY_SCHEMA);
    const byStep = new Map();
    (Array.isArray(res.items) ? res.items : []).forEach((it) => {
      byStep.set(Number(it.stepNumber), it);
    });

    const stepOutputs = [];
    for (let i = 0; i < entries.length; i++) {
      const ent = entries[i];
      const matched = byStep.get(ent.step) || (Array.isArray(res.items) ? res.items[i] : null) || {};
      const vocabArr = Array.isArray(matched.vocab) ? matched.vocab : [];
      const grammarArr = Array.isArray(matched.grammar) ? matched.grammar : [];

      ent.blk.study = {
        sourceText: ent.text,
        romaji: matched.romaji || '',
        english: matched.english || '',
        nuance: matched.nuance || '',
        breakdown: {
          vocab: vocabArr,
          grammar: grammarArr
        },
        showTranslation: true,
        showBreakdown: true
      };
      await putCachedBubbleStudy(ent.text, ent.blk.study);

      stepOutputs.push({
        step: ent.step,
        pageId: ent.page.id,
        pageIdx: ent.pageIdx,
        pageName: ent.page.name,
        blockId: ent.blk.id,
        bubbleNum: ent.bubbleNum,
        jpText: ent.text,
        romaji: matched.romaji || '',
        english: matched.english || '',
        nuance: matched.nuance || '',
        vocab: vocabArr,
        grammar: grammarArr
      });
    }

    state.batchStudyResult = {
      createdAt: Date.now(),
      connectedRomaji: res.connectedRomaji || '',
      connectedEnglish: res.connectedEnglish || '',
      contextNote: res.contextNote || '',
      steps: stepOutputs
    };
    state.batchStudyExpanded = true;
    showToast('Analyzed ' + entries.length + ' ordered bubble(s) with full cross-bubble context!');
  } catch (err) {
    if (!err || err.message !== 'NO_API_KEY') {
      showToast('Batch study failed: ' + (err ? err.message : 'Unknown error'), 'error');
    }
  } finally {
    state.isRunningBatchStudy = false;
    notifyStudyViewsUpdated(null);
  }
}


// -----------------------------------------------------------------------
// Saved Vocabulary Store & Native Anki Deck (.apkg + .txt) Generator
// Front Card: Kanji | Back Card: Romaji + Meaning
// -----------------------------------------------------------------------
const SAVED_VOCAB_STORAGE_KEY = 'ankisuru_saved_vocab_v1';

const QUICK_WORD_STUDY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kanji: { type: 'STRING', description: 'Standard Japanese word / kanji spelling for flashcard front.' },
    reading: { type: 'STRING', description: 'Hiragana reading.' },
    romaji: { type: 'STRING', description: 'Revised Hepburn romaji.' },
    pos: { type: 'STRING', description: 'Concise part of speech + JLPT hint if applicable.' },
    meaning: { type: 'STRING', description: 'Concise English meaning in context.' }
  },
  required: ['kanji', 'reading', 'romaji', 'pos', 'meaning']
};

function getVocabPrimaryKanji(v) {
  if (!v) return '';
  return String(v.kanji || v.surface || v.dictForm || '').trim();
}

function normalizeVocabMatchKey(v) {
  const k = getVocabPrimaryKanji(v);
  if (!k) return '';
  return k.replace(/\s+/g, '');
}

function findSavedVocabEntry(v) {
  const key = normalizeVocabMatchKey(v);
  if (!key) return null;
  const reading = String((v && v.reading) || '').trim();
  return state.savedVocab.find((item) => {
    if (normalizeVocabMatchKey(item) !== key) return false;
    if (reading && item.reading && reading !== item.reading) return false;
    return true;
  }) || state.savedVocab.find((item) => normalizeVocabMatchKey(item) === key) || null;
}

function isVocabItemSaved(v) {
  return Boolean(findSavedVocabEntry(v));
}

function computeInstantWordRomaji(kanjiStr, readingStr) {
  const source = String(readingStr || kanjiStr || '').trim();
  if (!source) return '';
  if (typeof convertJapaneseToRomajiInstant === 'function') {
    return (convertJapaneseToRomajiInstant(source).romaji || '').trim();
  }
  return '';
}

function buildSavedVocabRecord(rawVocab, meta) {
  const m = meta || {};
  const kanji = getVocabPrimaryKanji(rawVocab);
  const reading = String((rawVocab && rawVocab.reading) || '').trim();
  let romaji = String((rawVocab && rawVocab.romaji) || '').trim();
  if (!romaji) {
    romaji = computeInstantWordRomaji(kanji, reading);
  }
  const meaning = String((rawVocab && rawVocab.meaning) || '').trim();
  const dictForm = String((rawVocab && rawVocab.dictForm) || '').trim();
  const pos = String((rawVocab && rawVocab.pos) || '').trim();
  return {
    id: (rawVocab && rawVocab.id) || ('voc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)),
    kanji,
    reading,
    romaji,
    meaning,
    dictForm,
    pos,
    contextJp: String(m.contextJp || (rawVocab && rawVocab.contextJp) || '').trim(),
    pageId: m.pageId || (rawVocab && rawVocab.pageId) || null,
    pageName: m.pageName || (rawVocab && rawVocab.pageName) || '',
    bubbleIndex: m.bubbleIndex || (rawVocab && rawVocab.bubbleIndex) || null,
    blockId: m.blockId || (rawVocab && rawVocab.blockId) || null,
    savedAt: (rawVocab && rawVocab.savedAt) || Date.now()
  };
}

async function persistSavedVocabState() {
  const payload = {
    deckName: state.vocabDeckName || 'AnkiSuru Manga Vocabulary',
    items: state.savedVocab,
    updatedAt: Date.now()
  };
  try {
    if (window.localStorage) {
      window.localStorage.setItem(SAVED_VOCAB_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch (_e) {
    // Fallback to IndexedDB in restricted iframes
  }
  try {
    await idbPut(SAVED_VOCAB_STORAGE_KEY, payload);
  } catch (_e2) {}
}

async function loadSavedVocabConfig() {
  let loaded = null;
  try {
    const raw = window.localStorage ? window.localStorage.getItem(SAVED_VOCAB_STORAGE_KEY) : null;
    if (raw) loaded = JSON.parse(raw);
  } catch (_e) {}
  if (!loaded || typeof loaded !== 'object') {
    try {
      const idbVal = await idbGet(SAVED_VOCAB_STORAGE_KEY);
      if (idbVal && typeof idbVal === 'object') loaded = idbVal;
    } catch (_e2) {}
  }
  if (loaded && typeof loaded === 'object') {
    if (typeof loaded.deckName === 'string' && loaded.deckName.trim()) {
      state.vocabDeckName = loaded.deckName.trim();
    }
    if (Array.isArray(loaded.items)) {
      state.savedVocab = loaded.items
        .filter((it) => it && getVocabPrimaryKanji(it))
        .map((it) => buildSavedVocabRecord(it));
      state.savedVocabRev++;
    }
  }
  notifySavedVocabChanged({ skipRightRender: state.activeTab !== 'vocab' });
}

function notifySavedVocabChanged(opts) {
  const options = opts || {};
  state.savedVocabRev = (state.savedVocabRev || 0) + 1;
  if (state.vocabCardIndex >= state.savedVocab.length) {
    state.vocabCardIndex = Math.max(0, state.savedVocab.length - 1);
  }
  if (typeof syncSavedVocabIndicatorsInPlace === 'function') {
    syncSavedVocabIndicatorsInPlace();
  }
  if (typeof renderBatchStudyDock === 'function' && state.batchStudyExpanded && state.batchStudyResult) {
    // syncSavedVocabIndicatorsInPlace already updates all [data-vocab-save-key] buttons inside #batchStudyDock in-place!
  }
  if (!options.skipRightRender && state.activeTab === 'vocab' && typeof renderSavedVocabPanel === 'function') {
    renderSavedVocabPanel();
  }
  if (state.liveTextMode && state.livePopupBlockId && typeof syncLiveSelectionUI === 'function') {
    syncLiveSelectionUI();
  }
}

function toggleSaveVocabItem(rawVocab, meta) {
  const kanji = getVocabPrimaryKanji(rawVocab);
  if (!kanji) {
    showToast('Select or enter a Japanese vocabulary word first.', 'warn');
    return false;
  }
  const existing = findSavedVocabEntry(rawVocab);
  if (existing) {
    state.savedVocab = state.savedVocab.filter((it) => it.id !== existing.id);
    if (state.vocabEditingId === existing.id) state.vocabEditingId = null;
    state.vocabConfirmClear = false;
    persistSavedVocabState();
    notifySavedVocabChanged();
    showToast('Removed "' + existing.kanji + '" from Saved Vocabulary.');
    return false;
  }

  const record = buildSavedVocabRecord(rawVocab, meta);
  state.savedVocab.push(record);
  state.vocabConfirmClear = false;
  persistSavedVocabState();
  notifySavedVocabChanged();
  showToast('Saved "' + record.kanji + '" to Vocabulary (' + state.savedVocab.length + ' saved)!');
  return true;
}

function saveAllVocabFromList(vocabList, meta) {
  if (!Array.isArray(vocabList) || vocabList.length === 0) return 0;
  let added = 0;
  vocabList.forEach((v) => {
    if (!getVocabPrimaryKanji(v)) return;
    if (!isVocabItemSaved(v)) {
      state.savedVocab.push(buildSavedVocabRecord(v, meta));
      added++;
    }
  });
  state.vocabConfirmClear = false;
  if (added > 0) {
    persistSavedVocabState();
    notifySavedVocabChanged();
    showToast('Saved ' + added + ' vocabulary word' + (added === 1 ? '' : 's') + ' (' + state.savedVocab.length + ' total)!');
  } else {
    showToast('All vocabulary words in this bubble are already saved!');
  }
  return added;
}

async function saveHighlightedWordFromPopup(wordStr, info) {
  const cleanWord = String(wordStr || '').trim();
  if (!cleanWord) return;

  const existing = findSavedVocabEntry({ kanji: cleanWord });
  if (existing) {
    state.savedVocab = state.savedVocab.filter((it) => it.id !== existing.id);
    persistSavedVocabState();
    notifySavedVocabChanged();
    showToast('Removed "' + existing.kanji + '" from Saved Vocabulary.');
    return;
  }

  const meta = {
    contextJp: info && info.text ? info.text : '',
    pageId: info && info.page ? info.page.id : null,
    pageName: info && info.page ? info.page.name : '',
    bubbleIndex: info ? info.index : null,
    blockId: info && info.blk ? info.blk.id : null
  };

  // Check if current bubble's breakdown already has exact match
  const breakdownVocab = (info && info.blk && info.blk.study && info.blk.study.breakdown && Array.isArray(info.blk.study.breakdown.vocab))
    ? info.blk.study.breakdown.vocab
    : [];
  const matched = breakdownVocab.find(
    (v) => String(v.surface || '').trim() === cleanWord || String(v.dictForm || '').trim() === cleanWord
  );
  if (matched) {
    toggleSaveVocabItem(matched, meta);
    return;
  }

  const instantRomaji = computeInstantWordRomaji(cleanWord, '');
  const fallbackMeaning = (info && info.blk && info.blk.study && info.blk.study.english && cleanWord === info.text.trim())
    ? info.blk.study.english.trim()
    : '';
  const record = buildSavedVocabRecord(
    { kanji: cleanWord, romaji: instantRomaji, meaning: fallbackMeaning },
    meta
  );
  state.savedVocab.push(record);
  if (!record.meaning) {
    state.vocabEditingId = record.id;
  }
  persistSavedVocabState();
  notifySavedVocabChanged();

  const hasApiKey = Boolean((state.gemini.apiKey || '').trim() || (el.inputGeminiApiKey && el.inputGeminiApiKey.value.trim()));
  if (hasApiKey && !record.meaning) {
    showToast('Saved "' + record.kanji + '" — fetching contextual English meaning…');
    try {
      const sys = 'You are a concise Japanese-English manga dictionary. Return the kanji/word front, hiragana reading, Revised Hepburn romaji, part of speech, and concise contextual English meaning for the target word.';
      const usr = 'Manga bubble sentence: ' + (meta.contextJp || cleanWord) + '\nTarget Japanese word: ' + cleanWord;
      const res = await callGeminiStructuredJson(sys, usr, QUICK_WORD_STUDY_SCHEMA);
      const target = state.savedVocab.find((it) => it.id === record.id);
      if (target && res) {
        if (res.reading) target.reading = String(res.reading).trim();
        if (res.romaji) target.romaji = String(res.romaji).trim();
        if (res.pos) target.pos = String(res.pos).trim();
        if (res.meaning) {
          target.meaning = String(res.meaning).trim();
          if (state.vocabEditingId === target.id) state.vocabEditingId = null;
        }
        persistSavedVocabState();
        notifySavedVocabChanged();
        showToast('Updated "' + target.kanji + '": ' + target.romaji + ' — ' + target.meaning);
      }
    } catch (_e) {
      // Keep saved word with offline romaji so user can review/edit in Vocab tab
    }
  } else {
    showToast(
      record.meaning
        ? ('Saved "' + record.kanji + '" to Vocabulary!')
        : ('Saved "' + record.kanji + '" (' + (record.romaji || 'romaji ready') + ') — add/edit meaning in Vocab tab!')
    );
  }
}

// --- Zero-Dependency SQLite3 + ZIP Anki .apkg Builder ---
function utf8EncodeAnki(str) {
  return new TextEncoder().encode(String(str == null ? '' : str));
}

function encodeSqliteVarint(val) {
  let n = BigInt(val);
  if (n < 0n) n = BigInt.asUintN(64, n);
  if (n <= 0x7fn) return [Number(n)];
  const bytes = [];
  if (n > 0x00ffffffffffffffn) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
    for (let i = 0; i < 8; i++) {
      bytes.push(Number((n & 0x7fn) | 0x80n));
      n >>= 7n;
    }
    return bytes.reverse();
  }
  bytes.push(Number(n & 0x7fn));
  n >>= 7n;
  while (n > 0n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  return bytes.reverse();
}

function encodeSqliteRecord(cols) {
  const headerTypes = [];
  const bodyChunks = [];
  for (let idx = 0; idx < cols.length; idx++) {
    const col = cols[idx];
    if (!col || col.type === 'null' || col.value === null || col.value === undefined) {
      headerTypes.push(...encodeSqliteVarint(0));
    } else if (col.type === 'int') {
      const v = BigInt(col.value);
      if (v === 0n) {
        headerTypes.push(...encodeSqliteVarint(8));
      } else if (v === 1n) {
        headerTypes.push(...encodeSqliteVarint(9));
      } else if (v >= -128n && v <= 127n) {
        headerTypes.push(...encodeSqliteVarint(1));
        const b = new Uint8Array(1);
        new DataView(b.buffer).setInt8(0, Number(v));
        bodyChunks.push(b);
      } else if (v >= -32768n && v <= 32767n) {
        headerTypes.push(...encodeSqliteVarint(2));
        const b = new Uint8Array(2);
        new DataView(b.buffer).setInt16(0, Number(v), false);
        bodyChunks.push(b);
      } else if (v >= -8388608n && v <= 8388607n) {
        headerTypes.push(...encodeSqliteVarint(3));
        const b = new Uint8Array(3);
        const u = Number(BigInt.asUintN(24, v));
        b[0] = (u >> 16) & 0xff;
        b[1] = (u >> 8) & 0xff;
        b[2] = u & 0xff;
        bodyChunks.push(b);
      } else if (v >= -2147483648n && v <= 2147483647n) {
        headerTypes.push(...encodeSqliteVarint(4));
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, Number(v), false);
        bodyChunks.push(b);
      } else {
        headerTypes.push(...encodeSqliteVarint(6));
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, v, false);
        bodyChunks.push(b);
      }
    } else {
      const tb = utf8EncodeAnki(col.value);
      const serial = tb.length * 2 + 13;
      headerTypes.push(...encodeSqliteVarint(serial));
      bodyChunks.push(tb);
    }
  }

  let hdrLen = headerTypes.length + 1;
  let lenVarint = encodeSqliteVarint(hdrLen);
  while (lenVarint.length + headerTypes.length !== hdrLen) {
    hdrLen = lenVarint.length + headerTypes.length;
    lenVarint = encodeSqliteVarint(hdrLen);
  }

  let bodyLen = 0;
  for (let i = 0; i < bodyChunks.length; i++) bodyLen += bodyChunks[i].length;
  const out = new Uint8Array(hdrLen + bodyLen);
  out.set(lenVarint, 0);
  out.set(headerTypes, lenVarint.length);
  let off = hdrLen;
  for (let i = 0; i < bodyChunks.length; i++) {
    out.set(bodyChunks[i], off);
    off += bodyChunks[i].length;
  }
  return out;
}

function encodeTableLeafCell(rowid, recordBytes) {
  const pLen = encodeSqliteVarint(recordBytes.length);
  const rId = encodeSqliteVarint(rowid);
  const cell = new Uint8Array(pLen.length + rId.length + recordBytes.length);
  cell.set(pLen, 0);
  cell.set(rId, pLen.length);
  cell.set(recordBytes, pLen.length + rId.length);
  return cell;
}

function encodeTableInteriorCell(leftChildPageNum, intKey) {
  const k = encodeSqliteVarint(intKey);
  const cell = new Uint8Array(4 + k.length);
  new DataView(cell.buffer).setUint32(0, leftChildPageNum, false);
  cell.set(k, 4);
  return cell;
}

function buildSqliteLeafPage(pageSize, headerOffset, cells) {
  const page = new Uint8Array(pageSize);
  const dv = new DataView(page.buffer);
  const ptrStart = headerOffset + 8;
  let contentStart = pageSize;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    contentStart -= c.length;
    page.set(c, contentStart);
    dv.setUint16(ptrStart + i * 2, contentStart, false);
  }
  page[headerOffset] = 0x0d;
  dv.setUint16(headerOffset + 1, 0, false);
  dv.setUint16(headerOffset + 3, cells.length, false);
  dv.setUint16(headerOffset + 5, contentStart === 65536 ? 0 : contentStart, false);
  page[headerOffset + 7] = 0;
  return page;
}

function buildSqliteInteriorPage(pageSize, cells, rightMostPageNum) {
  const page = new Uint8Array(pageSize);
  const dv = new DataView(page.buffer);
  const ptrStart = 12;
  let contentStart = pageSize;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    contentStart -= c.length;
    page.set(c, contentStart);
    dv.setUint16(ptrStart + i * 2, contentStart, false);
  }
  page[0] = 0x05;
  dv.setUint16(1, 0, false);
  dv.setUint16(3, cells.length, false);
  dv.setUint16(5, contentStart === 65536 ? 0 : contentStart, false);
  page[7] = 0;
  dv.setUint32(8, rightMostPageNum, false);
  return page;
}

function allocateSqliteTablePages(pageSize, rows, nextPageNum) {
  const prepared = rows.map((r) => ({
    rowid: r.rowid,
    cell: encodeTableLeafCell(r.rowid, encodeSqliteRecord(r.cols))
  }));
  let totalBytes = 8 + prepared.length * 2;
  for (let i = 0; i < prepared.length; i++) totalBytes += prepared[i].cell.length;

  if (totalBytes <= pageSize) {
    const rootNum = nextPageNum;
    const leaf = buildSqliteLeafPage(pageSize, 0, prepared.map((p) => p.cell));
    return { rootPageNum: rootNum, pages: [{ num: rootNum, bytes: leaf }], nextPageNum: nextPageNum + 1 };
  }

  const rootNum = nextPageNum++;
  const leafGroups = [];
  let curGroup = [];
  let curUsed = 8;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const needed = 2 + p.cell.length;
    if (curGroup.length > 0 && curUsed + needed > pageSize - 64) {
      leafGroups.push(curGroup);
      curGroup = [];
      curUsed = 8;
    }
    curGroup.push(p);
    curUsed += needed;
  }
  if (curGroup.length > 0) leafGroups.push(curGroup);

  const leafPages = leafGroups.map((grp) => {
    const pNum = nextPageNum++;
    const maxKey = grp[grp.length - 1].rowid;
    return {
      num: pNum,
      maxKey,
      bytes: buildSqliteLeafPage(pageSize, 0, grp.map((x) => x.cell))
    };
  });

  const interiorCells = [];
  for (let i = 0; i < leafPages.length - 1; i++) {
    interiorCells.push(encodeTableInteriorCell(leafPages[i].num, leafPages[i].maxKey));
  }
  const rightMost = leafPages[leafPages.length - 1].num;
  const rootBytes = buildSqliteInteriorPage(pageSize, interiorCells, rightMost);

  return {
    rootPageNum: rootNum,
    pages: [{ num: rootNum, bytes: rootBytes }].concat(leafPages.map((lp) => ({ num: lp.num, bytes: lp.bytes }))),
    nextPageNum
  };
}

function sha1Uint32PrefixAnki(str) {
  const msg = utf8EncodeAnki(str);
  const ml = msg.length * 8;
  const withOne = msg.length + 1;
  const padLen = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, ml >>> 0, false);
  dv.setUint32(total - 8, Math.floor(ml / 4294967296) >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return h0 >>> 0;
}

function makeAnkiNoteGuid(seedStr) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  const bytes = utf8EncodeAnki(seedStr);
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 167777619) >>> 0;
    h2 = Math.imul(h2 ^ ((bytes[i] + i) & 0xff), 2246822519) >>> 0;
  }
  let out = '';
  let cur = (BigInt(h1) << 32n) | BigInt(h2);
  for (let i = 0; i < 10; i++) {
    const idx = Number(cur % BigInt(alphabet.length));
    out += alphabet[idx];
    cur = (cur / BigInt(alphabet.length)) ^ BigInt((i + 1) * 0x45d9f3b);
    if (cur < 0n) cur = -cur;
  }
  return out;
}

function escapeAnkiFieldHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>');
}

function buildAnkiCollectionSqliteBytes(deckName, vocabItems) {
  const PAGE_SIZE = 16384; // 16 KB pages -> supports long definitions and fast multi-page B-trees
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const cleanDeckName = (deckName || 'AnkiSuru Manga Vocabulary').trim() || 'AnkiSuru Manga Vocabulary';

  const modelId = 1731910401;
  const deckId = 1731910402;

  const cardCss = [
    '.card { font-family: "Roboto", "Noto Sans JP", -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; color: #202124; background-color: #ffffff; padding: 28px 20px; line-height: 1.5; }',
    '.nightMode.card, .night_mode .card { color: #e8eaed; background-color: #1e1f22; }',
    '.anki-front { padding: 18px 0 12px; }',
    '.kanji { font-family: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; font-size: 44px; font-weight: 700; letter-spacing: 0.03em; }',
    'hr#answer { border: 0; border-top: 1px solid #dadce0; margin: 18px auto; max-width: 360px; }',
    '.nightMode hr#answer, .night_mode hr#answer { border-top-color: #3c4043; }',
    '.anki-back { max-width: 480px; margin: 0 auto; }',
    '.romaji { font-size: 22px; font-weight: 600; color: #1a73e8; margin-bottom: 10px; }',
    '.nightMode .romaji, .night_mode .romaji { color: #8ab4f8; }',
    '.meaning { font-size: 20px; font-weight: 500; color: #202124; }',
    '.nightMode .meaning, .night_mode .meaning { color: #e8eaed; }'
  ].join('\n');

  const modelsObj = {};
  modelsObj[String(modelId)] = {
    id: modelId,
    name: 'AnkiSuru Kanji Vocab',
    type: 0,
    mod: nowSec,
    usn: -1,
    sortf: 0,
    did: null,
    tmpls: [
      {
        name: 'Kanji -> Romaji & Meaning',
        ord: 0,
        qfmt: '<div class="anki-front"><div class="kanji">{{Kanji}}</div></div>',
        afmt: '{{FrontSide}}<hr id="answer"><div class="anki-back"><div class="romaji">{{Romaji}}</div><div class="meaning">{{Meaning}}</div></div>',
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0
      }
    ],
    flds: [
      { name: 'Kanji', ord: 0, sticky: false, rtl: false, font: 'Noto Sans JP', size: 28, media: [], description: '' },
      { name: 'Romaji', ord: 1, sticky: false, rtl: false, font: 'Roboto', size: 18, media: [], description: '' },
      { name: 'Meaning', ord: 2, sticky: false, rtl: false, font: 'Roboto', size: 18, media: [], description: '' }
    ],
    css: cardCss,
    latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'any', [0]]],
    tags: [],
    vers: []
  };

  const decksObj = {
    '1': {
      id: 1, mod: nowSec, name: 'Default', usn: 0,
      lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1,
      extendNew: 10, extendRev: 50
    }
  };
  decksObj[String(deckId)] = {
    id: deckId, mod: nowSec, name: cleanDeckName, usn: -1,
    lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    collapsed: false, browserCollapsed: false, desc: 'Generated by AnkiSuru Manga Reader',
    dyn: 0, conf: 1, extendNew: 20, extendRev: 100
  };

  const dconfObj = {
    '1': {
      id: 1, mod: 0, name: 'Default', usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
      dyn: false
    }
  };

  const confObj = {
    nextPos: 1, estTimes: true, activeDecks: [1, deckId], sortType: 'noteFld',
    timeLim: 0, sortBackwards: false, addToCur: true, curDeck: deckId,
    newBury: true, newSpread: 0, dueCounts: true, curModel: String(modelId), collapseTime: 1200
  };

  const colRows = [{
    rowid: 1,
    cols: [
      { type: 'null' },
      { type: 'int', value: nowSec },
      { type: 'int', value: nowMs },
      { type: 'int', value: nowMs },
      { type: 'int', value: 11 },
      { type: 'int', value: 0 },
      { type: 'int', value: 0 },
      { type: 'int', value: 0 },
      { type: 'text', value: JSON.stringify(confObj) },
      { type: 'text', value: JSON.stringify(modelsObj) },
      { type: 'text', value: JSON.stringify(decksObj) },
      { type: 'text', value: JSON.stringify(dconfObj) },
      { type: 'text', value: '{}' }
    ]
  }];

  const noteRows = [];
  const cardRows = [];
  vocabItems.forEach((item, idx) => {
    const noteId = nowMs + idx * 2 + 1;
    const cardId = nowMs + idx * 2 + 2;
    const kanjiRaw = String(item.kanji || item.surface || '').trim().slice(0, 500);
    const romajiRaw = (String(item.romaji || '').trim() || computeInstantWordRomaji(kanjiRaw, item.reading)).slice(0, 1000);
    const meaningRaw = String(item.meaning || '').trim().slice(0, 2000);
    const flds = escapeAnkiFieldHtml(kanjiRaw) + '\x1f' + escapeAnkiFieldHtml(romajiRaw) + '\x1f' + escapeAnkiFieldHtml(meaningRaw);
    const guid = makeAnkiNoteGuid(cleanDeckName + '::' + kanjiRaw + '::' + idx);
    const csum = sha1Uint32PrefixAnki(kanjiRaw);

    noteRows.push({
      rowid: noteId,
      cols: [
        { type: 'null' },
        { type: 'text', value: guid },
        { type: 'int', value: modelId },
        { type: 'int', value: nowSec },
        { type: 'int', value: -1 },
        { type: 'text', value: ' ankisuru ' },
        { type: 'text', value: flds },
        { type: 'text', value: kanjiRaw },
        { type: 'int', value: csum },
        { type: 'int', value: 0 },
        { type: 'text', value: '' }
      ]
    });

    cardRows.push({
      rowid: cardId,
      cols: [
        { type: 'null' },
        { type: 'int', value: noteId },
        { type: 'int', value: deckId },
        { type: 'int', value: 0 },
        { type: 'int', value: nowSec },
        { type: 'int', value: -1 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: idx + 1 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'int', value: 0 },
        { type: 'text', value: '' }
      ]
    });
  });

  let nextPageNum = 2;
  const colAlloc = allocateSqliteTablePages(PAGE_SIZE, colRows, nextPageNum);
  nextPageNum = colAlloc.nextPageNum;
  const notesAlloc = allocateSqliteTablePages(PAGE_SIZE, noteRows, nextPageNum);
  nextPageNum = notesAlloc.nextPageNum;
  const cardsAlloc = allocateSqliteTablePages(PAGE_SIZE, cardRows, nextPageNum);
  nextPageNum = cardsAlloc.nextPageNum;
  const revlogAlloc = allocateSqliteTablePages(PAGE_SIZE, [], nextPageNum);
  nextPageNum = revlogAlloc.nextPageNum;
  const gravesAlloc = allocateSqliteTablePages(PAGE_SIZE, [], nextPageNum);
  nextPageNum = gravesAlloc.nextPageNum;

  const schemaDefs = [
    ['table', 'col', 'col', colAlloc.rootPageNum, 'CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)'],
    ['table', 'notes', 'notes', notesAlloc.rootPageNum, 'CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)'],
    ['table', 'cards', 'cards', cardsAlloc.rootPageNum, 'CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)'],
    ['table', 'revlog', 'revlog', revlogAlloc.rootPageNum, 'CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)'],
    ['table', 'graves', 'graves', gravesAlloc.rootPageNum, 'CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)']
  ];

  const schemaCells = schemaDefs.map((def, idx) =>
    encodeTableLeafCell(idx + 1, encodeSqliteRecord([
      { type: 'text', value: def[0] },
      { type: 'text', value: def[1] },
      { type: 'text', value: def[2] },
      { type: 'int', value: def[3] },
      { type: 'text', value: def[4] }
    ]))
  );

  const page1 = buildSqliteLeafPage(PAGE_SIZE, 100, schemaCells);
  const totalPages = nextPageNum - 1;

  page1.set(utf8EncodeAnki('SQLite format 3\0'), 0);
  const hdrDv = new DataView(page1.buffer);
  hdrDv.setUint16(16, PAGE_SIZE, false);
  page1[18] = 1;
  page1[19] = 1;
  page1[20] = 0;
  page1[21] = 64;
  page1[22] = 32;
  page1[23] = 32;
  hdrDv.setUint32(24, 1, false);
  hdrDv.setUint32(28, totalPages, false);
  hdrDv.setUint32(32, 0, false);
  hdrDv.setUint32(36, 0, false);
  hdrDv.setUint32(40, 1, false);
  hdrDv.setUint32(44, 4, false);
  hdrDv.setUint32(56, 1, false);
  hdrDv.setUint32(92, 1, false);
  hdrDv.setUint32(96, 3039000, false);

  const dbBytes = new Uint8Array(totalPages * PAGE_SIZE);
  dbBytes.set(page1, 0);
  const allOtherPages = []
    .concat(colAlloc.pages, notesAlloc.pages, cardsAlloc.pages, revlogAlloc.pages, gravesAlloc.pages);
  for (let i = 0; i < allOtherPages.length; i++) {
    const p = allOtherPages[i];
    dbBytes.set(p.bytes, (p.num - 1) * PAGE_SIZE);
  }
  return dbBytes;
}

const ANKI_CRC32_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32AnkiBytes(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = ANKI_CRC32_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRawAnkiIfSupported(u8) {
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(u8);
      writer.close();
      const chunks = [];
      const reader = cs.readable.getReader();
      let total = 0;
      while (true) {
        const res = await reader.read();
        if (res.done) break;
        chunks.push(res.value);
        total += res.value.byteLength;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (let i = 0; i < chunks.length; i++) {
        out.set(chunks[i], off);
        off += chunks[i].byteLength;
      }
      return { method: 8, data: out };
    } catch (_e) {}
  }
  return { method: 0, data: u8 };
}

async function buildAnkiZipBytes(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    const nameBytes = utf8EncodeAnki(ent.name);
    const raw = ent.data;
    const crc = crc32AnkiBytes(raw);
    const comp = await deflateRawAnkiIfSupported(raw);

    const lhdr = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lhdr.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);
    ldv.setUint16(8, comp.method, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0x21, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, comp.data.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lhdr.set(nameBytes, 30);

    const chdr = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(chdr.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, comp.method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x21, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, comp.data.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, localOffset, true);
    chdr.set(nameBytes, 46);

    localParts.push(lhdr, comp.data);
    centralParts.push(chdr);
    localOffset += lhdr.length + comp.data.length;
  }

  let centralSize = 0;
  for (let i = 0; i < centralParts.length; i++) centralSize += centralParts[i].length;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, localOffset, true);
  edv.setUint16(20, 0, true);

  const out = new Uint8Array(localOffset + centralSize + 22);
  let pos = 0;
  for (let i = 0; i < localParts.length; i++) {
    out.set(localParts[i], pos);
    pos += localParts[i].length;
  }
  for (let i = 0; i < centralParts.length; i++) {
    out.set(centralParts[i], pos);
    pos += centralParts[i].length;
  }
  out.set(eocd, pos);
  return out;
}

async function generateAnkiApkgUint8Array(deckName, vocabItems) {
  const dbBytes = buildAnkiCollectionSqliteBytes(deckName, vocabItems);
  return buildAnkiZipBytes([
    { name: 'collection.anki2', data: dbBytes },
    { name: 'media', data: utf8EncodeAnki('{}') }
  ]);
}

function buildAnkiTxtDeckString(deckName, vocabItems) {
  const cleanDeck = (deckName || 'AnkiSuru Manga Vocabulary').trim().replace(/[\r\n\t]+/g, ' ') || 'AnkiSuru Manga Vocabulary';
  const lines = [
    '#separator:tab',
    '#html:true',
    '#deck:' + cleanDeck,
    '#notetype:Basic',
    '#columns:Front\tBack'
  ];
  vocabItems.forEach((item) => {
    const front = escapeAnkiFieldHtml(String(item.kanji || '').trim()).replace(/\t/g, ' ');
    const rom = escapeAnkiFieldHtml(String(item.romaji || '').trim() || computeInstantWordRomaji(item.kanji, item.reading)).replace(/\t/g, ' ');
    const mean = escapeAnkiFieldHtml(String(item.meaning || '').trim()).replace(/\t/g, ' ');
    const back = '<div class="romaji"><strong>' + rom + '</strong></div><div class="meaning">' + mean + '</div>';
    lines.push(front + '\t' + back);
  });
  return lines.join('\n') + '\n';
}

function sanitizeDeckFilename(deckName) {
  const base = String(deckName || 'ankisuru_vocab')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 64);
  return base || 'ankisuru_vocab';
}

async function exportSavedVocabAsAnkiApkg() {
  if (!Array.isArray(state.savedVocab) || state.savedVocab.length === 0) {
    showToast('Save at least one vocabulary word before generating an Anki deck.', 'warn');
    return null;
  }
  if (state.isExportingAnki) return null;
  state.isExportingAnki = true;
  if (state.activeTab === 'vocab' && typeof renderSavedVocabPanel === 'function') {
    renderSavedVocabPanel();
  }

  try {
    const deckName = (state.vocabDeckName || 'AnkiSuru Manga Vocabulary').trim() || 'AnkiSuru Manga Vocabulary';
    const fileName = sanitizeDeckFilename(deckName) + '.apkg';
    let apkgBytes = null;

    if (state.nativeBackend && state.nativeBackend.connected && state.nativeBackend.url) {
      try {
        const resp = await fetch(state.nativeBackend.url.replace(/\/+$/, '') + '/api/export_anki_apkg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deck_name: deckName,
            cards: state.savedVocab.map((it) => ({
              kanji: it.kanji || '',
              romaji: it.romaji || computeInstantWordRomaji(it.kanji, it.reading),
              meaning: it.meaning || ''
            }))
          })
        });
        if (resp.ok) {
          apkgBytes = new Uint8Array(await resp.arrayBuffer());
        }
      } catch (_srvErr) {
        apkgBytes = null;
      }
    }

    if (!apkgBytes) {
      apkgBytes = await generateAnkiApkgUint8Array(deckName, state.savedVocab);
    }

    if (typeof triggerBlobDownload === 'function') {
      triggerBlobDownload(fileName, 'application/octet-stream', apkgBytes);
    }
    showToast('Generated Anki deck "' + fileName + '" (' + state.savedVocab.length + ' card' + (state.savedVocab.length === 1 ? '' : 's') + ')!');
    return apkgBytes;
  } catch (err) {
    showToast('Anki deck generation failed: ' + (err ? err.message : 'Unknown error'), 'error');
    return null;
  } finally {
    state.isExportingAnki = false;
    if (state.activeTab === 'vocab' && typeof renderSavedVocabPanel === 'function') {
      renderSavedVocabPanel();
    }
  }
}

function exportSavedVocabAsAnkiTxt() {
  if (!Array.isArray(state.savedVocab) || state.savedVocab.length === 0) {
    showToast('Save at least one vocabulary word before exporting.', 'warn');
    return '';
  }
  const deckName = (state.vocabDeckName || 'AnkiSuru Manga Vocabulary').trim() || 'AnkiSuru Manga Vocabulary';
  const txt = buildAnkiTxtDeckString(deckName, state.savedVocab);
  const fileName = sanitizeDeckFilename(deckName) + '_anki.txt';
  if (typeof triggerBlobDownload === 'function') {
    triggerBlobDownload(fileName, 'text/tab-separated-values;charset=utf-8', txt);
  }
  showToast('Downloaded Anki import file "' + fileName + '"!');
  return txt;
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
