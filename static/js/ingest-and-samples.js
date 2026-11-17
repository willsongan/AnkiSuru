"use strict";

// -----------------------------------------------------------------------
// File & Folder Ingestion (Input + Recursive Directory Drag-and-Drop)
// -----------------------------------------------------------------------
function revokeAllPages() {
  for (const p of state.pages) {
    if (p.isObjectUrl && p.url) {
      try { URL.revokeObjectURL(p.url); } catch (_e) { /* ignore */ }
    }
  }
}

async function ingestFileList(rawFiles) {
  const valid = Array.from(rawFiles || []).filter((f) => {
    if (!f) return false;
    if (f.type && f.type.startsWith('image/')) return true;
    return IMAGE_EXT_RE.test(f.name || '');
  });

  if (valid.length === 0) {
    showToast('No supported manga image files found in selection.', 'warn');
    return;
  }

  // Sort naturally by relative path / filename so page_2.jpg precedes page_10.jpg
  valid.sort((a, b) => {
    const ka = a.webkitRelativePath || a.relativePath || a.name;
    const kb = b.webkitRelativePath || b.relativePath || b.name;
    return naturalCollator.compare(ka, kb);
  });

  // Replace sample pages automatically on first user upload
  if (state.isSampleSet) {
    revokeAllPages();
    state.pages = [];
    state.isSampleSet = false;
  }

  const newPages = new Array(valid.length).fill(null);
  let ingestIdx = 0;
  const ingestConcurrency = Math.min(16, valid.length);

  async function ingestWorker() {
    while (true) {
      const idx = ingestIdx++;
      if (idx >= valid.length) return;
      const file = valid[idx];
      const url = URL.createObjectURL(file);
      let width = 0;
      let height = 0;
      try {
        if (typeof window.createImageBitmap === 'function') {
          const bmp = await window.createImageBitmap(file);
          width = bmp.width;
          height = bmp.height;
          if (typeof bmp.close === 'function') bmp.close();
        } else {
          const im = await loadImageElement(url);
          width = im.naturalWidth || im.width;
          height = im.naturalHeight || im.height;
        }
      } catch (_e) {
        URL.revokeObjectURL(url);
        continue;
      }
      newPages[idx] = {
        id: 'page_' + Math.random().toString(36).slice(2, 10),
        name: file.name,
        relativePath: file.webkitRelativePath || file.relativePath || file.name,
        url,
        rawFile: file,
        isObjectUrl: true,
        width,
        height,
        status: 'pending',
        boxesDetected: false,
        blocks: [],
        fullText: ''
      };
    }
  }

  await Promise.all(Array.from({ length: ingestConcurrency }, () => ingestWorker()));
  const loadedPages = newPages.filter(Boolean);

  if (loadedPages.length === 0) {
    showToast('Could not decode selected image files.', 'error');
    return;
  }

  state.pages.push(...loadedPages);
  state.selectedPageId = loadedPages[0].id;
  state.selectedBlockId = null;
  renderAll();
  showToast('Loaded ' + loadedPages.length + ' manga page(s). Ready to extract!');
}

// Synchronously capture files, FileSystemEntries, and FileSystemHandles BEFORE any await
// (browsers clear DataTransfer.files and DataTransfer.items as soon as the drop callback yields)
function snapshotDataTransferSync(dataTransfer) {
  const directFiles = Array.from((dataTransfer && dataTransfer.files) || []);
  const itemFiles = [];
  const entries = [];
  const handlePromises = [];
  let sawDirectory = false;

  const items = dataTransfer && dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;

      let syncFile = null;
      if (typeof item.getAsFile === 'function') {
        try { syncFile = item.getAsFile(); } catch (_e) { syncFile = null; }
      }
      if (syncFile) itemFiles.push(syncFile);

      if (typeof item.getAsFileSystemHandle === 'function') {
        try {
          handlePromises.push(item.getAsFileSystemHandle().catch(() => null));
        } catch (_e) { /* ignore */ }
      }

      const getEntryFn = item.webkitGetAsEntry || item.getAsEntry;
      if (typeof getEntryFn === 'function') {
        try {
          const entry = getEntryFn.call(item);
          if (entry) {
            if (entry.isDirectory) sawDirectory = true;
            entries.push({ entry, fallbackFile: syncFile });
            continue;
          }
        } catch (_e) { /* ignore */ }
      }

      if (syncFile) {
        entries.push({ entry: null, fallbackFile: syncFile });
      }
    }
  }

  return { directFiles, itemFiles, entries, handlePromises, sawDirectory };
}

