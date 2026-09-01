#!/usr/bin/env node
/**
 * dsh-insights · memory v2 一次性 backfill 腳本(SPEC dsh-embed-spec.md §6「下次
 * backfill 兜住」/§8):為存量 memories 離線補建 memory_vectors 向量行。
 *
 * 場景:flag 開啟前已有存量記憶(現網 522 條),或回滾舊版插件導致
 * memory_vectors 被靜默丟棄後的重建(向量為派生數據,可安全重建)。
 *
 * 用法:
 *   node scripts/backfill-memory-vectors.mjs [--storage PATH] [--backend NAME]
 *     [--dim N] [--sidecar tf|mlx] [--batch 16] [--dry-run] [--force]
 *
 * 默認值:
 *   --storage  ~/.dsh/storages/vector_memory.json(dsh-storage-json single 佈局)
 *   --backend  qwen3-4b-fp16(--dim 512;指紋 `{backend}@{dim}`)
 *   --sidecar  tf(讀 ~/.dsh/run/dsh-embed/<sidecar>.json 握手文件取 port/token)
 *
 * 安全約束:
 * - 離線腳本:運行前必須停止 DSH 進程(dsh-storage-json 的內存態會在插件寫入時
 *   覆蓋本腳本的落盤結果)。檢測到疑似運行中的 dsh 進程時拒絕執行,--force 強制。
 * - 原子寫回:同目錄臨時文件 + rename,與 dsh-storage-json writeAtomic 同協議。
 * - 只改 memory_vectors 表;memories 與其他表原樣保留。
 */
import { readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    storage: join(homedir(), '.dsh', 'storages', 'vector_memory.json'),
    backend: 'qwen3-4b-fp16',
    dim: 2560, // R2F2:對齊生產默認(SPEC v1.3;舊默認 512 會寫出與配置指紋不符的行)
    sidecar: 'tf',
    batch: 16, // SPEC §6:批量 16 條/次
    dryRun: false,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--storage') opts.storage = argv[++i]
    else if (a === '--backend') opts.backend = argv[++i]
    else if (a === '--dim') opts.dim = Number(argv[++i])
    else if (a === '--sidecar') opts.sidecar = argv[++i]
    else if (a === '--batch') opts.batch = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/backfill-memory-vectors.mjs [--storage PATH] [--backend NAME] [--dim N] [--sidecar tf|mlx] [--batch N] [--dry-run] [--force]')
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(opts.dim) || opts.dim <= 0) {
    console.error(`--dim must be a positive integer, got ${opts.dim}`)
    process.exit(2)
  }
  return opts
}

// ── safety: DSH must be stopped ─────────────────────────────────────────────

