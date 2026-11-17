"use strict";

// -----------------------------------------------------------------------
// Rendering Functions
// -----------------------------------------------------------------------
function getSelectedPage() {
  return state.pages.find((p) => p.id === state.selectedPageId) || null;
}

function renderAll() {
  renderPageList();
  renderActivePageStage();
  renderRightPanel();
}

function movePageOrder(fromIdx, toIdx) {
  if (state.isExtracting) return;
  if (fromIdx < 0 || fromIdx >= state.pages.length) return;
  if (toIdx < 0 || toIdx >= state.pages.length || fromIdx === toIdx) return;
  const [moved] = state.pages.splice(fromIdx, 1);
  state.pages.splice(toIdx, 0, moved);
  renderAll();
}

// Pointer-based page list drag reordering (works reliably in sandboxed iframes without colliding with OS file drop)
let pageSortDrag = null;
let suppressNextPageClick = false;

function clearPageDropIndicators() {
  const cards = el.pageListContainer.querySelectorAll('[data-page-idx]');
  cards.forEach((c) => {
    c.classList.remove('page-drop-above', 'page-drop-below', 'opacity-50');
  });
}

function applyPageStatusBadgeStyle(statusBadge, page) {
  if (page.status === 'done') {
    const revCount = countPageReviewBlocks(page);
    if (revCount > 0) {
      statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300';
      statusBadge.textContent = '⚠ ' + revCount + ' <90%';
      statusBadge.title = revCount + ' bubble(s) below 90% OCR confidence need review';
    } else {
      statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800';
      statusBadge.textContent = 'Extracted';
      statusBadge.title = '';
    }
  } else if (page.status === 'detecting') {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 animate-pulse';
    statusBadge.textContent = 'Detecting…';
  } else if (page.status === 'recognizing') {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 animate-pulse';
    statusBadge.textContent = 'OCR…';
  } else if (page.boxesDetected) {
    statusBadge.className = page.blocks.length > 0
      ? 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200'
      : 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200';
    statusBadge.textContent = page.blocks.length + (page.blocks.length === 1 ? ' box' : ' boxes');
  } else {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600';
    statusBadge.textContent = 'Ready';
  }
}

// O(1) incremental card update so 200+ page volumes never rebuild 200+ DOM nodes on every bubble
function updatePageCardInPlace(page) {
  if (!page) return;
  const card = el.pageListContainer.querySelector('[data-page-id="' + page.id + '"]');
  if (!card) return;
  const badge = card.querySelector('[data-role="status"]');
  if (badge) applyPageStatusBadgeStyle(badge, page);
  const prev = card.querySelector('[data-role="preview"]');
  if (prev) {
    prev.textContent = page.fullText
      ? page.fullText.replace(/\n+/g, ' ')
      : 'Click Extract to read Japanese';
  }
}

function renderPageList() {
  const count = state.pages.length;
  el.pagesSummaryCount.textContent = count + (count === 1 ? ' page loaded' : ' pages loaded');
  el.detectAllBoxesLabel.textContent = count > 0
    ? 'Detect All Boxes (' + count + ')'
    : 'Detect All Boxes';
  el.extractAllLabel.textContent = count > 0
    ? 'Extract All Japanese Text (' + count + ')'
    : 'Extract All Japanese Text';
  el.btnDetectAllBoxes.disabled = state.isExtracting || count === 0;
  el.btnExtractAll.disabled = state.isExtracting || count === 0;
  el.sampleNoticeBanner.classList.toggle('hidden', !state.isSampleSet || count === 0);

  el.pageListContainer.innerHTML = '';
  if (count === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'text-xs text-slate-400 text-center py-6 px-2';
    emptyMsg.textContent = 'No manga pages queued yet.';
    el.pageListContainer.appendChild(emptyMsg);
    return;
  }

  state.pages.forEach((page, idx) => {
    const isSelected = page.id === state.selectedPageId;
    const card = document.createElement('div');
    card.setAttribute('data-page-idx', String(idx));
    card.setAttribute('data-page-id', page.id);
    card.className =
      'group flex items-center gap-2 p-2 rounded-lg border cursor-pointer select-none transition ' +
      (isSelected
        ? 'border-indigo-500 bg-indigo-50/70 shadow-sm'
        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50');

    // Drag Grip Handle
    const grip = document.createElement('div');
    grip.className = 'text-slate-400 hover:text-indigo-600 cursor-grab active:cursor-grabbing px-0.5 py-2 shrink-0 touch-none';
    grip.title = 'Drag up or down to rearrange page order';
    grip.innerHTML = '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16"><circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>';

    const thumb = document.createElement('img');
    thumb.src = page.url;
    thumb.alt = page.name;
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    thumb.draggable = false;
    thumb.className = 'w-9 h-13 object-cover rounded border border-slate-200 bg-slate-100 shrink-0 pointer-events-none';

    const meta = document.createElement('div');
    meta.className = 'min-w-0 flex-1';

    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center justify-between gap-1';
    const numSpan = document.createElement('span');
    numSpan.className = 'text-[11px] font-bold text-slate-500';
    numSpan.textContent = '#' + (idx + 1);

    const statusBadge = document.createElement('span');
    statusBadge.setAttribute('data-role', 'status');
    applyPageStatusBadgeStyle(statusBadge, page);
    titleRow.appendChild(numSpan);
    titleRow.appendChild(statusBadge);

    const nameP = document.createElement('p');
    nameP.className = 'text-xs font-medium text-slate-800 truncate mt-0.5';
    nameP.textContent = page.name;

    const previewP = document.createElement('p');
    previewP.setAttribute('data-role', 'preview');
    previewP.className = 'jp-text text-[11px] text-slate-500 truncate mt-0.5';
    previewP.textContent = page.fullText
      ? page.fullText.replace(/\n+/g, ' ')
      : 'Click Extract to read Japanese';

    meta.appendChild(titleRow);
    meta.appendChild(nameP);
    meta.appendChild(previewP);

    // Rearrange Up/Down + Delete Controls
    const controlsCol = document.createElement('div');
    controlsCol.className = 'flex flex-col items-center gap-0.5 shrink-0';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.title = 'Move page up';
    upBtn.disabled = idx === 0 || state.isExtracting;
    upBtn.className = 'p-0.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-25 disabled:pointer-events-none transition';
    upBtn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg>';
    upBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      movePageOrder(idx, idx - 1);
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.title = 'Move page down';
    downBtn.disabled = idx === count - 1 || state.isExtracting;
    downBtn.className = 'p-0.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-25 disabled:pointer-events-none transition';
    downBtn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>';
    downBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      movePageOrder(idx, idx + 1);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.title = 'Remove page';
    delBtn.className = 'p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition';
    delBtn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.isExtracting) return;
      if (page.isObjectUrl && page.url) {
        try { URL.revokeObjectURL(page.url); } catch (_e) { /* ignore */ }
      }
      state.pages = state.pages.filter((p) => p.id !== page.id);
      if (state.selectedPageId === page.id) {
        state.selectedPageId = state.pages[0] ? state.pages[0].id : null;
        state.selectedBlockId = null;
      }
      renderAll();
    });

    controlsCol.appendChild(upBtn);
    controlsCol.appendChild(downBtn);
    controlsCol.appendChild(delBtn);

    card.appendChild(grip);
    card.appendChild(thumb);
    card.appendChild(meta);
    card.appendChild(controlsCol);

    // Pointer-based drag reorder on card/grip
    card.addEventListener('pointerdown', (ev) => {
      if (state.isExtracting || ev.button !== 0) return;
      if (ev.target.closest('button')) return;
      pageSortDrag = {
        fromIdx: idx,
        toIdx: idx,
        startY: ev.clientY,
        moved: false,
        pointerId: ev.pointerId,
        cardEl: card
      };
    });

    card.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      if (suppressNextPageClick || (pageSortDrag && pageSortDrag.moved)) return;
      const targetIdx = state.pages.findIndex((p) => p.id === page.id);
      if (targetIdx >= 0) {
        goToPageIndex(targetIdx, { animateSlide: true, scrollSidebar: false });
      }
    });

    card.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      const targetIdx = state.pages.findIndex((p) => p.id === page.id);
      if (targetIdx >= 0 && state.selectedPageId !== page.id) {
        goToPageIndex(targetIdx, { animateSlide: false, scrollSidebar: false });
      }
      quickExtractSinglePage(page);
    });

    el.pageListContainer.appendChild(card);
  });
}

