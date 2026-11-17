"use strict";

// -----------------------------------------------------------------------
// Instant Offline Japanese -> Revised Hepburn Romaji Engine
// Powered by Kuromoji.js (MeCab + IPADIC morphological analyzer in browser RAM)
// + Zero-dependency Revised Hepburn phonetic rules & instant cold-start fallback
// -----------------------------------------------------------------------
(function patchKuromojiXhrUrlBug() {
  if (typeof XMLHttpRequest === 'undefined' || XMLHttpRequest.__ankisuruPatched) return;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    let fixedUrl = url;
    if (typeof url === 'string' && url.indexOf('kuromoji') !== -1) {
      fixedUrl = url.replace(/^(https?):\/([^/])/, '$1://$2');
    }
    const args = Array.prototype.slice.call(arguments);
    args[1] = fixedUrl;
    return origOpen.apply(this, args);
  };
  XMLHttpRequest.__ankisuruPatched = true;
})();

const HEPBURN_DIGRAPHS = {
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'しぇ': 'she',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'ちぇ': 'che',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
  'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
  'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'じゃ': 'ja',  'じゅ': 'ju',  'じょ': 'jo',  'じぇ': 'je',
  'ぢゃ': 'ja',  'ぢゅ': 'ju',  'ぢょ': 'jo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
  'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
  'ふぁ': 'fa',  'ふぃ': 'fi',  'ふぇ': 'fe',  'ふぉ': 'fo', 'ふゅ': 'fyu',
  'てぃ': 'ti',  'でぃ': 'di',  'とぅ': 'tu',  'どぅ': 'du', 'てゅ': 'tyu', 'でゅ': 'dyu',
  'うぃ': 'wi',  'うぇ': 'we',  'うぉ': 'wo',
  'ゔぁ': 'va',  'ゔぃ': 'vi',  'ゔぇ': 've',  'ゔぉ': 'vo', 'ゔゅ': 'vyu',
  'つぁ': 'tsa', 'つぃ': 'tsi', 'つぇ': 'tse', 'つぉ': 'tso'
};

const HEPBURN_MONOGRAPHS = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo', 'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ゎ': 'wa',
  'ん': 'n', 'ゔ': 'vu',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  '。': '. ', '、': ', ', '！': '!', '？': '?', '…': '...', '・': ' · ',
  '「': '"', '」': '"', '『': '"', '』': '"', '（': '(', '）': ')'
};

// Built-in instant lexicon used during the ~1s cold start before Kuromoji's 160k IPADIC finishes loading
const COLD_START_LEXICON = [
  ['当たり前', 'あたりまえ'], ['放課後', 'ほうかご'], ['第一話', 'だいいちわ'],
  ['本当に', 'ほんとうに'], ['珍しい', 'めずらしい'], ['静かに', 'しずかに'],
  ['静かな', 'しずかな'], ['冷たい', 'つめたい'], ['階段', 'かいだん'],
  ['時間', 'じかん'], ['神社', 'じんじゃ'], ['昨日', 'きのう'], ['地図', 'ちず'],
  ['答え', 'こたえ'], ['読める', 'よめる'], ['調べた', 'しらべた'], ['吹いた', 'ふいた'],
  ['行こう', 'いこう'], ['急ごう', 'いそごう'], ['古い', 'ふるい'], ['誰か', 'だれか'],
  ['駅', 'えき'], ['裏', 'うら'], ['上', 'うえ'], ['風', 'かぜ'], ['私', 'わたし'],
  ['俺', 'おれ'], ['僕', 'ぼく'], ['君', 'きみ'], ['何', 'なに'], ['今', 'いま'],
  ['今日', 'きょう'], ['明日', 'あした'], ['人', 'ひと'], ['見', 'み'], ['行', 'い']
];

const offlineRomajiRuntime = {
  tokenizer: null,
  loadingPromise: null,
  failed: false,
  cache: new Map(),
  onReadyListeners: new Set()
};

