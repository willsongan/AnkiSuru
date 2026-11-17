"use strict";

// Initialize Review Queue state & DOM references (modularized so core-and-study.js stays untouched)
if (typeof state === 'object' && state) {
  if (state.filterReviewPagesOnly === undefined) state.filterReviewPagesOnly = false;
  if (state.reviewQueuePageId === undefined) state.reviewQueuePageId = null;
}
if (typeof el === 'object' && el) {
  if (!el.btnSidebarReviewFilter) el.btnSidebarReviewFilter = document.getElementById('btnSidebarReviewFilter');
  if (!el.btnVerifyPopupBubble) el.btnVerifyPopupBubble = document.getElementById('btnVerifyPopupBubble');
  if (!el.btnDeletePopupBubble) el.btnDeletePopupBubble = document.getElementById('btnDeletePopupBubble');
  if (!el.tabBtnReviewQueue) el.tabBtnReviewQueue = document.getElementById('tabBtnReviewQueue');
  if (!el.reviewQueueCountBadge) el.reviewQueueCountBadge = document.getElementById('reviewQueueCountBadge');
  if (!el.panelReviewQueue) el.panelReviewQueue = document.getElementById('panelReviewQueue');
}

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
function syncSidebarReviewFilterPill() {
  const volRev = countVolumeReviewBlocks();
  const pagesWithRev = state.pages.filter((p) => countPageReviewBlocks(p) > 0).length;
  if (volRev === 0 && state.filterReviewPagesOnly) {
    state.filterReviewPagesOnly = false;
  }
  if (el.btnSidebarReviewFilter) {
    const showPill = volRev > 0 || state.filterReviewPagesOnly;
    el.btnSidebarReviewFilter.classList.toggle('hidden', !showPill);
    el.btnSidebarReviewFilter.classList.toggle('is-active', Boolean(state.filterReviewPagesOnly));
    el.btnSidebarReviewFilter.setAttribute('aria-pressed', state.filterReviewPagesOnly ? 'true' : 'false');
    el.btnSidebarReviewFilter.textContent = state.filterReviewPagesOnly
      ? ('⚠ ' + pagesWithRev + 'p ×')
      : ('⚠ ' + volRev);
    el.btnSidebarReviewFilter.title = state.filterReviewPagesOnly
      ? 'Showing only pages with <90% OCR bubbles — click to show all pages'
      : (volRev + ' <90% OCR bubble(s) across ' + pagesWithRev + ' page(s) — click to filter pages & open Review Queue');
  }
}

function updatePageCardInPlace(page) {
  if (!page) return;
  syncSidebarReviewFilterPill();
  const card = el.pageListContainer.querySelector('[data-page-id="' + page.id + '"]');
  if (!card) return;
  const badge = card.querySelector('[data-role="status"]');
  if (badge) applyPageStatusBadgeStyle(badge, page);
  if (state.filterReviewPagesOnly) {
    card.classList.toggle('hidden', countPageReviewBlocks(page) === 0);
  } else {
    card.classList.remove('hidden');
  }
  const prev = card.querySelector('[data-role="preview"]');
  if (prev) {
    prev.textContent = page.fullText
      ? page.fullText.replace(/\n+/g, ' ')
      : 'Click Extract to read Japanese';
  }
}

