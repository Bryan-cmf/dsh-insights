/**
 * dsh-insights · memory v2 測試(SPEC dsh-embed-spec.md §6/§10 降級層)。
 *
 * 覆蓋:
 * 1. flag off(默認)mem_save/mem_search/mem_health 輸出與 v1 逐字節一致;
 * 2. embedder 缺失/拋錯時靜默降級 keyword,輸出與 flag-off 逐字節一致;
 * 3. RRF 融合單元:kw-only / sem-only / 兩者並存;
 * 4. mem_save 同步路徑延遲 <10ms(embedder 永不返回也不阻塞);
 * 5. 指紋過期向量行觸發單條異步重嵌;
 * 6. 嵌入隊列:批量 16、重試 5s/30s/120s 後放棄並記 health 事件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMemory,
  normalizeEmbeddingConfig,
  rrfFuse,
  cosineSimilarity,
  EmbeddingQueue,
  EMBED_RETRY_DELAYS_MS,
} from '../src/host/memory.ts'
import { resetDomainSingletonsForTest } from '../src/host/domains.ts'
import { makeFakeStorage, makeCtx, makeEmbedder, vectorFor, defaultSeed } from './helpers.mjs'

/** 微任務/立即回調沖刷(mock timers 下替代 setTimeout 輪詢)。 */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

const EMB_ON = { enabled: true, backend: 'qwen3-4b-fp16', dim: 4 }
const BASE_CONFIG = { ttlDays: 90, maxResults: 10 }

async function waitFor(cond, timeoutMs = 3000, label = 'condition') {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 搭一個場景:新存儲 + applyMemory;返回操作手柄。 */
async function setup({ config, embedder, storage } = {}) {
  resetDomainSingletonsForTest()
  const st = storage ?? makeFakeStorage()
  const services = embedder !== undefined ? { embedder } : {}
  const h = makeCtx({ storageDomain: st.storageDomain, services })
  applyMemory(h.ctx, config ?? BASE_CONFIG)
  return { ...h, st }
}

async function saveMem(h, content, tags = []) {
  const out = await h.tools.get('mem_save').execute({ content, tags })
  assert.match(out, /^saved memory /)
  return out
}

// ── 1. flag off:逐字節一致 ──────────────────────────────────────────────────

test('flag off(默認):mem_save/mem_search/mem_health 與 v1 逐字節一致,且不觸碰 embedder', async () => {
  const h = await setup()
  const s1 = await saveMem(h, 'rust borrow checker notes', ['rust'])
  const s2 = await saveMem(h, 'postgres vacuum tuning', ['db'])
  assert.match(s1, /^saved memory mem-[a-z0-9-]+ at \d{4}-\d{2}-\d{2}T.*\(ttl: 90d\)$/)
  assert.match(s2, /^saved memory mem-[a-z0-9-]+ at .*\(ttl: 90d\)$/)

  const searchOut = await h.tools.get('mem_search').execute({ query: 'rust' })
  // v1 公式:overlap/|tokens| + 0.3*recency;逐字節釘住格式(無 via 標記)。
  assert.match(searchOut, /^1\. \[mem-[a-z0-9-]+\] \(score \d+\.\d{2}, tags: rust\)\n   rust borrow checker notes$/)
  assert.ok(!searchOut.includes('via:'), 'flag off 不得出現 via 標記')

  const health = await h.tools.get('mem_health').execute({})
  assert.equal(health, [
    'records: 2',
    'expired (lazy): 0',
    'domain: vector_memory (storageDomain, version 1)',
    'ttl default: 90d',
    'status: ok',
  ].join('\n'))

  // flag off 時連 ctx.get('embedder') 都不應發生。
  assert.deepEqual(h.getCalls.filter((n) => n === 'embedder'), [])
  await h.dispose()
})

test('flag off:無匹配與錯誤路徑逐字節一致', async () => {
  const h = await setup()
  assert.equal(await h.tools.get('mem_search').execute({ query: 'zzz-nothing' }), 'no matching memories')
  assert.equal(await h.tools.get('mem_search').execute({ query: '' }), 'ERROR: query must be a non-empty string')
  assert.equal(await h.tools.get('mem_save').execute({ content: '  ' }), 'ERROR: content must be a non-empty string')
  await h.dispose()
})

// ── 2. embedder 缺失/拋錯:靜默降級,輸出與 flag-off 逐字節一致 ──────────────

test('embedder 缺失(flag on):mem_search 輸出與 flag-off 逐字節一致,工具層無錯', async () => {
  // 先用 flag off 產出基線,再克隆介質到 flag-on 場景(同 createdAt,分數確定)。
  const a = await setup()
  await saveMem(a, 'rust borrow checker notes', ['rust'])
  await saveMem(a, 'rust async runtime comparison', ['rust', 'async'])
  const baseline = await a.tools.get('mem_search').execute({ query: 'rust' })
  await a.dispose()

  const stB = makeFakeStorage()
  stB.medium.set('vector_memory', structuredClone(a.st.medium.get('vector_memory')))
  const b = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, storage: stB }) // 無 embedder 服務
  const degraded = await b.tools.get('mem_search').execute({ query: 'rust' })
  assert.equal(degraded, baseline, 'embedder 缺失時輸出須與 flag-off 逐字節一致')
  const health = await b.tools.get('mem_health').execute({})
  assert.match(health, /embedding: enabled \(fingerprint qwen3-4b-fp16@4, embedder: missing\)/)
  await b.dispose()
})