function kataToHiraStr(str) {
  return String(str || '').replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function normalizeFullWidthChars(str) {
  return String(str || '').replace(/[\uFF01-\uFF5E]/g, (ch) => {
    const ascii = String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    if (ascii === '!') return '！';
    if (ascii === '?') return '？';
    return ascii;
  });
}

function kanaToRevisedHepburn(kanaStr, applyOuMacron) {
  const hira = kataToHiraStr(normalizeFullWidthChars(kanaStr));
  let out = '';
  let i = 0;
  while (i < hira.length) {
    const ch = hira[i];
    const next = hira[i + 1] || '';

    if (ch === 'っ') {
      if (!next) {
        i++;
        continue;
      }
      const pairAfter = next + (hira[i + 2] || '');
      const nextRom = HEPBURN_DIGRAPHS[pairAfter] || HEPBURN_MONOGRAPHS[next] || '';
      if (nextRom.startsWith('ch')) {
        out += 't';
      } else if (nextRom && /^[bcdfghjklmnpqrstvwxyz]/.test(nextRom)) {
        out += nextRom[0];
      }
      i++;
      continue;
    }

    if (ch === 'ー') {
      const last = out.slice(-1);
      const macrons = { a: 'ā', i: 'ī', u: 'ū', e: 'ē', o: 'ō' };
      if (macrons[last]) {
        out = out.slice(0, -1) + macrons[last];
      }
      i++;
      continue;
    }

    if (ch === 'ん') {
      const pairAfter = next + (hira[i + 2] || '');
      const nextRom = HEPBURN_DIGRAPHS[pairAfter] || HEPBURN_MONOGRAPHS[next] || '';
      out += (nextRom && /^[aiueoy]/.test(nextRom)) ? "n'" : 'n';
      i++;
      continue;
    }

    const pair = ch + next;
    if (next && HEPBURN_DIGRAPHS[pair]) {
      out += HEPBURN_DIGRAPHS[pair];
      i += 2;
      continue;
    }

    if (HEPBURN_MONOGRAPHS[ch] !== undefined) {
      out += HEPBURN_MONOGRAPHS[ch];
    } else {
      out += ch;
    }
    i++;
  }

  if (applyOuMacron !== false) {
    out = out.replace(/oo/g, 'ō').replace(/ou/g, 'ō').replace(/uu/g, 'ū');
  }
  return out;
}

function kuromojiTokensToHepburn(tokens) {
  const pieces = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const surf = t.surface_form || '';
    if (!surf.trim()) continue;
    const pos = t.pos || '';
    const pos1 = t.pos_detail_1 || '';
    let reading = (t.reading && t.reading !== '*') ? t.reading : surf;

    if (pos === '助詞') {
      if (surf === 'は') reading = 'ワ';
      else if (surf === 'へ') reading = 'エ';
      else if (surf === 'を') reading = 'ヲ';
    }

    const isDictUverb = (
      pos === '動詞' &&
      surf.endsWith('う') &&
      !/[おこそとのほもよろ]う$/.test(surf)
    );
    const rom = kanaToRevisedHepburn(reading, !isDictUverb);
    const isPunct = pos === '記号' || /^[.,!?…"()·\s]+$/.test(rom);

    const prev = pieces.length > 0 ? pieces[pieces.length - 1] : null;
    const attachToPrev = isPunct ||
      (prev && !prev.isPunct && (
        pos === '助動詞' ||
        pos1 === '接尾' ||
        (pos === '動詞' && pos1 === '非自立' && (surf === 'てる' || surf === 'でる')) ||
        (pos === '助詞' && pos1 === '接続助詞' && (surf === 'て' || surf === 'で' || surf === 'ちゃ' || surf === 'じゃ'))
      ));

    if (attachToPrev && prev) {
      if (pos === '助動詞' && (surf === 'う' || surf === 'よう') && prev.text.endsWith('o') && rom === 'u') {
        prev.text = prev.text.slice(0, -1) + 'ō';
      } else {
        prev.text += rom;
      }
      prev.isPunct = isPunct;
    } else {
      pieces.push({ text: rom, isPunct });
    }
  }
  return pieces
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+([.,!?…")])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildKuromojiWithDicPath(dicPath) {
  return new Promise((resolve, reject) => {
    if (!window.kuromoji || typeof window.kuromoji.builder !== 'function') {
      reject(new Error('kuromoji.js not loaded'));
      return;
    }
    window.kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err || !tokenizer) reject(err || new Error('Tokenizer build failed'));
      else resolve(tokenizer);
    });
  });
}

