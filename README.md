# Emotion Rails

**Render a per-message emotion avatar rail beside character messages in SillyTavern, driven by `[word]` tags.**

English | [中文](#中文说明)

---

## Origin: built for an agent × TTS pipeline

This extension exists because in our local-agent ("Hermes") roleplay setup, **per-sentence TTS emotion control and custom expression avatars could not coexist**:

- Character reply lines start with cues like `[开心]`. The TTS side consumes **the same words** to switch per-sentence emotion reference audio — so avatars must be driven by that very word list. The official [Character Expressions](https://docs.sillytavern.app/extensions/expression-images/) extension is message-level only and uses a fixed English label set + classifier, so it can't hook into a shared custom vocabulary.
- The TTS browser extension injects its per-sentence player UI **inside** `.mes_text`. Any expression extension that rewrites `.mes_text` destroys it (and gets destroyed in return). Emotion Rails therefore renders as a sibling rail and never touches message text DOM.
- The agent replies through an OpenAI-compatible streaming endpoint; while streaming, its media-inclusion mechanism passes raw directives through as plain text, so images cannot be delivered that way — rendering must happen client-side, from the tags themselves. That is exactly what this extension does.
- Both sides fall back silently (the TTS backend quietly drops to neutral audio when an emotion word is missing; this extension quietly falls back to the fallback chip). Vocabulary drift between the two was painful to debug — hence one shared `emotions.json` with aliases as the single source of truth.

**You don't need any of that infrastructure**: Emotion Rails runs standalone with any word list you put in `emotions.json`.

Emotion Rails parses `[emotion-word]` cues at the start of your character's reply lines and renders a compact avatar rail beside each message segment. The word list, image mapping and aliases all live in **one `emotions.json`** — add or remove emotions without touching any code.

![preview](docs/preview.png)

## Features

- 🏷️ **Tag-driven**: lines starting with `[happy]`, `[害羞]`, … get their own avatar chip; unknown words silently fall back (whitelist → alias → fallback word).
- 🛤️ **Rail layout**: avatars stack vertically on the left of the message, text wraps naturally.
- 🧩 **Zero-intrusion**: the rail is a *sibling* of `.mes_text` — message text DOM is never rewritten, so markdown, quote styling, display-only regex and other extensions' per-message UI (e.g. TTS sentence players) keep working.
- 📦 **Data-driven**: whitelist, aliases and fallback are all defined in `emotions.json`. No hardcoded vocabulary.
- 🔁 **Always fresh**: full-history render on chat load; instant re-render on edit and swipe; consecutive duplicate words collapse into one chip.

## Install

In SillyTavern: **Extensions → Install extension**, paste this repository URL.

Manual alternative: clone into `data/<user-handle>/extensions/st-emotion-rails/`.

## Quick start

1. Create the asset folder: `data/<user-handle>/images/emotion-rails/`
2. Copy **one** example pack into it (`examples/zh/*` or `examples/en/*`), keeping the structure:
   ```
   emotion-rails/
   ├── emotions.json
   └── avatars/
       ├── happy.svg
       └── …
   ```
   Replace the placeholder SVGs with your own images later — any browser-renderable format works (`png`/`webp`/`svg`); either name files `<word>.png` or point to them explicitly in `emotions.json`.
3. Hard-refresh the SillyTavern page (**Ctrl+F5**).
4. Send a test message as the character, e.g. `[happy] Hello there!` — a chip should appear on the left.

## `emotions.json` format

```json
{
  "fallback": "calm",
  "happy":   { "img": "avatars/happy.svg" },
  "calm":    { "img": "avatars/calm.svg" },
  "aliases": { "glad": "happy", "pensive": "thinking" }
}
```

| Key | Meaning |
|---|---|
| `<word>` | Emotion word exactly as used inside `[...]`. Value: `{ "img": "<path relative to baseUrl>" }` |
| `aliases` | Extra words mapped to a canonical word (e.g. the model writes `[excited]` but you only have art for `happy`) |
| `fallback` | Word used for untagged lines and unrecognized words (overridden by the `defaultWord` setting if set) |

## Extension settings

Stored under `extension_settings.emotionRails`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `baseUrl` | `/user/images/emotion-rails/` | Where `emotions.json` and images live |
| `index` | `emotions.json` | Index file name |
| `defaultWord` | *(empty)* | Overrides `fallback` from the JSON |
| `showChip` | `true` | Show the word label under each avatar |
| `size` | `64` | Avatar size in px |

## For extension developers: the ST message contract

These cost us a debugging session — save yours:

- `CHARACTER_MESSAGE_RENDERED` / `MESSAGE_EDITED` / `MESSAGE_SWIPED` emit **positional args** `(messageId, type)` where `messageId` is the **array index** — not `{ messageId }`.
- Chat items have **no `id` field**; the array index *is* the message id.
- Message blocks locate via the bare attribute `.mes[mesid="<index>"]` — there are **no `data-*` attributes**.
- `GENERATION_ENDED` passes `chat.length` (not an index).
- Loading an existing chat fires **no render events** — rescan the whole chat yourself on `CHAT_CHANGED`/startup.

## Troubleshooting

- **No rail at all** → check the extension is enabled in the Extensions panel (a disabled entry persists server-side in `settings.json → extension_settings.disabledExtensions`; a hard refresh won't fix that). Then check the console for `[emotionRails]` logs and make sure `${baseUrl}emotions.json` returns HTTP 200.
- **Tags stay visible but no new chip appears** → the word isn't whitelisted and has no alias; the line falls back to the fallback word's chip. Add the word or an alias.

Tested on SillyTavern **1.18.x**. If it works (or breaks) on another version, an issue is appreciated.

## License

[MIT](LICENSE)

---

# 中文说明

**在 SillyTavern 里，按角色台词行首的 `[情绪词]` 标签，在消息旁边渲染一条头像侧栏。**

## 缘起：为 agent × TTS 联动而生

本插件源于本地 agent（Hermes）驱动的酒馆 RP 场景：**逐句 TTS 情绪控制与自定义表情头像无法共存**——

- 角色台词行首带 `[开心]` 这类情绪词，TTS 侧用**同一套词**切换逐句情绪参考音频——头像必须吃同一份词表。官方 [Character Expressions](https://docs.sillytavern.app/extensions/expression-images/) 是消息级整图 + 固定英文标签集 + 分类器路线，接不上自定义共享词表。
- TTS 扩展会在 `.mes_text` **内部**注入逐句播放按钮；任何改写 `.mes_text` 的表情扩展都会与它互相毁灭。Emotion Rails 因此以兄弟节点侧栏渲染，正文 DOM 零改动。
- agent 走 OpenAI 兼容流式接口回复；流式下其媒体内嵌机制会把原始指令当纯文本透传，图片没法走那条路——渲染只能在酒馆前端由标签驱动完成，这正是本插件做的事。
- 两端都有静默回落（TTS 后端情绪词缺失时悄悄退回中性音色；本插件未识别词悄悄退回兜底 chip），两边词表一旦漂移极难排查——所以用一份带别名的 `emotions.json` 作为唯一真源。

**不搭这套基础设施也完全能用**：Emotion Rails 单独即可运行，`emotions.json` 词表随你放。

## 特性

- 🏷️ **标签驱动**：`[开心]` `[惊讶]` 等行首标签各自出头像 chip；词表外词汇按 白名单→别名→兜底词 静默回落。
- 🛤️ **侧栏布局**：头像沿消息左侧竖排，正文自然环绕。
- 🧩 **零侵入**：轨道是 `.mes_text` 的**兄弟节点**，从不改写消息正文 DOM——Markdown、引用样式、仅显示 regex 以及其它扩展的消息内 UI（如 TTS 逐句播放按钮）完全不受影响。
- 📦 **数据驱动**：白名单/别名/兜底词全部在一个 `emotions.json` 里，增删情绪不改代码。
- 🔁 **始终新鲜**：聊天加载全历史补渲染；编辑/滑动即时重渲染；连续同词折叠成一个 chip。

## 安装

酒馆 → 扩展面板 → Install extension，粘贴本仓库地址；或手动克隆到 `data/<用户>/extensions/st-emotion-rails/`。

## 快速上手

1. 建素材目录 `data/<用户>/images/emotion-rails/`
2. 拷入任意一套示例包（`examples/zh/*` 或 `examples/en/*`），保持 `emotions.json + avatars/` 结构；之后可随时把占位 SVG 换成自己的 png/webp 图（文件名 `<词>.png` 或在 json 里显式指定）。
3. **Ctrl+F5** 硬刷新页面。
4. 让角色发一条 `[开心] 测试消息` —— 左侧应出现头像 chip。

## `emotions.json` 格式

```json
{
  "fallback": "平静",
  "开心": { "img": "avatars/开心.svg" },
  "aliases": { "高兴": "开心", "沉思": "思考" }
}
```

- `<词>`：与方括号里写的字面一致；值为 `{ "img": "相对 baseUrl 的路径" }`
- `aliases`：别名 → 规范词（模型输出 `[激动]` 但你只有「开心」的图时很有用）
- `fallback`：无标签行与未识别词的兜底词（设置里的 `defaultWord` 可覆盖它）

## 排障

- **完全不显示** → 先看扩展面板是否被禁用（禁用状态持久化在服务器 `settings.json` 的 `disabledExtensions` 里，硬刷新无效）；再看 console 有没有 `[emotionRails]` 日志；最后确认 `${baseUrl}emotions.json` 返回 200。
- **标签还留在正文里但没出新 chip** → 该词不在白名单也无别名，已按兜底词回落；加词或加别名即可。

已在 SillyTavern **1.18.x** 实测；其它版本欢迎反馈 issue。

## 许可

[MIT](LICENSE)