test('embedder 拋 EmbedderUnavailableError:靜默降級 keyword,輸出與 flag-off 逐字節一致', async () => {
  const a = await setup()
  await saveMem(a, 'postgres vacuum tuning', ['db'])
  const baseline = await a.tools.get('mem_search').execute({ query: 'vacuum' })
  await a.dispose()

  const stB = makeFakeStorage()
  stB.medium.set('vector_memory', structuredClone(a.st.medium.get('vector_memory')))
  // 預置當前指紋的向量行:backfill 無事可做,避免降級場景觸發隊列真重試。
  const tablesB = stB.medium.get('vector_memory').tables
  tablesB.set('memory_vectors', new Map(
    [...tablesB.get('memories').keys()].map((id) => [id, { fp: 'qwen3-4b-fp16@4', dim: 4, vec: [1, 0, 0, 0], ts: Date.now() }]),
  ))
  const b = await setup({
    config: { ...BASE_CONFIG, embedding: EMB_ON },
    embedder: makeEmbedder({ mode: 'throw' }),
    storage: stB,
  })
  const degraded = await b.tools.get('mem_search').execute({ query: 'vacuum' })
  assert.equal(degraded, baseline, 'embedder 不可用時輸出須與 flag-off 逐字節一致')
  assert.ok(!degraded.startsWith('ERROR'), '工具層不得拋錯')
  await b.dispose()
})

// ── 3. RRF 融合單元:kw-only / sem-only / 兩者並存 ───────────────────────────

test('rrfFuse: kw-only(sem 列表為空)', () => {
  const fused = rrfFuse([{ name: 'kw', ids: ['a', 'b', 'c'] }, { name: 'sem', ids: [] }])
  assert.deepEqual(fused.map((x) => x.id), ['a', 'b', 'c'])
  assert.deepEqual(fused[0], { id: 'a', score: 1 / 61, via: ['kw'] })
  assert.deepEqual(fused[2].via, ['kw'])
})

test('rrfFuse: sem-only(kw 列表為空)', () => {
  const fused = rrfFuse([{ name: 'kw', ids: [] }, { name: 'sem', ids: ['x', 'y'] }])
  assert.deepEqual(fused.map((x) => x.id), ['x', 'y'])
  assert.deepEqual(fused[0], { id: 'x', score: 1 / 61, via: ['sem'] })
})

test('rrfFuse: 兩者並存(雙榜項加分,score=Σ 1/(60+rank))', () => {
  const fused = rrfFuse([
    { name: 'kw', ids: ['a', 'b', 'c'] },
    { name: 'sem', ids: ['c', 'a', 'd'] },
  ])
  const byId = new Map(fused.map((x) => [x.id, x]))
  assert.ok(Math.abs(byId.get('a').score - (1 / 61 + 1 / 62)) < 1e-12)
  assert.deepEqual(byId.get('a').via, ['kw', 'sem'])
  assert.ok(Math.abs(byId.get('c').score - (1 / 63 + 1 / 61)) < 1e-12)
  assert.deepEqual(byId.get('d'), { id: 'd', score: 1 / 63, via: ['sem'] })
  // 雙榜項排在單榜項之前
  assert.deepEqual(fused.map((x) => x.id).slice(0, 2), ['a', 'c'])
})

test('cosineSimilarity: 正交為 0,同向為 1,零向量守衛', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-12)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
  assert.throws(() => cosineSimilarity([1], [1, 2]), RangeError)
})

