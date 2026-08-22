/**
 * dsh-insights · perspectives 模組(原 @bryan-cmf/dsh-view-perspectives host)。
 *
 * 提供 session 投影 + 洞察自動化:
 * - fileActivity :檔案活動(read/write/edit/glob/grep 折疊)
 * - mechEvents   :機制事件(goal/todo/plan/sandbox/approval/compaction/command/subagent/llm-retry)
 * - goalTrace    :目標軌跡(洞察視圖的價值錨點來源)
 * - insightsScan :自動掃描軌跡內容 → 洞察項目(失敗/重複失敗/用戶糾正/壓縮/目標/無產出)
 *
 * 洞察自動存檔:session/event 監聽器以同一套純函數增量折疊,在 turn/end 時
 * 把重要性 ≥2 且未存過的新洞察寫入 vector_memory 域(標籤 [洞察, kind]),
 * 可被 mem_search 檢索、跨 session 持久。
 */
import { z as zod } from 'zod'
import { domainTable } from '@deepseek-ai/dsh-storage-domain'
import { openVectorMemoryDomain, openObservationDomain } from './domains.ts'

interface FileCounter {
  reads: number
  writes: number
  edits: number
  searches: number
  err: number
  lastOk: boolean
  lastTool: string
}
interface FileState {
  files: Record<string, FileCounter>
  pending: Record<string, { name: string; path: string }>
  recent: Array<{ seq: number; path: string; tool: string; ok: boolean; code: string }>
  seq: number
}
interface MechItem { seq: number; type: string; text: string }
interface GoalItem { seq: number; action: string; objective: string }
interface InsightItem {
  seq: number
  kind: 'risk' | 'signal' | 'progress'
  text: string
  importance: number
  key: string
}
interface ScanState {
  items: InsightItem[]
  /** 已(將要)自動存入記憶的洞察——與存檔監聽器共用同一套規則,確定一致。 */
  saved: InsightItem[]
  pending: Record<string, string>
  /** 真錯誤計數(按工具);政策/瞬態錯誤不計入、不升級。 */
  toolErrs: Record<string, number>
  seen: Record<string, boolean>
  compactionCount: number
  turnWrites: number
  turnsSinceWrite: number
  /** 規則內攔截次數(沙箱/審批/政策)——只展示計數,不成洞察、不進記憶。 */
  policyBlocks: number
  /** 瞬態錯誤次數(重啟/網絡/限流)。 */
  transientErrs: number
  seq: number
}

const FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep']
const MECH_TYPES = [
  'goal/change', 'todo/write', 'plan/mode', 'sandbox/mode',
  'approval/asked', 'approval/decided',
  'compaction/start', 'compaction/end', 'compaction/summary',
  'command/run', 'command/done', 'subagent/descriptor', 'agent-preset/selected',
  'llm/retry', 'llm/retry-started', 'schedule/change', 'feedback/record', 'permission/preset',
]

// ── schemas ──────────────────────────────────────────────────────────────────

const fileSchema = zod.object({
  files: zod.array(zod.object({
    path: zod.string(), reads: zod.number(), writes: zod.number(), edits: zod.number(),
    searches: zod.number(), err: zod.number(), lastOk: zod.boolean(), lastTool: zod.string(),
  })),
  recent: zod.array(zod.object({ seq: zod.number(), path: zod.string(), tool: zod.string(), ok: zod.boolean(), code: zod.string() })),
})
const mechSchema = zod.object({
  items: zod.array(zod.object({ seq: zod.number(), type: zod.string(), text: zod.string() })),
})
const goalSchema = zod.object({
  items: zod.array(zod.object({ seq: zod.number(), action: zod.string(), objective: zod.string() })),
})
const insightItemSchema = zod.object({
  seq: zod.number(), kind: zod.string(), text: zod.string(), importance: zod.number(), key: zod.string(),
})
const scanSchema = zod.object({
  items: zod.array(insightItemSchema),
  saved: zod.array(insightItemSchema),
  policyBlocks: zod.number().optional(),
  transientErrs: zod.number().optional(),
})
// memorySchema / obsSchema 已收攏到 ./domains.ts(插件級域單例,避免 DomainError)

// ── 檔案活動 ─────────────────────────────────────────────────────────────────

function extractPath(tool: string, argsStr: unknown): string | null {
  try {
    const a = JSON.parse(typeof argsStr === 'string' ? argsStr : '{}') as Record<string, unknown>
    if (typeof a.file_path === 'string' && a.file_path !== '') return a.file_path
    if (typeof a.path === 'string' && a.path !== '') return a.path
    if (tool === 'glob' && typeof a.pattern === 'string' && a.pattern !== '') return `glob:${a.pattern}`
    return null
  } catch {
    return null
  }
}

function foldFile(state: FileState, event: { type: string; data?: any }): FileState {
  if (event.type === 'tool/call') {
    const d = event.data ?? {}
    if (!FILE_TOOLS.includes(d.name)) return state
    const path = extractPath(d.name, d.arguments)
    if (path === null) return state
    return { ...state, pending: { ...state.pending, [d.callId]: { name: d.name, path } } }
  }
  if (event.type === 'tool/result') {
    const d = event.data ?? {}
    let callId: string | null = null
    const content = d.message?.content
    if (Array.isArray(content) && content[0] && typeof content[0].toolCallId === 'string') callId = content[0].toolCallId
    const keys = Object.keys(state.pending)
    const key = callId !== null && state.pending[callId] !== undefined ? callId : keys[0]
    if (key === undefined) return state
    const pend = state.pending[key]
    const ok = d.error === undefined || d.error === null
    const code = ok ? '' : String((d.error && typeof d.error === 'object' && d.error.code) || 'error')
    const { [key]: _dropped, ...pending } = state.pending
    const prev = state.files[pend.path] ?? { reads: 0, writes: 0, edits: 0, searches: 0, err: 0, lastOk: true, lastTool: '' }
    const f: FileCounter = {
      reads: prev.reads, writes: prev.writes, edits: prev.edits, searches: prev.searches,
      err: prev.err + (ok ? 0 : 1), lastOk: ok, lastTool: pend.name,
    }
    if (pend.name === 'read') f.reads += 1
    else if (pend.name === 'write') f.writes += 1
    else if (pend.name === 'edit') f.edits += 1
    else f.searches += 1
    const recent = [...state.recent, { seq: state.seq + 1, path: pend.path, tool: pend.name, ok, code }]
    return {
      files: { ...state.files, [pend.path]: f },
      pending,
      recent: recent.length > 50 ? recent.slice(-50) : recent,
      seq: state.seq + 1,
    }
  }
  return state
}

function viewFiles(state: FileState) {
  const entries = Object.entries(state.files).map(([path, f]) => ({ path, ...f }))
  entries.sort((a, b) => (b.writes + b.edits) - (a.writes + a.edits) || b.reads - a.reads)
  return { files: entries, recent: state.recent.slice(-30) }
}

// ── 機制事件 ─────────────────────────────────────────────────────────────────

function mechText(type: string, d: unknown): string {
  if (!d || typeof d !== 'object') return ''
  const o = d as Record<string, any>
  try {
    switch (type) {
      case 'goal/change': {
        const act = o.action || o.change || ''
        const obj = typeof o.objective === 'string' ? o.objective : typeof o.payload?.objective === 'string' ? o.payload.objective : ''
        return `goal ${String(act)}${obj ? `: ${obj.slice(0, 100)}` : ''}`
      }
      case 'todo/write': return `todo: ${String(o.action || 'write')}`
      case 'plan/mode': return `plan mode → ${String(o.mode ?? '')}`
      case 'sandbox/mode': return `sandbox → ${String(o.mode ?? '')}`
      case 'approval/asked': {
        const req = o.request && typeof o.request === 'object' ? o.request : o
        return `審批請求: ${String(req.description || req.summary || '')}`
      }
      case 'approval/decided': return `審批: ${String(o.outcome ?? o.approved ?? '')}`
      case 'compaction/start': return '壓縮開始'
      case 'compaction/end': return '壓縮結束'
      case 'compaction/summary': return '壓縮摘要已產生'
      case 'command/run': return `命令: ${String(o.name || o.command || '')}`
      case 'command/done': return '命令完成'
      case 'subagent/descriptor': return `subagent: ${String(o.name || o.label || '')}`
      case 'agent-preset/selected': return `preset → ${String(o.agentPreset || o.preset || '')}`
      case 'llm/retry':
      case 'llm/retry-started': return 'LLM 重試'
      case 'schedule/change': return '排程變更'
      case 'feedback/record': return '反饋記錄'
      case 'permission/preset': return '權限 preset'
    }
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (typeof v === 'string' && k !== 'type' && k !== 'data') return `${k}: ${v.slice(0, 120)}`
    }
    return ''
  } catch {
    return ''
  }
}

function foldMech(state: { items: MechItem[]; seq: number }, event: { type: string; data?: any }) {
  if (!MECH_TYPES.includes(event.type)) return state
  const item: MechItem = { seq: state.seq + 1, type: event.type, text: mechText(event.type, event.data) }
  const items = [...state.items, item]
  return { items: items.length > 80 ? items.slice(-80) : items, seq: state.seq + 1 }
}

// ── 目標軌跡 ─────────────────────────────────────────────────────────────────

function foldGoal(state: { items: GoalItem[]; seq: number }, event: { type: string; data?: any }) {
  if (event.type !== 'goal/change') return state
  const d = (event.data ?? {}) as Record<string, any>
  const action = String(d.action || d.change || 'change')
  const objective = typeof d.objective === 'string' ? d.objective : typeof d.payload?.objective === 'string' ? d.payload.objective : ''
  const items = [...state.items, { seq: state.seq + 1, action, objective }]
  return { items: items.length > 40 ? items.slice(-40) : items, seq: state.seq + 1 }
}

// ── 洞察掃描(純函數,投影與自動存檔共用)────────────────────────────────────

function hashKey(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h.toString(36)
}

function initScan(): ScanState {
  return { items: [], saved: [], pending: {}, toolErrs: {}, seen: {}, compactionCount: 0, turnWrites: 0, turnsSinceWrite: 0, policyBlocks: 0, transientErrs: 0, seq: 0 }
}

