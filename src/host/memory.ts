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
 *
 * ── memory v2(SPEC dsh-embed-spec.md §5/§6/§7)───────────────────────────
 * `memory.embedding` 灰度開關(默認 off)啟用語義混合檢索:
 * - 寫入期:mem_save 同步存原文即返回,隨後投遞異步嵌入隊列(批量 16 條/次,
 *   失敗按 5s/30s/120s 重試 3 次後放棄並記 health 事件,由 backfill 兜底)。
 * - 查詢期:embedding.enabled 且 embedder 服務可用時,kwHits(現行 score
 *   top-100)與 semHits(cosine top-100)做 RRF(k=60)融合;embedder 缺失/
 *   不可用/查詢向量失敗時靜默降級純 keyword,輸出與 v1 逐字節一致。
 * - embedder 以 ctx.get('embedder') 可選注入(非 hard inject),指紋
 *   `{backend}@{dim}` 不匹配的向量行觸發單條異步重嵌,禁止跨後端替補。
 *
 * 回滾語義(重要):回滾到舊版插件(域 spec 無 memory_vectors)後,舊代碼
 * 的 serialize 只寫 descriptor 內的表,memory_vectors 數據會被靜默丟棄。
 * 向量是派生數據,記憶原文(memories 表)不受影響;重新啟用新版後由
 * backfill(插件內自動 + scripts/backfill-memory-vectors.mjs)一鍵重建。
 */
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { openVectorMemoryDomain } from './domains.ts'

/** memory 模組的 config 切片(入口的合併 Config 結構上滿足此介面)。 */
export interface MemoryConfig {
  ttlDays: number
  maxResults: number
  /**
   * memory v2 灰度開關(SPEC §7)。入口 Config 為扁平鍵,此欄位經
   * schemastery 非 strict object 透傳到本模組;缺省/缺鍵時 enabled=false,
   * 行為與 v1 逐字節一致。亦兼容嵌套寫法 `memory.embedding`。
   */
  embedding?: Partial<MemoryEmbeddingConfig>
}

/** memory v2 嵌入配置(SPEC §7 memory.embedding)。 */
export interface MemoryEmbeddingConfig {
  /** 灰度開關,默認 false。 */
  enabled: boolean
  /** 文本嵌入後端,默認 'qwen3-4b-fp16'。 */
  backend: string
  /**
   * MRL 維度,默認 2560(Qwen3-4B 全維)。t7 驗收實測:@512 純語義 86.5%,
   * @2560 94.2%——MRL-512 對 WeMM 場景成立,對 Qwen3-4B 文本不成立(F-QA-2)。
   * 注意:dim 變更即指紋變更,存量向量由 backfill 重嵌閉環自動兜住。
   */
  dim: number
}

/** 正規化 embedding 配置;支持扁平 `embedding` 與嵌套 `memory.embedding` 兩種寫法。 */
export function normalizeEmbeddingConfig(config: MemoryConfig): MemoryEmbeddingConfig {
  const raw = config.embedding
    ?? (config as unknown as { memory?: { embedding?: Partial<MemoryEmbeddingConfig> } }).memory?.embedding
    ?? {}
  return {
    enabled: raw.enabled === true,
    backend: typeof raw.backend === 'string' && raw.backend !== '' ? raw.backend : 'qwen3-4b-fp16',
    dim: typeof raw.dim === 'number' && Number.isInteger(raw.dim) && raw.dim > 0 ? raw.dim : 2560,
  }
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
  /** memory v2:RRF 融合的來源標記('kw'/'sem');僅融合路徑設置,v1 行為無此欄位。 */
  via?: string[]
}

// ── memory v2:向量行與嵌入服務的結構化最小介面 ─────────────────────────────

/** memory_vectors 表行(domains.ts memoryVectorSchema 的 TS 側)。 */
interface MemoryVectorRow {
  fp: string
  dim: number
  vec: number[]
  ts: number
}

