"use strict";

// Defensive Review Queue state & DOM fallback bindings
if (typeof state === 'object' && state) {
  if (state.filterReviewPagesOnly === undefined) state.filterReviewPagesOnly = false;
  if (state.reviewQueuePageId === undefined) state.reviewQueuePageId = null;
  if (state.reviewSortMode === undefined) state.reviewSortMode = 'page';
}
if (typeof el === 'object' && el) {
  if (!el.btnSidebarReviewFilter) el.btnSidebarReviewFilter = document.getElementById('btnSidebarReviewFilter');
  if (!el.btnToolbarReviewJump) el.btnToolbarReviewJump = document.getElementById('btnToolbarReviewJump');
  if (!el.btnVerifyPopupBubble) el.btnVerifyPopupBubble = document.getElementById('btnVerifyPopupBubble');
  if (!el.btnDeletePopupBubble) el.btnDeletePopupBubble = document.getElementById('btnDeletePopupBubble');
  if (!el.tabBtnReviewQueue) el.tabBtnReviewQueue = document.getElementById('tabBtnReviewQueue');
  if (!el.reviewQueueCountBadge) el.reviewQueueCountBadge = document.getElementById('reviewQueueCountBadge');
  if (!el.globalReviewBanner) el.globalReviewBanner = document.getElementById('globalReviewBanner');
  if (!el.globalReviewBannerText) el.globalReviewBannerText = document.getElementById('globalReviewBannerText');
  if (!el.btnBannerOpenReview) el.btnBannerOpenReview = document.getElementById('btnBannerOpenReview');
  if (!el.btnBannerNextReview) el.btnBannerNextReview = document.getElementById('btnBannerNextReview');
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
  const revCount = countPageReviewBlocks(page);
  if (page.status === 'detecting') {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 animate-pulse';
    statusBadge.textContent = 'Detecting…';
    statusBadge.title = '';
  } else if (page.status === 'recognizing') {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 animate-pulse';
    statusBadge.textContent = revCount > 0 ? ('OCR · ⚠ ' + revCount) : 'OCR…';
    statusBadge.title = '';
  } else if (revCount > 0) {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200';
    statusBadge.textContent = '⚠ ' + revCount + ' <90%';
    statusBadge.title = revCount + ' bubble(s) below 90% OCR confidence — click to review';
  } else if (page.status === 'done' || page.ocrCompleted) {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800';
    statusBadge.textContent = 'Extracted';
    statusBadge.title = '';
  } else if (page.boxesDetected) {
    statusBadge.className = page.blocks.length > 0
      ? 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200'
      : 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200';
    statusBadge.textContent = page.blocks.length + (page.blocks.length === 1 ? ' box' : ' boxes');
    statusBadge.title = '';
  } else {
    statusBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600';
    statusBadge.textContent = 'Ready';
    statusBadge.title = '';
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
    ? 'Detect All (' + count + ')'
    : 'Detect All';
  el.extractAllLabel.textContent = count > 0
    ? 'Extract All (' + count + ')'
    : 'Extract All';
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
      if (typeof activateSelectTextOnPageDoubleClick === 'function') {
        activateSelectTextOnPageDoubleClick(page, null);
      } else if (!isPageAlreadyExtracted(page)) {
        quickExtractSinglePage(page);
      }
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
    blk.charConf = normalizeConf01(res.charConf);
    blk.ocrAttempted = true;
    blk.verified = false;
    page.status = 'done';
    page.ocrCompleted = true;
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
  state.livePopupBlockId = null;
  if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');

  syncSelectedPageCardInSidebar(options.scrollSidebar !== false);
  el.viewerViewport.scrollTop = 0;
  renderActivePageStage();
  if (state.fitMode) {
    el.viewerViewport.scrollLeft = 0;
  } else if (el.viewerViewport) {
    el.viewerViewport.scrollLeft = state.readingOrder === 'rtl'
      ? Math.max(0, el.viewerViewport.scrollWidth - el.viewerViewport.clientWidth)
      : 0;
  }
  renderRightPanel();

  if (options.animateSlide !== false) {
    triggerStageSlideAnim(dir);
  } else {
    resetStageSlideTransform();
  }
  preloadNeighborPages(targetIdx);
  if (state.batchSelectMode && !isPageAlreadyExtracted(targetPage) && !state.isSampleSet && !state.isExtracting) {
    setTimeout(() => {
      if (state.selectedPageId === targetPage.id && state.batchSelectMode && !isPageAlreadyExtracted(targetPage) && !state.isExtracting) {
        quickExtractSinglePage(targetPage);
      }
    }, 60);
  }
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
  const batchOn = Boolean(state.batchSelectMode);
  const boxesVis = Boolean(state.showBoxes) && !liveOn && !batchOn;
  const qLen = Array.isArray(state.batchQueue) ? state.batchQueue.length : 0;
  if (el.btnBatchSelectMode) {
    el.btnBatchSelectMode.classList.toggle('is-active', batchOn);
    el.btnBatchSelectMode.setAttribute('aria-pressed', batchOn ? 'true' : 'false');
  }
  if (el.batchSelectBtnLabel) {
    el.batchSelectBtnLabel.textContent = qLen > 0 ? ('Batch (' + qLen + ')') : 'Batch Select';
  }
  if (el.btnFsBatchSelect) {
    el.btnFsBatchSelect.classList.toggle('is-active', batchOn || qLen > 0);
    el.btnFsBatchSelect.setAttribute('aria-pressed', batchOn ? 'true' : 'false');
  }
  if (el.fsBatchBtnLabel) {
    el.fsBatchBtnLabel.textContent = qLen > 0 ? ('Batch (' + qLen + ')') : 'Batch';
  }
  if (el.batchSelectBanner) {
    el.batchSelectBanner.classList.toggle('hidden', !batchOn);
  }
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

const ZOOM_MIN_FACTOR = 0.35;
const ZOOM_MAX_FACTOR = 5.0;
const ZOOM_STEP_RATIO = 1.25;

function getFitBaseWidth(page) {
  if (!page || !page.width || !page.height) return 800;
  if (!el.viewerViewport) return page.width;
  const cs = window.getComputedStyle(el.viewerViewport);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const rawVpW = el.viewerViewport.clientWidth || window.innerWidth || 960;
  const winH = window.innerHeight || document.documentElement.clientHeight || 800;
  const rawVpH = el.viewerViewport.clientHeight || (state.isViewerFullscreen ? winH : Math.max(240, winH - 165));
  const availW = Math.max(120, rawVpW - padX);
  const maxCssH = state.isViewerFullscreen
    ? Math.max(120, Math.min(rawVpH > 40 ? rawVpH - padY : winH - 20, winH - 20))
    : Math.max(120, Math.min(rawVpH > 40 ? rawVpH - padY : winH - 205, winH - 205));
  const fitByHeightW = maxCssH * (page.width / page.height);
  if (state.isViewerFullscreen) {
    return Math.max(120, Math.min(availW, fitByHeightW));
  }
  return Math.max(120, Math.min(page.width, availW, fitByHeightW));
}

function isViewportZoomOverflowing() {
  if (!el.viewerViewport || state.fitMode) return false;
  return (
    el.viewerViewport.scrollWidth > el.viewerViewport.clientWidth + 4 ||
    el.viewerViewport.scrollHeight > el.viewerViewport.clientHeight + 4
  );
}

function syncViewportGrabCursor() {
  if (!el.viewerViewport) return;
  const canPan = !state.drawMode && Boolean(getSelectedPage()) && isViewportZoomOverflowing();
  el.viewerViewport.classList.toggle('can-grab-pan', canPan);
}

function syncZoomFitUI() {
  const isFit = Boolean(state.fitMode);
  const pct = Math.round((isFit ? 1.0 : state.zoom) * 100);
  const atMin = !isFit && state.zoom <= ZOOM_MIN_FACTOR + 0.001;
  const atMax = !isFit && state.zoom >= ZOOM_MAX_FACTOR - 0.001;

  if (el.btnZoomFit) {
    el.btnZoomFit.classList.toggle('is-active', isFit);
    el.btnZoomFit.setAttribute(
      'data-tip',
      isFit ? 'Fit to Screen (Active · 100%)' : 'Reset to Fit (' + pct + '%)'
    );
  }
  if (el.btnZoomOut) el.btnZoomOut.disabled = atMin;
  if (el.btnZoomIn) el.btnZoomIn.disabled = atMax;

  if (el.btnFsZoomFit) {
    el.btnFsZoomFit.classList.toggle('is-active', isFit);
    el.btnFsZoomFit.textContent = isFit ? 'Fit' : (pct + '%');
    el.btnFsZoomFit.title = isFit
      ? 'Fit to Screen active (Shortcut: 0)'
      : ('Zoom ' + pct + '% — Click or press 0 to Fit Screen');
  }
  if (el.btnFsZoomOut) el.btnFsZoomOut.disabled = atMin;
  if (el.btnFsZoomIn) el.btnFsZoomIn.disabled = atMax;
}

function applyStageZoom(page) {
  syncZoomFitUI();
  if (!page || !el.activePageImage || !el.stageImageWrapper) return;

  if (state.fitMode) {
    state.zoom = 1.0;
    el.stageImageWrapper.classList.remove('is-zoomed');
    el.activePageImage.classList.remove('is-zoomed');
    el.activePageImage.style.maxWidth = '100%';
    if (state.isViewerFullscreen) {
      const fitW = Math.round(getFitBaseWidth(page));
      el.activePageImage.style.width = fitW + 'px';
      el.activePageImage.style.maxHeight = 'calc(100dvh - 20px)';
    } else {
      el.activePageImage.style.width = '';
      el.activePageImage.style.maxHeight = 'calc(100vh - 205px)';
    }
  } else {
    const baseW = getFitBaseWidth(page);
    const targetW = Math.max(120, Math.round(baseW * state.zoom));
    el.stageImageWrapper.classList.add('is-zoomed');
    el.activePageImage.classList.add('is-zoomed');
    el.activePageImage.style.maxWidth = 'none';
    el.activePageImage.style.maxHeight = 'none';
    el.activePageImage.style.width = targetW + 'px';
  }

  syncViewportGrabCursor();
  requestAnimationFrame(() => {
    syncViewportGrabCursor();
    if (state.liveTextMode) {
      fitLiveTextSpans();
      if (state.livePopupBlockId && typeof positionOpenLivePopup === 'function') {
        positionOpenLivePopup();
      }
    }
  });
}

function setStageZoomFactor(nextFactor, anchorClientX, anchorClientY) {
  const page = getSelectedPage();
  if (!page || !el.viewerViewport || !el.activePageImage) return;

  const clamped = Math.max(ZOOM_MIN_FACTOR, Math.min(ZOOM_MAX_FACTOR, +Number(nextFactor).toFixed(4)));
  const vp = el.viewerViewport;
  const vpRectBefore = vp.getBoundingClientRect();
  const imgRectBefore = el.activePageImage.getBoundingClientRect();

  const clientX = (typeof anchorClientX === 'number' && Number.isFinite(anchorClientX))
    ? anchorClientX
    : (vpRectBefore.left + vp.clientWidth * 0.5);
  const clientY = (typeof anchorClientY === 'number' && Number.isFinite(anchorClientY))
    ? anchorClientY
    : (vpRectBefore.top + vp.clientHeight * 0.5);

  const prevW = Math.max(1, imgRectBefore.width);
  const prevH = Math.max(1, imgRectBefore.height);
  const relX = Math.max(0, Math.min(1, (clientX - imgRectBefore.left) / prevW));
  const relY = Math.max(0, Math.min(1, (clientY - imgRectBefore.top) / prevH));
  const cursorOffsetVpX = clientX - vpRectBefore.left;
  const cursorOffsetVpY = clientY - vpRectBefore.top;

  state.fitMode = false;
  state.zoom = clamped;
  applyStageZoom(page);

  const vpRectAfter = vp.getBoundingClientRect();
  const imgRectAfter = el.activePageImage.getBoundingClientRect();
  const newPointClientX = imgRectAfter.left + relX * imgRectAfter.width;
  const newPointClientY = imgRectAfter.top + relY * imgRectAfter.height;
  const deltaScrollX = newPointClientX - (vpRectAfter.left + cursorOffsetVpX);
  const deltaScrollY = newPointClientY - (vpRectAfter.top + cursorOffsetVpY);

  vp.scrollLeft = Math.max(0, vp.scrollLeft + deltaScrollX);
  vp.scrollTop = Math.max(0, vp.scrollTop + deltaScrollY);
  syncViewportGrabCursor();
}

function stepStageZoom(stepDir, anchorClientX, anchorClientY) {
  const page = getSelectedPage();
  if (!page) return;
  let cur = state.fitMode ? 1.0 : state.zoom;
  if (state.fitMode && el.activePageImage) {
    const renderedW = el.activePageImage.getBoundingClientRect().width;
    const baseW = getFitBaseWidth(page);
    if (renderedW > 20 && baseW > 20) {
      cur = renderedW / baseW;
    }
  }
  const ratio = stepDir >= 0 ? ZOOM_STEP_RATIO : (1 / ZOOM_STEP_RATIO);
  const next = cur * ratio;
  setStageZoomFactor(next, anchorClientX, anchorClientY);
}

function resetStageZoomToFit() {
  const page = getSelectedPage();
  state.fitMode = true;
  state.zoom = 1.0;
  applyStageZoom(page);
  if (el.viewerViewport) {
    el.viewerViewport.scrollTop = 0;
    el.viewerViewport.scrollLeft = 0;
  }
  syncViewportGrabCursor();
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

  // Ordered Cross-Page Batch Bubble Selection Mode: click speech bubbles in sequence (1 -> 2 -> 3...) across pages!
  if (state.batchSelectMode) {
    if (state.isSampleSet && typeof populateSampleGroundTruthForPage === 'function') {
      const hasTxt = (page.blocks || []).some((b) => Boolean((b.text || '').trim()));
      if (!hasTxt && populateSampleGroundTruthForPage(page)) {
        updatePageCardInPlace(page);
      }
    }
    (page.blocks || []).forEach((blk, idx) => {
      const txt = (blk.text || '').trim();
      const qIdx = getBlockBatchOrderIndex(blk.id);
      const isQueued = qIdx >= 0;
      const reg = document.createElement('div');
      reg.className = 'batch-select-region' + (isQueued ? ' is-queued' : '');
      reg.setAttribute('data-batch-region', '1');
      reg.setAttribute('data-bbox-id', blk.id);
      reg.title = isQueued
        ? ('Batch #' + (qIdx + 1) + ' — click to remove from batch (' + txt + ')')
        : (txt
            ? ('Click to add as Batch #' + (state.batchQueue.length + 1) + ' (' + txt + ')')
            : ('Bubble #' + (idx + 1) + ' — click to OCR & add as Batch #' + (state.batchQueue.length + 1)));
      applyBoxGeometryToDom(reg, blk, page);

      if (isQueued) {
        const ordBadge = document.createElement('span');
        ordBadge.className = 'batch-order-badge';
        ordBadge.textContent = String(qIdx + 1);
        reg.appendChild(ordBadge);
      }

      reg.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!(blk.text || '').trim()) {
          if (state.isExtracting) return;
          await ocrSingleBlockById(page, blk.id);
          if ((blk.text || '').trim()) {
            toggleBlockInBatchQueue(page.id, blk.id);
          }
          return;
        }
        toggleBlockInBatchQueue(page.id, blk.id);
      });

      el.bboxOverlayLayer.appendChild(reg);
    });
    return;
  }

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
      const isHighlighted = state.livePopupBlockId === blk.id || state.selectedBlockId === blk.id;
      if (!txt && !isHighlighted) return;
      const reg = document.createElement('div');
      const needsReview = isBlockBelowReviewThreshold(blk, page);
      const confPct = formatOcrConfPercent(blk.charConf);
      reg.className =
        'live-text-region' +
        (needsReview ? ' is-low-conf' : '') +
        (isHighlighted ? ' has-selection' : '');
      reg.setAttribute('data-live-text', '1');
      reg.setAttribute('data-bbox-id', blk.id);
      reg.title = needsReview
        ? ('⚠ Low OCR (' + (confPct !== null ? confPct + '%' : '<90%') + ' — may be inaccurate) · Click to inspect Bubble #' + (idx + 1))
        : ('Click to open selectable sentence popup (Bubble #' + (idx + 1) + ')');
      applyBoxGeometryToDom(reg, blk, page);

      const qIdxLive = getBlockBatchOrderIndex(blk.id);
      if (qIdxLive >= 0) {
        const ordBadge = document.createElement('span');
        ordBadge.className = 'batch-order-badge';
        ordBadge.textContent = String(qIdxLive + 1);
        reg.appendChild(ordBadge);
      }

      reg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!state.liveTextMode || !txt) return;
        if (ev.shiftKey) {
          toggleBlockInBatchQueue(page.id, blk.id);
          return;
        }
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
    const confPct = formatOcrConfPercent(blk.charConf);
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

    const qIdxBox = getBlockBatchOrderIndex(blk.id);
    if (qIdxBox >= 0) {
      const bBadge = document.createElement('span');
      bBadge.className = 'batch-order-badge';
      bBadge.textContent = String(qIdxBox + 1);
      div.appendChild(bBadge);
    }

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

    // Start Move or Resize on Pointer Down (preserve synthetic click/dblclick unless dragging or resizing)
    div.addEventListener('pointerdown', (ev) => {
      if (state.drawMode || state.isExtracting || ev.button !== 0) return;
      ev.stopPropagation();
      const handleEl = ev.target.closest('[data-resize-dir]');
      const resizeDir = handleEl ? handleEl.getAttribute('data-resize-dir') : null;
      if (resizeDir) {
        ev.preventDefault();
      }
      el.viewerViewport.focus({ preventScroll: true });

      const wasAlreadySelected = state.selectedBlockId === blk.id;
      if (!wasAlreadySelected) {
        state.selectedBlockId = blk.id;
        syncToolbarBoxDeleteBtn();
      }

      const stageRect = el.stageImageWrapper.getBoundingClientRect();
      if (resizeDir) {
        try { div.setPointerCapture(ev.pointerId); } catch (_e) {}
        div.classList.add('dragging');
      }

      boxManip = {
        pointerId: ev.pointerId,
        divEl: div,
        page,
        blk,
        wasAlreadySelected,
        captured: Boolean(resizeDir),
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
      if (!boxManip.captured) {
        try { div.setPointerCapture(ev.pointerId); } catch (_e) {}
        div.classList.add('dragging');
        boxManip.captured = true;
      }

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
      const wasAlreadySelected = boxManip.wasAlreadySelected;
      boxManip.divEl.classList.remove('dragging');
      boxManip = null;

      // Avoid tearing down the DOM node on a stationary click if already selected so native dblclick fires on the same element
      if (wasMoved || !wasAlreadySelected) {
        renderOverlayBoxes();
      }
      if (!wasMoved) {
        if (state.activeTab !== 'bubbles') {
          setActiveTab('bubbles');
        } else {
          renderRightPanel();
        }
        const cardEl = el.panelPageBubbles.querySelector('[data-block-card="' + blk.id + '"]');
        if (cardEl) scrollCardIntoContainer(el.panelPageBubbles, cardEl);
      } else {
        renderRightPanel();
      }
    };

    div.addEventListener('pointerup', finishBoxManip);
    div.addEventListener('pointercancel', finishBoxManip);

    el.bboxOverlayLayer.appendChild(div);
  });
}

