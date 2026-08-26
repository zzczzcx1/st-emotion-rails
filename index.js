/*!
 * Emotion Rails (st-emotion-rails) v2.0.0
 * Renders a per-segment emotion avatar beside character messages in
 * SillyTavern, driven by [emotion-word] tags at line starts.
 *
 * v2.0.0 (seg mode): replaces the v1 sidebar rail with a "tag-aligned
 * segment" layout — each tagged line (plus any untagged narration that
 * follows it) becomes one segment rendered as:
 *
 *     [emotion avatar + word label] | [speech bubble]
 *
 * so every avatar sits exactly beside its own lines (the v1 rail could
 * drift from the text because it was a single left-float column with
 * fixed pitch while paragraphs varied in height). Tag lines and their
 * trailing narration are grouped per segment; the leading bracket groups
 * ([word] or [name][word][scene]) are hidden from display (moved into a
 * hidden span) WITHOUT touching the underlying chat data.
 *
 * Coexistence with extensions that rewrite .mes_text (e.g. per-sentence
 * TTS players): rendering is idempotent (dataset hash guard) and a
 * MutationObserver re-renders a message when something else rewrites
 * it; during streaming generation the observer is suspended so the
 * typewriter is never interrupted.
 *
 * Word list, image mapping and aliases are all loaded at runtime from a
 * single emotions.json — add/remove emotions without touching code.
 *
 * SillyTavern message-contract notes (verified on ST 1.18.x):
 *  - CHARACTER_MESSAGE_RENDERED / MESSAGE_EDITED / MESSAGE_SWIPED emit
 *    POSITIONAL args (messageId = array index, type) — not an object.
 *  - Chat items have NO `id` field; the array index IS the message id.
 *  - Message blocks locate by bare attribute `.mes[mesid="<index>"]`
 *    (no data-* attributes). GENERATION_ENDED passes chat.length.
 *  - A key one: messageFormatting renders EACH LINE AS A <p> ELEMENT
 *    (showdown simpleLineBreaks handles in-line \n only; blank lines
 *    delimit paragraphs) — there are NO <br> children at the .mes_text
 *    top level. Both shapes are handled by the row splitter.
 *  - Loading an existing chat does NOT fire render events — re-scan the
 *    whole chat on CHAT_CHANGED / startup.
 */
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { eventSource, event_types } from '../../../events.js';

const MODULE = 'emotionRails';

/* One or more leading bracket groups: [happy] or [Name][happy][scene] ... */
const TAG_ROW_RE = /^(\[[^\[\]]{1,12}\]\s*)+/;

let EMOTIONS = {};        // { word: {img} }
let ALIASES = {};         // { alias: canonical word }
let EMOTION_KEYS = [];
let FALLBACK_WORD = null; // settings.defaultWord > json.fallback > first key
let observer = null;
let debounceTimer = null;
let streaming = false;

function defaultSettings() {
    return {
        enabled: true,
        baseUrl: '/user/images/emotion-rails/',
        index: 'emotions.json',
        defaultWord: '',      // language-neutral: resolved via FALLBACK_WORD
        showChip: true,       // show the word label under each avatar
        size: 84,             // segment avatar size in px
        hideStAvatar: true,   // hide ST's persistent left avatar (each segment has its own)
        bubble: true,         // speech-bubble background behind segment text
    };
}

/* ST 1.18 does not export getExtensionSettings; provide an equivalent */
function getExtensionSettings(name) {
    return Object.assign({}, defaultSettings(), extension_settings?.[name] ?? {});
}

async function loadIndex() {
    const s = getExtensionSettings(MODULE);
    try {
        const r = await fetch(`${s.baseUrl}${s.index}`, { cache: 'no-cache' });
        if (!r.ok) throw new Error('index HTTP ' + r.status);
        const data = await r.json();
        EMOTIONS = {};
        ALIASES = data.aliases || {};
        for (const [k, v] of Object.entries(data)) {
            if (k !== 'aliases' && k !== 'fallback' && v && v.img) EMOTIONS[k] = v;
        }
        EMOTION_KEYS = Object.keys(EMOTIONS);
        FALLBACK_WORD = [s.defaultWord, data.fallback, EMOTION_KEYS[0]]
            .find(w => w && EMOTIONS[w]) || null;
        console.info(`[${MODULE}] emotion index loaded: ${EMOTION_KEYS.length} words, ${Object.keys(ALIASES).length} aliases`);
        return true;
    } catch (e) {
        console.warn(`[${MODULE}] emotion index load failed:`, e.message);
        EMOTIONS = {}; ALIASES = {}; EMOTION_KEYS = []; FALLBACK_WORD = null;
        return false;
    }
}

/* First bracket group that hits the whitelist (or an alias, mapped back to
   its canonical word). */
function findEmotion(text) {
    const groups = String(text).match(/\[([^\[\]]{1,12})\]/g) || [];
    for (const g of groups) {
        const w = g.slice(1, -1).trim();
        if (!w) continue;
        if (EMOTION_KEYS.includes(w)) return w;
        if (ALIASES[w] && EMOTIONS[ALIASES[w]]) return ALIASES[w];
    }
    return null;
}

function imgUrl(word, s) {
    const e = EMOTIONS[word] || {};
    return `${s.baseUrl}${e.img || encodeURIComponent(word) + '.png'}`;
}

