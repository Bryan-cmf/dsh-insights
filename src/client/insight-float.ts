/**
 * dsh-insights · 洞察浮窗(原 @bryan-cmf/dsh-insight-agent client)。
 *
 * 右下角浮動對話框(shell.overlay FAB + 面板):
 * - 對話按 sessionId 隔離(每個項目獨立)
 * - 「深思過程 ▸」永遠顯示(無推理時明說)
 * - 「⤴ 傳送建議」只送【建議】段落(無建議退回全文)
 * - LLM 呼叫走 /api/insight/chat(host webServer 路由)
 *
 * 隱形橋接條目(conversation.input.dock,渲染 null):
 * 把 session 投影(goal/todos/insightsScan/fileActivity/mechEvents)
 * 與 inputActions/sessionId 橋接到模組狀態。
 */
import { createElement, useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react'

interface SlotsService {
  inject(key: string, fn: () => unknown): unknown
  register(registration: unknown, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
}
interface ViewProps {
  useProjection?: <K extends string>(key: K) => unknown
  inputActions?: { setDraft?: (text: string) => void }
  sessionId?: string
}

const chatStates: Record<string, { messages: Array<{ role: string; text: string; thinking: string }>; busy: boolean }> = {}
const bridge: {
  goal: unknown
  todos: unknown
  scan: unknown
  file: unknown
  mech: unknown
  inputActions: ViewProps['inputActions']
  sessionId: string | undefined
} = { goal: undefined, todos: undefined, scan: undefined, file: undefined, mech: undefined, inputActions: undefined, sessionId: undefined }
// FAB 位置:可拖動,localStorage 持久(刷新/重啟後保持)
const FAB_KEY = 'dsh-insights-fab-pos'
const FAB_SIZE = 52
const PANEL_W = 380
const PANEL_H = 480

function loadFabPos(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(FAB_KEY)
    if (raw !== null) {
      const p = JSON.parse(raw) as { left?: unknown; top?: unknown }
      if (typeof p.left === 'number' && typeof p.top === 'number') return { left: p.left, top: p.top }
    }
  } catch {
    // ignore
  }
  return null
}
function saveFabPos(p: { left: number; top: number }): void {
  try {
    window.localStorage.setItem(FAB_KEY, JSON.stringify(p))
  } catch {
    // ignore
  }
}

const uiState = { expanded: false, fabPos: loadFabPos() }
/** 已從 host 還原過歷史的 session(避免重複 fetch) */
const loadedSids: Record<string, boolean> = {}

function stateOf(sid: string | undefined) {
  const key = typeof sid === 'string' && sid !== '' ? sid : '_default'
  if (chatStates[key] === undefined) chatStates[key] = { messages: [], busy: false }
  return chatStates[key]
}

const badge: CSSProperties = { fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', flex: 'none' }
const emptyText: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 }
const fab: CSSProperties = {
  position: 'fixed', right: 24, bottom: 120, zIndex: 60,
  width: 52, height: 52, borderRadius: '50%',
  // 夜間模式修復:--dsw-alias-brand-primary 在 dark theme 是近白(neutral-bluish-50),
  // 而 --dsw-alias-label-on-brand 未定義 → 白字白底隱形。改用雙模式都是品牌藍的
  // state-business-primary(deepseek-400/500)+ 白字,兩模式皆可讀。
  background: 'var(--dsw-alias-state-business-primary)', color: '#fff',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.25))',
  fontSize: 11, fontWeight: 700, userSelect: 'none', pointerEvents: 'auto',
}
const panel: CSSProperties = {
  position: 'fixed', right: 24, bottom: 120, zIndex: 60,
  width: 380, maxWidth: 'calc(100vw - 48px)', height: 480, maxHeight: 'calc(100vh - 160px)',
  background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 12, boxShadow: 'var(--dsw-shadow-lv2, 0 8px 32px rgba(0,0,0,.3))',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto',
}