function buildCombinedMangaTranscriptWithRanges() {
  const chunks = [];
  const ranges = [];
  let cursor = 0;
  state.pages.forEach((page, pageIdx) => {
    const validBlocks = (page.blocks || [])
      .map((blk, blkIdx) => ({ blk, blkIdx, text: (blk.text || '').trim() }))
      .filter((item) => item.text.length > 0);
    if (validBlocks.length === 0) return;

    if (chunks.length > 0) {
      cursor += 2; // '\n\n'
    }
    let chunkStr = '';
    if (state.includeHeaders) {
      const hdr = '=== Page ' + (pageIdx + 1) + ' (' + page.name + ') ===\n';
      chunkStr += hdr;
      cursor += hdr.length;
    }
    validBlocks.forEach((item, idxInPage) => {
      if (idxInPage > 0) {
        chunkStr += '\n';
        cursor += 1;
      }
      const start = cursor;
      const end = cursor + item.text.length;
      ranges.push({ start, end, pageIdx, page, blk: item.blk, blkIdx: item.blkIdx });
      chunkStr += item.text;
      cursor = end;
    });
    chunks.push(chunkStr);
  });
  return { text: chunks.join('\n\n'), ranges };
}

function buildCombinedMangaTranscript() {
  return buildCombinedMangaTranscriptWithRanges().text;
}

function findTranscriptBlockAtOffset(startOffset, endOffset) {
  const { ranges } = buildCombinedMangaTranscriptWithRanges();
  if (ranges.length === 0) return null;
  const s = Math.max(0, Number(startOffset) || 0);
  const e = Math.max(s, Number(endOffset) || s);
  for (const r of ranges) {
    if (e > s) {
      if (s < r.end && e > r.start) return r;
    } else if (s >= r.start && s <= r.end) {
      return r;
    }
  }
  return null;
}

function getPageBubbleCardClassName(isSelected, needsReview) {
  return (
    'rounded-md border p-2.5 transition cursor-pointer ' +
    (needsReview
      ? (isSelected
          ? 'md-bubble-card-selected border-2 border-amber-500 bg-amber-50/80 ring-2 ring-rose-300 shadow-sm'
          : 'border-2 border-amber-400 bg-amber-50/65 hover:border-amber-500 shadow-sm')
      : (isSelected
          ? 'md-bubble-card-selected border-2 border-rose-400 bg-rose-50/40 shadow-sm'
          : 'border-slate-200 bg-slate-50/50 hover:border-slate-300'))
  );
}

function getPageBubblePillClassName(isSelected, needsReview) {
  return (
    'inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold text-white ' +
    (isSelected ? 'bg-rose-600' : (needsReview ? 'bg-amber-600' : 'bg-indigo-600'))
  );
}

function scrollCardIntoContainer(container, cardEl) {
  if (!container || !cardEl) return;
  const cRect = container.getBoundingClientRect();
  const elRect = cardEl.getBoundingClientRect();
  if (cRect.height <= 0) return;
  if (elRect.top < cRect.top + 8) {
    container.scrollTo({
      top: Math.max(0, container.scrollTop + (elRect.top - cRect.top) - 10),
      behavior: 'smooth'
    });
  } else if (elRect.bottom > cRect.bottom - 8) {
    container.scrollTo({
      top: Math.max(0, container.scrollTop + (elRect.bottom - cRect.bottom) + 10),
      behavior: 'smooth'
    });
  }
}

function syncSelectedBubbleCardInPlace(selectedId, opts) {
  const options = opts || {};
  if (el.panelPageBubbles) {
    let activeBubbleCard = null;
    el.panelPageBubbles.querySelectorAll('[data-block-card]').forEach((card) => {
      const id = card.getAttribute('data-block-card');
      const isSel = Boolean(selectedId && id === selectedId);
      const needsRev = card.getAttribute('data-needs-review') === '1';
      card.setAttribute('data-selected', isSel ? 'true' : 'false');
      card.className = getPageBubbleCardClassName(isSel, needsRev);
      const pill = card.querySelector('[data-bubble-pill]');
      if (pill) {
        pill.className = getPageBubblePillClassName(isSel, needsRev);
      }
      if (isSel) activeBubbleCard = card;
    });
    if (activeBubbleCard && options.scrollCard !== false) {
      scrollCardIntoContainer(el.panelPageBubbles, activeBubbleCard);
    }
  }
  if (el.panelReviewQueue) {
    let activeRevCard = null;
    el.panelReviewQueue.querySelectorAll('[data-block-card]').forEach((card) => {
      const id = card.getAttribute('data-block-card');
      const isSel = Boolean(selectedId && id === selectedId);
      card.setAttribute('data-selected', isSel ? 'true' : 'false');
      card.className =
        'rounded-md border p-2.5 transition cursor-pointer ' +
        (isSel
          ? 'md-bubble-card-selected border-2 border-amber-500 bg-amber-50/80 shadow-sm'
          : 'border-amber-300 bg-amber-50/35 hover:border-amber-400');
      const jumpBtn = card.querySelector('[data-review-jump-pill]');
      if (jumpBtn) {
        jumpBtn.className =
          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition ' +
          (isSel
            ? 'bg-rose-600 text-white'
            : 'bg-white border border-amber-300 text-slate-800 hover:bg-amber-100');
      }
      if (isSel) activeRevCard = card;
    });
    if (activeRevCard && options.scrollReviewCard === true) {
      scrollCardIntoContainer(el.panelReviewQueue, activeRevCard);
    }
  }
}

const reviewThumbImageCache = new Map();

function collectAllLowConfidenceItems() {
  const items = [];
  state.pages.forEach((page, pageIdx) => {
    if (!page || !Array.isArray(page.blocks)) return;
    page.blocks.forEach((blk, blkIdx) => {
      if (isBlockBelowReviewThreshold(blk, page)) {
        const hasTxt = Boolean((blk.text || '').trim());
        const normC = normalizeConf01(blk.charConf);
        const confPct = formatOcrConfPercent(blk.charConf);
        items.push({
          page,
          pageIdx,
          blk,
          blkIdx,
          rawConf: normC !== null ? normC : (hasTxt ? 0.5 : -1),
          confPct: hasTxt ? confPct : (confPct !== null && confPct > 0 ? confPct : null),
          isEmpty: !hasTxt
        });
      }
    });
  });
  return items;
}

