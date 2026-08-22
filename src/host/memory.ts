/**
 * dsh-insights · memory 模組(原 @bryan-cmf/dsh-vector-memory host)。
 *
 * Durable agent memory core. Memories live in a `vector_memory` storageDomain
 * (durable JSON backend — survives process restarts), exposed through the
 * classic `mem_save` / `mem_search` / `mem_health` tool contract and a
 * `vectorMemory` service other plugins can inject.
 *
 * Retrieval (v1) is deterministic keyword scoring over content + tags with a
 * recency bonus — no external vector stack. Embedding backends (Qdrant,
 * hosted embedders) are a pluggable v2 concern; the store layout is
 * backend-agnostic by design.
 *
 * The client half renders a 「記憶」view tab from the `memActivity` projection.
 */
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { openVectorMemoryDomain } from './domains.ts'

/** memory 模組的 config 切片(入口的合併 Config 結構上滿足此介面)。 */
export interface MemoryConfig {
  ttlDays: number
  maxResults: number
}

// ── memory record ───────────────────────────────────────────────────────────

interface MemoryRecord {
  id: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  hits: number
  /** 0 = never expires. */
  expiresAt: number
  /** 寫入此記憶的 session id(mem_save 工具擷取自執行上下文;供記憶頁嚴格隔離)。 */
  sid?: string
}

interface MemoryHit {
  id: string
  content: string
  tags: string[]
  score: number
  createdAt: number
}

// ── structural service views ────────────────────────────────────────────────

interface DomainLike {
  close(): Promise<void>
  table(key: string): TableLike
}
interface TableLike {
  get(key: string): MemoryRecord | undefined
  entries(): IterableIterator<[string, MemoryRecord]>
  readonly size: number
  put(key: string, value: MemoryRecord): Promise<void>
}
interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}
interface ObsCtx {
  storageDomain: StorageDomainLike
}

// ── helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `mem-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
}

/** Deterministic keyword score: token overlap + tag hits + mild recency. */
function score(record: MemoryRecord, tokens: string[], now: number): number {
  if (tokens.length === 0) return 0
  const haystack = `${record.content} ${record.tags.join(' ')}`.toLowerCase()
  let overlap = 0
  for (const t of tokens) {
    if (haystack.includes(t)) overlap += 1
  }
  if (overlap === 0) return 0
  const ageDays = Math.max(0, (now - record.createdAt) / 86400000)
  const recency = 1 / (1 + ageDays / 30)
  return overlap / tokens.length + 0.3 * recency
}

