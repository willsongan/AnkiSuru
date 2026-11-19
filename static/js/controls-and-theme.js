"use strict";

// -----------------------------------------------------------------------
// Interactive Manual Box Drawing on Manga Page Stage
// -----------------------------------------------------------------------
let dragStart = null;

async function setBatchSelectMode(enabled) {
  const next = Boolean(enabled);
  if (next) {
    if (state.drawMode) setDrawMode(false);
    if (state.liveTextMode) {
      state.liveTextMode = false;
      state.livePopupBlockId = null;
      if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');
    }
    state.batchSelectMode = true;
    const page = getSelectedPage();
    if (page && !isPageAlreadyExtracted(page)) {
      if (state.isSampleSet && typeof populateSampleGroundTruthForPage === 'function') {
        populateSampleGroundTruthForPage(page);
        page.ocrCompleted = true;
        updatePageCardInPlace(page);
      } else if (!state.isExtracting) {
        syncBoxesToggleUI();
        renderOverlayBoxes();
        renderBatchStudyDock();
        showToast('Extracting Japanese text on this page for Batch Select…');
        await extractPagesQueue([page]);
        return;
      }
    }
  } else {
    state.batchSelectMode = false;
  }
  syncBoxesToggleUI();
  renderOverlayBoxes();
  renderRightPanel();
  renderBatchStudyDock();
}

async function setLiveTextMode(enabled) {
  const next = Boolean(enabled);
  if (next && state.drawMode) {
    state.drawMode = false;
    el.drawModeBanner.classList.add('hidden');
    el.stageImageWrapper.style.cursor = 'default';
    el.btnDrawBoxMode.classList.remove('is-danger-active');
    el.btnDrawBoxMode.setAttribute('data-tip', 'Draw Box');
    el.rubberBandBox.classList.add('hidden');
    dragStart = null;
  }
  if (next && state.batchSelectMode) {
    state.batchSelectMode = false;
  }
  state.liveTextMode = next;
  if (!next) state.livePopupBlockId = null;
  if (next) {
    const page = getSelectedPage();
    if (state.selectedBlockId && (!page || !(page.blocks || []).some((b) => b.id === state.selectedBlockId))) {
      state.selectedBlockId = null;
    }
    if (page && !isPageAlreadyExtracted(page)) {
      if (state.isSampleSet && typeof populateSampleGroundTruthForPage === 'function') {
        populateSampleGroundTruthForPage(page);
        page.ocrCompleted = true;
        updatePageCardInPlace(page);
        renderRightPanel();
      } else if (!state.isExtracting) {
        syncBoxesToggleUI();
        renderOverlayBoxes();
        showToast('Extracting Japanese text on this page so you can select & copy it…');
        await extractPagesQueue([page]);
        return;
      }
    }
  } else {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel) sel.removeAllRanges();
    } catch (_e) {}
  }
  syncBoxesToggleUI();
  renderOverlayBoxes();
  renderRightPanel();
}

function setDrawMode(enabled) {
  if (enabled && state.liveTextMode) {
    state.liveTextMode = false;
  }
  if (enabled && state.batchSelectMode) {
    state.batchSelectMode = false;
  }
  state.drawMode = enabled;
  el.drawModeBanner.classList.toggle('hidden', !enabled);
  el.stageImageWrapper.style.cursor = enabled ? 'crosshair' : 'default';
  el.btnDrawBoxMode.classList.toggle('is-danger-active', Boolean(enabled));
  el.btnDrawBoxMode.setAttribute('data-tip', enabled ? 'Exit Draw Mode' : 'Draw Box');
  if (enabled) {
    state.showBoxes = true;
    syncBoxesToggleUI();
    renderOverlayBoxes();
  } else {
    el.rubberBandBox.classList.add('hidden');
    dragStart = null;
    syncBoxesToggleUI();
    renderOverlayBoxes();
  }
}

function stagePointerCoords(clientX, clientY) {
  const rect = el.stageImageWrapper.getBoundingClientRect();
  const rx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const ry = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  return { rx, ry };
}

el.stageImageWrapper.addEventListener('pointerdown', (ev) => {
  if (state.liveTextMode) {
    if (
      (state.livePopupBlockId || state.selectedBlockId) &&
      !ev.target.closest('[data-live-text]') &&
      !ev.target.closest('#liveSelectionCard') &&
      !ev.target.closest('button, input, textarea, select, a')
    ) {
      closeLiveBubblePopup();
    }
    return;
  }
  if (!state.drawMode) {
    if (state.selectedBlockId && !ev.target.closest('[data-bbox-id]')) {
      state.selectedBlockId = null;
      renderOverlayBoxes();
      renderRightPanel();
    }
    return;
  }
  if (state.isExtracting) return;
  const page = getSelectedPage();
  if (!page) return;
  ev.preventDefault();
  el.stageImageWrapper.setPointerCapture(ev.pointerId);
  dragStart = stagePointerCoords(ev.clientX, ev.clientY);
  el.rubberBandBox.style.left = (dragStart.rx * 100) + '%';
  el.rubberBandBox.style.top = (dragStart.ry * 100) + '%';
  el.rubberBandBox.style.width = '0%';
  el.rubberBandBox.style.height = '0%';
  el.rubberBandBox.classList.remove('hidden');
});

el.stageImageWrapper.addEventListener('pointermove', (ev) => {
  if (!dragStart || !state.drawMode) return;
  const cur = stagePointerCoords(ev.clientX, ev.clientY);
  const left = Math.min(dragStart.rx, cur.rx);
  const top = Math.min(dragStart.ry, cur.ry);
  const w = Math.abs(cur.rx - dragStart.rx);
  const h = Math.abs(cur.ry - dragStart.ry);
  el.rubberBandBox.style.left = (left * 100) + '%';
  el.rubberBandBox.style.top = (top * 100) + '%';
  el.rubberBandBox.style.width = (w * 100) + '%';
  el.rubberBandBox.style.height = (h * 100) + '%';
});

el.stageImageWrapper.addEventListener('pointerup', async (ev) => {
  if (!dragStart || !state.drawMode) return;
  const cur = stagePointerCoords(ev.clientX, ev.clientY);
  const start = dragStart;
  dragStart = null;
  el.rubberBandBox.classList.add('hidden');

  const page = getSelectedPage();
  if (!page) return;

  const x1 = Math.round(Math.min(start.rx, cur.rx) * page.width);
  const y1 = Math.round(Math.min(start.ry, cur.ry) * page.height);
  const x2 = Math.round(Math.max(start.rx, cur.rx) * page.width);
  const y2 = Math.round(Math.max(start.ry, cur.ry) * page.height);
  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  const newBlk = {
    id: 'blk_' + Math.random().toString(36).slice(2, 9),
    x1,
    y1,
    x2,
    y2,
    conf: 1.0,
    isManual: true,
    text: '',
    charConf: null
  };
  page.blocks.push(newBlk);
  page.boxesDetected = true;
  page.blocks = sortBlocksByReadingOrder(page.blocks, state.readingOrder);
  state.selectedBlockId = newBlk.id;
  setActiveTab('bubbles');
  renderAll();

  // Automatically run OCR on the newly drawn bubble
  try {
    state.abortRequested = false;
    setExtractingUI(true);
    setProgress(true, 'Recognizing custom drawn speech bubble…', 50);
    const im = await loadImageElement(page.url);
    const target = page.blocks.find((b) => b.id === newBlk.id);
    if (target) {
      const res = await recognizeSingleBlock(im, target);
      target.text = res.text;
      target.charConf = normalizeConf01(res.charConf);
      target.ocrAttempted = true;
      target.verified = false;
      page.status = 'done';
      page.ocrCompleted = true;
      updatePageFullText(page);
    }
    setProgress(false);
    showToast('Extracted custom bubble!');
  } catch (err) {
    setProgress(false);
    if (!err || err.message !== 'ABORTED') {
      showToast('Custom box OCR error: ' + (err ? err.message : ''), 'error');
    }
  } finally {
    setExtractingUI(false);
    renderAll();
  }
});

// -----------------------------------------------------------------------
// Downloads (.TXT and Mokuro-style .JSON)
// -----------------------------------------------------------------------
function triggerBlobDownload(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// -----------------------------------------------------------------------
// Wire All Event Listeners
// -----------------------------------------------------------------------
let suppressOutsideSettingsCloseUntil = 0;

function updateSettingsHelperTexts() {
  if (state.detectorMode !== 'rtdetr-int8' && state.detectorMode !== 'ctd-onnx') {
    state.detectorMode = 'rtdetr-int8';
    if (el.selectDetector) el.selectDetector.value = 'rtdetr-int8';
  }
  if (state.ocrEngine !== 'manga-ocr-cpt') {
    state.ocrEngine = 'manga-ocr-cpt';
    if (el.selectOcrEngine) el.selectOcrEngine.value = 'manga-ocr-cpt';
  }
  if (el.helperDetector) {
    el.helperDetector.textContent = state.detectorMode === 'ctd-onnx'
      ? '95 MB · WebGPU'
      : '11 MB INT8 · Default';
  }
  if (el.helperOcrEngine) {
    el.helperOcrEngine.textContent = '0.86% CER · JP-only';
  }
  if (el.helperReadingOrder) {
    el.helperReadingOrder.textContent = state.readingOrder === 'rtl'
      ? 'Right → Left'
      : state.readingOrder === 'ttb'
      ? 'Top → Bottom'
      : 'Left → Right';
  }
  if (el.helperWorkerPool) {
    el.helperWorkerPool.textContent = state.workerPoolSetting === 'auto'
      ? 'Auto (' + DEFAULT_DET_WORKERS + ' threads)'
      : state.workerPoolSetting === '1'
      ? '1 thread · Low RAM'
      : state.workerPoolSetting + ' threads';
  }
  if (el.chkAutoPruneNonJp && el.chkAutoPruneNonJp.parentElement) {
    el.chkAutoPruneNonJp.parentElement.classList.toggle('is-checked', Boolean(state.autoPruneNonJp));
  }
}

function updateSettingsSummaryChip() {
  updateSettingsHelperTexts();
  const geminiSuffix = (state.gemini && state.gemini.apiKey) ? ' · AI' : '';
  if (state.nativeBackend.connected) {
    const acc = (state.nativeBackend.info && state.nativeBackend.info.accelerator) || 'Server';
    el.settingsSummaryChip.textContent = acc + ' · ' + state.readingOrder.toUpperCase() + geminiSuffix;
    return;
  }
  const detShort = state.detectorMode === 'ctd-onnx' ? 'Mokuro CTD' : 'RT-DETRv2';
  const wCount = state.workerPoolSetting === 'auto'
    ? DEFAULT_DET_WORKERS + 'x'
    : state.workerPoolSetting + 'x';
  el.settingsSummaryChip.textContent = wCount + ' · ' + detShort + ' · ' + state.readingOrder.toUpperCase() + geminiSuffix;
}

function setSettingsOpen(open) {
  el.settingsPopover.classList.toggle('hidden', !open);
  el.btnToggleSettings.classList.toggle('is-open', Boolean(open));
}

el.btnToggleSettings.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const isHidden = el.settingsPopover.classList.contains('hidden');
  setSettingsOpen(isHidden);
});
el.btnCloseSettings.addEventListener('click', () => setSettingsOpen(false));
document.addEventListener('click', (ev) => {
  if (performance.now() < suppressOutsideSettingsCloseUntil) return;
  if (!el.settingsPopover.classList.contains('hidden')) {
    if (!el.settingsPopover.contains(ev.target) && !el.btnToggleSettings.contains(ev.target)) {
      setSettingsOpen(false);
    }
  }
});

el.btnEmptyUploadFolder.addEventListener('click', () => el.folderInput.click());
el.btnDropzoneFolder.addEventListener('click', (ev) => {
  ev.stopPropagation();
  el.folderInput.click();
});
el.btnEmptyUploadFiles.addEventListener('click', () => el.filesInput.click());
el.sidebarDropTarget.addEventListener('click', (ev) => {
  if (ev.target.closest('button')) return;
  el.filesInput.click();
});

el.folderInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files.length > 0) {
    await ingestFileList(e.target.files);
    e.target.value = '';
  }
});

el.filesInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files.length > 0) {
    await ingestFileList(e.target.files);
    e.target.value = '';
  }
});

