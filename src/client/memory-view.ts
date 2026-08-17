/**
 * dsh-insights · 記憶視圖(原 @bryan-cmf/dsh-vector-memory client)。
 *
 * Registers a 「記憶」view tab (order 30, right of chat / 軌跡 / 觀測) showing
 * this session's memory activity from the `memActivity` session projection,
 * organized through four lenses (v2):
 * - 卡點(blockers)/ 失敗(failures)/ 技術(techniques)/ 學習(learning)
 * 失敗與卡點高亮——記憶的價值在卡點與教訓。
 */
import { createElement, type CSSProperties, type ReactNode } from 'react'

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
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }

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
      if (!activity) {
        return createElement('div', { style: page }, '記憶活動尚未就緒(memActivity 投影未回填)…')
      }
      const items = Array.isArray(activity.items) ? activity.items : []
      const buckets: Record<LensId, ActivityItem[]> = { block: [], fail: [], tech: [], learn: [], other: [] }
      for (const it of items) buckets[lensOf(it)]!.push(it)
      const saves = items.filter((i) => i.kind === 'mem_save').length
      const searches = items.filter((i) => i.kind === 'mem_search').length
      badgeState.mem = saves
      badgeState.memFail = buckets.fail!.length

      const header = createElement('div', { style: card },
        createElement('div', { style: cardTitle }, '記憶概覽'),
        createElement('div', { style: statsRow },
          createElement('div', { style: stat }, createElement('span', { style: statValue }, String(saves)), createElement('span', { style: statLabel }, '已儲存')),
          createElement('div', { style: stat }, createElement('span', { style: statValue }, String(searches)), createElement('span', { style: statLabel }, '已檢索')),
          createElement('div', { style: stat }, createElement('span', { style: { ...statValue, ...errColor } }, String(buckets.fail!.length)), createElement('span', { style: statLabel }, '失敗/卡點'))),
        createElement('div', { style: { ...emptyText, marginTop: 8 } }, '記憶的價值在卡點與教訓——讓模型用 mem_save 記錄失敗、技術與學習,避免重蹈覆轍。'))

      const lensCards = MEM_LENSES.map((lens) => {
        const list = buckets[lens.id]!.slice().reverse().slice(0, 10)
        return createElement('div', { key: lens.id, style: card },
          createElement('div', { style: cardTitle }, `${lens.title}(${buckets[lens.id]!.length})`),
          list.length === 0 ? createElement('div', { style: emptyText }, '尚無此類記憶') : list.map(itemRow))
      })

      return createElement('div', { style: page }, header, lensCards)
    },
  ))
}


