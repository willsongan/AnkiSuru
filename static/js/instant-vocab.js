"use strict";

// -----------------------------------------------------------------------
// Instant Zero-Cost Japanese Vocabulary Breakdown Engine
// Architecture:
//   1. Kuromoji.js (MeCab + 160k IPADIC in RAM) morphological tokenizer + compound/conjugation merger
//   2. 10ten / Yomitan-style Japanese verb & adjective de-inflector (instant 0ms cold-start + Godan potential roots)
//   3. OpenJLPT (JMdict-verified N5-N1, 7,811 entries via jsDelivr CDN, cached permanently in IndexedDB)
//   4. Local Server JMdict-Simplified (scriptin/jmdict-simplified EDRDG JMdict SSD cache via /api/jmdict_lookup)
//   5. Built-in Core Manga Vocabulary, Pronouns, Auxiliaries & Particles Lexicon (0ms offline ready)
// -----------------------------------------------------------------------

const OPENJLPT_CDN_BASE = 'https://cdn.jsdelivr.net/gh/evanclan/OpenJLPT@bf4e1ee/data/json/vocab/';
const OPENJLPT_CDN_FALLBACK = 'https://cdn.jsdelivr.net/gh/evanclan/OpenJLPT@main/data/json/vocab/';
const OPENJLPT_IDB_KEY = 'ankisuru_openjlpt_vocab_index_v1';
const OPENJLPT_LEVELS = ['n5', 'n4', 'n3', 'n2', 'n1'];

const JMDICT_POS_LABELS = {
  'v1': 'Ichidan Verb',
  'v1-s': 'Ichidan Verb',
  'v5u': 'Godan Verb',
  'v5u-s': 'Godan Verb',
  'v5k': 'Godan Verb',
  'v5k-s': 'Godan Verb',
  'v5g': 'Godan Verb',
  'v5s': 'Godan Verb',
  'v5t': 'Godan Verb',
  'v5n': 'Godan Verb',
  'v5b': 'Godan Verb',
  'v5m': 'Godan Verb',
  'v5r': 'Godan Verb',
  'v5r-i': 'Godan Verb',
  'v5aru': 'Godan Verb',
  'vk': 'Kuru Verb',
  'vs': 'Suru Verb',
  'vs-i': 'Suru Verb',
  'vs-s': 'Suru Verb',
  'vz': 'Zuru Verb',
  'vi': 'Intransitive',
  'vt': 'Transitive',
  'adj-i': 'I-Adjective',
  'adj-ix': 'I-Adjective',
  'adj-na': 'Na-Adjective',
  'adj-no': 'No-Adjective',
  'adj-pn': 'Pre-noun Adj',
  'adj-t': 'Taru-Adjective',
  'n': 'Noun',
  'n-adv': 'Adverbial Noun',
  'n-t': 'Temporal Noun',
  'n-suf': 'Noun Suffix',
  'n-pref': 'Prefix',
  'pn': 'Pronoun',
  'adv': 'Adverb',
  'adv-to': 'Adverb',
  'prt': 'Particle',
  'conj': 'Conjunction',
  'int': 'Interjection',
  'exp': 'Expression',
  'ctr': 'Counter',
  'num': 'Numeric',
  'pref': 'Prefix',
  'suf': 'Suffix',
  'aux': 'Auxiliary',
  'aux-v': 'Aux Verb',
  'aux-adj': 'Aux Adj',
  'cop': 'Copula'
};

