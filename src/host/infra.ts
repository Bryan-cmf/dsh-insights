/**
 * dsh-insights · infra 模組(原 @bryan-cmf/dsh-infra-observability host)。
 *
 * Structural observability layer, the platform-side replacement for
 * self-reporting skill systems:
 *
 * - `tools/result` listener records every real tool execution (name, outcome)
 *   into a ring buffer plus per-day aggregates — the platform recorded it, so
 *   nothing depends on the model reporting itself.
 * - `agent/error` / `agent/status` listeners track error totals and live
 *   agents; a timer watchdog alerts when errors spike in a 5-minute window.
 * - A `infraView` session-projection unit folds the committed session log
 *   into a per-session dashboard value (turns, per-tool/skill counters, recent
 *   executions) that the browser view tab renders live.
 * - Three tools expose the layer: `usage_report` (aggregates + recent trail),
 *   `audit_skills` (catalog health), `infra_health` (runtime snapshot).
 */
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** infra 模組的 config 切片(入口的合併 Config 結構上滿足此介面)。 */
export interface InfraConfig {
  maxRecords: number
  healthIntervalMs: number
  errorAlertThreshold: number
}

// ── minimal structural shapes of the events we consume ──────────────────────

interface ExecLike {
  name: string
  arguments: unknown
}
interface ResultLike {
  isError?: boolean
  error?: { code?: string; name?: string; message?: string }
}
interface ErrorEventPayload {
  agent?: { id?: unknown }
  turn?: number
  step?: number
  error?: unknown
}
interface StatusEventPayload {
  agent?: { id?: unknown }
  status?: string
}
interface SessionEventShape {
  type: string
  data: unknown
}

interface UsageRecord {
  ts: number
  name: string
  ok: boolean
  code?: string
}
interface Counter {
  calls: number
  ok: number
  err: number
}
type Bucket = Map<string, Counter>
interface DayBucket {
  tools: Bucket
  skills: Bucket
}

const startedAt = Date.now()

function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function agentIdOf(agent: { id?: unknown } | undefined): string {
  return agent && typeof agent.id === 'string' ? agent.id : '?'
}

function skillNameOf(args: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>
    if (typeof record.name === 'string') return record.name
  }
  return ''
}

function fmtCounters(title: string, bucket: Bucket, max = 15): string[] {
  const rows = [...bucket.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, max)
  if (rows.length === 0) return [`${title}: (none)`]
  const out = [`${title}:`]
  for (const [key, c] of rows) out.push(`  ${key}: ${c.calls} calls (${c.ok} ok / ${c.err} err)`)
  return out
}

// ── infraView session projection (dashboard wire value) ─────────────────────

interface InfraWireItem {
  name: string
  calls: number
  ok: number
  err: number
}
interface InfraWire {
  turns: { started: number; ended: number }
  errors: number
  tools: InfraWireItem[]
  skills: InfraWireItem[]
  recent: Array<{ seq: number; name: string; ok: boolean; code: string }>
}

/** Plain-JSON fold state (projection cache precondition: no Maps). */
interface InfraState {
  started: number
  ended: number
  errors: number
  pending: Record<string, { name: string; skill: string }>
  tools: Record<string, Counter>
  skills: Record<string, Counter>
  recent: Array<{ seq: number; name: string; ok: boolean; code: string }>
}

/** Projection schema — must be zod: session-projection settles values with
 * schema.parse(); schemastery objects (used for Config above) have no .parse. */
const infraSchema = zod.object({
  turns: zod.object({ started: zod.number(), ended: zod.number() }),
  errors: zod.number(),
  tools: zod.array(zod.object({ name: zod.string(), calls: zod.number(), ok: zod.number(), err: zod.number() })),
  skills: zod.array(zod.object({ name: zod.string(), calls: zod.number(), ok: zod.number(), err: zod.number() })),
  recent: zod.array(zod.object({ seq: zod.number(), name: zod.string(), ok: zod.boolean(), code: zod.string() })),
})

function bumpCounter(record: Record<string, Counter>, key: string, ok: boolean): Record<string, Counter> {
  const prev = record[key] ?? { calls: 0, ok: 0, err: 0 }
  return {
    ...record,
    [key]: { calls: prev.calls + 1, ok: ok ? prev.ok + 1 : prev.ok, err: ok ? prev.err : prev.err + 1 },
  }
}