// ── 3b. 融合集成:sem-only 命中能浮出、kw+sem 命中帶雙來源標記 ───────────────

test('融合集成: 純語義命中(kw 零重疊)浮出並標 via: sem', async () => {
  // 記憶文本與查詢無 token 重疊;假 embedder 讓兩者向量同向。
  const embedder = makeEmbedder({ dim: 4, seed: vectorFor({ 'alpha beta gamma': [1, 0, 0, 0], zzzz: [1, 0, 0, 0] }, 4) })
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder })
  const saved = await saveMem(h, 'alpha beta gamma', ['greek'])
  const id = saved.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  const vt = h.st.medium.get('vector_memory').tables.get('memory_vectors')
  await waitFor(() => vt.has(id), 3000, '向量寫入')

  const out = await h.tools.get('mem_search').execute({ query: 'zzzz' })
  assert.ok(out.includes(`[${id}]`), `語義命中應浮出: ${out}`)
  assert.ok(out.includes('via: sem'), `應標記語義來源: ${out}`)
  await h.dispose()
})

test('融合集成: kw+sem 雙命中帶 via: kw+sem 且融合分數正確(sem-primary)', async () => {
  const embedder = makeEmbedder({ dim: 4, seed: vectorFor({ 'rust borrow': [1, 0, 0, 0], rust: [1, 0, 0, 0] }, 4) })
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder })
  const saved = await saveMem(h, 'rust borrow checker', ['rust'])
  const id = saved.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  const vt = h.st.medium.get('vector_memory').tables.get('memory_vectors')
  await waitFor(() => vt.has(id), 3000, '向量寫入')

  const out = await h.tools.get('mem_search').execute({ query: 'rust' })
  assert.ok(out.includes(`[${id}]`), out)
  assert.ok(out.includes('via: kw+sem'), `應標記雙來源: ${out}`)
  // fuseHybrid(sem 主列表):輸出位置 rank 1 → score = 1/61 ≈ 0.0164 → toFixed(2) = 0.02
  assert.ok(out.includes('score 0.02'), out)
  await h.dispose()
})

// ── 4. mem_save 同步路徑延遲 <10ms ──────────────────────────────────────────

test('mem_save: embedder 永不返回也不阻塞同步路徑(延遲增加 <10ms)', async () => {
  const hanging = makeEmbedder({ mode: 'hang' })
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder: hanging })
  const durations = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    await h.tools.get('mem_save').execute({ content: `latency probe ${i}`, tags: ['bench'] })
    durations.push(performance.now() - t0)
  }
  for (const d of durations) {
    assert.ok(d < 10, `mem_save 同步路徑耗時 ${d.toFixed(2)}ms ≥ 10ms`)
  }
  assert.ok(hanging.calls.length <= 1, '嵌入在後台批量進行,不與 save 同步')
  await h.dispose()
})

// ── 5. 指紋過期 → 單條異步重嵌 ──────────────────────────────────────────────

test('指紋不匹配的向量行:不參與語義檢索,觸發單條異步重嵌', async () => {
  // 先 flag off 存一條,再以新 spec 直接寫入過期指紋的向量行。
  const a = await setup()
  const saved = await saveMem(a, 'fingerprint drift probe', ['fp'])
  const id = saved.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  await a.dispose()

  resetDomainSingletonsForTest()
  const st = a.st
  const { openVectorMemoryDomain } = await import('../src/host/domains.ts')
  const domain = await openVectorMemoryDomain(st.storageDomain)
  await domain.table('memory_vectors').put(id, { fp: 'old-backend@512', dim: 512, vec: [0.1, 0.2], ts: Date.now() })
  await domain.close()

  const embedder = makeEmbedder({ dim: 4 })
  const b = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder, storage: st })
  const out = await b.tools.get('mem_search').execute({ query: 'fingerprint' })
  assert.ok(out.includes(id), 'kw 命中仍在(過期向量不影響 keyword)')

  // 異步重嵌:行被更新為當前指紋 qwen3-4b-fp16@4。
  const vt = st.medium.get('vector_memory').tables.get('memory_vectors')
  await waitFor(() => vt.get(id)?.fp === 'qwen3-4b-fp16@4', 3000, '單條重嵌完成')
  assert.equal(vt.get(id).dim, 4)
  assert.equal(vt.get(id).vec.length, 4)
  assert.ok(embedder.calls.some((c) => c.texts.some((t) => t.includes('fingerprint drift probe'))))
  await b.dispose()
})