// Built-in 0ms Core Manga Vocabulary, Particles & Colloquialisms ([reading, posLabel, meaning])
const CORE_MANGA_LEXICON = {
  // Manga Dialogue & Sample Vocabulary
  '第一話': ['だいいちわ', 'Expression', 'Chapter 1; Episode 1'],
  '第一': ['だいいち', 'Noun · N3', 'first; number one'],
  '話': ['わ', 'Counter · N5', 'episode; chapter; story'],
  '静か': ['しずか', 'Na-Adjective · N5', 'quiet; silent; peaceful'],
  '静かに': ['しずかに', 'Adverb · N5', 'quietly; calmly; peacefully'],
  '放課後': ['ほうかご', 'Noun · N4', 'after school'],
  '本当': ['ほんとう', 'Noun / Na-Adj · N5', 'truth; reality; real'],
  '本当に': ['ほんとうに', 'Adverb · N5', 'really; truly'],
  'この': ['この', 'Pre-noun Adj · N5', 'this (near speaker)'],
  'その': ['その', 'Pre-noun Adj · N5', 'that (near listener)'],
  'あの': ['あの', 'Pre-noun Adj · N5', 'that (over there)'],
  'どの': ['どの', 'Pre-noun Adj · N5', 'which'],
  'こんな': ['こんな', 'Pre-noun Adj · N4', 'such; like this'],
  'そんな': ['そんな', 'Pre-noun Adj · N4', 'such; like that'],
  'あんな': ['あんな', 'Pre-noun Adj · N4', 'such; like that over there'],
  '古い': ['ふるい', 'I-Adjective · N5', 'old; aged; ancient'],
  '地図': ['ちず', 'Noun · N5', 'map; atlas'],
  '読める': ['よめる', 'Ichidan Verb (Potential) · N4', 'can read; able to read'],
  '読む': ['よむ', 'Godan Verb · N5', 'to read'],
  '当たり前': ['あたりまえ', 'Na-Adj / Noun · N3', 'natural; obvious; of course'],
  '昨日': ['きのう', 'Noun · N5', 'yesterday'],
  '今日': ['きょう', 'Noun · N5', 'today'],
  '明日': ['あした', 'Noun · N5', 'tomorrow'],
  '調べる': ['しらべる', 'Ichidan Verb · N4', 'to check; to look up; to investigate'],
  '駅': ['えき', 'Noun · N5', 'train station'],
  '裏': ['うら', 'Noun · N4', 'back; behind; reverse side'],
  'ある': ['ある', 'Godan Verb · N5', 'to exist; to be (inanimate); to have'],
  '神社': ['じんじゃ', 'Noun · N4', 'Shinto shrine'],
  '行く': ['いく', 'Godan Verb · N5', 'to go; to head towards'],
  '階段': ['かいだん', 'Noun · N5', 'stairs; stairway'],
  '上': ['うえ', 'Noun · N5', 'top; above; on'],
  '下': ['した', 'Noun · N5', 'below; under; bottom'],
  '中': ['なか', 'Noun · N5', 'inside; middle'],
  '前': ['まえ', 'Noun · N5', 'front; before'],
  '後ろ': ['うしろ', 'Noun · N5', 'behind; back'],
  '誰': ['だれ', 'Pronoun · N5', 'who'],
  '誰か': ['だれか', 'Pronoun · N5', 'someone; somebody'],
  '何': ['なに', 'Pronoun · N5', 'what'],
  '何か': ['なにか', 'Pronoun · N5', 'something'],
  'いる': ['いる', 'Ichidan Verb · N5', 'to be; to exist (animate)'],
  '時間': ['じかん', 'Noun · N5', 'time; hour'],
  '珍しい': ['めずらしい', 'I-Adjective · N4', 'rare; unusual; uncommon'],
  '冷たい': ['つめたい', 'I-Adjective · N5', 'cold (to the touch); chilly'],
  '風': ['かぜ', 'Noun · N5', 'wind; breeze'],
  '吹く': ['ふく', 'Godan Verb · N5', 'to blow (wind); to breathe out'],
  '急ぐ': ['いそぐ', 'Godan Verb · N4', 'to hurry; to rush'],
  '答え': ['こたえ', 'Noun · N4', 'answer; solution; reply'],
  '答える': ['こたえる', 'Ichidan Verb · N4', 'to answer; to reply'],
  'あそこ': ['あそこ', 'Pronoun · N5', 'over there; that place'],
  'ここ': ['ここ', 'Pronoun · N5', 'here; this place'],
  'そこ': ['そこ', 'Pronoun · N5', 'there; that place'],
  'どこ': ['どこ', 'Pronoun · N5', 'where; what place'],
  // High-Frequency Manga Pronouns, Verbs & Expressions
  '俺': ['おれ', 'Pronoun · Casual', 'I; me (masculine casual)'],
  '僕': ['ぼく', 'Pronoun · N5', 'I; me (male polite/casual)'],
  '私': ['わたし', 'Pronoun · N5', 'I; me'],
  'あたし': ['あたし', 'Pronoun · Casual', 'I; me (feminine casual)'],
  'お前': ['おまえ', 'Pronoun · Casual', 'you (rough/intimate)'],
  '君': ['きみ', 'Pronoun · N4', 'you (familiar)'],
  'あんた': ['あんた', 'Pronoun · Casual', 'you (colloquial)'],
  'あいつ': ['あいつ', 'Pronoun · Casual', 'that guy/girl; he; she'],
  'こいつ': ['こいつ', 'Pronoun · Casual', 'this guy/girl; this one'],
  'そいつ': ['そいつ', 'Pronoun · Casual', 'that guy/girl'],
  'みんな': ['みんな', 'Pronoun · N5', 'everyone; everybody; all'],
  '見る': ['みる', 'Ichidan Verb · N5', 'to see; to look; to watch'],
  '見える': ['みえる', 'Ichidan Verb · N4', 'to be visible; can see'],
  '聞く': ['きく', 'Godan Verb · N5', 'to hear; to listen; to ask'],
  '聞こえる': ['きこえる', 'Ichidan Verb · N4', 'to be audible; can hear'],
  '言う': ['いう', 'Godan Verb · N5', 'to say; to tell'],
  '思う': ['おもう', 'Godan Verb · N5', 'to think; to feel'],
  '知る': ['しる', 'Godan Verb · N5', 'to know; to find out'],
  '分かる': ['わかる', 'Godan Verb · N5', 'to understand; to grasp'],
  '来る': ['くる', 'Kuru Verb · N5', 'to come; to arrive'],
  'する': ['する', 'Suru Verb · N5', 'to do; to make'],
  'やる': ['やる', 'Godan Verb · N5', 'to do; to give (casual)'],
  'できる': ['できる', 'Ichidan Verb · N5', 'can do; to be ready; to be made'],
  '食べる': ['たべる', 'Ichidan Verb · N5', 'to eat'],
  '飲む': ['のむ', 'Godan Verb · N5', 'to drink; to swallow'],
  '待つ': ['まつ', 'Godan Verb · N5', 'to wait'],
  '持つ': ['もつ', 'Godan Verb · N5', 'to hold; to have; to carry'],
  '帰る': ['かえる', 'Godan Verb · N5', 'to return home; to go back'],
  '出る': ['でる', 'Ichidan Verb · N5', 'to leave; to come out; to appear'],
  '入る': ['はいる', 'Godan Verb · N5', 'to enter; to go in'],
  '使う': ['つかう', 'Godan Verb · N5', 'to use'],
  '作る': ['つくる', 'Godan Verb · N5', 'to make; to create'],
  '우': ['う', 'Auxiliary', 'volitional'],
  '大丈夫': ['だいじょうぶ', 'Na-Adjective · N5', 'all right; okay; safe'],
  '無理': ['むり', 'Na-Adj / Noun · N4', 'impossible; unreasonable; overdoing'],
  '駄目': ['だめ', 'Na-Adj / Noun · N4', 'no good; useless; must not'],
  'だめ': ['だめ', 'Na-Adj / Noun · N4', 'no good; useless; must not'],
  'すごい': ['すごい', 'I-Adjective · N4', 'amazing; incredible; intense'],
  'やばい': ['やばい', 'I-Adjective · Slang', 'crazy; awful; awesome;uh-oh'],
  'ちょっと': ['ちょっと', 'Adverb · N5', 'a little; wait a moment'],
  'もう': ['もう', 'Adverb · N5', 'already; soon; anymore'],
  'まだ': ['まだ', 'Adverb · N5', 'still; not yet'],
  'やっぱり': ['やっぱり', 'Adverb · N3', 'as expected; after all'],
  'やはり': ['やはり', 'Adverb · N3', 'as expected; after all'],
  'どうして': ['どうして', 'Adverb · N5', 'why; how'],
  'なぜ': ['なぜ', 'Adverb · N4', 'why; how come'],
  'なんで': ['なんで', 'Adverb · Casual', 'why; how come'],
  // Core Japanese Particles & Sentence-Enders
  'は': ['わ', 'Particle · N5', 'topic marker ("as for…")'],
  'が': ['が', 'Particle · N5', 'subject marker; "but" (clause end)'],
  'を': ['を', 'Particle · N5', 'direct object marker'],
  'に': ['に', 'Particle · N5', 'at / in / to / target / time marker'],
  'へ': ['え', 'Particle · N5', 'direction marker ("toward; to")'],
  'で': ['で', 'Particle · N5', 'location of action; by means of'],
  'と': ['と', 'Particle · N5', 'with; "and"; quotation marker'],
  'も': ['も', 'Particle · N5', 'also; too; even'],
  'の': ['の', 'Particle · N5', 'possessive ("of"); explanatory sentence-ender'],
  'か': ['か', 'Particle · N5', 'question marker; "or"'],
  'のか': ['のか', 'Particle · N4', 'explanatory question ("is it that…?")'],
  'よ': ['よ', 'Particle · N5', 'emphasis / new-information sentence-ender'],
  'ね': ['ね', 'Particle · N5', 'confirmation / agreement ("right?; isn\'t it?")'],
  'わね': ['わね', 'Particle · Casual', 'soft emphatic agreement ("isn\'t it!")'],
  'よね': ['よね', 'Particle · N5', 'seeking confirmation ("right?")'],
  'ぞ': ['ぞ', 'Particle · Casual', 'strong assertive sentence-ender ("hey!; I tell you!")'],
  'ぜ': ['ぜ', 'Particle · Casual', 'buddy-tone emphatic sentence-ender'],
  'わ': ['わ', 'Particle · Casual', 'soft emotive / emphatic sentence-ender'],
  'な': ['な', 'Particle · Casual', 'reflective / prohibitive particle'],
  'さ': ['さ', 'Particle · Casual', 'casual filler / assertion particle'],
  'かな': ['かな', 'Particle · N4', '"I wonder…"'],
  'かしら': ['かしら', 'Particle · N4', '"I wonder…" (soft/feminine)'],
  'から': ['から', 'Particle · N5', 'from; since; because'],
  'まで': ['まで', 'Particle · N5', 'until; up to; even'],
  'だけ': ['だけ', 'Particle · N4', 'only; just'],
  'しか': ['しか', 'Particle · N4', 'only (used with negative)'],
  'って': ['って', 'Particle · Casual', 'casual quotation / topic ("speaking of; said that")'],
  'けど': ['けど', 'Conjunction · N5', 'but; however; although'],
  'けれど': ['けれど', 'Conjunction · N5', 'but; however; although'],
  'のに': ['のに', 'Conjunction · N4', 'even though; despite'],
  'ので': ['ので', 'Conjunction · N4', 'because; since'],
  'だ': ['だ', 'Copula · N5', 'is / am / are (plain copula)'],
  'です': ['です', 'Copula · N5', 'is / am / are (polite copula)'],
  'じゃない': ['じゃない', 'Expression · N5', 'is not; isn\'t it?']
};

