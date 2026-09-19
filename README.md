# @bryan-cmf/dsh-insights

<div align="center">

🌐 **English** · <a href="./README.zh.md">繁體中文</a>

A value-oriented observation / insight / memory pipeline for DeepSeek Harness — a single plugin, actively iterated.

[![npm version](https://img.shields.io/npm/v/@bryan-cmf/dsh-insights)](https://www.npmjs.com/package/@bryan-cmf/dsh-insights)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

## What it does

Conversation → trajectory → observation (narrative & milestones) → insight (value-oriented) → suggestions → back into the main composer. Technology serves value — so the programmer never loses the thread.

## The three agents

| Agent | Responsibility |
|---|---|
| **Observation agent** | digest folding → incremental LLM observation on `turn/end` (deepseek-v4-flash) → rolling narrative / themes / milestones, persisted in the `observation` domain. Since v0.12.0 it only observes sessions that reached **≥ 2 turns** (measured: 96% of records came from single-turn sessions) and the memory field rides along in the same call every 3rd turn — one LLM call per observed turn, no separate memory agent. A manual "re-observe" rewrites the full history in segments; a total failure never overwrites a good narrative (data protection) |
| **Memory agent** | folded into the observation call since v0.12.0 (every 3rd observed turn) — the LLM files long-term memory into modules: **setbacks / techniques / learning / decisions** (like a human brain: remember failures and profound events, technical sediment and discoveries); dedupes against recent memories. Tool failures no longer sediment into memory (measured: 42% of all rows were 「tool X failed」 noise) — the scan view still surfaces them live |

## The four views (conversation view ring)

- **Observation** (order 20) — text-first: observation narrative / milestones and a whole-project overview on top; overview stats, file activity, mechanism events, tool/skill TOP, recent executions sink to the bottom
- **Memory** (order 30) — smart memory modules, **strictly isolated per session** (no other session's rows mix in — since v0.10.0; `mem_save` rows are stamped with the calling session id; the legacy "aggregate by cwd" behaviour remains reachable via `?scope=project` on `/api/memories`) + four lenses over memory activity
- **Insights** (order 40) — value anchors (goals / tasks), value summary cards, a **direction-evolution** timeline, and a **potential-paths** generator (adoptable as todos or pushed to the composer); generated artifacts persist across page switches. Auto insight (a periodic LLM call every 5 turns) is **off by default** since v0.12.0 — measured at 35 outputs in 35 days — and can be re-enabled with `autoInsight: true`
- **Notes** (order 50) — handwritten todos and **Markdown-rendered notes** (a multi-line composer, Enter to submit / Shift+Enter for a newline), auto-refreshed at turn end. Select any text in the conversation and a 「＋ Add to notes」 button appears next to the selection — one click files it into the current session's notes (tables, code blocks and lists are preserved as Markdown)

**Extras** — a prompt optimizer (the composer's 「Optimize」 button), **select-to-note** (dark-mode-safe floating button, touch-friendly, Escape to dismiss), and first-class **Markdown rendering** everywhere prose is shown (observation narrative, memory modules, notes, auto-insight, value summary) via the same `MarkdownText` pipeline the main conversation uses.

## Error taxonomy

Tool errors are classified as `policy` (sandbox / approval / FS-policy blocks — beneficial protection working as designed; counted, never surfaced), `transient` (restarts / network / rate limits — at most one hint), and `real` (actual pitfalls — aggregated per tool, automatically written to memory tagged 「setback」). Only profound events make it into memory.

## Platform surface

- **Tools**: `mem_save` / `mem_search` / `mem_health`, `usage_report` / `audit_skills` / `infra_health`
- **Service**: `vectorMemory` (injectable by other plugins)
- **Session projections**: `infraView`, `memActivity`, `fileActivity`, `mechEvents`, `goalTrace`, `insightsScan`
- **HTTP routes**: `/api/observation`, `/api/observation/rebuild`, `/api/observations`, `/api/notes`, `/api/prompt/optimize`, `/api/insight/summary`, `/api/insight/paths`, `/api/insight/chat`, `/api/memories`
- **Persistence domains**: `vector_memory`, `observation`, `session_notes`, `insight_chat`
- **No maxTokens caps on LLM calls**: requests omit `max_tokens` unless the provider sets one — the model decides its own output length; JSON parsing ships brace-aware balanced extraction + control-char sanitization + section salvage as fallbacks

## Install (profile)

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "@bryan-cmf/dsh-insights": "^0.10.0" },
  "dsh": { "profile": { "bundles": ["@bryan-cmf/dsh-insights"] } }
}
```

Restart `dsh web` to apply. (During development you may point the dependency at a local checkout via `file:/path/to/dsh-insights`.)

## Development

```bash
pnpm install        # fresh clone
pnpm build          # clean + types (tsc) + bundle (tsdown) → lib/
node scripts/smoke-host.mjs   # host-structure smoke test: 9 routes / 6 projections / 6 tools / 1 service + storage-domain singleton assertions
```

Source layout: host entry `src/index.ts` (merged Config + union of injects); feature modules under `src/host/` (infra / memory / perspectives / insight / domains); client entry `src/client/index.ts`, view modules under `src/client/` (observation-view / memory-view / insights-views / insight-float).

## Version history

| Version | Highlights |
|---|---|
| v0.12.1 | Fix "selecting a table and adding it to notes produced a wall of text": the selection is now walked as DOM and rebuilt into Markdown — tables become GFM tables (header row synthesised when not selected, pipes escaped), code blocks become fenced blocks, lists / headings / inline code, bold and links are restored. 12 regression tests cover partial-row selections, missing headers and mixed content |
| v0.12.0 | **Subtraction release** (evidence-driven, 35-day usage review): auto insight off by default; observation only for sessions ≥ 2 turns (also gated before the initial chronicle, killing ~2.7k wasted calls per 35 days); memory field merged into the observation call (no separate memory agent); tool failures no longer written to memory (1,279 noise rows eliminated); `hits` dead field and `suggestedTodos` generation removed; insight FAB (used 4 times in 35 days) and the `/api/insight/chat` route removed; **notes now render Markdown** with a multi-line composer; new **select-to-note** button. Also fixed a state race: session replay could overwrite live fold state, resetting turn counters |
| v0.11.0 | Settings page 「memory data」 dashboard — taxonomy / params / growth trend via `/api/memory/stats` |
| v0.10.1 | Mobile fix: FAB / panel head / resize handles now use Pointer Events + `touch-action: none` — dragging works with touch instead of being treated as page scroll |
| v0.10.0 | Strict per-session memory isolation; native Markdown rendering via the official `MarkdownText` pipeline; resizable insight panel |
| v0.9.0 | Draggable insight FAB (position persisted) |
| v0.8.0 | Insight chat history persisted (`insight_chat` domain, per session) |
| v0.7.0 | JSON parse-plague fix; memory isolation by project (cwd); per-project memory view |
| v0.6.0 | FAB night-mode fix; memory taxonomy overhaul (setbacks / techniques / learning / decisions) |
| v0.5.x | Persisted value summary & potential paths; memory agent (every 3 turns) + `/api/memories` |
| v0.4.x | Direction-evolution timeline; potential-paths generator; brace-aware JSON extraction |
| v0.3.x | Value-focused layouts; coherent chat history; all `maxTokens` caps removed |
| v0.2.0 | Error taxonomy (policy / transient / real); insights repositioned to value / direction |
| v0.1.0 | First unified single-bundle release; published; storage-domain singleton fix |

## License

MIT