el.btnSidebarSamples.addEventListener('click', () => loadBuiltInSamples());
el.btnEmptyLoadSamples.addEventListener('click', () => loadBuiltInSamples());

el.btnClearPages.addEventListener('click', () => {
  if (state.isExtracting) return;
  revokeAllPages();
  state.pages = [];
  state.selectedPageId = null;
  state.selectedBlockId = null;
  state.isSampleSet = false;
  renderAll();
});

// Prevent accidental browser tab navigation when dropping outside the designated drop area
window.addEventListener('dragover', (ev) => {
  if (!el.sidebarDropTarget.contains(ev.target)) {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
  }
});
window.addEventListener('drop', (ev) => {
  if (!el.sidebarDropTarget.contains(ev.target)) {
    ev.preventDefault();
  }
});

// Scoped Drag-and-Drop ONLY on Left Sidebar "Drop Folder or Images" Designated Area
el.sidebarDropTarget.addEventListener('dragenter', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (state.isExtracting) return;
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  el.sidebarDropTarget.classList.add('dropzone-active');
});

el.sidebarDropTarget.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (state.isExtracting) return;
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  el.sidebarDropTarget.classList.add('dropzone-active');
});

el.sidebarDropTarget.addEventListener('dragleave', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  if (!el.sidebarDropTarget.contains(ev.relatedTarget)) {
    el.sidebarDropTarget.classList.remove('dropzone-active');
  }
});

el.sidebarDropTarget.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  el.sidebarDropTarget.classList.remove('dropzone-active');
  if (state.isExtracting || !ev.dataTransfer) return;

  // Capture synchronous snapshot immediately before any await
  const snap = snapshotDataTransferSync(ev.dataTransfer);
  const { files, sawDirectory } = await resolveDroppedSnapshot(snap);
  if (files.length === 0 && sawDirectory) {
    showToast('Browser sandbox restricted reading inside the dropped folder — click "Browse Folder" to load it.', 'warn');
    return;
  }
  await ingestFileList(files);
});

// Toolbar Delete Box Button & Keyboard Manipulation (Move, Resize, Delete, Cycle)
el.btnDeleteSelectedBox.addEventListener('click', () => {
  const page = getSelectedPage();
  if (page && state.selectedBlockId) {
    deleteBlockById(page, state.selectedBlockId);
  }
});

window.addEventListener('keydown', (ev) => {
  const activeTag = document.activeElement ? document.activeElement.tagName : '';
  const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' ||
    (document.activeElement && document.activeElement.isContentEditable);

  if (ev.key === 'Escape') {
    if (!el.stackModal.classList.contains('hidden')) {
      el.stackModal.classList.add('hidden');
      return;
    }
    if (!el.settingsPopover.classList.contains('hidden')) {
      setSettingsOpen(false);
      return;
    }
    if (state.drawMode) {
      setDrawMode(false);
      return;
    }
    if (state.batchStudyExpanded && state.batchStudyResult) {
      state.batchStudyExpanded = false;
      renderBatchStudyDock();
      return;
    }
    if (state.batchSelectMode) {
      setBatchSelectMode(false);
      return;
    }
    if (state.liveTextMode) {
      const subSel = typeof getPopupHighlightedSubstring === 'function' ? getPopupHighlightedSubstring() : '';
      if (subSel && window.getSelection) {
        window.getSelection().removeAllRanges();
        syncLiveSelectionUI();
        return;
      }
      if (state.livePopupBlockId) {
        closeLiveBubblePopup();
        return;
      }
      if (!state.isViewerFullscreen) {
        state.showBoxes = true;
        setLiveTextMode(false);
        return;
      }
    }
    if (state.isViewerFullscreen) {
      setViewerFullscreen(false);
      return;
    }
    if (state.isExtracting) {
      triggerImmediateStop();
      return;
    }
    if (!isTyping && state.selectedBlockId) {
      state.selectedBlockId = null;
      renderOverlayBoxes();
      renderRightPanel();
      return;
    }
  }

  if (isTyping || !el.stackModal.classList.contains('hidden')) return;

  // Manga Reader Zoom Shortcuts (+ / =, - / _, 0; also intercept Ctrl/Cmd +/-/0 while in Website Fullscreen)
  if (!ev.altKey && (!ev.ctrlKey && !ev.metaKey || state.isViewerFullscreen)) {
    if (ev.key === '+' || ev.key === '=') {
      ev.preventDefault();
      wakeFullscreenHud();
      stepStageZoom(1);
      return;
    }
    if (ev.key === '-' || ev.key === '_') {
      ev.preventDefault();
      wakeFullscreenHud();
      stepStageZoom(-1);
      return;
    }
    if (ev.key === '0') {
      ev.preventDefault();
      wakeFullscreenHud();
      resetStageZoomToFit();
      return;
    }
  }

  // Reader & Rapid-Review Keyboard Shortcuts: F = Fullscreen, S = Select Text, R = Review Tab, N/P = Next/Prev <90%
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault();
      setViewerFullscreen(!state.isViewerFullscreen);
      return;
    }
    if (ev.key === 's' || ev.key === 'S') {
      ev.preventDefault();
      setLiveTextMode(!state.liveTextMode);
      return;
    }
    if (ev.key === 'b' || ev.key === 'B') {
      ev.preventDefault();
      setBatchSelectMode(!state.batchSelectMode);
      return;
    }
    if (!state.isViewerFullscreen && (ev.key === 'r' || ev.key === 'R')) {
      ev.preventDefault();
      openReviewAndFocusFirst();
      return;
    }
    if (!state.isViewerFullscreen && (ev.key === 'v' || ev.key === 'V')) {
      ev.preventDefault();
      setActiveTab('vocab');
      return;
    }
    if (!state.isViewerFullscreen && state.activeTab === 'vocab' && state.vocabViewMode === 'cards' && state.savedVocab.length > 0 && ev.key === ' ') {
      ev.preventDefault();
      state.vocabCardFlipped = !state.vocabCardFlipped;
      renderSavedVocabPanel();
      return;
    }
    if (ev.key === 'n' || ev.key === 'N') {
      ev.preventDefault();
      jumpToLowConfidenceByStep(1);
      return;
    }
    if (ev.key === 'p' || ev.key === 'P') {
      ev.preventDefault();
      jumpToLowConfidenceByStep(-1);
      return;
    }
  }

  // Manga Reader Keyboard Navigation (PageDown/PageUp/[/] anytime; Left/Right when no box is selected)
  if (state.pages.length > 1 && !state.drawMode) {
    if (ev.key === 'PageDown' || ev.key === ']') {
      ev.preventDefault();
      goToPageByOffset(1, { animateSlide: true });
      return;
    }
    if (ev.key === 'PageUp' || ev.key === '[') {
      ev.preventDefault();
      goToPageByOffset(-1, { animateSlide: true });
      return;
    }
    const hasHorizZoomOverflow = !state.fitMode && el.viewerViewport &&
      (el.viewerViewport.scrollWidth > el.viewerViewport.clientWidth + 8);
    if (!state.selectedBlockId && !hasHorizZoomOverflow && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        goToPageByOffset(1, { animateSlide: true });
        return;
      }
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        goToPageByOffset(-1, { animateSlide: true });
        return;
      }
    }
  }

  if (state.isExtracting) return;

  const page = getSelectedPage();
  if (!page || !page.blocks || page.blocks.length === 0) return;

  // Cycle boxes with Tab / Shift+Tab when a box is selected
  if (ev.key === 'Tab' && state.selectedBlockId) {
    ev.preventDefault();
    const curIdx = page.blocks.findIndex((b) => b.id === state.selectedBlockId);
    const nextIdx = ev.shiftKey
      ? (curIdx <= 0 ? page.blocks.length - 1 : curIdx - 1)
      : (curIdx + 1) % page.blocks.length;
    state.selectedBlockId = page.blocks[nextIdx].id;
    renderOverlayBoxes();
    renderRightPanel();
    return;
  }

  if (!state.selectedBlockId) return;
  const blk = page.blocks.find((b) => b.id === state.selectedBlockId);
  if (!blk) return;

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    deleteBlockById(page, blk.id);
    showToast('Deleted detector box');
    return;
  }

  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    const step = ev.shiftKey ? 16 : 4;
    const minSize = 12;
    const W = page.width;
    const H = page.height;

    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      // Alt + Arrow resizes width / height
      if (ev.key === 'ArrowRight') blk.x2 = Math.min(W, blk.x2 + step);
      if (ev.key === 'ArrowLeft') blk.x2 = Math.max(blk.x1 + minSize, blk.x2 - step);
      if (ev.key === 'ArrowDown') blk.y2 = Math.min(H, blk.y2 + step);
      if (ev.key === 'ArrowUp') blk.y2 = Math.max(blk.y1 + minSize, blk.y2 - step);
    } else {
      // Arrow moves box
      const bw = blk.x2 - blk.x1;
      const bh = blk.y2 - blk.y1;
      if (ev.key === 'ArrowLeft') {
        blk.x1 = Math.max(0, blk.x1 - step);
        blk.x2 = blk.x1 + bw;
      } else if (ev.key === 'ArrowRight') {
        blk.x1 = Math.min(W - bw, blk.x1 + step);
        blk.x2 = blk.x1 + bw;
      } else if (ev.key === 'ArrowUp') {
        blk.y1 = Math.max(0, blk.y1 - step);
        blk.y2 = blk.y1 + bh;
      } else if (ev.key === 'ArrowDown') {
        blk.y1 = Math.min(H - bh, blk.y1 + step);
        blk.y2 = blk.y1 + bh;
      }
    }

    renderOverlayBoxes();
    renderRightPanel();
  }
});

// Dropdown Controls
el.selectDetector.addEventListener('change', () => {
  state.detectorMode = el.selectDetector.value;
  updateSettingsSummaryChip();
});
el.selectOcrEngine.addEventListener('change', () => {
  state.ocrEngine = el.selectOcrEngine.value;
  updateSettingsSummaryChip();
});
el.selectReadingOrder.addEventListener('change', () => {
  state.readingOrder = el.selectReadingOrder.value;
  updateSettingsSummaryChip();
  for (const p of state.pages) {
    if (p.blocks && p.blocks.length > 0) {
      p.blocks = sortBlocksByReadingOrder(p.blocks, state.readingOrder);
      updatePageFullText(p);
    }
  }
  renderOverlayBoxes();
  renderRightPanel();
});
el.selectWorkerPoolSize.addEventListener('change', async () => {
  state.workerPoolSetting = el.selectWorkerPoolSize.value;
  updateSettingsSummaryChip();
  await ensureWorkerPoolSize(getDesiredPoolSize('rtdetr'));
});
el.chkAutoPruneNonJp.addEventListener('change', () => {
  state.autoPruneNonJp = el.chkAutoPruneNonJp.checked;
  updateSettingsHelperTexts();
});
el.btnConnectBackend.addEventListener('click', () => {
  probeNativeBackend(el.inputBackendUrl.value, false);
});

// Gemini API Key & Model Listeners (Saved to Local Storage + IndexedDB)
el.btnToggleGeminiKeyVis.addEventListener('click', () => {
  const isHidden = el.inputGeminiApiKey.type === 'password';
  el.inputGeminiApiKey.type = isHidden ? 'text' : 'password';
  el.btnToggleGeminiKeyVis.textContent = isHidden ? 'Hide' : 'Show';
});

el.btnSaveGeminiKey.addEventListener('click', async () => {
  const keyVal = el.inputGeminiApiKey.value.trim();
  await saveGeminiConfig(keyVal, el.selectGeminiModel.value);
  if (keyVal) {
    showToast('Saved Gemini API key locally in browser cache!');
  } else {
    showToast('Cleared Gemini API key.', 'warn');
  }
});

el.inputGeminiApiKey.addEventListener('keydown', async (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const keyVal = el.inputGeminiApiKey.value.trim();
    await saveGeminiConfig(keyVal, el.selectGeminiModel.value);
    if (keyVal) showToast('Saved Gemini API key locally!');
  }
});

el.selectGeminiModel.addEventListener('change', async () => {
  await saveGeminiConfig(el.inputGeminiApiKey.value.trim() || state.gemini.apiKey, el.selectGeminiModel.value);
});