const GODAN_POTENTIAL_TO_DICT = {
  'える': 'う',
  'ける': 'く',
  'げる': 'ぐ',
  'せる': 'す',
  'てる': 'つ',
  'ねる': 'ぬ',
  'べる': 'ぶ',
  'める': 'む',
  'れる': 'る'
};

const KUROMOJI_POS_FALLBACK = {
  '名詞': 'Noun',
  '動詞': 'Verb',
  '形容詞': 'I-Adjective',
  '副詞': 'Adverb',
  '助詞': 'Particle',
  '助動詞': 'Auxiliary',
  '連体詞': 'Pre-noun Adj',
  '接続詞': 'Conjunction',
  '感動詞': 'Interjection',
  '接頭詞': 'Prefix'
};

const instantVocabRuntime = {
  wordMap: new Map(), // key (kanji or reading) -> Array<{ w, r, m, p, l }>
  openJlptLoaded: false,
  openJlptLoading: null,
  serverLookupsCache: new Map(),
  pendingServerBatch: null,
  listeners: new Set()
};

function formatJmDictPosTag(posCodes, levelStr) {
  const seen = [];
  (Array.isArray(posCodes) ? posCodes : []).forEach((code) => {
    const lbl = JMDICT_POS_LABELS[code];
    if (lbl && !seen.includes(lbl)) seen.push(lbl);
  });
  const base = seen.slice(0, 2).join(' · ') || 'Word';
  return levelStr ? (base + ' · ' + levelStr) : base;
}

