# @bryan-cmf/dsh-insights

[English](README.md) | [中文](README.zh.md)

**A value-oriented observation / insight / memory pipeline for DeepSeek Harness — a four-in-one plugin, actively iterated.**

Conversation → trajectory → observation (narrative & milestones) → insight (value-oriented) → suggestions → back into the main composer.
Technology serves value — so the programmer never loses the thread.

## Three agents

| Agent | Responsibility |
|---|---|
| **Observation agent** | digest folding → incremental LLM observation on `turn/end` (deepseek-v4-flash) → rolling narrative / themes / milestones / suggested todos, persisted in the `observation` domain; manual "re-observe" rewrites the full history in segments; a total failure never overwrites a good narrative (data protection) |
| **Insight agent** | floating chat at the bottom-right (deep-thinking max, expandable reasoning, coherent chat history), entirely in service of value / potential paths / direction; 【Suggest】 pushes an idea into the main composer in one click; concurrency gate (2 concurrent + FIFO + 60s timeout → 429) |
| **Memory agent** | every 3 turns, distills long-term memory from the recent trajectory; the LLM files it into modules: **setbacks / techniques / learning / decisions** (like a human brain: remember failures and profound events, technical sediment and discoveries); dedupes against recent memories |

## Four views (conversation view ring)

- **Observation** (order 20) — text-first: observation narrative / milestones and a whole-project overview on top; overview stats, file activity, mechanism events, tool/skill TOP, recent executions sink to the bottom
- **Memory** (order 30) — smart memory modules (**strictly isolated per session** — no other session's rows mix in [since v0.10.0; the old "aggregate by cwd" mode is reachable via `?scope=project` on `/api/memories`], `mem_save` rows stamped with their session id) + four lenses over memory activity
- **Insights** (order 40) — value anchors (goals / tasks), auto insight cards (every 5 turns), value summary cards, a **direction-evolution** timeline, and a **potential-paths** generator (adoptable as todos or pushed to the composer); generated artifacts persist across page switches
- **Notes** (order 50) — handwritten todos / notes + one-click adoption of observation-suggested todos, auto-refreshed at turn end

Extras: a prompt optimizer (the composer's「Optimize」button), an insight FAB (readable in night mode, draggable), a **resizable insight panel** (drag right/bottom/corner edges; size survives refresh), and first-class **Markdown rendering** everywhere prose is shown (observation narrative, memory modules, auto-insight, value summary, insight chat) via the same `MarkdownText` pipeline the main conversation uses.

## Error taxonomy

Tool errors are classified as `policy` (sandbox / approval / FS-policy blocks — beneficial protection working as designed; counted, never surfaced), `transient` (restarts / network / rate limits — at most one hint), and `real` (actual pitfalls — aggregated per tool, automatically written to memory tagged「setback」). Only profound events make it into memory.

## Platform surface

- **Tools**: `mem_save` / `mem_search` / `mem_health`, `usage_report` / `audit_skills` / `infra_health`
- **Service**: `vectorMemory` (injectable by other plugins)
- **Session projections**: `infraView`, `memActivity`, `fileActivity`, `mechEvents`, `goalTrace`, `insightsScan`
- **HTTP routes**: `/api/observation`, `/api/observation/rebuild`, `/api/observations`, `/api/notes`, `/api/prompt/optimize`, `/api/insight/summary`, `/api/insight/paths`, `/api/insight/chat`, `/api/memories`
- **Persistence domains**: `vector_memory`, `observation`, `session_notes`
- **No maxTokens caps on LLM calls**: requests omit `max_tokens` unless the provider sets one — the model decides its own output length; JSON parsing ships brace-aware balanced extraction + control-char sanitization + section salvage as fallbacks

## Install (profile)

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "@bryan-cmf/dsh-insights": "^0.8.0" },
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

## License

MIT
