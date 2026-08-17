/**
 * dsh-insights · 洞察/筆記視圖(原 @bryan-cmf/dsh-view-perspectives client)。
 *
 * 「洞察」視圖(conversation.view, id 'insights', order 40):
 * 掃描洞察(insightsScan:工具失敗/用戶糾正/壓縮/無產出等)+ 價值錨點
 * (shipped `goal` 投影)+ 任務進度(shipped `todos` 投影)+ 風險掃描。
 * 重要性 ≥2 的洞察由 host 自動寫入記憶,視圖標記 ✓已存。
 *
 * 提醒條(conversation.input.dock, id 'insight-hint', order 30):
 * composer 上方常駐提醒欄——最新重要性 ≥2 洞察即時可見,‼級警示色。
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
  inputActions?: { setDraft?: (text: string) => void }
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 20px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' }
const card: CSSProperties = { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: '12px 14px' }
const cardTitle: CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-secondary)' }
const statsRow: CSSProperties = { display: 'flex', gap: 16, flexWrap: 'wrap' }
const stat: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const statValue: CSSProperties = { fontSize: 20, fontWeight: 700 }
const statLabel: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }
const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' }
const errColor: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const brandColor: CSSProperties = { color: 'var(--dsw-alias-brand-primary)' }
const warnColor: CSSProperties = { color: 'var(--dsw-alias-state-warn-label)' }
const badge: CSSProperties = { fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', flex: 'none' }
const sendBtnSmall: CSSProperties = { borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)', background: 'transparent', padding: '4px 10px', fontSize: 11, cursor: 'pointer', flex: 'none' }
const actionBtn: CSSProperties = { fontSize: 11, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', padding: '2px 8px', cursor: 'pointer', marginTop: 6 }
const textInput: CSSProperties = { flex: 1, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '6px 9px', fontSize: 12, fontFamily: 'inherit' }
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }

const KIND_META: Record<string, { label: string; color: CSSProperties; badge: CSSProperties }> = {
  risk: {
    label: '風險',
    color: errColor,
    badge: { ...badge, color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
  },
  signal: {
    label: '訊號',
    color: warnColor,
    badge: { ...badge, color: 'var(--dsw-alias-state-warn-label)', borderColor: 'var(--dsw-alias-state-warn-label)' },
  },
  progress: {
    label: '進展',
    color: brandColor,
    badge: { ...badge, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' },
  },
}

// ── 洞察視圖 ─────────────────────────────────────────────────────────────────

// ── 洞察視圖(全面服務於價值、路徑與發展方向)────────────────────────────────
// 用戶反饋:掃描洞察與風險/攔截數據對他沒有意義——踩坑捕捉轉為後台靜默進記憶
// (標籤 踩坑,host 側 foldScan/saver 照舊),頁面只留價值/方向/潛力內容。

interface PathItem { name: string; value: string; effort: string; firstStep: string }
interface ObsLite { insight?: string; topic?: string; milestones?: Array<{ seq: number; kind: string; title: string; why: string }>; summary?: string; paths?: PathItem[] }

const effortColor: Record<string, CSSProperties> = {
  小: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' },
  中: { color: 'var(--dsw-alias-state-warn-label)', borderColor: 'var(--dsw-alias-state-warn-label)' },
  大: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' },
}

function InsightsView(props: ViewProps): ReactNode {
  const goal = props.useProjection ? (props.useProjection('goal') as any) : undefined
  const todos = props.useProjection ? (props.useProjection('todos') as any) : undefined
  const infra = props.useProjection ? (props.useProjection('infraView') as any) : undefined
  const turns: number = infra && infra.turns && typeof infra.turns.ended === 'number' ? infra.turns.ended : 0

  const [summary, setSummary] = useState('')
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [obs, setObs] = useState<ObsLite>({})
  const [paths, setPaths] = useState<PathItem[]>([])
  const [pathsBusy, setPathsBusy] = useState(false)
  const [adopted, setAdopted] = useState<Record<string, boolean>>({})
  const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
  const canDraft = props.inputActions && typeof props.inputActions.setDraft === 'function'
  const setDraft = (text: string): void => { if (canDraft) props.inputActions!.setDraft!(text) }

  // 自動洞察 + 里程碑(觀測域;回合結束自動刷新)
  useEffect(() => {
    if (sid === '') return
    let cancelled = false
    fetch(`/api/observation?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: ObsLite) => {
        if (cancelled) return
        setObs({
          insight: typeof d.insight === 'string' ? d.insight : '',
          topic: typeof d.topic === 'string' ? d.topic : '',
          milestones: Array.isArray(d.milestones) ? d.milestones : [],
        })
        // 生成物持久化還原:價值總結與潛力路徑切頁不丟,直到下次生成覆寫
        if (typeof d.summary === 'string' && d.summary !== '') setSummary(d.summary)
        if (Array.isArray(d.paths) && d.paths.length > 0) setPaths(d.paths)
      })
      .catch(() => { /* 靜默 */ })
    return () => { cancelled = true }
  }, [sid, turns])

  function genSummary(): void {
    if (sid === '' || summaryBusy) return
    setSummaryBusy(true)
    fetch('/api/insight/summary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
      .then((r) => r.json())
      .then((d: { summary?: string; error?: string }) => {
        setSummary(typeof d.summary === 'string' && d.summary !== '' ? d.summary : `(${d.error || '生成失敗'})`)
      })
      .catch((e) => setSummary(`(呼叫失敗: ${String(e)})`))
      .finally(() => setSummaryBusy(false))
  }

  function genPaths(): void {
    if (sid === '' || pathsBusy) return
    setPathsBusy(true)
    fetch('/api/insight/paths', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
      .then((r) => r.json())
      .then((d: { paths?: PathItem[]; error?: string }) => {
        if (Array.isArray(d.paths)) setPaths(d.paths)
        else if (typeof d.error === 'string') setPaths([{ name: '(生成失敗)', value: d.error, effort: '中', firstStep: '' }])
      })
      .catch((e) => setPaths([{ name: '(呼叫失敗)', value: String(e), effort: '中', firstStep: '' }]))
      .finally(() => setPathsBusy(false))
  }

  function adoptPath(p: PathItem): void {
    if (sid === '') return
    fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, action: 'add-todo', content: `${p.name}:${p.firstStep}`, source: 'auto' }),
    })
      .then(() => setAdopted({ ...adopted, [p.name]: true }))
      .catch(() => { /* 靜默 */ })
  }

  // ── 價值錨點:目標 + 任務(純價值錨,不再放數據統計)──
  const goalSnap = goal && goal.goal ? goal.goal : null
  const goalText = goalSnap && typeof goalSnap.objective === 'string' ? goalSnap.objective : ''
  const goalPhase = goalSnap && typeof goalSnap.phase === 'string' ? goalSnap.phase : ''
  const todoList = todos && Array.isArray(todos) ? todos : []
  const todoDone = todoList.filter((t: any) => t.status === 'completed').length
  const todoTotal = todoList.length
  const todoActive = todoList.filter((t: any) => t.status === 'in_progress').length

  const anchors: ReactNode[] = [
    goalText !== ''
      ? createElement('div', { key: 'g', style: { ...stat, maxWidth: 360, minWidth: 200 } },
          createElement('span', { style: { ...statValue, ...brandColor, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, goalText),
          createElement('span', { style: statLabel }, `目前價值目標(${goalPhase})`))
      : createElement('div', { key: 'g', style: stat },
          createElement('span', { style: { ...statValue, fontSize: 15 } }, '—'),
          createElement('span', { style: statLabel }, '目前價值目標(未建立——用 /goal 錨定)')),
  ]
  if (todoTotal > 0) {
    anchors.push(createElement('div', { key: 'td', style: stat },
      createElement('span', { style: statValue }, `${todoDone}/${todoTotal}`),
      createElement('span', { style: statLabel }, `任務完成(進行中 ${todoActive})`)))
  }

  // ── 方向演變:從里程碑提煉方向類事件(零額外 LLM 成本)──
  const DIR_KINDS = ['目標建立', '方向轉變', '突破', '首次成功']
  const dirMilestones = (Array.isArray(obs.milestones) ? obs.milestones : []).filter((m) => DIR_KINDS.indexOf(m.kind) !== -1)

  const autoInsight = typeof obs.insight === 'string' ? obs.insight : ''

  return createElement('div', { style: page },
    // 價值錨點
    createElement('div', { style: card }, createElement('div', { style: cardTitle }, '價值錨點'), createElement('div', { style: statsRow }, anchors)),
    // 自動洞察(每 5 輪)
    autoInsight !== ''
      ? createElement('div', { style: card },
          createElement('div', { style: cardTitle }, '自動洞察(每 5 輪更新)'),
          createElement('div', { style: { lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, autoInsight),
          canDraft ? createElement('button', { style: actionBtn, onClick: () => setDraft(autoInsight) }, '⤴ 傳送到主對話框') : null)
      : null,
    // 價值總結卡
    createElement('div', { style: card },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, '價值總結卡'),
        createElement('button', { style: sendBtnSmall, onClick: genSummary, disabled: summaryBusy }, summaryBusy ? '生成中…' : '生成本 session 價值總結')),
      summary !== ''
        ? createElement('div', { style: { marginTop: 8 } },
            createElement('div', { style: { lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, summary),
            canDraft ? createElement('button', { style: actionBtn, onClick: () => setDraft(summary) }, '⤴ 傳送到主對話框') : null)
        : createElement('div', { style: { ...emptyText, marginTop: 6, fontSize: 11 } }, '一鍵生成本 session 的價值總結(可貼進週報/匯報,或傳送到主對話框變成新指令)。')),
    // 方向演變時間線
    dirMilestones.length > 0
      ? createElement('div', { style: card },
          createElement('div', { style: cardTitle }, `方向演變(${dirMilestones.length})`),
          dirMilestones.map((m) =>
            createElement('div', { key: `${m.seq}-${m.title}`, style: row },
              createElement('span', { style: { ...badge, ...brandColor } }, m.kind),
              createElement('span', { style: { flex: 1, minWidth: 0 } },
                createElement('div', { style: { fontWeight: 600 } }, m.title),
                m.why !== '' ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, m.why) : null))),
          obs.topic !== undefined && obs.topic !== ''
            ? createElement('div', { style: { ...emptyText, marginTop: 6, fontSize: 11 } }, `當前主題:${obs.topic}`)
            : null)
      : null,
    // 潛力路徑生成器
    createElement('div', { style: card },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, '潛力路徑'),
        createElement('button', { style: sendBtnSmall, onClick: genPaths, disabled: pathsBusy }, pathsBusy ? '推演中…' : paths.length > 0 ? '重新推演' : '生成潛力路徑')),
      paths.length === 0
        ? createElement('div', { style: { ...emptyText, marginTop: 6, fontSize: 11 } }, '基於觀測敘事與里程碑,推演 2–3 條有價值的展開路徑(價值/成本/第一步),可採納為待辦或傳到主對話框。')
        : createElement('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
            paths.map((p) =>
              createElement('div', { key: p.name, style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px' } },
                createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                  createElement('span', { style: { fontWeight: 700, flex: 1, minWidth: 0 } }, p.name),
                  createElement('span', { style: { ...badge, ...(effortColor[p.effort] || {}) } }, `成本 ${p.effort}`)),
                p.value !== '' ? createElement('div', { style: { lineHeight: 1.5, fontSize: 12 } }, p.value) : null,
                p.firstStep !== '' ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } }, `第一步:${p.firstStep}`) : null,
                createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  canDraft ? createElement('button', { style: actionBtn, onClick: () => setDraft(`【潛力路徑】${p.name}\n${p.firstStep}`) }, '⤴ 傳到主對話框') : null,
                  createElement('button', { style: actionBtn, onClick: () => adoptPath(p), disabled: adopted[p.name] === true }, adopted[p.name] === true ? '✓ 已採納' : '＋採納為待辦')))))))
}

