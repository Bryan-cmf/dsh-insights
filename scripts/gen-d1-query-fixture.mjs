#!/usr/bin/env node
/**
 * dsh-insights · D1 查詢向量 fixture 生成器(一次性,需 tf sidecar 在跑)。
 *
 * 用 dsh-embed tf sidecar(qwen3-4b-fp16)把 d1_queries.json 的 52 條查詢
 * 按生產配方(instruct 前綴,SPEC §4.2)嵌入到 2560 維,存成 npy fixture
 * 供 scripts/ablate-fusion.mjs 離線消融使用(消融本身零 GPU)。
 *
 * 用法:node scripts/gen-d1-query-fixture.mjs
 * 輸出:scripts/fixtures/d1-queries.qwen3-4b-fp16@2560.npy + .json(查詢文本對齊)
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { writeNpy } from './npy.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const POC = join(HERE, '..', '..', 'dsh-wemm-poc')
const FIXTURES = join(HERE, 'fixtures')

/** 生產查詢側 instruct(memory.ts MEMORY_QUERY_INSTRUCT;D1 回歸配方 task='memory notes')。 */
export const QUERY_INSTRUCT = 'Given a query, retrieve relevant memory notes'

async function main() {
  const queries = JSON.parse(await readFile(join(POC, 'data', 'd1_queries.json'), 'utf8'))
  const hs = JSON.parse(await readFile(join(homedir(), '.dsh', 'run', 'dsh-embed', 'tf.json'), 'utf8'))
  const base = `http://127.0.0.1:${hs.port}`

  const res = await fetch(`${base}/embed/texts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-embed-token': hs.token },
    body: JSON.stringify({ texts: queries.map((q) => q.q), dim: 2560, instruct: QUERY_INSTRUCT }),
  })
  if (!res.ok) throw new Error(`/embed/texts → ${res.status} ${await res.text().catch(() => '')}`)
  const body = await res.json()
  if (body.fingerprint !== 'qwen3-4b-fp16@2560') throw new Error(`unexpected fingerprint ${body.fingerprint}`)
  if (!Array.isArray(body.vectors) || body.vectors.length !== queries.length) throw new Error('vectors count mismatch')

  await mkdir(FIXTURES, { recursive: true })
  await writeNpy(join(FIXTURES, 'd1-queries.qwen3-4b-fp16@2560.npy'), body.vectors)
  await writeFile(
    join(FIXTURES, 'd1-queries.qwen3-4b-fp16@2560.json'),
    `${JSON.stringify({ fingerprint: body.fingerprint, instruct: QUERY_INSTRUCT, queries: queries.map((q) => q.q) }, null, 2)}\n`,
  )
  console.log(`fixture written: ${body.vectors.length} queries × 2560 dims (${body.ms}ms server-side)`)
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1) })