test('dim 默認 512→2560(F-QA-2):舊默認指紋行觸發 backfill 重嵌為 @2560', async () => {
  // 模擬 t15 前的存量:向量行為舊默認指紋 qwen3-4b-fp16@512。
  const a = await setup()
  const saved = await saveMem(a, 'dim migration probe', ['mrl'])
  const id = saved.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  await a.dispose()

  resetDomainSingletonsForTest()
  const st = a.st
  const { openVectorMemoryDomain } = await import('../src/host/domains.ts')
  const domain = await openVectorMemoryDomain(st.storageDomain)
  await domain.table('memory_vectors').put(id, {
    fp: 'qwen3-4b-fp16@512', dim: 512, vec: new Array(512).fill(0.01), ts: Date.now(),
  })
  await domain.close()

  // 新默認(不顯式給 dim):正規化為 2560,指紋 qwen3-4b-fp16@2560。
  const embedder = makeEmbedder({ dim: 2560 })
  const b = await setup({
    config: { ...BASE_CONFIG, embedding: { enabled: true, backend: 'qwen3-4b-fp16' } },
    embedder,
    storage: st,
  })
  const out = await b.tools.get('mem_search').execute({ query: 'migration' })
  assert.ok(out.includes(id), 'kw 命中仍在')

  const vt = st.medium.get('vector_memory').tables.get('memory_vectors')
  await waitFor(() => vt.get(id)?.fp === 'qwen3-4b-fp16@2560', 3000, 'dim 變更重嵌完成')
  assert.equal(vt.get(id).dim, 2560)
  assert.equal(vt.get(id).vec.length, 2560)
  await b.dispose()
})

// ── 6. 異步嵌入隊列單元:批量 16、重試 5s/30s/120s、放棄記 health 事件 ────────

test('EmbeddingQueue: 批量 16 條/次', async () => {
  const batches = []
  const q = new EmbeddingQueue({
    embed: async (texts) => { batches.push(texts.length); return texts.map(() => [1, 0, 0, 0]) },
    putVector: async () => {},
  })
  for (let i = 0; i < 20; i++) q.enqueue(`id-${i}`, `text ${i}`)
  await q.drain()
  assert.deepEqual(batches, [16, 4])
  assert.equal(q.stats.embedded, 20)
  assert.equal(q.stats.dropped, 0)
})

test('EmbeddingQueue: 失敗按 5s/30s/120s 重試 3 次後放棄並記 health 事件', async () => {
  const sleeps = []
  const events = []
  let attempts = 0
  const q = new EmbeddingQueue({
    embed: async () => { attempts += 1; throw new Error('sidecar down (fingerprint: qwen3-4b-fp16@512)') },
    putVector: async () => {},
    sleep: async (ms) => { sleeps.push(ms) },
    onEvent: (kind, detail) => events.push({ kind, detail }),
  })
  q.enqueue('m-1', 'doomed')
  await q.drain()
  assert.equal(attempts, 4, '初次 + 3 次重試')
  assert.deepEqual(sleeps, [...EMBED_RETRY_DELAYS_MS], '重試間隔 5s/30s/120s')
  assert.deepEqual(sleeps, [5000, 30000, 120000])
  assert.equal(q.stats.dropped, 1)
  assert.ok(events.some((e) => e.kind === 'embed-dropped' && e.detail.id === 'm-1'), '須記 health 事件')
})

test('EmbeddingQueue: 第 2 次重試成功則不放棄;同 id 去重', async () => {
  const sleeps = []
  let failures = 2
  const written = new Map()
  const q = new EmbeddingQueue({
    embed: async (texts) => {
      if (failures > 0) { failures -= 1; throw new Error('flaky') }
      return texts.map(() => [1, 0])
    },
    putVector: async (id, vec) => { written.set(id, vec) },
    sleep: async (ms) => { sleeps.push(ms) },
  })
  q.enqueue('m-1', 'hello')
  q.enqueue('m-1', 'hello') // 去重
  await q.drain()
  assert.equal(q.stats.enqueued, 1)
  assert.equal(q.stats.embedded, 1)
  assert.equal(q.stats.dropped, 0)
  assert.deepEqual(sleeps, [5000, 30000])
  assert.deepEqual(written.get('m-1'), [1, 0])
})

// ── 7. config 正規化 ────────────────────────────────────────────────────────

