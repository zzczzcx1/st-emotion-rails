#!/usr/bin/env node
/**
 * Generates the bundled example packs under examples/zh and examples/en:
 *   - avatars/<word>.svg   simple colored placeholder faces (no deps)
 *   - emotions.json        word -> image map + aliases + fallback
 * Single source of truth: the PACKS table below. Re-run after editing.
 *   node scripts/gen_placeholders.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** mouth: smile | small-smile | flat | o | frown | smirk */
const PACKS = {
    zh: {
        fallback: '平静',
        words: [
            ['开心', '#f6c945', 'smile'],
            ['平静', '#7aa2f7', 'flat'],
            ['惊讶', '#ff9e64', 'o'],
            ['害羞', '#ff75a0', 'small-smile'],
            ['生气', '#f7768e', 'frown'],
            ['悲伤', '#5d7ec8', 'frown'],
            ['思考', '#9ece6a', 'flat'],
            ['困惑', '#56b6c2', 'squiggle'],
            ['得意', '#41d19a', 'smirk'],
            ['委屈', '#c586c0', 'frown'],
        ],
        aliases: { 高兴: '开心', 激动: '开心', 沉思: '思考', 迷茫: '困惑', 不悦: '生气', 伤心: '悲伤' },
    },
    en: {
        fallback: 'calm',
        words: [
            ['happy', '#f6c945', 'smile'],
            ['calm', '#7aa2f7', 'flat'],
            ['surprised', '#ff9e64', 'o'],
            ['shy', '#ff75a0', 'small-smile'],
            ['angry', '#f7768e', 'frown'],
            ['sad', '#5d7ec8', 'frown'],
            ['thinking', '#9ece6a', 'flat'],
            ['confused', '#56b6c2', 'squiggle'],
            ['proud', '#41d19a', 'smirk'],
            ['hurt', '#c586c0', 'frown'],
        ],
        aliases: { glad: 'happy', excited: 'happy', pensive: 'thinking', lost: 'confused', upset: 'angry', unhappy: 'sad' },
    },
};

const MOUTHS = {
    smile: `M38 47 q10 9 20 0`,
    'small-smile': `M41 48 q7 5 14 0`,
    flat: `M40 48 h16`,
    o: `<circle cx="48" cy="49" r="4" fill="#334155"/>`,
    frown: `M39 51 q9 -8 18 0`,
    smirk: `M40 49 q9 6 17 -1`,
    squiggle: `M39 49 q4 -4 8 0 q4 4 8 0`,
};

function svg(word, color, mouth) {
    const mouthEl = MOUTHS[mouth] === MOUTHS.o
        ? MOUTHS.o
        : `<path d="${MOUTHS[mouth]}" stroke="#334155" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="18" fill="${color}"/>
  <circle cx="48" cy="42" r="21" fill="#ffffff" opacity=".93"/>
  <circle cx="41" cy="38" r="3.2" fill="#334155"/>
  <circle cx="55" cy="38" r="3.2" fill="#334155"/>
  ${mouthEl}
  <text x="48" y="85" font-family="sans-serif" font-size="15" font-weight="700" fill="#ffffff" text-anchor="middle">${word}</text>
</svg>
`;
}

for (const [lang, pack] of Object.entries(PACKS)) {
    const dir = join(ROOT, 'examples', lang);
    mkdirSync(join(dir, 'avatars'), { recursive: true });
    const json = { fallback: pack.fallback };
    for (const [word, color, mouth] of pack.words) {
        writeFileSync(join(dir, 'avatars', `${word}.svg`), svg(word, color, mouth), 'utf8');
        json[word] = { img: `avatars/${word}.svg` };
    }
    json.aliases = pack.aliases;
    writeFileSync(join(dir, 'emotions.json'), JSON.stringify(json, null, 1) + '\n', 'utf8');
    console.log(`${lang}: ${pack.words.length} words, ${Object.keys(pack.aliases).length} aliases -> examples/${lang}`);
}
