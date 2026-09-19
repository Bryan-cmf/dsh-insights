#!/usr/bin/env node
/**
 * smoke-host.mjs — dsh-insights host 結構冒煙測試(無需 DSH 宿主)。
 *
 * 以 mock ctx 調用合併後的 apply(),斷言:
 * 1. 註冊面完整:6 投影 / 8 路由 / 6 工具 / 1 服務 / 5 事件監聽 / 1 定時器
 * 2. 儲存域單例(回歸防護):驅動一組 session 事件觸發洞察存檔 + 調用
 *    mem_health,vector_memory 與 observation 兩域各自只被 open 一次
 *    (同 ctx 重複 open 同名域在真實環境會拋 DomainError,詳見 src/host/domains.ts)
 * 3. 減法行為回歸(2026-09-19):
 *    - A2:觀察門檻——第 1 個 turn/end 不觸發觀測 LLM,第 2 個才觸發
 *    - B7:記憶欄位合併進觀測呼叫——每個被觀測的回合至多 1 次 LLM(無額外記憶呼叫)
 *    - A1:autoInsight 預設關閉——多輪後仍無自動洞察呼叫
 *    - A3:工具失敗不再寫入記憶表
 *
 * 用法:node scripts/smoke-host.mjs(先 pnpm build)
 */
const reg = {
  tools: [], routes: [], projections: [], projectionDefs: [], provides: [], injects: [],
  listeners: {}, opens: [], timers: 0, llmCalls: 0, llmWithMem: [],
}

const memPuts = []
const fakeTable = {
  put: async (key, row) => { memPuts.push({ key, row }) },
  get: async () => undefined,
  entries: () => memPuts.map((p) => [p.key, p.row])[Symbol.iterator](),
  size: 0,
}
const fakeDomain = { table: () => fakeTable, close: async () => {} }

const ctx = {
  tools: { register: (t) => reg.tools.push(t) },
  on: (name, fn) => { (reg.listeners[name] ??= []).push(fn) },
  inject: (services, cb) => { reg.injects.push(services); cb(ctx) },
  effect: () => {},
  provide: (name) => reg.provides.push(name),
  sessionProjections: { register: (d) => { reg.projections.push(d.key); reg.projectionDefs.push(d) } },
  storageDomain: { open: async (spec) => { reg.opens.push(spec.name); return fakeDomain } },
  llm: {
    stream: async function* (o) {
      reg.llmCalls += 1
      const withMem = String((o && o.system) || '').includes('附加欄位')
      reg.llmWithMem.push(withMem)
      const payload = withMem
        ? { section: '## 近期\n冒煙段落。', topic: 'smoke', milestones: [], memories: [{ text: '冒煙記憶條目', kind: '技術' }] }
        : { section: '## 近期\n冒煙段落。', topic: 'smoke', milestones: [] }
      yield { type: 'text-delta', text: JSON.stringify(payload) }
    },
  },
  webServer: { register: (r) => reg.routes.push(r.path) },
  sessionQuery: { readSession: async () => ({ events: [] }), listSessions: async () => [] },
  timer: { interval: () => { reg.timers += 1 } },
  skills: { list: async () => [] },
}

const m = await import('../lib/index.js')
const config = { maxRecords: 5000, healthIntervalMs: 60000, errorAlertThreshold: 5, ttlDays: 90, maxResults: 10 }
m.apply(ctx, config)

// ── 1. 註冊面斷言 ──
const expectRoutes = ['/api/observation', '/api/observation/rebuild', '/api/observations', '/api/notes', '/api/prompt/optimize', '/api/insight/summary', '/api/insight/paths', '/api/memories', '/api/memory/stats']
const expectProjections = ['infraView', 'memActivity', 'fileActivity', 'mechEvents', 'goalTrace', 'insightsScan']
const expectTools = ['usage_report', 'audit_skills', 'infra_health', 'mem_save', 'mem_search', 'mem_health']
const expectEvents = ['tools/result', 'agent/error', 'agent/status', 'session/event', 'session/event']

