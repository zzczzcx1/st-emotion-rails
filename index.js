/*!
 * Emotion Rails (st-emotion-rails) v2.1.1
 * Renders a per-segment emotion avatar beside character messages in
 * SillyTavern, driven by [emotion-word] tags at line starts.
 *
 * v2.1.1 fixes per-character asset URLs, settings-backed visual toggles,
 * cache isolation, and formatted leading-tag hiding.
 *
 * v2.1.0 (multi-character + missing-art placeholders):
 *  - PER-CHARACTER vocabularies: settings.baseUrl may hold per-character
 *    subfolders — `${baseUrl}<character-name>/emotions.json` (+ images) is
 *    probed first for each message (keyed by mes.ch_name), falling back to
 *    the global `${baseUrl}emotions.json`; if neither exists the character's
 *    messages are left untouched (ST default rendering, zero interference).
 *    Vocabularies are cached per character with in-flight dedupe.
 *  - MISSING ART: an emotion word whose image 404s shows a blank placeholder
 *    (inline SVG data URI, no network) instead of being remapped to another
 *    word's avatar. Untagged/unknown-word lines still use the vocabulary
 *    fallback chain (defaultWord → JSON fallback → first word of that
 *    character's list).
 *  - Same segment layout as v2.0.0 ([avatar + word label] | [speech bubble],
 *    one per tagged line; trailing narration joins the segment; leading
 *    bracket groups hidden from display without touching chat data).
 *
 * Coexistence with extensions that rewrite .mes_text (e.g. per-sentence
 * TTS players): idempotent rendering (dataset hash guard) and a
 * MutationObserver re-renders a message when something else rewrites it;
 * during streaming generation the observer is suspended so the typewriter
 * is never interrupted.
 *
 * SillyTavern message-contract notes (verified on ST 1.18.x):
 *  - CHARACTER_MESSAGE_RENDERED / MESSAGE_EDITED / MESSAGE_SWIPED emit
 *    POSITIONAL args (messageId = array index, type) — not an object.
 *  - Chat items have NO `id` field; the array index IS the message id.
 *  - Message blocks locate by bare attribute `.mes[mesid="<index>"]`
 *    (no data-* attributes). GENERATION_ENDED passes chat.length.
 *  - messageFormatting renders EACH LINE AS A <p> ELEMENT (showdown
 *    simpleLineBreaks handles in-line \n only; blank lines delimit
 *    paragraphs) — there are NO <br> children at the .mes_text top level.
 *    Both shapes are handled by the row splitter.
 *  - Loading an existing chat does NOT fire render events — re-scan the
 *    whole chat on CHAT_CHANGED / startup.
 */
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { eventSource, event_types } from '../../../events.js';

const MODULE = 'emotionRails';

/* One or more leading bracket groups: [happy] or [Name][happy][scene] ... */
const TAG_ROW_RE = /^(\[[^\[\]]{1,64}\]\s*)+/;
const TAG_GROUP_RE = /\[[^\[\]]{1,64}\]/g;

/* Blank placeholder shown when an emotion's image file is missing
   (inline SVG — no network request, cannot be confused with real art) */
const PLACEHOLDER_SRC = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="14" fill="rgba(128,128,140,.10)" stroke="rgba(128,128,140,.25)"/></svg>'
);

/*
 * Vocabulary store: one entry per character ('' = the global list).
 * entry: { emotions, aliases, keys, fallback } or null (= nothing available
 * for that character / global base -> message left untouched).
 */
const INDEX_CACHE = new Map();
const INFLIGHT = new Map();
const PENDING_IDS = new Set();
let observer = null;
let debounceTimer = null;
let streaming = false;

function defaultSettings() {
    return {
        enabled: true,
        baseUrl: '/user/images/emotion-rails/',
        index: 'emotions.json',
        perCharacter: true,   // probe ${baseUrl}<character>/emotions.json first
        defaultWord: '',      // language-neutral: resolved per vocabulary
        showChip: true,       // show the word label under each avatar
        size: 84,             // segment avatar size in px
        hideStAvatar: true,   // hide ST's persistent left avatar (each segment has its own)
        bubble: true,         // speech-bubble background behind segment text
        placeholder: true,    // missing art -> blank placeholder (never remap)
    };
}

/* ST 1.18 does not export getExtensionSettings; provide an equivalent */
function getExtensionSettings(name) {
    return Object.assign({}, defaultSettings(), extension_settings?.[name] ?? {});
}