function registerDictEntryInRam(entry) {
  // entry: { w: word, r: readingHira, m: meaningStr, p: posLabel, o?: otherForms[] }
  const addKey = (k) => {
    if (!k) return;
    let bucket = instantVocabRuntime.wordMap.get(k);
    if (!bucket) {
      bucket = [];
      instantVocabRuntime.wordMap.set(k, bucket);
    }
    if (!bucket.some((x) => x.w === entry.w && x.r === entry.r)) {
      bucket.push(entry);
    }
  };
  addKey(entry.w);
  if (entry.r && entry.r !== entry.w) addKey(entry.r);
  if (Array.isArray(entry.o)) {
    entry.o.forEach((alt) => addKey(alt));
  }
}

// Seed 0ms built-in Core Manga Lexicon immediately at script load
(function seedCoreMangaLexicon() {
  Object.keys(CORE_MANGA_LEXICON).forEach((word) => {
    const [reading, pos, meaning] = CORE_MANGA_LEXICON[word];
    registerDictEntryInRam({ w: word, r: reading, p: pos, m: meaning });
  });
})();

function notifyInstantVocabListeners() {
  const callbacks = Array.from(instantVocabRuntime.listeners);
  instantVocabRuntime.listeners.clear();
  callbacks.forEach((fn) => {
    try { fn(); } catch (_e) {}
  });
}

async function fetchOpenJlptLevelJson(lvl) {
  const urls = [OPENJLPT_CDN_BASE + lvl + '.json', OPENJLPT_CDN_FALLBACK + lvl + '.json'];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = await fetch(urls[i], { mode: 'cors' });
      if (resp.ok) {
        return await resp.json();
      }
    } catch (_e) {}
  }
  return null;
}

function ensureInstantVocabDictionary(onReady) {
  if (typeof onReady === 'function') {
    if (instantVocabRuntime.openJlptLoaded) {
      onReady();
    } else {
      instantVocabRuntime.listeners.add(onReady);
    }
  }
  if (instantVocabRuntime.openJlptLoaded) {
    return Promise.resolve(true);
  }
  if (instantVocabRuntime.openJlptLoading) {
    return instantVocabRuntime.openJlptLoading;
  }

  instantVocabRuntime.openJlptLoading = (async () => {
    try {
      let compactList = null;
      if (typeof idbGet === 'function') {
        compactList = await idbGet(OPENJLPT_IDB_KEY);
      }

      if (!Array.isArray(compactList) || compactList.length < 1000) {
        const fetchedLevels = await Promise.all(OPENJLPT_LEVELS.map((lvl) => fetchOpenJlptLevelJson(lvl)));
        const merged = [];
        fetchedLevels.forEach((arr) => {
          if (!Array.isArray(arr)) return;
          arr.forEach((item) => {
            if (!item || !item.word) return;
            const w = String(item.word).trim();
            const r = kataToHiraStr(String(item.reading || w).trim());
            const m = Array.isArray(item.meanings) ? item.meanings.slice(0, 4).join('; ') : '';
            if (!m) return;
            const p = formatJmDictPosTag(item.pos, item.level || '');
            const rec = { w, r, m, p };
            if (Array.isArray(item.other_forms) && item.other_forms.length > 0) {
              rec.o = item.other_forms.slice(0, 3);
            }
            merged.push(rec);
          });
        });
        if (merged.length > 0) {
          compactList = merged;
          if (typeof idbPut === 'function') {
            try { await idbPut(OPENJLPT_IDB_KEY, compactList); } catch (_e) {}
          }
        }
      }

      if (Array.isArray(compactList) && compactList.length > 0) {
        for (let i = 0; i < compactList.length; i++) {
          registerDictEntryInRam(compactList[i]);
        }
        instantVocabRuntime.openJlptLoaded = true;
        notifyInstantVocabListeners();
        return true;
      }
    } catch (_err) {
      // Offline mode continues cleanly with built-in Core Manga Lexicon + Kuromoji IPADIC
    } finally {
      instantVocabRuntime.openJlptLoading = null;
    }
    return false;
  })();

  return instantVocabRuntime.openJlptLoading;
}

