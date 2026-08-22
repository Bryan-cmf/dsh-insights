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
| **Observation agent** | digest folding → incremental LLM observation on `turn/end` (deepseek-v4-flash) → rolling narrative / themes / milestones / suggested todos, persisted in the `observation` domain; a manual "re-observe" rewrites the full history in segments; a total failure never overwrites a good narrative (data protection) |
| **Insight agent** | floating chat at the bottom-right (deep-thinking max, expandable reasoning, coherent chat history), entirely in service of value / potential paths / direction; 【Suggest】 pushes an idea into the main composer in one click; concurrency gate (2 concurrent + FIFO + 60s timeout → 429) |
| **Memory agent** | every 3 turns, distills long-term memory from the recent trajectory; the LLM files it into modules: **setbacks / techniques / learning / decisions** (like a human brain: remember failures and profound events, technical sediment and discoveries); dedupes against recent memories |

## The four views (conversation view ring)

- **Observation** (order 20) — text-first: observation narrative / milestones and a whole-project overview on top; overview stats, file activity, mechanism events, tool/skill TOP, recent executions sink to the bottom
- **Memory** (order 30) — smart memory modules, **strictly isolated per session** (no other session's rows mix in — since v0.10.0; `mem_save` rows are stamped with the calling session id; the legacy "aggregate by cwd" behaviour remains reachable via `?scope=project` on `/api/memories`) + four lenses over memory activity
- **Insights** (order 40) — value anchors (goals / tasks), auto insight cards (every 5 turns), value summary cards, a **direction-evolution** timeline, and a **potential-paths** generator (adoptable as todos or pushed to the composer); generated artifacts persist across page switches
- **Notes** (order 50) — handwritten todos / notes + one-click adoption of observation-suggested todos, auto-refreshed at turn end

**Extras** — a prompt optimizer (the composer's 「Optimize」 button), an insight FAB (readable in night mode, draggable anywhere), a **resizable insight panel** (drag the right / bottom / corner edges; size survives refresh), and first-class **Markdown rendering** everywhere prose is shown (observation narrative, memory modules, auto-insight, value summary, insight chat) via the same `MarkdownText` pipeline the main conversation uses.

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