// ── 提醒條(conversation.input.dock)────────────────────────────────────────────

const hintBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden',
}
const hintBarCollapsed: CSSProperties = {
  ...hintBar,
  width: 'auto',
  marginLeft: 'auto',
  cursor: 'pointer',
}
const collapseBtn: CSSProperties = {
  flex: 'none',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '0 2px',
  userSelect: 'none',
}

function InsightHintBar(props: ViewProps): ReactNode {
  const scan = props.useProjection ? (props.useProjection('insightsScan') as any) : undefined
  const goal = props.useProjection ? (props.useProjection('goal') as any) : undefined
  const [collapsed, setCollapsed] = useState(false)
  const [dismissedSeq, setDismissedSeq] = useState(0)
  const items = scan && Array.isArray(scan.items) ? scan.items : []
  let latest: any = null
  let urgent = false
  let important = 0
  for (const it of items) {
    if (it.importance >= 2) {
      important += 1
      latest = it
      if (it.importance >= 3) urgent = true
    }
  }
  // 新的重要性 ≥2 洞察到達時自動重新浮出(不受上次收縮影響)
  const latestSeq = latest ? latest.seq : 0
  useEffect(() => {
    if (latestSeq > dismissedSeq) setCollapsed(false)
  }, [latestSeq, dismissedSeq])
  if (scan === undefined || latest === null) return null
  const meta = KIND_META[latest.kind] || KIND_META.progress
  if (collapsed) {
    return createElement('div', {
      style: hintBarCollapsed,
      title: '點擊展開洞察提醒',
      onClick: () => setCollapsed(false),
    },
      createElement('span', { style: meta.badge }, urgent ? '洞察 ‼' : '洞察 !'),
      createElement('span', { style: { ...badge, color: 'var(--dsw-alias-label-tertiary)' } }, `!${important}`),
      createElement('span', { style: collapseBtn }, '▸'))
  }
  const goalSnap = goal && goal.goal ? goal.goal : null
  return createElement('div', { style: hintBar },
    createElement('span', { style: meta.badge }, urgent ? '洞察 ‼' : '洞察 !'),
    createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(urgent ? meta.color : {}) }, title: latest.text }, latest.text),
    goalSnap !== null ? createElement('span', { style: { ...badge, color: 'var(--dsw-alias-label-tertiary)' }, title: goalSnap.objective }, `目標:${goalSnap.objective.slice(0, 12)}`) : null,
    createElement('span', { style: { ...badge, color: 'var(--dsw-alias-label-tertiary)' } }, `!${important}`),
    createElement('span', {
      style: collapseBtn,
      title: '收縮提醒條(新洞察到達時會自動重新浮出)',
      onClick: () => {
        setDismissedSeq(latestSeq)
        setCollapsed(true)
      },
    }, '▾'))
}