// 10ten / Yomitan-style Japanese Rule-Based De-inflector (handles conjugated verbs, potentials & i-adjectives)
const DEINFLECT_RULES = [
  ['ちゃった', 'る', 'Casual past (-chatta)'],
  ['ちゃう', 'る', 'Casual (-chau)'],
  ['じゃった', 'ぶ', 'Casual past'],
  ['じゃった', 'む', 'Casual past'],
  ['じゃった', 'ぬ', 'Casual past'],
  ['じゃう', 'ぶ', 'Casual'],
  ['じゃう', 'む', 'Casual'],
  ['ませんでした', 'る', 'Polite past negative'],
  ['ませんでした', 'う', 'Polite past negative'],
  ['ました', 'る', 'Polite past'],
  ['ました', 'う', 'Polite past'],
  ['ます', 'る', 'Polite'],
  ['なかった', 'る', 'Past negative'],
  ['なかった', 'い', 'Past negative'],
  ['くない', 'い', 'Negative'],
  ['かった', 'い', 'Past'],
  ['くて', 'い', 'Te-form'],
  ['ければ', 'い', 'Conditional'],
  ['すぎる', 'い', 'Too much (-sugiru)'],
  ['すぎる', 'る', 'Too much (-sugiru)'],
  ['たい', 'る', 'Want to (-tai)'],
  ['てる', 'る', 'Continuous (-teru)'],
  ['てた', 'る', 'Past continuous'],
  ['ている', 'る', 'Continuous (-te iru)'],
  ['ていた', 'る', 'Past continuous'],
  ['よう', 'る', 'Volitional'],
  ['おう', 'う', 'Volitional'],
  ['こう', 'く', 'Volitional'],
  ['ごう', 'ぐ', 'Volitional'],
  ['そう', 'す', 'Volitional'],
  ['とう', 'つ', 'Volitional'],
  ['のう', 'ぬ', 'Volitional'],
  ['ぼう', 'ぶ', 'Volitional'],
  ['もう', 'む', 'Volitional'],
  ['ろう', 'る', 'Volitional'],
  ['いた', 'く', 'Past'],
  ['いだ', 'ぐ', 'Past'],
  ['した', 'す', 'Past'],
  ['った', 'う', 'Past'],
  ['った', 'つ', 'Past'],
  ['った', 'る', 'Past'],
  ['んだ', 'む', 'Past'],
  ['んだ', 'ぶ', 'Past'],
  ['んだ', 'ぬ', 'Past'],
  ['いて', 'く', 'Te-form'],
  ['いで', 'ぐ', 'Te-form'],
  ['して', 'す', 'Te-form'],
  ['って', 'う', 'Te-form'],
  ['って', 'つ', 'Te-form'],
  ['って', 'る', 'Te-form'],
  ['んで', 'む', 'Te-form'],
  ['んで', 'ぶ', 'Te-form'],
  ['んで', 'ぬ', 'Te-form'],
  ['わない', 'う', 'Negative'],
  ['かない', 'く', 'Negative'],
  ['がない', 'ぐ', 'Negative'],
  ['さない', 'す', 'Negative'],
  ['たない', 'つ', 'Negative'],
  ['なない', 'ぬ', 'Negative'],
  ['ばない', 'ぶ', 'Negative'],
  ['まない', 'む', 'Negative'],
  ['らない', 'る', 'Negative'],
  ['ない', 'る', 'Negative'],
  ['た', 'る', 'Past'],
  ['て', 'る', 'Te-form'],
  ['く', 'い', 'Adverbial']
];

function generateDeinflectedCandidates(surface, basicForm) {
  const candidates = [];
  const pushCand = (term, reason) => {
    if (term && !candidates.some((c) => c.term === term)) {
      candidates.push({ term, reason: reason || '' });
    }
  };

  if (surface) pushCand(surface, '');
  if (basicForm && basicForm !== '*' && basicForm !== surface) {
    pushCand(basicForm, '');
  }

  const basesToProbe = [basicForm && basicForm !== '*' ? basicForm : surface, surface];
  basesToProbe.forEach((word) => {
    if (!word || word.length < 2) return;
    // Check Godan potential -> root verb (e.g. 読める -> 読む, 書ける -> 書く)
    const lastTwo = word.slice(-2);
    if (GODAN_POTENTIAL_TO_DICT[lastTwo]) {
      pushCand(word.slice(0, -2) + GODAN_POTENTIAL_TO_DICT[lastTwo], 'Potential');
    }
    // Check Na-adjective trailing な / に (e.g. 静かな -> 静か)
    if (word.length >= 3 && (word.endsWith('な') || word.endsWith('に'))) {
      pushCand(word.slice(0, -1), '');
    }
    // Check Suru-verb stem
    if (word.length >= 3 && word.endsWith('する')) {
      pushCand(word.slice(0, -2), 'Suru-verb');
    }
    for (let i = 0; i < DEINFLECT_RULES.length; i++) {
      const [suf, rep, reason] = DEINFLECT_RULES[i];
      if (word.length > suf.length && word.endsWith(suf)) {
        pushCand(word.slice(0, word.length - suf.length) + rep, reason);
      }
    }
  });

  return candidates;
}