test('normalizeEmbeddingConfig: 默認 off + dim 2560(F-QA-2),支持嵌套 memory.embedding 寫法', () => {
  assert.deepEqual(normalizeEmbeddingConfig(BASE_CONFIG), { enabled: false, backend: 'qwen3-4b-fp16', dim: 2560 })
  assert.deepEqual(
    normalizeEmbeddingConfig({ ...BASE_CONFIG, embedding: { enabled: true } }),
    { enabled: true, backend: 'qwen3-4b-fp16', dim: 2560 },
  )
  assert.deepEqual(
    normalizeEmbeddingConfig({ ...BASE_CONFIG, memory: { embedding: { enabled: true, backend: 'x', dim: 256 } } }),
    { enabled: true, backend: 'x', dim: 256 },
  )
  assert.deepEqual(
    normalizeEmbeddingConfig({ ...BASE_CONFIG, embedding: { enabled: 1, dim: -3 } }),
    { enabled: false, backend: 'qwen3-4b-fp16', dim: 2560 },
  )
})

// ── 7. drop 閉環:重試耗盡 → backfillDone 重置 → 下次 save/search 重嵌 ────────

test('閉環: 嵌入重試耗盡 drop 後,下次 search 觸發 backfill 重掃並重新投遞', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { failing: true }
  const embedder = {
    calls: [],
    async embedTexts(texts, opts) {
      this.calls.push([...texts])
      if (state.failing) {
        const err = new Error(`sidecar down (fingerprint: ${opts?.backend}@${opts?.dim})`)
        err.name = 'EmbedderUnavailableError'
        throw err
      }
      return texts.map((x) => defaultSeed(x, opts?.dim ?? 4))
    },
  }
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder })
  const saved = await saveMem(h, 'closed loop reembed probe', ['retry'])
  const id = saved.match(/^saved memory (mem-[a-z0-9-]+)/)[1]

  // 初次失敗 → 逐級重試 5s/30s/120s(mock timers 虛擬推進)→ 耗盡 drop
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  t.mock.timers.tick(30000)
  await flush()
  t.mock.timers.tick(120000)
  await flush()

  const health1 = await h.tools.get('mem_health').execute({})
  assert.match(health1, /embedding queue: enqueued \d+, embedded 0, dropped 1/)
  assert.match(health1, /embed-dropped/)
  const vt = () => h.st.medium.get('vector_memory').tables.get('memory_vectors')
  assert.ok(!vt()?.has(id), 'drop 後無向量行')

  // embedder 恢復;下一次 search 觸發 maybeBackfill 重掃 → 重新投遞 → 向量落盤
  state.failing = false
  await h.tools.get('mem_search').execute({ query: 'unrelated tokens' })
  await flush()
  assert.ok(vt()?.has(id), '閉環成立:drop 後重嵌成功')
  assert.equal(vt().get(id).fp, 'qwen3-4b-fp16@4')
  const embedsOfProbe = embedder.calls.filter((c) => c.some((x) => x.includes('closed loop reembed probe'))).length
  assert.ok(embedsOfProbe >= 2, `drop 後須再次嵌入(實際 ${embedsOfProbe} 次)`)
  await h.dispose()
  t.mock.timers.reset()
})

// ── 8. 隊列 dispose ─────────────────────────────────────────────────────────

test('EmbeddingQueue.dispose: 停止 pump、不再重試、後續 enqueue 忽略(注入 sleep 路徑)', async () => {
  let embedCalls = 0
  let releaseSleep
  const q = new EmbeddingQueue({
    embed: async () => { embedCalls += 1; throw new Error('down') },
    putVector: async () => {},
    sleep: () => new Promise((resolve) => { releaseSleep = resolve }), // 掛起重試等待
  })
  q.enqueue('m-1', 'x')
  await flush()
  assert.equal(embedCalls, 1, '首次失敗後進入重試等待')
  q.dispose()
  assert.equal(q.pendingCount, 0)
  releaseSleep?.() // 即使等待被解除也不再重投
  await flush()
  assert.equal(embedCalls, 1, 'dispose 後不再重試')
  q.enqueue('m-2', 'y')
  await flush()
  assert.equal(embedCalls, 1, 'dispose 後 enqueue 被忽略')
  assert.equal(q.stats.enqueued, 1)
  await q.drain() // drain 對 disposed 隊列立即返回,不掛起
})