// ── 錯誤分類(有益/有害)────────────────────────────────────────────────────
// 用戶洞察:部分報錯是框架規則內的攔截(沙箱拒絕、審批要求、讀前編輯政策),
// 是有益的保護;另一部分是重啟/網絡瞬態。兩者都不該變成洞察刷屏或進記憶。
// 只有真錯誤(踩坑碰壁)才聚合成洞察並由存檔器寫入記憶(標籤:踩坑)。
type ErrClass = 'policy' | 'transient' | 'real'
function classifyError(code: string, msg: string): ErrClass {
  const s = `${code} ${msg}`.toLowerCase()
  // fs_not_observed(編輯前須讀取)/fs_stale_version(檔案版本過期)同屬框架保護性攔截
  if (/sandbox|file access denied|operation not permitted|eperm|eacces|requires reading|observation-policy|fs_not_observed|fs_stale_version|approval|審批/.test(s)) return 'policy'
  if (/interrupted|no result was durably recorded|restart|kickstart|etimedout|econnreset|econnrefused|eai_again|rate.?limit|overloaded|socket/.test(s)) return 'transient'
  return 'real'
}

function pushItem(state: ScanState, kind: InsightItem['kind'], text: string, importance: number, dedupeKey: string): ScanState {
  if (dedupeKey !== '' && state.seen[dedupeKey] === true) return state
  const item: InsightItem = { seq: state.seq + 1, kind, text, importance, key: dedupeKey }
  const items = [...state.items, item]
  return {
    ...state,
    seq: state.seq + 1,
    seen: dedupeKey === '' ? state.seen : { ...state.seen, [dedupeKey]: true },
    items: items.length > 60 ? items.slice(-60) : items,
  }
}

const CORRECT_RE = /(不對|錯了|錯的|錯啦|不應該|改回|不要|別再|取消|推翻|重複|刪掉|去掉)/

function foldScan(state: ScanState, event: { type: string; data?: any }): ScanState {
  if (event.type === 'tool/call') {
    const d = event.data ?? {}
    if (typeof d.callId === 'string' && typeof d.name === 'string') {
      return { ...state, pending: { ...state.pending, [d.callId]: d.name } }
    }
    return state
  }
  if (event.type === 'tool/result') {
    const d = event.data ?? {}
    let callId: string | null = null
    const content = d.message?.content
    if (Array.isArray(content) && content[0] && typeof content[0].toolCallId === 'string') callId = content[0].toolCallId
    const keys = Object.keys(state.pending)
    const key = callId !== null && state.pending[callId] !== undefined ? callId : keys[0]
    if (key === undefined) return state
    const tool = state.pending[key]
    const { [key]: _dropped, ...pending } = state.pending
    const ok = d.error === undefined || d.error === null
    let next: ScanState = {
      ...state,
      pending,
      turnWrites: ok && (tool === 'write' || tool === 'edit') ? state.turnWrites + 1 : state.turnWrites,
    }
    if (ok) return next
    const code = String((d.error && typeof d.error === 'object' && d.error.code) || 'error')
    const errMsg = String((d.error && typeof d.error === 'object' && d.error.message) || '')
    const cls = classifyError(code, errMsg)
    // 規則內攔截(有益):只計數——不成洞察、不進記憶、不觸發升級
    if (cls === 'policy') return { ...next, policyBlocks: state.policyBlocks + 1 }
    // 瞬態(重啟/網絡/限流):全 session 至多一條低重要性提示
    if (cls === 'transient') {
      const t = state.transientErrs + 1
      next = { ...next, transientErrs: t }
      if (t === 1) next = pushItem(next, 'signal', `出現瞬態錯誤(重啟/網絡類,${tool})——通常無需處理,持續出現才排查`, 1, 'transient:first')
      return next
    }
    // 真錯誤(踩坑):按工具聚合去重——每工具一行 + 第 2/5 次升級行
    const errs = (state.toolErrs[tool] || 0) + 1
    next = { ...next, toolErrs: { ...state.toolErrs, [tool]: errs } }
    next = pushItem(next, 'risk', `工具「${tool}」失敗(${code})——踩坑,需排查`, 2, `fail:${tool}`)
    if (errs === 2) next = pushItem(next, 'risk', `工具「${tool}」已失敗 ${errs} 次——優先排查其輸入與環境`, 3, `failx2:${tool}`)
    if (errs === 5) next = pushItem(next, 'risk', `工具「${tool}」已失敗 ${errs} 次——建議暫停並人工介入`, 3, `failx5:${tool}`)
    return next
  }
  if (event.type === 'user/message') {
    const d = event.data ?? {}
    const text = typeof d.text === 'string' ? d.text : ''
    if (text.length > 500) return state
    const m = CORRECT_RE.exec(text)
    if (m) return pushItem(state, 'signal', `用戶糾正:「${text.slice(0, 80)}」——立即對齊方向,勿重複該做法`, 3, `corr:${hashKey(text.slice(0, 60))}`)
    return state
  }
  if (event.type === 'compaction/start') {
    const n = state.compactionCount + 1
    return pushItem({ ...state, compactionCount: n }, 'risk', '上下文壓縮開始——長期目標與早期決策細節可能遺失', 2, `compaction:${n}`)
  }
  if (event.type === 'goal/change') {
    const d = (event.data ?? {}) as Record<string, any>
    const objective = typeof d.objective === 'string' ? d.objective : typeof d.payload?.objective === 'string' ? d.payload.objective : ''
    if (objective !== '') return pushItem(state, 'progress', `目標更新:「${objective.slice(0, 100)}」——以此校準產出`, 2, `goal:${hashKey(objective)}`)
    return state
  }
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    return pushItem(state, 'risk', 'LLM 重試——檢查模型路由與限流', 1, 'llmretry')
  }
  if (event.type === 'approval/decided') {
    const d = (event.data ?? {}) as Record<string, any>
    const out = String(d.outcome ?? d.approved ?? '')
    if (/reject|deny|駁回|拒絕/i.test(out)) {
      return pushItem(state, 'signal', '審批被拒絕——方向或操作未獲認可,與用戶確認', 2, `reject:${hashKey(out)}`)
    }
    return state
  }
  if (event.type === 'turn/start') return { ...state, turnWrites: 0 }
  if (event.type === 'turn/end') {
    let next = state
    if (state.turnWrites > 0) {
      next = { ...state, turnsSinceWrite: 0 }
    } else {
      const streak = state.turnsSinceWrite + 1
      next = { ...state, turnsSinceWrite: streak }
      if (streak === 3 || streak === 6 || streak === 9) {
        next = pushItem(next, 'risk', `已連續 ${streak} 回合無檔案產出——檢查是否偏離交付目標`, 2, `nowrite:${streak}`)
      }
    }
    // ── 存檔計畫:重要性 ≥2、未存過,每回合最多 3 條(純函數,與存檔監聽器一致)──
    // 只把「深刻的事」寫進記憶(用戶方向):真錯誤 fail*(挫折)/用戶糾正 corr/目標 goal;
    // 壓縮、無產出、審批拒絕、重試、瞬態等過程噪音不進記憶。
    let budget = 3
    const savedKeySet = new Set(state.saved.map((s) => s.key))
    const toSave: InsightItem[] = []
    for (const item of next.items) {
      if (budget <= 0) break
      if (item.importance < 2) continue
      if (!/^(fail|corr|goal)/.test(item.key)) continue
      if (savedKeySet.has(item.key)) continue
      savedKeySet.add(item.key)
      toSave.push(item)
      budget -= 1
    }
    if (toSave.length > 0) {
      const saved = [...next.saved, ...toSave]
      next = { ...next, saved: saved.length > 100 ? saved.slice(-100) : saved }
    }
    return next
  }
  return state
}

// ── 記憶寫入(洞察自動存檔)─────────────────────────────────────────────────

let saveCounter = 0
function nextSaveId(): string {
  saveCounter += 1
  return `ins-${Date.now().toString(36)}-${saveCounter.toString(36)}`
}

interface StorageDomainLike { open(spec: unknown): Promise<DomainLike> }
interface DomainLike {
  table(name: string): TableLike
  close(): Promise<void> | void
}
interface TableLike { put(id: string, record: unknown): Promise<unknown> }

export interface ProjectionCtx {
  sessionProjections: {
    register(d: {
      key: string
      schema: { parse: (v: unknown) => unknown }
      init: () => unknown
      apply: (state: any, event: any) => unknown
      view: (state: any) => unknown
      stateVersion: number
    }): () => void
  }
  storageDomain?: StorageDomainLike
  llm?: LlmLike
  webServer?: {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
  sessionQuery?: {
    listEvents(sessionId: string): Promise<Array<{ seq?: number; type: string; data?: any }>>
    readSession(sessionId: string): Promise<{ events: Array<{ seq?: number; type: string; data?: any }> }>
    listSessions(): Promise<Array<{ header: { id?: string; cwd?: string; title?: string } }>>
  }
  on(name: string, listener: (...args: any[]) => void): () => void
}

// ── 觀測智能體:訊息摘要 → LLM 增量觀測 → 里程碑/敘事持久化 ──────────────────

interface DigestItem { seq: number; kind: string; text: string }
interface Milestone { seq: number; kind: string; title: string; why: string; evidenceSeq: number }
interface PathRecord { name: string; value: string; effort: string; firstStep: string }
interface ObsState {
  digest: DigestItem[]
  lastObservedIdx: number
  narrative: string
  topic: string
  milestones: Milestone[]
  suggestedTodos: Array<{ content: string; why: string }>
  insight: string
  turnsSinceInsight: number
  /** 記憶智能體節奏:每 3 輪從增量 digest 提取長期記憶。 */
  turnsSinceMem: number
  turnCount: number
  seq: number
  pending: Record<string, { name: string; path: string }>
  digestCap: number
  /** 洞察頁生成物——持久化,直到用戶下次生成才覆寫(切頁不丟)。 */
  summary: string
  paths: PathRecord[]
}

interface LlmLike {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    system?: string
    messages: unknown[]
    maxTokens?: number
    temperature?: number
  }): AsyncIterable<{ type: string; text?: string }>
}