function foldInfra(state: InfraState, event: SessionEventShape): InfraState {
  if (event.type === 'turn/start') return { ...state, started: state.started + 1 }
  if (event.type === 'turn/end') return { ...state, ended: state.ended + 1 }
  if (event.type === 'tool/call') {
    const d = event.data as { turn: number; callId: string; name: string; arguments: string }
    return { ...state, pending: { ...state.pending, [d.callId]: { name: d.name, skill: d.name === 'skill' ? skillNameOf(d.arguments) : '' } } }
  }
  if (event.type === 'tool/result') {
    const d = event.data as { message?: { content?: Array<{ toolCallId?: string }> }; error?: unknown; seq?: number }
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
    const ok = d.error === undefined || d.error === null
    const code = ok ? '' : typeof d.error === 'object' && d.error !== null ? String((d.error as { code?: unknown }).code ?? 'error') : 'error'
    const remaining = { ...state.pending }
    delete remaining[pendingKey]
    const recent = [...state.recent, { seq: d.seq ?? 0, name: pending.name, ok, code }]
    if (recent.length > 30) recent.shift()
    let next: InfraState = {
      ...state,
      pending: remaining,
      recent,
      errors: state.errors + (ok ? 0 : 1),
    }
    next = { ...next, tools: bumpCounter(next.tools, pending.name, ok) }
    if (pending.skill !== '') next = { ...next, skills: bumpCounter(next.skills, pending.skill, ok) }
    return next
  }
  return state
}

function viewInfra(state: InfraState): InfraWire {
  const toItems = (record: Record<string, Counter>): InfraWireItem[] =>
    Object.entries(record)
      .map(([name, c]) => ({ name, calls: c.calls, ok: c.ok, err: c.err }))
      .sort((a, b) => b.calls - a.calls)
  return {
    turns: { started: state.started, ended: state.ended },
    errors: state.errors,
    tools: toItems(state.tools),
    skills: toItems(state.skills),
    recent: state.recent.slice(-20),
  }
}