function ensureOfflineRomajiEngine(onReadyCallback) {
  if (typeof onReadyCallback === 'function') {
    if (offlineRomajiRuntime.tokenizer) {
      onReadyCallback(offlineRomajiRuntime.tokenizer);
    } else {
      offlineRomajiRuntime.onReadyListeners.add(onReadyCallback);
    }
  }
  if (offlineRomajiRuntime.tokenizer) {
    return Promise.resolve(offlineRomajiRuntime.tokenizer);
  }
  if (offlineRomajiRuntime.loadingPromise) {
    return offlineRomajiRuntime.loadingPromise;
  }

  offlineRomajiRuntime.loadingPromise = (async () => {
    const cdnDicPath = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
    const useLocalServerDict = Boolean(
      state.nativeBackend &&
      state.nativeBackend.connected &&
      state.nativeBackend.url
    );
    try {
      let tok = null;
      if (useLocalServerDict) {
        try {
          tok = await buildKuromojiWithDicPath(state.nativeBackend.url.replace(/\/+$/, '') + '/kuromoji_dict/');
        } catch (_localErr) {
          tok = null;
        }
      }
      if (!tok) {
        tok = await buildKuromojiWithDicPath(cdnDicPath);
      }
      offlineRomajiRuntime.tokenizer = tok;
      offlineRomajiRuntime.cache.clear();
      const listeners = Array.from(offlineRomajiRuntime.onReadyListeners);
      offlineRomajiRuntime.onReadyListeners.clear();
      listeners.forEach((fn) => {
        try { fn(tok); } catch (_e) {}
      });
      return tok;
    } catch (_err) {
      offlineRomajiRuntime.failed = true;
      return null;
    } finally {
      offlineRomajiRuntime.loadingPromise = null;
    }
  })();

  return offlineRomajiRuntime.loadingPromise;
}

function convertJapaneseToRomajiInstant(jpText, onUpgraded) {
  const clean = String(jpText || '').trim();
  if (!clean) return { romaji: '', ready: true };

  if (offlineRomajiRuntime.tokenizer) {
    if (offlineRomajiRuntime.cache.has(clean)) {
      return { romaji: offlineRomajiRuntime.cache.get(clean), ready: true };
    }
    const lines = clean.split(/\r?\n/).map((line) => {
      const tokens = offlineRomajiRuntime.tokenizer.tokenize(line);
      return kuromojiTokensToHepburn(tokens);
    });
    const fullRomaji = lines.join('\n');
    offlineRomajiRuntime.cache.set(clean, fullRomaji);
    return { romaji: fullRomaji, ready: true };
  }

  // Trigger background Kuromoji IPADIC load and notify caller the moment full kanji readings are ready
  if (!offlineRomajiRuntime.failed) {
    ensureOfflineRomajiEngine(() => {
      if (typeof onUpgraded === 'function') onUpgraded();
    });
  }

  // Instant 0ms fallback using built-in manga lexicon + pure-JS Revised Hepburn kana converter
  let working = clean;
  for (let i = 0; i < COLD_START_LEXICON.length; i++) {
    const [kanji, hira] = COLD_START_LEXICON[i];
    if (working.indexOf(kanji) !== -1) {
      working = working.split(kanji).join(' ' + hira + ' ');
    }
  }
  const approx = kanaToRevisedHepburn(working, true)
    .replace(/\s+([.,!?…")])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { romaji: approx, ready: offlineRomajiRuntime.failed };
}