const OBS_SHARED = [
  '你是「觀測者」——為研發 session 維護滾動觀測編年史。',
  '你只輸出 JSON,不輸出其他任何文字。',
  '敘事主線是「進步與成果」:完成了什麼、交付了什麼、往前推進了什麼、學到了什麼。',
  '工具失敗與除錯細節不是敘事重點(觀測頁另有錯誤與統計區塊)——只在其實際影響成果時一句帶過。',
  '框架攔截類錯誤(沙箱拒絕、審批要求、讀前編輯政策等)與重啟/網絡瞬態錯誤是規則內的正常保護,不是卡點——一律不寫進敘事、里程碑或建議。',
  '事件([cmd]/[write] 等)是成果的證據,不是敘事主體。',
  'JSON 格式:',
  '{',
  '  "narrative": "完整敘事文字",',
  '  "topic": "一句話當前主題/子目標",',
  '  "milestones": [{"kind":"首次成功|方向轉變|突破|反覆卡點|交付物完成|用戶糾正|目標建立","title":"≤20字","why":"≤60字,為何重要","evidenceSeq":數字}],',
  '  "suggestedTodos": [{"content":"≤30字,可執行的下一步待辦","why":"≤40字,為什麼該做"}]',
  '}',
  '規則:只根據提供的內容;沒有真正的里程碑回空陣列;evidenceSeq 引用輸入事件的序號;suggestedTodos 最多 2 條、沒有則空陣列;繁體中文。',
].join('\n')

const OBS_SYSTEM = OBS_SHARED + '\n' + [
  '【增量模式——只回新段落】',
  '你會收到:本回合新內容(歷史摘要流的最新一段)。',
  '只輸出本回合的新段落文字(「## 近期」開頭,聚焦本回合的進步與成果;交付物逐一點名),不要回傳整份敘事。',
  'JSON 格式:{"section": "本回合新段落文字(≤300字)", "topic": "一句話當前主題", "milestones": [...], "suggestedTodos": [...]}',
  'milestones/suggestedTodos 規則同上;沒有就空陣列。',
].join('\n')

const OBS_SYSTEM_REBUILD = OBS_SHARED + '\n' + [
  '【重建模式——分段續寫】',
  '你會收到:已有編年史(可能為空)+ 已有里程碑 + 本段新內容(歷史摘要流的一段)。',
  '任務:把本段新內容「融入」編年史——這是一份從頭到尾的全程梳理:',
  '- 開頭交代:這個 session 的初始目標是什麼、方向如何一步步演變。',
  '- 主體按階段分節(## 階段名):目標、推進了什麼、產出/交付物(**逐一點名,不許遺漏套件/功能/文件**)、關鍵事實、結果。',
  '- 收尾交代:你對用戶動機與走向的推測(標明是推測)。',
  '- 保留並可精煉已有內容;敘事可增長至 10000 字。',
  '- 進步與成果是主線;工具失敗與除錯細節只在影響成果時一句帶過。',
  'narrative 欄位回傳「完整的更新後編年史全文」;milestones 與已有里程碑去重(同 kind+title 不重複加入)。',
].join('\n')

// 自動洞察(每 5 輪):價值/方向/潛力發現——錯誤與踩坑由記憶承載,這裡只談價值。
const INSIGHT_AUTO_SYSTEM = [
  '你是「洞察」——每 5 輪對一個研發 session 做一次價值與方向評估。',
  '根據提供的觀測敘事與里程碑,直接輸出 150–250 字(不要 JSON、不要標題):',
  '1. 價值發現:這幾輪產生了什麼有價值的東西(成果/能力/可複用資產)',
  '2. 方向發現:方向在收斂還是發散;有沒有更值得的路線',
  '3. 潛力路徑:基於已有成果,項目還有哪些有價值的展開方向或選項(至多兩條)',
  '4. 下一個最有價值的動作:一句話',
  '規則:不列錯誤清單、不提除錯細節——錯誤與踩坑已由記憶承載;這裡只談價值、方向與潛力。繁體中文,簡潔。',
].join('\n')

// ── 筆記/待辦域(每 session 一份,持久化;僅本模組使用,直接 open 不衝突)─────

const notesSchema = zod.object({
  sessionId: zod.string(),
  notes: zod.array(zod.object({ seq: zod.number(), text: zod.string(), createdAt: zod.number() })),
  todos: zod.array(zod.object({
    seq: zod.number(), content: zod.string(), done: zod.boolean(), createdAt: zod.number(), source: zod.string(),
  })),
  updatedAt: zod.number(),
})

function initObs(): ObsState {
  return { digest: [], lastObservedIdx: 0, narrative: '', topic: '', milestones: [], suggestedTodos: [], insight: '', turnsSinceInsight: 0, turnsSinceMem: 0, turnCount: 0, seq: 0, pending: {}, digestCap: 120, summary: '', paths: [] }
}

function digestPush(state: ObsState, kind: string, text: string): ObsState {
  const item: DigestItem = { seq: state.seq + 1, kind, text }
  const digest = [...state.digest, item]
  const cap = state.digestCap > 0 ? state.digestCap : 120
  return { ...state, seq: state.seq + 1, digest: digest.length > cap ? digest.slice(-cap) : digest }
}

function extractArgString(argsStr: unknown, field: string): string {
  try {
    const a = JSON.parse(typeof argsStr === 'string' ? argsStr : '{}') as Record<string, unknown>
    const v = a[field]
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

function foldDigest(state: ObsState, event: { type: string; data?: any }): ObsState {
  if (event.type === 'user/message') {
    const d = event.data ?? {}
    const text = typeof d.text === 'string' ? d.text : ''
    if (text === '') return state
    return digestPush(state, 'user', text.slice(0, 300))
  }
  if (event.type === 'assistant/message') {
    const d = event.data ?? {}
    let text = ''
    const content = d.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'text' && typeof b.text === 'string') text += b.text + ' '
      }
      text = text.trim()
    } else if (typeof d.text === 'string') {
      text = d.text
    }
    if (text === '') return state
    return digestPush(state, 'assistant', text.slice(0, 240))
  }
  if (event.type === 'tool/call') {
    const d = event.data ?? {}
    if (typeof d.callId === 'string' && typeof d.name === 'string') {
      const path = (d.name === 'write' || d.name === 'edit' || d.name === 'read') ? extractPath(d.name, d.arguments) : null
      let next: ObsState = { ...state, pending: { ...state.pending, [d.callId]: { name: d.name, path: path ?? '' } } }
      // 有意義的工具呼叫也進摘要:bash 指令(建置/部署證據)、cordis 操作
      if (d.name === 'bash') {
        const cmd = extractArgString(d.arguments, 'command')
        if (cmd !== '') next = digestPush(next, 'cmd', `執行:${cmd.slice(0, 140)}`)
      } else if (d.name === 'cordis_define' || d.name === 'cordis_run') {
        const pname = extractArgString(d.arguments, 'name') || extractArgString(d.arguments, 'pluginId')
        next = digestPush(next, 'cmd', `${d.name}${pname !== '' ? ` ${pname}` : ''}`)
      }
      return next
    }
    return state
  }
  if (event.type === 'tool/result') {
    const d = event.data ?? {}
    let callId: string | null = null
    const content = d.message?.content
    if (Array.isArray(content) && content[0] && typeof content[0].toolCallId === 'string') callId = content[0].toolCallId
    const keys = Object.keys(state.pending)
    const key = callId !== null && state.pending[callId] !== undefined ? callId : keys[0]
    if (key === undefined) return state
    const pend = state.pending[key]
    const { [key]: _dropped, ...pending } = state.pending
    const ok = d.error === undefined || d.error === null
    const next: ObsState = { ...state, pending }
    if (!ok) {
      const code = String((d.error && typeof d.error === 'object' && d.error.code) || 'error')
      return digestPush(next, 'fail', `工具「${pend.name}」失敗(${code})`)
    }
    if ((pend.name === 'write' || pend.name === 'edit') && pend.path !== '') {
      return digestPush(next, 'write', `${pend.name === 'write' ? '寫入' : '編輯'} ${pend.path}`)
    }
    return next
  }
  if (event.type === 'goal/change') {
    const d = (event.data ?? {}) as Record<string, any>
    const objective = typeof d.objective === 'string' ? d.objective : typeof d.payload?.objective === 'string' ? d.payload.objective : ''
    if (objective !== '') return digestPush(state, 'goal', `目標更新:「${objective.slice(0, 100)}」`)
    return state
  }
  if (event.type === 'command/run') {
    const d = (event.data ?? {}) as Record<string, any>
    const cmdName = String(d.name || d.command || '')
    if (cmdName !== '') return digestPush(state, 'cmd', `命令:/${cmdName}`)
    return state
  }
  if (event.type === 'todo/write') return digestPush(state, 'mech', '待辦清單更新')
  if (event.type === 'compaction/start') return digestPush(state, 'mech', '上下文壓縮開始')
  return state
}

// 字串感知的平衡大括號截取:敘事文本常含「}」(程式碼/設定檔描述),
// naive 首{-尾} 切法會誤切,導致整段 JSON 解析失敗(增量觀測全天失敗的真兇之一)。
// 未閉合(真截斷)回 null。
function extractFirstBalanced(raw: string, open: string, close: string): string | null {
  const start = raw.indexOf(open)
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}
function extractFirstJsonObject(raw: string): string | null { return extractFirstBalanced(raw, '{', '}') }
function extractFirstJsonArray(raw: string): string | null { return extractFirstBalanced(raw, '[', ']') }

// 模型常在 JSON 字串值裡輸出字面換行/Tab(pretty-print 習慣)——JSON.parse 拒收
// 字串內裸控制符(當前進程增量失敗的主因之一)。字串狀態下轉義,保住內容。
function sanitizeJsonControlChars(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) { out += c; esc = false; continue }
      if (c === '\\') { out += c; esc = true; continue }
      if (c === '"') { out += c; inStr = false; continue }
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') { out += '\\r'; continue }
      if (c === '\t') { out += '\\t'; continue }
      if (c.charCodeAt(0) < 0x20) { out += ' '; continue }
      out += c
      continue
    }
    if (c === '"') inStr = true
    out += c
  }
  return out
}