function getOrderedReviewItems(baseItems) {
  const items = Array.isArray(baseItems) ? baseItems : collectAllLowConfidenceItems();
  if (state.reviewSortMode === 'conf') {
    return [...items].sort((a, b) => (a.rawConf - b.rawConf) || (a.pageIdx - b.pageIdx) || (a.blkIdx - b.blkIdx));
  }
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
  syncToolbarBoxDeleteBtn();
  if (state.liveTextMode) {
    renderOverlayBoxes();
    if (typeof openLiveBubblePopup === 'function') {
      openLiveBubblePopup(blockId, { preserveTab: true, skipRightRender: true });
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
  } else {
    syncSelectedBubbleCardInPlace(blockId, { scrollCard: false });
  }
}

function openReviewAndFocusFirst() {
  const ordered = getOrderedReviewItems();
  state.reviewQueuePageId = null;
  if (state.activeTab !== 'review') {
    state.activeTab = 'review';
    syncTabBarClasses();
  }
  if (ordered.length > 0) {
    const curPageIdx = Math.max(0, state.pages.findIndex((p) => p.id === state.selectedPageId));
    const onCurPage = ordered.find((it) => it.pageIdx === curPageIdx);
    const target = onCurPage || ordered[0];
    focusBlockOnStage(target.pageIdx, target.blk.id);
    setTimeout(() => {
      if (!el.panelReviewQueue) return;
      const cardEl = el.panelReviewQueue.querySelector('[data-block-card="' + target.blk.id + '"]');
      if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 30);
  } else {
    renderRightPanel();
  }
}

function jumpToLowConfidenceByStep(stepDir) {
  const ordered = getOrderedReviewItems();
  if (ordered.length === 0) {
    showToast('All extracted bubbles are ≥90% confidence or verified!');
    return false;
  }
  const pool = state.reviewQueuePageId
    ? ordered.filter((it) => it.page.id === state.reviewQueuePageId)
    : ordered;
  const activeList = pool.length > 0 ? pool : ordered;
  const dir = stepDir < 0 ? -1 : 1;
  const curIdx = activeList.findIndex(
    (it) => it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId
  );
  let nextItem = null;
  if (curIdx >= 0) {
    const nextPos = (curIdx + dir + activeList.length) % activeList.length;
    nextItem = activeList[nextPos];
  } else {
    const curPageIdx = Math.max(0, state.pages.findIndex((p) => p.id === state.selectedPageId));
    nextItem = dir > 0
      ? (activeList.find((it) => it.pageIdx >= curPageIdx) || activeList[0])
      : ([...activeList].reverse().find((it) => it.pageIdx <= curPageIdx) || activeList[activeList.length - 1]);
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
  const W = 96;
  const H = 76;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvasEl.width = Math.round(W * dpr);
  canvasEl.height = Math.round(H * dpr);
  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const paintFromImg = (im) => {
    const imgW = im.naturalWidth || page.width || 1;
    const imgH = im.naturalHeight || page.height || 1;
    const pad = 10;
    const sx = Math.max(0, blk.x1 - pad);
    const sy = Math.max(0, blk.y1 - pad);
    const ex = Math.min(imgW, blk.x2 + pad);
    const ey = Math.min(imgH, blk.y2 + pad);
    const sw = Math.max(1, ex - sx);
    const sh = Math.max(1, ey - sy);
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

    // Subtle amber crop frame showing exact detected bubble bounds inside context margin
    const bx = dx + (blk.x1 - sx) * scale;
    const by = dy + (blk.y1 - sy) * scale;
    const bw = Math.max(2, (blk.x2 - blk.x1) * scale);
    const bh = Math.max(2, (blk.y2 - blk.y1) * scale);
    ctx.strokeStyle = 'rgba(227, 116, 0, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
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

function advanceAfterResolvingReviewItem(anchorPageIdx, focusTextarea) {
  const ordered = getOrderedReviewItems();
  if (ordered.length === 0) {
    state.selectedBlockId = null;
    state.reviewQueuePageId = null;
    renderAll();
    showToast('All <90% OCR bubbles reviewed!');
    return;
  }
  if (state.reviewQueuePageId && !ordered.some((it) => it.page.id === state.reviewQueuePageId)) {
    state.reviewQueuePageId = null;
  }
  const pool = state.reviewQueuePageId
    ? ordered.filter((it) => it.page.id === state.reviewQueuePageId)
    : ordered;
  const nextIt = state.reviewSortMode === 'conf'
    ? pool[0]
    : (pool.find((it) => it.pageIdx >= anchorPageIdx) || pool[0]);
  focusBlockOnStage(nextIt.pageIdx, nextIt.blk.id);
  if (focusTextarea && state.activeTab === 'review' && el.panelReviewQueue) {
    requestAnimationFrame(() => {
      const nextTa = el.panelReviewQueue.querySelector('[data-block-card="' + nextIt.blk.id + '"] textarea');
      if (nextTa) {
        nextTa.focus();
        nextTa.setSelectionRange(nextTa.value.length, nextTa.value.length);
      }
    });
  }
}

function renderReviewQueuePanel(allReviewItems) {
  if (!el.panelReviewQueue) return;
  const prevScroll = el.panelReviewQueue.scrollTop;
  el.panelReviewQueue.innerHTML = '';

  const totalCount = allReviewItems.length;
  const anyExtracted = state.pages.some(
    (p) => p.status === 'done' || p.ocrCompleted || (p.blocks || []).some((b) => b.ocrAttempted || Boolean((b.text || '').trim()))
  );

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

  // Group counts per page for quick page jump chips & page headers
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

  const orderedAll = getOrderedReviewItems(allReviewItems);
  const filteredItems = state.reviewQueuePageId
    ? orderedAll.filter((it) => it.page.id === state.reviewQueuePageId)
    : orderedAll;

  const activePos = filteredItems.findIndex(
    (it) => it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId
  );
  const emptyItems = allReviewItems.filter((it) => it.isEmpty);

  // Sticky Top Review Navigation, Sort & Batch Bar
  const stickyHeader = document.createElement('div');
  stickyHeader.className = 'md-review-sticky-bar space-y-2';

  const topRow = document.createElement('div');
  topRow.className = 'flex flex-wrap items-center justify-between gap-1.5';

  const leftMeta = document.createElement('div');
  leftMeta.className = 'flex items-center gap-1.5';

  const summaryLabel = document.createElement('span');
  summaryLabel.className = 'text-xs font-semibold text-amber-900 tabular-nums';
  summaryLabel.textContent = totalCount + ' <90% · ' + pageGroups.length + (pageGroups.length === 1 ? ' page' : ' pages');
  leftMeta.appendChild(summaryLabel);

  // Sort Capsule: Page Order vs Lowest % First
  const sortCap = document.createElement('div');
  sortCap.className = 'viewer-capsule';
  const btnSortPage = document.createElement('button');
  btnSortPage.type = 'button';
  btnSortPage.className = 'md-review-sort-pill' + (state.reviewSortMode !== 'conf' ? ' is-active' : '');
  btnSortPage.textContent = 'By Page';
  btnSortPage.title = 'Order <90% bubbles page-by-page in manga reading order';
  btnSortPage.addEventListener('click', () => {
    state.reviewSortMode = 'page';
    renderRightPanel();
  });
  const btnSortConf = document.createElement('button');
  btnSortConf.type = 'button';
  btnSortConf.className = 'md-review-sort-pill' + (state.reviewSortMode === 'conf' ? ' is-active' : '');
  btnSortConf.textContent = 'Lowest %';
  btnSortConf.title = 'Order lowest OCR confidence bubbles first across all pages';
  btnSortConf.addEventListener('click', () => {
    state.reviewSortMode = 'conf';
    renderRightPanel();
  });
  sortCap.appendChild(btnSortPage);
  sortCap.appendChild(btnSortConf);
  leftMeta.appendChild(sortCap);
  topRow.appendChild(leftMeta);

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
  btnPrevRev.title = 'Jump to previous <90% OCR bubble (Shortcut: P)';
  btnPrevRev.addEventListener('click', () => jumpToLowConfidenceByStep(-1));

  const stepPos = document.createElement('span');
  stepPos.className = 'px-1.5 text-[11px] font-medium text-slate-600 tabular-nums select-none';
  stepPos.textContent = (activePos >= 0 ? (activePos + 1) : '–') + '/' + filteredItems.length;

  const btnNextRev = document.createElement('button');
  btnNextRev.type = 'button';
  btnNextRev.className = 'px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 rounded';
  btnNextRev.textContent = 'Next →';
  btnNextRev.title = 'Jump to next <90% OCR bubble (Shortcut: N)';
  btnNextRev.addEventListener('click', () => jumpToLowConfidenceByStep(1));

  stepper.appendChild(btnPrevRev);
  stepper.appendChild(stepPos);
  stepper.appendChild(btnNextRev);
  navRight.appendChild(stepper);
  topRow.appendChild(navRight);
  stickyHeader.appendChild(topRow);

  // Page Quick-Jump & Filter Chips Row
  const chipsRow = document.createElement('div');
  chipsRow.className = 'flex items-center gap-1.5 overflow-x-auto custom-scroll pb-0.5';

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'md-review-page-chip' + (!state.reviewQueuePageId ? ' is-active' : '');
  allChip.textContent = 'All Pages (' + totalCount + ')';
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
    pChip.title = 'Jump to Page ' + (g.pageIdx + 1) + ' (' + g.page.name + ') — click again to show all pages';
    pChip.addEventListener('click', () => {
      state.reviewQueuePageId = isAct ? null : g.page.id;
      focusBlockOnStage(g.pageIdx, g.firstBlkId);
    });
    chipsRow.appendChild(pChip);
  });
  stickyHeader.appendChild(chipsRow);
  el.panelReviewQueue.appendChild(stickyHeader);

  // Render Each <90% Review Card (with Page Section Dividers in 'By Page' mode)
  let lastRenderedPageId = null;
  filteredItems.forEach((it) => {
    if (state.reviewSortMode !== 'conf' && it.page.id !== lastRenderedPageId) {
      lastRenderedPageId = it.page.id;
      const pGroup = seenPageIds.get(it.page.id);
      const groupBar = document.createElement('div');
      groupBar.className = 'md-review-page-group';

      const pTitleBtn = document.createElement('button');
      pTitleBtn.type = 'button';
      pTitleBtn.className = 'text-left text-xs font-medium text-slate-800 hover:underline truncate min-w-0';
      pTitleBtn.textContent = 'Page ' + (it.pageIdx + 1) + ' · ' + it.page.name + ' (' + (pGroup ? pGroup.count : 1) + ')';
      pTitleBtn.title = 'Jump viewer to Page ' + (it.pageIdx + 1);
      pTitleBtn.addEventListener('click', () => {
        focusBlockOnStage(it.pageIdx, it.blk.id);
      });

      const btnVerifyPage = document.createElement('button');
      btnVerifyPage.type = 'button';
      btnVerifyPage.className = 'md-btn-text px-2 py-0.5 rounded text-[11px] font-medium shrink-0';
      btnVerifyPage.textContent = '✓ Verify Page';
      btnVerifyPage.title = 'Mark all <90% bubbles with text on Page ' + (it.pageIdx + 1) + ' as verified';
      btnVerifyPage.addEventListener('click', () => {
        let verifiedN = 0;
        (it.page.blocks || []).forEach((b) => {
          if (isBlockBelowReviewThreshold(b, it.page) && Boolean((b.text || '').trim())) {
            b.verified = true;
            verifiedN++;
          }
        });
        if (verifiedN > 0) {
          updatePageCardInPlace(it.page);
          advanceAfterResolvingReviewItem(it.pageIdx, false);
          showToast('Verified ' + verifiedN + ' bubble(s) on Page ' + (it.pageIdx + 1) + '!');
        }
      });

      groupBar.appendChild(pTitleBtn);
      groupBar.appendChild(btnVerifyPage);
      el.panelReviewQueue.appendChild(groupBar);
    }

    const isSel = it.page.id === state.selectedPageId && it.blk.id === state.selectedBlockId;
    const card = document.createElement('div');
    card.setAttribute('data-block-card', it.blk.id);
    card.setAttribute('data-selected', isSel ? 'true' : 'false');
    card.className =
      'rounded-md border p-2.5 transition cursor-pointer ' +
      (isSel
        ? 'md-bubble-card-selected border-2 border-amber-500 bg-amber-50/80 shadow-sm'
        : 'border-amber-300 bg-amber-50/35 hover:border-amber-400');

    // Clicking anywhere on the card body (outside buttons/textarea) jumps directly to that page & bubble
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('button, textarea')) return;
      focusBlockOnStage(it.pageIdx, it.blk.id);
    });

    const topBar = document.createElement('div');
    topBar.className = 'flex flex-wrap items-center justify-between gap-1.5 mb-2';

    const locLeft = document.createElement('div');
    locLeft.className = 'flex items-center gap-1.5';

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.setAttribute('data-review-jump-pill', '1');
    jumpBtn.className =
      'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition ' +
      (isSel
        ? 'bg-rose-600 text-white'
        : 'bg-white border border-amber-300 text-slate-800 hover:bg-amber-100');
    jumpBtn.textContent = 'P.' + (it.pageIdx + 1) + ' · #' + (it.blkIdx + 1);
    jumpBtn.title = 'Jump to Page ' + (it.pageIdx + 1) + ', Bubble #' + (it.blkIdx + 1) + ' on the manga viewer';
    jumpBtn.addEventListener('click', () => {
      focusBlockOnStage(it.pageIdx, it.blk.id);
    });

    const confTag = document.createElement('span');
    confTag.className = 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-200/80 text-amber-950 border border-amber-400 tabular-nums';
    confTag.textContent = it.confPct !== null
      ? (it.confPct + '% OCR')
      : (it.isEmpty ? 'Empty OCR' : '<90% OCR');

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
      advanceAfterResolvingReviewItem(it.pageIdx, false);
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
    btnDel.title = 'Delete this false or unwanted bounding box and jump to next <90% bubble (Alt+Backspace in text box)';
    btnDel.addEventListener('click', () => {
      if (state.isExtracting) return;
      it.page.blocks = it.page.blocks.filter((b) => b.id !== it.blk.id);
      updatePageFullText(it.page);
      updatePageCardInPlace(it.page);
      advanceAfterResolvingReviewItem(it.pageIdx, false);
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
        advanceAfterResolvingReviewItem(it.pageIdx, true);
      } else if (ev.altKey && (ev.key === 'Backspace' || ev.key === 'Delete')) {
        ev.preventDefault();
        if (state.isExtracting) return;
        it.page.blocks = it.page.blocks.filter((b) => b.id !== it.blk.id);
        updatePageFullText(it.page);
        updatePageCardInPlace(it.page);
        advanceAfterResolvingReviewItem(it.pageIdx, true);
      }
    });

    bodyRow.appendChild(thumbCanvas);
    bodyRow.appendChild(ta);
    card.appendChild(bodyRow);
    el.panelReviewQueue.appendChild(card);
  });

  el.panelReviewQueue.scrollTop = prevScroll;
}