window.addEventListener('pointermove', (ev) => {
  if (!pageSortDrag) return;
  const dy = Math.abs(ev.clientY - pageSortDrag.startY);
  if (!pageSortDrag.moved && dy < 6) return;
  pageSortDrag.moved = true;
  clearPageDropIndicators();
  pageSortDrag.cardEl.classList.add('opacity-50');

  // Auto-scroll pageListContainer near top/bottom edges
  const listRect = el.pageListContainer.getBoundingClientRect();
  if (ev.clientY < listRect.top + 28) {
    el.pageListContainer.scrollTop -= 8;
  } else if (ev.clientY > listRect.bottom - 28) {
    el.pageListContainer.scrollTop += 8;
  }

  const cards = Array.from(el.pageListContainer.querySelectorAll('[data-page-idx]'));
  let targetIdx = pageSortDrag.fromIdx;
  let insertAfter = false;

  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    const midY = r.top + r.height * 0.5;
    if (ev.clientY < midY) {
      targetIdx = i;
      insertAfter = false;
      cards[i].classList.add('page-drop-above');
      break;
    }
    if (i === cards.length - 1) {
      targetIdx = i;
      insertAfter = true;
      cards[i].classList.add('page-drop-below');
    }
  }

  let finalIdx = insertAfter ? targetIdx : targetIdx;
  if (!insertAfter && targetIdx > pageSortDrag.fromIdx) {
    finalIdx = targetIdx - 1;
  }
  pageSortDrag.toIdx = Math.max(0, Math.min(state.pages.length - 1, finalIdx));
});

window.addEventListener('pointerup', () => {
  if (!pageSortDrag) return;
  const drag = pageSortDrag;
  pageSortDrag = null;
  clearPageDropIndicators();
  if (drag.moved) {
    suppressNextPageClick = true;
    setTimeout(() => { suppressNextPageClick = false; }, 80);
    if (drag.fromIdx !== drag.toIdx) {
      movePageOrder(drag.fromIdx, drag.toIdx);
    }
  }
});

function deleteBlockById(page, blockId) {
  if (!page || !blockId || state.isExtracting) return;
  const prevIdx = page.blocks.findIndex((b) => b.id === blockId);
  if (prevIdx < 0) return;
  page.blocks.splice(prevIdx, 1);
  page.boxesDetected = true;
  updatePageFullText(page);
  if (state.selectedBlockId === blockId) {
    const nextBlk = page.blocks[prevIdx] || page.blocks[prevIdx - 1] || null;
    state.selectedBlockId = nextBlk ? nextBlk.id : null;
  }
  renderAll();
}

async function ocrSingleBlockById(page, blockId) {
  if (!page || !blockId || state.isExtracting) return;
  const idx = page.blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return;
  const blk = page.blocks[idx];
  try {
    state.abortRequested = false;
    setExtractingUI(true);
    setProgress(true, 'Recognizing bubble #' + (idx + 1) + '…', 45);
    const im = await loadImageElement(page.url);
    const res = await recognizeSingleBlock(im, blk);
    blk.text = res.text;
    blk.charConf = res.charConf;
    page.status = 'done';
    updatePageFullText(page);
    setProgress(false);
    showToast('Updated bubble #' + (idx + 1));
  } catch (err) {
    setProgress(false);
    if (!err || err.message !== 'ABORTED') {
      showToast('Bubble OCR failed: ' + (err ? err.message : ''), 'error');
    }
  } finally {
    setExtractingUI(false);
    renderAll();
  }
}

function syncToolbarBoxDeleteBtn() {
  const page = getSelectedPage();
  const hasSel = Boolean(page && state.selectedBlockId && page.blocks.some((b) => b.id === state.selectedBlockId));
  el.btnDeleteSelectedBox.disabled = state.isExtracting || !hasSel;
}

const SELECTED_CARD_CLS = ['border-indigo-500', 'bg-indigo-50/70', 'shadow-sm'];
const UNSELECTED_CARD_CLS = ['border-slate-200', 'bg-white', 'hover:border-slate-300', 'hover:bg-slate-50'];
let slideAnimTimer = null;

function syncSelectedPageCardInSidebar(scrollIntoViewIfNeeded) {
  const cards = el.pageListContainer.querySelectorAll('[data-page-id]');
  if (cards.length !== state.pages.length) {
    renderPageList();
  }
  let activeCard = null;
  el.pageListContainer.querySelectorAll('[data-page-id]').forEach((c) => {
    const isSel = c.getAttribute('data-page-id') === state.selectedPageId;
    if (isSel) {
      c.classList.remove(...UNSELECTED_CARD_CLS);
      c.classList.add(...SELECTED_CARD_CLS);
      activeCard = c;
    } else {
      c.classList.remove(...SELECTED_CARD_CLS);
      c.classList.add(...UNSELECTED_CARD_CLS);
    }
  });
  if (scrollIntoViewIfNeeded && activeCard) {
    activeCard.scrollIntoView({ block: 'nearest' });
  }
}

function preloadNeighborPages(centerIdx) {
  [centerIdx + 1, centerIdx - 1].forEach((nIdx) => {
    const neighbor = state.pages[nIdx];
    if (neighbor && neighbor.url) {
      const pre = new Image();
      pre.decoding = 'async';
      pre.src = neighbor.url;
    }
  });
}

function resetStageSlideTransform() {
  el.stageImageWrapper.style.transition = '';
  el.stageImageWrapper.style.transform = '';
  el.stageImageWrapper.style.opacity = '';
}

function triggerStageSlideAnim(dir) {
  if (slideAnimTimer) {
    clearTimeout(slideAnimTimer);
    slideAnimTimer = null;
  }
  resetStageSlideTransform();
  el.stageImageWrapper.classList.remove('stage-anim-next', 'stage-anim-prev');
  // Force reflow so rapid consecutive page turns replay the smooth slide animation
  void el.stageImageWrapper.offsetWidth;
  el.stageImageWrapper.classList.add(dir >= 0 ? 'stage-anim-next' : 'stage-anim-prev');
  slideAnimTimer = setTimeout(() => {
    el.stageImageWrapper.classList.remove('stage-anim-next', 'stage-anim-prev');
    slideAnimTimer = null;
  }, 210);
}

function goToPageIndex(targetIdx, opts) {
  const options = opts || {};
  if (targetIdx < 0 || targetIdx >= state.pages.length) return false;
  const prevIdx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  const targetPage = state.pages[targetIdx];
  if (!targetPage) return false;
  if (targetPage.id === state.selectedPageId) {
    resetStageSlideTransform();
    return false;
  }

  const dir = prevIdx >= 0 && targetIdx < prevIdx ? -1 : 1;
  state.selectedPageId = targetPage.id;
  state.selectedBlockId = null;

  syncSelectedPageCardInSidebar(options.scrollSidebar !== false);
  el.viewerViewport.scrollTop = 0;
  if (state.fitMode) {
    el.viewerViewport.scrollLeft = 0;
  }
  renderActivePageStage();
  renderRightPanel();

  if (options.animateSlide !== false) {
    triggerStageSlideAnim(dir);
  } else {
    resetStageSlideTransform();
  }
  preloadNeighborPages(targetIdx);
  return true;
}