el.btnTestGeminiKey.addEventListener('click', async () => {
  const keyVal = el.inputGeminiApiKey.value.trim() || state.gemini.apiKey;
  if (!keyVal) {
    showToast('Paste a Gemini API key first to verify.', 'warn');
    el.inputGeminiApiKey.focus();
    return;
  }
  el.btnTestGeminiKey.disabled = true;
  el.btnTestGeminiKey.textContent = 'Checking…';
  try {
    const bestModel = await discoverBestGeminiModel(keyVal);
    await saveGeminiConfig(keyVal, el.selectGeminiModel.value);
    state.gemini.resolvedAutoModel = bestModel;
    updateGeminiSettingsStatusUI('Verified (' + maskApiKey(keyVal) + ' · ' + bestModel + ' ready)');
    showToast('Gemini API key verified! Active model: ' + bestModel);
  } catch (err) {
    updateGeminiSettingsStatusUI('Verification failed: ' + (err ? err.message : 'Invalid key'), true);
    showToast('Gemini key verification failed: ' + (err ? err.message : 'Invalid key'), 'error');
  } finally {
    el.btnTestGeminiKey.disabled = false;
    el.btnTestGeminiKey.textContent = 'Verify';
  }
});

el.btnClearGeminiKey.addEventListener('click', async () => {
  el.inputGeminiApiKey.value = '';
  el.inputGeminiApiKey.type = 'password';
  el.btnToggleGeminiKeyVis.textContent = 'Show';
  await saveGeminiConfig('', el.selectGeminiModel.value);
  showToast('Removed Gemini API key from local browser storage.');
});

// Batch Detect All Boxes, Extract & Stop Buttons
el.btnDetectAllBoxes.addEventListener('click', () => {
  detectBoxesForAllPages(state.pages);
});
el.btnExtractAll.addEventListener('click', () => {
  extractPagesQueue(state.pages);
});
el.btnExtractPage.addEventListener('click', () => {
  const p = getSelectedPage();
  if (p) quickExtractSinglePage(p);
});
el.btnStopExtract.addEventListener('click', () => {
  triggerImmediateStop();
});

// Page Navigation, Manga Reader Empty-Side Click, Interactive Drag-Slide, Trackpad Swipe & Scrubber
el.btnPrevPage.addEventListener('click', () => {
  goToPageByOffset(-1, { animateSlide: true });
});
el.btnNextPage.addEventListener('click', () => {
  goToPageByOffset(1, { animateSlide: true });
});
el.btnSideNavPrev.addEventListener('click', (ev) => {
  ev.stopPropagation();
  goToPageByOffset(-1, { animateSlide: true });
});
el.btnSideNavNext.addEventListener('click', (ev) => {
  ev.stopPropagation();
  goToPageByOffset(1, { animateSlide: true });
});
el.pageScrubberRange.addEventListener('input', () => {
  const targetIdx = Math.max(0, Math.min(state.pages.length - 1, parseInt(el.pageScrubberRange.value, 10) - 1));
  goToPageIndex(targetIdx, { animateSlide: false });
});

function getViewportEmptySideZone(clientX, clientY) {
  if (!getSelectedPage() || state.drawMode || el.stageImageWrapper.classList.contains('hidden')) {
    return null;
  }
  const vpRect = el.viewerViewport.getBoundingClientRect();
  // Exclude native scrollbars at right/bottom edge of viewerViewport
  if (
    clientX < vpRect.left ||
    clientX > vpRect.left + el.viewerViewport.clientWidth ||
    clientY < vpRect.top ||
    clientY > vpRect.top + el.viewerViewport.clientHeight
  ) {
    return null;
  }
  const stageRect = el.stageImageWrapper.getBoundingClientRect();
  if (clientX > stageRect.right + 2) return 'next';
  if (clientX < stageRect.left - 2) return 'prev';
  return null;
}

function clearSideGutterHoverUI() {
  el.viewerViewport.style.cursor = '';
  el.btnSideNavNext.classList.remove('gutter-hover');
  el.btnSideNavPrev.classList.remove('gutter-hover');
}

let readerSlide = null;
let suppressNextViewerClick = false;

el.viewerViewport.addEventListener('pointermove', (ev) => {
  if ((readerSlide && readerSlide.engaged) || state.drawMode || boxManip) return;
  const zone = getViewportEmptySideZone(ev.clientX, ev.clientY);
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  const canNext = zone === 'next' && idx >= 0 && idx < state.pages.length - 1;
  const canPrev = zone === 'prev' && idx > 0;
  el.viewerViewport.style.cursor = (canNext || canPrev) ? 'pointer' : '';
  el.btnSideNavNext.classList.toggle('gutter-hover', canNext);
  el.btnSideNavPrev.classList.toggle('gutter-hover', canPrev);
});

el.viewerViewport.addEventListener('pointerleave', () => {
  clearSideGutterHoverUI();
});

// Click on empty right side -> Next Page; click on empty left side -> Previous Page
el.viewerViewport.addEventListener('click', (ev) => {
  if (suppressNextViewerClick) return;
  if (state.drawMode || boxManip) return;
  if (ev.target.closest('[data-bbox-id], button, input, a, #emptyViewerState')) return;
  const zone = getViewportEmptySideZone(ev.clientX, ev.clientY);
  if (zone === 'next') {
    el.viewerViewport.focus({ preventScroll: true });
    goToPageByOffset(1, { animateSlide: true });
  } else if (zone === 'prev') {
    el.viewerViewport.focus({ preventScroll: true });
    goToPageByOffset(-1, { animateSlide: true });
  }
});

// Interactive 2D Grab-to-Pan (when zoomed) & Pointer Drag-to-Slide Page Turn (when fitted)
let stagePan = null;

el.viewerViewport.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || state.drawMode || boxManip) return;
  if (!getSelectedPage()) return;
  if (ev.target.closest('#liveSelectionCard, #batchStudyDock, [data-batch-region], button, input, a, #emptyViewerState')) return;

  const vpRect = el.viewerViewport.getBoundingClientRect();
  if (
    ev.clientX > vpRect.left + el.viewerViewport.clientWidth ||
    ev.clientY > vpRect.top + el.viewerViewport.clientHeight
  ) {
    return;
  }

  // When zoomed and overflowing the viewport, drag-pan smoothly in 2D like a native manga reader
  if (isViewportZoomOverflowing()) {
    if (!state.liveTextMode && state.showBoxes && ev.target.closest('[data-bbox-id]')) {
      return;
    }
    stagePan = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      startScrollLeft: el.viewerViewport.scrollLeft,
      startScrollTop: el.viewerViewport.scrollTop,
      engaged: false
    };
    return;
  }

  if (state.pages.length <= 1) return;
  if (ev.target.closest('[data-bbox-id], [data-live-text]')) return;

  readerSlide = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    startTime: performance.now(),
    engaged: false,
    aborted: false
  };
});

window.addEventListener('pointermove', (ev) => {
  if (stagePan && ev.pointerId === stagePan.pointerId) {
    if (state.drawMode || boxManip) {
      stagePan = null;
      el.viewerViewport.classList.remove('is-grab-panning');
      return;
    }
    const dx = ev.clientX - stagePan.startX;
    const dy = ev.clientY - stagePan.startY;
    if (!stagePan.engaged) {
      if (Math.hypot(dx, dy) < 6) return;
      stagePan.engaged = true;
      clearSideGutterHoverUI();
      el.viewerViewport.classList.add('is-grab-panning');
    }
    ev.preventDefault();
    el.viewerViewport.scrollLeft = Math.max(0, stagePan.startScrollLeft - dx);
    el.viewerViewport.scrollTop = Math.max(0, stagePan.startScrollTop - dy);
    if (state.liveTextMode && state.livePopupBlockId && typeof positionOpenLivePopup === 'function') {
      requestAnimationFrame(positionOpenLivePopup);
    }
    return;
  }

  if (!readerSlide || ev.pointerId !== readerSlide.pointerId || readerSlide.aborted) return;
  if (state.drawMode || boxManip) {
    readerSlide.aborted = true;
    el.slideGestureHint.classList.add('hidden');
    resetStageSlideTransform();
    return;
  }

  const dx = ev.clientX - readerSlide.startX;
  const dy = ev.clientY - readerSlide.startY;

  if (!readerSlide.engaged) {
    if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      readerSlide.aborted = true;
      return;
    }
    if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy) * 1.15) {
      return;
    }
    readerSlide.engaged = true;
    clearSideGutterHoverUI();
    el.viewerViewport.style.cursor = 'grabbing';
    el.stageImageWrapper.classList.remove('stage-anim-next', 'stage-anim-prev');
    el.stageImageWrapper.style.transition = 'none';
  }

  ev.preventDefault();
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  const total = state.pages.length;
  const goingNext = dx < 0;
  const canTurn = goingNext ? (idx >= 0 && idx < total - 1) : (idx > 0);
  const dampedDx = canTurn
    ? Math.max(-280, Math.min(280, dx * 0.88))
    : Math.max(-44, Math.min(44, dx * 0.22));

  el.stageImageWrapper.style.transform = 'translate3d(' + dampedDx.toFixed(1) + 'px, 0, 0)';
  el.stageImageWrapper.style.opacity = String(Math.max(0.6, 1 - Math.abs(dampedDx) / 540));

  const readyToCommit = canTurn && Math.abs(dx) >= 52;
  el.slideGestureHint.classList.remove('hidden');
  el.slideGestureHint.className =
    'pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-full text-xs font-semibold shadow-md backdrop-blur-sm whitespace-nowrap transition-colors ' +
    (readyToCommit ? 'bg-indigo-600/95 text-white' : 'bg-slate-900/85 text-white');
  if (goingNext) {
    el.slideGestureHint.textContent = canTurn
      ? ('Next · Page ' + (idx + 2) + ' / ' + total + ' →')
      : 'Last page';
  } else {
    el.slideGestureHint.textContent = canTurn
      ? ('← Prev · Page ' + idx + ' / ' + total)
      : 'First page';
  }
}, { passive: false });

function finishReaderSlide(ev) {
  if (stagePan && ev.pointerId === stagePan.pointerId) {
    const p = stagePan;
    stagePan = null;
    el.viewerViewport.classList.remove('is-grab-panning');
    syncViewportGrabCursor();
    if (p.engaged) {
      suppressNextViewerClick = true;
      setTimeout(() => { suppressNextViewerClick = false; }, 90);
    }
    return;
  }
  if (!readerSlide || ev.pointerId !== readerSlide.pointerId) return;
  const s = readerSlide;
  readerSlide = null;
  el.slideGestureHint.classList.add('hidden');
  el.viewerViewport.style.cursor = '';

  if (!s.engaged || s.aborted) return;

  suppressNextViewerClick = true;
  setTimeout(() => { suppressNextViewerClick = false; }, 90);

  const dx = ev.clientX - s.startX;
  const dt = Math.max(16, performance.now() - s.startTime);
  const vx = dx / dt;
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  const canNext = idx >= 0 && idx < state.pages.length - 1;
  const canPrev = idx > 0;

  if (canNext && (dx <= -52 || (dx <= -24 && vx <= -0.38))) {
    resetStageSlideTransform();
    goToPageByOffset(1, { animateSlide: true });
  } else if (canPrev && (dx >= 52 || (dx >= 24 && vx >= 0.38))) {
    resetStageSlideTransform();
    goToPageByOffset(-1, { animateSlide: true });
  } else {
    el.stageImageWrapper.style.transition = 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
    el.stageImageWrapper.style.transform = 'translate3d(0, 0, 0)';
    el.stageImageWrapper.style.opacity = '1';
    setTimeout(() => {
      if (!readerSlide) resetStageSlideTransform();
    }, 190);
  }
}

window.addEventListener('pointerup', finishReaderSlide);
window.addEventListener('pointercancel', finishReaderSlide);

// Laptop Two-Finger Horizontal Trackpad Swipe Support
let wheelSwipeAccumX = 0;
let wheelSwipeResetTimer = null;
let lastWheelPageTurnAt = 0;