function renderPageList() {
  const count = state.pages.length;
  if (typeof reviewThumbImageCache !== 'undefined' && reviewThumbImageCache.size > 0) {
    const validUrls = new Set(state.pages.map((p) => p.url));
    for (const u of Array.from(reviewThumbImageCache.keys())) {
      if (!validUrls.has(u)) reviewThumbImageCache.delete(u);
    }
  }
  syncSidebarReviewFilterPill();
  const flaggedPagesCount = state.pages.filter((p) => countPageReviewBlocks(p) > 0).length;
  el.pagesSummaryCount.textContent = state.filterReviewPagesOnly
    ? (flaggedPagesCount + ' of ' + count + ' pages <90%')
    : (count + (count === 1 ? ' page loaded' : ' pages loaded'));
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
    statusBadge.addEventListener('click', (ev) => {
      if (countPageReviewBlocks(page) > 0) {
        ev.stopPropagation();
        const firstLow = (page.blocks || []).find((b) => isBlockBelowReviewThreshold(b, page));
        state.reviewQueuePageId = null;
        setActiveTab('review');
        if (firstLow) {
          focusBlockOnStage(idx, firstLow.id);
        }
      }
    });
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

    if (state.filterReviewPagesOnly && countPageReviewBlocks(page) === 0) {
      card.classList.add('hidden');
    }
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

const reviewThumbImageCache = new Map();

function collectAllLowConfidenceItems() {
  const items = [];
  state.pages.forEach((page, pageIdx) => {
    if (!page || !Array.isArray(page.blocks)) return;
    page.blocks.forEach((blk, blkIdx) => {
      if (isBlockBelowReviewThreshold(blk, page)) {
        const hasTxt = Boolean((blk.text || '').trim());
        const confPct = typeof blk.charConf === 'number' && blk.charConf > 0
          ? Math.round(blk.charConf * 100)
          : null;
        items.push({ page, pageIdx, blk, blkIdx, confPct, isEmpty: !hasTxt });
      }
    });
  });
  return items;
}

function scrollViewportToBlockIfNeeded(page, blk) {
  if (!page || !blk || !el.viewerViewport || !el.stageImageWrapper) return;
  requestAnimationFrame(() => {
    const boxEl = el.bboxOverlayLayer.querySelector('[data-bbox-id="' + blk.id + '"]');
    if (!boxEl) return;
    const vpRect = el.viewerViewport.getBoundingClientRect();
    const bxRect = boxEl.getBoundingClientRect();
    const outVert = bxRect.top < vpRect.top + 24 || bxRect.bottom > vpRect.bottom - 24;
    const outHoriz = bxRect.left < vpRect.left + 24 || bxRect.right > vpRect.right - 24;
    if (outVert || outHoriz) {
      boxEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  });
}

function focusBlockOnStage(pageIdx, blockId, opts) {
  const options = opts || {};
  const targetPage = state.pages[pageIdx];
  if (!targetPage) return;
  if (targetPage.id !== state.selectedPageId) {
    goToPageIndex(pageIdx, { animateSlide: options.animateSlide !== false });
  }
  state.selectedBlockId = blockId;
  if (state.liveTextMode) {
    if (typeof openLiveBubblePopup === 'function') {
      openLiveBubblePopup(blockId);
    }
  } else {
    state.showBoxes = true;
    renderOverlayBoxes();
  }
  const blk = (targetPage.blocks || []).find((b) => b.id === blockId);
  if (blk) {
    scrollViewportToBlockIfNeeded(targetPage, blk);
  }
  if (options.skipRightRender !== true) {
    renderRightPanel();
  }
}

function jumpToLowConfidenceByStep(stepDir) {
  const allItems = collectAllLowConfidenceItems();
  if (allItems.length === 0) {
    showToast('All extracted bubbles are ≥90% confidence or verified!');
    return false;
  }
  const dir = stepDir < 0 ? -1 : 1;
  const curIdx = allItems.findIndex(
    (it) => it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId
  );
  let nextItem = null;
  if (curIdx >= 0) {
    const nextPos = (curIdx + dir + allItems.length) % allItems.length;
    nextItem = allItems[nextPos];
  } else {
    const curPageIdx = Math.max(0, state.pages.findIndex((p) => p.id === state.selectedPageId));
    nextItem = dir > 0
      ? (allItems.find((it) => it.pageIdx >= curPageIdx) || allItems[0])
      : ([...allItems].reverse().find((it) => it.pageIdx <= curPageIdx) || allItems[allItems.length - 1]);
  }
  if (state.reviewQueuePageId && state.reviewQueuePageId !== nextItem.page.id) {
    state.reviewQueuePageId = null;
  }
  if (state.activeTab !== 'review' && state.activeTab !== 'bubbles') {
    state.activeTab = 'review';
    syncTabBarClasses();
  }
  focusBlockOnStage(nextItem.pageIdx, nextItem.blk.id);
  setTimeout(() => {
    const container = state.activeTab === 'review' ? el.panelReviewQueue : el.panelPageBubbles;
    if (!container) return;
    const cardEl = container.querySelector('[data-block-card="' + nextItem.blk.id + '"]');
    if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 30);
  return true;
}

function jumpToNextLowConfidenceBubble() {
  return jumpToLowConfidenceByStep(1);
}

function drawBubbleCropPreview(canvasEl, page, blk) {
  if (!canvasEl || !page || !blk) return;
  const W = 72;
  const H = 64;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvasEl.width = Math.round(W * dpr);
  canvasEl.height = Math.round(H * dpr);
  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const paintFromImg = (im) => {
    const sx = Math.max(0, blk.x1);
    const sy = Math.max(0, blk.y1);
    const sw = Math.max(1, Math.min((im.naturalWidth || page.width) - sx, blk.x2 - blk.x1));
    const sh = Math.max(1, Math.min((im.naturalHeight || page.height) - sy, blk.y2 - blk.y1));
    const scale = Math.min((W - 6) / sw, (H - 6) / sh);
    const dw = Math.max(1, sw * scale);
    const dh = Math.max(1, sh * scale);
    const dx = (W - dw) * 0.5;
    const dy = (H - dh) * 0.5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh);
  };

  if (
    state.selectedPageId === page.id &&
    el.activePageImage &&
    el.activePageImage.complete &&
    el.activePageImage.naturalWidth > 0
  ) {
    paintFromImg(el.activePageImage);
    return;
  }
  const cached = reviewThumbImageCache.get(page.url);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    paintFromImg(cached);
    return;
  }
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => {
    reviewThumbImageCache.set(page.url, im);
    if (canvasEl.isConnected) paintFromImg(im);
  };
  im.src = page.url;
}

function advanceAfterResolvingReviewItem(anchorPageIdx) {
  const remaining = collectAllLowConfidenceItems();
  if (remaining.length === 0) {
    state.selectedBlockId = null;
    state.reviewQueuePageId = null;
    renderAll();
    showToast('All <90% OCR bubbles reviewed!');
    return;
  }
  if (state.reviewQueuePageId && !remaining.some((it) => it.page.id === state.reviewQueuePageId)) {
    state.reviewQueuePageId = null;
  }
  const pool = state.reviewQueuePageId
    ? remaining.filter((it) => it.page.id === state.reviewQueuePageId)
    : remaining;
  const nextIt = pool.find((it) => it.pageIdx >= anchorPageIdx) || pool[0];
  focusBlockOnStage(nextIt.pageIdx, nextIt.blk.id);
}

function renderReviewQueuePanel(allReviewItems) {
  if (!el.panelReviewQueue) return;
  const prevScroll = el.panelReviewQueue.scrollTop;
  el.panelReviewQueue.innerHTML = '';

  const totalCount = allReviewItems.length;
  const anyExtracted = state.pages.some((p) => p.status === 'done' || (p.blocks || []).some((b) => Boolean((b.text || '').trim())));

  if (totalCount === 0) {
    const emptyBox = document.createElement('div');
    emptyBox.className = 'mt-4 rounded-lg border p-6 text-center space-y-2 ' +
      (anyExtracted ? 'border-emerald-200 bg-emerald-50/50' : 'border-slate-200 bg-slate-50');
    const titleP = document.createElement('p');
    titleP.className = 'text-sm font-medium ' + (anyExtracted ? 'text-emerald-900' : 'text-slate-800');
    titleP.textContent = anyExtracted
      ? '✓ Zero bubbles need review'
      : 'No <90% OCR bubbles queued yet';
    const subP = document.createElement('p');
    subP.className = 'text-xs text-slate-500 leading-relaxed';
    subP.textContent = anyExtracted
      ? 'Every extracted bubble across your loaded pages scored 90%+ confidence or has been verified.'
      : 'Double-click any manga page or click "Extract All Japanese Text" — any speech bubble scoring under 90% OCR confidence will appear here for 1-click review or deletion.';
    emptyBox.appendChild(titleP);
    emptyBox.appendChild(subP);
    el.panelReviewQueue.appendChild(emptyBox);
    return;
  }

  // Group counts per page for quick page jump chips
  const pageGroups = [];
  const seenPageIds = new Map();
  allReviewItems.forEach((it) => {
    if (!seenPageIds.has(it.page.id)) {
      const g = { page: it.page, pageIdx: it.pageIdx, count: 0, firstBlkId: it.blk.id };
      seenPageIds.set(it.page.id, g);
      pageGroups.push(g);
    }
    seenPageIds.get(it.page.id).count++;
  });

  if (state.reviewQueuePageId && !seenPageIds.has(state.reviewQueuePageId)) {
    state.reviewQueuePageId = null;
  }

  const filteredItems = state.reviewQueuePageId
    ? allReviewItems.filter((it) => it.page.id === state.reviewQueuePageId)
    : allReviewItems;

  const activePos = allReviewItems.findIndex(
    (it) => it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId
  );
  const emptyItems = allReviewItems.filter((it) => it.isEmpty);

  // Sticky Top Review Navigation & Batch Bar
  const stickyHeader = document.createElement('div');
  stickyHeader.className = 'md-review-sticky-bar space-y-2';

  const topRow = document.createElement('div');
  topRow.className = 'flex flex-wrap items-center justify-between gap-2';

  const summaryLabel = document.createElement('span');
  summaryLabel.className = 'text-xs font-medium text-amber-900';
  summaryLabel.textContent = totalCount + (totalCount === 1 ? ' bubble' : ' bubbles') +
    ' <90% · ' + pageGroups.length + (pageGroups.length === 1 ? ' page' : ' pages');
  topRow.appendChild(summaryLabel);

  const navRight = document.createElement('div');
  navRight.className = 'flex items-center gap-1.5 ml-auto';

  if (emptyItems.length > 0) {
    const btnDelEmpty = document.createElement('button');
    btnDelEmpty.type = 'button';
    btnDelEmpty.className = 'md-popup-del-btn';
    btnDelEmpty.textContent = 'Delete Empty (' + emptyItems.length + ')';
    btnDelEmpty.title = 'Remove all empty 0-character boxes across loaded pages';
    btnDelEmpty.addEventListener('click', () => {
      if (state.isExtracting) return;
      state.pages.forEach((p) => {
        if (!p.blocks) return;
        const before = p.blocks.length;
        p.blocks = p.blocks.filter((b) => !(isBlockBelowReviewThreshold(b, p) && !(b.text || '').trim()));
        if (p.blocks.length !== before) updatePageFullText(p);
      });
      renderAll();
      showToast('Removed ' + emptyItems.length + ' empty box(es).');
    });
    navRight.appendChild(btnDelEmpty);
  }

  const stepper = document.createElement('div');
  stepper.className = 'viewer-capsule';

  const btnPrevRev = document.createElement('button');
  btnPrevRev.type = 'button';
  btnPrevRev.className = 'px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 rounded';
  btnPrevRev.textContent = '← Prev';
  btnPrevRev.title = 'Jump to previous <90% OCR bubble';
  btnPrevRev.addEventListener('click', () => jumpToLowConfidenceByStep(-1));

  const stepPos = document.createElement('span');
  stepPos.className = 'px-2 text-[11px] font-medium text-slate-600 tabular-nums select-none';
  stepPos.textContent = (activePos >= 0 ? (activePos + 1) : '–') + ' / ' + totalCount;

  const btnNextRev = document.createElement('button');
  btnNextRev.type = 'button';
  btnNextRev.className = 'px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 rounded';
  btnNextRev.textContent = 'Next →';
  btnNextRev.title = 'Jump to next <90% OCR bubble';
  btnNextRev.addEventListener('click', () => jumpToLowConfidenceByStep(1));

  stepper.appendChild(btnPrevRev);
  stepper.appendChild(stepPos);
  stepper.appendChild(btnNextRev);
  navRight.appendChild(stepper);
  topRow.appendChild(navRight);
  stickyHeader.appendChild(topRow);

  // Page Quick-Jump Filter Chips Row
  const chipsRow = document.createElement('div');
  chipsRow.className = 'flex items-center gap-1.5 overflow-x-auto custom-scroll pb-0.5';

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'md-review-page-chip' + (!state.reviewQueuePageId ? ' is-active' : '');
  allChip.textContent = 'All (' + totalCount + ')';
  allChip.addEventListener('click', () => {
    state.reviewQueuePageId = null;
    renderRightPanel();
  });
  chipsRow.appendChild(allChip);

  pageGroups.forEach((g) => {
    const pChip = document.createElement('button');
    pChip.type = 'button';
    const isAct = state.reviewQueuePageId === g.page.id;
    pChip.className = 'md-review-page-chip' + (isAct ? ' is-active' : '');
    pChip.textContent = 'P.' + (g.pageIdx + 1) + ' (' + g.count + ')';
    pChip.title = 'Jump to Page ' + (g.pageIdx + 1) + ' (' + g.page.name + ')';
    pChip.addEventListener('click', () => {
      state.reviewQueuePageId = isAct ? null : g.page.id;
      focusBlockOnStage(g.pageIdx, g.firstBlkId);
    });
    chipsRow.appendChild(pChip);
  });
  stickyHeader.appendChild(chipsRow);
  el.panelReviewQueue.appendChild(stickyHeader);

  // Render Each <90% Review Card with Live Manga Bubble Crop + Inline Edit + 1-Click Verify / Delete
  filteredItems.forEach((it) => {
    const isSel = it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId;
    const card = document.createElement('div');
    card.setAttribute('data-block-card', it.blk.id);
    card.className =
      'rounded-md border p-2.5 transition ' +
      (isSel
        ? 'border-2 border-amber-500 bg-amber-50/80 shadow-sm'
        : 'border-amber-300 bg-amber-50/35 hover:border-amber-400');

    const topBar = document.createElement('div');
    topBar.className = 'flex flex-wrap items-center justify-between gap-1.5 mb-2';

    const locLeft = document.createElement('div');
    locLeft.className = 'flex items-center gap-1.5';

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className =
      'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition ' +
      (isSel
        ? 'bg-rose-600 text-white'
        : 'bg-white border border-amber-300 text-slate-800 hover:bg-amber-100');
    jumpBtn.textContent = 'Page ' + (it.pageIdx + 1) + ' · #' + (it.blkIdx + 1);
    jumpBtn.title = 'Jump to Page ' + (it.pageIdx + 1) + ', Bubble #' + (it.blkIdx + 1) + ' on the manga viewer';
    jumpBtn.addEventListener('click', () => {
      focusBlockOnStage(it.pageIdx, it.blk.id);
    });

    const confTag = document.createElement('span');
    confTag.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-200/80 text-amber-950 border border-amber-400 tabular-nums';
    confTag.textContent = it.confPct !== null ? (it.confPct + '% OCR') : 'Empty OCR';

    locLeft.appendChild(jumpBtn);
    locLeft.appendChild(confTag);

    const actRight = document.createElement('div');
    actRight.className = 'flex items-center gap-1 ml-auto';

    const btnKeep = document.createElement('button');
    btnKeep.type = 'button';
    btnKeep.className = 'md-popup-verify-btn';
    btnKeep.textContent = '✓ Verify';
    btnKeep.title = 'Confirm text is accurate and jump to next <90% bubble (or press Ctrl+Enter in text box)';
    btnKeep.addEventListener('click', () => {
      it.blk.verified = true;
      updatePageCardInPlace(it.page);
      advanceAfterResolvingReviewItem(it.pageIdx);
    });

    const btnReOcr = document.createElement('button');
    btnReOcr.type = 'button';
    btnReOcr.disabled = state.isExtracting;
    btnReOcr.className = 'md-btn-outlined px-2 py-0.5 rounded text-[11px] font-medium';
    btnReOcr.textContent = 'OCR';
    btnReOcr.title = 'Re-run OCR on this bubble';
    btnReOcr.addEventListener('click', () => {
      focusBlockOnStage(it.pageIdx, it.blk.id, { skipRightRender: true });
      ocrSingleBlockById(it.page, it.blk.id);
    });

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.disabled = state.isExtracting;
    btnDel.className = 'md-popup-del-btn';
    btnDel.textContent = 'Delete';
    btnDel.title = 'Delete this false or unwanted bounding box and jump to next <90% bubble';
    btnDel.addEventListener('click', () => {
      if (state.isExtracting) return;
      it.page.blocks = it.page.blocks.filter((b) => b.id !== it.blk.id);
      updatePageFullText(it.page);
      updatePageCardInPlace(it.page);
      advanceAfterResolvingReviewItem(it.pageIdx);
    });

    actRight.appendChild(btnKeep);
    actRight.appendChild(btnReOcr);
    actRight.appendChild(btnDel);

    topBar.appendChild(locLeft);
    topBar.appendChild(actRight);
    card.appendChild(topBar);

    const bodyRow = document.createElement('div');
    bodyRow.className = 'flex items-stretch gap-2';

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.className = 'md-crop-thumb';
    thumbCanvas.title = 'Click to jump to Page ' + (it.pageIdx + 1) + ', Bubble #' + (it.blkIdx + 1);
    drawBubbleCropPreview(thumbCanvas, it.page, it.blk);
    thumbCanvas.addEventListener('click', () => {
      focusBlockOnStage(it.pageIdx, it.blk.id);
    });

    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Empty OCR — type Japanese text (Ctrl+Enter to verify) or click Delete…';
    ta.value = it.blk.text || '';
    ta.style.fontSize = Math.max(14, state.jpFontSize) + 'px';
    ta.className = 'jp-text flex-1 min-w-0 rounded border border-amber-400 bg-white px-2.5 py-1.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 resize-y';
    ta.addEventListener('focus', () => {
      if (state.selectedPageId !== it.page.id || state.selectedBlockId !== it.blk.id) {
        focusBlockOnStage(it.pageIdx, it.blk.id, { skipRightRender: true });
      }
    });
    ta.addEventListener('input', () => {
      it.blk.text = ta.value;
      updatePageFullText(it.page);
      updatePageCardInPlace(it.page);
      el.fullMangaTextarea.value = buildCombinedMangaTranscript();
    });
    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        it.blk.verified = true;
        updatePageCardInPlace(it.page);
        advanceAfterResolvingReviewItem(it.pageIdx);
      }
    });

    bodyRow.appendChild(thumbCanvas);
    bodyRow.appendChild(ta);
    card.appendChild(bodyRow);
    el.panelReviewQueue.appendChild(card);
  });

  el.panelReviewQueue.scrollTop = prevScroll;
}