// ── 筆記/待辦視圖(手寫筆記 + 手寫/自動待辦,per-session 持久化)─────────────

interface NoteItem { seq: number; text: string; createdAt: number }
interface TodoItem { seq: number; content: string; done: boolean; createdAt: number; source: string }
interface NotesPayload { notes?: NoteItem[]; todos?: TodoItem[] }

function NotesView(props: ViewProps): ReactNode {
  const sid = typeof props.sessionId === 'string' ? props.sessionId : ''
  const [data, setData] = useState<NotesPayload | null>(null)
  const [suggested, setSuggested] = useState<Array<{ content: string; why: string }>>([])
  const [noteText, setNoteText] = useState('')
  const [todoText, setTodoText] = useState('')
  // 自動刷新(P2-12):觀測建議待辦在 turn/end 更新——用回合數投影做精確觸發,
  // 30s 計時輪詢兜底(投影缺席或無機制事件的 session 仍會刷新)。
  const infra = props.useProjection ? (props.useProjection('infraView') as any) : undefined
  const turnsEnded: number = infra && infra.turns && typeof infra.turns.ended === 'number' ? infra.turns.ended : 0

  function refresh(): void {
    if (sid === '') return
    fetch(`/api/notes?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: NotesPayload) => setData(d))
      .catch(() => { /* 靜默 */ })
    fetch(`/api/observation?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: { suggestedTodos?: Array<{ content: string; why: string }> }) => {
        setSuggested(Array.isArray(d.suggestedTodos) ? d.suggestedTodos : [])
      })
      .catch(() => { /* 靜默 */ })
  }
  useEffect(() => { refresh() }, [sid, turnsEnded])
  useEffect(() => {
    if (sid === '') return
    const timer = setInterval(() => refresh(), 30000)
    return () => clearInterval(timer)
  }, [sid])

  async function post(action: string, payload: Record<string, unknown>): Promise<void> {
    if (sid === '') return
    try {
      const resp = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, action, ...payload }),
      })
      const d = (await resp.json()) as NotesPayload
      setData(d)
    } catch {
      // 靜默
    }
  }

  const todos = data && Array.isArray(data.todos) ? data.todos : []
  const notes = data && Array.isArray(data.notes) ? data.notes : []
  const adopted = new Set(todos.map((t) => t.content))
  const pendingSuggested = suggested.filter((s) => !adopted.has(s.content))

  const todoRows = todos.slice().reverse().map((t) =>
    createElement('div', { key: String(t.seq), style: row },
      createElement('span', {
        style: { cursor: 'pointer', flex: 'none', fontSize: 14, color: t.done ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' },
        title: t.done ? '標記未完成' : '標記完成',
        onClick: () => void post('toggle-todo', { seq: t.seq }),
      }, t.done ? '☑' : '☐'),
      createElement('span', { style: { flex: 1, minWidth: 0, ...(t.done ? { textDecoration: 'line-through', color: 'var(--dsw-alias-label-tertiary)' } : {}) } }, t.content),
      t.source === 'auto' ? createElement('span', { style: badge }, '自動') : null,
      createElement('span', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' }, title: '刪除', onClick: () => void post('delete-todo', { seq: t.seq }) }, '✕')))

  const noteRows = notes.slice().reverse().map((n) =>
    createElement('div', { key: String(n.seq), style: row },
      createElement('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, n.text),
      createElement('span', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' }, title: '刪除', onClick: () => void post('delete-note', { seq: n.seq }) }, '✕')))

  return createElement('div', { style: page },
    pendingSuggested.length > 0
      ? createElement('div', { style: card },
          createElement('div', { style: cardTitle }, '建議待辦(觀測智能體生成)'),
          pendingSuggested.map((s, i) =>
            createElement('div', { key: String(i), style: row },
              createElement('span', { style: { flex: 1, minWidth: 0 } },
                createElement('div', null, s.content),
                s.why !== '' ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, s.why) : null),
              createElement('button', { style: sendBtnSmall, onClick: () => void post('add-todo', { content: s.content, source: 'auto' }) }, '採納'))))
      : null,
    createElement('div', { style: card },
      createElement('div', { style: cardTitle }, `待辦(${todos.filter((t) => !t.done).length} 未完成 / ${todos.length} 總計)`),
      todos.length === 0 ? createElement('div', { style: emptyText }, '尚無待辦——手寫一條,或等觀測智能體生成建議。') : todoRows,
      createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
        createElement('input', {
          style: textInput,
          placeholder: '新增待辦…(Enter 送出)',
          value: todoText,
          onChange: (e: { target: { value: string } }) => setTodoText(e.target.value),
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === 'Enter' && todoText.trim() !== '') {
              e.preventDefault()
              void post('add-todo', { content: todoText.trim(), source: 'user' })
              setTodoText('')
            }
          },
        }),
        createElement('button', { style: sendBtnSmall, onClick: () => { if (todoText.trim() !== '') { void post('add-todo', { content: todoText.trim(), source: 'user' }); setTodoText('') } } }, '新增'))),
    createElement('div', { style: card },
      createElement('div', { style: cardTitle }, `筆記(${notes.length})`),
      notes.length === 0 ? createElement('div', { style: emptyText }, '尚無筆記——把想法、卡點、靈感記在這裡,per-session 持久。') : noteRows,
      createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
        createElement('input', {
          style: textInput,
          placeholder: '寫一條筆記…(Enter 送出)',
          value: noteText,
          onChange: (e: { target: { value: string } }) => setNoteText(e.target.value),
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === 'Enter' && noteText.trim() !== '') {
              e.preventDefault()
              void post('add-note', { text: noteText.trim() })
              setNoteText('')
            }
          },
        }),
        createElement('button', { style: sendBtnSmall, onClick: () => { if (noteText.trim() !== '') { void post('add-note', { text: noteText.trim() }); setNoteText('') } } }, '新增'))))
}

