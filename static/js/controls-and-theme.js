"use strict";

// -----------------------------------------------------------------------
// Interactive Manual Box Drawing on Manga Page Stage
// -----------------------------------------------------------------------
let dragStart = null;

function setDrawMode(enabled) {
  state.drawMode = enabled;
  el.drawModeBanner.classList.toggle('hidden', !enabled);
  el.stageImageWrapper.style.cursor = enabled ? 'crosshair' : 'default';
  el.btnDrawBoxMode.classList.toggle('is-danger-active', Boolean(enabled));
  el.btnDrawBoxMode.setAttribute('data-tip', enabled ? 'Exit Draw Mode' : 'Draw Box');
  if (enabled) {
    if (!state.showBoxes) {
      state.showBoxes = true;
      syncBoxesToggleUI();
      renderOverlayBoxes();
    }
  } else {
    el.rubberBandBox.classList.add('hidden');
    dragStart = null;
  }
}

function stagePointerCoords(clientX, clientY) {
  const rect = el.stageImageWrapper.getBoundingClientRect();
  const rx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  const ry = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  return { rx, ry };
}

el.stageImageWrapper.addEventListener('pointerdown', (ev) => {
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

function updateSettingsSummaryChip() {
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
  el.btnToggleSettings.classList.toggle('bg-indigo-50', open);
  el.btnToggleSettings.classList.toggle('border-indigo-300', open);
  el.btnToggleSettings.classList.toggle('text-indigo-700', open);
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
  if (p) extractPagesQueue([p]);
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
  if (ev.target.closest('[data-bbox-id], button, input, a, #emptyViewerState')) return;

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
  state.showBoxes = !state.showBoxes;
  syncBoxesToggleUI();
  renderOverlayBoxes();
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

// Auto-collapse intro title bar after 3.5 seconds to maximize manga workspace
updateSettingsSummaryChip();
setTimeout(() => {
  if (el.titleBanner) {
    el.titleBanner.classList.add('is-collapsed');
  }
}, 3500);

// Initialize saved Gemini key/config, parallel worker pool, local server probe, & sample pages
el.inputBackendUrl.value = state.nativeBackend.url;
loadSavedGeminiConfig();
ensureAiWorker();
probeNativeBackend(state.nativeBackend.url, true);
loadBuiltInSamples();