function renderRightPanel() {
  const page = getSelectedPage();
  const bubbleCount = page && page.blocks ? page.blocks.length : 0;
  el.currentBubbleCountBadge.textContent = String(bubbleCount);

  const allReviewItems = collectAllLowConfidenceItems();
  const volReviewCount = allReviewItems.length;
  const pageReviewCount = page ? countPageReviewBlocks(page) : 0;
  syncSidebarReviewFilterPill();

  if (el.lowConfTabBadge) {
    el.lowConfTabBadge.classList.toggle('hidden', pageReviewCount === 0);
    el.lowConfTabBadge.textContent = '⚠ ' + pageReviewCount;
  }
  if (el.reviewQueueCountBadge) {
    el.reviewQueueCountBadge.textContent = volReviewCount > 0 ? ('⚠ ' + volReviewCount) : '0';
    el.reviewQueueCountBadge.className = volReviewCount > 0
      ? 'px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-amber-500 text-white tabular-nums'
      : 'px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 tabular-nums';
  }

  renderReviewQueuePanel(allReviewItems);

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
      const btnOpenQueue = document.createElement('button');
      btnOpenQueue.type = 'button';
      btnOpenQueue.className =
        'px-2 py-0.5 rounded-lg text-[11px] font-semibold border border-amber-400 bg-white text-amber-950 hover:bg-amber-100 transition';
      btnOpenQueue.textContent = 'All <90% (' + volReviewCount + ')';
      btnOpenQueue.title = 'Open the unified <90% Review Queue across all pages';
      btnOpenQueue.addEventListener('click', () => setActiveTab('review'));
      revBtns.appendChild(btnOpenQueue);

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

function syncTabBarClasses() {
  const tab = state.activeTab;
  el.tabBtnAllText.className = tab === 'all' ? 'md-tab is-active' : 'md-tab';
  el.tabBtnPageBubbles.className =
    (tab === 'bubbles' ? 'md-tab is-active' : 'md-tab') + ' inline-flex items-center gap-1.5';
  if (el.tabBtnReviewQueue) {
    el.tabBtnReviewQueue.className =
      (tab === 'review' ? 'md-tab is-active' : 'md-tab') + ' inline-flex items-center gap-1.5';
  }
  el.panelAllText.classList.toggle('hidden', tab !== 'all');
  el.panelPageBubbles.classList.toggle('hidden', tab !== 'bubbles');
  if (el.panelReviewQueue) {
    el.panelReviewQueue.classList.toggle('hidden', tab !== 'review');
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  syncTabBarClasses();
  renderRightPanel();
}