el.viewerViewport.addEventListener('wheel', (ev) => {
  // Smooth Ctrl/Cmd + Mouse Wheel & Trackpad Pinch-to-Zoom anchored at cursor
  if (ev.ctrlKey || ev.metaKey) {
    if (!getSelectedPage()) return;
    ev.preventDefault();
    wakeFullscreenHud();
    const rawDelta = ev.deltaMode === 1 ? ev.deltaY * 28 : ev.deltaY;
    const clampedDelta = Math.max(-160, Math.min(160, rawDelta));
    const factor = Math.exp(-clampedDelta * 0.0022);
    const curFactor = state.fitMode ? 1.0 : state.zoom;
    setStageZoomFactor(curFactor * factor, ev.clientX, ev.clientY);
    return;
  }

  if (state.pages.length <= 1 || state.drawMode) return;
  const hasHorizOverflow = !state.fitMode && (el.viewerViewport.scrollWidth > el.viewerViewport.clientWidth + 8);
  if (hasHorizOverflow) return;
  if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY) * 1.35 || Math.abs(ev.deltaX) < 4) return;

  ev.preventDefault();
  const now = performance.now();
  if (now - lastWheelPageTurnAt < 380) return;

  wheelSwipeAccumX += ev.deltaX;
  if (wheelSwipeResetTimer) clearTimeout(wheelSwipeResetTimer);
  wheelSwipeResetTimer = setTimeout(() => {
    wheelSwipeAccumX = 0;
  }, 180);

  if (wheelSwipeAccumX >= 60) {
    wheelSwipeAccumX = 0;
    lastWheelPageTurnAt = now;
    goToPageByOffset(1, { animateSlide: true });
  } else if (wheelSwipeAccumX <= -60) {
    wheelSwipeAccumX = 0;
    lastWheelPageTurnAt = now;
    goToPageByOffset(-1, { animateSlide: true });
  }
}, { passive: false });

el.btnToggleBoxes.addEventListener('click', () => {
  if (state.liveTextMode) {
    state.liveTextMode = false;
    state.showBoxes = true;
  } else {
    state.showBoxes = !state.showBoxes;
  }
  syncBoxesToggleUI();
  renderOverlayBoxes();
});

if (el.btnSelectTextMode) {
  el.btnSelectTextMode.addEventListener('click', () => {
    setLiveTextMode(!state.liveTextMode);
  });
}
if (el.btnBatchSelectMode) {
  el.btnBatchSelectMode.addEventListener('click', () => {
    setBatchSelectMode(!state.batchSelectMode);
  });
}
if (el.btnBannerExitBatch) {
  el.btnBannerExitBatch.addEventListener('click', () => {
    setBatchSelectMode(false);
  });
}
if (el.btnExitLiveTextMode) {
  el.btnExitLiveTextMode.addEventListener('click', () => {
    state.showBoxes = true;
    setLiveTextMode(false);
  });
}

function getActivePopupBlockInfo() {
  if (!state.liveTextMode || !state.livePopupBlockId) return null;
  const page = getSelectedPage();
  if (!page || !Array.isArray(page.blocks)) return null;
  const idx = page.blocks.findIndex((b) => b.id === state.livePopupBlockId);
  if (idx < 0) return null;
  const blk = page.blocks[idx];
  const text = (blk.text || '').trim();
  if (!text) return null;
  return { page, blk, index: idx + 1, text };
}

function getPopupHighlightedSubstring() {
  if (!state.liveTextMode || !window.getSelection || !el.liveSelPreviewBody) return '';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  const insidePopup =
    (anchor && el.liveSelPreviewBody.contains(anchor)) ||
    (focus && el.liveSelPreviewBody.contains(focus));
  if (!insidePopup) return '';
  return sel.toString().trim();
}

function getSelectedLiveStageText() {
  const sub = getPopupHighlightedSubstring();
  if (sub) return sub;
  const info = getActivePopupBlockInfo();
  return info ? info.text : '';
}

function resetLiveBannerDefaultText() {
  if (!el.liveBannerStatusText) return;
  el.liveBannerStatusText.innerHTML =
    '<strong>Select Text Mode:</strong> Click any speech bubble on the manga to open its sentence popup, then highlight &amp; copy text inside the popup.';
}

function positionOpenLivePopup() {
  if (!el.liveSelectionCard) return;
  const info = getActivePopupBlockInfo();
  if (!info || !el.bboxOverlayLayer) {
    el.liveSelectionCard.classList.add('hidden');
    return;
  }
  const reg = el.bboxOverlayLayer.querySelector('[data-bbox-id="' + info.blk.id + '"]');
  if (!reg) {
    el.liveSelectionCard.classList.add('hidden');
    return;
  }
  try {
    const anchorRect = reg.getBoundingClientRect();
    if (el.viewerViewport) {
      const vpRect = el.viewerViewport.getBoundingClientRect();
      if (
        anchorRect.bottom < vpRect.top + 4 ||
        anchorRect.top > vpRect.bottom - 4 ||
        anchorRect.right < vpRect.left + 4 ||
        anchorRect.left > vpRect.right - 4
      ) {
        el.liveSelectionCard.classList.add('hidden');
        return;
      }
    }

    const vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1024);
    const vh = Math.max(240, window.innerHeight || document.documentElement.clientHeight || 768);

    el.liveSelectionCard.classList.remove('hidden', 'place-above', 'place-below');
    const cardW = Math.min(380, Math.max(236, el.liveSelectionCard.offsetWidth || 260));
    const cardH = Math.max(76, el.liveSelectionCard.offsetHeight || 108);

    const centerLeft = (anchorRect.left + anchorRect.right) * 0.5 - cardW * 0.5;
    const clampedLeft = Math.max(8, Math.min(Math.max(8, vw - cardW - 8), centerLeft));
    el.liveSelectionCard.style.left = Math.round(clampedLeft) + 'px';

    const spaceAbove = anchorRect.top - 8;
    const spaceBelow = vh - anchorRect.bottom - 8;

    if (spaceAbove >= cardH + 6 || (spaceAbove > spaceBelow && spaceAbove >= 96)) {
      el.liveSelectionCard.classList.add('place-above');
      const targetBottomY = Math.max(cardH + 8, Math.min(vh - 8, anchorRect.top - 8));
      el.liveSelectionCard.style.top = Math.round(targetBottomY) + 'px';
    } else {
      el.liveSelectionCard.classList.add('place-below');
      const targetTopY = Math.max(8, Math.min(Math.max(8, vh - cardH - 8), anchorRect.bottom + 8));
      el.liveSelectionCard.style.top = Math.round(targetTopY) + 'px';
    }
  } catch (_e) {
    el.liveSelectionCard.classList.add('hidden');
  }
}

function openLiveBubblePopup(blockId, opts) {
  const options = opts || {};
  state.livePopupBlockId = blockId;
  state.selectedBlockId = blockId;
  syncToolbarBoxDeleteBtn();

  if (window.getSelection) {
    try { window.getSelection().removeAllRanges(); } catch (_e) {}
  }
  if (el.bboxOverlayLayer) {
    el.bboxOverlayLayer.querySelectorAll('.live-text-region').forEach((node) => {
      node.classList.toggle('has-selection', node.getAttribute('data-bbox-id') === blockId);
    });
  }
  const info = getActivePopupBlockInfo();
  if (!info) {
    closeLiveBubblePopup();
    return;
  }
  if (el.liveSelPreviewBody) {
    el.liveSelPreviewBody.textContent = info.text;
  }

  // Behavior consistency with Box Mode: switch to Page Bubbles & highlight + scroll to the clicked bubble card
  if (options.preserveTab !== true && state.activeTab !== 'bubbles') {
    state.activeTab = 'bubbles';
    syncTabBarClasses();
    if (options.skipRightRender !== true) {
      renderRightPanel();
    }
  } else if (options.skipRightRender !== true) {
    renderRightPanel();
  } else if (typeof syncSelectedBubbleCardInPlace === 'function') {
    syncSelectedBubbleCardInPlace(blockId, { scrollCard: false });
  }

  if (options.skipRightScroll !== true && el.panelPageBubbles && typeof scrollCardIntoContainer === 'function') {
    const cardEl = el.panelPageBubbles.querySelector('[data-block-card="' + blockId + '"]');
    if (cardEl) scrollCardIntoContainer(el.panelPageBubbles, cardEl);
  }

  positionOpenLivePopup();
  syncLiveSelectionUI();
}

function closeLiveBubblePopup(opts) {
  const options = opts || {};
  state.livePopupBlockId = null;
  if (options.keepSelectedBlock !== true) {
    state.selectedBlockId = null;
    syncToolbarBoxDeleteBtn();
  }
  if (window.getSelection) {
    try { window.getSelection().removeAllRanges(); } catch (_e) {}
  }
  if (el.bboxOverlayLayer) {
    el.bboxOverlayLayer.querySelectorAll('.live-text-region').forEach((n) => {
      const keep = Boolean(state.selectedBlockId && n.getAttribute('data-bbox-id') === state.selectedBlockId);
      n.classList.toggle('has-selection', keep);
    });
  }
  if (el.liveSelectionCard) {
    el.liveSelectionCard.classList.add('hidden');
  }
  if (typeof syncSelectedBubbleCardInPlace === 'function') {
    syncSelectedBubbleCardInPlace(state.selectedBlockId, { scrollCard: false });
  }
  syncLiveSelectionUI();
}

