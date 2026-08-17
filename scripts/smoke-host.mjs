#!/usr/bin/env node
/**
 * smoke-host.mjs — dsh-insights host 結構冒煙測試(無需 DSH 宿主)。
 *
 * 以 mock ctx 調用合併後的 apply(),斷言:
 * 1. 註冊面完整:6 投影 / 7 路由 / 6 工具 / 1 服務 / 5 事件監聽 / 1 定時器
 * 2. 儲存域單例(回歸防護):驅動一組 session 事件觸發洞察存檔 + 調用
 *    mem_health,vector_memory 與 observation 兩域各自只被 open 一次
 *    (同 ctx 重複 open 同名域在真實環境會拋 DomainError,詳見 src/host/domains.ts)
 *
 * 用法:node scripts/smoke-host.mjs(先 pnpm build)
 */
const reg = {
  tools: [], routes: [], projections: [], provides: [], injects: [],
  listeners: {}, opens: [], timers: 0,
}

const fakeTable = { put: async () => {}, get: async () => undefined, entries: () => [][Symbol.iterator](), size: 0 }
const fakeDomain = { table: () => fakeTable, close: async () => {} }

const ctx = {
  tools: { register: (t) => reg.tools.push(t) },
  on: (name, fn) => { (reg.listeners[name] ??= []).push(fn) },
  inject: (services, cb) => { reg.injects.push(services); cb(ctx) },
  effect: () => {},
  provide: (name) => reg.provides.push(name),
  sessionProjections: { register: (d) => reg.projections.push(d.key) },
  storageDomain: { open: async (spec) => { reg.opens.push(spec.name); return fakeDomain } },
  llm: { stream: async function* () { /* no chunks */ } },
  webServer: { register: (r) => reg.routes.push(r.path) },
  sessionQuery: { readSession: async () => ({ events: [] }), listSessions: async () => [] },
  timer: { interval: () => { reg.timers += 1 } },
  skills: { list: async () => [] },
}

const m = await import('../lib/index.js')
const config = { maxRecords: 5000, healthIntervalMs: 60000, errorAlertThreshold: 5, ttlDays: 90, maxResults: 10 }
m.apply(ctx, config)

// ── 1. 註冊面斷言 ──
const expectRoutes = ['/api/observation', '/api/observation/rebuild', '/api/observations', '/api/notes', '/api/prompt/optimize', '/api/insight/summary', '/api/insight/paths', '/api/insight/chat', '/api/memories']
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
check('provides', reg.provides, ['vectorMemory'])
check('tools', reg.tools.map((t) => t && t.name), expectTools)
check('event listeners', Object.entries(reg.listeners).flatMap(([n, fns]) => fns.map(() => n)), expectEvents)
if (reg.timers !== 1) { fail += 1; console.error(`✗ timers: 預期 1,實際 ${reg.timers}`) } else { console.log('✓ timers: 1 (watchdog)') }

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
