import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(ROOT, 'index.js');
let source = readFileSync(sourcePath, 'utf8')
    .replace(/^import .*?;\r?\n/gm, '')
    .replace(/\r?\nstart\(\)\.catch\([^\n]+\);\s*$/, '\n');
source += '\nexport { fallbackOf, findEmotion, getIndex, imgUrl, normalizeBaseUrl, parseIndex };\n';
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const core = await import(moduleUrl);

test('per-character images resolve beside the character index', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        return {
            ok: true,
            async json() {
                return { fallback: 'happy', happy: { img: 'avatars/happy.png' } };
            },
        };
    };

    const settings = { baseUrl: '/user/images/emotion-rails', index: 'emotions.json', perCharacter: true };
    const idx = await core.getIndex('Alice Smith', settings);
    assert.equal(requested[0], '/user/images/emotion-rails/Alice%20Smith/emotions.json');
    assert.equal(idx.baseUrl, '/user/images/emotion-rails/Alice%20Smith/');
    assert.equal(core.imgUrl('happy', { ...settings, idx }), '/user/images/emotion-rails/Alice%20Smith/avatars/happy.png');
});

test('empty character index falls back to the global vocabulary', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        return {
            ok: true,
            async json() {
                return String(url).includes('/Bob/')
                    ? { aliases: { glad: 'happy' } }
                    : { fallback: 'calm', calm: { img: 'calm.svg' } };
            },
        };
    };

    const settings = { baseUrl: '/test-empty/', index: 'emotions.json', perCharacter: true };
    const idx = await core.getIndex('Bob', settings);
    assert.deepEqual(requested, ['/test-empty/Bob/emotions.json', '/test-empty/emotions.json']);
    assert.equal(idx.baseUrl, '/test-empty/');
    assert.equal(core.imgUrl('calm', { ...settings, idx }), '/test-empty/calm.svg');
});

test('cache keys include the configured base URL', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        return { ok: true, async json() { return { calm: { img: 'calm.png' } }; } };
    };

    await core.getIndex('CacheTest', { baseUrl: '/cache-a/', index: 'emotions.json', perCharacter: true });
    await core.getIndex('CacheTest', { baseUrl: '/cache-b/', index: 'emotions.json', perCharacter: true });
    assert.deepEqual(requested, ['/cache-a/CacheTest/emotions.json', '/cache-b/CacheTest/emotions.json']);
});

test('only leading bracket groups can select an emotion', () => {
    const idx = core.parseIndex({
        fallback: 'calm',
        calm: { img: 'calm.png' },
        happy: { img: 'happy.png' },
        aliases: { glad: 'happy' },
    }, '/assets/');
    assert.equal(core.findEmotion('[Name][glad] Hello', idx), 'happy');
    assert.equal(core.findEmotion('[Name][scene] Hello [happy]', idx), null);
    assert.equal(core.fallbackOf(idx, { defaultWord: 'glad' }), 'happy');
    assert.equal(core.imgUrl('happy', { idx, baseUrl: '/ignored/' }), '/assets/happy.png');
});

test('manifest and bundled example references are release-ready', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '2.1.1');
    assert.equal(manifest.auto_update, true);
    assert.match(manifest.homePage, /^https:\/\/github\.com\//);
    assert.equal(manifest.minimum_client_version, '1.18.0');

    for (const language of ['en', 'zh']) {
        const packDir = join(ROOT, 'examples', language);
        const pack = JSON.parse(readFileSync(join(packDir, 'emotions.json'), 'utf8'));
        assert.ok(pack[pack.fallback]);
        for (const [word, value] of Object.entries(pack)) {
            if (word === 'fallback' || word === 'aliases') continue;
            assert.equal(typeof value.img, 'string');
            assert.ok(existsSync(join(packDir, value.img)), `${language}/${value.img} should exist`);
        }
    }
});
