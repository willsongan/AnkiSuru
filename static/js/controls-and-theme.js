"use strict";

// -----------------------------------------------------------------------
// Interactive Manual Box Drawing on Manga Page Stage
// -----------------------------------------------------------------------
let dragStart = null;

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
  state.liveTextMode = next;
  if (!next) state.livePopupBlockId = null;
  if (next) {
    state.selectedBlockId = null;
    const page = getSelectedPage();
    if (page) {
      const hasAnyText = (page.blocks || []).some((b) => Boolean((b.text || '').trim()));
      if (!hasAnyText) {
        if (state.isSampleSet && typeof populateSampleGroundTruthForPage === 'function') {
          populateSampleGroundTruthForPage(page);
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
      state.livePopupBlockId &&
      !ev.target.closest('[data-live-text]') &&
      !ev.target.closest('#liveSelectionCard')
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
      target.charConf = res.charConf;
      page.status = 'done';
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
  if (el.helperDetector) {
    el.helperDetector.textContent = state.detectorMode === 'rtdetr-int8'
      ? 'RT-DETRv2 · 11 MB · Default'
      : state.detectorMode === 'ctd-onnx'
      ? 'Mokuro YOLOv5 · 95 MB · WebGPU'
      : state.detectorMode === 'bubble-heuristic'
      ? 'Instant pixel cluster · 0 MB'
      : 'Single pre-cropped bubble';
  }
  if (el.helperOcrEngine) {
    el.helperOcrEngine.textContent = state.ocrEngine === 'manga-ocr-cpt'
      ? 'JP-only SOTA · 0.86% CER'
      : state.ocrEngine === 'manga-ocr'
      ? 'Classic base · 4.81% CER'
      : 'Lightweight fallback · ~15 MB';
  }
  if (el.helperReadingOrder) {
    el.helperReadingOrder.textContent = state.readingOrder === 'rtl'
      ? 'Japanese manga panels'
      : state.readingOrder === 'ttb'
      ? 'Vertical webtoon strips'
      : 'Western comic panels';
  }
  if (el.helperWorkerPool) {
    el.helperWorkerPool.textContent = state.workerPoolSetting === 'auto'
      ? 'Auto-scaled (' + DEFAULT_DET_WORKERS + ' threads)'
      : state.workerPoolSetting === '1'
      ? 'Single worker · Low RAM'
      : state.workerPoolSetting + ' concurrent OS threads';
  }
  if (el.chkAutoPruneNonJp && el.chkAutoPruneNonJp.parentElement) {
    el.chkAutoPruneNonJp.parentElement.classList.toggle('is-checked', Boolean(state.autoPruneNonJp));
  }
}

function updateSettingsSummaryChip() {
  updateSettingsHelperTexts();
  const geminiSuffix = (state.gemini && state.gemini.apiKey) ? ' · Gemini' : '';
  if (state.nativeBackend.connected) {
    const acc = (state.nativeBackend.info && state.nativeBackend.info.accelerator) || 'Native Server';
    el.settingsSummaryChip.textContent = acc + ' · ' + state.readingOrder.toUpperCase() + geminiSuffix;
    return;
  }
  const detShort = state.detectorMode === 'rtdetr-int8'
    ? 'Turbo INT8'
    : state.detectorMode === 'ctd-onnx'
    ? 'Mokuro CTD'
    : state.detectorMode === 'bubble-heuristic'
    ? 'Heuristic'
    : 'Whole Image';
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

  // Reader Keyboard Shortcuts: 'F' toggles Fullscreen Reader; 'S' toggles Select Text mode
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
    if (!state.selectedBlockId && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
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

// Interactive Pointer Drag-to-Slide / Touch Swipe on Manga Stage
el.viewerViewport.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || state.drawMode || boxManip) return;
  if (!getSelectedPage() || state.pages.length <= 1) return;
  if (ev.target.closest('[data-bbox-id], [data-live-text], #liveSelectionCard, button, input, a, #emptyViewerState')) return;

  const vpRect = el.viewerViewport.getBoundingClientRect();
  if (
    ev.clientX > vpRect.left + el.viewerViewport.clientWidth ||
    ev.clientY > vpRect.top + el.viewerViewport.clientHeight
  ) {
    return;
  }
  const hasHorizOverflow = !state.fitMode && (el.viewerViewport.scrollWidth > el.viewerViewport.clientWidth + 8);
  if (hasHorizOverflow) return;

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
    const sRect = el.stageImageWrapper.getBoundingClientRect();
    const anchorRect = reg.getBoundingClientRect();
    el.liveSelectionCard.classList.remove('hidden', 'place-above', 'place-below');
    const cardW = Math.min(360, Math.max(236, el.liveSelectionCard.offsetWidth || 260));
    const centerLeft = (anchorRect.left + anchorRect.right) * 0.5 - sRect.left - cardW * 0.5;
    const clampedLeft = Math.max(8, Math.min(Math.max(8, sRect.width - cardW - 8), centerLeft));
    const relTop = anchorRect.top - sRect.top;
    const relBottom = anchorRect.bottom - sRect.top;

    el.liveSelectionCard.style.left = Math.round(clampedLeft) + 'px';
    if (relTop >= 104) {
      el.liveSelectionCard.classList.add('place-above');
      el.liveSelectionCard.style.top = Math.round(relTop - 8) + 'px';
    } else {
      el.liveSelectionCard.classList.add('place-below');
      el.liveSelectionCard.style.top = Math.round(Math.min(sRect.height - 12, relBottom + 8)) + 'px';
    }
  } catch (_e) {
    el.liveSelectionCard.classList.add('hidden');
  }
}

function openLiveBubblePopup(blockId) {
  state.livePopupBlockId = blockId;
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
  positionOpenLivePopup();
  syncLiveSelectionUI();
}

function closeLiveBubblePopup() {
  state.livePopupBlockId = null;
  if (window.getSelection) {
    try { window.getSelection().removeAllRanges(); } catch (_e) {}
  }
  if (el.bboxOverlayLayer) {
    el.bboxOverlayLayer.querySelectorAll('.live-text-region.has-selection').forEach((n) => {
      n.classList.remove('has-selection');
    });
  }
  if (el.liveSelectionCard) {
    el.liveSelectionCard.classList.add('hidden');
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

  const sub = getPopupHighlightedSubstring();
  const totalChars = Array.from(info.text).length;
  const subChars = sub ? Array.from(sub).length : 0;

  if (el.btnCopySelectedLiveText) {
    el.btnCopySelectedLiveText.disabled = false;
  }
  const needsReview = isBlockBelowReviewThreshold(info.blk, info.page);
  const confPct = typeof info.blk.charConf === 'number' ? Math.round(info.blk.charConf * 100) : null;
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
  // Sync Offline Romaji toggle button & live Romaji readout (without clobbering active drag inside #liveSelRomajiBody)
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

// Double-click anywhere on the manga page to auto-start fast single-page extraction
el.stageImageWrapper.addEventListener('dblclick', (ev) => {
  if (state.drawMode) return;
  if (ev.target.closest('#liveSelectionCard, .bbox-quickbar, [data-resize-dir], button, input, textarea, select, a')) {
    return;
  }
  const page = getSelectedPage();
  if (!page) return;
  // In Select Text mode, let clicks on already-extracted bubble hotspots open the sentence popup without re-running OCR
  if (state.liveTextMode && ev.target.closest('[data-live-text]')) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (window.getSelection) {
    try { window.getSelection().removeAllRanges(); } catch (_e) {}
  }
  quickExtractSinglePage(page);
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
  try {
    const savedRom = localStorage.getItem('ankisuru_popup_romaji_v1');
    if (savedRom === '0') state.showPopupRomaji = false;
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
      localStorage.setItem('ankisuru_popup_romaji_v1', state.showPopupRomaji ? '1' : '0');
    } catch (_e) {}
    syncLiveSelectionUI();
    positionOpenLivePopup();
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
  if (state.liveTextMode && typeof positionOpenLivePopup === 'function') {
    requestAnimationFrame(positionOpenLivePopup);
  }
});

el.btnDrawBoxMode.addEventListener('click', () => setDrawMode(!state.drawMode));
el.btnExitDrawMode.addEventListener('click', () => setDrawMode(false));

el.btnRedetectPage.addEventListener('click', () => {
  const page = getSelectedPage();
  if (!page || state.isExtracting) return;
  detectBoxesForAllPages([page]);
});

el.btnZoomIn.addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = Math.min(2.5, +(state.zoom + 0.2).toFixed(2));
  applyStageZoom(getSelectedPage());
});
el.btnZoomOut.addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = Math.max(0.3, +(state.zoom - 0.2).toFixed(2));
  applyStageZoom(getSelectedPage());
});
el.btnZoomFit.addEventListener('click', () => {
  state.fitMode = true;
  state.zoom = 1.0;
  applyStageZoom(getSelectedPage());
});

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
  state.isViewerFullscreen = next;

  // Website-only viewport fullscreen (expands viewer across 100% of the browser tab without triggering OS browser fullscreen)
  if (next) {
    if (state.drawMode) setDrawMode(false);
    setSettingsOpen(false);
    state.preFsShowBoxes = state.showBoxes;
    // Hide noisy boundary boxes in fullscreen so manga art is 100% clutter-free
    state.showBoxes = false;
    state.selectedBlockId = null;
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

  applyStageZoom(getSelectedPage());
  syncBoxesToggleUI();
  renderOverlayBoxes();
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
if (el.btnFsSelectText) {
  el.btnFsSelectText.addEventListener('click', (ev) => {
    ev.stopPropagation();
    wakeFullscreenHud();
    setLiveTextMode(!state.liveTextMode);
  });
}
if (el.viewerSection) {
  el.viewerSection.addEventListener('pointermove', wakeFullscreenHud, { passive: true });
  el.viewerSection.addEventListener('pointerdown', wakeFullscreenHud, { passive: true });
}

// Right Panel Tabs & Export Actions
el.tabBtnAllText.addEventListener('click', () => setActiveTab('all'));
el.tabBtnPageBubbles.addEventListener('click', () => setActiveTab('bubbles'));

el.chkIncludeHeaders.addEventListener('change', () => {
  state.includeHeaders = el.chkIncludeHeaders.checked;
  el.fullMangaTextarea.value = buildCombinedMangaTranscript();
});

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
ensureAiWorker();
probeNativeBackend(state.nativeBackend.url, true);
loadBuiltInSamples();
if (typeof ensureOfflineRomajiEngine === 'function') {
  setTimeout(() => { ensureOfflineRomajiEngine(); }, 250);
}
