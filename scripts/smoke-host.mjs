#!/usr/bin/env node
/**
 * smoke-host.mjs — dsh-insights host 結構冒煙測試(無需 DSH 宿主)。
 *
 * 以 mock ctx 調用合併後的 apply(),斷言四模組的註冊面完整:
 * 6 投影 / 7 路由 / 6 工具 / 1 服務 / 5 事件監聽 / 1 定時器。
 *
 * 用法:node scripts/smoke-host.mjs(先 pnpm build)
 */
const reg = { tools: [], routes: [], projections: [], events: [], provides: [], injects: [], timers: 0 }

const fakeTable = { put: async () => {}, get: async () => undefined, entries: () => [][Symbol.iterator](), size: 0 }
const fakeDomain = { table: () => fakeTable, close: async () => {} }

const ctx = {
  tools: { register: (t) => reg.tools.push(t && t.name) },
  on: (name) => reg.events.push(name),
  inject: (services, cb) => { reg.injects.push(services); cb(ctx) },
  effect: () => {},
  provide: (name) => reg.provides.push(name),
  sessionProjections: { register: (d) => reg.projections.push(d.key) },
  storageDomain: { open: async () => fakeDomain },
  llm: { stream: async function* () { /* no chunks */ } },
  webServer: { register: (r) => reg.routes.push(r.path) },
  sessionQuery: { readSession: async () => ({ events: [] }), listSessions: async () => [] },
  timer: { interval: () => { reg.timers += 1 } },
  skills: { list: async () => [] },
}

const m = await import('../lib/index.js')
const config = { maxRecords: 5000, healthIntervalMs: 60000, errorAlertThreshold: 5, ttlDays: 90, maxResults: 10 }
m.apply(ctx, config)

const expect = {
  projections: ['infraView', 'memActivity', 'fileActivity', 'mechEvents', 'goalTrace', 'insightsScan'],
  routes: ['/api/observation', '/api/observation/rebuild', '/api/observations', '/api/notes', '/api/prompt/optimize', '/api/insight/summary', '/api/insight/chat'],
  tools: ['usage_report', 'audit_skills', 'infra_health', 'mem_save', 'mem_search', 'mem_health'],
  provides: ['vectorMemory'],
  events: ['tools/result', 'agent/error', 'agent/status', 'session/event', 'session/event'],
}

let fail = 0
for (const [kind, want] of Object.entries(expect)) {
  const got = reg[kind]
  // 逐項消去匹配(支援同名重複,如 session/event ×2)
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
if (reg.timers !== 1) { fail += 1; console.error(`✗ timers: 預期 1,實際 ${reg.timers}`) } else { console.log('✓ timers: 1 (watchdog)') }
console.log(`name=${m.name} inject=[${m.inject.join(',')}]`)
if (fail > 0) { console.error(`SMOKE FAILED (${fail})`); process.exit(1) }
console.log('SMOKE OK — 合併 apply 註冊面完整')