interface VectorTableLike {
  get(key: string): MemoryVectorRow | undefined
  entries(): IterableIterator<[string, MemoryVectorRow]>
  readonly size: number
  put(key: string, value: MemoryVectorRow): Promise<void>
  delete(key: string): Promise<void>
}

/** dsh-embed `embedder` 服務的結構化最小介面(SPEC §3);可選注入,缺失即降級。 */
interface EmbedderLike {
  embedTexts(texts: string[], opts?: { backend?: string; dim?: number; instruct?: string }): Promise<(Float32Array | number[])[]>
  health?(): Promise<unknown>
}

// ── memory v2:純函數(cosine / RRF;語義與 dsh-embed/src/vector.ts 一致) ─────

/** cosine 相似度;長度不等拋 RangeError;零向量返回 0。 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) throw new RangeError(`cosine: length mismatch ${a.length} vs ${b.length}`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RrfFusedItem {
  id: string
  /** score = Σ_lists 1/(k + rank),rank 為 1-based。 */
  score: number
  /** 來源標記('kw'/'sem',按 lists 順序)。 */
  via: string[]
}

/**
 * memory v2 融合策略(F-QA-2 / t15 消融選定):**sem 主列表 + kw 僅補位**。
 *
 * 背景:t7 驗收實測等權 RRF(k=60)被 kw 弱列表(D1 Recall@5 僅 23.1%)稀釋,
 * 混合 73.1% < 純語義 86.5%(@512)。scripts/ablate-fusion.mjs 對 D1 52 查詢
 * 用快取向量離線對比 4 種策略(@2560):A.rrf-k60=90.4%(不變式 FAIL)、
 * B.wrrf-wsem3 / C.sem-primary / D.asymk-60/120 均 96.2% PASS;
 * 依「不變式 fused ≥ max(kw, sem) 下取最簡公式」選定本策略。
 *
 * 語義:排序 = sem 排名原樣;kw 中 sem 未覆蓋的 id 依 kw 排名追加在後
 * (向量表稀疏/退回早期 backfill 時 kw 兜底覆蓋)。score 為輸出位置的
 * RRF 形式分 1/(60+rank),僅作展示;via 保留 kw/sem 來源標記。
 * (SPEC §6 的公式修訂由隊長跟進;本函數為線上唯一融合入口。)
 */
export function fuseHybrid(kwIds: readonly string[], semIds: readonly string[]): RrfFusedItem[] {
  const kwSet = new Set(kwIds)
  const seen = new Set<string>()
  const ordered: Array<{ id: string; via: string[] }> = []
  for (const id of semIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push({ id, via: kwSet.has(id) ? ['kw', 'sem'] : ['sem'] })
  }
  for (const id of kwIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push({ id, via: ['kw'] })
  }
  return ordered.map((e, i) => ({ id: e.id, score: 1 / (60 + i + 1), via: e.via }))
}

/**
 * Reciprocal Rank Fusion(SPEC §6 原案):`score = Σ 1/(k+rank)`,k 默認 60。
 * 平手按「最早出現的列表,再 rank」穩定排序——純函數,同輸入恆同輸出。
 * 注意:F-QA-2 消融後線上融合已改為 fuseHybrid(sem 主列表 + kw 補位);
 * 本函數保留作為消融對照基線與通用工具。
 */
export function rrfFuse(lists: { name: string; ids: readonly string[] }[], k = 60): RrfFusedItem[] {
  if (!Number.isFinite(k) || k <= 0) throw new RangeError(`rrfFuse: k must be positive, got ${k}`)
  const map = new Map<string, { score: number; via: string[]; firstList: number; firstRank: number }>()
  for (let li = 0; li < lists.length; li++) {
    const { name, ids } = lists[li]
    for (let rank = 1; rank <= ids.length; rank++) {
      const id = ids[rank - 1]
      const entry = map.get(id)
      if (entry === undefined) {
        map.set(id, { score: 1 / (k + rank), via: [name], firstList: li, firstRank: rank })
      } else {
        entry.score += 1 / (k + rank)
        entry.via.push(name)
      }
    }
  }
  return [...map.entries()]
    .map(([id, e]) => ({ id, score: e.score, via: e.via, firstList: e.firstList, firstRank: e.firstRank }))
    .sort((a, b) => b.score - a.score || a.firstList - b.firstList || a.firstRank - b.firstRank)
    .map(({ id, score, via }) => ({ id, score, via }))
}

