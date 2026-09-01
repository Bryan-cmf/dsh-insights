/**
 * dsh-insights · memory v2 回滾語義測試(隊長裁決 / SPEC §11)。
 *
 * 場景:新版插件寫入 memory_vectors → 回滾舊版插件(域 spec 無
 * memory_vectors)→ 舊代碼寫入時 serialize 只覆蓋 descriptor 內的表,
 * memory_vectors 被靜默丟棄 → 再啟新版,backfill 重建全部向量,
 * memories 原文(含舊版期間寫入的記憶)完好。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMemory } from '../src/host/memory.ts'
import { memorySchema, resetDomainSingletonsForTest } from '../src/host/domains.ts'
import { domainTable } from '@deepseek-ai/dsh-storage-domain'
import { makeFakeStorage, makeCtx, makeEmbedder } from './helpers.mjs'

const EMB_ON = { enabled: true, backend: 'qwen3-4b-fp16', dim: 4 }
const BASE_CONFIG = { ttlDays: 90, maxResults: 10 }

async function waitFor(cond, timeoutMs = 3000, label = 'condition') {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function mediumTables(st) {
  return st.medium.get('vector_memory').tables
}

test('回滾舊版 → memory_vectors 被丟棄 → 新版 backfill 恢復,memories 原文完好', async () => {
  const st = makeFakeStorage()

  // ── 階段 1:新版插件,embedding on,寫兩條記憶並等向量落盤 ──
  resetDomainSingletonsForTest()
  const h1 = makeCtx({ storageDomain: st.storageDomain, services: { embedder: makeEmbedder({ dim: 4 }) } })
  applyMemory(h1.ctx, { ...BASE_CONFIG, embedding: EMB_ON })
  const s1 = await h1.tools.get('mem_save').execute({ content: 'first memory about rust', tags: ['rust'] })
  const s2 = await h1.tools.get('mem_save').execute({ content: 'second memory about postgres', tags: ['db'] })
  const id1 = s1.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  const id2 = s2.match(/^saved memory (mem-[a-z0-9-]+)/)[1]
  await waitFor(() => mediumTables(st).get('memory_vectors')?.size === 2, 3000, '兩條向量落盤')
  await h1.dispose()
  assert.equal(mediumTables(st).get('memories').size, 2)
  assert.equal(mediumTables(st).get('memory_vectors').size, 2)

  // ── 階段 2:回滾舊版(域 spec 只有 memories),寫第三條記憶 ──
  // 舊版 serialize 只寫 descriptor 內的表 → memory_vectors 從介質丟棄。
  const oldSpec = { name: 'vector_memory', version: 1, tables: { memories: domainTable(memorySchema) } }
  const oldDomain = await st.storageDomain.open(oldSpec)
  const oldMemories = oldDomain.table('memories')
  await oldMemories.put('mem-oldver-1', {
    id: 'mem-oldver-1', content: 'third memory written by old plugin', tags: ['legacy'],
    createdAt: Date.now(), updatedAt: Date.now(), hits: 0, expiresAt: 0,
  })
  await oldDomain.close()
  assert.equal(mediumTables(st).get('memories').size, 3, 'memories 原文含舊版寫入')
  assert.equal(mediumTables(st).get('memory_vectors'), undefined, '舊版寫入後 memory_vectors 被靜默丟棄')

  // ── 階段 3:再啟新版 → backfill 重建全部向量,原文完好 ──
  resetDomainSingletonsForTest()
  const h2 = makeCtx({ storageDomain: st.storageDomain, services: { embedder: makeEmbedder({ dim: 4 }) } })
  applyMemory(h2.ctx, { ...BASE_CONFIG, embedding: EMB_ON })
  // 首次讀寫觸發 backfill。
  const out = await h2.tools.get('mem_search').execute({ query: 'rust' })
  assert.ok(out.includes(id1), 'memories 原文可查')
  await waitFor(() => mediumTables(st).get('memory_vectors')?.size === 3, 3000, 'backfill 重建 3 條向量')

  const vectors = mediumTables(st).get('memory_vectors')
  for (const id of [id1, id2, 'mem-oldver-1']) {
    const row = vectors.get(id)
    assert.ok(row, `向量行存在: ${id}`)
    assert.equal(row.fp, 'qwen3-4b-fp16@4')
    assert.equal(row.dim, 4)
  }
  assert.equal(mediumTables(st).get('memories').size, 3, 'memories 原文不受影響')
  await h2.dispose()
})