function syncLiveSelectionUI() {
  if (!state.liveTextMode) {
    if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');
    if (el.btnCopySelectedLiveText) el.btnCopySelectedLiveText.disabled = true;
    resetLiveBannerDefaultText();
    return;
  }

  const info = getActivePopupBlockInfo();
  if (!info) {
    if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');
    if (el.btnCopySelectedLiveText) el.btnCopySelectedLiveText.disabled = true;
    resetLiveBannerDefaultText();
    return;
  }

  if (state.selectedBlockId !== info.blk.id) {
    state.selectedBlockId = info.blk.id;
    syncToolbarBoxDeleteBtn();
  }
  if (el.bboxOverlayLayer) {
    el.bboxOverlayLayer.querySelectorAll('.live-text-region').forEach((node) => {
      node.classList.toggle('has-selection', node.getAttribute('data-bbox-id') === info.blk.id);
    });
  }
  if (typeof syncSelectedBubbleCardInPlace === 'function') {
    syncSelectedBubbleCardInPlace(info.blk.id, { scrollCard: true });
  }

  const sub = getPopupHighlightedSubstring();
  const totalChars = Array.from(info.text).length;
  const subChars = sub ? Array.from(sub).length : 0;

  if (el.btnCopySelectedLiveText) {
    el.btnCopySelectedLiveText.disabled = false;
  }
  const needsReview = isBlockBelowReviewThreshold(info.blk, info.page);
  const confPct = formatOcrConfPercent(info.blk.charConf);
  if (el.btnVerifyPopupBubble) {
    el.btnVerifyPopupBubble.classList.toggle('hidden', !needsReview);
  }
  if (el.btnDeletePopupBubble) {
    el.btnDeletePopupBubble.classList.toggle('hidden', !needsReview);
  }
  if (el.liveSelMetaLabel) {
    el.liveSelMetaLabel.classList.toggle('is-low-conf', Boolean(needsReview));
    if (needsReview) {
      const confTag = confPct !== null ? (confPct + '% OCR') : 'Low OCR';
      el.liveSelMetaLabel.textContent = sub
        ? ('⚠ ' + confTag + ' · ' + subChars + '/' + totalChars + ' chars')
        : ('⚠ ' + confTag + ' · May be inaccurate');
      el.liveSelMetaLabel.title = 'OCR confidence is below 90% — double-check characters against the manga artwork';
    } else {
      el.liveSelMetaLabel.textContent = sub
        ? ('Selected · ' + subChars + ' / ' + totalChars + ' chars')
        : ('Bubble #' + info.index + ' · ' + totalChars + ' chars');
      el.liveSelMetaLabel.title = '';
    }
  }
  if (el.liveSelectionCopyChip) {
    const spanEl = el.liveSelectionCopyChip.querySelector('span');
    if (spanEl) spanEl.textContent = sub ? 'Copy' : 'Copy';
    el.liveSelectionCopyChip.title = sub
      ? 'Copy highlighted characters'
      : 'Copy entire sentence';
  }
  // Sync Offline Romaji (default OFF), English translation, and Vocab & Grammar breakdown inside popup
  const activeTask = state.gemini.activeTasks.get(info.blk.id) || null;
  const study = info.blk.study || null;
  const isStale = Boolean(study && study.sourceText && study.sourceText !== info.text);
  const hasTrans = Boolean(study && study.english);
  const hasBreakdown = Boolean(study && study.breakdown && (
    (Array.isArray(study.breakdown.vocab) && study.breakdown.vocab.length > 0) ||
    (Array.isArray(study.breakdown.grammar) && study.breakdown.grammar.length > 0)
  ));
  const showPopupEn = Boolean(hasTrans && study.showTranslation !== false);
  const showPopupBd = Boolean(activeTask) || Boolean(hasBreakdown && study.showBreakdown);

  if (el.liveSelectionCard) {
    el.liveSelectionCard.classList.toggle(
      'has-study-open',
      Boolean(state.showPopupRomaji || state.showPopupInstantVocab || showPopupEn || showPopupBd)
    );
  }

  if (el.btnTogglePopupRomaji) {
    el.btnTogglePopupRomaji.classList.toggle('is-active', Boolean(state.showPopupRomaji));
    el.btnTogglePopupRomaji.setAttribute('aria-pressed', state.showPopupRomaji ? 'true' : 'false');
  }
  if (el.liveSelRomajiWrap) {
    el.liveSelRomajiWrap.classList.toggle('hidden', !state.showPopupRomaji);
  }
  if (state.showPopupRomaji && el.liveSelRomajiBody && typeof convertJapaneseToRomajiInstant === 'function') {
    let selectingInsideRomaji = false;
    if (window.getSelection) {
      const s = window.getSelection();
      if (s && s.rangeCount > 0 && !s.isCollapsed) {
        selectingInsideRomaji =
          (s.anchorNode && el.liveSelRomajiBody.contains(s.anchorNode)) ||
          (s.focusNode && el.liveSelRomajiBody.contains(s.focusNode));
      }
    }
    if (!selectingInsideRomaji) {
      const targetJp = sub || info.text;
      const romRes = convertJapaneseToRomajiInstant(targetJp, () => {
        if (state.liveTextMode && state.livePopupBlockId === info.blk.id) {
          syncLiveSelectionUI();
          positionOpenLivePopup();
        }
      });
      if (el.liveSelRomajiBody.textContent !== romRes.romaji) {
        el.liveSelRomajiBody.textContent = romRes.romaji;
      }
      if (el.liveSelRomajiLabel) {
        el.liveSelRomajiLabel.textContent = sub
          ? 'Selected Romaji · Offline'
          : (romRes.ready ? 'Offline Romaji (IPADIC)' : 'Offline Romaji (Loading dict…)');
      }
    }
  }

  // Sync Popup Instant Vocab button & 0ms Offline JMdict/Kuromoji Vocab sub-panel
  if (el.btnTogglePopupInstantVocab) {
    el.btnTogglePopupInstantVocab.classList.toggle('is-active', Boolean(state.showPopupInstantVocab));
    el.btnTogglePopupInstantVocab.setAttribute('aria-pressed', state.showPopupInstantVocab ? 'true' : 'false');
  }
  if (el.liveSelInstantVocabWrap && el.liveSelInstantVocabBody) {
    el.liveSelInstantVocabWrap.classList.toggle('hidden', !state.showPopupInstantVocab);
    if (state.showPopupInstantVocab && typeof analyzeJapaneseVocabInstant === 'function') {
      const targetIvJp = (sub || info.text || '').trim();
      const ivRes = analyzeJapaneseVocabInstant(targetIvJp, () => {
        if (state.liveTextMode && state.livePopupBlockId === info.blk.id && state.showPopupInstantVocab) {
          el.liveSelInstantVocabBody.removeAttribute('data-iv-render-key');
          syncLiveSelectionUI();
          positionOpenLivePopup();
        }
      });
      const ivList = Array.isArray(ivRes.vocab) ? ivRes.vocab : [];
      const ivContentOnly = ivList.filter((v) => !v.isParticle);
      const ivSaveTargets = ivContentOnly.length > 0 ? ivContentOnly : ivList;

      if (el.liveSelInstantVocabLabel) {
        el.liveSelInstantVocabLabel.textContent = (sub ? 'Selected Vocab · ' : 'Instant Vocab · ') + ivRes.dictSource;
      }
      if (el.btnPopupSaveAllInstantVocab) {
        el.btnPopupSaveAllInstantVocab.classList.toggle('hidden', ivSaveTargets.length === 0);
        if (ivSaveTargets.length > 0) {
          const allIvSaved = ivSaveTargets.every((v) => isVocabItemSaved(v));
          el.btnPopupSaveAllInstantVocab.classList.toggle('is-saved', allIvSaved);
          el.btnPopupSaveAllInstantVocab.textContent = allIvSaved
            ? '✓ All Saved'
            : ('+ Save All (' + ivSaveTargets.length + ')');
        }
      }

      const ivRenderKey = info.blk.id + '::' + targetIvJp + '::' + ivRes.dictSource + '::' + ivList.length;
      if (el.liveSelInstantVocabBody.getAttribute('data-iv-render-key') !== ivRenderKey) {
        el.liveSelInstantVocabBody.setAttribute('data-iv-render-key', ivRenderKey);
        el.liveSelInstantVocabBody.innerHTML = '';
        const ivMeta = {
          contextJp: info.text,
          pageId: info.page.id,
          pageName: info.page.name,
          bubbleIndex: info.index,
          blockId: info.blk.id
        };
        ivList.forEach((v) => {
          const row = document.createElement('div');
          row.className = 'rounded bg-white border border-slate-200 px-2 py-1 text-xs';

          const topLine = document.createElement('div');
          topLine.className = 'flex flex-wrap items-center justify-between gap-1';

          const leftW = document.createElement('div');
          leftW.className = 'flex flex-wrap items-baseline gap-1';
          const surf = document.createElement('span');
          surf.className = 'jp-text font-bold text-slate-900';
          surf.textContent = v.surface || '';
          leftW.appendChild(surf);

          if (v.reading && v.reading !== v.surface) {
            const rd = document.createElement('span');
            rd.className = 'jp-text text-[11px] text-indigo-700 font-medium';
            rd.textContent = '【' + v.reading + '】';
            leftW.appendChild(rd);
          }
          if (v.romaji) {
            const rm = document.createElement('span');
            rm.className = 'italic text-[11px] text-slate-500';
            rm.textContent = v.romaji;
            leftW.appendChild(rm);
          }
          if (v.dictForm && v.dictForm !== v.surface) {
            const df = document.createElement('span');
            df.className = 'jp-text text-[10px] text-slate-500 bg-slate-100 px-1 rounded';
            df.textContent = 'dict: ' + v.dictForm;
            leftW.appendChild(df);
          }
          topLine.appendChild(leftW);

          const rightTags = document.createElement('div');
          rightTags.className = 'flex items-center gap-1 ml-auto shrink-0';
          if (v.pos) {
            const pos = document.createElement('span');
            pos.className = 'px-1.5 py-0.2 rounded bg-teal-100/80 text-teal-900 text-[10px] font-semibold shrink-0';
            pos.textContent = v.pos;
            rightTags.appendChild(pos);
          }
          const vKey = normalizeVocabMatchKey(v);
          const savedNow = isVocabItemSaved(v);
          const btnSaveIv = document.createElement('button');
          btnSaveIv.type = 'button';
          btnSaveIv.setAttribute('data-vocab-save-btn', '1');
          btnSaveIv.setAttribute('data-vocab-save-key', vKey);
          btnSaveIv.setAttribute('aria-pressed', savedNow ? 'true' : 'false');
          btnSaveIv.className = 'md-vocab-save-btn' + (savedNow ? ' is-saved' : '');
          btnSaveIv.textContent = savedNow ? '✓ Saved' : '+ Save';
          btnSaveIv.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          });
          btnSaveIv.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggleSaveVocabItem(v, ivMeta);
          });
          rightTags.appendChild(btnSaveIv);
          topLine.appendChild(rightTags);

          const mean = document.createElement('p');
          mean.className = 'text-[11px] text-slate-700 leading-snug mt-0.5';
          mean.textContent = v.meaning || '';
          row.appendChild(topLine);
          row.appendChild(mean);
          el.liveSelInstantVocabBody.appendChild(row);
        });
      }
    }
  }

  // Sync Popup English output card (populated in the same single request alongside Vocab & Grammar)
  if (el.liveSelEnglishWrap) {
    el.liveSelEnglishWrap.classList.toggle('hidden', !showPopupEn);
    if (showPopupEn && hasTrans) {
      let selectingInsideEn = false;
      if (window.getSelection && el.liveSelEnglishWrap) {
        const s = window.getSelection();
        if (s && s.rangeCount > 0 && !s.isCollapsed) {
          selectingInsideEn =
            (s.anchorNode && el.liveSelEnglishWrap.contains(s.anchorNode)) ||
            (s.focusNode && el.liveSelEnglishWrap.contains(s.focusNode));
        }
      }
      if (!selectingInsideEn) {
        const aiRom = (study.romaji || '').trim();
        if (el.liveSelEnglishLabel) {
          el.liveSelEnglishLabel.textContent = aiRom ? 'English & Verified Romaji' : 'English';
        }
        if (el.liveSelStudyRomajiBody) {
          el.liveSelStudyRomajiBody.classList.toggle('hidden', !aiRom);
          if (aiRom) el.liveSelStudyRomajiBody.textContent = aiRom;
        }
        if (el.btnCopyPopupStudyRomaji) {
          el.btnCopyPopupStudyRomaji.classList.toggle('hidden', !aiRom);
        }
        if (el.liveSelEnglishBody) el.liveSelEnglishBody.textContent = study.english;
        if (el.btnCopyPopupEnglish) el.btnCopyPopupEnglish.classList.remove('hidden');
        if (el.liveSelNuanceBody) {
          const nu = (study.nuance || '').trim();
          el.liveSelNuanceBody.classList.toggle('hidden', !nu);
          if (nu) el.liveSelNuanceBody.textContent = 'Tone / Nuance: ' + nu;
        }
      }
    }
  }

  // Sync Popup Highlighted-Word Quick Save button
  if (el.btnPopupSaveWord) {
    const cleanSub = (sub || '').trim();
    const canSaveSub = cleanSub.length > 0 && Array.from(cleanSub).length <= 32;
    el.btnPopupSaveWord.classList.toggle('hidden', !canSaveSub);
    if (canSaveSub) {
      const subSaved = isVocabItemSaved({ kanji: cleanSub });
      el.btnPopupSaveWord.classList.toggle('is-saved-word', subSaved);
      const shortSub = Array.from(cleanSub).length > 8 ? Array.from(cleanSub).slice(0, 8).join('') + '…' : cleanSub;
      el.btnPopupSaveWord.textContent = subSaved ? ('✓ Saved "' + shortSub + '"') : ('+ Save "' + shortSub + '"');
    }
  }

  // Sync Popup + Batch button
  if (el.btnPopupBatchToggle) {
    const bOrder = getBlockBatchOrderIndex(info.blk.id);
    const inBatch = bOrder >= 0;
    el.btnPopupBatchToggle.classList.toggle('is-in-batch', inBatch);
    el.btnPopupBatchToggle.setAttribute('aria-pressed', inBatch ? 'true' : 'false');
    el.btnPopupBatchToggle.textContent = inBatch ? ('#' + (bOrder + 1) + ' in Batch') : '+ Batch';
  }

  // Sync Unified Popup EN + Romaji + Vocab & Grammar button & Breakdown sub-panel
  if (el.btnPopupBreakdown) {
    el.btnPopupBreakdown.disabled = Boolean(activeTask);
    const bdActive = Boolean(hasBreakdown && !isStale && study.showBreakdown);
    el.btnPopupBreakdown.classList.toggle('is-active-bd', bdActive);
    el.btnPopupBreakdown.setAttribute('aria-pressed', bdActive ? 'true' : 'false');
    if (activeTask) {
      el.btnPopupBreakdown.textContent = 'Analyzing…';
    } else if (hasBreakdown && !isStale) {
      el.btnPopupBreakdown.textContent = bdActive
        ? 'Hide Study'
        : 'Show Study';
    } else {
      el.btnPopupBreakdown.textContent = 'EN + Romaji + Vocab & Grammar';
    }
  }
  if (el.liveSelBreakdownWrap && el.liveSelBreakdownBody) {
    el.liveSelBreakdownWrap.classList.toggle('hidden', !showPopupBd);
    if (showPopupBd) {
      const popupVocabList = (hasBreakdown && study && study.breakdown && Array.isArray(study.breakdown.vocab))
        ? study.breakdown.vocab
        : [];
      if (el.btnPopupSaveAllVocab) {
        const showSaveAll = activeTask !== 'breakdown' && popupVocabList.length > 0;
        el.btnPopupSaveAllVocab.classList.toggle('hidden', !showSaveAll);
        if (showSaveAll) {
          const allPopupSaved = popupVocabList.every((v) => isVocabItemSaved(v));
          el.btnPopupSaveAllVocab.classList.toggle('is-saved', allPopupSaved);
          el.btnPopupSaveAllVocab.textContent = allPopupSaved
            ? '✓ All Saved'
            : ('+ Save All (' + popupVocabList.length + ')');
        }
      }
      const renderKey = activeTask
        ? ('loading:' + info.blk.id)
        : ('ready:' + info.blk.id + ':' + (study ? study.sourceText : ''));
      if (el.liveSelBreakdownBody.getAttribute('data-render-key') !== renderKey) {
        el.liveSelBreakdownBody.setAttribute('data-render-key', renderKey);
        el.liveSelBreakdownBody.innerHTML = '';
        if (activeTask) {
          if (el.liveSelBreakdownLabel) el.liveSelBreakdownLabel.textContent = 'Translating & Breaking Down…';
          const p = document.createElement('p');
          p.className = 'text-xs text-slate-500';
          p.textContent = 'Translating into English and analyzing Japanese vocabulary & grammar in one pass…';
          el.liveSelBreakdownBody.appendChild(p);
        } else if (hasBreakdown) {
          if (el.liveSelBreakdownLabel) el.liveSelBreakdownLabel.textContent = 'Vocab & Grammar';
          const vocabList = popupVocabList;
          if (vocabList.length > 0) {
            const popupMeta = {
              contextJp: info.text,
              pageId: info.page.id,
              pageName: info.page.name,
              bubbleIndex: info.index,
              blockId: info.blk.id
            };
            const vStack = document.createElement('div');
            vStack.className = 'space-y-1';
            vocabList.forEach((v) => {
              const vItem = document.createElement('div');
              vItem.className = 'rounded bg-white border border-slate-200 px-2 py-1 text-xs';
              const topLine = document.createElement('div');
              topLine.className = 'flex flex-wrap items-center justify-between gap-1';
              const leftW = document.createElement('div');
              leftW.className = 'flex flex-wrap items-baseline gap-1';
              const surf = document.createElement('span');
              surf.className = 'jp-text font-bold text-slate-900';
              surf.textContent = v.surface || '';
              leftW.appendChild(surf);
              if (v.reading && v.reading !== v.surface) {
                const rd = document.createElement('span');
                rd.className = 'jp-text text-[11px] text-indigo-700 font-medium';
                rd.textContent = '【' + v.reading + '】';
                leftW.appendChild(rd);
              }
              if (v.romaji) {
                const rm = document.createElement('span');
                rm.className = 'italic text-[11px] text-slate-500';
                rm.textContent = v.romaji;
                leftW.appendChild(rm);
              }
              if (v.dictForm && v.dictForm !== v.surface) {
                const df = document.createElement('span');
                df.className = 'jp-text text-[10px] text-slate-500 bg-slate-100 px-1 rounded';
                df.textContent = 'dict: ' + v.dictForm;
                leftW.appendChild(df);
              }
              topLine.appendChild(leftW);

              const rightTags = document.createElement('div');
              rightTags.className = 'flex items-center gap-1 ml-auto shrink-0';
              if (v.pos) {
                const pos = document.createElement('span');
                pos.className = 'px-1.5 py-0.2 rounded bg-emerald-100/80 text-emerald-900 text-[10px] font-semibold shrink-0';
                pos.textContent = v.pos;
                rightTags.appendChild(pos);
              }
              const vKey = normalizeVocabMatchKey(v);
              const savedNow = isVocabItemSaved(v);
              const btnSaveV = document.createElement('button');
              btnSaveV.type = 'button';
              btnSaveV.setAttribute('data-vocab-save-btn', '1');
              btnSaveV.setAttribute('data-vocab-save-key', vKey);
              btnSaveV.setAttribute('aria-pressed', savedNow ? 'true' : 'false');
              btnSaveV.className = 'md-vocab-save-btn' + (savedNow ? ' is-saved' : '');
              btnSaveV.textContent = savedNow ? '✓ Saved' : '+ Save';
              btnSaveV.addEventListener('pointerdown', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
              });
              btnSaveV.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                toggleSaveVocabItem(v, popupMeta);
              });
              rightTags.appendChild(btnSaveV);
              topLine.appendChild(rightTags);

              const mean = document.createElement('p');
              mean.className = 'text-[11px] text-slate-700 leading-snug mt-0.5';
              mean.textContent = v.meaning || '';
              vItem.appendChild(topLine);
              vItem.appendChild(mean);
              vStack.appendChild(vItem);
            });
            el.liveSelBreakdownBody.appendChild(vStack);
          }
          const grammarList = Array.isArray(study.breakdown.grammar) ? study.breakdown.grammar : [];
          if (grammarList.length > 0) {
            const gStack = document.createElement('div');
            gStack.className = 'space-y-1 pt-1.5 border-t border-slate-200';
            grammarList.forEach((g) => {
              const gItem = document.createElement('div');
              gItem.className = 'rounded bg-white border border-indigo-100 px-2 py-1 text-xs';
              const gHead = document.createElement('div');
              gHead.className = 'flex flex-wrap items-center justify-between gap-1';
              const pat = document.createElement('span');
              pat.className = 'jp-text font-bold text-indigo-900';
              pat.textContent = g.pattern || '';
              gHead.appendChild(pat);
              if (g.level) {
                const lvl = document.createElement('span');
                lvl.className = 'px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold';
                lvl.textContent = g.level;
                gHead.appendChild(lvl);
              }
              const exp = document.createElement('p');
              exp.className = 'text-[11px] text-slate-700 leading-snug mt-0.5';
              exp.textContent = g.explanation || '';
              gItem.appendChild(gHead);
              gItem.appendChild(exp);
              gStack.appendChild(gItem);
            });
            el.liveSelBreakdownBody.appendChild(gStack);
          }
        }
      }
    }
  }

  if (el.btnPopupRefreshStudy) {
    const canRefresh = Boolean((hasTrans || hasBreakdown) && !activeTask);
    el.btnPopupRefreshStudy.classList.toggle('hidden', !canRefresh);
    el.btnPopupRefreshStudy.textContent = isStale ? '↻ Update' : '↻';
  }

  if (el.liveBannerStatusText) {
    const activeStr = sub || info.text;
    const clipped = activeStr.length > 44 ? activeStr.slice(0, 44) + '…' : activeStr;
    el.liveBannerStatusText.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = sub
      ? ('Selected (' + subChars + ' chars): ')
      : ('Bubble #' + info.index + ' (' + totalChars + ' chars — drag inside popup to select words): ');
    const preview = document.createElement('span');
    preview.className = 'font-medium';
    preview.textContent = '「' + clipped + '」';
    el.liveBannerStatusText.appendChild(strong);
    el.liveBannerStatusText.appendChild(preview);
  }
}