// ── memory v2:異步嵌入隊列(批量 16 條/次,重試 5s/30s/120s 後放棄) ──────────

/** SPEC §6:寫入期重試間隔。 */
export const EMBED_RETRY_DELAYS_MS = [5000, 30000, 120000] as const
/** SPEC §6:批量嵌入 16 條/次。 */
export const EMBED_BATCH_SIZE = 16

export interface EmbeddingQueueOptions {
  /** 批量嵌入;失敗即拋(調用方不區分錯誤類,一律進重試)。 */
  embed(texts: string[]): Promise<(Float32Array | number[])[]>
  /** 寫入一條向量行。 */
  putVector(id: string, vec: number[]): Promise<void>
  batchSize?: number
  retryDelays?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  /** health 事件:重試耗盡放棄時回調(SPEC §6「記 health 事件」)。 */
  onEvent?: (kind: 'embed-dropped' | 'embed-error', detail: Record<string, unknown>) => void
}

export interface EmbeddingQueueStats {
  enqueued: number
  embedded: number
  dropped: number
  lastError: string
}

/**
 * 內存態異步嵌入隊列:enqueue 立即返回(mem_save 同步路徑零阻塞),
 * 後台按 batchSize 批量嵌入;批量失敗時整批按 retryDelays 逐級重試,
 * 耗盡後放棄並記 health 事件,由 backfill 兜底(SPEC §6)。
 */
export class EmbeddingQueue {
  private pending: Array<{ id: string; text: string; attempt: number }> = []
  private readonly pendingIds = new Set<string>()
  private running = false
  private disposed = false
  /** 未決重試的 timer 與其 resolve(dispose 時清除並立即解除等待)。 */
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryResolve: (() => void) | undefined
  private readonly opts: EmbeddingQueueOptions
  readonly stats: EmbeddingQueueStats = { enqueued: 0, embedded: 0, dropped: 0, lastError: '' }

  constructor(opts: EmbeddingQueueOptions) {
    this.opts = opts
  }

  get pendingCount(): number {
    return this.pending.length
  }

  /** 投遞一條嵌入任務;同 id 去重(指紋重嵌與 backfill 可能重複投遞)。dispose 後忽略。 */
  enqueue(id: string, text: string): void {
    if (this.disposed || this.pendingIds.has(id)) return
    this.pendingIds.add(id)
    this.pending.push({ id, text, attempt: 0 })
    this.stats.enqueued += 1
    // 微任務調度:同一 tick 內的連續 enqueue 合批(滿足批量 16 條/次語義)。
    queueMicrotask(() => { void this.pump() })
  }

  /**
   * 停止隊列:置 disposed、清除未決重試 timer 並立即解除等待、清空待處理;
   * 進行中的 pump 在當前 await 點後退出,不再嵌入也不再重試。冪等。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const resolve = this.retryResolve
    this.retryResolve = undefined
    if (resolve !== undefined) resolve()
    this.pending.length = 0
    this.pendingIds.clear()
  }

  /** 排空隊列(測試用;生產路徑由 enqueue 自驅動,永不 await)。 */
  async drain(): Promise<void> {
    while (!this.disposed && (this.running || this.pending.length > 0)) {
      await this.pump()
    }
  }