/* Character-name -> safe path segment (strip filesystem-hostile chars) */
function normalizeName(name) {
    return String(name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_');
}

function normalizeBaseUrl(value) {
    const base = String(value ?? '').trim() || defaultSettings().baseUrl;
    return base.endsWith('/') ? base : `${base}/`;
}

function indexName(s) {
    return String(s.index || 'emotions.json').replace(/^\/+/, '');
}

function cacheKey(charKey, s) {
    return JSON.stringify([
        normalizeBaseUrl(s.baseUrl),
        indexName(s),
        s.perCharacter !== false,
        charKey,
    ]);
}

async function fetchJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    try { return await r.json(); } catch (e) { return null; }
}

function parseIndex(data, baseUrl) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const emotions = {};
    for (const [k, v] of Object.entries(data)) {
        if (k !== 'aliases' && k !== 'fallback' && v && typeof v.img === 'string' && v.img.trim()) emotions[k] = v;
    }
    const keys = Object.keys(emotions);
    if (!keys.length) return null;
    return {
        emotions,
        aliases: data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases) ? data.aliases : {},
        keys,
        fallback: data.fallback || null,
        baseUrl: normalizeBaseUrl(baseUrl),
    };
}

/**
 * Resolve (and cache) the vocabulary for one character.
 * charKey '' = global list. Per-character probe first (if enabled), then
 * the global list; null = nothing available (skip that character entirely).
 */
function getIndex(charKey, s) {
    const key = cacheKey(charKey, s);
    if (INDEX_CACHE.has(key)) return Promise.resolve(INDEX_CACHE.get(key));
    if (INFLIGHT.has(key)) return INFLIGHT.get(key);
    const p = (async () => {
        let idx = null;
        const globalBase = normalizeBaseUrl(s.baseUrl);
        const filename = indexName(s);
        if (charKey && s.perCharacter !== false) {
            const characterBase = `${globalBase}${encodeURIComponent(charKey)}/`;
            try {
                idx = parseIndex(await fetchJSON(`${characterBase}${filename}`), characterBase);
            } catch (e) { idx = null; }
        }
        if (!idx) {
            try {
                idx = parseIndex(await fetchJSON(`${globalBase}${filename}`), globalBase);
            } catch (e) { idx = null; }
        }
        INDEX_CACHE.set(key, idx);
        return idx;
    })();
    INFLIGHT.set(key, p);
    p.finally(() => INFLIGHT.delete(key));
    return p;
}

/* Fallback word for a vocabulary: setting > json fallback > first word */
function fallbackOf(idx, s) {
    for (const word of [s.defaultWord, idx.fallback, idx.keys[0]]) {
        if (word && idx.emotions[word]) return word;
        const canonical = word && idx.aliases[word];
        if (canonical && idx.emotions[canonical]) return canonical;
    }
    return null;
}

/* First bracket group that hits the whitelist (or an alias, mapped back to
   its canonical word) of the GIVEN vocabulary */
function findEmotion(text, idx) {
    const prefix = String(text).match(TAG_ROW_RE)?.[0] || '';
    const groups = prefix.match(TAG_GROUP_RE) || [];
    for (const g of groups) {
        const w = g.slice(1, -1).trim();
        if (!w || !idx) continue;
        if (idx.emotions[w]) return w;
        if (idx.aliases[w] && idx.emotions[idx.aliases[w]]) return idx.aliases[w];
    }
    return null;
}

function imgUrl(word, s) {
    const e = s.idx.emotions[word] || {};
    const rel = e.img || encodeURIComponent(word) + '.png';
    /* Absolute URLs / data URIs / origin-root paths are used as-is. */
    if (/^(https?:|data:|blob:)/i.test(rel) || rel.startsWith('/')) return rel;
    return `${s.idx.baseUrl || normalizeBaseUrl(s.baseUrl)}${rel}`;
}

/* ---------- DOM segmentation ---------- */

/**
 * Split .mes_text top-level children into "rows".
 * ST renders one <p> per line; the streaming typewriter intermediate shape
 * may be [text, <br>, text, ...] instead. Both supported.
 */
function collectRows(mesTextEl) {
    const rows = [];
    let cur = [];
    const flush = () => { rows.push(cur); cur = []; };
    for (const node of [...mesTextEl.childNodes]) {
        if (node.nodeType !== 1) { cur.push(node); continue; }
        if (node.nodeName === 'BR') { flush(); continue; }
        if (node.nodeName === 'P') {
            if (cur.length) flush();
            let inner = [];
            for (const pn of node.childNodes) {
                if (pn.nodeName === 'BR') { rows.push(inner); inner = []; }
                else inner.push(pn);
            }
            rows.push(inner);
            continue;
        }
        cur.push(node);
    }
    if (cur.length) rows.push(cur);
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return rows;
}