test('EmbeddingQueue.dispose: 默認 timer 路徑——清除未決重試 setTimeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let embedCalls = 0
  const q = new EmbeddingQueue({
    embed: async () => { embedCalls += 1; throw new Error('down') },
    putVector: async () => {},
  })
  q.enqueue('m-1', 'x')
  await flush()
  assert.equal(embedCalls, 1)
  q.dispose() // 應清除 5s 重試 timer
  t.mock.timers.tick(60000) // 虛擬推進一分鐘:原重試不應再觸發
  await flush()
  assert.equal(embedCalls, 1, 'dispose 後重試 timer 已清除')
  t.mock.timers.reset()
})

test('applyMemory: 隊列清理經 ctx.effect 註冊,ctx dispose 後 save 不再嵌入', async () => {
  const embedder = makeEmbedder({ dim: 4 })
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder })
  const s1 = await saveMem(h, 'before dispose marker', ['a'])
  const id1 = s1.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  const vt = () => h.st.medium.get('vector_memory').tables.get('memory_vectors')
  await waitFor(() => vt()?.has(id1), 3000, 'dispose 前向量落盤')

  await h.dispose() // 跑 ctx.effect 清理鏈,含 queue.dispose

  const s2 = await saveMem(h, 'after dispose marker', ['b']) // fake 域仍可寫;隊列已 dispose
  const id2 = s2.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  await flush()
  assert.ok(!vt()?.has(id2), 'dispose 後新記憶不再嵌入')
  assert.ok(
    !embedder.calls.some((c) => c.texts.some((x) => x.includes('after dispose marker'))),
    'dispose 後 embedder 不再被調用',
  )
})

// ── 7. F2/F3 修復契約(隊長代碼審查 2026-09-01)───────────────────────────────

test('F2 契約: embedder 缺失時 mem_save 仍無條件入隊(閉環不被預檢繞過)', async () => {
  const h = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON } }) // 無 embedder 服務
  await saveMem(h, 'saved while embedder down', ['resilience'])
  const health = await h.tools.get('mem_health').execute({})
  // 修復前:save 路徑預檢 getEmbedder()→undefined→不入隊(enqueued 恆 0),
  // 向量缺失直到重啟。修復後:隊列 stats 立即可見 enqueued≥1。
  assert.match(health, /embedding queue: enqueued [1-9]/, `save 應無條件入隊: ${health}`)
  await h.dispose()
})

test('id 空間契約: slug-keyed 記憶(memory agent 寫入形態)語義命中以 table key 浮出', async () => {
  // 生產 store 實測:603 條中 558 條以語義 slug 為 key('compaction:1' 等),
  // record.id 僅為寫入者元數據。向量表/融合/組裝必須全程以 table key 為 id。
  const seed = vectorFor({ 'alpha beta gamma': [1, 0, 0, 0], zzzz: [1, 0, 0, 0] }, 4)
  const a = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, embedder: makeEmbedder({ dim: 4, seed }) })
  await saveMem(a, 'alpha beta gamma', ['greek'])
  await a.dispose() // flush 到介質

  // 把 id-key 改寫為 slug-key(模擬 memory agent 形態;record.id 保留原值)
  const doc = a.st.medium.get('vector_memory')
  const recs = doc.tables.get('memories')
  const [[oldKey, rec]] = [...recs.entries()]
  recs.delete(oldKey)
  recs.set('compaction:1', rec)

  const stB = makeFakeStorage()
  stB.medium.set('vector_memory', structuredClone(doc))
  const b = await setup({ config: { ...BASE_CONFIG, embedding: EMB_ON }, storage: stB, embedder: makeEmbedder({ dim: 4, seed }) })
  // backfill 為火忘式,僅在讀/寫時觸發:先做一次無關搜索點火,再等向量落盤。
  // 注意:fake storage 每次 flush 會替換 Map 實例,輪詢須重新解析引用。
  await b.tools.get('mem_search').execute({ query: 'warmup-trigger-backfill' })
  await waitFor(() => stB.medium.get('vector_memory')?.tables.get('memory_vectors')?.has('compaction:1') ?? false, 3000, 'backfill 應以 slug key 寫向量')

  const out = await b.tools.get('mem_search').execute({ query: 'zzzz' }) // kw 零重疊→純語義
  assert.ok(out.includes('[compaction:1]'), `slug-keyed 語義命中應以 key 浮出: ${out}`)
  assert.ok(out.includes('via: sem'), `應標記語義來源: ${out}`)
  await b.dispose()
})