let fail = 0
function check(kind, got, want) {
  const pool = [...got]
  const miss = []
  for (const w of want) {
    const i = pool.indexOf(w)
    if (i === -1) miss.push(w)
    else pool.splice(i, 1)
  }
  if (miss.length > 0) {
    fail += 1
    console.error(`✗ ${kind}: 缺少 ${JSON.stringify(miss)}(實際: ${JSON.stringify(got)})`)
  } else {
    console.log(`✓ ${kind} (${got.length}): ${got.join(', ')}`)
  }
}
check('routes', reg.routes, expectRoutes)
check('projections', reg.projections, expectProjections)
// ── 投影契約回歸(2026-08-22:舊 `schema`/`view` 頂層欄位被現行 session-projection
// 忽略 → 單元註冊成 host-only,客戶端永遠收不到;必須是 stateSchema + wire.{viewSchema,view})──
{
  let contractFail = 0
  for (const d of reg.projectionDefs) {
    const ok = d && typeof d.key === 'string' && d.stateSchema !== undefined && typeof d.init === 'function' && typeof d.apply === 'function' &&
      d.wire !== undefined && d.wire.viewSchema !== undefined && typeof d.wire.view === 'function' &&
      Number.isSafeInteger(d.stateVersion) && d.schema === undefined && d.view === undefined
    if (!ok) {
      contractFail += 1
      console.error(`✗ projection 契約違反: ${d && d.key} 欄位=${JSON.stringify(Object.keys(d || {}))}`)
    }
  }
  if (contractFail > 0) { fail += contractFail }
  else { console.log(`✓ projection 契約(stateSchema + wire.viewSchema/view)全部 6 個過關`) }
}
check('provides', reg.provides, ['vectorMemory'])
check('tools', reg.tools.map((t) => t && t.name), expectTools)
check('event listeners', Object.entries(reg.listeners).flatMap(([n, fns]) => fns.map(() => n)), expectEvents)
if (reg.timers !== 1) { fail += 1; console.error(`✗ timers: 預期 1,實際 ${reg.timers}`) } else { console.log('✓ timers: 1 (watchdog)') }