// 寬鬆 JSON 解析:平衡擷取 → 直接 parse → 控制符清洗後 parse → null
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const slice = extractFirstJsonObject(raw)
  if (slice === null) return null
  try { return JSON.parse(slice) as Record<string, unknown> } catch { /* 嘗試清洗 */ }
  try { return JSON.parse(sanitizeJsonControlChars(slice)) as Record<string, unknown> } catch { return null }
}
function parseJsonArrayLoose(raw: string): unknown[] | null {
  const slice = extractFirstJsonArray(raw)
  if (slice === null) return null
  try { const v = JSON.parse(slice); return Array.isArray(v) ? v : null } catch { /* 嘗試清洗 */ }
  try { const v = JSON.parse(sanitizeJsonControlChars(slice)); return Array.isArray(v) ? v : null } catch { return null }
}

function parseObsJson(raw: string): { narrative: string; topic: string; milestones: Milestone[]; suggestedTodos: Array<{ content: string; why: string }> } | null {
  const obj = parseJsonLoose(raw)
  if (obj === null) return null
  try {
    if (typeof obj.narrative !== 'string') return null
    const rawMs = Array.isArray(obj.milestones) ? obj.milestones : []
    const milestones: Milestone[] = rawMs
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
      .filter((m) => typeof m.title === 'string' && typeof m.kind === 'string')
      .slice(0, 5)
      .map((m) => ({
        seq: 0,
        kind: String(m.kind),
        title: String(m.title).slice(0, 40),
        why: typeof m.why === 'string' ? m.why.slice(0, 120) : '',
        evidenceSeq: typeof m.evidenceSeq === 'number' ? m.evidenceSeq : 0,
      }))
    const rawTodos = Array.isArray(obj.suggestedTodos) ? obj.suggestedTodos : []
    const suggestedTodos = rawTodos
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
      .filter((m) => typeof m.content === 'string')
      .slice(0, 2)
      .map((m) => ({ content: String(m.content).slice(0, 60), why: typeof m.why === 'string' ? m.why.slice(0, 80) : '' }))
    return {
      narrative: obj.narrative.slice(0, 12000),
      topic: typeof obj.topic === 'string' ? obj.topic.slice(0, 100) : '',
      milestones,
      suggestedTodos,
    }
  } catch {
    return null
  }
}

