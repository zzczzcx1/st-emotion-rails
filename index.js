/*!
 * Emotion Rails (st-emotion-rails) v1.0.0
 * Renders an avatar rail beside character messages, driven by [emotion-word]
 * tags at line starts. The rail is a sibling of .mes_text — message text DOM
 * is never touched, so markdown rendering and other extensions' per-message
 * UI (e.g. TTS sentence players) keep working untouched.
 *
 * Origin: built for an agent-driven RP+TTS pipeline (a local "Hermes" agent).
 * Reply lines start with [emotion-word]; a TTS extension switches per-sentence
 * emotion reference audio by the SAME words and injects player UI inside
 * .mes_text, while the agent streams replies (so its media-inclusion path is
 * unavailable). Message-level expression extensions — or anything rewriting
 * .mes_text — could not coexist with that setup; this zero-intrusion renderer
 * with a shared emotions.json vocabulary is the fix. It also runs standalone.
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
 *  - Loading an existing chat does NOT fire render events — re-scan the
 *    whole chat on CHAT_CHANGED / startup.
 */
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { eventSource, event_types } from '../../../events.js';

const MODULE = 'emotionRails';

let EMOTIONS = {};        // { word: {img} }
let ALIASES = {};         // { alias: canonical word }
let EMOTION_KEYS = [];
let FALLBACK_WORD = null; // settings.defaultWord > json.fallback > first key

function defaultSettings() {
    return {
        enabled: true,
        baseUrl: '/user/images/emotion-rails/',
        index: 'emotions.json',
        defaultWord: '',   // language-neutral: resolved via FALLBACK_WORD
        showChip: true,    // show the word label under each avatar
        size: 64,          // rail avatar size in px
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

/* Find the first bracket group on the line that hits the whitelist (or an
   alias, which is mapped back to its canonical word). */
function findEmotion(line) {
    const groups = String(line).match(/\[([^\[\]]{1,12})\]/g) || [];
    for (const g of groups) {
        const w = g.slice(1, -1).trim();
        if (!w) continue;
        if (EMOTION_KEYS.includes(w)) return w;
        if (ALIASES[w] && EMOTIONS[ALIASES[w]]) return ALIASES[w];
    }
    return null;
}

function parseSegments(text, fallbackWord) {
    const lines = String(text).split('\n');
    const segs = [];
    let cur = null;
    for (let raw of lines) {
        const line = raw.trim();
        if (line === '') continue;
        const tag = line.startsWith('[') ? findEmotion(line) : null;
        const body = line.replace(/^(\[[^\[\]]{1,12}\])+/, '').trim(); // strip ALL leading bracket groups
        const content = body || line;
        if (tag) {
            cur = { tag, lines: [content] };
            segs.push(cur);
        } else if (cur) {
            cur.lines.push(content);
        } else {
            segs.push({ tag: fallbackWord, lines: [content] });
        }
    }
    return segs.filter(s => s.lines.some(l => l !== ''));
}

function imgUrl(word, s) {
    const e = EMOTIONS[word] || {};
    return `${s.baseUrl}${e.img || encodeURIComponent(word) + '.png'}`;
}

function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildRailHtml(segs, s) {
    const chips = [];
    let lastWord = null;
    for (const seg of segs) {
        const word = EMOTION_KEYS.includes(seg.tag) ? seg.tag : FALLBACK_WORD;
        if (!word || word === lastWord) continue; // collapse consecutive duplicates
        lastWord = word;
        const label = s.showChip ? `<span class="er-chip-label">${escapeHtml(word)}</span>` : '';
        chips.push(`<div class="er-chip" data-word="${escapeHtml(word)}" title="${escapeHtml(word)}">
            <img class="er-chip-img" src="${imgUrl(word, s)}" width="${Number(s.size) || 64}" height="${Number(s.size) || 64}" alt="${escapeHtml(word)}">${label}
        </div>`);
    }
    return `<div class="er-rail">${chips.join('')}</div>`;
}

function buildEl(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

/**
 * Render the rail for one character message by array index.
 * Idempotent: an existing rail is rebuilt in place (no dirty-flag guard,
 * so edits/swipes always refresh).
 */
function renderRail(messageIndex) {
    const i = Number(messageIndex);
    if (!Number.isInteger(i) || i < 0) return;
    const s = getExtensionSettings(MODULE);
    if (!s.enabled || !FALLBACK_WORD) return;
    let mes;
    try {
        mes = (getContext().chat ?? [])[i];
    } catch (e) { return; }
    if (!mes || mes.is_user) return;
    const el = document.querySelector(`.mes[mesid="${i}"]`);
    if (!el) return;
    const inner = el.querySelector('.mes_text');
    if (!inner || !inner.parentNode) return;
    const rail = inner.parentNode.querySelector(':scope > .er-rail'); // only our own, direct child
    const html = buildRailHtml(parseSegments(mes.mes, FALLBACK_WORD), s);
    if (rail) rail.outerHTML = html;
    else inner.insertAdjacentElement('beforebegin', buildEl(html));
}

/* Chat loading fires no render events — scan every character message. */
function renderAll() {
    if (!FALLBACK_WORD) return;
    let chat;
    try { chat = getContext().chat ?? []; } catch (e) { return; }
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i]?.is_user) renderRail(i);
    }
}

/* Printing order vs CHAT_CHANGED timing varies; triple-fire is idempotent */
function scheduleRenderAll() {
    renderAll();
    requestAnimationFrame(renderAll);
    setTimeout(renderAll, 400);
}

function onMessageEvent(messageId) { renderRail(messageId); }

function onGenerationEnded() {
    try {
        const ctx = getContext();
        const i = (ctx.chat?.length ?? 1) - 1; // emit arg is chat.length, not an index
        if (i >= 0) renderRail(i);
    } catch (e) { /* ignore */ }
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
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, () => { loadIndex().then(scheduleRenderAll); });
    scheduleRenderAll();
    console.info(`[${MODULE}] ready (rail mode), words=${EMOTION_KEYS.length}`);
}

start().catch(e => console.error(`[${MODULE}] init error:`, e));