function goToPageByOffset(delta, opts) {
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  if (idx < 0) return false;
  return goToPageIndex(idx + delta, opts);
}

function renderActivePageStage() {
  const page = getSelectedPage();
  const total = state.pages.length;
  const idx = page ? state.pages.findIndex((p) => p.id === page.id) : -1;
  const disablePrev = idx <= 0;
  const disableNext = idx < 0 || idx >= total - 1;

  el.btnPrevPage.disabled = disablePrev;
  el.btnNextPage.disabled = disableNext;
  el.btnSideNavPrev.disabled = disablePrev;
  el.btnSideNavNext.disabled = disableNext;
  if (el.btnFsPrevPage) el.btnFsPrevPage.disabled = disablePrev;
  if (el.btnFsNextPage) el.btnFsNextPage.disabled = disableNext;
  el.btnSideNavPrev.classList.toggle('hidden', !page || total <= 1);
  el.btnSideNavNext.classList.toggle('hidden', !page || total <= 1);

  el.btnExtractPage.disabled = state.isExtracting || !page;
  el.btnRedetectPage.disabled = state.isExtracting || !page;
  syncToolbarBoxDeleteBtn();

  if (!page) {
    el.activePageTitle.textContent = 'No page selected';
    el.scrubberPageCounter.textContent = '0 / 0';
    if (el.fsPageCounter) el.fsPageCounter.textContent = '0 / 0';
    el.pageScrubberRange.min = '1';
    el.pageScrubberRange.max = '1';
    el.pageScrubberRange.value = '1';
    el.pageScrubberRange.disabled = true;
    el.emptyViewerState.classList.remove('hidden');
    el.stageImageWrapper.classList.add('hidden');
    return;
  }

  el.emptyViewerState.classList.add('hidden');
  el.stageImageWrapper.classList.remove('hidden');
  el.activePageTitle.textContent = (idx + 1) + '/' + total + ' · ' + page.name;
  el.scrubberPageCounter.textContent = (idx + 1) + ' / ' + total;
  if (el.fsPageCounter) el.fsPageCounter.textContent = (idx + 1) + ' / ' + total;
  el.pageScrubberRange.min = '1';
  el.pageScrubberRange.max = String(Math.max(1, total));
  el.pageScrubberRange.value = String(idx + 1);
  el.pageScrubberRange.disabled = total <= 1;
  el.activePageImage.src = page.url;

  applyStageZoom(page);
  renderOverlayBoxes();
}

function syncBoxesToggleUI() {
  const liveOn = Boolean(state.liveTextMode);
  const boxesVis = Boolean(state.showBoxes) && !liveOn;
  if (el.btnToggleBoxes) {
    el.btnToggleBoxes.classList.toggle('is-active', boxesVis);
    if (el.iconBoxesOn) el.iconBoxesOn.classList.toggle('hidden', !boxesVis);
    if (el.iconBoxesOff) el.iconBoxesOff.classList.toggle('hidden', boxesVis);
    if (el.toggleBoxesSr) el.toggleBoxesSr.textContent = boxesVis ? 'Boxes: On' : 'Boxes: Off';
    el.btnToggleBoxes.setAttribute('data-tip', boxesVis ? 'Hide Boxes' : 'Show Boxes');
  }
  if (el.btnSelectTextMode) {
    el.btnSelectTextMode.classList.toggle('is-active', liveOn);
    el.btnSelectTextMode.setAttribute('aria-pressed', liveOn ? 'true' : 'false');
  }
  if (el.btnFsSelectText) {
    el.btnFsSelectText.classList.toggle('is-active', liveOn);
    el.btnFsSelectText.setAttribute('aria-pressed', liveOn ? 'true' : 'false');
  }
  if (el.liveTextBanner) {
    el.liveTextBanner.classList.toggle('hidden', !liveOn);
  }
  if (el.viewerViewport) {
    el.viewerViewport.classList.toggle('select-none', !liveOn);
  }
  if (el.bboxOverlayLayer) {
    el.bboxOverlayLayer.classList.toggle('is-live-text', liveOn);
  }
  if (!liveOn && el.liveSelectionCard) {
    el.liveSelectionCard.classList.add('hidden');
  }
}

function fitLiveTextSpans() {
  if (!state.liveTextMode || !el.bboxOverlayLayer) return;
  const regions = el.bboxOverlayLayer.querySelectorAll('.live-text-region');
  regions.forEach((reg) => {
    const span = reg.querySelector('.live-text-span');
    if (!span) return;
    const txt = span.textContent || '';
    const charCount = Math.max(1, Array.from(txt).length);
    const rw = Math.max(16, reg.clientWidth || parseFloat(reg.dataset.pxW) || 40);
    const rh = Math.max(16, reg.clientHeight || parseFloat(reg.dataset.pxH) || 40);
    const isVert = span.classList.contains('is-vertical');
    if (isVert) {
      const cols = Math.max(1, Math.round(Math.sqrt((charCount * rw) / Math.max(1, rh * 1.08))));
      const charsPerCol = Math.max(1, Math.ceil(charCount / cols));
      const fontPx = Math.max(9, Math.min(rw / (cols * 1.08), rh / (charsPerCol * 1.02)));
      span.style.fontSize = fontPx.toFixed(1) + 'px';
      span.style.lineHeight = '1.08';
    } else {
      const rows = Math.max(1, Math.round(Math.sqrt((charCount * rh) / Math.max(1, rw * 1.08))));
      const charsPerRow = Math.max(1, Math.ceil(charCount / rows));
      const fontPx = Math.max(9, Math.min(rh / (rows * 1.14), rw / (charsPerRow * 1.02)));
      span.style.fontSize = fontPx.toFixed(1) + 'px';
      span.style.lineHeight = '1.14';
    }
  });
}

function syncZoomFitUI() {
  if (!el.btnZoomFit) return;
  el.btnZoomFit.classList.toggle('is-active', Boolean(state.fitMode));
  el.btnZoomFit.setAttribute(
    'data-tip',
    state.fitMode ? 'Fit to Screen (Active)' : 'Fit to Screen (' + Math.round(state.zoom * 100) + '%)'
  );
}

function applyStageZoom(page) {
  syncZoomFitUI();
  if (!page) return;
  if (state.fitMode) {
    el.activePageImage.style.width = '';
    el.activePageImage.style.maxHeight = state.isViewerFullscreen ? 'calc(100vh - 20px)' : 'calc(100vh - 205px)';
  } else {
    const targetW = Math.round(page.width * state.zoom);
    el.activePageImage.style.maxHeight = 'none';
    el.activePageImage.style.width = targetW + 'px';
  }
  if (state.liveTextMode) {
    requestAnimationFrame(fitLiveTextSpans);
  }
}

// Interactive Box Move & 8-Way Resize State
let boxManip = null;
const RESIZE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function applyBoxGeometryToDom(div, blk, page) {
  div.style.left = ((blk.x1 / page.width) * 100).toFixed(3) + '%';
  div.style.top = ((blk.y1 / page.height) * 100).toFixed(3) + '%';
  div.style.width = (((blk.x2 - blk.x1) / page.width) * 100).toFixed(3) + '%';
  div.style.height = (((blk.y2 - blk.y1) / page.height) * 100).toFixed(3) + '%';
}