document.addEventListener('selectionchange', syncLiveSelectionUI);

if (el.liveSelectionCard) {
  // Stop stage/viewport slide & double-click handlers from intercepting interactions inside the popup,
  // while allowing native double-click word selection inside #liveSelPreviewBody!
  el.liveSelectionCard.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
  });
  el.liveSelectionCard.addEventListener('click', (ev) => {
    ev.stopPropagation();
  });
  el.liveSelectionCard.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
  });
}

function findExtractedBlockAtCoords(page, rx, ry) {
  if (!page || !page.width || !page.height || !Array.isArray(page.blocks)) return null;
  const px = rx * page.width;
  const py = ry * page.height;
  let best = null;
  let bestArea = Infinity;
  for (const b of page.blocks) {
    if (!Boolean((b.text || '').trim())) continue;
    if (px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2) {
      const area = Math.max(1, (b.x2 - b.x1) * (b.y2 - b.y1));
      if (area < bestArea) {
        bestArea = area;
        best = b;
      }
    }
  }
  return best;
}

async function activateSelectTextOnPageDoubleClick(page, coords) {
  const target = page || getSelectedPage();
  if (!target) return;

  if (state.drawMode) {
    setDrawMode(false);
  }
  state.selectedBlockId = null;

  // Already extracted -> never re-trigger extraction; immediately enter Select Text mode!
  if (isPageAlreadyExtracted(target)) {
    const wasLive = Boolean(state.liveTextMode);
    state.liveTextMode = true;
    syncBoxesToggleUI();
    renderOverlayBoxes();
    renderRightPanel();

    if (coords && state.selectedPageId === target.id && typeof openLiveBubblePopup === 'function') {
      const hitBlk = findExtractedBlockAtCoords(target, coords.rx, coords.ry);
      if (hitBlk) {
        openLiveBubblePopup(hitBlk.id);
        return;
      }
    }
    if (!wasLive) {
      showToast('Select Text mode active — click any speech bubble to read & copy.');
    }
    return;
  }

  // Not extracted yet -> enter Select Text mode immediately and run fast single-page extraction once!
  state.liveTextMode = true;
  syncBoxesToggleUI();
  renderOverlayBoxes();
  renderRightPanel();

  if (state.isExtracting) {
    showToast('Extraction already running…', 'warn');
    return;
  }

  await quickExtractSinglePage(target);

  if (!state.liveTextMode) {
    state.liveTextMode = true;
    syncBoxesToggleUI();
    renderOverlayBoxes();
    renderRightPanel();
  }
  if (coords && state.selectedPageId === target.id && typeof openLiveBubblePopup === 'function') {
    const hitBlk = findExtractedBlockAtCoords(target, coords.rx, coords.ry);
    if (hitBlk) {
      openLiveBubblePopup(hitBlk.id);
    }
  }
}

// Double-click anywhere on the manga page: enters Select Text mode (and extracts only if not already extracted)
el.stageImageWrapper.addEventListener('dblclick', (ev) => {
  if (state.drawMode) return;
  if (ev.target.closest('#liveSelectionCard, .bbox-quickbar, [data-resize-dir], button, input, textarea, select, a')) {
    return;
  }
  const page = getSelectedPage();
  if (!page) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (window.getSelection) {
    try { window.getSelection().removeAllRanges(); } catch (_e) {}
  }
  const coords = stagePointerCoords(ev.clientX, ev.clientY);
  activateSelectTextOnPageDoubleClick(page, coords);
});