export function applyInfra(ctx: Context, config: InfraConfig): void {
  const recent: UsageRecord[] = []
  const byDay = new Map<string, DayBucket>()
  const activeAgents = new Set<string>()
  const errorLog: Array<{ ts: number; text: string }> = []
  let errorTotal = 0

  function bucketOf(day: string): DayBucket {
    let b = byDay.get(day)
    if (!b) {
      b = { tools: new Map(), skills: new Map() }
      byDay.set(day, b)
    }
    return b
  }
  function bump(bucket: Bucket, key: string, ok: boolean): void {
    let c = bucket.get(key)
    if (!c) {
      c = { calls: 0, ok: 0, err: 0 }
      bucket.set(key, c)
    }
    c.calls += 1
    if (ok) c.ok += 1
    else c.err += 1
  }
  function recentErrorCount(windowMs: number): number {
    const cutoff = Date.now() - windowMs
    let n = 0
    for (const e of errorLog) if (e.ts >= cutoff) n += 1
    return n
  }

  // ── dashboard projection (per-session, from the committed log) ────────────
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    ;(projectionCtx as unknown as { sessionProjections: { register(d: unknown): unknown } }).sessionProjections.register({
      key: 'infraView',
      schema: infraSchema,
      init: () => ({ started: 0, ended: 0, errors: 0, pending: {}, tools: {}, skills: {}, recent: [] }),
      apply: (state: InfraState, event: SessionEventShape) => foldInfra(state, event),
      view: viewInfra,
      stateVersion: 1,
    })
  })

  // ── structural recording ──────────────────────────────────────────────────
  ctx.on('tools/result', (exec: ExecLike, result: ResultLike) => {
    try {
      const ok = result?.isError !== true
      const rec: UsageRecord = { ts: Date.now(), name: exec.name, ok }
      if (!ok) rec.code = result?.error?.code ?? result?.error?.name ?? 'error'
      recent.push(rec)
      if (recent.length > config.maxRecords) recent.shift()
      const b = bucketOf(dayKey())
      bump(b.tools, exec.name, ok)
      if (exec.name === 'skill') {
        const skill = skillNameOf(exec.arguments)
        if (skill !== '') bump(b.skills, skill, ok)
      }
    } catch {
      // observe only — never let the recorder break the pipeline
    }
  })

  // ── agent lifecycle ───────────────────────────────────────────────────────
  ctx.on('agent/error', (payload: ErrorEventPayload) => {
    errorTotal += 1
    const text = `agent ${agentIdOf(payload?.agent)} turn ${payload?.turn ?? '?'} step ${payload?.step ?? '?'}: ${String(payload?.error ?? '')}`
    errorLog.push({ ts: Date.now(), text: text.slice(0, 300) })
    if (errorLog.length > 200) errorLog.shift()
  })

  ctx.on('agent/status', (payload: StatusEventPayload) => {
    const id = agentIdOf(payload?.agent)
    if (id === '?') return
    if (payload?.status === 'running') activeAgents.add(id)
    else if (payload?.status === 'idle') activeAgents.delete(id)
  })

  // ── watchdog ──────────────────────────────────────────────────────────────
  const obs = ctx as unknown as { timer: { interval(cb: () => void, ms: number): unknown } }
  obs.timer.interval(() => {
    const n = recentErrorCount(5 * 60 * 1000)
    if (n >= config.errorAlertThreshold) {
      console.error(`[infra-observability] ${n} agent error(s) in the last 5 minutes (threshold ${config.errorAlertThreshold})`)
    }
  }, config.healthIntervalMs)

  // ── usage_report ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'usage_report',
    description: 'Aggregated tool/skill usage recorded from real executions (structural; the platform recorded it, not the model).',
    parameters: { days: { type: 'number', description: 'Days of history to include (default 1, max 30).' } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args) {
      const days = typeof args.days === 'number' && args.days > 0 ? Math.min(Math.floor(args.days), 30) : 1
      const keys = [...byDay.keys()].sort().slice(-days)
      const lines: string[] = []
      if (keys.length === 0) {
        lines.push('no usage recorded yet in this process')
        return lines.join('\n')
      }
      for (const day of keys) {
        const b = bucketOf(day)
        lines.push(`== ${day} ==`)
        lines.push(...fmtCounters('tools', b.tools))
        lines.push(...fmtCounters('skills', b.skills))
      }
      lines.push(`-- last ${Math.min(recent.length, 10)} executions --`)
      for (const r of recent.slice(-10)) {
        lines.push(`  ${new Date(r.ts).toISOString().slice(11, 19)} ${r.name} ${r.ok ? 'ok' : `ERR:${r.code ?? ''}`}`)
      }
      return lines.join('\n')
    },
  }))

  // ── audit_skills ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'audit_skills',
    description: 'Audit the mounted skill catalog: totals, provider spread, warnings (missing description / non-kebab name), and today\'s skill usage.',
    parameters: {},
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute() {
      let skills: SkillSummary[] = []
      try {
        skills = await ctx.skills.list({})
      } catch (error) {
        return `ERROR: skills service unavailable: ${String(error)}`
      }
      const warn: string[] = []
      const providers = new Map<string, number>()
      for (const s of skills) {
        providers.set(s.provider, (providers.get(s.provider) ?? 0) + 1)
        if (s.description === '') warn.push(`${s.name}: missing description`)
        if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name)) warn.push(`${s.name}: non-kebab name`)
      }
      const today = bucketOf(dayKey())
      const usedSkills = [...today.skills.entries()]
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 15)
      const lines = [
        `skills total: ${skills.length}`,
        `providers: ${[...providers.entries()].map(([p, n]) => `${p}×${n}`).join(', ') || '(none)'}`,
        `warnings: ${warn.length}`,
        ...warn.slice(0, 10).map((w) => `  ⚠ ${w}`),
        `today's skill usage: ${usedSkills.length === 0 ? '(none)' : ''}`,
        ...usedSkills.map(([s, c]) => `  ${s}: ${c.calls} calls (${c.ok} ok / ${c.err} err)`),
      ]
      return lines.join('\n')
    },
  }))

  // ── infra_health ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'infra_health',
    description: 'Health snapshot of the observability layer and the runtime it watches.',
    parameters: {},
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute() {
      let skillCount = -1
      try {
        skillCount = (await ctx.skills.list({})).length
      } catch {
        // keep -1 = unavailable
      }
      return [
        `uptime: ${Math.round((Date.now() - startedAt) / 1000)}s`,
        `records kept: ${recent.length} / ${config.maxRecords}`,
        `days tracked: ${byDay.size}`,
        `agent errors (process): ${errorTotal} (last 5min: ${recentErrorCount(5 * 60 * 1000)})`,
        `agents currently running: ${activeAgents.size}`,
        `skills in catalog: ${skillCount === -1 ? 'unavailable' : String(skillCount)}`,
        `watchdog: every ${config.healthIntervalMs}ms, alert ≥ ${config.errorAlertThreshold} errors/5min`,
      ].join('\n')
    },
  }))
}