  /**
   * 可取消的重試等待:默認 setTimeout(unref,不拖住進程退出;可被 dispose
   * 清除並立即喚醒);注入 sleep 時由調用方自控(測試)。
   */
  private waitRetry(ms: number): Promise<void> {
    if (this.opts.sleep !== undefined) return this.opts.sleep(ms)
    return new Promise<void>((resolve) => {
      this.retryResolve = resolve
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        this.retryResolve = undefined
        resolve()
      }, ms)
      ;(this.retryTimer as { unref?: () => void }).unref?.()
    })
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      const batchSize = this.opts.batchSize ?? EMBED_BATCH_SIZE
      const retryDelays = this.opts.retryDelays ?? EMBED_RETRY_DELAYS_MS
      while (!this.disposed && this.pending.length > 0) {
        const batch = this.pending.splice(0, batchSize)
        try {
          const vecs = await this.opts.embed(batch.map((item) => item.text))
          if (!Array.isArray(vecs) || vecs.length !== batch.length) {
            throw new Error(`embed batch size mismatch: got ${vecs?.length}, want ${batch.length}`)
          }
          for (let i = 0; i < batch.length; i++) {
            await this.opts.putVector(batch[i].id, Array.from(vecs[i]))
            this.pendingIds.delete(batch[i].id)
            this.stats.embedded += 1
          }
        } catch (error) {
          const message = String(error)
          this.stats.lastError = message
          this.opts.onEvent?.('embed-error', { error: message, batch: batch.length })
          const retry: typeof batch = []
          for (const item of batch) {
            item.attempt += 1
            if (item.attempt <= retryDelays.length) {
              retry.push(item)
            } else {
              this.pendingIds.delete(item.id)
              this.stats.dropped += 1
              this.opts.onEvent?.('embed-dropped', { id: item.id, attempts: item.attempt, error: message })
            }
          }
          if (retry.length > 0) {
            await this.waitRetry(retryDelays[retry[0].attempt - 1])
            // dispose 期間等待被解除:不再重投,直接由 while 條件退出。
            if (!this.disposed) this.pending.unshift(...retry)
          }
        }
      }
    } finally {
      this.running = false
      // 收尾時有新投遞(泵運行期間進隊)則再排一輪。
      if (!this.disposed && this.pending.length > 0) queueMicrotask(() => { void this.pump() })
    }
  }
}

/**
 * 向量行嵌入文本:與 D1 回歸/快取配方一致(dsh-wemm-poc run_regression.py:
 * `content + ' tags: ' + tags.join(', ')`,無 tags 時裸 content)。
 * 與快取向量對齊是離線消融(scripts/ablate-fusion.mjs)有效的前提。
 */
export function embedTextOf(record: MemoryRecord): string {
  return record.tags.length > 0 ? `${record.content} tags: ${record.tags.join(', ')}` : record.content
}

/**
 * Qwen3 家族 query 側任務前綴(SPEC §4.2;D1 回歸配方 task='memory notes',
 * sidecar 拼裝為 `Instruct: {instruct}\nQuery: {text}`)。其他後端不傳(傳入即拋驗證錯)。
 */