export function applyPerspectivesViews(ctx: ClientCtx): void {
  const registerSafe = (registration: unknown, component: unknown): void => {
    try {
      ctx.slots.register(registration, component)
    } catch {
      // 靜默降級:該視圖/提醒條不出現,其餘照常。
    }
  }
  ctx.slots.inject('conversation.view', () => registerSafe(
    { name: 'conversation.view', id: 'insights', order: 40, label: '洞察' },
    InsightsView,
  ))
  ctx.slots.inject('conversation.view', () => registerSafe(
    { name: 'conversation.view', id: 'notes', order: 50, label: '筆記' },
    NotesView,
  ))
  // 提示詞優化器:composer 工具列按鈕,把草稿結構化後寫回
  ctx.slots.inject('conversation.input.left', () => registerSafe(
    { name: 'conversation.input.left', id: 'prompt-optimizer', order: 100, label: '優化' },
    PromptOptimizerButton,
  ))
}

// ── 提示詞優化器按鈕(conversation.input.left)─────────────────────────────────

const optBtn: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flex: 'none',
}

interface InputProps {
  useInput?: <S>(sel: (s: { draft?: string }) => S, eq?: (a: S, b: S) => boolean) => S
  inputActions?: { setDraft?: (text: string) => void }
}

function PromptOptimizerButton(props: InputProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')

  // hooks 只能在 render 期呼叫;SnapshotSelectorHook 必須傳 selector 函數(無零參數形態)
  const inputState = props.useInput
    ? (props.useInput((s: { draft?: string }) => (s && typeof s.draft === 'string' ? s.draft : '')) as string)
    : ''
  const draft = typeof inputState === 'string' ? inputState : ''

  useEffect(() => {
    if (flash === '') return
    const t = setTimeout(() => setFlash(''), 2500)
    return () => clearTimeout(t)
  }, [flash])

  function optimize(): void {
    if (busy) return
    if (draft.trim() === '') {
      setFlash('先輸入內容')
      return
    }
    setBusy(true)
    fetch('/api/prompt/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    })
      .then((r) => r.json())
      .then((d: { optimized?: string; error?: string }) => {
        if (typeof d.optimized === 'string' && d.optimized !== '') {
          if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
            props.inputActions.setDraft(d.optimized)
            setFlash('✓ 已優化')
          } else {
            setFlash('無法寫回')
          }
        } else {
          setFlash(d.error || '優化失敗')
        }
      })
      .catch((e) => setFlash(`失敗: ${String(e && (e as Error).message ? (e as Error).message : e)}`))
      .finally(() => setBusy(false))
  }

  return createElement('button', {
    style: { ...optBtn, ...(busy ? { color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } : {}) },
    title: '把草稿結構化(背景→目標→要求→期望輸出),讓智能體更清晰理解',
    onClick: optimize,
    disabled: busy,
  }, busy ? '優化中…' : flash !== '' ? flash : '✨ 優化')
}