function rowText(nodes) {
    let t = '';
    for (const n of nodes) t += n.textContent || '';
    return t;
}

/* Does the row start with a bracket group (blank/narration rows return false)? */
function isTagRow(nodes) {
    const t = rowText(nodes);
    if (!t.trim()) return false;
    const m = t.match(TAG_ROW_RE);
    return !!m && m[0].length > 0;
}

/* Blank row: no nodes / all <br> / all-whitespace */
function isEmptyRow(nodes) {
    if (!nodes || !nodes.length) return true;
    for (const n of nodes) {
        if (n && n.nodeName !== 'BR' && (n.textContent || '').trim() !== '') return false;
    }
    return true;
}

/**
 * Group rows into segments: a tag row opens a segment, subsequent non-tag
 * rows (narration/blank) join it; narration at the head of the message is
 * merged into the first segment; trailing blank rows are dropped.
 */
function splitRows(rows, idx) {
    const segs = [];
    const trimTail = () => {
        const last = segs[segs.length - 1];
        if (last && last.more.length && isEmptyRow(last.more[last.more.length - 1])) last.more.pop();
    };
    for (const nodes of rows) {
        if (isTagRow(nodes)) {
            trimTail();
            segs.push({ word: findEmotion(rowText(nodes), idx), head: nodes, more: [] });
        } else if (segs.length) {
            segs[segs.length - 1].more.push(nodes);
        } else if (!isEmptyRow(nodes)) {
            segs.push({ word: null, head: null, more: [nodes] });
        }
    }
    trimTail();
    return segs;
}

/**
 * Hide the leading tag prefix of a row by moving it into a hidden span
 * (returns the consumed node). Primary path: the first text node of the row
 * IS the tag (verified DOM shape). Fallback: a leading element whose whole
 * text content is the tag gets display:none.
 */
function hideTagPrefix(nodes, target) {
    for (const n of nodes) {
        if (n.nodeType === 3) {
            const m = n.textContent.match(TAG_ROW_RE);
            if (!m || m[0].length === 0) return null;
            const span = document.createElement('span');
            span.className = 'er-taghide';
            if (m[0].length === n.textContent.length) {
                span.appendChild(n);
            } else {
                const rest = n.splitText(m[0].length);
                span.appendChild(n);
                if (rest.textContent.trim() !== '') target.appendChild(rest);
            }
            target.appendChild(span);
            return n;
        }
        if (n.nodeType !== 1 || n.nodeName === 'BR') continue;
        const text = n.textContent || '';
        const m = text.match(TAG_ROW_RE);
        if (!m || !m[0].length) return null;
        if (m[0].length === text.length) {
            n.style.display = 'none';
            return n;
        }
        return null;
    }
    return null;
}

/* Build one segment (avatar column + speech body) into frag */
function buildSeg(seg, s, frag) {
    const fb = fallbackOf(s.idx, s);
    const word = (seg.word && s.idx.emotions[seg.word]) ? seg.word : fb;
    if (!word) return;
    const segEl = document.createElement('div');
    segEl.className = 'er-seg';

    const ava = document.createElement('div');
    ava.className = 'er-ava';
    const img = document.createElement('img');
    img.className = 'er-ava-img';
    img.src = imgUrl(word, s);
    img.width = img.height = Number(s.size) || 84;
    img.draggable = false;
    img.alt = word;
    if (s.placeholder !== false) {
        /* Missing art never remaps: blank placeholder instead */
        const fallbackSrc = PLACEHOLDER_SRC;
        img.onerror = () => { img.onerror = null; img.src = fallbackSrc; img.title = word + ' (missing art)'; };
    }
    ava.appendChild(img);
    if (s.showChip) {
        const lab = document.createElement('span');
        lab.className = 'er-word';
        lab.textContent = word;
        ava.appendChild(lab);
    }
    segEl.appendChild(ava);

    const body = document.createElement('div');
    body.className = s.bubble === false ? 'er-body er-body--plain' : 'er-body';
    let first = true;
    const appendRow = (nodes, isHead) => {
        if (!first) body.appendChild(document.createElement('br'));
        first = false;
        const consumed = isHead ? hideTagPrefix(nodes, body) : null;
        for (const node of nodes) {
            if (node === consumed) continue;
            body.appendChild(node);
        }
    };
    if (seg.head) appendRow(seg.head, true);
    for (const r of seg.more) appendRow(r, false);
    segEl.appendChild(body);
    frag.appendChild(segEl);
}