const MEMORY_QUERY_INSTRUCT = 'Given a query, retrieve relevant memory notes'

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

  // ── memory v2:embedding 配置與可選 embedder ──────────────────────────────
  // flag off(默認)時以下設施完全不激活:不讀 embedder、不開向量表、
  // 不投遞隊列,mem_save/mem_search/mem_health 行為與 v1 逐字節一致。
  const embCfg = normalizeEmbeddingConfig(config)
  const currentFp = `${embCfg.backend}@${embCfg.dim}`

  /** 懶解析 embedder:可選注入(非 hard inject),缺失/拋錯即 undefined → 降級。 */
  function getEmbedder(): EmbedderLike | undefined {
    if (!embCfg.enabled) return undefined
    try {
      return (ctx as unknown as { get(name: string): EmbedderLike | undefined }).get('embedder')
    } catch {
      return undefined
    }
  }

  let vectorTable: VectorTableLike | undefined
  async function ensureVectorTable(): Promise<VectorTableLike> {
    if (vectorTable) return vectorTable
    // 復用同一域單例(ensureTable 已註冊 domain close effect;若向量表先開,
    // 這裡補註冊——同域重複 open 由 openVectorMemoryDomain 單例吸收)。
    const domain = await openVectorMemoryDomain(obs.storageDomain)
    if (table === undefined) {
      ctx.effect(() => () => { void domain.close() }, 'vector_memory.domain')
    }
    vectorTable = domain.table('memory_vectors') as unknown as VectorTableLike
    return vectorTable
  }

  /**
   * backfill(SPEC §6「下次 backfill 兜住」):embedding 激活後首次讀寫時掃描
   * memories,對缺向量或指紋過期的記憶投遞異步重嵌。火忘式,失敗不影響主路徑。
   * 嵌入重試耗盡被 drop 時 backfillDone 會被置回 false(見下方 onEvent),
   * 使下次 save/search 重掃並重新投遞,形成「失敗→重嵌」閉環。
   */
  let backfillDone = false

  const queue = new EmbeddingQueue({
    embed: (texts) => {
      const embedder = getEmbedder()
      if (embedder === undefined) throw new Error('embedder service unavailable')
      return embedder.embedTexts(texts, { backend: embCfg.backend, dim: embCfg.dim })
    },
    putVector: async (id, vec) => {
      const vt = await ensureVectorTable()
      await vt.put(id, { fp: currentFp, dim: embCfg.dim, vec, ts: Date.now() })
    },
    onEvent: (kind, detail) => {
      queueEvents.push({ kind, detail, at: Date.now() })
      if (queueEvents.length > 20) queueEvents.shift()
      // drop 閉環:重試耗盡的記憶缺向量,重置 backfill 讓下次讀寫重掃重嵌。
      if (kind === 'embed-dropped') backfillDone = false
    },
  })
  // 插件停用完隊列:清除未決重試 timer、停止 pump,不留後台寫入。
  ctx.effect(() => () => queue.dispose(), 'memory.embeddingQueue')
  const queueEvents: Array<{ kind: string; detail: Record<string, unknown>; at: number }> = []
  async function maybeBackfill(): Promise<void> {
    if (backfillDone || !embCfg.enabled || getEmbedder() === undefined) return
    backfillDone = true
    try {
      const t = await ensureTable()
      const vt = await ensureVectorTable()
      const now = Date.now()
      for (const [id, record] of t.entries()) {
        if (record.expiresAt !== 0 && record.expiresAt <= now) continue
        const row = vt.get(id)
        if (row === undefined || row.fp !== currentFp || row.dim !== embCfg.dim) {
          queue.enqueue(id, embedTextOf(record))
        }
      }
    } catch {
      backfillDone = false // 下次讀寫重試
    }
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
    // memory v2:存原文即返回(同步路徑不變),嵌入走異步隊列(SPEC §6)。
    if (embCfg.enabled) {
      void maybeBackfill()
      if (getEmbedder() !== undefined) queue.enqueue(record.id, embedTextOf(record))
    }
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
    if (!embCfg.enabled) return hits.slice(0, limit)
    return fuseWithSemantic(query, hits, t, limit)
  }

  /**
   * memory v2 查詢期:kwHits top-100 ∪ semHits top-100 → fuseHybrid
   * (sem 主列表 + kw 補位;F-QA-2 消融選定,見 fuseHybrid 註釋)。
   * 任何一步失敗(embedder 缺失/EmbedderUnavailableError/向量表異常)都靜默
   * 降級純 keyword——本函數對外不拋錯,輸出退化為 v1 行為。
   */
  async function fuseWithSemantic(query: string, kwHits: MemoryHit[], t: TableLike, limit: number): Promise<MemoryHit[]> {
    const fallback = kwHits.slice(0, limit)
    try {
      void maybeBackfill()
      const embedder = getEmbedder()
      if (embedder === undefined) return fallback
      const qv = await embedder.embedTexts([query], {
        backend: embCfg.backend,
        dim: embCfg.dim,
        // instruct 僅 Qwen3 家族生效;其他後端傳入即拋驗證錯(SPEC §3)。
        ...(embCfg.backend.startsWith('qwen3') ? { instruct: MEMORY_QUERY_INSTRUCT } : {}),
      }).catch(() => null)
      if (qv === null || qv.length === 0) return fallback

      const vt = await ensureVectorTable()
      const semScored: Array<{ id: string; s: number }> = []
      for (const [id, row] of vt.entries()) {
        if (row.fp !== currentFp || row.dim !== embCfg.dim) {
          // 指紋過期:不參與本輪語義檢索,觸發單條異步重嵌(SPEC §5)。
          const record = t.get(id)
          if (record !== undefined) queue.enqueue(id, embedTextOf(record))
          else void vt.delete(id) // 原文已刪,孤兒向量行清理
          continue
        }
        semScored.push({ id, s: cosineSimilarity(qv[0], row.vec) })
      }
      semScored.sort((a, b) => b.s - a.s)
      const kwTop = kwHits.slice(0, 100)
      const semTop = semScored.slice(0, 100)
      const fused = fuseHybrid(kwTop.map((h) => h.id), semTop.map((h) => h.id))
      const byId = new Map<string, MemoryHit>()
      for (const h of kwTop) byId.set(h.id, h)
      const result: MemoryHit[] = []
      for (const item of fused.slice(0, limit)) {
        const kw = byId.get(item.id)
        if (kw !== undefined) {
          result.push({ ...kw, score: item.score, via: item.via })
        } else {
          const record = t.get(item.id)
          if (record === undefined) continue
          result.push({ id: item.id, content: record.content, tags: record.tags, score: item.score, createdAt: record.createdAt, via: item.via })
        }
      }
      return result
    } catch {
      return fallback
    }
  }

  // ── memActivity projection (session's memory activity for the view tab) ───
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const activityItemSchema = zod.object({ seq: zod.number(), kind: zod.string(), text: zod.string(), ok: zod.boolean() })
    ;(projectionCtx as unknown as { sessionProjections: { register(d: unknown): unknown } }).sessionProjections.register({
      key: 'memActivity',
      /** Projection schemas must be zod (schemastery objects have no .parse). */
      stateSchema: zod.object({
        items: zod.array(activityItemSchema),
        pending: zod.record(zod.string(), zod.object({ kind: zod.string(), text: zod.string() })),
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
      wire: { viewSchema: zod.object({ items: zod.array(activityItemSchema) }), view: (state: { items: Array<{ seq: number; kind: string; text: string; ok: boolean }> }) => ({ items: state.items }) },
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
          `${i + 1}. [${h.id}] (score ${h.score.toFixed(2)}${h.via !== undefined ? `, via: ${h.via.join('+')}` : ''}${h.tags.length ? `, tags: ${h.tags.join(',')}` : ''})\n   ${h.content.slice(0, 300)}`,
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
        const lines = [
          `records: ${t.size}`,
          `expired (lazy): ${expired}`,
          `domain: vector_memory (storageDomain, version 1)`,
          `ttl default: ${config.ttlDays === 0 ? 'forever' : `${config.ttlDays}d`}`,
          openError !== '' ? `open error: ${openError}` : 'status: ok',
        ]
        // memory v2:僅 flag on 時追加 embedding 狀態行(flag off 輸出與 v1 逐字節一致)。
        if (embCfg.enabled) {
          const embedder = getEmbedder()
          lines.push(`embedding: enabled (fingerprint ${currentFp}, embedder: ${embedder === undefined ? 'missing' : 'available'})`)
          try {
            const vt = await ensureVectorTable()
            let stale = 0
            for (const [, row] of vt.entries()) {
              if (row.fp !== currentFp || row.dim !== embCfg.dim) stale += 1
            }
            lines.push(`vectors: ${vt.size} rows (stale fingerprint: ${stale})`)
          } catch (error) {
            lines.push(`vectors: unavailable (${String(error)})`)
          }
          lines.push(`embedding queue: enqueued ${queue.stats.enqueued}, embedded ${queue.stats.embedded}, dropped ${queue.stats.dropped}${queue.stats.lastError !== '' ? `, last error: ${queue.stats.lastError}` : ''}`)
          for (const ev of queueEvents.slice(-3)) {
            lines.push(`embedding event: ${ev.kind} ${JSON.stringify(ev.detail)}`)
          }
        }
        return lines.join('\n')
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