function lookupBestDictMatch(surface, basicForm, hiraReading) {
  const cands = generateDeinflectedCandidates(surface, basicForm);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const hits = instantVocabRuntime.wordMap.get(c.term);
    if (hits && hits.length > 0) {
      if (hiraReading) {
        const exactRead = hits.find((h) => h.r === hiraReading);
        if (exactRead) return { hit: exactRead, matchedTerm: c.term, reason: c.reason };
      }
      // Prefer entries whose headword matches the kanji/kana spelling of c.term
      const exactHead = hits.find((h) => h.w === c.term) || hits[0];
      return { hit: exactHead, matchedTerm: c.term, reason: c.reason };
    }
    if (instantVocabRuntime.serverLookupsCache.has(c.term)) {
      const srvHit = instantVocabRuntime.serverLookupsCache.get(c.term);
      if (srvHit) return { hit: srvHit, matchedTerm: c.term, reason: c.reason };
    }
  }
  return null;
}

// Optional Local Server Full-JMdict Enrichment (22.6k common / 219k JMdict when server.py is connected)
function requestServerJmDictEnrichment(missingTerms, onUpgraded) {
  if (
    !Array.isArray(missingTerms) ||
    missingTerms.length === 0 ||
    !(state.nativeBackend && state.nativeBackend.connected && state.nativeBackend.url)
  ) {
    return;
  }
  const novel = missingTerms.filter((t) => t && !instantVocabRuntime.serverLookupsCache.has(t));
  if (novel.length === 0) return;
  novel.forEach((t) => instantVocabRuntime.serverLookupsCache.set(t, null));

  fetch(state.nativeBackend.url.replace(/\/+$/, '') + '/api/jmdict_lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terms: novel.slice(0, 60) })
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.entries) return;
      let addedAny = false;
      Object.keys(data.entries).forEach((k) => {
        const ent = data.entries[k];
        if (ent && ent.m) {
          instantVocabRuntime.serverLookupsCache.set(k, ent);
          registerDictEntryInRam(ent);
          addedAny = true;
        }
      });
      if (addedAny && typeof onUpgraded === 'function') {
        onUpgraded();
      }
    })
    .catch(() => {});
}