/* ---------- DOM segmentation ---------- */

/**
 * Split .mes_text top-level children into "rows".
 * ST renders one <p> per line (see header notes); the streaming typewriter
 * intermediate shape may be [text, <br>, text, ...] instead. Both supported:
 *  - <p> block: its children form one row (inner <br>s split it further);
 *    <p> is a paragraph boundary, so there are no "blank rows" in this shape.
 *  - <br>: row break; consecutive <br>s produce empty rows (dropped later).
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
function splitRows(rows) {
    const segs = [];
    const trimTail = () => {
        const last = segs[segs.length - 1];
        if (last && last.more.length && isEmptyRow(last.more[last.more.length - 1])) last.more.pop();
    };
    for (const nodes of rows) {
        if (isTagRow(nodes)) {
            trimTail();
            segs.push({ word: findEmotion(rowText(nodes)), head: nodes, more: [] });
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
    const tn = nodes.find(n => n.nodeType === 3);
    if (tn) {
        const m = tn.textContent.match(TAG_ROW_RE);
        if (!m || m[0].length === 0) return null;
        const span = document.createElement('span');
        span.className = 'er-taghide';
        if (m[0].length === tn.textContent.length) {
            span.appendChild(tn);
        } else {
            const rest = tn.splitText(m[0].length);
            span.appendChild(tn);
            if (rest.textContent.trim() !== '') target.appendChild(rest);
        }
        target.appendChild(span);
        return tn;
    }
    for (const n of nodes) {
        if (n.nodeType !== 1 || n.nodeName === 'BR') continue;
        const t = n.textContent || '';
        const m = t.match(TAG_ROW_RE);
        if (!m || !m[0].length) continue;
        if (m[0].length === t.length) { n.style.display = 'none'; return n; }
    }
    return null;
}

/* Build one segment (avatar column + speech body) into frag */
function buildSeg(seg, s, frag) {
    const word = (seg.word && EMOTION_KEYS.includes(seg.word)) ? seg.word : FALLBACK_WORD;
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
    ava.appendChild(img);
    if (s.showChip) {
        const lab = document.createElement('span');
        lab.className = 'er-word';
        lab.textContent = word;
        ava.appendChild(lab);
    }
    segEl.appendChild(ava);

    const body = document.createElement('div');
    body.className = 'er-body';
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
 * Hash from chat text (edit/swipe/generation changes it -> rebuild);
 * already rendered with the same hash -> skip; rewritten by another
 * extension (.er-seg lost) -> rebuild.
 */
function renderMes(messageIndex, force = false) {
    const i = Number(messageIndex);
    if (!Number.isInteger(i) || i < 0) return;
    const s = getExtensionSettings(MODULE);
    if (!s.enabled || !EMOTION_KEYS.length || !FALLBACK_WORD) return;
    let mes, el;
    try {
        mes = (getContext().chat ?? [])[i];
    } catch (e) { return; }
    if (!mes || mes.is_user || mes.is_system) return;
    el = document.querySelector(`.mes[mesid="${i}"]`);
    if (!el) return;
    const mesText = el.querySelector('.mes_text');
    if (!mesText) return;

    const want = simpleHash(mes.mes ?? '');
    const seg = mesText.querySelector(':scope > .er-seg');
    if (!force && seg && mesText.dataset.erHash === want) return;

    try {
        const rows = collectRows(mesText);
        if (!rows.some(isTagRow)) return;      /* plain narration: leave as-is */
        const segs = splitRows(rows);
        if (!segs.length) return;
        const frag = document.createDocumentFragment();
        for (const segItem of segs) buildSeg(segItem, s, frag);

        /* Preserve datasets (other extensions' markers, e.g. TTS state) */
        const ds = Object.assign({}, mesText.dataset);
        mesText.replaceChildren(frag);
        for (const k of Object.keys(ds)) mesText.dataset[k] = ds[k];
        mesText.dataset.erHash = want;
    } catch (e) {
        console.warn(`[${MODULE}] render mes ${i} failed:`, e?.message ?? e);
    }
}

function renderAll() {
    if (streaming || !EMOTION_KEYS.length) return;
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
        const ids = new Set();
        for (const m of muts) {
            let el = m.target;
            while (el && (!el.classList || !el.classList.contains('mes'))) el = el.parentElement;
            if (el) {
                const id = el.getAttribute('mesid');
                if (id !== null && id !== '') ids.add(id);
            }
        }
        if (!ids.size) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { for (const id of ids) renderMes(id); }, 500);
    });
    observer.observe(chatEl, { childList: true, subtree: true });
}

async function start() {
    await loadIndex();
    if (!FALLBACK_WORD) {
        console.warn(`[${MODULE}] no usable words; check baseUrl/index settings`);
        return;
    }
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageEvent);
    eventSource.on(event_types.GENERATION_STARTED, () => { streaming = true; });
    eventSource.on(event_types.GENERATION_STOPPED, () => { streaming = false; });
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        streaming = false;
        loadIndex().then(scheduleRenderAll);
    });
    startObserver();
    scheduleRenderAll();
    console.info(`[${MODULE}] ready (seg mode), words=${EMOTION_KEYS.length}`);
}

start().catch(e => console.error(`[${MODULE}] init error:`, e));