function syncSavedVocabIndicatorsInPlace() {
  const totalSaved = Array.isArray(state.savedVocab) ? state.savedVocab.length : 0;
  if (el.savedVocabCountBadge) {
    el.savedVocabCountBadge.textContent = String(totalSaved);
    el.savedVocabCountBadge.className = totalSaved > 0
      ? 'px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-600 text-white tabular-nums leading-none'
      : 'px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 tabular-nums leading-none';
  }

  document.querySelectorAll('[data-vocab-save-key]').forEach((btn) => {
    const key = btn.getAttribute('data-vocab-save-key') || '';
    const saved = Boolean(key && state.savedVocab.some((it) => normalizeVocabMatchKey(it) === key));
    btn.classList.toggle('is-saved', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    btn.textContent = saved ? '✓ Saved' : '+ Save';
    btn.title = saved
      ? 'Saved to your Anki Vocabulary list — click to remove'
      : 'Save this vocabulary word for review & Anki deck export';
  });

  document.querySelectorAll('[data-vocab-save-all-keys]').forEach((btn) => {
    const rawKeys = (btn.getAttribute('data-vocab-save-all-keys') || '').split('|').filter(Boolean);
    if (rawKeys.length === 0) return;
    const allSaved = rawKeys.every((k) => state.savedVocab.some((it) => normalizeVocabMatchKey(it) === k));
    btn.classList.toggle('is-saved', allSaved);
    btn.textContent = allSaved ? '✓ All Saved' : ('+ Save All (' + rawKeys.length + ')');
  });
}


function renderBatchStudyDock() {
  if (!el.batchStudyDock) return;
  const entries = resolveBatchQueueEntries();
  const qCount = entries.length;
  const pageCount = new Set(entries.map((e) => e.page.id)).size;
  const showDock = Boolean(state.batchSelectMode || qCount > 0 || state.batchStudyResult);

  el.batchStudyDock.classList.toggle('hidden', !showDock);
  if (!showDock) return;

  if (el.batchDockCountBadge) {
    el.batchDockCountBadge.textContent = qCount > 0
      ? ('Batch · ' + qCount + (qCount === 1 ? ' bubble' : ' bubbles') + (pageCount > 1 ? ' · ' + pageCount + ' pages' : ''))
      : 'Batch Select · 0';
  }
  if (el.batchDockHintText) {
    el.batchDockHintText.textContent = qCount === 0
      ? 'Click speech bubbles in reading order (1 → 2 → 3…) across pages'
      : 'Ordered context ready — click EN + Romaji + Vocab & Grammar';
  }
  if (el.batchBannerStatusText && state.batchSelectMode) {
    el.batchBannerStatusText.innerHTML = qCount > 0
      ? ('<strong>Batch Order (' + qCount + ' selected across ' + pageCount + (pageCount === 1 ? ' page' : ' pages') + '):</strong> Click more bubbles across pages or run <strong>EN + Romaji + Vocab &amp; Grammar</strong> below.')
      : '<strong>Batch Order Mode:</strong> Click speech bubbles in reading order (1 → 2 → 3…) across one or more pages, then click <strong>EN + Romaji + Vocab &amp; Grammar</strong> below.';
  }

  if (el.btnRunBatchStudy) {
    el.btnRunBatchStudy.disabled = qCount === 0 || state.isRunningBatchStudy;
    el.btnRunBatchStudy.textContent = state.isRunningBatchStudy
      ? ('Analyzing ' + qCount + ' in Order…')
      : ('EN + Romaji + Vocab & Grammar' + (qCount > 0 ? ' (' + qCount + ')' : ''));
  }

  const hasResult = Boolean(state.batchStudyResult && Array.isArray(state.batchStudyResult.steps) && state.batchStudyResult.steps.length > 0);
  if (el.btnToggleBatchResults) {
    el.btnToggleBatchResults.classList.toggle('hidden', !hasResult && !state.isRunningBatchStudy);
    el.btnToggleBatchResults.textContent = state.batchStudyExpanded ? 'Hide Study' : 'Show Study';
  }
  if (el.btnBatchUndoLast) {
    el.btnBatchUndoLast.disabled = qCount === 0 || state.isRunningBatchStudy;
  }
  if (el.btnClearBatchQueue) {
    el.btnClearBatchQueue.disabled = (qCount === 0 && !hasResult) || state.isRunningBatchStudy;
  }

  // Render Ordered Bubble Sequence Strip
  if (el.batchSequenceStrip) {
    el.batchSequenceStrip.innerHTML = '';
    if (qCount === 0) {
      const emptyHint = document.createElement('span');
      emptyHint.className = 'text-xs text-slate-500 py-0.5';
      emptyHint.textContent = 'No bubbles queued yet — click bubbles on this page, turn pages, and keep clicking in reading order.';
      el.batchSequenceStrip.appendChild(emptyHint);
    } else {
      entries.forEach((ent, idx) => {
        if (idx > 0) {
          const arrow = document.createElement('span');
          arrow.className = 'text-xs text-slate-400 select-none shrink-0';
          arrow.textContent = '→';
          el.batchSequenceStrip.appendChild(arrow);
        }
        const chip = document.createElement('div');
        chip.className = 'md-batch-seq-chip';
        chip.setAttribute('data-batch-chip-step', String(ent.step));
        chip.title = 'Page ' + (ent.pageIdx + 1) + ' #' + ent.bubbleNum + ': ' + ent.text + ' (click to jump)';

        const num = document.createElement('span');
        num.className = 'md-batch-seq-num';
        num.textContent = String(ent.step);

        const loc = document.createElement('span');
        loc.className = 'text-[10px] font-semibold text-slate-500';
        loc.textContent = 'P' + (ent.pageIdx + 1) + '#' + ent.bubbleNum;

        const snippet = document.createElement('span');
        snippet.className = 'jp-text font-medium';
        const shortTxt = Array.from(ent.text).length > 12
          ? Array.from(ent.text).slice(0, 12).join('') + '…'
          : ent.text;
        snippet.textContent = shortTxt;

        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'md-batch-seq-remove';
        rmBtn.textContent = '×';
        rmBtn.title = 'Remove Step #' + ent.step + ' from batch';
        rmBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeBatchStepAt(idx);
        });

        chip.addEventListener('click', () => {
          if (typeof focusBlockOnStage === 'function') {
            focusBlockOnStage(ent.pageIdx, ent.blk.id, { skipRightRender: false });
          } else {
            goToPageIndex(ent.pageIdx, { animateSlide: true });
          }
        });

        chip.appendChild(num);
        chip.appendChild(loc);
        chip.appendChild(snippet);
        chip.appendChild(rmBtn);
        el.batchSequenceStrip.appendChild(chip);
      });
    }
  }

  // Render Expandable Batch Study Results Panel
  if (el.batchStudyResultsPanel) {
    const showResults = Boolean(state.batchStudyExpanded && (state.isRunningBatchStudy || hasResult));
    el.batchStudyResultsPanel.classList.toggle('hidden', !showResults);
    if (!showResults) return;

    const prevScroll = el.batchStudyResultsPanel.scrollTop;
    el.batchStudyResultsPanel.innerHTML = '';

    if (state.isRunningBatchStudy) {
      const loadingBox = document.createElement('div');
      loadingBox.className = 'rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 text-xs text-slate-700';
      loadingBox.textContent = 'Translating ' + qCount + ' ordered bubble(s) together with verified Romaji, vocabulary & grammar…';
      el.batchStudyResultsPanel.appendChild(loadingBox);
      return;
    }

    const res = state.batchStudyResult;
    if (!res) return;

    // Collect all vocab across all steps for 1-click "+ Save All Batch Vocab"
    const allBatchVocabPairs = [];
    (res.steps || []).forEach((st) => {
      (st.vocab || []).forEach((v) => {
        if (getVocabPrimaryKanji(v)) {
          allBatchVocabPairs.push({
            v,
            meta: {
              contextJp: st.jpText,
              pageId: st.pageId,
              pageName: st.pageName,
              bubbleIndex: st.bubbleNum,
              blockId: st.blockId
            }
          });
        }
      });
    });

    // 1. Connected Dialogue Flow Summary Card
    const summaryCard = document.createElement('div');
    summaryCard.setAttribute('data-batch-connected-card', '1');
    summaryCard.className = 'rounded-lg border border-indigo-200 bg-indigo-50/55 p-3 space-y-1.5 text-xs';

    const sumHead = document.createElement('div');
    sumHead.className = 'flex flex-wrap items-center justify-between gap-2';
    const sumTitle = document.createElement('span');
    sumTitle.className = 'text-[11px] font-bold uppercase tracking-wider text-indigo-900';
    sumTitle.textContent = 'Connected Sequence (' + res.steps.length + ' Bubbles in Order)';
    sumHead.appendChild(sumTitle);

    const sumBtns = document.createElement('div');
    sumBtns.className = 'flex items-center gap-1.5';
    if (res.connectedRomaji) {
      const btnCpRom = document.createElement('button');
      btnCpRom.type = 'button';
      btnCpRom.className = 'md-copy-romaji-btn';
      btnCpRom.textContent = 'Copy Romaji';
      btnCpRom.addEventListener('click', () => copyTextSafe(res.connectedRomaji, 'Copied connected Romaji!'));
      sumBtns.appendChild(btnCpRom);
    }
    if (res.connectedEnglish) {
      const btnCpEn = document.createElement('button');
      btnCpEn.type = 'button';
      btnCpEn.className = 'md-copy-romaji-btn';
      btnCpEn.textContent = 'Copy EN';
      btnCpEn.addEventListener('click', () => copyTextSafe(res.connectedEnglish, 'Copied connected English!'));
      sumBtns.appendChild(btnCpEn);
    }
    if (allBatchVocabPairs.length > 0) {
      const allKeys = allBatchVocabPairs.map((p) => normalizeVocabMatchKey(p.v)).filter(Boolean).join('|');
      const allSaved = allBatchVocabPairs.every((p) => isVocabItemSaved(p.v));
      const btnSaveAllBatch = document.createElement('button');
      btnSaveAllBatch.type = 'button';
      btnSaveAllBatch.setAttribute('data-vocab-save-all-keys', allKeys);
      btnSaveAllBatch.className = 'md-vocab-save-btn' + (allSaved ? ' is-saved' : '');
      btnSaveAllBatch.textContent = allSaved
        ? '✓ All Saved'
        : ('+ Save All Vocab (' + allBatchVocabPairs.length + ')');
      btnSaveAllBatch.addEventListener('click', () => {
        let added = 0;
        allBatchVocabPairs.forEach((pair) => {
          if (!isVocabItemSaved(pair.v)) {
            state.savedVocab.push(buildSavedVocabRecord(pair.v, pair.meta));
            added++;
          }
        });
        if (added > 0) {
          persistSavedVocabState();
          notifySavedVocabChanged();
          showToast('Saved ' + added + ' vocabulary word(s) from batch!');
        } else {
          showToast('All batch vocabulary words are already saved!');
        }
      });
      sumBtns.appendChild(btnSaveAllBatch);
    }
    sumHead.appendChild(sumBtns);
    summaryCard.appendChild(sumHead);

    if (res.connectedRomaji) {
      const cRom = document.createElement('div');
      cRom.setAttribute('data-batch-connected-romaji', '1');
      cRom.className = 'italic font-medium text-indigo-800 leading-snug';
      cRom.textContent = res.connectedRomaji;
      summaryCard.appendChild(cRom);
    }
    if (res.connectedEnglish) {
      const cEn = document.createElement('div');
      cEn.setAttribute('data-batch-connected-english', '1');
      cEn.className = 'font-semibold text-slate-900 text-[13px] leading-snug';
      cEn.textContent = res.connectedEnglish;
      summaryCard.appendChild(cEn);
    }
    if (res.contextNote) {
      const cNote = document.createElement('p');
      cNote.className = 'text-[11px] text-slate-600 pt-1 border-t border-indigo-200/60 leading-snug';
      cNote.textContent = 'Context Flow: ' + res.contextNote;
      summaryCard.appendChild(cNote);
    }
    el.batchStudyResultsPanel.appendChild(summaryCard);

    // 2. Per-Step Breakdown Cards
    res.steps.forEach((st) => {
      const stMeta = {
        contextJp: st.jpText,
        pageId: st.pageId,
        pageName: st.pageName,
        bubbleIndex: st.bubbleNum,
        blockId: st.blockId
      };
      const stCard = document.createElement('div');
      stCard.setAttribute('data-batch-step-card', String(st.step));
      stCard.className = 'rounded-lg border border-slate-200 bg-white p-2.5 space-y-2 text-xs';

      const stHead = document.createElement('div');
      stHead.className = 'flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100';
      const stLeft = document.createElement('div');
      stLeft.className = 'flex items-center gap-1.5 min-w-0';
      const stBadge = document.createElement('span');
      stBadge.className = 'md-batch-seq-num';
      stBadge.textContent = String(st.step);
      const stLoc = document.createElement('button');
      stLoc.type = 'button';
      stLoc.className = 'text-[11px] font-semibold text-indigo-700 hover:underline';
      stLoc.textContent = 'Page ' + (st.pageIdx + 1) + ' · Bubble #' + st.bubbleNum;
      stLoc.addEventListener('click', () => {
        if (typeof focusBlockOnStage === 'function') {
          focusBlockOnStage(st.pageIdx, st.blockId, { skipRightRender: false });
        }
      });
      const stJp = document.createElement('span');
      stJp.className = 'jp-text font-bold text-slate-900 truncate';
      stJp.textContent = '「' + st.jpText + '」';

      stLeft.appendChild(stBadge);
      stLeft.appendChild(stLoc);
      stLeft.appendChild(stJp);
      stHead.appendChild(stLeft);
      stCard.appendChild(stHead);

      if (st.romaji) {
        const rLine = document.createElement('div');
        rLine.className = 'flex items-baseline gap-1.5';
        const rLbl = document.createElement('span');
        rLbl.className = 'text-[10px] font-bold uppercase tracking-wider text-indigo-700 shrink-0';
        rLbl.textContent = 'Romaji';
        const rVal = document.createElement('span');
        rVal.className = 'italic font-medium text-slate-800';
        rVal.textContent = st.romaji;
        rLine.appendChild(rLbl);
        rLine.appendChild(rVal);
        stCard.appendChild(rLine);
      }

      if (st.english) {
        const eLine = document.createElement('div');
        eLine.className = 'flex items-baseline gap-1.5';
        const eLbl = document.createElement('span');
        eLbl.className = 'text-[10px] font-bold uppercase tracking-wider text-emerald-700 shrink-0';
        eLbl.textContent = 'English';
        const eVal = document.createElement('span');
        eVal.className = 'font-medium text-slate-900';
        eVal.textContent = st.english;
        eLine.appendChild(eLbl);
        eLine.appendChild(eVal);
        stCard.appendChild(eLine);
      }

      if (st.nuance) {
        const nLine = document.createElement('p');
        nLine.className = 'text-[11px] text-slate-500';
        nLine.textContent = 'Tone / Continuity: ' + st.nuance;
        stCard.appendChild(nLine);
      }

      if (Array.isArray(st.vocab) && st.vocab.length > 0) {
        const vWrap = document.createElement('div');
        vWrap.className = 'space-y-1 pt-1 border-t border-slate-100';
        st.vocab.forEach((v) => {
          const vRow = document.createElement('div');
          vRow.className = 'rounded border border-slate-200 bg-slate-50/50 px-2 py-1 flex flex-col gap-0.5';
          const top = document.createElement('div');
          top.className = 'flex flex-wrap items-center justify-between gap-1';
          const wLeft = document.createElement('div');
          wLeft.className = 'flex flex-wrap items-baseline gap-1.5';
          const sf = document.createElement('span');
          sf.className = 'jp-text font-bold text-slate-900';
          sf.textContent = v.surface || '';
          wLeft.appendChild(sf);
          if (v.reading && v.reading !== v.surface) {
            const rd = document.createElement('span');
            rd.className = 'jp-text text-[11px] text-indigo-700 font-medium';
            rd.textContent = '【' + v.reading + '】';
            wLeft.appendChild(rd);
          }
          if (v.romaji) {
            const rm = document.createElement('span');
            rm.className = 'italic text-[11px] text-slate-500';
            rm.textContent = v.romaji;
            wLeft.appendChild(rm);
          }
          top.appendChild(wLeft);

          const wRight = document.createElement('div');
          wRight.className = 'flex items-center gap-1 ml-auto shrink-0';
          if (v.pos) {
            const pos = document.createElement('span');
            pos.className = 'px-1.5 py-0.2 rounded bg-emerald-100/80 text-emerald-900 text-[10px] font-semibold';
            pos.textContent = v.pos;
            wRight.appendChild(pos);
          }
          const vKey = normalizeVocabMatchKey(v);
          const saved = isVocabItemSaved(v);
          const btnSave = document.createElement('button');
          btnSave.type = 'button';
          btnSave.setAttribute('data-vocab-save-btn', '1');
          btnSave.setAttribute('data-vocab-save-key', vKey);
          btnSave.className = 'md-vocab-save-btn' + (saved ? ' is-saved' : '');
          btnSave.textContent = saved ? '✓ Saved' : '+ Save';
          btnSave.addEventListener('click', () => toggleSaveVocabItem(v, stMeta));
          wRight.appendChild(btnSave);
          top.appendChild(wRight);

          const mn = document.createElement('p');
          mn.className = 'text-[11px] text-slate-700 leading-snug';
          mn.textContent = v.meaning || '';
          vRow.appendChild(top);
          vRow.appendChild(mn);
          vWrap.appendChild(vRow);
        });
        stCard.appendChild(vWrap);
      }

      if (Array.isArray(st.grammar) && st.grammar.length > 0) {
        const gWrap = document.createElement('div');
        gWrap.className = 'space-y-1 pt-1 border-t border-slate-100';
        st.grammar.forEach((g) => {
          const gRow = document.createElement('div');
          gRow.className = 'rounded border border-indigo-100 bg-indigo-50/35 px-2 py-1';
          const gTop = document.createElement('div');
          gTop.className = 'flex items-center justify-between gap-1';
          const pat = document.createElement('span');
          pat.className = 'jp-text font-bold text-indigo-900';
          pat.textContent = g.pattern || '';
          gTop.appendChild(pat);
          if (g.level) {
            const lvl = document.createElement('span');
            lvl.className = 'text-[10px] font-semibold text-indigo-700';
            lvl.textContent = g.level;
            gTop.appendChild(lvl);
          }
          const exp = document.createElement('p');
          exp.className = 'text-[11px] text-slate-700 leading-snug mt-0.5';
          exp.textContent = g.explanation || '';
          gRow.appendChild(gTop);
          gRow.appendChild(exp);
          gWrap.appendChild(gRow);
        });
        stCard.appendChild(gWrap);
      }

      el.batchStudyResultsPanel.appendChild(stCard);
    });

    el.batchStudyResultsPanel.scrollTop = prevScroll;
  }
}

