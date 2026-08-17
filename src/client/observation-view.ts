/**
 * dsh-insights · 觀測視圖(原 @bryan-cmf/dsh-infra-observability client)。
 *
 * Registers an "觀測" view tab (order 20, right of chat/trajectory in the
 * conversation view ring) rendering a live dashboard from the `infraView`
 * session projection: turn counts, per-tool/per-skill usage with success
 * rates, failure count, and the recent execution trail.
 *
 * v2(合併版):同視圖追加
 * - 檔案活動(fileActivity 投影,@bryan-cmf/dsh-view-perspectives 提供)
 * - 機制事件(mechEvents 投影,@bryan-cmf/dsh-view-perspectives 提供)
 * 兩個區塊各自在投影缺席時優雅降級。
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
  sessionId?: string
}

// ── 觀測智能體產物(滾動敘事 + 里程碑,由 /api/observation 提供)─────────────

interface Milestone {
  seq: number
  kind: string
  title: string
  why: string
  evidenceSeq: number
}
interface ObsPayload {
  empty?: boolean
  narrative?: string
  topic?: string
  milestones?: Milestone[]
  turnCount?: number
}

function ObsNarrative(props: { sessionId?: string; refreshKey: number }): ReactNode {
  const [obs, setObs] = useState<ObsPayload | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildNote, setRebuildNote] = useState('')
  function load(): void {
    const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
    if (sid === '') return
    fetch(`/api/observation?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: ObsPayload) => setObs(d))
      .catch(() => { /* 路由未就緒時靜默 */ })
  }
  useEffect(() => {
    let cancelled = false
    const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
    if (sid === '') return
    fetch(`/api/observation?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: ObsPayload) => { if (!cancelled) setObs(d) })
      .catch(() => { /* 路由未就緒時靜默 */ })
    return () => { cancelled = true }
  }, [props.sessionId, props.refreshKey])

  function rebuild(): void {
    const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
    if (sid === '' || rebuilding) return
    setRebuilding(true)
    setRebuildNote('')
    fetch('/api/observation/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string }) => {
        if (d && d.ok === true) {
          setRebuildNote('')
          load()
        } else {
          // 失敗也要看得見(原來靜默,用戶以為「沒有反應」)
          setRebuildNote(d && typeof d.error === 'string' ? d.error : '重建失敗,請重試')
        }
      })
      .catch(() => setRebuildNote('呼叫失敗——請檢查服務狀態後重試'))
      .finally(() => setRebuilding(false))
  }

  const rebuildBtn = createElement('button', {
    style: sendBtnSmall,
    onClick: rebuild,
    disabled: rebuilding,
    title: '回讀全歷史,以成就主線重跑一次觀測。需時約 1–2 分鐘,期間按鈕保持「重建中…」,完成後自動刷新',
  }, rebuilding ? '重建中…(約 1–2 分鐘)' : '重新觀測')
  const rebuildNoteEl = rebuildNote !== ''
    ? createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, rebuildNote)
    : null

  if (obs === null || obs.empty === true) {
    return createElement('div', { style: card },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, '觀測敘事'),
        rebuildNoteEl,
        rebuildBtn),
      createElement('div', { style: emptyText }, '觀測智能體尚未產生敘事——有活動的回合結束後會自動觀測並在此沉澱滾動敘事與里程碑。'))
  }
  const milestones = Array.isArray(obs.milestones) ? obs.milestones : []
  const milestoneRows = milestones.slice().reverse().slice(0, 10).map((m) =>
    createElement('div', { key: `${m.seq}-${m.title}`, style: row },
      createElement('span', { style: Object.assign({}, badge, brandColor) }, m.kind),
      createElement('span', { style: { minWidth: 0 } },
        createElement('div', { style: { fontWeight: 600 } }, m.title),
        m.why !== '' ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, m.why) : null)))
  return createElement('div', { style: card },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, `觀測敘事${typeof obs.turnCount === 'number' ? `(觀測 ${obs.turnCount} 次)` : ''}`),
      rebuildNoteEl,
      rebuildBtn),
    obs.topic !== undefined && obs.topic !== ''
      ? createElement('div', { style: { marginBottom: 6, color: 'var(--dsw-alias-brand-primary)', fontWeight: 600 } }, `主題:${obs.topic}`)
      : null,
    obs.narrative !== undefined && obs.narrative !== ''
      ? createElement('div', { style: { lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, obs.narrative)
      : null,
    milestones.length > 0
      ? createElement('div', { style: { marginTop: 8 } },
          createElement('div', { style: cardTitle }, '里程碑'),
          milestoneRows)
      : null,
    createElement('div', { style: { ...emptyText, marginTop: 6, fontSize: 10 } }, '由觀測智能體生成(AI 觀測,僅供參考;里程碑附證據事件序號)'))
}

// ── 全項目觀測一覽(/api/observations)────────────────────────────────────────

interface ObsOverviewItem {
  sessionId: string
  topic: string
  narrative: string
  milestoneCount: number
  turnCount: number
  updatedAt: number
}

function ObsOverview(props: { refreshKey: number }): ReactNode {
  const [items, setItems] = useState<ObsOverviewItem[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/observations')
      .then((r) => r.json())
      .then((d: { items?: ObsOverviewItem[] }) => { if (!cancelled) setItems(Array.isArray(d.items) ? d.items : []) })
      .catch(() => { /* 靜默 */ })
    return () => { cancelled = true }
  }, [props.refreshKey])
  if (items.length === 0) return null
  const rows = items.map((it) =>
    createElement('div', { key: it.sessionId, style: row },
      createElement('span', { style: { ...badge, fontFamily: 'var(--ds-font-family-code)', fontSize: 10 }, title: it.sessionId }, it.sessionId.slice(0, 12)),
      createElement('span', { style: { flex: 1, minWidth: 0 } },
        createElement('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.topic !== '' ? it.topic : '(無主題)'),
        it.narrative !== '' ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.narrative) : null),
      createElement('span', { style: badge }, `里程碑 ${it.milestoneCount}`),
      createElement('span', { style: badge }, `觀測 ${it.turnCount}`)))
  return createElement('div', { style: card },
    createElement('div', { style: cardTitle }, `全項目觀測一覽(${items.length} 個 session)`),
    rows)
}

interface WireItem {
  name: string
  calls: number
  ok: number
  err: number
}
interface InfraWire {
  turns: { started: number; ended: number }
  errors: number
  tools: WireItem[]
  skills: WireItem[]
  recent: Array<{ seq: number; name: string; ok: boolean; code: string }>
}

const badgeState = { obs: 0, obsErr: 0 }

const page: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '16px 20px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}
const card: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 10,
  padding: '12px 14px',
}
const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-secondary)' }
const statsRow: CSSProperties = { display: 'flex', gap: 16, flexWrap: 'wrap' }
const stat: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const statValue: CSSProperties = { fontSize: 20, fontWeight: 700 }
const statLabel: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' }
const nameCell: CSSProperties = { minWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const barWrap: CSSProperties = { flex: 1, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, height: 8, overflow: 'hidden' }
const bar: CSSProperties = { height: '100%', background: 'var(--dsw-alias-brand-primary)', borderRadius: 4 }
const countCell: CSSProperties = { minWidth: 110, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }
const okColor: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }
const errColor: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const brandColor: CSSProperties = { color: 'var(--dsw-alias-brand-primary)' }
const badge: CSSProperties = { fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', flex: 'none' }
const sendBtnSmall: CSSProperties = { borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)', background: 'transparent', padding: '4px 10px', fontSize: 11, cursor: 'pointer', flex: 'none' }
const typeBadge: CSSProperties = { ...badge, minWidth: 92, textAlign: 'center' }
const neutralBadge: CSSProperties = { ...typeBadge, color: 'var(--dsw-alias-label-secondary)' }
const brandBadge: CSSProperties = { ...typeBadge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' }
const warnBadge: CSSProperties = { ...typeBadge, color: 'var(--dsw-alias-state-warn-label)', borderColor: 'var(--dsw-alias-state-warn-label)' }
const businessBadge: CSSProperties = { ...typeBadge, color: 'var(--dsw-alias-state-business-primary)', borderColor: 'var(--dsw-alias-state-business-primary)' }
const pathCell: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--ds-font-family-code)', fontSize: 12 }
const textCell: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }

const TYPE_SHORT: Record<string, string> = {
  'goal/change': '目標', 'todo/write': '待辦', 'plan/mode': '計畫', 'sandbox/mode': '沙箱',
  'approval/asked': '審批請求', 'approval/decided': '審批結果',
  'compaction/start': '壓縮開始', 'compaction/end': '壓縮結束', 'compaction/summary': '壓縮摘要',
  'command/run': '命令', 'command/done': '命令完成', 'subagent/descriptor': '子代理',
  'agent-preset/selected': 'Preset', 'llm/retry': 'LLM重試', 'llm/retry-started': 'LLM重試',
  'schedule/change': '排程', 'feedback/record': '反饋', 'permission/preset': '權限',
}

function mechTone(type: string): 'brand' | 'business' | 'warn' | 'neutral' {
  if (type.indexOf('goal') === 0 || type.indexOf('todo') === 0 || type === 'subagent/descriptor' || type === 'agent-preset/selected') return 'brand'
  if (type.indexOf('approval') === 0) return 'business'
  if (type.indexOf('command') === 0 || type.indexOf('llm/retry') === 0) return 'warn'
  return 'neutral'
}

function itemRow(item: WireItem): ReactNode {
  const total = item.calls || 1
  const okPct = Math.round((item.ok / total) * 100)
  const count = `${item.calls} 次 · ${okPct}% 成功`
  return createElement(
    'div',
    { key: item.name, style: row },
    createElement('span', { style: nameCell }, item.name),
    createElement('div', { style: barWrap }, createElement('div', { style: { ...bar, width: `${okPct}%` } })),
    createElement('span', { style: countCell }, count),
  )
}

function recentRow(r: InfraWire['recent'][number]): ReactNode {
  return createElement(
    'div',
    { key: String(r.seq), style: row },
    createElement('span', { style: { ...nameCell, minWidth: 56, color: 'var(--dsw-alias-label-secondary)' } }, `#${r.seq}`),
    createElement('span', { style: { ...nameCell, flex: 1 } }, r.name),
    createElement('span', { style: r.ok ? okColor : errColor }, r.ok ? '✓ ok' : `✗ ${r.code || 'error'}`),
  )
}

export function applyObservabilityView(ctx: ClientCtx): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view', id: 'observability', order: 20, label: '觀測',
    },
    (props: ViewProps) => {
      const wire = props.useProjection ? (props.useProjection('infraView') as InfraWire | undefined) : undefined
      const fileWire = props.useProjection ? props.useProjection('fileActivity') as any : undefined
      const mechWire = props.useProjection ? props.useProjection('mechEvents') as any : undefined
      // 佈局原則(用戶反饋):文字性內容(敘事/里程碑/一覽)在上方方便人類閱讀,
      // 數據統計類(概覽/檔案/機制/工具/技能/最近執行)在下方備查。
      const textSections: ReactNode[] = []
      const dataSections: ReactNode[] = []

      // ── 觀測敘事與里程碑(觀測智能體產物)──
      textSections.push(createElement(ObsNarrative, {
        key: 'obs-narrative',
        sessionId: props.sessionId,
        refreshKey: mechWire && Array.isArray(mechWire.items) ? mechWire.items.length : 0,
      }))

      // ── 全項目觀測一覽 ──
      textSections.push(createElement(ObsOverview, {
        key: 'obs-overview',
        refreshKey: mechWire && Array.isArray(mechWire.items) ? mechWire.items.length : 0,
      }))

      // ── 概覽統計 ──
      if (wire) {
        const toolTotal = wire.tools.reduce((acc, t) => acc + t.calls, 0)
        const skillTotal = wire.skills.reduce((acc, s) => acc + s.calls, 0)
        dataSections.push(createElement('div', { key: 'stats', style: card },
          createElement('div', { style: cardTitle }, '概覽'),
          createElement('div', { style: statsRow },
            createElement('div', { style: stat },
              createElement('span', { style: statValue }, String(wire.turns.started)),
              createElement('span', { style: statLabel }, '回合')),
            createElement('div', { style: stat },
              createElement('span', { style: statValue }, String(toolTotal)),
              createElement('span', { style: statLabel }, '工具呼叫')),
            createElement('div', { style: stat },
              createElement('span', { style: { ...statValue, ...errColor } }, String(wire.errors)),
              createElement('span', { style: statLabel }, '失敗')),
            createElement('div', { style: stat },
              createElement('span', { style: statValue }, String(skillTotal)),
              createElement('span', { style: statLabel }, '技能使用'))),
        ))
      } else {
        dataSections.push(createElement('div', { key: 'stats', style: card },
          createElement('div', { style: cardTitle }, '概覽'),
          createElement('div', { style: emptyText }, 'infraView 投影未就緒…')))
      }

      // ── 檔案活動(view-perspectives 投影;缺席時降級)──
      if (fileWire !== undefined) {
        const files: any[] = Array.isArray(fileWire.files) ? fileWire.files : []
        let fileErr = 0
        let writes = 0
        for (const f of files) {
          fileErr += f.err
          writes += f.writes + f.edits
        }
        badgeState.obs = files.length + (mechWire && Array.isArray(mechWire.items) ? mechWire.items.length : 0)
        badgeState.obsErr = fileErr
        const fileRows = files.slice(0, 12).map((f: any) => {
          const ops: ReactNode[] = []
          if (f.reads > 0) ops.push(createElement('span', { key: 'r', style: badge }, `讀 ${f.reads}`))
          if (f.writes > 0) ops.push(createElement('span', { key: 'w', style: { ...badge, ...brandColor } }, `寫 ${f.writes}`))
          if (f.edits > 0) ops.push(createElement('span', { key: 'e', style: { ...badge, ...brandColor } }, `改 ${f.edits}`))
          if (f.searches > 0) ops.push(createElement('span', { key: 's', style: badge }, `搜 ${f.searches}`))
          return createElement('div', { key: f.path, style: row },
            createElement('span', { style: pathCell, title: f.path }, f.path),
            ops.length > 0 ? createElement('span', { style: { display: 'flex', gap: 4, flex: 'none' } }, ops) : null,
            createElement('span', { style: f.lastOk ? okColor : errColor, flex: 'none' }, f.lastOk ? '✓' : '✗'))
        })
        dataSections.push(createElement('div', { key: 'files', style: card },
          createElement('div', { style: cardTitle }, `檔案活動(${files.length} 個檔案 · 寫入/編輯 ${writes} · 失敗 ${fileErr})`),
          files.length === 0
            ? createElement('div', { style: emptyText }, '尚無檔案活動——讓模型呼叫 read / write / edit / glob / grep 即可在此看到')
            : fileRows))
      }

      // ── 機制事件(view-perspectives 投影;缺席時降級)──
      if (mechWire !== undefined) {
        const mechItems: any[] = Array.isArray(mechWire.items) ? mechWire.items : []
        const countMap: Record<string, number> = {}
        for (const it of mechItems) {
          const short = TYPE_SHORT[it.type] || it.type
          countMap[short] = (countMap[short] || 0) + 1
        }
        const countCells = Object.keys(countMap).map((k) =>
          createElement('div', { key: k, style: stat }, createElement('span', { style: statValue }, String(countMap[k])), createElement('span', { style: statLabel }, k)))
        const rows = mechItems.slice(-15).reverse().map((it: any) => {
          const short = TYPE_SHORT[it.type] || it.type
          const tone = mechTone(it.type)
          const toneBadge = tone === 'brand' ? brandBadge : tone === 'warn' ? warnBadge : tone === 'business' ? businessBadge : neutralBadge
          return createElement('div', { key: String(it.seq), style: row },
            createElement('span', { style: toneBadge }, short),
            createElement('span', { style: textCell, title: it.text }, it.text === '' ? it.type : it.text))
        })
        dataSections.push(createElement('div', { key: 'mech', style: card },
          createElement('div', { style: cardTitle }, `機制事件(${mechItems.length})`),
          countCells.length > 0 ? createElement('div', { style: { marginBottom: 8 } }, createElement('div', { style: statsRow }, countCells)) : null,
          mechItems.length === 0
            ? createElement('div', { style: emptyText }, '尚無機制事件——goal / todo / plan / sandbox / approval / compaction / command 活動會出現在這裡')
            : rows))
      }

      // ── 工具/技能 TOP(純數據,置底區)──
      if (wire) {
        dataSections.push(createElement('div', { key: 'tools', style: card },
          createElement('div', { style: cardTitle }, `工具 TOP ${Math.min(wire.tools.length, 10)}`),
          ...(wire.tools.length === 0
            ? [createElement('div', { key: 'none', style: { color: 'var(--dsw-alias-label-secondary)' } }, '尚無工具呼叫')]
            : wire.tools.slice(0, 10).map(itemRow)),
        ))
        dataSections.push(createElement('div', { key: 'skills', style: card },
          createElement('div', { style: cardTitle }, `技能 TOP ${Math.min(wire.skills.length, 8)}`),
          ...(wire.skills.length === 0
            ? [createElement('div', { key: 'none', style: { color: 'var(--dsw-alias-label-secondary)' } }, '尚無技能使用')]
            : wire.skills.slice(0, 8).map(itemRow)),
        ))
      }

      // ── 最近執行 ──
      if (wire) {
        dataSections.push(createElement('div', { key: 'recent', style: card },
          createElement('div', { style: cardTitle }, '最近執行'),
          ...(wire.recent.length === 0
            ? [createElement('div', { key: 'none', style: { color: 'var(--dsw-alias-label-secondary)' } }, '尚無執行記錄')]
            : wire.recent.slice().reverse().map(recentRow)),
        ))
      }

      return createElement('div', { style: page }, ...textSections, ...dataSections)
    },
  ))
}


