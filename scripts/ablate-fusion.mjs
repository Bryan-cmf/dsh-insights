#!/usr/bin/env node
/**
 * dsh-insights · memory v2 融合策略離線消融(F-QA-2 / t15)。
 *
 * 零 GPU:D1 語料文檔向量用 dsh-wemm-poc/results/cache/d1_qwen3-4b.npy
 * (522×2560,qwen3-4b-fp16 全維快取),查詢向量用 scripts/fixtures/ 的
 * 52×2560 fixture(gen-d1-query-fixture.mjs 一次性生成);kw 排名直接驅動
 * 生產代碼(applyMemory flag-off 的 vectorMemory.search),保證與線上一致。
 *
 * 對比策略(Recall@5,52 查詢):
 *   kw-only / sem-only@512 / sem-only@2560(基線列)
 *   A. rrf-k60         —— 現行等權 RRF,SPEC §6 原案
 *   B. wrrf-wsem3      —— 加權 RRF,sem 權重 3
 *   C. sem-primary     —— sem 主列表 + kw 僅補位(sem 沒有的 id 追加在後)
 *   D. asymk-60/120    —— 非對稱 RRF,k_sem=60 / k_kw=120
 * 硬約束(不變式):fused ≥ max(kw-only, sem-only)。滿足者中取最簡公式。
 *
 * --e2e:額外驅動生產混合路徑(applyMemory flag-on + fixture 假 embedder)
 *        實測 shipped fuseHybrid 的 Recall@5(驗收「混合路徑 ≥93%」)。
 *
 * 用法:node scripts/ablate-fusion.mjs [--e2e]
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMemory, cosineSimilarity, embedTextOf, rrfFuse } from '../src/host/memory.ts'
import { resetDomainSingletonsForTest } from '../src/host/domains.ts'
import { makeFakeStorage, makeCtx } from '../test/helpers.mjs'
import { readNpy, rows2d } from './npy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const POC = join(HERE, '..', '..', 'dsh-wemm-poc')
const K = 5

// ── 數據加載 ────────────────────────────────────────────────────────────────

const mems = (await readFile(join(POC, 'data', 'd1_memories.jsonl'), 'utf8'))
  .trim().split('\n').map((l) => JSON.parse(l))
const queries = JSON.parse(await readFile(join(POC, 'data', 'd1_queries.json'), 'utf8'))
const docMat = rows2d(...Object.values(await readNpy(join(POC, 'results', 'cache', 'd1_qwen3-4b.npy'))))
const qFixture = rows2d(...Object.values(await readNpy(join(HERE, 'fixtures', 'd1-queries.qwen3-4b-fp16@2560.npy'))))
const qMeta = JSON.parse(await readFile(join(HERE, 'fixtures', 'd1-queries.qwen3-4b-fp16@2560.json'), 'utf8'))
if (docMat.length !== mems.length) throw new Error('doc cache / corpus misaligned')
if (qFixture.length !== queries.length) throw new Error('query fixture / queries misaligned')

/** 標註:content 含任一 key 的記憶索引集合(與 t7 驗收 harness 同口徑)。 */
const relevants = queries.map((q) => new Set(
  mems.map((m, i) => (q.keys.some((k) => m.content.includes(k)) ? i : -1)).filter((i) => i >= 0),
))

// ── 工具 ────────────────────────────────────────────────────────────────────

/** MRL 截斷 + L2 重歸一(與 dsh-embed vector.ts mrlTruncate 同義)。 */
function mrl(vec, dim) {
  const out = Array.from(vec.subarray(0, dim))
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? out.map((x) => x / norm) : out
}

function recallAt(rankings, k) {
  let hit = 0
  for (let i = 0; i < rankings.length; i++) {
    if (rankings[i].slice(0, k).some((id) => relevants[i].has(id))) hit += 1
  }
  return hit / rankings.length
}

function semRankings(dim) {
  const docs = dim === 2560 ? docMat : docMat.map((v) => mrl(v, dim))
  return queries.map((q, qi) => {
    const qv = dim === 2560 ? qFixture[qi] : mrl(qFixture[qi], dim)
    return docs.map((d, di) => [cosineSimilarity(qv, d), di])
      .sort((a, b) => b[0] - a[0])
      .map(([, di]) => di)
  })
}

// ── kw 排名:驅動生產 flag-off 路徑 ──────────────────────────────────────────

resetDomainSingletonsForTest()
const st = makeFakeStorage()
const h = makeCtx({ storageDomain: st.storageDomain })
applyMemory(h.ctx, { ttlDays: 0, maxResults: 10 }) // flag off:純 kw,v1 行為
const svc = h.provided.get('vectorMemory')
const corpusToSvc = new Array(mems.length)
for (let i = 0; i < mems.length; i++) {
  const { id } = await svc.save(mems[i].content, mems[i].tags ?? [], 0)
  corpusToSvc[i] = id
}
const kwRankings = []
for (const q of queries) {
  const hits = await svc.search(q.q, 100)
  // 映回語料索引;kw 只返回 score>0 的項
  kwRankings.push(hits.map((x) => corpusToSvc.indexOf(x.id)).filter((i) => i >= 0))
}
await h.dispose()

// ── 候選融合策略(輸入輸出皆為語料索引排名) ──────────────────────────────────