// ── 2. 減法行為回歸(2026-09-19 A1/A2/A3/B7)──
{
  const sess2 = { id: 's-smoke-subtract' }
  const emit2 = (type, data) => { for (const fn of reg.listeners['session/event'] ?? []) fn(sess2, { type, data }) }
  // 觀測呼叫是 fire-and-forget(void observeTurn(...)),要讓微任務鏈跑完;
  // 混合 setImmediate 與真實 timer 輪次,避免計數落後一拍造成假失敗。
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 15))
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }
  const turn = async (n) => {
    emit2('tool/call', { callId: 'sm' + n, name: 'read', arguments: '{}', turn: n, step: 1 })
    emit2('tool/result', { message: { content: [{ toolCallId: 'sm' + n }] }, error: { code: 'ENOENT' } })
    emit2('turn/end', {})
    await settle()
  }

  await turn(1)
  if (reg.llmCalls !== 0) { fail += 1; console.error(`✗ A2:第 1 回合不該觸發任何 LLM(實際 ${reg.llmCalls} 次)`) }
  else { console.log('✓ A2 觀察門檻:第 1 個 turn/end 不觸發觀測/初始編年史(96% 單回合 session 不再白燒)') }

  await turn(2)
  if (reg.llmCalls !== 1) { fail += 1; console.error(`✗ A2:第 2 回合應恰好 1 次觀測呼叫(實際 ${reg.llmCalls})`) }
  else { console.log('✓ A2:第 2 個 turn/end 起開始觀測,且僅 1 次呼叫') }

  await turn(3)
  const calls3 = reg.llmCalls
  if (calls3 !== 2) { fail += 1; console.error(`✗ B7:第 3 回合應仍為 2 次總呼叫(實際 ${calls3})`) }

  await turn(4)
  const calls4 = reg.llmCalls
  // B7:第 4 輪(=第 3 次觀測)附帶記憶欄位,且仍只有 1 次呼叫/回合
  if (calls4 !== 3) { fail += 1; console.error(`✗ B7:每個被觀測回合應恰好 1 次呼叫(4 回合後實際 ${calls4})`) }
  else if (reg.llmWithMem.filter(Boolean).length !== 1) { fail += 1; console.error(`✗ B7:應恰好 1 次呼叫附帶記憶欄位(實際 ${reg.llmWithMem.filter(Boolean).length})`) }
  else if (!reg.llmWithMem[2]) { fail += 1; console.error('✗ B7:記憶欄位應出現在第 3 次觀測呼叫上') }
  else { console.log('✓ B7 記憶合併:每回合 1 次呼叫;第 3 次觀測附帶記憶欄位(零額外 LLM)') }

  // B7 落地:記憶真的寫進記憶表(且經 memagent: 前綴,可被檢索)
  const agentRows = memPuts.filter((p) => String(p.key).startsWith('memagent:') && String(p.row && p.row.content).includes('冒煙記憶條目'))
  if (agentRows.length !== 1) { fail += 1; console.error(`✗ B7:合併呼叫的記憶未落地(找到 ${agentRows.length} 行)`) }
  else { console.log(`✓ B7 落地:記憶寫入 shape=${JSON.stringify(Object.keys(agentRows[0].row))}`) }

  // A1:預設不產生自動洞察(每 5 輪一次的呼叫不該出現)
  if (calls4 > 3) { fail += 1; console.error(`✗ A1:出現額外呼叫(自動洞察應預設關閉),共 ${calls4}`) }
  else { console.log('✓ A1 自動洞察預設關閉:4 個回合後僅 3 次觀測呼叫') }

  // A3:工具失敗不進記憶(本 session 有多次 fail 洞察,記憶表不該出現 fail/踩坑 row)
  const failRows = memPuts.filter((p) => String(p.key).includes('fail') || String(p.row && p.row.content).includes('工具「'))
  if (failRows.length > 0) { fail += 1; console.error(`✗ A3:工具失敗仍寫入記憶(${failRows.length} 行)`) }
  else { console.log('✓ A3:工具失敗不再沉澱成記憶(掃描洞察仍保留)') }

  // A5:觀測 row 不再帶 suggestedTodos,且帶 turnsSeen(A2 門檻可跨重啟延續)
  const obsRow = memPuts.filter((p) => p.row && typeof p.row.narrative === 'string' && typeof p.row.sessionId === 'string').pop()
  if (obsRow === undefined) { fail += 1; console.error('✗ A5:觀測 row 未寫入(無法驗證 shape)') }
  else if ('suggestedTodos' in obsRow.row) { fail += 1; console.error('✗ A5:觀測 row 仍帶 suggestedTodos') }
  else if (typeof obsRow.row.turnsSeen !== 'number') { fail += 1; console.error('✗ A2:觀測 row 缺 turnsSeen(門檻無法跨重啟)') }
  else { console.log(`✓ A5 觀測 row:${JSON.stringify(Object.keys(obsRow.row))} (無 suggestedTodos、含 turnsSeen)`) }
}

// ── 2. 儲存域單例斷言(驅動真實碼路徑)──
const sess = { id: 's1' }
const emit = (type, data) => { for (const fn of reg.listeners['session/event'] ?? []) fn(sess, { type, data }) }
// 一筆工具失敗 → 產生重要性 2 洞察;turn/end 觸發 saver 寫入(開 vector_memory 域)
emit('tool/call', { callId: 'c1', name: 'read', arguments: '{}' })
emit('tool/result', { message: { content: [{ toolCallId: 'c1' }] }, error: { code: 'ENOENT' } })
emit('turn/end', {})
// mem_health 工具(memory 模組也開 vector_memory 域)
const health = reg.tools.find((t) => t && t.name === 'mem_health')
if (health === undefined) { fail += 1; console.error('✗ mem_health 工具未註冊') }
else await health.execute({})
// 觀測智能體 init 會開 observation 域;等異步回放/寫入全部落地
for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))

const openCount = {}
for (const n of reg.opens) openCount[n] = (openCount[n] ?? 0) + 1
for (const domainName of ['vector_memory', 'observation']) {
  const c = openCount[domainName] ?? 0
  if (c > 1) { fail += 1; console.error(`✗ 域 "${domainName}" 被 open ${c} 次(真實環境會拋 DomainError)`) }
  else console.log(`✓ 域 "${domainName}" open ${c} 次(單例)`)
}

console.log(`name=${m.name} inject=[${m.inject.join(',')}] opens=${JSON.stringify(openCount)}`)
if (fail > 0) { console.error(`SMOKE FAILED (${fail})`); process.exit(1) }
console.log('SMOKE OK — 註冊面完整 + 儲存域單例')