const PUNCT_SKIP_RE = /^[。、！？!?…・「」『』（）()\[\]【】\s〜~ー\-.,:;'"/\\]+$/;

function groupKuromojiTokensForVocab(tokens) {
  const groups = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const surf = (t.surface_form || '').trim();
    if (!surf || t.pos === '記号' || PUNCT_SKIP_RE.test(surf)) {
      i++;
      continue;
    }

    // 1. Prefix 第 + Number + Counter/Noun (e.g. 第一話)
    if (surf === '第' && tokens[i + 1] && tokens[i + 1].pos_detail_1 === '数') {
      let combSurf = surf;
      let combRead = (t.reading && t.reading !== '*') ? t.reading : surf;
      let j = i + 1;
      while (
        j < tokens.length &&
        (tokens[j].pos_detail_1 === '数' || tokens[j].pos_detail_1 === '助数詞' || tokens[j].pos_detail_1 === '接尾' || tokens[j].surface_form === '話')
      ) {
        combSurf += tokens[j].surface_form;
        combRead += (tokens[j].reading && tokens[j].reading !== '*') ? tokens[j].reading : tokens[j].surface_form;
        j++;
      }
      groups.push({
        surface: combSurf,
        basicForm: combSurf,
        hiraReading: kataToHiraStr(combRead),
        pos: 'Expression',
        inflection: ''
      });
      i = j;
      continue;
    }

    // 2. Na-Adjective stem (名詞-形容動詞語幹) + trailing な / に
    if (
      t.pos === '名詞' &&
      t.pos_detail_1 === '形容動詞語幹' &&
      tokens[i + 1] &&
      (tokens[i + 1].surface_form === 'な' || tokens[i + 1].surface_form === 'に')
    ) {
      const nxt = tokens[i + 1];
      const r1 = (t.reading && t.reading !== '*') ? t.reading : surf;
      const r2 = (nxt.reading && nxt.reading !== '*') ? nxt.reading : nxt.surface_form;
      groups.push({
        surface: surf + nxt.surface_form,
        basicForm: (t.basic_form && t.basic_form !== '*') ? t.basic_form : surf,
        hiraReading: kataToHiraStr(r1 + r2),
        pos: 'Na-Adjective',
        inflection: nxt.surface_form === 'に' ? 'Adverbial' : ''
      });
      i += 2;
      continue;
    }

    // 3. Interrogative Pronoun + か (誰か, 何か, どこか)
    if (
      t.pos === '名詞' &&
      t.pos_detail_1 === '代名詞' &&
      tokens[i + 1] &&
      tokens[i + 1].surface_form === 'か'
    ) {
      const r1 = (t.reading && t.reading !== '*') ? t.reading : surf;
      groups.push({
        surface: surf + 'か',
        basicForm: surf + 'か',
        hiraReading: kataToHiraStr(r1) + 'か',
        pos: 'Pronoun',
        inflection: ''
      });
      i += 2;
      continue;
    }

    // 4. Verb / I-Adjective + Conjugation & Auxiliary Tail (調べ + た -> 調べた, 行こ + う -> 行こう)
    if ((t.pos === '動詞' || t.pos === '形容詞') && t.pos_detail_1 === '自立') {
      let combSurf = surf;
      let combRead = (t.reading && t.reading !== '*') ? t.reading : surf;
      const baseDict = (t.basic_form && t.basic_form !== '*') ? t.basic_form : surf;
      let inflTags = [];
      let j = i + 1;
      while (j < tokens.length) {
        const nx = tokens[j];
        const nxSurf = nx.surface_form || '';
        const isAux = nx.pos === '助動詞';
        const isDepVerb = (nx.pos === '動詞' || nx.pos === '形容詞') && (nx.pos_detail_1 === '非自立' || nx.pos_detail_1 === '接尾');
        const isConnPrt = nx.pos === '助詞' && nx.pos_detail_1 === '接続助詞' &&
          (nxSurf === 'て' || nxSurf === 'で' || nxSurf === 'ちゃ' || nxSurf === 'じゃ' || nxSurf === 'ば' || nxSurf === 'たら');
        // Do not swallow sentence-final explanatory の / ん or copula だ after plain form
        if (isAux && (nxSurf === 'だ' || nxSurf === 'です' || nxSurf === 'らしい')) break;
        if (!isAux && !isDepVerb && !isConnPrt) break;

        combSurf += nxSurf;
        combRead += (nx.reading && nx.reading !== '*') ? nx.reading : nxSurf;
        if (nxSurf === 'た' || nxSurf === 'だ') inflTags.push('Past');
        else if (nxSurf === 'ない' || nxSurf === 'ぬ' || nxSurf === 'ん') inflTags.push('Negative');
        else if (nxSurf === 'う' || nxSurf === 'よう') inflTags.push('Volitional');
        else if (nxSurf === 'たい') inflTags.push('Want (-tai)');
        else if (nxSurf === 'ます') inflTags.push('Polite');
        else if (nxSurf === 'てる' || nxSurf === 'でる' || nxSurf === 'いる') inflTags.push('Continuous');
        j++;
      }
      groups.push({
        surface: combSurf,
        basicForm: baseDict,
        hiraReading: kataToHiraStr(combRead),
        pos: t.pos === '形容詞' ? 'I-Adjective' : 'Verb',
        inflection: inflTags.slice(0, 2).join(' · ')
      });
      i = j;
      continue;
    }

    // 5. Compound Sentence-Final Particles (のか, わね, よね)
    if (
      t.pos === '助詞' &&
      tokens[i + 1] &&
      tokens[i + 1].pos === '助詞' &&
      CORE_MANGA_LEXICON[surf + tokens[i + 1].surface_form]
    ) {
      const comb = surf + tokens[i + 1].surface_form;
      groups.push({
        surface: comb,
        basicForm: comb,
        hiraReading: CORE_MANGA_LEXICON[comb][0],
        pos: 'Particle',
        inflection: ''
      });
      i += 2;
      continue;
    }

    // 6. Standard Word / Particle
    let rawRead = (t.reading && t.reading !== '*') ? t.reading : surf;
    if (t.pos === '助詞') {
      if (surf === 'は') rawRead = 'ワ';
      else if (surf === 'へ') rawRead = 'エ';
    }
    groups.push({
      surface: surf,
      basicForm: (t.basic_form && t.basic_form !== '*') ? t.basic_form : surf,
      hiraReading: kataToHiraStr(rawRead),
      pos: KUROMOJI_POS_FALLBACK[t.pos] || 'Word',
      inflection: ''
    });
    i++;
  }
  return groups;
}