function renderSavedVocabPanel() {
  if (!el.panelSavedVocab) return;
  const prevScroll = el.panelSavedVocab.scrollTop;
  el.panelSavedVocab.innerHTML = '';

  const totalSaved = state.savedVocab.length;

  // Sticky Header: Segmented View Switcher (Saved List | Review Cards) + Add/Clear + Anki Deck Card Generator
  const sticky = document.createElement('div');
  sticky.className = 'md-vocab-sticky-bar space-y-2';

  const topRow = document.createElement('div');
  topRow.className = 'flex flex-wrap items-center justify-between gap-1.5';

  const modeGroup = document.createElement('div');
  modeGroup.className = 'inline-flex items-center rounded-md border border-slate-200 p-0.5 bg-slate-50/70';

  const btnListMode = document.createElement('button');
  btnListMode.type = 'button';
  btnListMode.setAttribute('data-vocab-mode-btn', 'list');
  btnListMode.className = 'md-review-sort-pill ' + (state.vocabViewMode === 'list' ? 'is-active' : '');
  btnListMode.textContent = 'Saved List (' + totalSaved + ')';
  btnListMode.addEventListener('click', () => {
    state.vocabViewMode = 'list';
    renderSavedVocabPanel();
  });

  const btnCardsMode = document.createElement('button');
  btnCardsMode.type = 'button';
  btnCardsMode.setAttribute('data-vocab-mode-btn', 'cards');
  btnCardsMode.className = 'md-review-sort-pill ' + (state.vocabViewMode === 'cards' ? 'is-active' : '');
  btnCardsMode.textContent = 'Review Cards';
  btnCardsMode.disabled = totalSaved === 0;
  btnCardsMode.title = 'Practice your saved words as Anki flashcards (Front: Kanji -> Back: Romaji & Meaning)';
  btnCardsMode.addEventListener('click', () => {
    state.vocabViewMode = 'cards';
    state.vocabCardFlipped = false;
    if (state.vocabCardIndex >= state.savedVocab.length) state.vocabCardIndex = 0;
    renderSavedVocabPanel();
  });

  modeGroup.appendChild(btnListMode);
  modeGroup.appendChild(btnCardsMode);

  const rightBtns = document.createElement('div');
  rightBtns.className = 'flex items-center gap-1';

  const btnAddToggle = document.createElement('button');
  btnAddToggle.type = 'button';
  btnAddToggle.setAttribute('data-vocab-add-toggle', '1');
  btnAddToggle.className = 'md-btn-outlined px-2 py-0.5 rounded text-[11px] font-medium transition';
  btnAddToggle.textContent = state.vocabShowAddForm ? 'Cancel' : '+ Add Word';
  btnAddToggle.addEventListener('click', () => {
    state.vocabShowAddForm = !state.vocabShowAddForm;
    state.vocabConfirmClear = false;
    if (state.vocabShowAddForm) state.vocabViewMode = 'list';
    renderSavedVocabPanel();
  });
  rightBtns.appendChild(btnAddToggle);

  if (totalSaved > 0) {
    const btnClear = document.createElement('button');
    btnClear.type = 'button';
    btnClear.className = state.vocabConfirmClear
      ? 'px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-600 text-white hover:bg-rose-700 transition'
      : 'md-btn-text px-2 py-0.5 rounded text-[11px] font-medium text-slate-500 hover:text-rose-600 transition';
    btnClear.textContent = state.vocabConfirmClear ? 'Confirm Clear?' : 'Clear';
    btnClear.addEventListener('click', () => {
      if (!state.vocabConfirmClear) {
        state.vocabConfirmClear = true;
        renderSavedVocabPanel();
        return;
      }
      state.savedVocab = [];
      state.vocabConfirmClear = false;
      state.vocabEditingId = null;
      state.vocabCardIndex = 0;
      state.vocabCardFlipped = false;
      state.vocabViewMode = 'list';
      persistSavedVocabState();
      notifySavedVocabChanged();
      showToast('Cleared saved vocabulary list.');
    });
    rightBtns.appendChild(btnClear);
  }

  topRow.appendChild(modeGroup);
  topRow.appendChild(rightBtns);
  sticky.appendChild(topRow);

  // Anki Deck Card Generator Box (Front: Kanji | Back: Romaji + Meaning)
  const deckBox = document.createElement('div');
  deckBox.className = 'md-vocab-deck-box space-y-1.5';

  const deckMetaRow = document.createElement('div');
  deckMetaRow.className = 'flex flex-wrap items-center justify-between gap-1 text-[11px]';
  const specLabel = document.createElement('span');
  specLabel.className = 'font-medium text-slate-700';
  specLabel.textContent = 'Anki Deck · Front: Kanji | Back: Romaji + Meaning';
  deckMetaRow.appendChild(specLabel);
  deckBox.appendChild(deckMetaRow);

  const exportRow = document.createElement('div');
  exportRow.className = 'flex flex-wrap items-center gap-1.5';

  const deckInput = document.createElement('input');
  deckInput.type = 'text';
  deckInput.value = state.vocabDeckName || 'AnkiSuru Manga Vocabulary';
  deckInput.placeholder = 'Anki deck name…';
  deckInput.setAttribute('aria-label', 'Anki deck name');
  deckInput.className = 'md-vocab-input flex-1 min-w-[130px]';
  deckInput.addEventListener('input', () => {
    state.vocabDeckName = deckInput.value;
    persistSavedVocabState();
  });

  const btnExportApkg = document.createElement('button');
  btnExportApkg.type = 'button';
  btnExportApkg.setAttribute('data-export-anki-apkg', '1');
  btnExportApkg.disabled = totalSaved === 0 || state.isExportingAnki;
  btnExportApkg.className = 'md-btn-filled px-2.5 py-1 rounded text-[11px] font-medium transition disabled:opacity-45 shrink-0';
  btnExportApkg.textContent = state.isExportingAnki
    ? 'Building…'
    : ('Generate Anki Deck (.apkg)');
  btnExportApkg.title = 'Download native Anki .apkg deck with Kanji on the front card and Romaji + Meaning on the back card';
  btnExportApkg.addEventListener('click', () => {
    exportSavedVocabAsAnkiApkg();
  });

  const btnExportTxt = document.createElement('button');
  btnExportTxt.type = 'button';
  btnExportTxt.setAttribute('data-export-anki-txt', '1');
  btnExportTxt.disabled = totalSaved === 0;
  btnExportTxt.className = 'md-btn-outlined px-2 py-1 rounded text-[11px] font-medium transition disabled:opacity-45 shrink-0';
  btnExportTxt.textContent = 'Anki .txt';
  btnExportTxt.title = 'Download Anki tab-separated text import file (Front: Kanji, Back: Romaji + Meaning)';
  btnExportTxt.addEventListener('click', () => {
    exportSavedVocabAsAnkiTxt();
  });

  exportRow.appendChild(deckInput);
  exportRow.appendChild(btnExportApkg);
  exportRow.appendChild(btnExportTxt);
  deckBox.appendChild(exportRow);
  sticky.appendChild(deckBox);

  // Inline "+ Add Word" Quick Form
  if (state.vocabShowAddForm) {
    const addForm = document.createElement('form');
    addForm.className = 'rounded-lg border border-indigo-200 bg-indigo-50/50 p-2.5 space-y-2 text-xs';
    addForm.setAttribute('data-vocab-add-form', '1');

    const title = document.createElement('div');
    title.className = 'text-[11px] font-semibold text-indigo-900';
    title.textContent = 'Add Custom Vocabulary Card';
    addForm.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-1.5';

    const inKanji = document.createElement('input');
    inKanji.type = 'text';
    inKanji.placeholder = 'Front: Kanji / Word (e.g. 放課後)';
    inKanji.className = 'md-vocab-input jp-text';
    inKanji.setAttribute('data-add-vocab-kanji', '1');

    const inRomaji = document.createElement('input');
    inRomaji.type = 'text';
    inRomaji.placeholder = 'Back: Romaji (auto-filled)';
    inRomaji.className = 'md-vocab-input';
    inRomaji.setAttribute('data-add-vocab-romaji', '1');

    let romajiManuallyEdited = false;
    inRomaji.addEventListener('input', () => {
      romajiManuallyEdited = Boolean(inRomaji.value.trim());
    });
    inKanji.addEventListener('input', () => {
      if (!romajiManuallyEdited) {
        inRomaji.value = computeInstantWordRomaji(inKanji.value, '');
      }
    });

    grid.appendChild(inKanji);
    grid.appendChild(inRomaji);
    addForm.appendChild(grid);

    const inMeaning = document.createElement('input');
    inMeaning.type = 'text';
    inMeaning.placeholder = 'Back: English meaning (e.g. after school)';
    inMeaning.className = 'md-vocab-input';
    inMeaning.setAttribute('data-add-vocab-meaning', '1');
    addForm.appendChild(inMeaning);

    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-end gap-1.5';
    const btnSaveNew = document.createElement('button');
    btnSaveNew.type = 'submit';
    btnSaveNew.className = 'md-btn-filled px-3 py-1 rounded text-[11px] font-medium';
    btnSaveNew.textContent = 'Save Vocabulary';
    btnRow.appendChild(btnSaveNew);
    addForm.appendChild(btnRow);

    addForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const k = inKanji.value.trim();
      if (!k) {
        showToast('Enter a Japanese word / Kanji for the front card.', 'warn');
        inKanji.focus();
        return;
      }
      const r = inRomaji.value.trim() || computeInstantWordRomaji(k, '');
      const m = inMeaning.value.trim();
      const page = getSelectedPage();
      const rec = buildSavedVocabRecord(
        { kanji: k, romaji: r, meaning: m },
        { pageId: page ? page.id : null, pageName: page ? page.name : '' }
      );
      state.savedVocab.push(rec);
      state.vocabShowAddForm = false;
      persistSavedVocabState();
      notifySavedVocabChanged();
      showToast('Added "' + rec.kanji + '" to Saved Vocabulary!');
    });

    sticky.appendChild(addForm);
  }

  el.panelSavedVocab.appendChild(sticky);

  // Empty State
  if (totalSaved === 0) {
    const empty = document.createElement('div');
    empty.className = 'rounded-lg border border-dashed border-slate-300 p-6 text-center space-y-2 mt-2';
    const h = document.createElement('p');
    h.className = 'text-xs font-semibold text-slate-700';
    h.textContent = 'No vocabulary saved yet';
    const sub = document.createElement('p');
    sub.className = 'text-[11px] text-slate-500 leading-relaxed';
    sub.textContent = 'Open Vocab & Grammar on any speech bubble (in Page Bubbles or the Select Text popup) and click "+ Save" next to any word, highlight a word in Select Text popup, or click "+ Add Word" above.';
    empty.appendChild(h);
    empty.appendChild(sub);
    el.panelSavedVocab.appendChild(empty);
    return;
  }

  // Mode B: Interactive Anki Flashcard Review / Flip Preview
  if (state.vocabViewMode === 'cards') {
    const idx = Math.max(0, Math.min(totalSaved - 1, state.vocabCardIndex || 0));
    state.vocabCardIndex = idx;
    const item = state.savedVocab[idx];
    const flipped = Boolean(state.vocabCardFlipped);

    const cardWrap = document.createElement('div');
    cardWrap.className = 'space-y-2.5 pt-1';

    const metaTop = document.createElement('div');
    metaTop.className = 'flex items-center justify-between text-xs text-slate-500 px-0.5';
    const counter = document.createElement('span');
    counter.className = 'font-semibold tabular-nums text-slate-700';
    counter.textContent = 'Card ' + (idx + 1) + ' of ' + totalSaved;

    const btnShuffle = document.createElement('button');
    btnShuffle.type = 'button';
    btnShuffle.className = 'md-btn-text px-2 py-0.5 rounded text-[11px] font-medium text-indigo-600';
    btnShuffle.textContent = 'Shuffle Order';
    btnShuffle.addEventListener('click', () => {
      for (let i = state.savedVocab.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = state.savedVocab[i];
        state.savedVocab[i] = state.savedVocab[j];
        state.savedVocab[j] = tmp;
      }
      state.vocabCardIndex = 0;
      state.vocabCardFlipped = false;
      persistSavedVocabState();
      renderSavedVocabPanel();
    });

    metaTop.appendChild(counter);
    metaTop.appendChild(btnShuffle);
    cardWrap.appendChild(metaTop);

    const flashcard = document.createElement('div');
    flashcard.className = 'md-vocab-flashcard';
    flashcard.setAttribute('data-vocab-flashcard', '1');
    flashcard.setAttribute('tabindex', '0');
    flashcard.setAttribute('role', 'button');
    flashcard.setAttribute('aria-label', flipped ? 'Back of Anki card — click to flip to front' : 'Front of Anki card — click to reveal Romaji and Meaning');

    const sideBadge = document.createElement('span');
    sideBadge.className = flipped
      ? 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800'
      : 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-100 text-indigo-800';
    sideBadge.textContent = flipped ? 'Back · Romaji & Meaning' : 'Front · Kanji';
    flashcard.appendChild(sideBadge);

    const centerContent = document.createElement('div');
    centerContent.className = 'w-full py-3 space-y-2';

    const kanjiEl = document.createElement('div');
    kanjiEl.className = 'jp-text font-bold text-slate-900 ' + (flipped ? 'text-2xl' : 'text-3xl py-4');
    kanjiEl.textContent = item.kanji || '';
    centerContent.appendChild(kanjiEl);

    if (flipped) {
      const hr = document.createElement('hr');
      hr.className = 'md-vocab-card-divider';
      centerContent.appendChild(hr);

      const romEl = document.createElement('div');
      romEl.setAttribute('data-flashcard-romaji', '1');
      romEl.className = 'text-base font-semibold text-indigo-700';
      romEl.textContent = item.romaji || computeInstantWordRomaji(item.kanji, item.reading) || '—';
      centerContent.appendChild(romEl);

      const meanEl = document.createElement('div');
      meanEl.setAttribute('data-flashcard-meaning', '1');
      meanEl.className = 'text-sm font-medium text-slate-800 max-w-sm mx-auto leading-snug';
      meanEl.textContent = item.meaning || '(No meaning entered yet)';
      centerContent.appendChild(meanEl);

      if (item.reading && item.reading !== item.kanji) {
        const rdEl = document.createElement('div');
        rdEl.className = 'jp-text text-xs text-slate-500 pt-0.5';
        rdEl.textContent = 'Reading: ' + item.reading + (item.pos ? ' · ' + item.pos : '');
        centerContent.appendChild(rdEl);
      }
    }

    flashcard.appendChild(centerContent);

    const hintEl = document.createElement('span');
    hintEl.className = 'text-[11px] text-slate-400';
    hintEl.textContent = flipped
      ? 'Click card or press Space to flip back to Kanji'
      : 'Click card or press Space to reveal Romaji & Meaning';
    flashcard.appendChild(hintEl);

    flashcard.addEventListener('click', () => {
      state.vocabCardFlipped = !state.vocabCardFlipped;
      renderSavedVocabPanel();
    });
    flashcard.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        state.vocabCardFlipped = !state.vocabCardFlipped;
        renderSavedVocabPanel();
      }
    });

    cardWrap.appendChild(flashcard);

    const navRow = document.createElement('div');
    navRow.className = 'flex items-center justify-between gap-2';

    const btnPrevCard = document.createElement('button');
    btnPrevCard.type = 'button';
    btnPrevCard.disabled = idx <= 0;
    btnPrevCard.className = 'md-btn-outlined px-3 py-1.5 rounded text-xs font-medium disabled:opacity-40';
    btnPrevCard.textContent = '← Prev';
    btnPrevCard.addEventListener('click', () => {
      if (state.vocabCardIndex > 0) {
        state.vocabCardIndex--;
        state.vocabCardFlipped = false;
        renderSavedVocabPanel();
      }
    });

    const btnFlipCard = document.createElement('button');
    btnFlipCard.type = 'button';
    btnFlipCard.setAttribute('data-vocab-flip-btn', '1');
    btnFlipCard.className = 'md-btn-filled flex-1 py-1.5 rounded text-xs font-medium';
    btnFlipCard.textContent = flipped ? 'Show Front (Kanji)' : 'Flip Card (Romaji & Meaning)';
    btnFlipCard.addEventListener('click', () => {
      state.vocabCardFlipped = !state.vocabCardFlipped;
      renderSavedVocabPanel();
    });

    const btnNextCard = document.createElement('button');
    btnNextCard.type = 'button';
    btnNextCard.disabled = idx >= totalSaved - 1;
    btnNextCard.className = 'md-btn-outlined px-3 py-1.5 rounded text-xs font-medium disabled:opacity-40';
    btnNextCard.textContent = 'Next →';
    btnNextCard.addEventListener('click', () => {
      if (state.vocabCardIndex < totalSaved - 1) {
        state.vocabCardIndex++;
        state.vocabCardFlipped = false;
        renderSavedVocabPanel();
      }
    });

    navRow.appendChild(btnPrevCard);
    navRow.appendChild(btnFlipCard);
    navRow.appendChild(btnNextCard);
    cardWrap.appendChild(navRow);

    el.panelSavedVocab.appendChild(cardWrap);
    el.panelSavedVocab.scrollTop = prevScroll;
    return;
  }

  // Mode A: Saved Vocabulary List, Search & Inline Editor
  if (totalSaved > 2) {
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.value = state.vocabSearchQuery || '';
    searchInput.placeholder = 'Filter saved kanji, romaji, or meaning…';
    searchInput.className = 'md-vocab-input';
    searchInput.addEventListener('input', () => {
      state.vocabSearchQuery = searchInput.value;
      renderSavedVocabPanel();
      const nextSearch = el.panelSavedVocab.querySelector('input[type="search"]');
      if (nextSearch) {
        nextSearch.focus();
        const len = nextSearch.value.length;
        try { nextSearch.setSelectionRange(len, len); } catch (_e) {}
      }
    });
    el.panelSavedVocab.appendChild(searchInput);
  }

  const q = (state.vocabSearchQuery || '').trim().toLowerCase();
  const filtered = q
    ? state.savedVocab.filter((it) =>
        (it.kanji || '').toLowerCase().includes(q) ||
        (it.reading || '').toLowerCase().includes(q) ||
        (it.romaji || '').toLowerCase().includes(q) ||
        (it.meaning || '').toLowerCase().includes(q)
      )
    : state.savedVocab;

  if (filtered.length === 0) {
    const noHit = document.createElement('p');
    noHit.className = 'text-xs text-slate-400 text-center py-6';
    noHit.textContent = 'No saved vocabulary matches "' + state.vocabSearchQuery + '".';
    el.panelSavedVocab.appendChild(noHit);
    return;
  }

  const listWrap = document.createElement('div');
  listWrap.className = 'space-y-2 pb-2';

  filtered.forEach((item, idx) => {
    const isEditing = state.vocabEditingId === item.id;
    const card = document.createElement('div');
    card.className = 'md-vocab-item-card space-y-1.5';
    card.setAttribute('data-saved-vocab-card', item.id);

    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center justify-between gap-1.5';

    const wordWrap = document.createElement('div');
    wordWrap.className = 'flex flex-wrap items-baseline gap-1.5 min-w-0';

    const numSpan = document.createElement('span');
    numSpan.className = 'text-[10px] font-semibold text-slate-400 tabular-nums';
    numSpan.textContent = '#' + (idx + 1);
    wordWrap.appendChild(numSpan);

    const kanjiSpan = document.createElement('span');
    kanjiSpan.className = 'jp-text text-sm font-bold text-slate-900';
    kanjiSpan.textContent = item.kanji;
    wordWrap.appendChild(kanjiSpan);

    if (item.reading && item.reading !== item.kanji) {
      const readSpan = document.createElement('span');
      readSpan.className = 'jp-text text-[11px] font-medium text-indigo-700';
      readSpan.textContent = '【' + item.reading + '】';
      wordWrap.appendChild(readSpan);
    }

    if (item.pos) {
      const posSpan = document.createElement('span');
      posSpan.className = 'px-1.5 py-0.2 rounded bg-emerald-100/80 text-emerald-900 text-[10px] font-semibold';
      posSpan.textContent = item.pos;
      wordWrap.appendChild(posSpan);
    }

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1 ml-auto shrink-0';

    if (item.pageId && state.pages.some((p) => p.id === item.pageId)) {
      const pIdx = state.pages.findIndex((p) => p.id === item.pageId);
      const btnJump = document.createElement('button');
      btnJump.type = 'button';
      btnJump.className = 'px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition';
      btnJump.textContent = 'P' + (pIdx + 1) + (item.bubbleIndex ? ' · #' + item.bubbleIndex : '');
      btnJump.title = 'Jump to source manga page & bubble';
      btnJump.addEventListener('click', () => {
        if (item.blockId && typeof focusBlockOnStage === 'function') {
          focusBlockOnStage(pIdx, item.blockId, { skipRightRender: true });
        } else {
          goToPageIndex(pIdx, { animateSlide: true });
        }
      });
      actions.appendChild(btnJump);
    }

    const btnPracticeOne = document.createElement('button');
    btnPracticeOne.type = 'button';
    btnPracticeOne.className = 'px-1.5 py-0.5 rounded text-[10px] font-medium text-indigo-700 hover:bg-indigo-50 transition';
    btnPracticeOne.textContent = 'Card';
    btnPracticeOne.title = 'Preview this word as an Anki flashcard';
    btnPracticeOne.addEventListener('click', () => {
      const realIdx = state.savedVocab.findIndex((x) => x.id === item.id);
      state.vocabCardIndex = Math.max(0, realIdx);
      state.vocabCardFlipped = false;
      state.vocabViewMode = 'cards';
      renderSavedVocabPanel();
    });
    actions.appendChild(btnPracticeOne);

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'px-1.5 py-0.5 rounded text-[10px] font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition';
    btnEdit.textContent = isEditing ? 'Done' : 'Edit';
    btnEdit.addEventListener('click', () => {
      state.vocabEditingId = isEditing ? null : item.id;
      renderSavedVocabPanel();
    });
    actions.appendChild(btnEdit);

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.setAttribute('data-remove-saved-vocab', item.id);
    btnDel.className = 'px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition';
    btnDel.textContent = '✕';
    btnDel.title = 'Remove from saved vocabulary';
    btnDel.addEventListener('click', () => {
      state.savedVocab = state.savedVocab.filter((x) => x.id !== item.id);
      if (state.vocabEditingId === item.id) state.vocabEditingId = null;
      persistSavedVocabState();
      notifySavedVocabChanged();
    });
    actions.appendChild(btnDel);

    head.appendChild(wordWrap);
    head.appendChild(actions);
    card.appendChild(head);

    if (isEditing) {
      const editBox = document.createElement('div');
      editBox.className = 'grid grid-cols-1 gap-1.5 pt-1 border-t border-slate-100 text-xs';

      const kIn = document.createElement('input');
      kIn.type = 'text';
      kIn.value = item.kanji || '';
      kIn.placeholder = 'Front card (Kanji)';
      kIn.className = 'md-vocab-input jp-text';
      kIn.addEventListener('input', () => {
        item.kanji = kIn.value.trim() || item.kanji;
        kanjiSpan.textContent = item.kanji;
        persistSavedVocabState();
        syncSavedVocabIndicatorsInPlace();
      });

      const rIn = document.createElement('input');
      rIn.type = 'text';
      rIn.value = item.romaji || '';
      rIn.placeholder = 'Back card (Romaji)';
      rIn.className = 'md-vocab-input';
      rIn.addEventListener('input', () => {
        item.romaji = rIn.value;
        persistSavedVocabState();
      });

      const mIn = document.createElement('input');
      mIn.type = 'text';
      mIn.value = item.meaning || '';
      mIn.placeholder = 'Back card (English meaning)';
      mIn.className = 'md-vocab-input';
      mIn.addEventListener('input', () => {
        item.meaning = mIn.value;
        persistSavedVocabState();
      });

      editBox.appendChild(kIn);
      editBox.appendChild(rIn);
      editBox.appendChild(mIn);
      card.appendChild(editBox);
    } else {
      const backSummary = document.createElement('div');
      backSummary.className = 'text-xs space-y-0.5';

      const romRow = document.createElement('div');
      romRow.className = 'flex items-baseline gap-1.5';
      const romTag = document.createElement('span');
      romTag.className = 'text-[10px] font-semibold uppercase tracking-wide text-indigo-600 shrink-0';
      romTag.textContent = 'Romaji';
      const romTxt = document.createElement('span');
      romTxt.className = 'italic font-medium text-slate-700';
      romTxt.textContent = item.romaji || computeInstantWordRomaji(item.kanji, item.reading) || '—';
      romRow.appendChild(romTag);
      romRow.appendChild(romTxt);

      const meanRow = document.createElement('div');
      meanRow.className = 'flex items-baseline gap-1.5';
      const meanTag = document.createElement('span');
      meanTag.className = 'text-[10px] font-semibold uppercase tracking-wide text-emerald-700 shrink-0';
      meanTag.textContent = 'Meaning';
      const meanTxt = document.createElement('span');
      meanTxt.className = item.meaning ? 'text-slate-800' : 'text-amber-700 italic';
      meanTxt.textContent = item.meaning || 'Click Edit to add English meaning';
      meanRow.appendChild(meanTag);
      meanRow.appendChild(meanTxt);

      backSummary.appendChild(romRow);
      backSummary.appendChild(meanRow);
      card.appendChild(backSummary);
    }

    listWrap.appendChild(card);
  });

  el.panelSavedVocab.appendChild(listWrap);
  el.panelSavedVocab.scrollTop = prevScroll;
}

