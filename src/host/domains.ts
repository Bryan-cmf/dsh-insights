/**
 * dsh-insights · 共用儲存域 opener。
 *
 * 合併前的四套件各自 inject storageDomain,同名域各自 open 互不衝突;
 * 合併成單一插件後,同一 ctx 上重複 open 同名域會拋
 * `DomainError: domain '<name>' is already open`(重啟後實測命中:
 * memory 與 perspectives 同開 vector_memory;perspectives 與 insight
 * 同開 observation)。此模組把域 open 收攏為插件級單例。
 *
 * 注意:obsSchema 採用 perspectives 的超集版本(含 suggestedTodos /
 * insight 欄位),insight 模組原用的子集 schema 與之相容。
 */
import { z as zod } from 'zod'
import { domainTable } from '@deepseek-ai/dsh-storage-domain'

export interface DomainLike {
  table(name: string): unknown
  close(): Promise<void> | void
}
export interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}

// ── schemas(域級單一真相)────────────────────────────────────────────────────

export const memorySchema = zod.object({
  id: zod.string(),
  content: zod.string(),
  tags: zod.array(zod.string()),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  hits: zod.number(),
  expiresAt: zod.number(),
  /** v0.10.0:寫入方 session id(記憶頁嚴格隔離;舊記錄無此欄位仍相容)。 */
  sid: zod.string().optional(),
})

/** observation 域 schema(perspectives 超集版;suggestedTodos/insight/summary/paths 可選,與 insight 模組的子集讀取相容)。 */
export const obsSchema = zod.object({
  sessionId: zod.string(),
  narrative: zod.string(),
  topic: zod.string(),
  milestones: zod.array(zod.object({
    seq: zod.number(), kind: zod.string(), title: zod.string(), why: zod.string(), evidenceSeq: zod.number(),
  })),
  suggestedTodos: zod.array(zod.object({ content: zod.string(), why: zod.string() })).optional(),
  insight: zod.string().optional(),
  /** 洞察頁生成物:價值總結與潛力路徑,持久化到下次生成才覆寫(切頁不丟)。 */
  summary: zod.string().optional(),
  paths: zod.array(zod.object({
    name: zod.string(), value: zod.string(), effort: zod.string(), firstStep: zod.string(),
  })).optional(),
  turnCount: zod.number(),
  updatedAt: zod.number(),
})

/** 洞察對話歷史域:per-session 一份對話線,滾動保留最近 50 條。 */
export const insightChatSchema = zod.object({
  sessionId: zod.string(),
  messages: zod.array(zod.object({
    role: zod.string(),
    text: zod.string(),
    thinking: zod.string().optional(),
    at: zod.number(),
  })),
  updatedAt: zod.number(),
})

// ── 單例 openers(失敗時清除 memo,允許下次呼叫重試)─────────────────────────

let vectorMemoryDomain: Promise<DomainLike> | undefined
let observationDomain: Promise<DomainLike> | undefined
let insightChatDomain: Promise<DomainLike> | undefined

export function openVectorMemoryDomain(sd: StorageDomainLike): Promise<DomainLike> {
  if (vectorMemoryDomain === undefined) {
    const p = sd.open({ name: 'vector_memory', version: 1, tables: { memories: domainTable(memorySchema) } })
    vectorMemoryDomain = p
    p.catch(() => { if (vectorMemoryDomain === p) vectorMemoryDomain = undefined })
  }
  return vectorMemoryDomain
}

export function openObservationDomain(sd: StorageDomainLike): Promise<DomainLike> {
  if (observationDomain === undefined) {
    const p = sd.open({ name: 'observation', version: 1, tables: { sessions: domainTable(obsSchema) } })
    observationDomain = p
    p.catch(() => { if (observationDomain === p) observationDomain = undefined })
  }
  return observationDomain
}

export function openInsightChatDomain(sd: StorageDomainLike): Promise<DomainLike> {
  if (insightChatDomain === undefined) {
    const p = sd.open({ name: 'insight_chat', version: 1, tables: { chats: domainTable(insightChatSchema) } })
    insightChatDomain = p
    p.catch(() => { if (insightChatDomain === p) insightChatDomain = undefined })
  }
  return insightChatDomain
}
