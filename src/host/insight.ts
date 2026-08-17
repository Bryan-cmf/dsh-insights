/**
 * dsh-insights · insight 模組(原 @bryan-cmf/dsh-insight-agent host)。
 *
 * 洞察智能體:以技術服務價值的研發方向顧問。
 * 靜態套件沒有動態 plugin 的 host.call 通道,改為在 webServer 上註冊
 * POST /api/insight/chat 路由;client 以 fetch 調用。
 *
 * 模型:deepseek-official / deepseek-v4-flash,reasoningEffort: 'max'。
 * 收集 reasoning-delta(深思過程)與 text-delta(答案)一併回傳。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openObservationDomain } from './domains.ts'

const SYSTEM = [
  '你是「洞察」——以技術服務價值的研發方向顧問,只讀當前 session 的觀測資料。',
  '',
  '你的核心任務:評估當前的技術研發方向,並預判沿此方向能達到什麼成果。',
  '',
  '回答結構(依需要選用,不必全列):',
  '1. 方向判讀:從觀測資料歸納目前的技術路線在做什麼',
  '2. 成果預判:沿此路線,最可能達成什麼成果、達不到什麼',
  '3. 價值對齊:該成果與價值目標的落差在哪',
  '4. 潛力路徑:基於已有成果,項目還有哪些有價值的展開方向或選項(至多兩條)',
  '5. 下一步:最該做的一件事',
  '',
  '輸出格式(重要):',
  '- 當回答中包含給用戶的建議提示詞、建議做法或目標陳述時,必須以下列格式收尾:',
  '  【建議】',
  '  (一段可直接貼到主對話框執行的提示詞,或一條可執行的目標陳述;簡短、可執行)',
  '- 若回答純分析、無具體建議,則不需要【建議】段落。',
  '',
  '規則:',
  '1. 只根據下方「觀測資料」回答;資料不足就明說,並指出還缺什麼。',
  '2. 工具失敗只是訊號——只有當它實質阻礙方向時才提;不要把回答變成除錯清單。框架攔截(沙箱/審批/政策)與重啟/網絡瞬態是規則內保護,一律不提;踩坑教訓已由記憶承載,不重複囉嗦。',
  '3. 方向不明或目標缺失時,主動反問用戶(一次最多兩問),刺激思考,例如:',
  '   - 「這個方向最終想達成什麼成果?」',
  '   - 「這些成果裡,哪一個最有價值?」',
  '   - 「技術路線和目標之間最大的落差是什麼?」',
  '4. 協助用戶收斂出可執行的目標陳述,並建議用 /goal 錨定。',
  '5. 使用繁體中文,條列優先;篇幅跟隨問題——簡單問題簡潔答,方向/潛力類問題可充分展開(數百字亦可),不必壓縮字數,像自然對話一樣。',
  '',
  '目標診斷模式(重要):',
  '- 當價值目標未建立、或用戶迷惘時,進入診斷模式:一次只問一個關鍵問題(最多三輪),逐步收斂——',
  '  第 1 問:想達成什麼成果?第 2 問:哪個成果最有價值?第 3 問:如何衡量完成?',
  '- 收斂出目標陳述後,【建議】必須輸出 `/goal <目標陳述>` 讓用戶一鍵錨定(直接貼到主對話框執行)。',
  '',
  '【觀測資料】',
].join('\n')

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
interface WebServerLike {
  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}
interface DomainLike {
  table(name: string): { get?: (id: string) => Promise<unknown> }
  close(): Promise<void> | void
}
interface StorageDomainLike {
  open(spec: unknown): Promise<DomainLike>
}
export interface InsightCtx {
  webServer: WebServerLike
  llm: LlmLike
  storageDomain?: StorageDomainLike
}

// 觀測智能體產物(滾動敘事/主題/里程碑)——從 observation 域讀取,併入洞察 context。
interface StoredObservation {
  narrative?: string
  topic?: string
  milestones?: Array<{ kind: string; title: string; why: string }>
}

function obsContextBlock(obs: StoredObservation): string {
  const lines: string[] = []
  if (typeof obs.narrative === 'string' && obs.narrative !== '') lines.push(`敘事:${obs.narrative}`)
  if (typeof obs.topic === 'string' && obs.topic !== '') lines.push(`主題:${obs.topic}`)
  if (Array.isArray(obs.milestones) && obs.milestones.length > 0) {
    lines.push('里程碑:')
    for (const m of obs.milestones.slice(-8)) {
      lines.push(`- [${m.kind}] ${m.title}${m.why ? ` — ${m.why}` : ''}`)
    }
  }
  if (lines.length === 0) return ''
  return '\n\n【觀測智能體的滾動觀測(AI 生成)】\n' + lines.join('\n')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function applyInsightChat(ctx: InsightCtx): void {
  // ── 併發閘(P1-15):LLM 串流在 HTTP handler 內完成,多人/多標籤同時提問會
  // 排隊佔滿連接。簡單信號量:最多 MAX_CONCURRENT 個併發,其餘排 FIFO 佇列
  // (上限 MAX_QUEUE),等候超過 QUEUE_WAIT_MS 或佇列滿 → 429 請稍後再試。
  const MAX_CONCURRENT = 2
  const MAX_QUEUE = 6
  const QUEUE_WAIT_MS = 60000
  let active = 0
  const queue: Array<() => void> = []

  function leave(): void {
    active -= 1
    const next = queue.shift()
    if (next !== undefined) next()
  }

  function acquire(): Promise<boolean> {
    if (active < MAX_CONCURRENT) {
      active += 1
      return Promise.resolve(true)
    }
    if (queue.length >= MAX_QUEUE) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const onTurn = (): void => {
        if (settled) {
          // 已逾時卻被輪到:名額直接讓給下一位,不泄漏 active 計數
          const nxt = queue.shift()
          if (nxt !== undefined) nxt()
          return
        }
        settled = true
        clearTimeout(timer)
        active += 1
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const i = queue.indexOf(onTurn)
        if (i >= 0) queue.splice(i, 1)
        resolve(false)
      }, QUEUE_WAIT_MS)
      queue.push(onTurn)
    })
  }

  let obsTable: { get?: (id: string) => Promise<unknown> } | undefined
  let obsOpenFailed = false
  async function readObservation(sessionId: string): Promise<StoredObservation | undefined> {
    if (ctx.storageDomain === undefined) return undefined
    if (obsOpenFailed) return undefined
    try {
      if (obsTable === undefined) {
        // 插件級單例:與 perspectives 模組共用同一 observation 域(重複 open 會拋 DomainError)
        const d = await openObservationDomain(ctx.storageDomain)
        obsTable = d.table('sessions') as { get?: (id: string) => Promise<unknown> }
      }
      const getter = obsTable.get
      if (typeof getter !== 'function') return undefined
      const stored = await getter.call(obsTable, sessionId)
      if (stored && typeof stored === 'object') return stored as StoredObservation
      return undefined
    } catch {
      obsOpenFailed = true
      return undefined
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/insight/chat',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let args: { context?: unknown; question?: unknown; sessionId?: unknown; history?: unknown } = {}
        try {
          args = JSON.parse(raw || '{}') as typeof args
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const question = typeof args.question === 'string' ? args.question.slice(0, 800) : ''
        if (question === '') {
          sendJson(res, 400, { error: '問題為空' })
          return
        }
        const context = typeof args.context === 'string' ? args.context.slice(0, 3000) : ''
        // 近期對話歷史:讓洞察智能體看得見前文,對話才自然(原來只收單題)
        let historyBlock = ''
        if (Array.isArray(args.history)) {
          const lines: string[] = []
          for (const h of args.history.slice(-10)) {
            if (h && typeof h === 'object') {
              const o = h as Record<string, unknown>
              const role = o.role === 'assistant' ? '洞察' : '用戶'
              const t = typeof o.text === 'string' ? o.text.slice(0, 800) : ''
              if (t !== '') lines.push(`${role}:${t}`)
            }
          }
          if (lines.length > 0) historyBlock = '\n\n【近期對話】\n' + lines.join('\n')
        }
        let obsBlock = ''
        if (typeof args.sessionId === 'string' && args.sessionId !== '') {
          const obs = await readObservation(args.sessionId)
          if (obs !== undefined) obsBlock = obsContextBlock(obs)
        }
        const granted = await acquire()
        if (!granted) {
          sendJson(res, 429, { error: '洞察服務繁忙(併發上限),請稍後再試。' })
          return
        }
        let text = ''
        let thinking = ''
        let finished = false
        try {
          for await (const chunk of ctx.llm.stream({
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            reasoningEffort: 'max',
            system: SYSTEM + context + obsBlock + historyBlock,
            messages: [{ id: 'ins-q-1', role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } }],
            temperature: 0.4,
          })) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') thinking += chunk.text
            if (chunk.type === 'finish') finished = true
          }
        } finally {
          leave()
        }
        if (!finished && text === '') {
          sendJson(res, 502, { error: '模型串流中斷且無輸出' })
          return
        }
        sendJson(res, 200, { answer: text, thinking: thinking.slice(0, 8000) })
      } catch (e) {
        const msg = String(e && (e as Error).message ? (e as Error).message : e)
        if (/MISSING_CREDENTIAL|no API key|DEEPSEEK_API_KEY/i.test(msg)) {
          sendJson(res, 200, { error: '缺少 DeepSeek API key——請到設定 → Models 頁新增 deepseek-official 的 key(或於啟動環境 export DEEPSEEK_API_KEY),再重試。' })
          return
        }
        sendJson(res, 200, { error: msg })
      }
    },
  })
}