async function resolveDroppedSnapshot(snap) {
  const collected = [];

  function withTimeout(promise, ms, fallbackVal) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallbackVal), ms))
    ]);
  }

  async function traverseEntry(entry, prefix, fallbackFile) {
    if (!entry) {
      if (fallbackFile) collected.push(fallbackFile);
      return;
    }
    // Top-level dropped files (like .jpg/.png) already have a synchronous File object
    if (entry.isFile && !prefix && fallbackFile && fallbackFile.size > 0) {
      collected.push(fallbackFile);
      return;
    }
    if (entry.isFile) {
      const file = await withTimeout(new Promise((res) => {
        try {
          entry.file(res, () => res(fallbackFile || null));
        } catch (_e) {
          res(fallbackFile || null);
        }
      }), 900, fallbackFile || null);
      const chosen = file || fallbackFile;
      if (chosen) {
        try {
          Object.defineProperty(chosen, 'relativePath', {
            value: prefix + chosen.name,
            configurable: true
          });
        } catch (_e) { /* ignore */ }
        collected.push(chosen);
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let guard = 0;
      while (guard++ < 200) {
        const batch = await withTimeout(new Promise((res) => {
          try {
            reader.readEntries(res, () => res([]));
          } catch (_e) {
            res([]);
          }
        }), 1200, []);
        if (!batch || batch.length === 0) break;
        for (const child of batch) {
          await traverseEntry(child, prefix + entry.name + '/', null);
        }
      }
    }
  }

  for (const item of snap.entries) {
    await traverseEntry(item.entry, '', item.fallbackFile);
  }

  // Fallback 2: Modern FileSystemHandle API (if webkitGetAsEntry directory reader was restricted)
  if (collected.length === 0 && snap.handlePromises.length > 0) {
    async function traverseHandle(handle, prefix) {
      if (!handle) return;
      if (handle.kind === 'file' && typeof handle.getFile === 'function') {
        try {
          const f = await handle.getFile();
          if (f) {
            try {
              Object.defineProperty(f, 'relativePath', { value: prefix + f.name, configurable: true });
            } catch (_e) { /* ignore */ }
            collected.push(f);
          }
        } catch (_e) { /* ignore */ }
      } else if (handle.kind === 'directory' && typeof handle.values === 'function') {
        snap.sawDirectory = true;
        try {
          for await (const child of handle.values()) {
            await traverseHandle(child, prefix + handle.name + '/');
          }
        } catch (_e) { /* ignore */ }
      }
    }
    const handles = await Promise.all(snap.handlePromises);
    for (const h of handles) {
      await traverseHandle(h, '');
    }
  }

  // Fallback 3: Synchronous File snapshots (always works for dropped .jpg/.png files even in strict iframes)
  if (collected.length === 0) {
    const syncPool = snap.directFiles.length > 0 ? snap.directFiles : snap.itemFiles;
    for (const f of syncPool) {
      if (f && (f.size > 0 || IMAGE_EXT_RE.test(f.name || ''))) {
        collected.push(f);
      }
    }
  }

  return { files: collected, sawDirectory: snap.sawDirectory };
}

// -----------------------------------------------------------------------
// Built-in Crisp Japanese Manga Sample Generator (2 Pages for Instant Test)
// -----------------------------------------------------------------------
function drawVerticalJapaneseLines(ctx, lines, topRightX, topY, fontSize, lineStep, charStep) {
  ctx.save();
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 ' + fontSize + 'px "Noto Sans JP", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let col = 0; col < lines.length; col++) {
    const x = topRightX - col * lineStep;
    const chars = Array.from(lines[col]);
    for (let r = 0; r < chars.length; r++) {
      const ch = chars[r];
      const y = topY + r * charStep;
      if (ch === 'ー' || ch === '…') {
        ctx.save();
        ctx.translate(x, y + charStep * 0.48);
        ctx.rotate(Math.PI / 2);
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(ch, x, y);
      }
    }
  }
  ctx.restore();
}

function drawSpeechOval(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#0f172a';
  ctx.stroke();
  ctx.restore();
}