function assertDshStopped(force) {
  if (force) return
  const suspicious = []
  // R2F3 實測(macOS pgrep 怪癖):帶路徑分隔符的 pattern(dsh/lib/bin.js 等)
  // 對長 cmdline 全部漏配;唯一可靠的是純參數段 'bin.js (web|serve)'。
  try {
    const out = execFileSync('pgrep', ['-fl', 'bin.js (web|serve)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    suspicious.push(...out.split('\n').filter((l) => l.includes('dsh') && l.trim() !== ''))
  } catch { /* pgrep exit 1 = 無匹配 */ }
  // 雙保險:默認端口 3080 處於 LISTEN 即視為 DSH 在運行(覆蓋非常規啟動路徑)。
  try {
    const lsof = execFileSync('lsof', ['-nP', '-iTCP:3080', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (lsof.trim() !== '') suspicious.push(`port 3080 LISTEN: ${lsof.split('\n')[1] ?? ''}`.trim())
  } catch { /* lsof 非零 = 無監聽 */ }
  if (suspicious.length > 0) {
    console.error('偵測到疑似運行中的 DSH 進程(dsh-storage-json 內存態會覆蓋本腳本落盤結果):')
    for (const l of suspicious) console.error(`  ${l}`)
    console.error('請先停止 DSH,或確認無誤後加 --force。')
    process.exit(1)
  }
}

// ── embed 配方(必須與生產 embedTextOf 完全一致,否則同一指紋下混入兩種向量)──

function embedTextOf(rec) {
  const tags = Array.isArray(rec.tags) ? rec.tags : []
  return tags.length > 0 ? `${rec.content} tags: ${tags.join(', ')}` : rec.content
}

// ── sidecar HTTP(SPEC §4 契約) ─────────────────────────────────────────────

async function loadHandshake(sidecar) {
  const path = join(homedir(), '.dsh', 'run', 'dsh-embed', `${sidecar}.json`)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  if (typeof raw.port !== 'number' || typeof raw.token !== 'string') {
    throw new Error(`握手文件缺 port/token: ${path}`)
  }
  return { base: `http://127.0.0.1:${raw.port}`, token: raw.token, path }
}

async function embedBatch(hs, texts, dim) {
  const res = await fetch(`${hs.base}/embed/texts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-embed-token': hs.token },
    body: JSON.stringify({ texts, dim }),
  })
  if (!res.ok) throw new Error(`/embed/texts → ${res.status} ${await res.text().catch(() => '')}`)
  const body = await res.json()
  if (!Array.isArray(body.vectors) || body.vectors.length !== texts.length) {
    throw new Error(`/embed/texts 回應畸形: vectors 數不符 (fingerprint: ${body.fingerprint ?? 'unknown'})`)
  }
  return body // {vectors, fingerprint, dim, ms}
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  assertDshStopped(opts.force)

  const text = await readFile(opts.storage, 'utf8')
  const doc = JSON.parse(text)
  if (doc?.unit?.name !== 'vector_memory' || doc.unit.version !== 1 || typeof doc.tables !== 'object' || doc.tables === null) {
    throw new Error(`存儲文件不是 vector_memory v1 single 單元: ${opts.storage}`)
  }
  const memories = doc.tables.memories ?? {}
  const vectors = doc.tables.memory_vectors ?? {}
  const fp = `${opts.backend}@${opts.dim}`
  const now = Date.now()

  const todo = []
  for (const [id, rec] of Object.entries(memories)) {
    if (typeof rec?.content !== 'string') continue
    if (rec.expiresAt !== 0 && rec.expiresAt <= now) continue // 過期記憶不嵌入
    const row = vectors[id]
    if (row && row.fp === fp && row.dim === opts.dim && Array.isArray(row.vec)) continue
    todo.push({ id, text: embedTextOf(rec) })
  }
  console.log(`memories: ${Object.keys(memories).length}, vectors: ${Object.keys(vectors).length}, fingerprint: ${fp}`)
  console.log(`待嵌入: ${todo.length} 條(缺失或指紋過期)`)
  if (todo.length === 0 || opts.dryRun) {
    console.log(opts.dryRun ? 'dry-run,未寫入。' : '無需 backfill。')
    return
  }

  const hs = await loadHandshake(opts.sidecar)
  console.log(`sidecar: ${hs.path} → ${hs.base}`)

  let done = 0
  for (let i = 0; i < todo.length; i += opts.batch) {
    const batch = todo.slice(i, i + opts.batch)
    const body = await embedBatch(hs, batch.map((b) => b.text), opts.dim)
    if (body.fingerprint !== fp) {
      throw new Error(`sidecar 指紋 ${body.fingerprint} ≠ 配置指紋 ${fp}——禁止跨後端混存(SPEC §13),中止。`)
    }
    for (let j = 0; j < batch.length; j++) {
      vectors[batch[j].id] = { fp, dim: opts.dim, vec: body.vectors[j], ts: now }
    }
    done += batch.length
    console.log(`  ${done}/${todo.length} (${body.ms}ms/batch)`)
  }

  // 原子寫回(writeAtomic 同協議:同目錄 tmp + rename)。
  doc.tables.memory_vectors = vectors
  const tmp = join(dirname(opts.storage), `.${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await rename(tmp, opts.storage)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
  console.log(`backfill 完成:${done} 條向量寫入 ${opts.storage}`)
}

main().catch((error) => {
  console.error(`backfill 失敗: ${error?.stack ?? error}`)
  process.exit(1)
})