if (el.btnCopySelectedLiveText) {
  el.btnCopySelectedLiveText.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
  });
  el.btnCopySelectedLiveText.addEventListener('click', () => {
    const txt = getSelectedLiveStageText();
    if (txt) copyTextSafe(txt, 'Copied: ' + (txt.length > 24 ? txt.slice(0, 24) + '…' : txt));
  });
}
if (el.btnSelectWholeBubble) {
  el.btnSelectWholeBubble.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnSelectWholeBubble.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (el.liveSelPreviewBody && window.getSelection) {
      const range = document.createRange();
      range.selectNodeContents(el.liveSelPreviewBody);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      syncLiveSelectionUI();
    }
  });
}
if (el.liveSelectionCopyChip) {
  el.liveSelectionCopyChip.addEventListener('pointerdown', (ev) => {
    // Keep any highlighted substring inside #liveSelPreviewBody intact when clicking Copy!
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.liveSelectionCopyChip.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const txt = getSelectedLiveStageText();
    if (txt) {
      copyTextSafe(txt, 'Copied: ' + (txt.length > 24 ? txt.slice(0, 24) + '…' : txt));
    }
  });
}
if (el.btnTogglePopupRomaji) {
  state.showPopupRomaji = false;
  try {
    const savedRom = localStorage.getItem('ankisuru_popup_romaji_v2');
    if (savedRom === '1') state.showPopupRomaji = true;
  } catch (_e) {}
  el.btnTogglePopupRomaji.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnTogglePopupRomaji.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    state.showPopupRomaji = !state.showPopupRomaji;
    try {
      localStorage.setItem('ankisuru_popup_romaji_v2', state.showPopupRomaji ? '1' : '0');
    } catch (_e) {}
    syncLiveSelectionUI();
    positionOpenLivePopup();
  });
}
if (el.btnTogglePopupInstantVocab) {
  state.showPopupInstantVocab = false;
  try {
    const savedIv = localStorage.getItem('ankisuru_popup_instant_vocab_v1');
    if (savedIv === '1') state.showPopupInstantVocab = true;
  } catch (_e) {}
  el.btnTogglePopupInstantVocab.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnTogglePopupInstantVocab.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    state.showPopupInstantVocab = !state.showPopupInstantVocab;
    try {
      localStorage.setItem('ankisuru_popup_instant_vocab_v1', state.showPopupInstantVocab ? '1' : '0');
    } catch (_e) {}
    syncLiveSelectionUI();
    positionOpenLivePopup();
  });
}
if (el.btnPopupSaveAllInstantVocab) {
  el.btnPopupSaveAllInstantVocab.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupSaveAllInstantVocab.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info || typeof analyzeJapaneseVocabInstant !== 'function') return;
    const sub = getPopupHighlightedSubstring();
    const targetJp = (sub || info.text || '').trim();
    const ivRes = analyzeJapaneseVocabInstant(targetJp);
    const ivList = Array.isArray(ivRes.vocab) ? ivRes.vocab : [];
    const contentOnly = ivList.filter((v) => !v.isParticle);
    const targets = contentOnly.length > 0 ? contentOnly : ivList;
    saveAllVocabFromList(targets, {
      contextJp: info.text,
      pageId: info.page.id,
      pageName: info.page.name,
      bubbleIndex: info.index,
      blockId: info.blk.id
    });
  });
}
if (el.btnPopupBreakdown) {
  el.btnPopupBreakdown.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupBreakdown.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info) return;
    const study = info.blk.study || null;
    const isStale = Boolean(study && study.sourceText && study.sourceText !== info.text);
    const hasBreakdown = Boolean(study && study.breakdown && (
      (Array.isArray(study.breakdown.vocab) && study.breakdown.vocab.length > 0) ||
      (Array.isArray(study.breakdown.grammar) && study.breakdown.grammar.length > 0)
    ));
    if (hasBreakdown && !isStale) {
      const nextOpen = !Boolean(study.showBreakdown);
      info.blk.study.showTranslation = nextOpen;
      info.blk.study.showBreakdown = nextOpen;
      notifyStudyViewsUpdated(info.blk.id);
    } else {
      requestBubbleBreakdown(info.page, info.blk, isStale);
    }
  });
}
if (el.btnPopupSaveWord) {
  el.btnPopupSaveWord.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupSaveWord.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    const sub = getPopupHighlightedSubstring();
    if (sub && info) {
      saveHighlightedWordFromPopup(sub, info);
    }
  });
}
if (el.btnPopupSaveAllVocab) {
  el.btnPopupSaveAllVocab.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupSaveAllVocab.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info || !info.blk || !info.blk.study || !info.blk.study.breakdown) return;
    const vocabList = Array.isArray(info.blk.study.breakdown.vocab) ? info.blk.study.breakdown.vocab : [];
    saveAllVocabFromList(vocabList, {
      contextJp: info.text,
      pageId: info.page.id,
      pageName: info.page.name,
      bubbleIndex: info.index,
      blockId: info.blk.id
    });
  });
}
if (el.btnPopupRefreshStudy) {
  el.btnPopupRefreshStudy.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupRefreshStudy.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info) return;
    requestBubbleBreakdown(info.page, info.blk, true);
  });
}
if (el.btnPopupBatchToggle) {
  el.btnPopupBatchToggle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnPopupBatchToggle.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info) return;
    const ord = toggleBlockInBatchQueue(info.page.id, info.blk.id);
    if (ord > 0) {
      showToast('Added as Batch #' + ord + ' (' + state.batchQueue.length + ' selected)');
    }
  });
}
if (el.btnCopyPopupStudyRomaji) {
  el.btnCopyPopupStudyRomaji.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnCopyPopupStudyRomaji.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    const rTxt = info && info.blk && info.blk.study ? (info.blk.study.romaji || '').trim() : '';
    if (rTxt) {
      copyTextSafe(rTxt, 'Copied verified Romaji!');
    }
  });
}
if (el.btnCopyPopupEnglish) {
  el.btnCopyPopupEnglish.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnCopyPopupEnglish.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    const enTxt = info && info.blk && info.blk.study ? (info.blk.study.english || '').trim() : '';
    if (enTxt) {
      copyTextSafe(enTxt, 'Copied English translation!');
    }
  });
}
if (el.btnCopyPopupRomaji) {
  el.btnCopyPopupRomaji.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnCopyPopupRomaji.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    let romTxt = '';
    if (window.getSelection && el.liveSelRomajiBody) {
      const sel = window.getSelection();
      if (
        sel &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        ((sel.anchorNode && el.liveSelRomajiBody.contains(sel.anchorNode)) ||
          (sel.focusNode && el.liveSelRomajiBody.contains(sel.focusNode)))
      ) {
        romTxt = sel.toString().trim();
      }
    }
    if (!romTxt && el.liveSelRomajiBody) {
      romTxt = (el.liveSelRomajiBody.textContent || '').trim();
    }
    if (romTxt) {
      copyTextSafe(romTxt, 'Copied Romaji: ' + (romTxt.length > 28 ? romTxt.slice(0, 28) + '…' : romTxt));
    }
  });
}
if (el.btnVerifyPopupBubble) {
  el.btnVerifyPopupBubble.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnVerifyPopupBubble.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info) return;
    info.blk.verified = true;
    updatePageCardInPlace(info.page);
    renderOverlayBoxes();
    syncLiveSelectionUI();
    positionOpenLivePopup();
    renderRightPanel();
    showToast('Verified bubble #' + info.index + '!');
  });
}
if (el.btnDeletePopupBubble) {
  el.btnDeletePopupBubble.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnDeletePopupBubble.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const info = getActivePopupBlockInfo();
    if (!info || state.isExtracting) return;
    const removedNum = info.index;
    closeLiveBubblePopup();
    deleteBlockById(info.page, info.blk.id);
    showToast('Deleted bubble #' + removedNum);
  });
}
if (el.btnClearLiveSelection) {
  el.btnClearLiveSelection.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.btnClearLiveSelection.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeLiveBubblePopup();
  });
}

document.addEventListener('copy', () => {
  const txt = getSelectedLiveStageText();
  if (txt) {
    showToast('Copied selected Japanese text!');
  }
});

el.activePageImage.addEventListener('load', () => {
  if (state.liveTextMode) {
    renderOverlayBoxes();
  }
});
window.addEventListener('resize', () => {
  const page = getSelectedPage();
  if (page) {
    applyStageZoom(page);
  }
  if (state.liveTextMode && typeof positionOpenLivePopup === 'function') {
    requestAnimationFrame(positionOpenLivePopup);
  }
});
window.addEventListener('scroll', () => {
  if (state.liveTextMode && state.livePopupBlockId && typeof positionOpenLivePopup === 'function') {
    requestAnimationFrame(positionOpenLivePopup);
  }
}, { passive: true });
if (el.viewerViewport) {
  el.viewerViewport.addEventListener('scroll', () => {
    if (state.liveTextMode && state.livePopupBlockId) {
      requestAnimationFrame(positionOpenLivePopup);
    }
  }, { passive: true });
  el.viewerViewport.addEventListener('pointerdown', (ev) => {
    if (
      state.liveTextMode &&
      (state.livePopupBlockId || state.selectedBlockId) &&
      !ev.target.closest('[data-live-text]') &&
      !ev.target.closest('#liveSelectionCard') &&
      !ev.target.closest('#batchStudyDock') &&
      !ev.target.closest('button, input, textarea, select, a')
    ) {
      closeLiveBubblePopup();
    }
  });
}

el.btnDrawBoxMode.addEventListener('click', () => setDrawMode(!state.drawMode));
el.btnExitDrawMode.addEventListener('click', () => setDrawMode(false));

el.btnRedetectPage.addEventListener('click', () => {
  const page = getSelectedPage();
  if (!page || state.isExtracting) return;
  detectBoxesForAllPages([page]);
});

el.btnZoomIn.addEventListener('click', () => stepStageZoom(1));
el.btnZoomOut.addEventListener('click', () => stepStageZoom(-1));
el.btnZoomFit.addEventListener('click', () => resetStageZoomToFit());

// Distraction-Free Fullscreen Manga Reader Controller
let fsHudIdleTimer = null;

function wakeFullscreenHud() {
  if (!state.isViewerFullscreen || !el.fsFloatingHud) return;
  el.fsFloatingHud.classList.remove('is-idle');
  if (fsHudIdleTimer) clearTimeout(fsHudIdleTimer);
  fsHudIdleTimer = setTimeout(() => {
    if (state.isViewerFullscreen && el.fsFloatingHud) {
      el.fsFloatingHud.classList.add('is-idle');
    }
  }, 2200);
}

function setViewerFullscreen(enabled) {
  const next = Boolean(enabled);
  if (next === state.isViewerFullscreen) return;

  // Preserve current normalized panel center across Normal <-> Fullscreen transitions when zoomed
  const page = getSelectedPage();
  let savedRelX = 0.5;
  let savedRelY = 0;
  const preserveZoomFocus = Boolean(page && !state.fitMode && el.viewerViewport && el.activePageImage);
  if (preserveZoomFocus) {
    const vpR = el.viewerViewport.getBoundingClientRect();
    const imgR = el.activePageImage.getBoundingClientRect();
    if (imgR.width > 10 && imgR.height > 10) {
      savedRelX = Math.max(0, Math.min(1, (vpR.left + el.viewerViewport.clientWidth * 0.5 - imgR.left) / imgR.width));
      savedRelY = Math.max(0, Math.min(1, (vpR.top + el.viewerViewport.clientHeight * 0.5 - imgR.top) / imgR.height));
    }
  }

  state.isViewerFullscreen = next;

  // Website-only viewport fullscreen (expands viewer across 100% of the browser tab without triggering OS browser fullscreen)
  if (next) {
    if (state.drawMode) setDrawMode(false);
    setSettingsOpen(false);
    state.preFsShowBoxes = state.showBoxes;
    // Hide noisy boundary boxes in fullscreen so manga art is 100% clutter-free
    state.showBoxes = false;
    if (!state.liveTextMode) {
      state.selectedBlockId = null;
    }
    document.body.classList.add('is-reader-fullscreen');
    if (el.fsFloatingHud) {
      el.fsFloatingHud.classList.remove('hidden');
      wakeFullscreenHud();
    }
  } else {
    if (fsHudIdleTimer) {
      clearTimeout(fsHudIdleTimer);
      fsHudIdleTimer = null;
    }
    document.body.classList.remove('is-reader-fullscreen');
    if (el.fsFloatingHud) {
      el.fsFloatingHud.classList.add('hidden');
      el.fsFloatingHud.classList.remove('is-idle');
    }
    if (!state.liveTextMode) {
      state.showBoxes = Boolean(state.preFsShowBoxes);
    }
  }
  if (el.btnToggleFullscreen) {
    el.btnToggleFullscreen.classList.toggle('is-active', next);
    el.btnToggleFullscreen.setAttribute('aria-pressed', next ? 'true' : 'false');
  }

  applyStageZoom(page);
  if (el.viewerViewport) {
    if (preserveZoomFocus && el.activePageImage) {
      const restoreCenter = () => {
        if (!el.viewerViewport || !el.activePageImage) return;
        applyStageZoom(getSelectedPage());
        const vpR2 = el.viewerViewport.getBoundingClientRect();
        const imgR2 = el.activePageImage.getBoundingClientRect();
        const targetX = imgR2.left + savedRelX * imgR2.width;
        const targetY = imgR2.top + savedRelY * imgR2.height;
        el.viewerViewport.scrollLeft = Math.max(
          0,
          el.viewerViewport.scrollLeft + (targetX - (vpR2.left + el.viewerViewport.clientWidth * 0.5))
        );
        el.viewerViewport.scrollTop = Math.max(
          0,
          el.viewerViewport.scrollTop + (targetY - (vpR2.top + el.viewerViewport.clientHeight * 0.5))
        );
        syncViewportGrabCursor();
      };
      restoreCenter();
      requestAnimationFrame(restoreCenter);
    } else {
      el.viewerViewport.scrollTop = 0;
      el.viewerViewport.scrollLeft = 0;
      requestAnimationFrame(() => applyStageZoom(getSelectedPage()));
    }
  }
  syncBoxesToggleUI();
  renderOverlayBoxes();
  if (!next && state.selectedBlockId && typeof syncSelectedBubbleCardInPlace === 'function') {
    requestAnimationFrame(() => {
      syncSelectedBubbleCardInPlace(state.selectedBlockId, { scrollCard: true });
    });
  }
  if (typeof positionOpenLivePopup === 'function') {
    requestAnimationFrame(positionOpenLivePopup);
  }
  if (el.viewerViewport) {
    el.viewerViewport.focus({ preventScroll: true });
  }
}