export function applyMemory(ctx: Context, config: MemoryConfig): void {
  const obs = ctx as unknown as ObsCtx
  let table: TableLike | undefined
  let openError = ''

  async function ensureTable(): Promise<TableLike> {
    if (table) return table
    try {
      // 域 open 收攏為插件級單例(同 ctx 重複 open 同名域會拋 DomainError)
      const domain = await openVectorMemoryDomain(obs.storageDomain)
      ctx.effect(() => () => { void domain.close() }, 'vector_memory.domain')
      table = domain.table('memories') as TableLike
      openError = ''
    } catch (error) {
      openError = String(error)
      throw error
    }
    return table
  }

  async function save(content: string, tags: string[], ttlDays: number, sid?: string): Promise<{ id: string; createdAt: number }> {
    const t = await ensureTable()
    const now = Date.now()
    const record: MemoryRecord = {
      id: nextId(),
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      hits: 0,
      expiresAt: ttlDays > 0 ? now + ttlDays * 86400000 : 0,
      ...(typeof sid === 'string' && sid !== '' ? { sid } : {}),
    }
    await t.put(record.id, record)
    return { id: record.id, createdAt: now }
  }

  async function search(query: string, limit: number): Promise<MemoryHit[]> {
    const t = await ensureTable()
    const now = Date.now()
    const tokens = tokenize(query)
    const hits: MemoryHit[] = []
    for (const [id, record] of t.entries()) {
      if (record.expiresAt !== 0 && record.expiresAt <= now) continue
      const s = score(record, tokens, now)
      if (s > 0) hits.push({ id, content: record.content, tags: record.tags, score: s, createdAt: record.createdAt })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  // ── memActivity projection (session's memory activity for the view tab) ───
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    ;(projectionCtx as unknown as { sessionProjections: { register(d: unknown): unknown } }).sessionProjections.register({
      key: 'memActivity',
      /** Projection schemas must be zod (schemastery objects have no .parse). */
      schema: zod.object({
        items: zod.array(zod.object({ seq: zod.number(), kind: zod.string(), text: zod.string(), ok: zod.boolean() })),
      }),
      init: () => ({ items: [], pending: {} }),
      apply: (state: { items: Array<{ seq: number; kind: string; text: string; ok: boolean }>; pending: Record<string, { kind: string; text: string }> }, event: { type: string; seq?: number; data?: unknown }) => {
        if (event.type === 'tool/call') {
          const d = event.data as { callId: string; name: string; arguments: string }
          if (d.name !== 'mem_save' && d.name !== 'mem_search') return state
          let text = ''
          try {
            const parsed = JSON.parse(d.arguments) as Record<string, unknown>
            text = typeof parsed.content === 'string' ? parsed.content : typeof parsed.query === 'string' ? parsed.query : ''
          } catch {
            text = ''
          }
          return { ...state, pending: { ...state.pending, [d.callId]: { kind: d.name, text: text.slice(0, 200) } } }
        }
        if (event.type === 'tool/result') {
          const d = event.data as { message?: { content?: Array<{ toolCallId?: string }> }; error?: unknown }
          const callId = d.message?.content?.[0]?.toolCallId
          let pendingKey = ''
          if (typeof callId === 'string' && state.pending[callId] !== undefined) {
            pendingKey = callId
          } else {
            pendingKey = Object.keys(state.pending)[0] ?? ''
          }
          if (pendingKey === '') return state
          const pending = state.pending[pendingKey]
          if (!pending) return state
          const remaining = { ...state.pending }
          delete remaining[pendingKey]
          const item = { seq: event.seq ?? 0, kind: pending.kind, text: pending.text, ok: d.error === undefined || d.error === null }
          const items = [...state.items, item]
          if (items.length > 50) items.shift()
          return { ...state, pending: remaining, items }
        }
        return state
      },
      view: (state: { items: Array<{ seq: number; kind: string; text: string; ok: boolean }> }) => ({ items: state.items }),
      stateVersion: 1,
    })
  })

  // ── tools ─────────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mem_save',
    description: 'Save a durable memory (cross-session, survives restarts). Returns the memory id.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory content to store.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for retrieval.' },
      ttlDays: { type: 'number', description: 'Override TTL in days (0 = forever). Defaults to config.' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args, exec) {
      if (typeof args.content !== 'string' || args.content.trim() === '') {
        return 'ERROR: content must be a non-empty string'
      }
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : []
      const ttl = typeof args.ttlDays === 'number' && args.ttlDays >= 0 ? Math.floor(args.ttlDays) : config.ttlDays
      // 擷取呼叫方 session id(agent.id 即 SessionId),讓記憶頁可按 session 隔離展示
      const execCtx = exec as { agent?: { id?: unknown } } | undefined
      const sid = execCtx && execCtx.agent && typeof execCtx.agent.id === 'string' ? execCtx.agent.id : undefined
      try {
        const saved = await save(args.content.trim(), tags, ttl, sid)
        return `saved memory ${saved.id} at ${new Date(saved.createdAt).toISOString()} (ttl: ${ttl === 0 ? 'forever' : `${ttl}d`})`
      } catch (error) {
        return `ERROR: memory store unavailable: ${String(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_search',
    description: 'Search saved memories by keyword relevance (content + tags, recency-weighted).',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      limit: { type: 'number', description: 'Max results (default from config).' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        return 'ERROR: query must be a non-empty string'
      }
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : config.maxResults
      try {
        const hits = await search(args.query.trim(), limit)
        if (hits.length === 0) return 'no matching memories'
        const lines = hits.map((h, i) =>
          `${i + 1}. [${h.id}] (score ${h.score.toFixed(2)}${h.tags.length ? `, tags: ${h.tags.join(',')}` : ''})\n   ${h.content.slice(0, 300)}`,
        )
        return lines.join('\n')
      } catch (error) {
        return `ERROR: memory store unavailable: ${String(error)}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mem_health',
    description: 'Memory store health: record count, domain status, expiry policy.',
    parameters: {},
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute() {
      try {
        const t = await ensureTable()
        const now = Date.now()
        let expired = 0
        for (const [, record] of t.entries()) {
          if (record.expiresAt !== 0 && record.expiresAt <= now) expired += 1
        }
        return [
          `records: ${t.size}`,
          `expired (lazy): ${expired}`,
          `domain: vector_memory (storageDomain, version 1)`,
          `ttl default: ${config.ttlDays === 0 ? 'forever' : `${config.ttlDays}d`}`,
          openError !== '' ? `open error: ${openError}` : 'status: ok',
        ].join('\n')
      } catch (error) {
        return `ERROR: memory store unavailable: ${String(error)}`
      }
    },
  }))

  // ── public service for other plugins ──────────────────────────────────────
  ctx.provide('vectorMemory', {
    save,
    search,
    health: async () => {
      const t = await ensureTable()
      return { records: t.size, ok: openError === '' }
    },
  })
}