export function applyPerspectives(ctx: ProjectionCtx): void {
  ctx.sessionProjections.register({
    key: 'fileActivity', schema: fileSchema,
    init: () => ({ files: {}, pending: {}, recent: [], seq: 0 }),
    apply: foldFile, view: viewFiles, stateVersion: 1,
  })
  ctx.sessionProjections.register({
    key: 'mechEvents', schema: mechSchema,
    init: () => ({ items: [], seq: 0 }),
    apply: foldMech, view: (s: { items: MechItem[] }) => ({ items: s.items }), stateVersion: 1,
  })
  ctx.sessionProjections.register({
    key: 'goalTrace', schema: goalSchema,
    init: () => ({ items: [], seq: 0 }),
    apply: foldGoal, view: (s: { items: GoalItem[] }) => ({ items: s.items }), stateVersion: 1,
  })
  ctx.sessionProjections.register({
    key: 'insightsScan', schema: scanSchema,
    init: initScan, apply: foldScan,
    view: (s: ScanState) => ({ items: s.items, saved: s.saved, policyBlocks: s.policyBlocks, transientErrs: s.transientErrs }), stateVersion: 2,
  })

  // ── 洞察自動存檔 ──
  const domain = ctx.storageDomain
  if (domain === undefined) return
  let table: TableLike | undefined
  let openFailed = false

  async function ensureTable(): Promise<TableLike | undefined> {
    if (table) return table
    if (openFailed) return undefined
    try {
      // 插件級單例:與 memory 模組共用同一 vector_memory 域(重複 open 會拋 DomainError)
      const d = await openVectorMemoryDomain(domain!)
      table = d.table('memories') as TableLike
      return table
    } catch {
      openFailed = true
      return undefined
    }
  }

  // 記憶 row key 加 session 前綴:避免跨 session 同名 key(如 llmretry、
  // fail:read)互相覆寫。舊格式無前綴的歷史 row 仍在(90 天過期),不遷移。
  // 真錯誤類洞察(fail*)以「踩坑」標籤入記憶——犯錯踩坑由記憶承載;
  // 政策/瞬態錯誤在 foldScan 已被攔截,永遠到不了這裡。
  async function saveInsight(sid: string, item: InsightItem): Promise<boolean> {
    try {
      const t = await ensureTable()
      if (!t) return false
      const now = Date.now()
      // 記憶模塊對齊人腦隱喻(用戶:記住挫折或深刻的事)——
      // fail→挫折、corr(用戶糾正)→學習、goal(目標更新)→決策;其餘已在存檔計畫攔截
      const tag = item.key.startsWith('fail') ? '挫折' : item.key.startsWith('corr') ? '學習' : '決策'
      await t.put(`${sid}:${item.key}`, {
        id: nextSaveId(),
        content: `[${tag}] ${item.text}`,
        tags: [tag, item.kind],
        createdAt: now,
        updatedAt: now,
        hits: 0,
        expiresAt: now + 90 * 86400000,
      })
      return true
    } catch {
      return false
    }
  }

  interface SaverEntry {
    st: ScanState
    savedIdx: number
    /** 重啟後首見 session:全歷史回放完成前,即時事件先排佇列,避免亂序。 */
    replayed: boolean
    queue: Array<{ type: string; data?: any }>
  }
  const saverStates = new Map<string, SaverEntry>()

  function saverFlush(sid: string, entry: SaverEntry): void {
    // fold 已把應存項目累進 st.saved(純函數);這裡只按水位線執行實際寫入。
    // row key 即 item.key(加 sid 前綴),重放覆寫同 key,冪等無重複。
    const pending = entry.st.saved.slice(entry.savedIdx)
    for (const item of pending) void saveInsight(sid, item)
    entry.savedIdx = entry.st.saved.length
  }

  function saverFold(sid: string, entry: SaverEntry, event: { type: string; data?: any }): void {
    entry.st = foldScan(entry.st, event)
    if (event.type === 'turn/end') saverFlush(sid, entry)
  }

  // 重啟回放(P1-8):saver 原本只折新事件,而 insightsScan 投影首次觸碰折全量
  // 歷史 → 視圖「✓已存」標記與實際寫入不一致。首見 session 時回放全歷史 fold
  // 並補寫(同 key 覆寫),讓標記與落盤對齊;同時恢復 seen 去重狀態。
  async function replaySaver(sid: string, entry: SaverEntry): Promise<void> {
    const sq = ctx.sessionQuery
    if (sq !== undefined) {
      try {
        const snap = await sq.readSession(sid)
        const events = snap && Array.isArray(snap.events) ? snap.events : []
        let count = 0
        for (const ev of events) {
          entry.st = foldScan(entry.st, { type: ev.type, data: ev.data })
          count += 1
          // 每 2000 條讓出事件迴圈(38 萬+ 事件同步折疊實測 ~20s CPU)
          if (count % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        }
        saverFlush(sid, entry) // 補寫本 process 未寫、但投影已標記的歷史洞察
      } catch {
        // 回放失敗靜默:後續增量照常
      }
    }
    entry.replayed = true
    const queued = entry.queue.splice(0, entry.queue.length)
    for (const ev of queued) saverFold(sid, entry, ev)
  }

  ctx.on('session/event', (session: { id?: string }, event: { type: string; data?: any }) => {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    if (sid === '') return
    let entry = saverStates.get(sid)
    if (entry === undefined) {
      entry = { st: initScan(), savedIdx: 0, replayed: false, queue: [] }
      saverStates.set(sid, entry)
      if (saverStates.size > 32) {
        const oldest = saverStates.keys().next().value
        if (oldest !== undefined) saverStates.delete(oldest)
      }
      entry.queue.push({ type: event.type, data: event.data })
      void replaySaver(sid, entry)
      return
    }
    if (!entry.replayed) {
      entry.queue.push({ type: event.type, data: event.data })
      return
    }
    saverFold(sid, entry, event)
  })

  // ── 觀測智能體(turn/end 增量 LLM 觀測 → 敘事/主題/里程碑,持久化 + 路由)──
  const llm = ctx.llm
  const webServer = ctx.webServer
  if (llm !== undefined) {
    const llmRef = llm
    let obsTable: TableLike | undefined
    let obsOpenFailed = false

    async function ensureObsTable(): Promise<TableLike | undefined> {
      if (obsTable) return obsTable
      if (obsOpenFailed) return undefined
      if (domain === undefined) return undefined
      try {
        // 插件級單例:與 insight 模組共用同一 observation 域
        const d = await openObservationDomain(domain)
        obsTable = d.table('sessions') as TableLike
        return obsTable
      } catch {
        obsOpenFailed = true
        return undefined
      }
    }

    async function persistObs(sessionId: string, st: ObsState): Promise<void> {
      try {
        const t = await ensureObsTable()
        if (!t) return
        await t.put(sessionId, {
          sessionId,
          narrative: st.narrative,
          topic: st.topic,
          milestones: st.milestones,
          suggestedTodos: st.suggestedTodos,
          insight: st.insight,
          turnCount: st.turnCount,
          summary: st.summary,
          paths: st.paths,
          updatedAt: Date.now(),
        })
      } catch {
        // 持久化失敗靜默降級,不影響主流程
      }
    }

    // 洞察頁生成物(價值總結/潛力路徑)持久化:切頁不丟,直到下次生成覆寫。
    // 有記憶體狀態走 persistObs;非活躍 session 對儲存做 read-modify-write。
    async function persistGenerated(sid: string, patch: { summary?: string; paths?: PathRecord[] }): Promise<void> {
      try {
        const entry = obsStates.get(sid)
        if (entry !== undefined) {
          if (typeof patch.summary === 'string') entry.summary = patch.summary
          if (Array.isArray(patch.paths)) entry.paths = patch.paths
          await persistObs(sid, entry)
          return
        }
        const stored = await readObs(sid)
        if (stored && typeof stored === 'object') {
          const t = await ensureObsTable()
          if (t) await t.put(sid, { ...(stored as Record<string, unknown>), ...patch, updatedAt: Date.now() })
        }
      } catch {
        // 靜默
      }
    }

    // 里程碑自動寫入記憶(vector_memory 域,標籤 里程碑,跨 session 可檢索)
    // row key 同樣加 session 前綴:ms-<seq>-<title> 跨 session 會撞 key(同 seq 同標題)。
    async function saveMilestoneToMemory(sid: string, m: Milestone): Promise<void> {
      try {
        const t = await ensureTable()
        if (!t) return
        const now = Date.now()
        await t.put(`ms:${sid}:${m.seq}-${m.title.slice(0, 20)}`, {
          id: `ms-${now.toString(36)}-${m.seq}`,
          content: `[里程碑][${m.kind}] ${m.title} — ${m.why}`,
          tags: ['里程碑', m.kind],
          createdAt: now,
          updatedAt: now,
          hits: 0,
          expiresAt: now + 90 * 86400000,
        })
      } catch {
        // 靜默降級
      }
    }

    async function readObs(sessionId: string): Promise<unknown | undefined> {
      try {
        const t = await ensureObsTable()
        if (!t) return undefined
        const getter = (t as unknown as { get?: (id: string) => Promise<unknown> }).get
        if (typeof getter !== 'function') return undefined
        return await getter.call(t, sessionId)
      } catch {
        return undefined
      }
    }

    // 增量模式的段落解析:{"section": "...", "topic": "...", "milestones": [...], "suggestedTodos": [...]}
    // 增量只要求 section 存在;里程碑/待辦解析失敗不連坐(寬鬆解析)。
    function parseChunkJson(raw: string): { section: string; topic: string; milestones: Milestone[]; suggestedTodos: Array<{ content: string; why: string }> } | null {
      const obj = parseJsonLoose(raw)
      if (obj === null) return null
      const section = typeof obj.section === 'string' ? obj.section : (typeof obj.narrative === 'string' ? obj.narrative : '')
      if (section === '') return null
      const parsed = parseObsJson(raw) // 里程碑/待辦(narrative 缺失不影響此處回傳)
      return {
        section: section.slice(0, 1200),
        topic: parsed !== null ? parsed.topic : (typeof obj.topic === 'string' ? (obj.topic as string).slice(0, 100) : ''),
        milestones: parsed !== null ? parsed.milestones : [],
        suggestedTodos: parsed !== null ? parsed.suggestedTodos : [],
      }
    }

    // host 端敘事拼接與裁剪:開頭保留初始目標段,超長時中段精煉省略
    function appendSection(narrative: string, section: string): string {
      let next = narrative === '' ? section : narrative + '\n\n' + section
      if (next.length > 12500) {
        const head = next.slice(0, 1000)
        const tail = next.slice(-10000)
        next = head + '\n\n…(中段精煉省略)…\n\n' + tail
      }
      return next
    }

    // 不設 maxTokens:provider 缺省即不帶 max_tokens,讓模型自己決定輸出長度
    // (用戶原則:大模型認為要輸出多少就輸出多少;坑 #2 的教訓是小額度→0 字,放開後由模型自治)
    async function callObsLlm(sessionId: string, system: string, prompt: string): Promise<string> {
      let raw = ''
      try {
        for await (const chunk of llmRef.stream({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'high',
          system,
          messages: [{ id: 'obs-q-1', role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
          temperature: 0.2,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        }
      } catch (e) {
        console.error('[observation] llm.stream failed for session', sessionId, String(e && (e as Error).message ? (e as Error).message : e))
        return ''
      }
      return raw
    }

    function mergeMilestones(sid: string, st: ObsState, milestones: Milestone[]): Milestone[] {
      const seen = new Set(st.milestones.map((m) => m.kind + '|' + m.title))
      const added: Milestone[] = []
      for (const m of milestones) {
        const k = m.kind + '|' + m.title
        if (seen.has(k)) continue
        seen.add(k)
        added.push({ ...m, seq: st.seq })
      }
      for (const m of added) void saveMilestoneToMemory(sid, m)
      return [...st.milestones, ...added].slice(-30)
    }

    // 增量觀測(每輪):模型只回本回合新段落,host 拼接與裁剪
    async function observeTurn(sessionId: string, st: ObsState): Promise<void> {
      const newItems = st.digest.slice(st.lastObservedIdx)
      if (newItems.length === 0) return
      const meaningful = newItems.some((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'fail' || i.kind === 'write' || i.kind === 'goal' || i.kind === 'cmd')
      if (!meaningful) return
      const input = newItems.slice(-14).map((i) => `#${i.seq} [${i.kind}] ${i.text}`).join('\n')
      const prompt = ['【本回合新內容】', input].join('\n')
      const raw = await callObsLlm(sessionId, OBS_SYSTEM, prompt)
      if (raw === '') {
        console.error('[observation] 增量輸出為空(模型無輸出),session', sessionId)
        return
      }
      const parsed = parseChunkJson(raw)
      if (parsed === null) {
        // 兜底打撈:JSON 全毀時至少取出 section 文本,敘事不中斷(里程碑/待辦本輪放棄)
        const m = /"section"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(raw)
        const salvaged = m && typeof m[1] === 'string'
          ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
          : ''
        if (salvaged.length >= 40) {
          console.error('[observation] 增量 JSON 毀損,打撈 section(' + salvaged.length + ' 字),session', sessionId)
          st.narrative = appendSection(st.narrative, salvaged.slice(0, 1200))
          st.turnCount += 1
          st.lastObservedIdx = st.digest.length
          await persistObs(sessionId, st)
          return
        }
        console.error('[observation] 增量輸出無法解析 JSON,session', sessionId, 'raw 長度:', raw.length, 'raw 頭:', raw.slice(0, 200), 'raw 尾:', raw.slice(-120))
        return
      }
      st.narrative = appendSection(st.narrative, parsed.section)
      if (parsed.topic !== '') st.topic = parsed.topic
      if (parsed.milestones.length > 0) st.milestones = mergeMilestones(sessionId, st, parsed.milestones)
      if (parsed.suggestedTodos.length > 0) st.suggestedTodos = parsed.suggestedTodos
      st.turnCount += 1
      st.lastObservedIdx = st.digest.length
      await persistObs(sessionId, st)
    }

    // 重建觀測(手動/初始化):大段續寫,全過程覆蓋,交付物逐一點名。
    // v4-flash 有 1M 上下文:本 session 2577 條摘要(~38 萬字元)分 3 段即可;
    // 單段上限 1000 條摘要(~15 萬字元),遠低於模型上下文。
    // 回傳成功解析的段數;0 段 = 完全失敗,**不寫入**(見資料保護註釋)
    async function rebuildChronicle(sessionId: string, st: ObsState): Promise<number> {
      const items = st.digest
      if (items.length === 0) return 0
      const CHUNK = 1000
      let pass = 0
      let parsedCount = 0
      for (let i = 0; i < items.length; i += CHUNK) {
        pass += 1
        const chunk = items.slice(i, i + CHUNK)
        const chunkText = chunk.map((it) => `#${it.seq} [${it.kind}] ${it.text}`).join('\n')
        const prompt = [
          '【已有編年史】', st.narrative || '(無)',
          '【已有里程碑】', st.milestones.map((m) => `[${m.kind}]${m.title}`).join('; ') || '(無)',
          `【本段新內容(第 ${pass} 段,共 ${Math.ceil(items.length / CHUNK)} 段)】`, chunkText,
        ].join('\n')
        const raw = await callObsLlm(sessionId, OBS_SYSTEM_REBUILD, prompt)
        if (raw === '') {
          console.error('[observation] 重建第 ' + pass + ' 段輸出為空,session', sessionId)
          continue
        }
        const parsed = parseObsJson(raw)
        if (parsed === null) {
          console.error('[observation] 重建第 ' + pass + ' 段無法解析 JSON,session', sessionId, 'raw 長度:', raw.length, 'raw 頭:', raw.slice(0, 200))
          continue
        }
        parsedCount += 1
        st.narrative = parsed.narrative
        if (parsed.topic !== '') st.topic = parsed.topic
        if (parsed.milestones.length > 0) st.milestones = mergeMilestones(sessionId, st, parsed.milestones)
        if (parsed.suggestedTodos.length > 0) st.suggestedTodos = parsed.suggestedTodos
      }
      // 資料保護:全部段落失敗時不 persist、不動 turnCount——
      // 空狀態覆寫掉好敘事的事故已發生過一次(2026-08-17,用戶回報)
      if (parsedCount === 0) {
        console.error('[observation] 重建全部段落失敗,保留原有敘事不覆寫,session', sessionId)
        return 0
      }
      st.turnCount += 1
      st.lastObservedIdx = st.digest.length
      await persistObs(sessionId, st)
      return parsedCount
    }

    // 自動洞察(每 5 輪):基於觀測敘事與里程碑的價值導向評估
    async function generateInsight(sessionId: string, st: ObsState): Promise<void> {
      if (st.narrative === '') return
      const ms = st.milestones.slice(-6).map((m) => `- [${m.kind}] ${m.title}`).join('\n')
      const prompt = `【觀測敘事】\n${st.narrative.slice(-3000)}\n【近期里程碑】\n${ms || '(無)'}`
      let text = ''
      try {
        for await (const chunk of llmRef.stream({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'high',
          system: INSIGHT_AUTO_SYSTEM,
          messages: [{ id: 'ins-auto-1', role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
          temperature: 0.3,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
      } catch (e) {
        console.error('[observation] auto-insight llm failed', sessionId, String(e && (e as Error).message ? (e as Error).message : e))
        return
      }
      if (text.trim() === '') {
        console.error('[observation] auto-insight empty output', sessionId)
        return
      }
      st.insight = text.trim().slice(0, 1200)
      st.turnsSinceInsight = 0
      await persistObs(sessionId, st)
    }

    // ── 記憶智能體:每 3 輪從近期軌跡提煉長期記憶,LLM 理解後歸入模塊 ──
    // (用戶方向:記憶也該是智能體——跟踪掃描軌跡與對話,分類進記憶的不同模塊;
    //  取代記憶頁原本的 regex 死分類。複用觀測 digest 流,不另起折疊。)
    const MEMORY_AGENT_SYSTEM = [
      '你是「記憶官」——從研發 session 的軌跡與對話中,挑出值得長期記住的內容。',
      '只輸出 JSON 數組,不輸出其他任何文字:',
      '[{"text":"一句話記憶(≤80字,含關鍵事實/做法/原因)","kind":"挫折|技術|學習|決策"}]',
      '模塊定義(像人腦:記住挫折或深刻的事;技術的沉澱與發現):',
      '- 挫折:踩坑碰壁、失敗教訓、卡點與繞法(什麼做法失敗了、以後怎麼避免)',
      '- 技術:技術沉澱與技術發現——有效的方法、模式、指令、寫法',
      '- 學習:領悟、用戶偏好、用戶明確表達的原則',
      '- 決策:為什麼這麼選(取捨理由)、目標的確立與轉向',
      '規則:',
      '1. 政策攔截(沙箱/審批)與瞬態錯誤(重啟/網絡)是規則內事件,不值得記。',
      '2. 不要重複「已有記憶」裡的內容。',
      '3. 沒有值得記的就回空數組;至多 3 條;繁體中文。',
    ].join('\n')

    async function saveAgentMemory(sid: string, text: string, kind: string): Promise<void> {
      try {
        const t = await ensureTable()
        if (!t) return
        const kinds = ['挫折', '技術', '學習', '決策']
        // 兼容舊詞表(卡點/失敗→挫折)
        const legacy = kind === '卡點' || kind === '失敗' ? '挫折' : kind
        const k = kinds.indexOf(legacy) !== -1 ? legacy : '學習'
        const now = Date.now()
        // key = session + 內容雜湊:同內容重複提取會覆寫同一 row,不產生重複
        await t.put(`memagent:${sid}:${hashKey(text.slice(0, 60))}`, {
          id: `mema-${now.toString(36)}-${hashKey(text.slice(0, 20))}`,
          content: `[${k}] ${text}`,
          tags: ['智能記憶', k],
          createdAt: now,
          updatedAt: now,
          hits: 0,
          expiresAt: now + 90 * 86400000,
        })
      } catch {
        // 靜默降級
      }
    }

    async function extractMemories(sessionId: string, st: ObsState): Promise<void> {
      const recent = st.digest.slice(-30)
      const meaningful = recent.filter((i) => i.kind !== 'mech')
      if (meaningful.length < 3) {
        st.turnsSinceMem = 0
        return
      }
      // 列出近期記憶避免重複提取
      let existing = ''
      try {
        const t = await ensureTable()
        const entriesFn = t ? (t as unknown as { entries?: () => Iterable<[string, unknown]> }).entries : undefined
        if (typeof entriesFn === 'function') {
          const rows: string[] = []
          for (const [, rec] of entriesFn.call(t)) {
            const r = rec as { content?: string }
            if (r && typeof r.content === 'string') rows.push(r.content.slice(0, 60))
          }
          existing = rows.slice(-15).join('\n')
        }
      } catch {
        // 拿不到清單也照常提取
      }
      const input = meaningful.map((i) => `#${i.seq} [${i.kind}] ${i.text}`).join('\n')
      const prompt = `【近期軌跡與對話】\n${input}\n【已有記憶(不要重複)】\n${existing || '(無)'}`
      let raw = ''
      try {
        for await (const chunk of llmRef.stream({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'high',
          system: MEMORY_AGENT_SYSTEM,
          messages: [{ id: 'mem-q-1', role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
          temperature: 0.2,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        }
      } catch (e) {
        console.error('[memory-agent] llm 呼叫失敗', sessionId, String(e && (e as Error).message ? (e as Error).message : e))
        return
      }
      st.turnsSinceMem = 0
      if (raw.trim() === '') {
        console.error('[memory-agent] 輸出為空', sessionId)
        return
      }
      const arr = parseJsonArrayLoose(raw)
      if (arr === null) {
        console.error('[memory-agent] 輸出無法解析,session', sessionId, 'raw 長度:', raw.length, 'raw 頭:', raw.slice(0, 200), 'raw 尾:', raw.slice(-120))
        return
      }
      try {
        const items = arr
          .filter((it): it is Record<string, unknown> => it !== null && typeof it === 'object')
          .filter((it) => typeof it.text === 'string' && (it.text as string).trim() !== '')
          .slice(0, 3)
        for (const it of items) {
          await saveAgentMemory(sessionId, (it.text as string).trim().slice(0, 120), typeof it.kind === 'string' ? it.kind : '')
        }
      } catch {
        console.error('[memory-agent] JSON 解析失敗', sessionId)
      }
    }

    const obsStates = new Map<string, ObsState>()
    const initInFlight = new Set<string>()
    const sessionQuery = ctx.sessionQuery

    // 折疊當前 session 的完整歷史成 digest(重建/初始化的原料)。
    // 只折本 session:同 cwd 下存在其他項目的 session,聚合會污染敘事(實測)。
    async function foldSessionDigest(sid: string, st: ObsState): Promise<ObsState> {
      if (sessionQuery === undefined) return st
      try {
        const snap = await sessionQuery.readSession(sid)
        const events = snap && Array.isArray(snap.events) ? snap.events : []
        let count = 0
        for (const ev of events) {
          st = foldDigest(st, { type: ev.type, data: ev.data })
          count += 1
          // 每 2000 條讓出事件迴圈,避免長時間同步折疊阻塞宿主(38 萬+ 事件實測 ~20s CPU)
          if (count % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        }
      } catch {
        // 讀取失敗靜默:後續增量觀測照常
      }
      return st
    }

    // 初始化觀測:回顧歷史事件,生成一次初始敘事(每 session 只做一次;已有敘事則跳過)
    function initObservation(sid: string, st: ObsState): void {
      if (initInFlight.has(sid)) return
      initInFlight.add(sid)
      void (async () => {
        try {
          const stored = await readObs(sid)
          if (stored && typeof stored === 'object') {
            const s = stored as { narrative?: unknown; topic?: unknown; milestones?: unknown; turnCount?: unknown; summary?: unknown; paths?: unknown }
            if (typeof s.narrative === 'string') st.narrative = s.narrative
            if (typeof s.topic === 'string') st.topic = s.topic
            if (Array.isArray(s.milestones)) st.milestones = s.milestones as Milestone[]
            if (typeof s.turnCount === 'number') st.turnCount = s.turnCount
            if (typeof s.summary === 'string') st.summary = s.summary
            if (Array.isArray(s.paths)) st.paths = s.paths as PathRecord[]
          }
          if (st.narrative !== '') return // 已有敘事(恢復成功),不需初始化
          if (sessionQuery === undefined) return
          st.digestCap = 3000 // 初始化/重建:全過程覆蓋,不丟早期成果
          st = await foldSessionDigest(sid, st)
          obsStates.set(sid, st)
          await rebuildChronicle(sid, st)
        } catch {
          // 初始化失敗靜默:後續回合的增量觀測照常進行
        } finally {
          initInFlight.delete(sid)
        }
      })()
    }

    ctx.on('session/event', (session: { id?: string }, event: { type: string; data?: any }) => {
      const sid = session && typeof session.id === 'string' ? session.id : ''
      if (sid === '') return
      let st = obsStates.get(sid)
      if (st === undefined) {
        st = initObs()
        obsStates.set(sid, st)
        if (obsStates.size > 32) {
          const oldest = obsStates.keys().next().value
          if (oldest !== undefined) obsStates.delete(oldest)
        }
        initObservation(sid, st)
      }
      st = foldDigest(st, event)
      obsStates.set(sid, st)
      if (event.type === 'turn/end') {
        // 觀測敘事:每輪增量更新
        void observeTurn(sid, st).then(() => {
          // 自動洞察:每 5 輪觸發一次(基於最新敘事)
          st.turnsSinceInsight += 1
          if (st.turnsSinceInsight >= 5) void generateInsight(sid, st)
          // 記憶智能體:每 3 輪從近期軌跡提煉長期記憶歸入模塊
          st.turnsSinceMem += 1
          if (st.turnsSinceMem >= 3) void extractMemories(sid, st)
        })
      }
    })

    if (webServer !== undefined) {
      const sendJsonTo = (res: unknown, status: number, value: unknown): void => {
        const r = res as { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }
        const body = JSON.stringify(value)
        r.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) })
        r.end(body)
      }
      const readReqBody = (req: unknown): Promise<string> => new Promise((resolve, reject) => {
        const parts: Buffer[] = []
        const r = req as { on: (ev: string, fn: (c: Buffer) => void) => void }
        r.on('data', (c: Buffer) => parts.push(c))
        r.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
        r.on('error', reject)
      })

      webServer.register({
        kind: 'exact',
        path: '/api/observation',
        handler: async (req: unknown, res: unknown) => {
          try {
            const url = new URL(String((req as { url?: string }).url || ''), 'http://localhost')
            const sid = url.searchParams.get('sessionId') || ''
            if (sid === '') {
              sendJsonTo(res, 400, { error: 'missing sessionId' })
              return
            }
            const stored = await readObs(sid)
            if (stored === undefined) {
              sendJsonTo(res, 200, { empty: true })
              return
            }
            sendJsonTo(res, 200, stored)
          } catch (e) {
            sendJsonTo(res, 500, { error: String(e && (e as Error).message ? (e as Error).message : e) })
          }
        },
      })

      // 重建觀測:回讀全歷史,以「成就主線」重跑一次(救回變薄的敘事)
      webServer.register({
        kind: 'exact',
        path: '/api/observation/rebuild',
        handler: async (req: unknown, res: unknown) => {
          try {
            const method = String((req as { method?: string }).method || 'GET')
            if (method !== 'POST') {
              sendJsonTo(res, 405, { error: 'method not allowed' })
              return
            }
            const raw = await readReqBody(req)
            let args: { sessionId?: unknown } = {}
            try {
              args = JSON.parse(raw || '{}') as typeof args
            } catch {
              sendJsonTo(res, 400, { error: 'invalid JSON' })
              return
            }
            const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
            if (sid === '') {
              sendJsonTo(res, 400, { error: 'missing sessionId' })
              return
            }
            if (sessionQuery === undefined) {
              sendJsonTo(res, 503, { error: 'sessionQuery 未就緒' })
              return
            }
            // 在 scratch 狀態上重建,成功才替換 obsStates 並已 persist;
            // 失敗則保留原有敘事(記憶體與儲存都不動)——不再先重置再冒覆寫風險。
            // 注意:重建期間(約 1–2 分鐘)到達的即時事件仍在舊狀態上折疊,
            // 替換後那一小段事件等下輪增量補上,可接受。
            let st = initObs()
            st.digestCap = 3000 // 重建:全過程覆蓋,不丟早期成果
            st = await foldSessionDigest(sid, st)
            const parsedCount = await rebuildChronicle(sid, st)
            if (parsedCount === 0) {
              sendJsonTo(res, 502, { error: '重建失敗:模型輸出全部無法解析,已保留原有敘事未覆寫。請稍後重試。' })
              return
            }
            obsStates.set(sid, st)
            await generateInsight(sid, st) // 重建後立即產生一次自動洞察
            sendJsonTo(res, 200, { ok: true, parsedCount, turnCount: st.turnCount, narrative: st.narrative, topic: st.topic, insight: st.insight })
          } catch (e) {
            sendJsonTo(res, 500, { error: String(e && (e as Error).message ? (e as Error).message : e) })
          }
        },
      })

      // 記憶域一覽(記憶頁「智能模塊」資料源)。**預設嚴格按 session 隔離**(用戶要求
      // 2026-08-22:記憶頁出現其他 session 內容——同 cwd 的 session 群在一個工作目錄
      // 下做不同任務,「同項目聚合」反而洩漏。改為:
      // - 預設:只回本 session 的 row(key 前綴 <sid>:、memagent:<sid>:,或 row.sid === sid);
      // - ?scope=project:白名單回退——解析 cwd,聚合同項目全部 session(舊行為);
      // - ?scope=all:全部(診斷用)。
      webServer.register({
        kind: 'exact',
        path: '/api/memories',
        handler: async (req: unknown, res: unknown) => {
          try {
            const url = new URL(String((req as { url?: string }).url || ''), 'http://localhost')
            const sidParam = url.searchParams.get('sessionId') || ''
            const scope = url.searchParams.get('scope') || ''
            let scopeSids: Set<string> | null
            if (scope === 'all') {
              scopeSids = null // 診斷白名單:全部
            } else if (sidParam === '') {
              scopeSids = new Set<string>() // 無 sessionId 且非 all → 嚴格為空
            } else {
              scopeSids = new Set([sidParam])
              // 僅 scope=project 時做 cwd 聚合(同項目全部 session)
              if (scope === 'project' && sessionQuery !== undefined) {
                try {
                  const sessions = await sessionQuery.listSessions()
                  const me = sessions.find((s) => s.header && s.header.id === sidParam)
                  const cwd = me && me.header && typeof me.header.cwd === 'string' ? me.header.cwd : ''
                  if (cwd !== '') {
                    for (const s of sessions) {
                      if (s.header && s.header.cwd === cwd && typeof s.header.id === 'string') scopeSids.add(s.header.id)
                    }
                  }
                } catch {
                  // 解析失敗退回本 session 範圍
                }
              }
            }
            const t = await ensureTable()
            if (!t) {
              sendJsonTo(res, 200, { items: [] })
              return
            }
            const entriesFn = (t as unknown as { entries?: () => Iterable<[string, unknown]> }).entries
            if (typeof entriesFn !== 'function') {
              sendJsonTo(res, 200, { items: [] })
              return
            }
            interface MemRow { key: string; content: string; tags: string[]; createdAt: number }
            const items: MemRow[] = []
            for (const [key, row] of entriesFn.call(t)) {
              if (scopeSids !== null) {
                let inScope = false
                const rr = row as { sid?: unknown }
                for (const s of scopeSids) {
                  if (
                    key.startsWith(`${s}:`) ||
                    key.startsWith(`memagent:${s}:`) ||
                    (rr && typeof rr.sid === 'string' && rr.sid === s)
                  ) { inScope = true; break }
                }
                if (!inScope) continue
              }
              const r = row as { content?: unknown; tags?: unknown; createdAt?: unknown }
              if (r && typeof r === 'object' && typeof r.content === 'string') {
                items.push({
                  key,
                  content: r.content,
                  tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((x): x is string => typeof x === 'string') : [],
                  createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
                })
              }
            }
            items.sort((a, b) => b.createdAt - a.createdAt)
            sendJsonTo(res, 200, { items: items.slice(0, 120) })
          } catch (e) {
            sendJsonTo(res, 500, { error: String(e && (e as Error).message ? (e as Error).message : e) })
          }
        },
      })

      // 全項目觀測一覽
      webServer.register({
        kind: 'exact',
        path: '/api/observations',
        handler: async (_req: unknown, res: unknown) => {
          try {
            const t = await ensureObsTable()
            if (!t) {
              sendJsonTo(res, 200, { items: [] })
              return
            }
            const entriesFn = (t as unknown as { entries?: () => Iterable<[string, unknown]> }).entries
            if (typeof entriesFn !== 'function') {
              sendJsonTo(res, 200, { items: [] })
              return
            }
            const items: unknown[] = []
            for (const [sid, row] of entriesFn.call(t)) {
              const r = row as { narrative?: string; topic?: string; milestones?: unknown[]; turnCount?: number; updatedAt?: number }
              if (r && typeof r === 'object') {
                items.push({
                  sessionId: sid,
                  topic: typeof r.topic === 'string' ? r.topic : '',
                  narrative: typeof r.narrative === 'string' ? r.narrative.slice(0, 200) : '',
                  milestoneCount: Array.isArray(r.milestones) ? r.milestones.length : 0,
                  turnCount: typeof r.turnCount === 'number' ? r.turnCount : 0,
                  updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
                })
              }
            }
            items.sort((a, b) => ((b as { updatedAt: number }).updatedAt - (a as { updatedAt: number }).updatedAt))
            sendJsonTo(res, 200, { items })
          } catch (e) {
            sendJsonTo(res, 500, { error: String(e && (e as Error).message ? (e as Error).message : e) })
          }
        },
      })

      // 筆記/待辦(每 session 一份)
      let notesTable: TableLike | undefined
      let notesOpenFailed = false
      async function ensureNotesTable(): Promise<TableLike | undefined> {
        if (notesTable) return notesTable
        if (notesOpenFailed) return undefined
        if (domain === undefined) return undefined
        try {
          const d = await domain.open({
            name: 'session_notes',
            version: 1,
            tables: { notes: domainTable(notesSchema) },
          })
          notesTable = d.table('notes')
          return notesTable
        } catch {
          notesOpenFailed = true
          return undefined
        }
      }
      interface NotesRow {
        sessionId: string
        notes: Array<{ seq: number; text: string; createdAt: number }>
        todos: Array<{ seq: number; content: string; done: boolean; createdAt: number; source: string }>
        updatedAt: number
      }
      async function readNotes(sid: string): Promise<NotesRow> {
        const empty: NotesRow = { sessionId: sid, notes: [], todos: [], updatedAt: 0 }
        try {
          const t = await ensureNotesTable()
          if (!t) return empty
          const getter = (t as unknown as { get?: (id: string) => Promise<unknown> }).get
          if (typeof getter !== 'function') return empty
          const stored = await getter.call(t, sid)
          if (stored && typeof stored === 'object') return stored as NotesRow
          return empty
        } catch {
          return empty
        }
      }
      async function writeNotes(row: NotesRow): Promise<void> {
        try {
          const t = await ensureNotesTable()
          if (!t) return
          await t.put(row.sessionId, { ...row, updatedAt: Date.now() })
        } catch {
          // 靜默
        }
      }

      webServer.register({
        kind: 'exact',
        path: '/api/notes',
        handler: async (req: unknown, res: unknown) => {
          try {
            const method = String((req as { method?: string }).method || 'GET')
            if (method === 'GET') {
              const url = new URL(String((req as { url?: string }).url || ''), 'http://localhost')
              const sid = url.searchParams.get('sessionId') || ''
              if (sid === '') {
                sendJsonTo(res, 400, { error: 'missing sessionId' })
                return
              }
              sendJsonTo(res, 200, await readNotes(sid))
              return
            }
            if (method === 'POST') {
              const raw = await readReqBody(req)
              let args: { sessionId?: unknown; action?: unknown; text?: unknown; content?: unknown; seq?: unknown; source?: unknown } = {}
              try {
                args = JSON.parse(raw || '{}') as typeof args
              } catch {
                sendJsonTo(res, 400, { error: 'invalid JSON' })
                return
              }
              const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
              if (sid === '') {
                sendJsonTo(res, 400, { error: 'missing sessionId' })
                return
              }
              const row = await readNotes(sid)
              const nextSeq = Math.max(0, ...row.notes.map((n) => n.seq), ...row.todos.map((t) => t.seq)) + 1
              const action = String(args.action || '')
              if (action === 'add-note' && typeof args.text === 'string' && args.text.trim() !== '') {
                row.notes = [...row.notes, { seq: nextSeq, text: args.text.trim().slice(0, 500), createdAt: Date.now() }].slice(-100)
              } else if (action === 'delete-note' && typeof args.seq === 'number') {
                row.notes = row.notes.filter((n) => n.seq !== args.seq)
              } else if (action === 'add-todo' && typeof args.content === 'string' && args.content.trim() !== '') {
                row.todos = [...row.todos, { seq: nextSeq, content: args.content.trim().slice(0, 200), done: false, createdAt: Date.now(), source: typeof args.source === 'string' ? args.source : 'user' }].slice(-50)
              } else if (action === 'toggle-todo' && typeof args.seq === 'number') {
                row.todos = row.todos.map((t) => (t.seq === args.seq ? { ...t, done: !t.done } : t))
              } else if (action === 'delete-todo' && typeof args.seq === 'number') {
                row.todos = row.todos.filter((t) => t.seq !== args.seq)
              } else {
                sendJsonTo(res, 400, { error: 'unknown action or missing payload' })
                return
              }
              await writeNotes(row)
              sendJsonTo(res, 200, row)
              return
            }
            sendJsonTo(res, 405, { error: 'method not allowed' })
          } catch (e) {
            sendJsonTo(res, 500, { error: String(e && (e as Error).message ? (e as Error).message : e) })
          }
        },
      })

      // 提示詞優化器(把草稿結構化:背景→目標→要求→期望輸出)
      webServer.register({
        kind: 'exact',
        path: '/api/prompt/optimize',
        handler: async (req: unknown, res: unknown) => {
          try {
            const method = String((req as { method?: string }).method || 'GET')
            if (method !== 'POST') {
              sendJsonTo(res, 405, { error: 'method not allowed' })
              return
            }
            const raw = await readReqBody(req)
            let args: { text?: unknown } = {}
            try {
              args = JSON.parse(raw || '{}') as typeof args
            } catch {
              sendJsonTo(res, 400, { error: 'invalid JSON' })
              return
            }
            const draft = typeof args.text === 'string' ? args.text.slice(0, 6000) : ''
            if (draft.trim() === '') {
              sendJsonTo(res, 400, { error: '草稿為空' })
              return
            }
            const OPT_SYSTEM = [
              '你是提示詞優化器。把用戶的草稿重寫成結構化提示詞,讓智能體更清晰理解。',
              '格式(用戶草稿已有明確結構時保持其結構,不要過度改寫):',
              '【背景】相關上下文與現狀',
              '【目標】要達成什麼',
              '【要求】具體約束、規範、範圍',
              '【期望輸出】想要的格式或成果形態',
              '規則:',
              '1. 忠於原意——只結構化與補全用戶已有的意思,不添加用戶沒提的內容。',
              '2. 用戶寫的是繁體中文就用繁體;原文語言保持一致。',
              '3. 簡短的草稿(如一句指令)只需最小結構化,不要膨脹。',
              '4. 直接輸出優化後的提示詞全文,不要解釋、不要前後綴。',
            ].join('\n')
            let text = ''
            for await (const chunk of llmRef.stream({
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
              reasoningEffort: 'high',
              system: OPT_SYSTEM,
              messages: [{ id: 'opt-q-1', role: 'user', content: [{ type: 'text', text: draft }], source: { kind: 'user' } }],
              temperature: 0.2,
            })) {
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            }
            if (text.trim() === '') {
              sendJsonTo(res, 502, { error: '模型無輸出' })
              return
            }
            sendJsonTo(res, 200, { optimized: text.trim().slice(0, 8000) })
          } catch (e) {
            const msg = String(e && (e as Error).message ? (e as Error).message : e)
            if (/MISSING_CREDENTIAL|no API key|DEEPSEEK_API_KEY/i.test(msg)) {
              sendJsonTo(res, 200, { error: '缺少 DeepSeek API key' })
              return
            }
            sendJsonTo(res, 200, { error: msg })
          }
        },
      })

      // 潛力路徑生成器(洞察頁創意功能):基於觀測敘事/里程碑生成 2–3 條展開路徑,
      // 供用戶採納為待辦或傳到主對話框——洞察頁全面服務於價值/路徑/方向。
      webServer.register({
        kind: 'exact',
        path: '/api/insight/paths',
        handler: async (req: unknown, res: unknown) => {
          try {
            const method = String((req as { method?: string }).method || 'GET')
            if (method !== 'POST') {
              sendJsonTo(res, 405, { error: 'method not allowed' })
              return
            }
            const raw = await readReqBody(req)
            let args: { sessionId?: unknown } = {}
            try {
              args = JSON.parse(raw || '{}') as typeof args
            } catch {
              sendJsonTo(res, 400, { error: 'invalid JSON' })
              return
            }
            const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
            if (sid === '') {
              sendJsonTo(res, 400, { error: 'missing sessionId' })
              return
            }
            const stored = await readObs(sid) as { narrative?: string; topic?: string; milestones?: Array<{ kind: string; title: string; why: string }> } | undefined
            const obsText = stored && typeof stored === 'object'
              ? `敘事:${stored.narrative || '(無)'}\n主題:${stored.topic || '(無)'}\n里程碑:${(stored.milestones || []).map((m) => `- [${m.kind}] ${m.title} — ${m.why}`).join('\n') || '(無)'}`
              : '(尚無觀測資料)'
            const PATHS_SYSTEM = [
              '你是「路徑規劃師」——為研發項目發現有價值的潛力展開路徑。',
              '根據觀測資料,生成 2–3 條潛力路徑。只輸出 JSON 數組,不輸出其他任何文字:',
              '[{"name":"≤12字路徑名","value":"為什麼有價值(≤60字)","effort":"小|中|大","firstStep":"可立即執行的第一步(≤40字)"}]',
              '規則:基於已有成果與方向展開;不要重複已完成的內容;每條路徑要有差異化(例如:深化現有成果/產品化包裝/生態整合);繁體中文。',
            ].join('\n')
            let text = ''
            for await (const chunk of llmRef.stream({
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
              reasoningEffort: 'high',
              system: PATHS_SYSTEM,
              messages: [{ id: 'paths-q-1', role: 'user', content: [{ type: 'text', text: obsText }], source: { kind: 'user' } }],
              temperature: 0.5,
            })) {
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            }
            const arr = parseJsonArrayLoose(text) // 平衡擷取 + 控制符清洗(與觀測管線同源)
            if (arr === null) {
              sendJsonTo(res, 502, { error: '模型無輸出或格式異常' })
              return
            }
            try {
              const paths = arr
                .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
                .slice(0, 3)
                .map((p) => ({
                  name: typeof p.name === 'string' ? p.name.slice(0, 24) : '未命名路徑',
                  value: typeof p.value === 'string' ? p.value.slice(0, 120) : '',
                  effort: ['小', '中', '大'].includes(String(p.effort)) ? String(p.effort) : '中',
                  firstStep: typeof p.firstStep === 'string' ? p.firstStep.slice(0, 80) : '',
                }))
              if (paths.length === 0) {
                sendJsonTo(res, 502, { error: '模型未產生有效路徑' })
                return
              }
              await persistGenerated(sid, { paths }) // 持久化:切頁不丟,下次生成才覆寫
              sendJsonTo(res, 200, { paths })
            } catch {
              sendJsonTo(res, 502, { error: '路徑 JSON 解析失敗' })
            }
          } catch (e) {
            const msg = String(e && (e as Error).message ? (e as Error).message : e)
            if (/MISSING_CREDENTIAL|no API key|DEEPSEEK_API_KEY/i.test(msg)) {
              sendJsonTo(res, 200, { error: '缺少 DeepSeek API key——請到設定 → Models 頁新增 deepseek-official 的 key。' })
              return
            }
            sendJsonTo(res, 200, { error: msg })
          }
        },
      })

      // 價值總結卡(本 session 價值總結,LLM 生成)
      webServer.register({
        kind: 'exact',
        path: '/api/insight/summary',
        handler: async (req: unknown, res: unknown) => {
          try {
            const method = String((req as { method?: string }).method || 'GET')
            if (method !== 'POST') {
              sendJsonTo(res, 405, { error: 'method not allowed' })
              return
            }
            const raw = await readReqBody(req)
            let args: { sessionId?: unknown } = {}
            try {
              args = JSON.parse(raw || '{}') as typeof args
            } catch {
              sendJsonTo(res, 400, { error: 'invalid JSON' })
              return
            }
            const sid = typeof args.sessionId === 'string' ? args.sessionId : ''
            if (sid === '') {
              sendJsonTo(res, 400, { error: 'missing sessionId' })
              return
            }
            const stored = await readObs(sid) as { narrative?: string; topic?: string; milestones?: Array<{ kind: string; title: string; why: string }> } | undefined
            const obsText = stored && typeof stored === 'object'
              ? `敘事:${stored.narrative || '(無)'}\n主題:${stored.topic || '(無)'}\n里程碑:${(stored.milestones || []).map((m) => `- [${m.kind}] ${m.title}`).join('\n') || '(無)'}`
              : '(尚無觀測資料)'
            const SUMMARY_SYSTEM = [
              '你是價值總結員。根據觀測資料,為本 session 生成一份「價值總結」,可直接貼進週報或匯報。',
              '格式:',
              '1. 總結段:本 session 的背景、目標與達成(2–4 句)',
              '2. 成果清單:條列,每條含關鍵細節與交付物名稱(1–2 句),數量依實際成果',
              '3. 價值與方向:這些成果的價值在哪、方向是否在收斂、有什麼潛力路徑(一段)',
              '4. 下一步建議:1–2 條,可執行',
              '規則:只根據資料;繁體中文;不臆測;內容可充分展開,總長 600 字內。',
            ].join('\n')
            let summary = ''
            for await (const chunk of llmRef.stream({
              provider: 'deepseek-official',
              model: 'deepseek-v4-flash',
              reasoningEffort: 'high',
              system: SUMMARY_SYSTEM,
              messages: [{ id: 'sum-q-1', role: 'user', content: [{ type: 'text', text: obsText }], source: { kind: 'user' } }],
              temperature: 0.3,
            })) {
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text
            }
            if (summary === '') {
              sendJsonTo(res, 502, { error: '模型無輸出' })
              return
            }
            await persistGenerated(sid, { summary }) // 持久化:切頁不丟,下次生成才覆寫
            sendJsonTo(res, 200, { summary })
          } catch (e) {
            const msg = String(e && (e as Error).message ? (e as Error).message : e)
            if (/MISSING_CREDENTIAL|no API key|DEEPSEEK_API_KEY/i.test(msg)) {
              sendJsonTo(res, 200, { error: '缺少 DeepSeek API key——請到設定 → Models 頁新增 deepseek-official 的 key。' })
              return
            }
            sendJsonTo(res, 200, { error: msg })
          }
        },
      })
    }
  }
}