if (el.btnToggleFullscreen) {
  el.btnToggleFullscreen.addEventListener('click', () => {
    setViewerFullscreen(!state.isViewerFullscreen);
  });
}
if (el.btnExitFullscreen) {
  el.btnExitFullscreen.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setViewerFullscreen(false);
  });
}
if (el.btnFsPrevPage) {
  el.btnFsPrevPage.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    goToPageByOffset(-1, { animateSlide: true });
  });
}
if (el.btnFsNextPage) {
  el.btnFsNextPage.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    goToPageByOffset(1, { animateSlide: true });
  });
}
if (el.btnFsZoomOut) {
  el.btnFsZoomOut.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    stepStageZoom(-1);
  });
}
if (el.btnFsZoomFit) {
  el.btnFsZoomFit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    resetStageZoomToFit();
  });
}
if (el.btnFsZoomIn) {
  el.btnFsZoomIn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    stepStageZoom(1);
  });
}
if (el.btnFsSelectText) {
  el.btnFsSelectText.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    setLiveTextMode(!state.liveTextMode);
  });
}
if (el.btnFsBatchSelect) {
  el.btnFsBatchSelect.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    setBatchSelectMode(!state.batchSelectMode);
  });
}
if (el.batchStudyDock) {
  el.batchStudyDock.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  el.batchStudyDock.addEventListener('click', (ev) => ev.stopPropagation());
  el.batchStudyDock.addEventListener('dblclick', (ev) => ev.stopPropagation());
}
if (el.btnRunBatchStudy) {
  el.btnRunBatchStudy.addEventListener('click', () => {
    requestOrderedBatchStudy();
  });
}
if (el.btnToggleBatchResults) {
  el.btnToggleBatchResults.addEventListener('click', () => {
    state.batchStudyExpanded = !state.batchStudyExpanded;
    renderBatchStudyDock();
  });
}
if (el.btnBatchUndoLast) {
  el.btnBatchUndoLast.addEventListener('click', () => {
    if (state.batchQueue.length > 0) {
      removeBatchStepAt(state.batchQueue.length - 1);
    }
  });
}
if (el.btnClearBatchQueue) {
  el.btnClearBatchQueue.addEventListener('click', () => {
    clearBatchStudyQueue();
    showToast('Cleared batch selection queue.');
  });
}
if (el.btnCloseBatchDock) {
  el.btnCloseBatchDock.addEventListener('click', () => {
    if (state.batchSelectMode) {
      setBatchSelectMode(false);
    }
    if (state.batchQueue.length > 0 || state.batchStudyResult) {
      clearBatchStudyQueue();
    }
    renderBatchStudyDock();
  });
}
if (el.viewerSection) {
  el.viewerSection.addEventListener('pointermove', wakeFullscreenHud, { passive: true });
  el.viewerSection.addEventListener('pointerdown', wakeFullscreenHud, { passive: true });
}

// Right Panel Tabs, Toolbar/Banner Review Jump, Sidebar Review Filter & Export Actions
el.tabBtnAllText.addEventListener('click', () => setActiveTab('all'));
el.tabBtnPageBubbles.addEventListener('click', () => setActiveTab('bubbles'));
if (el.tabBtnReviewQueue) {
  el.tabBtnReviewQueue.addEventListener('click', () => openReviewAndFocusFirst());
}
if (el.tabBtnSavedVocab) {
  el.tabBtnSavedVocab.addEventListener('click', () => setActiveTab('vocab'));
}
if (el.btnToolbarReviewJump) {
  el.btnToolbarReviewJump.addEventListener('click', () => openReviewAndFocusFirst());
}
if (el.btnBannerOpenReview) {
  el.btnBannerOpenReview.addEventListener('click', () => openReviewAndFocusFirst());
}
if (el.btnBannerNextReview) {
  el.btnBannerNextReview.addEventListener('click', () => jumpToLowConfidenceByStep(1));
}
if (el.btnSidebarReviewFilter) {
  el.btnSidebarReviewFilter.addEventListener('click', () => {
    state.filterReviewPagesOnly = !state.filterReviewPagesOnly;
    if (state.filterReviewPagesOnly) {
      openReviewAndFocusFirst();
    }
    renderPageList();
  });
}

el.chkIncludeHeaders.addEventListener('change', () => {
  state.includeHeaders = el.chkIncludeHeaders.checked;
  el.fullMangaTextarea.value = buildCombinedMangaTranscript();
});

// Selecting text inside Full Manga transcript also highlights the corresponding page bubble & Page Bubbles card
if (el.fullMangaTextarea) {
  const syncFromFullTranscriptSelection = () => {
    if (typeof findTranscriptBlockAtOffset !== 'function') return;
    const s = el.fullMangaTextarea.selectionStart;
    const e = el.fullMangaTextarea.selectionEnd;
    if (typeof s !== 'number' || typeof e !== 'number' || e <= s) return;
    const hit = findTranscriptBlockAtOffset(s, e);
    if (!hit || !hit.blk || !hit.page) return;
    if (hit.page.id !== state.selectedPageId) {
      state.selectedPageId = hit.page.id;
      state.livePopupBlockId = null;
      if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');
      syncSelectedPageCardInSidebar(true);
      renderActivePageStage();
    }
    if (state.selectedBlockId !== hit.blk.id) {
      state.selectedBlockId = hit.blk.id;
      syncToolbarBoxDeleteBtn();
      renderOverlayBoxes();
      scrollViewportToBlockIfNeeded(hit.page, hit.blk);
      if (typeof syncSelectedBubbleCardInPlace === 'function') {
        syncSelectedBubbleCardInPlace(hit.blk.id, { scrollCard: true });
      }
    }
  };
  el.fullMangaTextarea.addEventListener('select', syncFromFullTranscriptSelection);
  el.fullMangaTextarea.addEventListener('mouseup', syncFromFullTranscriptSelection);
  el.fullMangaTextarea.addEventListener('keyup', syncFromFullTranscriptSelection);
}

el.btnFontSmaller.addEventListener('click', () => {
  state.jpFontSize = Math.max(12, state.jpFontSize - 2);
  renderRightPanel();
});
el.btnFontLarger.addEventListener('click', () => {
  state.jpFontSize = Math.min(28, state.jpFontSize + 2);
  renderRightPanel();
});

el.btnCopyAllText.addEventListener('click', () => {
  copyTextSafe(buildCombinedMangaTranscript(), 'Copied full Japanese manga script!');
});

el.btnDownloadTxt.addEventListener('click', () => {
  const txt = buildCombinedMangaTranscript();
  if (!txt) {
    showToast('Extract Japanese text first before downloading .txt.', 'warn');
    return;
  }
  triggerBlobDownload('ankisuru_japanese_extracted.txt', 'text/plain;charset=utf-8', txt);
  showToast('Downloaded ankisuru_japanese_extracted.txt');
});

el.btnDownloadJson.addEventListener('click', () => {
  if (state.pages.length === 0) {
    showToast('No manga pages loaded to export.', 'warn');
    return;
  }
  const payload = {
    app: 'AnkiSuru',
    version: '1.0.0-ankisuru',
    ocr_engine: state.ocrEngine,
    detector: state.detectorMode,
    reading_order: state.readingOrder,
    pages: state.pages.map((p, idx) => ({
      page_index: idx + 1,
      img_path: p.relativePath || p.name,
      img_width: p.width,
      img_height: p.height,
      blocks: (p.blocks || []).map((b, bIdx) => ({
        order: bIdx + 1,
        box: [b.x1, b.y1, b.x2, b.y2],
        vertical: (b.y2 - b.y1) > (b.x2 - b.x1),
        confidence: b.charConf,
        lines: b.text ? [b.text] : [],
        romaji: b.study && b.study.romaji ? b.study.romaji : undefined,
        english: b.study && b.study.english ? b.study.english : undefined,
        nuance: b.study && b.study.nuance ? b.study.nuance : undefined,
        study_breakdown: b.study && b.study.breakdown ? b.study.breakdown : undefined
      }))
    }))
  };
  triggerBlobDownload('ankisuru_ocr.json', 'application/json;charset=utf-8', JSON.stringify(payload, null, 2));
  showToast('Downloaded ankisuru_ocr.json');
});

// Stack & CLI Modal
el.btnOpenStackModal.addEventListener('click', () => el.stackModal.classList.remove('hidden'));
el.btnCloseStackModal.addEventListener('click', () => el.stackModal.classList.add('hidden'));
el.btnCloseStackModalBottom.addEventListener('click', () => el.stackModal.classList.add('hidden'));
el.stackModal.addEventListener('click', (ev) => {
  if (ev.target === el.stackModal) el.stackModal.classList.add('hidden');
});
el.btnCopyCliCmd.addEventListener('click', () => {
  copyTextSafe(el.cliCommandBlock.textContent, 'Copied mokuro CLI commands!');
});

// Dark / Light Mode Segmented Material UI Toggle & Persistence
const THEME_STORAGE_KEY = 'ankisuru_theme_v1';
function syncThemeToggleUI() {
  const isDark = document.documentElement.classList.contains('dark');
  if (el.btnThemeLight) {
    el.btnThemeLight.classList.toggle('is-active', !isDark);
    el.btnThemeLight.setAttribute('aria-pressed', !isDark ? 'true' : 'false');
    el.btnThemeLight.setAttribute('data-tip', !isDark ? 'Light mode (Active)' : 'Switch to Light mode');
  }
  if (el.btnThemeDark) {
    el.btnThemeDark.classList.toggle('is-active', isDark);
    el.btnThemeDark.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    el.btnThemeDark.setAttribute('data-tip', isDark ? 'Dark mode (Active)' : 'Switch to Dark mode');
  }
  if (el.iconLightFilled) el.iconLightFilled.classList.toggle('hidden', isDark);
  if (el.iconLightOutlined) el.iconLightOutlined.classList.toggle('hidden', !isDark);
  if (el.iconDarkFilled) el.iconDarkFilled.classList.toggle('hidden', !isDark);
  if (el.iconDarkOutlined) el.iconDarkOutlined.classList.toggle('hidden', isDark);
}
function setAppTheme(mode) {
  const useDark = mode === 'dark';
  document.documentElement.classList.toggle('dark', useDark);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, useDark ? 'dark' : 'light');
  } catch (_e) {}
  syncThemeToggleUI();
}
if (el.btnThemeLight) {
  el.btnThemeLight.addEventListener('click', () => setAppTheme('light'));
}
if (el.btnThemeDark) {
  el.btnThemeDark.addEventListener('click', () => setAppTheme('dark'));
}
if (window.matchMedia) {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = (ev) => {
      try {
        if (!localStorage.getItem(THEME_STORAGE_KEY)) {
          document.documentElement.classList.toggle('dark', Boolean(ev.matches));
          syncThemeToggleUI();
        }
      } catch (_e) {}
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onSystemThemeChange);
    }
  } catch (_e) {}
}
syncThemeToggleUI();

// Initialize Material settings summary & helper captions
updateSettingsSummaryChip();

// Initialize saved Gemini key/config, parallel worker pool, local server probe, & sample pages
el.inputBackendUrl.value = state.nativeBackend.url;
loadSavedGeminiConfig();
loadSavedVocabConfig();
ensureAiWorker();
probeNativeBackend(state.nativeBackend.url, true);
loadBuiltInSamples();
if (typeof ensureOfflineRomajiEngine === 'function') {
  setTimeout(() => {
    ensureOfflineRomajiEngine();
    if (typeof ensureInstantVocabDictionary === 'function') {
      ensureInstantVocabDictionary();
    }
  }, 250);
}