// 動態位置:FAB 拖到哪面板跟到哪(仍在視口內)
function fabStyle(): CSSProperties {
  if (uiState.fabPos === null) return fab
  const left = Math.min(Math.max(0, uiState.fabPos.left), window.innerWidth - FAB_SIZE - 4)
  const top = Math.min(Math.max(0, uiState.fabPos.top), window.innerHeight - FAB_SIZE - 4)
  return { ...fab, right: 'auto', bottom: 'auto', left, top }
}
function panelStyle(): CSSProperties {
  if (uiState.fabPos === null) return panel
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(Math.max(8, uiState.fabPos.left + FAB_SIZE / 2 - PANEL_W / 2), Math.max(8, vw - PANEL_W - 8))
  // FAB 在螢幕上半 → 面板往下開;下半 → 往上開
  const below = uiState.fabPos.top < vh / 2
  let top = below ? uiState.fabPos.top + FAB_SIZE + 8 : uiState.fabPos.top - PANEL_H - 8
  top = Math.min(Math.max(8, top), Math.max(8, vh - PANEL_H - 8))
  return { ...panel, right: 'auto', bottom: 'auto', left, top }
}
const panelHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: 'none' }
const headBtn: CSSProperties = { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', padding: '0 4px', userSelect: 'none', fontSize: 14, flex: 'none' }
const panelBody: CSSProperties = { flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }
const userBubble: CSSProperties = { alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-state-business-primary)', borderRadius: 10, padding: '6px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }
const aiBubble: CSSProperties = { alignSelf: 'flex-start', maxWidth: '94%', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 10, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, fontSize: 12, color: 'var(--dsw-alias-label-primary)' }
const thinkBlock: CSSProperties = { alignSelf: 'flex-start', maxWidth: '94%', borderLeft: '2px solid var(--dsw-alias-markdown-citation)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6, padding: '6px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }
const thinkToggle: CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', userSelect: 'none', fontWeight: 600 }
const inputRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-end', padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', flex: 'none' }
const textArea: CSSProperties = { flex: 1, resize: 'none', minHeight: 34, maxHeight: 80, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '7px 9px', fontSize: 12, fontFamily: 'inherit' }
const sendBtn: CSSProperties = { borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)', background: 'transparent', padding: '6px 12px', fontSize: 12, cursor: 'pointer', flex: 'none' }
const actionBtn: CSSProperties = { fontSize: 11, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', padding: '2px 8px', cursor: 'pointer', marginTop: 4 }

function InsightBridge(props: ViewProps): ReactNode {
  bridge.goal = props.useProjection ? props.useProjection('goal') : undefined
  bridge.todos = props.useProjection ? props.useProjection('todos') : undefined
  bridge.scan = props.useProjection ? props.useProjection('insightsScan') : undefined
  bridge.file = props.useProjection ? props.useProjection('fileActivity') : undefined
  bridge.mech = props.useProjection ? props.useProjection('mechEvents') : undefined
  bridge.inputActions = props.inputActions
  bridge.sessionId = props.sessionId
  return null
}

function extractSuggestion(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  const markers = ['【建議】', '【建议】']
  for (const marker of markers) {
    const idx = text.lastIndexOf(marker)
    if (idx !== -1) {
      const rest = text.slice(idx + marker.length).replace(/^[\s:：]+/, '').trim()
      if (rest !== '') return rest
    }
  }
  return ''
}

function buildContext(): string {
  const parts: string[] = []
  const goal = bridge.goal as any
  if (goal && goal.goal && typeof goal.goal.objective === 'string') {
    parts.push(`價值目標:「${goal.goal.objective}」(phase: ${String(goal.goal.phase)})`)
  } else {
    parts.push('價值目標:(未建立)')
  }
  const todos = bridge.todos as any
  if (Array.isArray(todos) && todos.length > 0) {
    const done = todos.filter((t: any) => t.status === 'completed').length
    const doing = todos.filter((t: any) => t.status === 'in_progress').map((t: any) => t.content).slice(0, 3)
    parts.push(`任務:${done}/${todos.length} 完成${doing.length > 0 ? `;進行中:${doing.join('、')}` : ''}`)
  }
  // 掃描洞察項不再併入 context(用戶反饋:錯誤類內容無助於價值/方向討論;
  // 觀測敘事已由 host 端 observation 域提供更完整的價值上下文)
  const file = bridge.file as any
  if (file && Array.isArray(file.files) && file.files.length > 0) {
    const tops = file.files.slice(0, 5).map((f: any) => `${f.path}(寫${f.writes}改${f.edits}${f.err > 0 ? ` ✗${f.err}` : ''})`)
    parts.push(`檔案活動 TOP5: ${tops.join('; ')}`)
  }
  const mech = bridge.mech as any
  const mechItems = mech && Array.isArray(mech.items) ? mech.items : []
  if (mechItems.length > 0) {
    const comp = mechItems.filter((i: any) => i.type === 'compaction/start').length
    const retry = mechItems.filter((i: any) => typeof i.type === 'string' && i.type.indexOf('llm/retry') === 0).length
    parts.push(`機制:事件 ${mechItems.length} 條;壓縮 ${comp} 次;LLM重試 ${retry} 次`)
  }
  return parts.join('\n')
}

async function askInsight(context: string, question: string, sessionId: string | undefined, history: Array<{ role: string; text: string }>): Promise<{ answer?: string; thinking?: string; error?: string }> {
  try {
    const resp = await fetch('/api/insight/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context, question, sessionId: sessionId ?? '', history }),
    })
    const data = (await resp.json()) as { answer?: string; thinking?: string; error?: string }
    return data
  } catch (e) {
    return { error: `呼叫失敗: ${String(e && (e as Error).message ? (e as Error).message : e)}` }
  }
}