function createMangaSampleDataUrl(pageNumber) {
  const W = 760;
  const H = 1060;
  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d');

  // Paper base
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  function drawPanel(x, y, w, h, toneDensity) {
    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x, y, w, h);

    // Subtle manga screentone & speed lines kept away from white bubbles
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    ctx.fillStyle = '#94a3b8';
    for (let py = y + 8; py < y + h; py += toneDensity) {
      for (let px = x + 8; px < x + w; px += toneDensity) {
        ctx.fillRect(px, py, 2, 2);
      }
    }

    // Dramatic diagonal speed lines in lower artwork zone
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    for (let i = -w; i < w * 1.5; i += 22) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + 70, y + h * 0.55);
      ctx.stroke();
    }

    // Character silhouette artwork in bottom center of panel
    const scx = x + w * 0.5;
    const scy = y + h * 0.78;
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(scx, scy - 45, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(scx - 62, y + h);
    ctx.quadraticCurveTo(scx, scy - 10, scx + 62, y + h);
    ctx.fill();

    ctx.restore();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#0f172a';
    ctx.strokeRect(x, y, w, h);
  }

  if (pageNumber === 1) {
    // Top panel
    drawPanel(36, 36, 688, 470, 14);

    // Top-right rectangular narration box
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3.5;
    ctx.fillRect(560, 62, 138, 250);
    ctx.strokeRect(560, 62, 138, 250);
    drawVerticalJapaneseLines(ctx, ['第一話', '静かな放課後'], 654, 84, 24, 38, 30);

    // Top-left speech balloon
    drawSpeechOval(ctx, 215, 200, 148, 138);
    drawVerticalJapaneseLines(ctx, ['本当にこの', '古い地図が', '読めるのか？'], 278, 102, 24, 42, 31);

    // Bottom-right panel
    drawPanel(388, 532, 336, 490, 16);
    drawSpeechOval(ctx, 556, 675, 136, 122);
    drawVerticalJapaneseLines(ctx, ['当たり前よ！', '昨日調べたの'], 602, 586, 23, 42, 30);

    // Bottom-left panel
    drawPanel(36, 532, 332, 490, 15);
    drawSpeechOval(ctx, 202, 682, 136, 126);
    drawVerticalJapaneseLines(ctx, ['駅の裏にある', '神社へ行こう'], 246, 590, 23, 42, 30);
  } else {
    // Page 2: Two wide dramatic panels
    drawPanel(36, 36, 688, 480, 15);
    drawSpeechOval(ctx, 555, 195, 138, 128);
    drawVerticalJapaneseLines(ctx, ['階段の上に', '誰かいるぞ！'], 598, 108, 24, 44, 31);

    drawSpeechOval(ctx, 205, 225, 142, 132);
    drawVerticalJapaneseLines(ctx, ['こんな時間に', '珍しいわね…'], 250, 132, 24, 44, 31);

    drawPanel(36, 542, 688, 480, 14);
    // Bottom-right narration box
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3.5;
    ctx.fillRect(520, 572, 174, 256);
    ctx.strokeRect(520, 572, 174, 256);
    drawVerticalJapaneseLines(ctx, ['冷たい風が', '静かに吹いた'], 636, 598, 24, 44, 31);

    // Bottom-left bubble
    drawSpeechOval(ctx, 225, 705, 150, 132);
    drawVerticalJapaneseLines(ctx, ['急ごう！答えは', 'あそこにある'], 272, 608, 23, 44, 30);
  }

  return { url: cvs.toDataURL('image/png'), width: W, height: H };
}

async function loadBuiltInSamples() {
  if (state.isExtracting) return;
  if (document.fonts && document.fonts.ready) {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  }
  revokeAllPages();
  const s1 = createMangaSampleDataUrl(1);
  const s2 = createMangaSampleDataUrl(2);

  state.pages = [
    {
      id: 'sample_p1',
      name: 'sample_chapter_01.png',
      relativePath: 'sample_manga/sample_chapter_01.png',
      url: s1.url,
      isObjectUrl: false,
      width: s1.width,
      height: s1.height,
      status: 'pending',
      blocks: [],
      fullText: ''
    },
    {
      id: 'sample_p2',
      name: 'sample_chapter_02.png',
      relativePath: 'sample_manga/sample_chapter_02.png',
      url: s2.url,
      isObjectUrl: false,
      width: s2.width,
      height: s2.height,
      status: 'pending',
      blocks: [],
      fullText: ''
    }
  ];

  // Pre-detect bubble outlines on sample pages so user immediately sees speech-bubble targeting
  for (const p of state.pages) {
    const im = await loadImageElement(p.url);
    p.blocks = sortBlocksByReadingOrder(detectSpeechBubblesHeuristic(im), state.readingOrder);
    p.boxesDetected = true;
    p.status = 'detected';
  }

  state.isSampleSet = true;
  state.selectedPageId = state.pages[0].id;
  state.selectedBlockId = null;
  renderAll();
}

const SAMPLE_GROUND_TRUTH_BUBBLES = {
  sample_p1: [
    { cx: 629, cy: 187, text: '第一話静かな放課後' },
    { cx: 215, cy: 200, text: '本当にこの古い地図が読めるのか？' },
    { cx: 556, cy: 675, text: '当たり前よ！昨日調べたの' },
    { cx: 202, cy: 682, text: '駅の裏にある神社へ行こう' }
  ],
  sample_p2: [
    { cx: 555, cy: 195, text: '階段の上に誰かいるぞ！' },
    { cx: 205, cy: 225, text: 'こんな時間に珍しいわね…' },
    { cx: 607, cy: 700, text: '冷たい風が静かに吹いた' },
    { cx: 225, cy: 705, text: '急ごう！答えはあそこにある' }
  ]
};

function populateSampleGroundTruthForPage(page) {
  if (!page || !state.isSampleSet || !SAMPLE_GROUND_TRUTH_BUBBLES[page.id]) return false;
  const refs = SAMPLE_GROUND_TRUTH_BUBBLES[page.id];
  let filled = 0;
  (page.blocks || []).forEach((blk) => {
    if ((blk.text || '').trim()) return;
    const bcx = (blk.x1 + blk.x2) * 0.5;
    const bcy = (blk.y1 + blk.y2) * 0.5;
    let best = null;
    let bestDist = Infinity;
    for (const r of refs) {
      const d = Math.hypot(bcx - r.cx, bcy - r.cy);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (best && bestDist < 180) {
      blk.text = best.text;
      blk.charConf = 0.99;
      filled++;
    }
  });
  if (filled > 0) {
    page.status = 'done';
    if (typeof updatePageFullText === 'function') updatePageFullText(page);
  }
  return filled > 0;
}

