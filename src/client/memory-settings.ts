/**
 * dsh-insights · 記憶數據設置頁(settings.section id=memory-data, order 60)。
 *
 * 讀取 GET /api/memory/stats(host 端點,perspectives.ts 註冊):
 * - 概覽卡:記錄數 / 向量數 / 標籤種類 / 總命中 / 已過期 / 最近寫入
 * - 參數:TTL / maxResults / maxRecords / 健康間隔 / 警報閾值 + 嵌入(backend/dim/
 *   指紋/embedder/向量/隊列)
 * - 分類:標籤頻次橫條(前 24,降冪)
 * - 增長趨勢:SVG 柱狀(當日新增)+ 折線(累計總數),本地日粒度,至多 120 天
 *
 * 純 createElement + CSS 變量 + 內聯 SVG,不依賴 dsh-client-ui-primitives
 * (舊 host 缺失 named exports 時本頁仍可渲染,只是裸樣式)。
 */
import { createElement as h, useEffect, useState, type CSSProperties, type ReactNode } from 'react'

interface SlotsService {
  inject(key: string, fn: () => unknown): unknown
  register(registration: unknown, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
}

interface StatsPayload {
  ok: boolean
  error?: string
  summary?: {
    total: number
    expired: number
    distinctTags: number
    tagCells: number
    oldestDay: string
    newestDay: string
    generatedAt: number
  }
  params?: {
    ttlDays: number
    maxResults: number
    maxRecords: number | null
    healthIntervalMs: number | null
    errorAlertThreshold: number | null
  } | null
  embedding?: {
    enabled: boolean
    backend?: string
    dim?: number
    fingerprint?: string
    embedder?: string
    vectors?: { total: number; staleFingerprint: number; error?: string } | null
    queue?: { enqueued: number; embedded: number; dropped: number; lastError: string } | null
    recentEvents?: Array<{ kind: string; detail: Record<string, unknown>; at: number }>
  } | null
  taxonomy?: Array<{ tag: string; count: number }>
  growth?: Array<{ day: string; added: number; total: number }>
}

// ── 靜態樣式(與 memory-view 同視覺語言)─────────────────────────────────────
const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 20px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' }
const card: CSSProperties = { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '12px 14px' }
const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-secondary)' }
const statsRow: CSSProperties = { display: 'flex', gap: 18, flexWrap: 'wrap' }
const stat: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 64 }
const statValue: CSSProperties = { fontSize: 20, fontWeight: 700 }
const statLabel: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const kvRow: CSSProperties = { display: 'flex', gap: 10, padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' }
const kvKey: CSSProperties = { width: 150, flex: 'none', color: 'var(--dsw-alias-label-secondary)' }
const kvVal: CSSProperties = { flex: 1, minWidth: 0, wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }
const barRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }
const barTag: CSSProperties = { width: 96, flex: 'none', textAlign: 'right', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const barTrack: CSSProperties = { flex: 1, height: 12, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6, overflow: 'hidden' }
const barFill: CSSProperties = { height: '100%', background: 'var(--dsw-alias-brand-primary)', borderRadius: 6 }
const barCount: CSSProperties = { width: 44, flex: 'none', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right', fontSize: 11 }

function fmtNum(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function KVRows(rows: Array<[string, string]>): ReactNode {
  if (rows.length === 0) return h('div', { style: emptyText }, '—')
  return h('div', {}, rows.map(([k, v]) => h('div', { key: k, style: kvRow },
    h('span', { style: kvKey }, k),
    h('span', { style: kvVal }, v))))
}

/** SVG 增長圖:柱狀 = 當日新增,折線 = 累計總數。 */
function GrowthChart(props: { growth: NonNullable<StatsPayload['growth']> }): ReactNode {
  const items = props.growth
  const W = 720
  const H = 220
  const padL = 40
  const padR = 16
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = items.length
  const maxAdded = Math.max(1, ...items.map((g) => g.added))
  const maxTotal = Math.max(1, ...items.map((g) => g.total))
  const bw = plotW / Math.max(1, n)
  const bar = (g: { added: number }, i: number): ReactNode => {
    const bh = Math.max(1, (g.added / maxAdded) * plotH)
    return h('rect', {
      key: `b${i}`,
      x: padL + i * bw + bw * 0.2,
      y: padT + plotH - bh,
      width: bw * 0.6,
      height: bh,
      style: { fill: 'var(--dsw-alias-brand-primary)', opacity: 0.55 },
    })
  }
  const linePts = items.map((g, i) => `${padL + i * bw + bw / 2},${padT + plotH - (g.total / maxTotal) * plotH}`).join(' ')
  const dayLabel = (i: number): string => (i >= 0 && i < n ? items[i]!.day : '')
  const labelY = padT + plotH + 16
  const mid = Math.floor(n / 2)
  return h('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 'auto', display: 'block' } },
    // 網格線(4 條水平)
    [0, 1, 2, 3].map((g) => {
      const y = padT + (plotH / 4) * g
      return h('line', { key: `g${g}`, x1: padL, y1: y, x2: W - padR, y2: y, style: { stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 } })
    }),
    items.map(bar),
    h('polyline', { points: linePts, style: { fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.6 } }),
    // x 軸日期:首 / 中 / 末
    h('text', { x: padL, y: labelY, style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, dayLabel(0)),
    h('text', { x: padL + plotW / 2, y: labelY, textAnchor: 'middle', style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, dayLabel(mid)),
    h('text', { x: W - padR, y: labelY, textAnchor: 'end', style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, dayLabel(n - 1)),
    // y 軸標籤:累計 max / 當日 max
    h('text', { x: padL - 6, y: padT + 4, textAnchor: 'end', style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, fmtNum(maxTotal)),
    h('text', { x: padL - 6, y: padT + plotH + 4, textAnchor: 'end', style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, '0'),
    // 圖例
    h('text', { x: padL + 4, y: padT + plotH - 6, style: { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' } }, `柱=當日新增(峰值 ${fmtNum(maxAdded)}) · 線=累計(峰值 ${fmtNum(maxTotal)})`),
  )
}

function MemorySettingsPage(): ReactNode {
  const [data, setData] = useState<StatsPayload | null>(null)
  const [error, setError] = useState<string>('')
  function load(): void {
    fetch('/api/memory/stats')
      .then((r) => r.json())
      .then((d: StatsPayload) => { setData(d); setError(d && d.ok === false && typeof d.error === 'string' ? d.error : '') })
      .catch((e: unknown) => { setError(String(e)) })
  }
  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
  }, [])

  if (error !== '' && data === null) {
    return h('div', { style: page }, h('div', { style: card }, h('div', { style: { ...cardTitle, color: 'var(--dsw-alias-state-error-primary)' } }, '記憶數據載入失敗'), h('div', { style: emptyText }, error)))
  }
  if (data === null || data.summary === undefined) {
    return h('div', { style: page }, h('div', { style: card }, h('div', { style: emptyText }, '載入記憶統計中…')))
  }

  const s = data.summary
  const emb = data.embedding
  const embRows: Array<[string, string]> = emb === null || emb === undefined ? [['狀態', '未啟用（embedding.enabled = false）']] : [
    ['狀態', emb.enabled ? '已啟用' : '未啟用'],
    ['後端/維度', `${String(emb.backend ?? '?')} @ ${String(emb.dim ?? '?')}`],
    ['向量指紋', String(emb.fingerprint ?? '?')],
    ['嵌入器', emb.embedder === 'available' ? 'available' : emb.embedder === 'missing' ? 'missing → 降級關鍵字' : String(emb.embedder ?? '?')],
    ...(emb.vectors !== null && emb.vectors !== undefined ? [['向量行', `${fmtNum(emb.vectors.total)} 行${emb.vectors.staleFingerprint > 0 ? `（過期指紋 ${emb.vectors.staleFingerprint}）` : ''}${typeof emb.vectors.error === 'string' ? ` · ${emb.vectors.error}` : ''}`] as [string, string]] : []),
    ...(emb.queue !== null && emb.queue !== undefined ? [['嵌入隊列', `進 ${emb.queue.enqueued} · 成 ${emb.queue.embedded} · 棄 ${emb.queue.dropped}${emb.queue.lastError !== '' ? ` · 錯：${emb.queue.lastError}` : ''}`] as [string, string]] : []),
  ]
  const p = data.params
  const paramRows: Array<[string, string]> = p === null || p === undefined ? [] : [
    ['ttlDays', p.ttlDays === 0 ? '0（永不過期）' : `${p.ttlDays} 天`],
    ['maxResults', String(p.maxResults)],
    ['maxRecords', p.maxRecords !== null ? String(p.maxRecords) : '—'],
    ['healthIntervalMs', p.healthIntervalMs !== null ? `${p.healthIntervalMs} ms` : '—'],
    ['errorAlertThreshold', p.errorAlertThreshold !== null ? String(p.errorAlertThreshold) : '—'],
  ]
  const taxonomy = (data.taxonomy ?? []).slice(0, 24)
  const maxTag = Math.max(1, ...taxonomy.map((x) => x.count))
  const growth = data.growth ?? []

  return h('div', { style: page },
    // 概覽
    h('div', { style: card }, h('div', { style: cardTitle }, '概覽（全局，跨 session）'),
      h('div', { style: statsRow },
        statCard(String(s.total), '記憶總數'),
        statCard(fmtNum(s.distinctTags), '標籤種類'),
        statCard(s.total > 0 ? (s.tagCells / s.total).toFixed(1) : '—', '平均標籤/條'),
        statCard(String(s.expired), '已過期（惰性）'),
        statCard(s.newestDay !== '' ? s.newestDay.slice(5) : '—', '最近寫入'),
      )),
    // 參數
    h('div', { style: card }, h('div', { style: cardTitle }, '參數'),
      KVRows(paramRows),
      h('div', { style: { ...cardTitle, marginTop: 10 } }, '記憶 v2 嵌入'),
      KVRows(embRows)),
    // 分類
    h('div', { style: card }, h('div', { style: cardTitle }, `分類（標籤頻次 · 前 ${taxonomy.length}/${data.taxonomy?.length ?? 0}）`),
      taxonomy.length === 0
        ? h('div', { style: emptyText }, '尚無標籤')
        : h('div', {}, taxonomy.map((x) =>
            h('div', { key: x.tag, style: barRow },
              h('span', { style: barTag, title: x.tag }, x.tag),
              h('div', { style: barTrack }, h('div', { style: { ...barFill, width: `${(x.count / maxTag) * 100}%` } })),
              h('span', { style: barCount }, String(x.count)))))),
    // 增長趨勢
    h('div', { style: card }, h('div', { style: cardTitle }, `增長趨勢（本地日粒度 · ${growth.length} 天）`),
      growth.length === 0
        ? h('div', { style: emptyText }, '尚無數據')
        : h('div', {}, h(GrowthChart, { growth }))),
  )
}

function statCard(value: string, label: string): ReactNode {
  return h('div', { style: stat }, h('span', { style: statValue }, value), h('span', { style: statLabel }, label))
}

export function applyMemorySettings(ctx: ClientCtx): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'memory-data',
      order: 60,
      label: () => '記憶數據',
    },
    () => h(MemorySettingsPage, {}),
  ))
}
