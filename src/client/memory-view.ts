/**
 * dsh-insights · 記憶視圖 v2(原 @bryan-cmf/dsh-vector-memory client)。
 *
 * 「記憶」tab(order 30):
 * 上段·智能模塊——記憶智能體與自動存檔寫入 vector_memory 域的內容,
 *   按模塊分組(卡點/失敗/技術/學習/決策/踩坑/里程碑/洞察),跨 session 累積;
 *   記憶智能體每 3 輪從近期軌跡提煉(LLM 理解後歸類,取代 regex 死分類)。
 * 下段·記憶活動——本 session 的 mem_save/mem_search 活動四透鏡(memActivity 投影)。
 * 回合結束自動刷新(infraView 投影)+ 30s 輪詢兜底。
 */
import { createElement, useEffect, useState, type CSSProperties, type ReactNode } from 'react'

interface SlotsService {
  inject(key: string, fn: () => unknown): unknown
  register(registration: unknown, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
}
interface ViewProps {
  useProjection?: <K extends string>(key: K) => unknown
}
interface ActivityItem {
  seq: number
  kind: string
  text: string
  ok: boolean
}
interface MemActivity {
  items: ActivityItem[]
}
interface MemRow {
  key: string
  content: string
  tags: string[]
  createdAt: number
}

const badgeState = { mem: 0, memFail: 0 }

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 20px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' }
const card: CSSProperties = { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '12px 14px' }
const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-secondary)' }
const statsRow: CSSProperties = { display: 'flex', gap: 16, flexWrap: 'wrap' }
const stat: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const statValue: CSSProperties = { fontSize: 20, fontWeight: 700 }
const statLabel: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' }
const textCell: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const okColor: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }
const errColor: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const brandColor: CSSProperties = { color: 'var(--dsw-alias-brand-primary)' }
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }
const badge: CSSProperties = { fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', flex: 'none' }

// ── 智能模塊(記憶域內容,按模塊分組)─────────────────────────────────────────

const MODULE_ORDER = ['卡點', '失敗', '技術', '學習', '決策', '踩坑', '里程碑', '洞察', '其他']
const MODULE_TONE: Record<string, CSSProperties> = {
  失敗: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
  踩坑: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
  卡點: { color: 'var(--dsw-alias-state-warn-label)', borderColor: 'var(--dsw-alias-state-warn-label)' },
  技術: brandColor,
  學習: brandColor,
  決策: brandColor,
}

function moduleOf(item: MemRow): string {
  // 智能記憶 rows:tags = ['智能記憶', 模塊];其他:tags[0] 即模塊
  if (item.tags.indexOf('智能記憶') !== -1 && typeof item.tags[1] === 'string') return item.tags[1]
  const first = item.tags[0]
  return typeof first === 'string' && first !== '' ? first : '其他'
}

function MemoryModules(props: { refreshKey: number }): ReactNode {
  const [items, setItems] = useState<MemRow[]>([])
  function load(): void {
    fetch('/api/memories')
      .then((r) => r.json())
      .then((d: { items?: MemRow[] }) => setItems(Array.isArray(d.items) ? d.items : []))
      .catch(() => { /* 靜默 */ })
  }
  useEffect(() => {
    let cancelled = false
    fetch('/api/memories')
      .then((r) => r.json())
      .then((d: { items?: MemRow[] }) => { if (!cancelled) setItems(Array.isArray(d.items) ? d.items : []) })
      .catch(() => { /* 靜默 */ })
    return () => { cancelled = true }
  }, [props.refreshKey])
  useEffect(() => {
    const timer = setInterval(() => load(), 30000)
    return () => clearInterval(timer)
  }, [])

  if (items.length === 0) return null
  const buckets: Record<string, MemRow[]> = {}
  for (const it of items) {
    const m = moduleOf(it)
    if (buckets[m] === undefined) buckets[m] = []
    buckets[m]!.push(it)
  }
  const modules = MODULE_ORDER.filter((m) => buckets[m] !== undefined)
    .concat(Object.keys(buckets).filter((m) => MODULE_ORDER.indexOf(m) === -1))

  return createElement('div', { style: card },
    createElement('div', { style: cardTitle }, `智能記憶模塊(${items.length} 條 · 跨 session 累積)`),
    modules.map((m) =>
      createElement('div', { key: m, style: { marginBottom: 6 } },
        createElement('div', { style: { fontSize: 11, fontWeight: 600, marginBottom: 4, color: 'var(--dsw-alias-label-secondary)' } }, `${m}(${buckets[m]!.length})`),
        buckets[m]!.slice(0, 8).map((it) =>
          createElement('div', { key: it.key, style: row },
            createElement('span', { style: { ...badge, ...(MODULE_TONE[m] || {}) } }, m),
            createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' }, title: it.content }, it.content),
            it.createdAt > 0
              ? createElement('span', { style: { ...badge, color: 'var(--dsw-alias-label-tertiary)' } }, new Date(it.createdAt).toISOString().slice(5, 10))
              : null)))))
}

// ── 記憶活動四透鏡(memActivity 投影,本 session)────────────────────────────

const MEM_LENSES = [
  { id: 'block', title: '卡點', rx: /卡|阻|阻塞|障礙|瓶頸|stuck|block|pending|待解決|困住|無法/ },
  { id: 'fail', title: '失敗', rx: /失敗|錯誤|異常|崩|炸|fail|error|exception|crash|denied|拒絕/ },
  { id: 'tech', title: '技術', rx: /技術|方法|模式|做法|方案|架構|設計|pattern|skill|技巧|api|指令|寫法/ },
  { id: 'learn', title: '學習', rx: /學習|教訓|領悟|發現|注意|以後|記得|記住|下次|learn|lesson|insight|remind/ },
] as const

type LensId = 'block' | 'fail' | 'tech' | 'learn' | 'other'

function lensOf(item: ActivityItem): LensId {
  const t = String(item.text || '').toLowerCase()
  if (item.ok !== true) return 'fail'
  for (const lens of MEM_LENSES) if (lens.rx.test(t)) return lens.id
  return 'other'
}

function itemRow(item: ActivityItem): ReactNode {
  return createElement(
    'div',
    { key: String(item.seq), style: row },
    createElement('span', { style: item.ok ? okColor : errColor, flex: 'none' }, item.ok ? '✓' : '✗'),
    createElement('span', { style: textCell, title: item.text }, item.text === '' ? '(空)' : item.text),
  )
}

export function applyMemoryView(ctx: ClientCtx): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view', id: 'memory', order: 30, label: () => {
        if (badgeState.memFail > 0) return `記憶 ✗${badgeState.memFail}`
        if (badgeState.mem > 0) return `記憶 ${badgeState.mem}`
        return '記憶'
      },
    },
    (props: ViewProps) => {
      const activity = props.useProjection ? (props.useProjection('memActivity') as MemActivity | undefined) : undefined
      const infra = props.useProjection ? (props.useProjection('infraView') as any) : undefined
      const turns: number = infra && infra.turns && typeof infra.turns.ended === 'number' ? infra.turns.ended : 0

      let activitySection: ReactNode
      if (!activity) {
        activitySection = createElement('div', { style: card },
          createElement('div', { style: cardTitle }, '記憶活動'),
          createElement('div', { style: emptyText }, '記憶活動尚未就緒(memActivity 投影未回填)…'))
      } else {
        const items = Array.isArray(activity.items) ? activity.items : []
        const buckets: Record<LensId, ActivityItem[]> = { block: [], fail: [], tech: [], learn: [], other: [] }
        for (const it of items) buckets[lensOf(it)]!.push(it)
        const saves = items.filter((i) => i.kind === 'mem_save').length
        const searches = items.filter((i) => i.kind === 'mem_search').length
        badgeState.mem = saves
        badgeState.memFail = buckets.fail!.length
        activitySection = createElement('div', { style: card },
          createElement('div', { style: cardTitle }, `記憶活動(本 session:存 ${saves} · 查 ${searches})`),
          createElement('div', { style: statsRow },
            MEM_LENSES.map((lens) =>
              createElement('div', { key: lens.id, style: stat },
                createElement('span', { style: { ...statValue, ...(lens.id === 'fail' ? errColor : {}) } }, String(buckets[lens.id]!.length)),
                createElement('span', { style: statLabel }, lens.title)))),
          items.length === 0
            ? createElement('div', { style: { ...emptyText, marginTop: 8 } }, '尚無記憶活動——讓模型呼叫 mem_save / mem_search 即可在這裡看到')
            : createElement('div', { style: { marginTop: 8 } },
                items.slice().reverse().slice(0, 10).map(itemRow)))
      }

      return createElement('div', { style: page },
        createElement(MemoryModules, { key: 'modules', refreshKey: turns }),
        activitySection)
    },
  ))
}