function renderRightPanel() {
  const page = getSelectedPage();
  const bubbleCount = page && page.blocks ? page.blocks.length : 0;
  el.currentBubbleCountBadge.textContent = String(bubbleCount);

  const allReviewItems = collectAllLowConfidenceItems();
  const volReviewCount = allReviewItems.length;
  const pageReviewCount = page ? countPageReviewBlocks(page) : 0;
  const flaggedPageIds = new Set(allReviewItems.map((it) => it.page.id));
  const flaggedPagesCount = flaggedPageIds.size;
  const anyExtracted = state.pages.some(
    (p) => p.status === 'done' || p.ocrCompleted || (p.blocks || []).some((b) => b.ocrAttempted || Boolean((b.text || '').trim()))
  );
  syncSidebarReviewFilterPill();

  if (el.lowConfTabBadge) {
    el.lowConfTabBadge.classList.toggle('hidden', pageReviewCount === 0);
    el.lowConfTabBadge.textContent = '⚠ ' + pageReviewCount;
  }
  if (el.reviewQueueCountBadge) {
    if (volReviewCount > 0) {
      el.reviewQueueCountBadge.textContent = '⚠ ' + volReviewCount;
      el.reviewQueueCountBadge.className = 'px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500 text-white tabular-nums leading-none';
    } else if (anyExtracted) {
      el.reviewQueueCountBadge.textContent = '✓ 0';
      el.reviewQueueCountBadge.className = 'px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 tabular-nums leading-none';
    } else {
      el.reviewQueueCountBadge.textContent = '0';
      el.reviewQueueCountBadge.className = 'px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 tabular-nums leading-none';
    }
  }
  if (el.btnToolbarReviewJump) {
    el.btnToolbarReviewJump.classList.toggle('hidden', volReviewCount === 0);
    el.btnToolbarReviewJump.textContent = '⚠ ' + volReviewCount + ' <90%';
    el.btnToolbarReviewJump.title =
      volReviewCount + ' bubble(s) below 90% OCR across ' + flaggedPagesCount + ' page(s) — click to open Review Queue & jump (Shortcut: R / N)';
  }
  if (el.globalReviewBanner) {
    const showGlobalBanner = volReviewCount > 0 && state.activeTab !== 'review' && state.activeTab !== 'vocab';
    el.globalReviewBanner.classList.toggle('hidden', !showGlobalBanner);
    if (el.globalReviewBannerText && volReviewCount > 0) {
      el.globalReviewBannerText.textContent =
        '⚠ ' + volReviewCount + (volReviewCount === 1 ? ' bubble' : ' bubbles') +
        ' <90% OCR across ' + flaggedPagesCount + (flaggedPagesCount === 1 ? ' page' : ' pages');
    }
    if (el.btnBannerOpenReview) {
      el.btnBannerOpenReview.textContent = 'Review All (' + volReviewCount + ')';
    }
  }

  renderReviewQueuePanel(allReviewItems);
  syncSavedVocabIndicatorsInPlace();
  renderSavedVocabPanel();

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
    msg.textContent = 'No speech bubbles detected yet on this page. Click "Extract Page" or "+ Draw Box".';
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

  const topRightStudyBtns = document.createElement('div');
  topRightStudyBtns.className = 'flex flex-wrap items-center gap-1.5 ml-auto';

  const extractedBlocksOnPage = page.blocks.filter((b) => (b.text || '').trim().length > 0);
  const allPageRomajiOpen = extractedBlocksOnPage.length > 0 && extractedBlocksOnPage.every((b) => Boolean(b.showRomaji));
  const allPageInstantVocabOpen = extractedBlocksOnPage.length > 0 && extractedBlocksOnPage.every((b) => Boolean(b.showInstantVocab));

  const btnTogglePageRomajiAll = document.createElement('button');
  btnTogglePageRomajiAll.type = 'button';
  btnTogglePageRomajiAll.disabled = extractedCountOnPage === 0;
  btnTogglePageRomajiAll.className =
    'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-45 disabled:pointer-events-none ' +
    (allPageRomajiOpen
      ? 'border-indigo-300 bg-indigo-100/80 text-indigo-900 hover:bg-indigo-200/70'
      : 'border-slate-200 bg-white text-slate-700 hover:bg-indigo-50');
  btnTogglePageRomajiAll.textContent = allPageRomajiOpen ? 'Hide All Romaji' : 'Romaji All';
  btnTogglePageRomajiAll.title = 'Toggle instant offline Hepburn Romaji across all bubbles on this page (0ms, no API key required)';
  btnTogglePageRomajiAll.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const nextVal = !allPageRomajiOpen;
    extractedBlocksOnPage.forEach((b) => {
      b.showRomaji = nextVal;
    });
    renderRightPanel();
  });

  const btnTogglePageInstantVocabAll = document.createElement('button');
  btnTogglePageInstantVocabAll.type = 'button';
  btnTogglePageInstantVocabAll.disabled = extractedCountOnPage === 0;
  btnTogglePageInstantVocabAll.setAttribute('data-page-instant-vocab-all', '1');
  btnTogglePageInstantVocabAll.className =
    'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-45 disabled:pointer-events-none ' +
    (allPageInstantVocabOpen
      ? 'border-teal-400 bg-teal-100/80 text-teal-900 hover:bg-teal-200/70'
      : 'border-slate-200 bg-white text-slate-700 hover:bg-teal-50');
  btnTogglePageInstantVocabAll.textContent = allPageInstantVocabOpen ? 'Hide All Vocab' : 'Instant Vocab All';
  btnTogglePageInstantVocabAll.title = 'Toggle instant offline JMdict + Kuromoji vocabulary breakdown across all bubbles on this page (0ms, no API key)';
  btnTogglePageInstantVocabAll.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const nextVal = !allPageInstantVocabOpen;
    extractedBlocksOnPage.forEach((b) => {
      b.showInstantVocab = nextVal;
    });
    renderRightPanel();
  });

  const btnTranslatePageAll = document.createElement('button');
  btnTranslatePageAll.type = 'button';
  btnTranslatePageAll.disabled = extractedCountOnPage === 0 || state.gemini.isTranslatingPage;
  btnTranslatePageAll.className =
    'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-45 disabled:pointer-events-none transition shadow-sm';
  btnTranslatePageAll.textContent = state.gemini.isTranslatingPage
    ? 'Translating Page…'
    : 'Translate Page: EN + Romaji (' + extractedCountOnPage + ')';
  btnTranslatePageAll.title = 'Translate all extracted bubbles on this page into English in one Gemini request';
  btnTranslatePageAll.addEventListener('click', (ev) => {
    ev.stopPropagation();
    requestPageBatchTranslation(page);
  });

  topRightStudyBtns.appendChild(btnTogglePageRomajiAll);
  topRightStudyBtns.appendChild(btnTogglePageInstantVocabAll);
  topRightStudyBtns.appendChild(btnTranslatePageAll);
  studyTopStrip.appendChild(keyBadgeBtn);
  studyTopStrip.appendChild(topRightStudyBtns);
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
    ? page.blocks.map((blk, idx) => ({ blk, idx })).filter(
        (item) => isBlockBelowReviewThreshold(item.blk, page) || item.blk.id === state.selectedBlockId
      )
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
    card.setAttribute('data-needs-review', needsReview ? '1' : '0');
    card.setAttribute('data-selected', isSelected ? 'true' : 'false');
    card.className = getPageBubbleCardClassName(isSelected, needsReview);

    const activateCardSelection = () => {
      state.selectedBlockId = blk.id;
      syncToolbarBoxDeleteBtn();
      if (state.liveTextMode && Boolean((blk.text || '').trim()) && typeof openLiveBubblePopup === 'function') {
        openLiveBubblePopup(blk.id, { preserveTab: true, skipRightRender: true, skipRightScroll: true });
      }
      renderOverlayBoxes();
      syncSelectedBubbleCardInPlace(blk.id, { scrollCard: false });
      scrollViewportToBlockIfNeeded(page, blk);
    };

    card.addEventListener('click', (ev) => {
      if (ev.target.closest('button, textarea, input, select, a')) return;
      activateCardSelection();
    });

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-2 mb-1.5';

    const leftBadge = document.createElement('div');
    leftBadge.className = 'flex items-center flex-wrap gap-1.5 cursor-pointer';
    const pill = document.createElement('span');
    pill.setAttribute('data-bubble-pill', '1');
    pill.className = getPageBubblePillClassName(isSelected, needsReview);
    pill.textContent = '#' + (idx + 1);

    const confSpan = document.createElement('span');
    const dispPct = formatOcrConfPercent(blk.charConf);
    if (blk.verified) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200';
      const rawPct = dispPct !== null ? ' (' + dispPct + '%)' : '';
      confSpan.textContent = '✓ Verified' + rawPct;
    } else if (needsReview) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-200/90 text-amber-950 border border-amber-400';
      const hasTxt = Boolean((blk.text || '').trim());
      const pctStr = dispPct !== null && (hasTxt || dispPct > 0)
        ? (dispPct + '% OCR')
        : (hasTxt ? '<90% OCR' : 'Empty OCR');
      confSpan.textContent = '⚠ ' + pctStr + ' · Needs Review (<90%)';
    } else if (dispPct !== null) {
      confSpan.className = 'px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200';
      confSpan.textContent = dispPct + '% OCR';
    } else {
      confSpan.className = 'text-[11px] text-slate-500';
      confSpan.textContent = (blk.x2 - blk.x1) + '×' + (blk.y2 - blk.y1) + ' px';
    }
    leftBadge.appendChild(pill);
    leftBadge.appendChild(confSpan);
    leftBadge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      activateCardSelection();
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
        blk.charConf = normalizeConf01(res.charConf);
        blk.ocrAttempted = true;
        blk.verified = false;
        page.status = 'done';
        page.ocrCompleted = true;
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
    const onBubbleTextareaInteract = () => {
      const changed = state.selectedBlockId !== blk.id;
      state.selectedBlockId = blk.id;
      syncToolbarBoxDeleteBtn();
      if (state.liveTextMode && state.livePopupBlockId && state.livePopupBlockId !== blk.id) {
        state.livePopupBlockId = null;
        if (el.liveSelectionCard) el.liveSelectionCard.classList.add('hidden');
      }
      renderOverlayBoxes();
      syncSelectedBubbleCardInPlace(blk.id, { scrollCard: false });
      if (changed) {
        scrollViewportToBlockIfNeeded(page, blk);
      }
    };
    ta.addEventListener('focus', onBubbleTextareaInteract);
    ta.addEventListener('select', onBubbleTextareaInteract);
    let inlineRomValEl = null;
    ta.addEventListener('input', () => {
      blk.text = ta.value;
      updatePageFullText(page);
      el.fullMangaTextarea.value = buildCombinedMangaTranscript();
      if (inlineRomValEl && typeof convertJapaneseToRomajiInstant === 'function') {
        const nextJp = (blk.text || '').trim();
        inlineRomValEl.textContent = nextJp ? convertJapaneseToRomajiInstant(nextJp).romaji : '';
      }
    });

    card.appendChild(header);
    card.appendChild(ta);

    // Per-Bubble Instant Offline Romaji, Gemini English Translation & Vocab/Grammar Breakdown Controls
    const jpTrimmed = (blk.text || '').trim();
    const hasExtractedJp = jpTrimmed.length > 0;
    const activeTask = state.gemini.activeTasks.get(blk.id) || null;
    const study = blk.study || null;
    const isStale = Boolean(study && study.sourceText && study.sourceText !== jpTrimmed);
    const hasTrans = Boolean(study && study.english);
    const hasBreakdown = Boolean(study && study.breakdown && (
      (Array.isArray(study.breakdown.vocab) && study.breakdown.vocab.length > 0) ||
      (Array.isArray(study.breakdown.grammar) && study.breakdown.grammar.length > 0)
    ));
    const showInstantRomaji = Boolean(blk.showRomaji) && hasExtractedJp;
    const showInstantVocab = Boolean(blk.showInstantVocab) && hasExtractedJp;

    const studyBar = document.createElement('div');
    studyBar.className = 'mt-2 flex flex-wrap items-center justify-between gap-1.5';

    const leftStudyBtns = document.createElement('div');
    leftStudyBtns.className = 'flex flex-wrap items-center gap-1.5';

    const btnInstantRomaji = document.createElement('button');
    btnInstantRomaji.type = 'button';
    btnInstantRomaji.disabled = !hasExtractedJp;
    btnInstantRomaji.setAttribute('data-bubble-romaji-toggle', '1');
    btnInstantRomaji.setAttribute('aria-pressed', showInstantRomaji ? 'true' : 'false');
    btnInstantRomaji.className =
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (showInstantRomaji
        ? 'border-indigo-300 bg-indigo-100/80 text-indigo-900 hover:bg-indigo-200/70'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-indigo-50');
    btnInstantRomaji.textContent = showInstantRomaji ? 'Hide Romaji' : 'Romaji';
    btnInstantRomaji.title = 'Toggle instant offline Hepburn Romaji for this bubble (0ms, no API key needed)';
    btnInstantRomaji.addEventListener('click', (ev) => {
      ev.stopPropagation();
      blk.showRomaji = !blk.showRomaji;
      renderRightPanel();
    });

    const isCombinedOpen = Boolean(hasBreakdown && !isStale && study.showBreakdown);
    const btnBreakdown = document.createElement('button');
    btnBreakdown.type = 'button';
    btnBreakdown.disabled = !hasExtractedJp || Boolean(activeTask);
    btnBreakdown.setAttribute('data-bubble-study-btn', '1');
    btnBreakdown.setAttribute('aria-pressed', isCombinedOpen ? 'true' : 'false');
    btnBreakdown.className =
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (isCombinedOpen
        ? 'border-emerald-300 bg-emerald-100/80 text-emerald-900 hover:bg-emerald-200/70'
        : 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50');
    if (activeTask) {
      btnBreakdown.textContent = 'Analyzing…';
    } else if (hasBreakdown && !isStale) {
      btnBreakdown.textContent = isCombinedOpen
        ? 'Hide Study'
        : 'Show Study';
    } else {
      btnBreakdown.textContent = 'EN + Romaji + Vocab & Grammar';
    }
    btnBreakdown.title = 'Translate into English + verified Romaji and break down Japanese vocabulary & grammar in one Gemini request';
    btnBreakdown.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (hasBreakdown && !isStale) {
        const nextOpen = !isCombinedOpen;
        blk.study.showTranslation = nextOpen;
        blk.study.showBreakdown = nextOpen;
        notifyStudyViewsUpdated(blk.id);
      } else {
        requestBubbleBreakdown(page, blk, isStale);
      }
    });

    const batchIdxOnCard = getBlockBatchOrderIndex(blk.id);
    const isQueuedOnCard = batchIdxOnCard >= 0;
    const btnBatchCard = document.createElement('button');
    btnBatchCard.type = 'button';
    btnBatchCard.disabled = !hasExtractedJp;
    btnBatchCard.setAttribute('data-bubble-batch-btn', '1');
    btnBatchCard.className =
      'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (isQueuedOnCard
        ? 'border-teal-400 bg-teal-100/80 text-teal-900 hover:bg-teal-200/70'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-teal-50');
    btnBatchCard.textContent = isQueuedOnCard ? ('#' + (batchIdxOnCard + 1) + ' Batch') : '+ Batch';
    btnBatchCard.title = isQueuedOnCard
      ? ('Bubble is #' + (batchIdxOnCard + 1) + ' in your cross-page Batch Queue — click to remove')
      : 'Add this bubble to your ordered cross-page Batch Study queue';
    btnBatchCard.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleBlockInBatchQueue(page.id, blk.id);
    });

    const btnInstantVocab = document.createElement('button');
    btnInstantVocab.type = 'button';
    btnInstantVocab.disabled = !hasExtractedJp;
    btnInstantVocab.setAttribute('data-bubble-instant-vocab-toggle', '1');
    btnInstantVocab.setAttribute('aria-pressed', showInstantVocab ? 'true' : 'false');
    btnInstantVocab.className =
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition disabled:opacity-40 disabled:pointer-events-none ' +
      (showInstantVocab
        ? 'border-teal-400 bg-teal-100/80 text-teal-900 hover:bg-teal-200/70'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-teal-50');
    btnInstantVocab.textContent = showInstantVocab ? 'Hide Vocab' : 'Instant Vocab';
    btnInstantVocab.title = 'Toggle instant offline JMdict + Kuromoji vocabulary breakdown (0ms, no API key required)';
    btnInstantVocab.addEventListener('click', (ev) => {
      ev.stopPropagation();
      blk.showInstantVocab = !blk.showInstantVocab;
      renderRightPanel();
    });

    leftStudyBtns.appendChild(btnInstantRomaji);
    leftStudyBtns.appendChild(btnInstantVocab);
    leftStudyBtns.appendChild(btnBreakdown);
    leftStudyBtns.appendChild(btnBatchCard);

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
        ? 'Japanese text changed — click to re-run Gemini English + Vocab & Grammar'
        : 'Re-generate English translation & vocabulary/grammar breakdown';
      btnRefreshStudy.addEventListener('click', (ev) => {
        ev.stopPropagation();
        requestBubbleBreakdown(page, blk, true);
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

    // Render Instant Offline Romaji Box (when toggled on for this bubble)
    if (showInstantRomaji && typeof convertJapaneseToRomajiInstant === 'function') {
      const romBox = document.createElement('div');
      romBox.setAttribute('data-bubble-romaji-box', '1');
      romBox.className = 'mt-2 rounded-lg border border-indigo-200/80 bg-indigo-50/50 px-2.5 py-2 text-xs';

      const romRow = document.createElement('div');
      romRow.className = 'flex items-start justify-between gap-2';
      const romTextWrap = document.createElement('div');
      romTextWrap.className = 'min-w-0 flex-1';
      const romLabel = document.createElement('span');
      romLabel.className = 'inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-700 mr-1.5';

      const romRes = convertJapaneseToRomajiInstant(jpTrimmed, () => {
        if (blk.showRomaji && state.selectedPageId === page.id) {
          renderRightPanel();
        }
      });
      romLabel.textContent = romRes.ready ? 'Offline Romaji' : 'Offline Romaji…';

      const romVal = document.createElement('span');
      romVal.className = 'font-medium text-slate-800 break-words';
      romVal.textContent = romRes.romaji;
      inlineRomValEl = romVal;

      romTextWrap.appendChild(romLabel);
      romTextWrap.appendChild(romVal);

      const btnCopyRom = document.createElement('button');
      btnCopyRom.type = 'button';
      btnCopyRom.className = 'text-[10px] font-medium text-slate-500 hover:text-indigo-700 shrink-0';
      btnCopyRom.textContent = 'Copy';
      btnCopyRom.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafe(romVal.textContent || '', 'Copied Romaji!');
      });

      romRow.appendChild(romTextWrap);
      romRow.appendChild(btnCopyRom);
      romBox.appendChild(romRow);
      card.appendChild(romBox);
    }

    // Render Instant Offline Vocabulary Breakdown Box (when toggled on for this bubble)
    if (showInstantVocab && typeof analyzeJapaneseVocabInstant === 'function') {
      const ivBox = document.createElement('div');
      ivBox.setAttribute('data-bubble-instant-vocab-box', '1');
      ivBox.className = 'mt-2 rounded-lg border border-teal-200 bg-teal-50/40 p-2.5 space-y-1.5 text-xs';

      const ivRes = analyzeJapaneseVocabInstant(jpTrimmed, () => {
        if (blk.showInstantVocab && state.selectedPageId === page.id) {
          renderRightPanel();
        }
      });

      const ivVocab = Array.isArray(ivRes.vocab) ? ivRes.vocab : [];
      const contentOnly = ivVocab.filter((v) => !v.isParticle);
      const saveTargetList = contentOnly.length > 0 ? contentOnly : ivVocab;
      const ivMeta = {
        contextJp: jpTrimmed,
        pageId: page.id,
        pageName: page.name,
        bubbleIndex: idx + 1,
        blockId: blk.id
      };

      const ivHead = document.createElement('div');
      ivHead.className = 'flex items-center justify-between gap-2';
      const ivLbl = document.createElement('span');
      ivLbl.className = 'text-[10px] font-bold uppercase tracking-wider text-teal-800';
      ivLbl.textContent = 'Instant Vocab · ' + ivRes.dictSource;
      ivHead.appendChild(ivLbl);

      if (saveTargetList.length > 0) {
        const allIvKeys = saveTargetList.map((v) => normalizeVocabMatchKey(v)).filter(Boolean).join('|');
        const allIvSaved = saveTargetList.every((v) => isVocabItemSaved(v));
        const btnSaveAllIv = document.createElement('button');
        btnSaveAllIv.type = 'button';
        btnSaveAllIv.setAttribute('data-vocab-save-all-keys', allIvKeys);
        btnSaveAllIv.className = 'md-vocab-save-btn' + (allIvSaved ? ' is-saved' : '');
        btnSaveAllIv.textContent = allIvSaved ? '✓ All Saved' : ('+ Save All (' + saveTargetList.length + ')');
        btnSaveAllIv.addEventListener('click', (ev) => {
          ev.stopPropagation();
          saveAllVocabFromList(saveTargetList, ivMeta);
        });
        ivHead.appendChild(btnSaveAllIv);
      }
      ivBox.appendChild(ivHead);

      const ivList = document.createElement('div');
      ivList.className = 'space-y-1';
      ivVocab.forEach((v) => {
        const row = document.createElement('div');
        row.className = 'rounded-md bg-white border border-slate-200 px-2 py-1.5 flex flex-col gap-0.5';

        const top = document.createElement('div');
        top.className = 'flex flex-wrap items-center justify-between gap-1';

        const leftW = document.createElement('div');
        leftW.className = 'flex flex-wrap items-baseline gap-1.5';
        const surfEl = document.createElement('span');
        surfEl.className = 'jp-text font-bold text-slate-900 text-xs';
        surfEl.textContent = v.surface || '';
        leftW.appendChild(surfEl);

        if (v.reading && v.reading !== v.surface) {
          const rdEl = document.createElement('span');
          rdEl.className = 'jp-text text-[11px] text-indigo-700 font-medium';
          rdEl.textContent = '【' + v.reading + '】';
          leftW.appendChild(rdEl);
        }
        if (v.romaji) {
          const rmEl = document.createElement('span');
          rmEl.className = 'italic text-[11px] text-slate-500';
          rmEl.textContent = v.romaji;
          leftW.appendChild(rmEl);
        }
        if (v.dictForm && v.dictForm !== v.surface) {
          const dfEl = document.createElement('span');
          dfEl.className = 'jp-text text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded';
          dfEl.textContent = 'dict: ' + v.dictForm;
          leftW.appendChild(dfEl);
        }
        top.appendChild(leftW);

        const rightTags = document.createElement('div');
        rightTags.className = 'flex items-center gap-1 ml-auto shrink-0';
        if (v.pos) {
          const posEl = document.createElement('span');
          posEl.className = 'px-1.5 py-0.2 rounded bg-teal-100/80 text-teal-900 text-[10px] font-semibold shrink-0';
          posEl.textContent = v.pos;
          rightTags.appendChild(posEl);
        }
        const vKey = normalizeVocabMatchKey(v);
        const savedNow = isVocabItemSaved(v);
        const btnSv = document.createElement('button');
        btnSv.type = 'button';
        btnSv.setAttribute('data-vocab-save-btn', '1');
        btnSv.setAttribute('data-vocab-save-key', vKey);
        btnSv.setAttribute('aria-pressed', savedNow ? 'true' : 'false');
        btnSv.className = 'md-vocab-save-btn' + (savedNow ? ' is-saved' : '');
        btnSv.textContent = savedNow ? '✓ Saved' : '+ Save';
        btnSv.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleSaveVocabItem(v, ivMeta);
        });
        rightTags.appendChild(btnSv);
        top.appendChild(rightTags);

        const meanEl = document.createElement('p');
        meanEl.className = 'text-[11px] text-slate-700 leading-snug';
        meanEl.textContent = v.meaning || '';

        row.appendChild(top);
        row.appendChild(meanEl);
        ivList.appendChild(row);
      });

      ivBox.appendChild(ivList);
      card.appendChild(ivBox);
    }

    // Render English + Verified Romaji Translation Box
    if (hasTrans && study.showTranslation !== false) {
      const transBox = document.createElement('div');
      transBox.setAttribute('data-bubble-english-box', '1');
      transBox.className = 'mt-2 rounded-lg border border-indigo-200/80 bg-white p-2.5 space-y-1.5 text-xs';

      if (study.romaji && study.romaji.trim()) {
        const aiRomRow = document.createElement('div');
        aiRomRow.setAttribute('data-bubble-study-romaji', '1');
        aiRomRow.className = 'flex items-start justify-between gap-2 pb-1.5 border-b border-slate-100';
        const aiRomWrap = document.createElement('div');
        aiRomWrap.className = 'min-w-0 flex-1';
        const aiRomLbl = document.createElement('span');
        aiRomLbl.className = 'inline-block text-[10px] font-bold uppercase tracking-wider text-indigo-700 mr-1.5';
        aiRomLbl.textContent = 'Romaji (Check)';
        const aiRomVal = document.createElement('span');
        aiRomVal.className = 'italic font-medium text-slate-800 break-words';
        aiRomVal.textContent = study.romaji.trim();
        aiRomWrap.appendChild(aiRomLbl);
        aiRomWrap.appendChild(aiRomVal);

        const btnCopyAiRom = document.createElement('button');
        btnCopyAiRom.type = 'button';
        btnCopyAiRom.className = 'text-[10px] font-medium text-slate-400 hover:text-indigo-700 shrink-0';
        btnCopyAiRom.textContent = 'Copy';
        btnCopyAiRom.addEventListener('click', (ev) => {
          ev.stopPropagation();
          copyTextSafe(study.romaji.trim(), 'Copied verified Romaji!');
        });

        aiRomRow.appendChild(aiRomWrap);
        aiRomRow.appendChild(btnCopyAiRom);
        transBox.appendChild(aiRomRow);
      }

      const enRow = document.createElement('div');
      enRow.className = 'flex items-start justify-between gap-2';
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
      btnCopyEn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafe(study.english, 'Copied English translation!');
      });

      enRow.appendChild(enTextWrap);
      enRow.appendChild(btnCopyEn);
      transBox.appendChild(enRow);

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
        const bubbleMeta = {
          contextJp: jpTrimmed,
          pageId: page.id,
          pageName: page.name,
          bubbleIndex: idx + 1,
          blockId: blk.id
        };
        const vSec = document.createElement('div');
        vSec.className = 'space-y-1.5';
        const vHeadRow = document.createElement('div');
        vHeadRow.className = 'flex items-center justify-between gap-2';
        const vTitle = document.createElement('div');
        vTitle.className = 'text-[10px] font-bold uppercase tracking-wider text-emerald-800';
        vTitle.textContent = 'Vocabulary & Word Readings';

        const allKeysJoined = vocabList.map((v) => normalizeVocabMatchKey(v)).filter(Boolean).join('|');
        const allSavedHere = vocabList.every((v) => isVocabItemSaved(v));
        const btnSaveAllVocab = document.createElement('button');
        btnSaveAllVocab.type = 'button';
        btnSaveAllVocab.setAttribute('data-vocab-save-all-keys', allKeysJoined);
        btnSaveAllVocab.className = 'md-vocab-save-btn' + (allSavedHere ? ' is-saved' : '');
        btnSaveAllVocab.textContent = allSavedHere ? '✓ All Saved' : ('+ Save All (' + vocabList.length + ')');
        btnSaveAllVocab.title = 'Save all vocabulary words in this speech bubble to your Vocabulary deck';
        btnSaveAllVocab.addEventListener('click', (ev) => {
          ev.stopPropagation();
          saveAllVocabFromList(vocabList, bubbleMeta);
        });

        vHeadRow.appendChild(vTitle);
        vHeadRow.appendChild(btnSaveAllVocab);
        vSec.appendChild(vHeadRow);

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

          const rightTags = document.createElement('div');
          rightTags.className = 'flex items-center gap-1 ml-auto shrink-0';
          if (v.pos) {
            const posPill = document.createElement('span');
            posPill.className = 'px-1.5 py-0.2 rounded bg-emerald-100/80 text-emerald-900 text-[10px] font-semibold shrink-0';
            posPill.textContent = v.pos;
            rightTags.appendChild(posPill);
          }

          const vKey = normalizeVocabMatchKey(v);
          const savedNow = isVocabItemSaved(v);
          const btnSaveVocab = document.createElement('button');
          btnSaveVocab.type = 'button';
          btnSaveVocab.setAttribute('data-vocab-save-btn', '1');
          btnSaveVocab.setAttribute('data-vocab-save-key', vKey);
          btnSaveVocab.setAttribute('aria-pressed', savedNow ? 'true' : 'false');
          btnSaveVocab.className = 'md-vocab-save-btn' + (savedNow ? ' is-saved' : '');
          btnSaveVocab.textContent = savedNow ? '✓ Saved' : '+ Save';
          btnSaveVocab.title = savedNow
            ? 'Saved to your Anki Vocabulary list — click to remove'
            : 'Save this vocabulary word for review & Anki deck export';
          btnSaveVocab.addEventListener('click', (ev) => {
            ev.stopPropagation();
            toggleSaveVocabItem(v, bubbleMeta);
          });
          rightTags.appendChild(btnSaveVocab);
          topLine.appendChild(rightTags);

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
  if (el.tabBtnSavedVocab) {
    el.tabBtnSavedVocab.className =
      (tab === 'vocab' ? 'md-tab is-active' : 'md-tab') + ' inline-flex items-center gap-1.5';
  }
  el.panelAllText.classList.toggle('hidden', tab !== 'all');
  el.panelPageBubbles.classList.toggle('hidden', tab !== 'bubbles');
  if (el.panelReviewQueue) {
    el.panelReviewQueue.classList.toggle('hidden', tab !== 'review');
  }
  if (el.panelSavedVocab) {
    el.panelSavedVocab.classList.toggle('hidden', tab !== 'vocab');
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  syncTabBarClasses();
  renderRightPanel();
}