// Greedy Longest-Match + De-inflection Fallback Scanner (0ms cold start before Kuromoji IPADIC loads)
function segmentGreedyColdStart(jpText) {
  const clean = String(jpText || '').trim();
  const groups = [];
  const chars = Array.from(clean);
  let i = 0;
  while (i < chars.length) {
    if (PUNCT_SKIP_RE.test(chars[i])) {
      i++;
      continue;
    }
    let matched = null;
    const maxLen = Math.min(10, chars.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const sub = chars.slice(i, i + len).join('');
      if (PUNCT_SKIP_RE.test(sub)) continue;
      const hitInfo = lookupBestDictMatch(sub, sub, '');
      if (hitInfo) {
        let derivedRead = hitInfo.hit.r || kataToHiraStr(sub);
        const dictW = hitInfo.matchedTerm || hitInfo.hit.w || '';
        if (sub !== dictW && dictW.length >= 2 && hitInfo.hit.r) {
          // Derive inflected kana suffix from shared kanji stem (e.g. 調べた vs 調べる -> しらべ + た = しらべた)
          let stemLen = 0;
          while (stemLen < sub.length && stemLen < dictW.length && sub[stemLen] === dictW[stemLen]) {
            stemLen++;
          }
          const dictKanaTail = dictW.slice(stemLen);
          const surfKanaTail = sub.slice(stemLen);
          if (stemLen > 0 && dictKanaTail && hitInfo.hit.r.endsWith(dictKanaTail)) {
            derivedRead = hitInfo.hit.r.slice(0, hitInfo.hit.r.length - dictKanaTail.length) + kataToHiraStr(surfKanaTail);
          }
        }
        matched = {
          surface: sub,
          basicForm: dictW || hitInfo.hit.w,
          hiraReading: derivedRead,
          pos: hitInfo.hit.p || 'Word',
          inflection: hitInfo.reason || '',
          preMatchedHit: hitInfo.hit
        };
        i += len;
        break;
      }
    }
    if (matched) {
      groups.push(matched);
    } else {
      // Group contiguous kanji or katakana run as an unknown token
      let end = i + 1;
      const isKanji = /[\u3400-\u9FFF]/.test(chars[i]);
      const isKata = /[\u30A1-\u30FAー]/.test(chars[i]);
      while (
        end < chars.length &&
        ((isKanji && /[\u3400-\u9FFF]/.test(chars[end])) || (isKata && /[\u30A1-\u30FAー]/.test(chars[end])))
      ) {
        end++;
      }
      const chunk = chars.slice(i, end).join('');
      groups.push({
        surface: chunk,
        basicForm: chunk,
        hiraReading: kataToHiraStr(chunk),
        pos: isKata ? 'Noun (Katakana)' : 'Word',
        inflection: ''
      });
      i = end;
    }
  }
  return groups;
}

function analyzeJapaneseVocabInstant(jpText, onUpgraded) {
  const clean = String(jpText || '').trim();
  if (!clean) return { vocab: [], ready: true, dictSource: 'Empty' };

  // Kick off background Kuromoji IPADIC + OpenJLPT JMdict load if not yet ready
  let tokenizerReady = Boolean(typeof offlineRomajiRuntime !== 'undefined' && offlineRomajiRuntime.tokenizer);
  if (!tokenizerReady && typeof ensureOfflineRomajiEngine === 'function' && !offlineRomajiRuntime.failed) {
    ensureOfflineRomajiEngine(() => {
      if (typeof onUpgraded === 'function') onUpgraded();
    });
  }
  if (!instantVocabRuntime.openJlptLoaded) {
    ensureInstantVocabDictionary(() => {
      if (typeof onUpgraded === 'function') onUpgraded();
    });
  }

  const rawGroups = tokenizerReady
    ? groupKuromojiTokensForVocab(offlineRomajiRuntime.tokenizer.tokenize(clean))
    : segmentGreedyColdStart(clean);

  const missingForServer = [];
  const vocabOut = [];

  rawGroups.forEach((g) => {
    const match = g.preMatchedHit
      ? { hit: g.preMatchedHit, matchedTerm: g.basicForm, reason: g.inflection }
      : lookupBestDictMatch(g.surface, g.basicForm, g.hiraReading);

    let reading = g.hiraReading || '';
    if (match && match.hit && match.hit.r && g.surface === (match.matchedTerm || match.hit.w)) {
      reading = match.hit.r;
    }
    const isUverbDict = g.pos.includes('Verb') && g.surface.endsWith('う') && !/[おこそとのほもよろ]う$/.test(g.surface);
    const romaji = (typeof kanaToRevisedHepburn === 'function' && reading)
      ? kanaToRevisedHepburn(reading, !isUverbDict)
      : '';

    const dictForm = (match && match.hit && match.hit.w) ? match.hit.w : (g.basicForm || g.surface);
    const inflNote = g.inflection || (match && match.reason) || '';
    const basePos = (match && match.hit && match.hit.p) ? match.hit.p : g.pos;
    const posLabel = inflNote && !basePos.includes(inflNote) ? (basePos + ' · ' + inflNote) : basePos;
    let meaning = (match && match.hit && match.hit.m) ? match.hit.m : '';

    if (!meaning) {
      missingForServer.push(g.basicForm || g.surface);
      if (g.surface !== g.basicForm) missingForServer.push(g.surface);
      meaning = instantVocabRuntime.openJlptLoaded
        ? 'Proper noun / colloquialism (use AI Study for nuance)'
        : 'Loading JMdict dictionary…';
    }

    vocabOut.push({
      surface: g.surface,
      reading,
      romaji,
      dictForm,
      pos: posLabel,
      meaning,
      isParticle: basePos.startsWith('Particle') || basePos.startsWith('Copula')
    });
  });

  if (missingForServer.length > 0) {
    requestServerJmDictEnrichment(missingForServer, onUpgraded);
  }

  const dictSource = (state.nativeBackend && state.nativeBackend.connected)
    ? 'Kuromoji + JMdict'
    : (instantVocabRuntime.openJlptLoaded ? 'Kuromoji + OpenJLPT/JMdict' : 'Instant Lexicon');

  return {
    vocab: vocabOut,
    ready: Boolean((tokenizerReady || offlineRomajiRuntime.failed) && instantVocabRuntime.openJlptLoaded),
    dictSource
  };
}