function renderOverlayBoxes() {
  el.bboxOverlayLayer.innerHTML = '';
  syncBoxesToggleUI();
  syncToolbarBoxDeleteBtn();
  const page = getSelectedPage();
  if (!page || !page.width || !page.height) return;

  // Select Text Popup Mode: hide boundary boxes and turn speech bubbles into clean click targets
  // that open a crisp, normal-selectable sentence popup right next to the bubble!
  if (state.liveTextMode) {
    if (state.isSampleSet && typeof populateSampleGroundTruthForPage === 'function') {
      const hasTxt = (page.blocks || []).some((b) => Boolean((b.text || '').trim()));
      if (!hasTxt && populateSampleGroundTruthForPage(page)) {
        updatePageCardInPlace(page);
      }
    }
    (page.blocks || []).forEach((blk, idx) => {
      const txt = (blk.text || '').trim();
      if (!txt) return;
      const reg = document.createElement('div');
      const isPopupOpen = state.livePopupBlockId === blk.id;
      const needsReview = isBlockBelowReviewThreshold(blk, page);
      const confPct = typeof blk.charConf === 'number' ? Math.round(blk.charConf * 100) : null;
      reg.className =
        'live-text-region' +
        (needsReview ? ' is-low-conf' : '') +
        (isPopupOpen ? ' has-selection' : '');
      reg.setAttribute('data-live-text', '1');
      reg.setAttribute('data-bbox-id', blk.id);
      reg.title = needsReview
        ? ('⚠ Low OCR (' + (confPct !== null ? confPct + '%' : '<90%') + ' — may be inaccurate) · Click to inspect Bubble #' + (idx + 1))
        : ('Click to open selectable sentence popup (Bubble #' + (idx + 1) + ')');
      applyBoxGeometryToDom(reg, blk, page);

      reg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!state.liveTextMode) return;
        if (typeof openLiveBubblePopup === 'function') {
          openLiveBubblePopup(blk.id);
        }
      });

      el.bboxOverlayLayer.appendChild(reg);
    });
    if (typeof positionOpenLivePopup === 'function') {
      requestAnimationFrame(positionOpenLivePopup);
    }
    return;
  }

  if (!state.showBoxes) return;

  (page.blocks || []).forEach((blk, idx) => {
    const isSelected = blk.id === state.selectedBlockId;
    const isOcrActive = state.activeOcrBlockIds.has(blk.id);
    const needsReview = isBlockBelowReviewThreshold(blk, page);
    const confPct = typeof blk.charConf === 'number' ? Math.round(blk.charConf * 100) : null;
    const div = document.createElement('div');
    div.setAttribute('data-bbox-id', blk.id);
    div.className =
      'bbox-rect' +
      (isSelected ? ' active' : '') +
      (isOcrActive ? ' ocr-working' : '') +
      (!isSelected && !isOcrActive && needsReview ? ' needs-review' : '');
    applyBoxGeometryToDom(div, blk, page);
    div.title = blk.text
      ? '#' + (idx + 1) +
        (confPct !== null ? ' (' + confPct + '% OCR' + (needsReview ? ' · REVIEW <90%' : '') + ')' : '') +
        ': ' + blk.text
      : 'Bubble #' + (idx + 1) + (needsReview ? ' (Empty OCR — review)' : ' (drag to move, handles to resize, Del to remove)');

    const badge = document.createElement('span');
    badge.className = 'bbox-badge';
    badge.textContent = needsReview ? (idx + 1) + '!' : String(idx + 1);
    div.appendChild(badge);

    // 8 Resize Handles
    RESIZE_DIRS.forEach((dir) => {
      const h = document.createElement('div');
      h.className = 'bbox-handle bbox-handle-' + dir;
      h.setAttribute('data-resize-dir', dir);
      div.appendChild(h);
    });

    // Floating Quick Action Pill on Active Box (OCR + Delete)
    if (isSelected && !state.drawMode) {
      const qbar = document.createElement('div');
      qbar.className = 'bbox-quickbar' + (blk.y1 < page.height * 0.06 ? ' flip-below' : '');

      const qOcrBtn = document.createElement('button');
      qOcrBtn.type = 'button';
      qOcrBtn.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition';
      qOcrBtn.textContent = 'OCR';
      qOcrBtn.title = 'Re-run OCR on this box';
      qOcrBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      qOcrBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ocrSingleBlockById(page, blk.id);
      });

      const qDelBtn = document.createElement('button');
      qDelBtn.type = 'button';
      qDelBtn.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-600 hover:bg-rose-500 text-white transition';
      qDelBtn.textContent = '✕';
      qDelBtn.title = 'Delete box (Del / Backspace)';
      qDelBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      qDelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteBlockById(page, blk.id);
      });

      qbar.appendChild(qOcrBtn);
      if (needsReview) {
        const qVerifyBtn = document.createElement('button');
        qVerifyBtn.type = 'button';
        qVerifyBtn.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition';
        qVerifyBtn.textContent = '✓ OK';
        qVerifyBtn.title = 'Mark this <90% OCR bubble as reviewed & verified';
        qVerifyBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        qVerifyBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          blk.verified = true;
          updatePageCardInPlace(page);
          renderOverlayBoxes();
          renderRightPanel();
        });
        qbar.appendChild(qVerifyBtn);
      }
      qbar.appendChild(qDelBtn);
      div.appendChild(qbar);
    }

    // Start Move or Resize on Pointer Down
    div.addEventListener('pointerdown', (ev) => {
      if (state.drawMode || state.isExtracting || ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      el.viewerViewport.focus({ preventScroll: true });

      const handleEl = ev.target.closest('[data-resize-dir]');
      const resizeDir = handleEl ? handleEl.getAttribute('data-resize-dir') : null;

      if (state.selectedBlockId !== blk.id) {
        state.selectedBlockId = blk.id;
        syncToolbarBoxDeleteBtn();
      }

      const stageRect = el.stageImageWrapper.getBoundingClientRect();
      div.setPointerCapture(ev.pointerId);
      div.classList.add('dragging');

      boxManip = {
        pointerId: ev.pointerId,
        divEl: div,
        page,
        blk,
        mode: resizeDir ? 'resize' : 'move',
        dir: resizeDir,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        stageW: Math.max(1, stageRect.width),
        stageH: Math.max(1, stageRect.height),
        origX1: blk.x1,
        origY1: blk.y1,
        origX2: blk.x2,
        origY2: blk.y2,
        moved: false
      };
    });

    div.addEventListener('pointermove', (ev) => {
      if (!boxManip || boxManip.pointerId !== ev.pointerId) return;
      const dxClient = ev.clientX - boxManip.startClientX;
      const dyClient = ev.clientY - boxManip.startClientY;
      if (!boxManip.moved && Math.hypot(dxClient, dyClient) < 3) return;
      boxManip.moved = true;

      const dxImg = (dxClient / boxManip.stageW) * boxManip.page.width;
      const dyImg = (dyClient / boxManip.stageH) * boxManip.page.height;
      const minSize = 12;
      const W = boxManip.page.width;
      const H = boxManip.page.height;

      if (boxManip.mode === 'move') {
        const bw = boxManip.origX2 - boxManip.origX1;
        const bh = boxManip.origY2 - boxManip.origY1;
        const nx1 = Math.max(0, Math.min(W - bw, Math.round(boxManip.origX1 + dxImg)));
        const ny1 = Math.max(0, Math.min(H - bh, Math.round(boxManip.origY1 + dyImg)));
        boxManip.blk.x1 = nx1;
        boxManip.blk.y1 = ny1;
        boxManip.blk.x2 = nx1 + bw;
        boxManip.blk.y2 = ny1 + bh;
      } else {
        let x1 = boxManip.origX1;
        let y1 = boxManip.origY1;
        let x2 = boxManip.origX2;
        let y2 = boxManip.origY2;
        const d = boxManip.dir;
        if (d.includes('w')) x1 = Math.max(0, Math.min(x2 - minSize, Math.round(boxManip.origX1 + dxImg)));
        if (d.includes('e')) x2 = Math.min(W, Math.max(x1 + minSize, Math.round(boxManip.origX2 + dxImg)));
        if (d.includes('n')) y1 = Math.max(0, Math.min(y2 - minSize, Math.round(boxManip.origY1 + dyImg)));
        if (d.includes('s')) y2 = Math.min(H, Math.max(y1 + minSize, Math.round(boxManip.origY2 + dyImg)));
        boxManip.blk.x1 = x1;
        boxManip.blk.y1 = y1;
        boxManip.blk.x2 = x2;
        boxManip.blk.y2 = y2;
      }

      applyBoxGeometryToDom(boxManip.divEl, boxManip.blk, boxManip.page);
    });

    const finishBoxManip = (ev) => {
      if (!boxManip || boxManip.pointerId !== ev.pointerId) return;
      const wasMoved = boxManip.moved;
      boxManip.divEl.classList.remove('dragging');
      boxManip = null;

      renderOverlayBoxes();
      if (!wasMoved) {
        if (state.activeTab !== 'bubbles') {
          setActiveTab('bubbles');
        } else {
          renderRightPanel();
        }
        const cardEl = el.panelPageBubbles.querySelector('[data-block-card="' + blk.id + '"]');
        if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        renderRightPanel();
      }
    };

    div.addEventListener('pointerup', finishBoxManip);
    div.addEventListener('pointercancel', finishBoxManip);

    el.bboxOverlayLayer.appendChild(div);
  });
}