function simpleHash(t) {
    let h = 5381;
    for (let i = 0; i < t.length; i++) { h = ((h << 5) + h + t.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16);
}

/**
 * Idempotently render one character message by array index.
 * Resolves the character's vocabulary first (per-character probe -> global
 * fallback -> skip if none), then re-segments .mes_text.
 */
async function renderMes(messageIndex, force = false) {
    const i = Number(messageIndex);
    if (!Number.isInteger(i) || i < 0) return;
    const s = getExtensionSettings(MODULE);
    if (!s.enabled) return;
    let mes;
    try {
        mes = (getContext().chat ?? [])[i];
    } catch (e) { return; }
    if (!mes || mes.is_user || mes.is_system) return;
    const charKey = normalizeName(mes.ch_name ?? '');
    const idx = await getIndex(charKey, s);
    if (!idx || !idx.keys.length) return;      /* no vocab for this character: leave as-is */
    const st = Object.assign({}, s, { idx });
    if (st.placeholder === false) delete st.placeholder;

    const el = document.querySelector(`.mes[mesid="${i}"]`);
    if (!el) return;
    const mesText = el.querySelector('.mes_text');
    if (!mesText) return;

    const want = simpleHash(mes.mes ?? '');
    const seg = mesText.querySelector(':scope > .er-seg');
    if (!force && seg && mesText.dataset.erHash === want) return;

    try {
        const rows = collectRows(mesText);
        if (!rows.some(isTagRow)) {
            el.classList.remove('er-hide-st-avatar');
            return;                           /* plain narration: leave as-is */
        }
        const segs = splitRows(rows, idx);
        if (!segs.length) return;
        const frag = document.createDocumentFragment();
        for (const segItem of segs) buildSeg(segItem, st, frag);

        /* Preserve datasets (other extensions' markers, e.g. TTS state) */
        const ds = Object.assign({}, mesText.dataset);
        mesText.replaceChildren(frag);
        for (const k of Object.keys(ds)) mesText.dataset[k] = ds[k];
        mesText.dataset.erHash = want;
        el.classList.toggle('er-hide-st-avatar', st.hideStAvatar !== false);
    } catch (e) {
        console.warn(`[${MODULE}] render mes ${i} failed:`, e?.message ?? e);
    }
}

function renderAll() {
    if (streaming) return;
    let chat;
    try { chat = getContext().chat ?? []; } catch (e) { return; }
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && !chat[i].is_user && !chat[i].is_system) renderMes(i);
    }
}

function scheduleRenderAll() {
    renderAll();
    requestAnimationFrame(renderAll);
    setTimeout(renderAll, 400);
}

/* ---------- events & watchers ---------- */

function onMessageEvent(messageId) {
    /* edit/swipe formatting may land async; slight delay avoids racing ST */
    setTimeout(() => renderMes(messageId, true), 120);
}

function onGenerationEnded() {
    streaming = false;
    setTimeout(renderAll, 600);
}

function startObserver() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || observer) return;
    observer = new MutationObserver((muts) => {
        if (streaming) return;               /* suspend during typewriter */
        for (const m of muts) {
            let el = m.target;
            while (el && (!el.classList || !el.classList.contains('mes'))) el = el.parentElement;
            if (el) {
                const id = el.getAttribute('mesid');
                if (id !== null && id !== '') PENDING_IDS.add(id);
            }
            for (const node of m.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                const blocks = node.matches?.('.mes') ? [node] : [...(node.querySelectorAll?.('.mes') || [])];
                for (const block of blocks) {
                    const id = block.getAttribute('mesid');
                    if (id !== null && id !== '') PENDING_IDS.add(id);
                }
            }
        }
        if (!PENDING_IDS.size) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const ids = [...PENDING_IDS];
            PENDING_IDS.clear();
            for (const id of ids) renderMes(id);
        }, 500);
    });
    observer.observe(chatEl, { childList: true, characterData: true, subtree: true });
}

async function start() {
    const s = getExtensionSettings(MODULE);
    if (!s.enabled) return;
    const globalIndex = await getIndex('', s); /* warm the global list */
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageEvent);
    eventSource.on(event_types.GENERATION_STARTED, () => { streaming = true; });
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        streaming = false;
        getIndex('', getExtensionSettings(MODULE)).then(scheduleRenderAll);
    });
    startObserver();
    scheduleRenderAll();
    console.info(`[${MODULE}] ready (seg mode, per-character), global=${globalIndex ? 'yes' : 'no'}`);
}

start().catch(e => console.error(`[${MODULE}] init error:`, e));