function FloatingInsightChat(): ReactNode {
  const force = useReducer((n: number) => n + 1, 0)[1]
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [expandedThink, setExpandedThink] = useState(-1)

  const sid = bridge.sessionId
  const st = stateOf(sid)

  // 對話歷史還原(host 持久化,跨刷新/重啟):本地為空才載入,每個 session 一次
  useEffect(() => {
    if (typeof sid !== 'string' || sid === '') return
    if (st.messages.length > 0 || loadedSids[sid] === true) return
    loadedSids[sid] = true
    fetch(`/api/insight/chat?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((d: { messages?: Array<{ role: string; text: string; thinking?: string }> }) => {
        if (Array.isArray(d.messages) && d.messages.length > 0 && st.messages.length === 0) {
          for (const m of d.messages) {
            if (typeof m.text === 'string') st.messages.push({ role: m.role, text: m.text, thinking: typeof m.thinking === 'string' ? m.thinking : '' })
          }
          force()
        }
      })
      .catch(() => { /* 靜默 */ })
  }, [sid])

  function clearHistory(): void {
    if (typeof sid !== 'string' || sid === '') return
    fetch('/api/insight/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, action: 'clear' }),
    }).catch(() => { /* 靜默 */ })
    st.messages.splice(0, st.messages.length)
    force()
  }

  // 可拖動 FAB/面板頭:拖動改變錨點(存 localStorage);原地放開 = 點擊(展開面板)
  function startDrag(e: { target: unknown; currentTarget: unknown; clientX: number; clientY: number; preventDefault: () => void }): void {
    const t = e.target as { closest?: (sel: string) => unknown } | null
    if (t && typeof t.closest === 'function' && t.closest('[data-nodrag]') !== null) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMove = (ev: { clientX: number; clientY: number }): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return // 拖動閾值內 = 點擊
      moved = true
      uiState.fabPos = {
        left: Math.min(Math.max(0, rect.left + dx), window.innerWidth - FAB_SIZE - 4),
        top: Math.min(Math.max(0, rect.top + dy), window.innerHeight - FAB_SIZE - 4),
      }
      force()
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (moved) {
        if (uiState.fabPos !== null) saveFabPos(uiState.fabPos)
      } else {
        uiState.expanded = true
        force()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function send(): void {
    const el = inputRef.current
    const q = el && el.value ? el.value.trim() : ''
    if (q === '' || st.busy) return
    st.messages.push({ role: 'user', text: q, thinking: '' })
    if (st.messages.length > 60) st.messages.splice(0, st.messages.length - 60)
    st.busy = true
    if (el) el.value = ''
    force()
    const context = buildContext()
    // 帶上近期對話(不含剛推入的當前問題),讓回答有連續性
    const history = st.messages.slice(0, -1).slice(-10).map((m) => ({ role: m.role, text: m.text.slice(0, 800) }))
    void askInsight(context, q, sid, history).then((res) => {
      st.busy = false
      if (res && typeof res.answer === 'string' && res.answer !== '') {
        st.messages.push({ role: 'assistant', text: res.answer, thinking: typeof res.thinking === 'string' ? res.thinking : '' })
      } else if (res && typeof res.error === 'string') {
        st.messages.push({ role: 'assistant', text: `(錯誤) ${res.error}`, thinking: '' })
      } else {
        st.messages.push({ role: 'assistant', text: '(無回應)', thinking: '' })
      }
      force()
    })
  }

  function toComposer(text: string): void {
    if (bridge.inputActions && typeof bridge.inputActions.setDraft === 'function') {
      bridge.inputActions.setDraft(text)
    }
  }

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [st.messages.length, st.busy, sid])

  if (!uiState.expanded) {
    return createElement('div', {
      style: { ...fabStyle(), cursor: 'grab' },
      title: '洞察智能體——拖動到任意位置;點擊開啟對話',
      onMouseDown: startDrag,
    },
      createElement('span', null, '洞察'))
  }

  const bubbles = st.messages.map((m, idx) => {
    if (m.role === 'user') {
      return createElement('div', { key: String(idx), style: userBubble }, m.text)
    }
    const hasThink = typeof m.thinking === 'string' && m.thinking !== ''
    const thinkOpen = expandedThink === idx
    const suggestion = extractSuggestion(m.text)
    return createElement('div', { key: String(idx), style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 } },
      createElement('span', {
        style: thinkToggle,
        onClick: () => setExpandedThink(thinkOpen ? -1 : idx),
      }, thinkOpen ? '深思過程 ▾' : '深思過程 ▸'),
      thinkOpen ? createElement('div', { style: thinkBlock }, hasThink ? m.thinking : '(本次無深思輸出——模型未產生推理內容)') : null,
      createElement('div', { style: aiBubble }, m.text),
      createElement('button', { style: actionBtn, onClick: () => toComposer(suggestion !== '' ? suggestion : m.text) }, suggestion !== '' ? '⤴ 傳送建議' : '⤴ 傳送全文'))
  })

  const noSession = bridge.scan === undefined && bridge.inputActions === undefined

  return createElement('div', { style: panelStyle() },
    createElement('div', { style: { ...panelHead, cursor: 'grab' }, onMouseDown: startDrag, title: '拖動面板移動位置' },
      createElement('span', null, '洞察對話'),
      createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } }, '方向評估 · V4 flash 深思'),
      st.messages.length > 0
        ? createElement('span', { style: headBtn, title: '清空本 session 對話歷史(含持久存儲)', onClick: clearHistory, 'data-nodrag': '1' }, '🗑')
        : null,
      createElement('span', { style: headBtn, title: '收合', onClick: () => { uiState.expanded = false; force() }, 'data-nodrag': '1' }, '✕')),
    createElement('div', { style: panelBody, ref: bodyRef },
      noSession
        ? createElement('div', { style: emptyText }, '請先開啟一個 session,洞察智能體需要讀取該 session 的觀測資料。')
        : (st.messages.length === 0
          ? createElement('div', { style: emptyText }, '我會評估你的技術方向、預判能達到的成果,並反問你以定方向、定目標。試試:「我這個方向最後能做出什麼?」「目前的技術路線值不值得繼續?」「幫我把方向收斂成一條目標」')
          : bubbles),
      st.busy ? createElement('div', { style: { ...emptyText, fontSize: 11 } }, '洞察深思中…') : null),
    createElement('div', { style: inputRow },
      createElement('textarea', {
        ref: inputRef,
        style: textArea,
        placeholder: '問洞察…(Enter 送出)',
        onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        },
      }),
      createElement('button', { style: sendBtn, onClick: send, disabled: st.busy }, st.busy ? '…' : '送出')))
}

export function applyInsightFloat(ctx: ClientCtx): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'insight-fab', order: 0, label: '洞察' },
    FloatingInsightChat,
  ))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'insight-bridge', order: 99 },
    InsightBridge,
  ))
}