function buildCombinedMangaTranscript() {
  const chunks = [];
  state.pages.forEach((page, idx) => {
    const lines = (page.blocks || [])
      .map((b) => (b.text || '').trim())
      .filter((t) => t.length > 0);
    if (lines.length === 0) return;
    if (state.includeHeaders) {
      chunks.push('=== Page ' + (idx + 1) + ' (' + page.name + ') ===\n' + lines.join('\n'));
    } else {
      chunks.push(lines.join('\n'));
    }
  });
  return chunks.join('\n\n');
}

function jumpToNextLowConfidenceBubble() {
  if (state.pages.length === 0) return;
  const curPageIdx = Math.max(0, state.pages.findIndex((p) => p.id === state.selectedPageId));
  for (let offset = 0; offset < state.pages.length; offset++) {
    const pIdx = (curPageIdx + offset) % state.pages.length;
    const p = state.pages[pIdx];
    if (!p || !Array.isArray(p.blocks)) continue;
    const curBlkIdx = offset === 0
      ? p.blocks.findIndex((b) => b.id === state.selectedBlockId)
      : -1;
    for (let bStep = 1; bStep <= p.blocks.length; bStep++) {
      const bIdx = offset === 0
        ? (curBlkIdx + bStep) % p.blocks.length
        : bStep - 1;
      const cand = p.blocks[bIdx];
      if (isBlockBelowReviewThreshold(cand, p)) {
        if (p.id !== state.selectedPageId) {
          goToPageIndex(pIdx, { animateSlide: true });
        }
        state.selectedBlockId = cand.id;
        if (state.activeTab !== 'bubbles') {
          setActiveTab('bubbles');
        } else {
          renderOverlayBoxes();
          renderRightPanel();
        }
        setTimeout(() => {
          const cardEl = el.panelPageBubbles.querySelector('[data-block-card="' + cand.id + '"]');
          if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 30);
        return;
      }
    }
  }
  showToast('All extracted bubbles are ≥90% confidence or verified!');
}

function renderRightPanel() {
  const page = getSelectedPage();
  const bubbleCount = page && page.blocks ? page.blocks.length : 0;
  el.currentBubbleCountBadge.textContent = String(bubbleCount);

  const volReviewCount = countVolumeReviewBlocks();
  const pageReviewCount = page ? countPageReviewBlocks(page) : 0;
  if (el.lowConfTabBadge) {
    const badgeNum = pageReviewCount > 0 ? pageReviewCount : volReviewCount;
    el.lowConfTabBadge.classList.toggle('hidden', badgeNum === 0);
    el.lowConfTabBadge.textContent = '⚠ ' + badgeNum;
  }

  const combined = buildCombinedMangaTranscript();
  el.fullMangaTextarea.value = combined;
  el.fullMangaTextarea.style.fontSize = state.jpFontSize + 'px';

  const rawCharCount = state.pages.reduce((acc, p) => {
    return acc + (p.blocks || []).reduce((s, b) => s + ((b.text || '').trim().length), 0);
  }, 0);
  el.totalCharsStat.textContent = rawCharCount.toLocaleString() + ' JP chars';

  // Render Current Page Bubble Cards (preserve scroll offset during async Gemini updates)
  const prevBubbleScrollTop = el.panelPageBubbles.scrollTop;
  el.panelPageBubbles.innerHTML = '';
  if (!page) {
    const p = document.createElement('p');
    p.className = 'text-xs text-slate-400 text-center py-8';
    p.textContent = 'Select or upload a manga page to inspect speech bubbles.';
    el.panelPageBubbles.appendChild(p);
    return;
  }

  if (!page.blocks || page.blocks.length === 0) {
    const wrap = document.createElement('div');
    wrap.className = 'text-center py-8 px-4 space-y-2';
    const msg = document.createElement('p');
    msg.className = 'text-xs text-slate-500';
    msg.textContent = 'No speech bubbles detected yet on this page. Click "Extract Current Page" or "+ Draw Box".';
    wrap.appendChild(msg);
    el.panelPageBubbles.appendChild(wrap);
    return;
  }

  // Top Page-Level Gemini Translation & API Key Convenience Strip
  const extractedCountOnPage = page.blocks.filter((b) => (b.text || '').trim().length > 0).length;
  const studyTopStrip = document.createElement('div');
  studyTopStrip.className = 'rounded-md border border-indigo-100 bg-indigo-50/50 px-2.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs';

  const keyBadgeBtn = document.createElement('button');
  keyBadgeBtn.type = 'button';
  const hasGeminiKey = Boolean((state.gemini.apiKey || '').trim());
  keyBadgeBtn.className = hasGeminiKey
    ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 hover:bg-emerald-200/80 transition'
    : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 hover:bg-amber-200/80 transition';
  keyBadgeBtn.textContent = hasGeminiKey ? 'Gemini Key Ready' : 'Set Gemini API Key';
  keyBadgeBtn.title = 'Open Settings to configure or update your locally cached Gemini API key';
  keyBadgeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    suppressOutsideSettingsCloseUntil = performance.now() + 250;
    setSettingsOpen(true);
    setTimeout(() => {
      if (el.inputGeminiApiKey) el.inputGeminiApiKey.focus();
    }, 40);
  });

  const btnTranslatePageAll = document.createElement('button');
  btnTranslatePageAll.type = 'button';
  btnTranslatePageAll.disabled = extractedCountOnPage === 0 || state.gemini.isTranslatingPage;
  btnTranslatePageAll.className =
    'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-45 disabled:pointer-events-none transition shadow-sm';
  btnTranslatePageAll.textContent = state.gemini.isTranslatingPage
    ? 'Translating Page…'
    : 'Translate Page EN + Romaji (' + extractedCountOnPage + ')';
  btnTranslatePageAll.title = 'Translate and generate Romaji for all extracted bubbles on this page in one Gemini request';
  btnTranslatePageAll.addEventListener('click', (ev) => {
    ev.stopPropagation();
    requestPageBatchTranslation(page);
  });

  studyTopStrip.appendChild(keyBadgeBtn);
  studyTopStrip.appendChild(btnTranslatePageAll);
  el.panelPageBubbles.appendChild(studyTopStrip);

  // <90% OCR Confidence Review Strip (Filter + Jump to Next <90% Bubble)
  if (extractedCountOnPage > 0 || volReviewCount > 0 || state.filterLowConfOnly) {
    const reviewStrip = document.createElement('div');
    const hasAnyLow = pageReviewCount > 0 || volReviewCount > 0;
    reviewStrip.className =
      'rounded-md border px-2.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs ' +
      (hasAnyLow
        ? 'border-amber-300 bg-amber-50/85 text-amber-950'
        : 'border-emerald-200 bg-emerald-50/60 text-emerald-900');

    const revInfo = document.createElement('span');
    revInfo.className = 'font-semibold text-[11px]';
    if (hasAnyLow) {
      revInfo.textContent =
        '⚠ Review (<90% OCR): ' + pageReviewCount + ' on page · ' + volReviewCount + ' total';
    } else {
      revInfo.textContent = '✓ All bubbles ≥90% confidence or verified';
    }

    const revBtns = document.createElement('div');
    revBtns.className = 'flex items-center gap-1.5';

    const btnFilterLow = document.createElement('button');
    btnFilterLow.type = 'button';
    btnFilterLow.className =
      'px-2 py-0.5 rounded-lg text-[11px] font-semibold border transition ' +
      (state.filterLowConfOnly
        ? 'border-amber-600 bg-amber-600 text-white'
        : 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100/70');
    btnFilterLow.textContent = state.filterLowConfOnly ? 'Showing <90% Only' : 'Filter <90%';
    btnFilterLow.title = 'Show only bubbles below 90% OCR confidence on this page';
    btnFilterLow.addEventListener('click', () => {
      state.filterLowConfOnly = !state.filterLowConfOnly;
      renderRightPanel();
    });
    revBtns.appendChild(btnFilterLow);

    if (hasAnyLow) {
      const btnJumpNext = document.createElement('button');
      btnJumpNext.type = 'button';
      btnJumpNext.className =
        'px-2 py-0.5 rounded-lg text-[11px] font-semibold bg-amber-600 text-white hover:bg-amber-700 transition shadow-sm';
      btnJumpNext.textContent = 'Next <90% →';
      btnJumpNext.title = 'Jump to the next bubble below 90% OCR confidence across your pages';
      btnJumpNext.addEventListener('click', () => jumpToNextLowConfidenceBubble());
      revBtns.appendChild(btnJumpNext);
    }

    reviewStrip.appendChild(revInfo);
    reviewStrip.appendChild(revBtns);
    el.panelPageBubbles.appendChild(reviewStrip);
  }

  const visibleBlocks = state.filterLowConfOnly
    ? page.blocks.map((blk, idx) => ({ blk, idx })).filter((item) => isBlockBelowReviewThreshold(item.blk, page))
    : page.blocks.map((blk, idx) => ({ blk, idx }));

  if (visibleBlocks.length === 0 && state.filterLowConfOnly) {
    const allGoodMsg = document.createElement('p');
    allGoodMsg.className = 'text-xs text-emerald-700 bg-emerald-50/70 border border-emerald-200 rounded-md py-5 px-3 text-center font-medium';
    allGoodMsg.textContent = 'No bubbles below 90% OCR confidence on this page!';
    el.panelPageBubbles.appendChild(allGoodMsg);
  }

  visibleBlocks.forEach(({ blk, idx }) => {
    const isSelected = blk.id === state.selectedBlockId;
    const needsReview = isBlockBelowReviewThreshold(blk, page);
    const card = document.createElement('div');
    card.setAttribute('data-block-card', blk.id);
    card.className =
      'rounded-md border p-2.5 transition ' +
      (needsReview
        ? (isSelected
            ? 'border-2 border-amber-500 bg-amber-50/80 ring-2 ring-rose-300 shadow-sm'
            : 'border-2 border-amber-400 bg-amber-50/65 hover:border-amber-500 shadow-sm')
        : (isSelected
            ? 'border-rose-400 bg-rose-50/40 shadow-sm'
            : 'border-slate-200 bg-slate-50/50 hover:border-slate-300'));

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-2 mb-1.5';

    const leftBadge = document.createElement('div');
    leftBadge.className = 'flex items-center flex-wrap gap-1.5 cursor-pointer';
    const pill = document.createElement('span');
    pill.className =
      'inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold text-white ' +
      (isSelected ? 'bg-rose-600' : (needsReview ? 'bg-amber-600' : 'bg-indigo-600'));
    pill.textContent = '#' + (idx + 1);

    const confSpan = document.createElement('span');
    if (blk.verified) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200';
      const rawPct = typeof blk.charConf === 'number' && blk.charConf > 0
        ? ' (' + Math.round(blk.charConf * 100) + '%)'
        : '';
      confSpan.textContent = '✓ Verified' + rawPct;
    } else if (needsReview) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-200/90 text-amber-950 border border-amber-400';
      const pctStr = typeof blk.charConf === 'number' && blk.charConf > 0
        ? Math.round(blk.charConf * 100) + '% OCR'
        : 'Empty OCR';
      confSpan.textContent = '⚠ ' + pctStr + ' · Needs Review (<90%)';
    } else if (typeof blk.charConf === 'number' && blk.charConf > 0) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200';
      confSpan.textContent = Math.round(blk.charConf * 100) + '% OCR';
    } else {
      confSpan.className = 'text-[11px] text-slate-500';
      confSpan.textContent = (blk.x2 - blk.x1) + '×' + (blk.y2 - blk.y1) + ' px';
    }
    leftBadge.appendChild(pill);
    leftBadge.appendChild(confSpan);
    leftBadge.addEventListener('click', () => {
      state.selectedBlockId = blk.id;
      renderOverlayBoxes();
      renderRightPanel();
    });

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1';

    const btnReOcr = document.createElement('button');
    btnReOcr.type = 'button';
    btnReOcr.className = 'px-2 py-0.5 rounded text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-indigo-50 hover:text-indigo-700';
    btnReOcr.textContent = 'OCR';
    btnReOcr.title = 'Run OCR on just this speech bubble';
    btnReOcr.addEventListener('click', async () => {
      if (state.isExtracting) return;
      try {
        state.abortRequested = false;
        setExtractingUI(true);
        setProgress(true, 'Recognizing bubble #' + (idx + 1) + '…', 45);
        const im = await loadImageElement(page.url);
        const res = await recognizeSingleBlock(im, blk);
        blk.text = res.text;
        blk.charConf = res.charConf;
        blk.verified = false;
        page.status = 'done';
        updatePageFullText(page);
        setProgress(false);
        showToast('Updated bubble #' + (idx + 1));
      } catch (err) {
        setProgress(false);
        if (!err || err.message !== 'ABORTED') {
          showToast('Bubble OCR failed: ' + (err ? err.message : ''), 'error');
        }
      } finally {
        setExtractingUI(false);
        renderAll();
      }
    });

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'px-2 py-0.5 rounded text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-100';
    btnCopy.textContent = 'Copy';
    btnCopy.addEventListener('click', () => copyTextSafe(blk.text, 'Copied bubble #' + (idx + 1) + '!'));

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-400 hover:text-rose-600 hover:bg-rose-50';
    btnDel.textContent = '✕';
    btnDel.title = 'Remove bounding box';
    btnDel.addEventListener('click', () => {
      if (state.isExtracting) return;
      page.blocks = page.blocks.filter((b) => b.id !== blk.id);
      updatePageFullText(page);
      if (state.selectedBlockId === blk.id) state.selectedBlockId = null;
      renderAll();
    });

    if (needsReview) {
      const btnVerify = document.createElement('button');
      btnVerify.type = 'button';
      btnVerify.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition shadow-sm';
      btnVerify.textContent = '✓ Verify';
      btnVerify.title = 'Confirm Japanese text is accurate and clear the <90% review highlight';
      btnVerify.addEventListener('click', () => {
        blk.verified = true;
        updatePageCardInPlace(page);
        renderOverlayBoxes();
        renderRightPanel();
      });
      actions.appendChild(btnVerify);
    }

    actions.appendChild(btnReOcr);
    actions.appendChild(btnCopy);
    actions.appendChild(btnDel);

    header.appendChild(leftBadge);
    header.appendChild(actions);

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Click Extract to transcribe this bubble…';
    ta.value = blk.text || '';
    ta.style.fontSize = state.jpFontSize + 'px';
    ta.className =
      'jp-text w-full rounded-lg border bg-white px-2.5 py-1.5 text-slate-900 focus:outline-none focus:ring-2 resize-y ' +
      (needsReview
        ? 'border-amber-400 focus:ring-amber-500'
        : 'border-slate-200 focus:ring-indigo-500');
    ta.addEventListener('focus', () => {
      if (state.selectedBlockId !== blk.id) {
        state.selectedBlockId = blk.id;
        renderOverlayBoxes();
      }
    });
    ta.addEventListener('input', () => {
      blk.text = ta.value;
      updatePageFullText(page);
      el.fullMangaTextarea.value = buildCombinedMangaTranscript();
    });

    card.appendChild(header);
    card.appendChild(ta);

    // Per-Bubble Gemini Translation, Romaji & Japanese Vocab/Grammar Breakdown Controls
    const jpTrimmed = (blk.text || '').trim();
    const hasExtractedJp = jpTrimmed.length > 0;
    const activeTask = state.gemini.activeTasks.get(blk.id) || null;
    const study = blk.study || null;
    const isStale = Boolean(study && study.sourceText && study.sourceText !== jpTrimmed);
    const hasTrans = Boolean(study && (study.english || study.romaji));
    const hasBreakdown = Boolean(study && study.breakdown && (
      (Array.isArray(study.breakdown.vocab) && study.breakdown.vocab.length > 0) ||
      (Array.isArray(study.breakdown.grammar) && study.breakdown.grammar.length > 0)
    ));

    const studyBar = document.createElement('div');
    studyBar.className = 'mt-2 flex flex-wrap items-center justify-between gap-1.5';

    const leftStudyBtns = document.createElement('div');
    leftStudyBtns.className = 'flex flex-wrap items-center gap-1.5';

    const btnEnRomaji = document.createElement('button');
    btnEnRomaji.type = 'button';
    btnEnRomaji.disabled = !hasExtractedJp || Boolean(activeTask);
    btnEnRomaji.className =
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (hasTrans && study.showTranslation !== false
        ? 'border-indigo-300 bg-indigo-100/80 text-indigo-900 hover:bg-indigo-200/70'
        : 'border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50');
    if (activeTask === 'translate') {
      btnEnRomaji.textContent = 'Translating…';
    } else if (hasTrans && !isStale) {
      btnEnRomaji.textContent = study.showTranslation === false ? 'Show EN + Romaji' : 'Hide EN + Romaji';
    } else {
      btnEnRomaji.textContent = 'EN + Romaji';
    }
    btnEnRomaji.title = 'Generate English translation and Hepburn Romaji for this bubble via Gemini API';
    btnEnRomaji.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (hasTrans && !isStale) {
        blk.study.showTranslation = blk.study.showTranslation === false;
        renderRightPanel();
      } else {
        requestBubbleTranslation(page, blk, isStale);
      }
    });

    const btnBreakdown = document.createElement('button');
    btnBreakdown.type = 'button';
    btnBreakdown.disabled = !hasExtractedJp || Boolean(activeTask);
    btnBreakdown.className =
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (hasBreakdown && study.showBreakdown
        ? 'border-emerald-300 bg-emerald-100/80 text-emerald-900 hover:bg-emerald-200/70'
        : 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50');
    if (activeTask === 'breakdown') {
      btnBreakdown.textContent = 'Breaking down…';
    } else if (hasBreakdown && !isStale) {
      btnBreakdown.textContent = study.showBreakdown ? 'Hide Vocab & Grammar' : 'Show Vocab & Grammar';
    } else {
      btnBreakdown.textContent = 'Vocab & Grammar';
    }
    btnBreakdown.title = 'Break down Japanese vocabulary, readings, conjugations, and grammar used in this bubble';
    btnBreakdown.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (hasBreakdown && !isStale) {
        blk.study.showBreakdown = !blk.study.showBreakdown;
        renderRightPanel();
      } else {
        requestBubbleBreakdown(page, blk, isStale);
      }
    });

    leftStudyBtns.appendChild(btnEnRomaji);
    leftStudyBtns.appendChild(btnBreakdown);

    if (hasTrans || hasBreakdown) {
      const btnRefreshStudy = document.createElement('button');
      btnRefreshStudy.type = 'button';
      btnRefreshStudy.disabled = !hasExtractedJp || Boolean(activeTask);
      btnRefreshStudy.className =
        'px-2 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 ' +
        (isStale
          ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
          : 'border-slate-200 bg-white text-slate-500 hover:text-indigo-700 hover:bg-slate-100');
      btnRefreshStudy.textContent = isStale ? '↻ Update' : '↻';
      btnRefreshStudy.title = isStale
        ? 'Japanese text changed — click to re-run Gemini study analysis'
        : 'Re-generate Gemini translation & breakdown';
      btnRefreshStudy.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (hasBreakdown && study.showBreakdown) {
          requestBubbleBreakdown(page, blk, true);
        } else {
          requestBubbleTranslation(page, blk, true);
        }
      });
      leftStudyBtns.appendChild(btnRefreshStudy);
    }

    studyBar.appendChild(leftStudyBtns);

    if (!hasExtractedJp) {
      const hintSpan = document.createElement('span');
      hintSpan.className = 'text-[10px] text-slate-400';
      hintSpan.textContent = 'Extract text first';
      studyBar.appendChild(hintSpan);
    }
    card.appendChild(studyBar);

    // Render English Translation + Romaji Box
    if (hasTrans && study.showTranslation !== false) {
      const transBox = document.createElement('div');
      transBox.className = 'mt-2 rounded-lg border border-indigo-200/80 bg-white p-2.5 space-y-1.5 text-xs';

      if (study.romaji) {
        const romRow = document.createElement('div');
        romRow.className = 'flex items-start justify-between gap-2';
        const romTextWrap = document.createElement('div');
        romTextWrap.className = 'min-w-0 flex-1';
        const romLabel = document.createElement('span');
        romLabel.className = 'inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-600 mr-1.5';
        romLabel.textContent = 'Romaji';
        const romVal = document.createElement('span');
        romVal.className = 'italic text-slate-700 break-words';
        romVal.textContent = study.romaji;
        romTextWrap.appendChild(romLabel);
        romTextWrap.appendChild(romVal);

        const btnCopyRom = document.createElement('button');
        btnCopyRom.type = 'button';
        btnCopyRom.className = 'text-[10px] font-medium text-slate-400 hover:text-indigo-600 shrink-0';
        btnCopyRom.textContent = 'Copy';
        btnCopyRom.addEventListener('click', () => copyTextSafe(study.romaji, 'Copied Romaji!'));

        romRow.appendChild(romTextWrap);
        romRow.appendChild(btnCopyRom);
        transBox.appendChild(romRow);
      }

      if (study.english) {
        const enRow = document.createElement('div');
        enRow.className = 'flex items-start justify-between gap-2 pt-1 border-t border-slate-100';
        const enTextWrap = document.createElement('div');
        enTextWrap.className = 'min-w-0 flex-1';
        const enLabel = document.createElement('span');
        enLabel.className = 'inline-block text-[10px] font-bold uppercase tracking-wider text-emerald-700 mr-1.5';
        enLabel.textContent = 'English';
        const enVal = document.createElement('span');
        enVal.className = 'font-medium text-slate-900 break-words';
        enVal.textContent = study.english;
        enTextWrap.appendChild(enLabel);
        enTextWrap.appendChild(enVal);

        const btnCopyEn = document.createElement('button');
        btnCopyEn.type = 'button';
        btnCopyEn.className = 'text-[10px] font-medium text-slate-400 hover:text-emerald-700 shrink-0';
        btnCopyEn.textContent = 'Copy';
        btnCopyEn.addEventListener('click', () => copyTextSafe(study.english, 'Copied English translation!'));

        enRow.appendChild(enTextWrap);
        enRow.appendChild(btnCopyEn);
        transBox.appendChild(enRow);
      }

      if (study.nuance && study.nuance.trim()) {
        const nuanceP = document.createElement('p');
        nuanceP.className = 'text-[11px] text-slate-500 pt-1 border-t border-slate-100 leading-snug';
        nuanceP.textContent = 'Tone / Nuance: ' + study.nuance.trim();
        transBox.appendChild(nuanceP);
      }

      card.appendChild(transBox);
    }

    // Render Detailed Vocabulary & Grammar Breakdown Panel
    if (hasBreakdown && study.showBreakdown) {
      const bdBox = document.createElement('div');
      bdBox.className = 'mt-2 rounded-lg border border-emerald-200 bg-emerald-50/35 p-2.5 space-y-2.5 text-xs';

      const vocabList = Array.isArray(study.breakdown.vocab) ? study.breakdown.vocab : [];
      if (vocabList.length > 0) {
        const vSec = document.createElement('div');
        vSec.className = 'space-y-1.5';
        const vTitle = document.createElement('div');
        vTitle.className = 'text-[10px] font-bold uppercase tracking-wider text-emerald-800';
        vTitle.textContent = 'Vocabulary & Word Readings';
        vSec.appendChild(vTitle);

        const vGrid = document.createElement('div');
        vGrid.className = 'space-y-1';
        vocabList.forEach((v) => {
          const vItem = document.createElement('div');
          vItem.className = 'rounded-md bg-white border border-emerald-100 px-2 py-1.5 flex flex-col gap-0.5';

          const topLine = document.createElement('div');
          topLine.className = 'flex flex-wrap items-center justify-between gap-1';

          const wordLeft = document.createElement('div');
          wordLeft.className = 'flex flex-wrap items-baseline gap-1.5';
          const surfSpan = document.createElement('span');
          surfSpan.className = 'jp-text font-bold text-slate-900 text-xs';
          surfSpan.textContent = v.surface || '';
          wordLeft.appendChild(surfSpan);

          if (v.reading && v.reading !== v.surface) {
            const readSpan = document.createElement('span');
            readSpan.className = 'jp-text text-[11px] text-indigo-700 font-medium';
            readSpan.textContent = '【' + v.reading + '】';
            wordLeft.appendChild(readSpan);
          }
          if (v.romaji) {
            const romSpan = document.createElement('span');
            romSpan.className = 'italic text-[11px] text-slate-500';
            romSpan.textContent = v.romaji;
            wordLeft.appendChild(romSpan);
          }
          if (v.dictForm && v.dictForm !== v.surface) {
            const dictSpan = document.createElement('span');
            dictSpan.className = 'jp-text text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded';
            dictSpan.textContent = 'dict: ' + v.dictForm;
            wordLeft.appendChild(dictSpan);
          }

          topLine.appendChild(wordLeft);

          if (v.pos) {
            const posPill = document.createElement('span');
            posPill.className = 'px-1.5 py-0.2 rounded bg-emerald-100/80 text-emerald-900 text-[10px] font-semibold shrink-0';
            posPill.textContent = v.pos;
            topLine.appendChild(posPill);
          }

          const meanLine = document.createElement('p');
          meanLine.className = 'text-[11px] text-slate-700 leading-snug';
          meanLine.textContent = v.meaning || '';

          vItem.appendChild(topLine);
          vItem.appendChild(meanLine);
          vGrid.appendChild(vItem);
        });
        vSec.appendChild(vGrid);
        bdBox.appendChild(vSec);
      }

      const grammarList = Array.isArray(study.breakdown.grammar) ? study.breakdown.grammar : [];
      if (grammarList.length > 0) {
        const gSec = document.createElement('div');
        gSec.className = 'space-y-1.5 pt-1.5 border-t border-emerald-200/70';
        const gTitle = document.createElement('div');
        gTitle.className = 'text-[10px] font-bold uppercase tracking-wider text-indigo-800';
        gTitle.textContent = 'Grammar, Conjugations & Manga Nuances';
        gSec.appendChild(gTitle);

        const gStack = document.createElement('div');
        gStack.className = 'space-y-1';
        grammarList.forEach((g) => {
          const gCard = document.createElement('div');
          gCard.className = 'rounded-md bg-white border border-indigo-100 px-2 py-1.5 space-y-0.5';

          const gHead = document.createElement('div');
          gHead.className = 'flex flex-wrap items-center justify-between gap-1';
          const patSpan = document.createElement('span');
          patSpan.className = 'jp-text font-bold text-indigo-900 text-xs';
          patSpan.textContent = g.pattern || '';
          gHead.appendChild(patSpan);

          if (g.level) {
            const lvlSpan = document.createElement('span');
            lvlSpan.className = 'px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold';
            lvlSpan.textContent = g.level;
            gHead.appendChild(lvlSpan);
          }

          const expP = document.createElement('p');
          expP.className = 'text-[11px] text-slate-700 leading-snug';
          expP.textContent = g.explanation || '';

          gCard.appendChild(gHead);
          gCard.appendChild(expP);
          gStack.appendChild(gCard);
        });
        gSec.appendChild(gStack);
        bdBox.appendChild(gSec);
      }

      card.appendChild(bdBox);
    }

    el.panelPageBubbles.appendChild(card);
  });

  el.panelPageBubbles.scrollTop = prevBubbleScrollTop;
}

function setActiveTab(tab) {
  state.activeTab = tab;
  if (tab === 'all') {
    el.tabBtnAllText.className = 'md-tab is-active';
    el.tabBtnPageBubbles.className = 'md-tab inline-flex items-center gap-1.5';
    el.panelAllText.classList.remove('hidden');
    el.panelPageBubbles.classList.add('hidden');
  } else {
    el.tabBtnPageBubbles.className = 'md-tab is-active inline-flex items-center gap-1.5';
    el.tabBtnAllText.className = 'md-tab';
    el.panelPageBubbles.classList.remove('hidden');
    el.panelAllText.classList.add('hidden');
  }
  renderRightPanel();
}