function rrfIds(kwIds, semIds, kSem = 60, kKw = 60, wSem = 1, wKw = 1) {
  const map = new Map()
  kwIds.forEach((id, r) => {
    const e = map.get(id) ?? { score: 0, firstSem: Infinity, firstKw: Infinity }
    e.score += wKw / (kKw + r + 1)
    e.firstKw = Math.min(e.firstKw, r)
    map.set(id, e)
  })
  semIds.forEach((id, r) => {
    const e = map.get(id) ?? { score: 0, firstSem: Infinity, firstKw: Infinity }
    e.score += wSem / (kSem + r + 1)
    e.firstSem = Math.min(e.firstSem, r)
    map.set(id, e)
  })
  return [...map.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstSem - b[1].firstSem || a[1].firstKw - b[1].firstKw)
    .map(([id]) => id)
}

const STRATEGIES = {
  'A.rrf-k60(現行)': (kw, sem) => rrfIds(kw, sem),
  'B.wrrf-wsem3': (kw, sem) => rrfIds(kw, sem, 60, 60, 3, 1),
  'C.sem-primary+kw補位': (kw, sem) => {
    const seen = new Set(sem)
    return [...sem, ...kw.filter((id) => !seen.has(id))]
  },
  'D.asymk-60/120': (kw, sem) => rrfIds(kw, sem, 60, 120),
}

// ── 對照表 ──────────────────────────────────────────────────────────────────

const sem2560 = semRankings(2560)
const sem512 = semRankings(512)
const baseline = {
  'kw-only': recallAt(kwRankings, K),
  'sem-only@512': recallAt(sem512, K),
  'sem-only@2560': recallAt(sem2560, K),
}

console.log(`D1 消融:${queries.length} 查詢 × ${mems.length} 記憶,Recall@${K}`)
console.log('─'.repeat(64))
console.log('基線:')
for (const [name, r] of Object.entries(baseline)) {
  console.log(`  ${name.padEnd(28)} ${(r * 100).toFixed(1)}%`)
}
console.log('─'.repeat(64))
console.log('融合策略(@2560 文檔/查詢向量):')

const table = []
for (const [name, fn] of Object.entries(STRATEGIES)) {
  const fused = queries.map((_, i) => fn(kwRankings[i].slice(0, 100), sem2560[i].slice(0, 100)))
  const r = recallAt(fused, K)
  const invariant = r >= Math.max(baseline['kw-only'], baseline['sem-only@2560']) - 1e-9
  table.push({ name, recall: r, invariant })
  console.log(`  ${name.padEnd(28)} ${(r * 100).toFixed(1)}%   不變式 fused≥max(kw,sem): ${invariant ? 'PASS' : 'FAIL'}`)
}
console.log('─'.repeat(64))
const winners = table.filter((x) => x.invariant)
console.log(`滿足不變式: ${winners.map((x) => x.name).join(', ') || '(無)'}`)

// ── --e2e:生產混合路徑實測(shipped fuseHybrid) ──────────────────────────────

if (process.argv.includes('--e2e')) {
  const memory = await import('../src/host/memory.ts')
  if (typeof memory.fuseHybrid !== 'function') {
    console.log('memory.ts 尚未導出 fuseHybrid,跳過 e2e')
    process.exit(0)
  }
  const docVecByText = new Map(mems.map((m, i) => [embedTextOf({ content: m.content, tags: m.tags ?? [] }), docMat[i]]))
  const qVecByText = new Map(queries.map((q, i) => [q.q, qFixture[i]]))
  const fakeEmbedder = {
    async embedTexts(texts, opts) {
      const dim = opts?.dim ?? 2560
      return texts.map((text) => {
        const v = docVecByText.get(text) ?? qVecByText.get(text)
        if (v === undefined) throw new Error(`fixture 無此文本的向量: ${text.slice(0, 60)}`)
        return dim === 2560 ? Array.from(v) : mrl(v, dim)
      })
    },
    async health() { return { mlx: 'down', tf: 'up' } },
  }

  resetDomainSingletonsForTest()
  const st2 = makeFakeStorage()
  const h2 = makeCtx({ storageDomain: st2.storageDomain, services: { embedder: fakeEmbedder } })
  applyMemory(h2.ctx, { ttlDays: 0, maxResults: 10, embedding: { enabled: true, backend: 'qwen3-4b-fp16', dim: 2560 } })
  const svc2 = h2.provided.get('vectorMemory')
  const svc2ToCorpus = new Map()
  for (let i = 0; i < mems.length; i++) {
    const { id } = await svc2.save(mems[i].content, mems[i].tags ?? [], 0)
    svc2ToCorpus.set(id, i)
  }
  // 等異步嵌入隊列排空
  const deadline = Date.now() + 60000
  for (;;) {
    const n = st2.medium.get('vector_memory')?.tables.get('memory_vectors')?.size ?? 0
    if (n >= mems.length) break
    if (Date.now() > deadline) throw new Error(`向量寫入超時 ${n}/${mems.length}`)
    await new Promise((r) => setTimeout(r, 50))
  }
  let hit = 0
  for (let qi = 0; qi < queries.length; qi++) {
    const hits = await svc2.search(queries[qi].q, K)
    if (hits.some((x) => relevants[qi].has(svc2ToCorpus.get(x.id) ?? -1))) hit += 1
  }
  const e2eRecall = hit / queries.length
  console.log('─'.repeat(64))
  console.log(`e2e 生產混合路徑(shipped fuseHybrid @2560):Recall@${K} = ${(e2eRecall * 100).toFixed(1)}%  (門檻 ≥93%)`)
  await h2.dispose()
  process.exit(e2eRecall >= 0.93 ? 0 : 1)
}
