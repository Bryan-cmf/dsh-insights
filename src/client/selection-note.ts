/**
 * dsh-insights · 選取文字 → 加到筆記(用戶 2026-09-19 需求)。
 *
 * 在對話(或頁面任何非輸入區域)選取文字後,選區旁浮出「加到筆記」按鈕;
 * 點擊即把選取內容寫進當前 session 的筆記(支援 Markdown,原樣保留換行)。
 *
 * 設計要點:
 * - 監聽 `selectionchange` + `pointerup`/`keyup`(滑鼠拖選、雙擊選詞、鍵盤選取全覆蓋)。
 * - 排除輸入框/可編輯區與本插件自身 UI(否則會干擾打字與按鈕點擊)。
 * - 按鈕以 position:fixed 定位在選區上方,貼近視口頂部時自動翻到下方。
 * - 按鈕 pointerdown 時 preventDefault,保住選區,否則按鈕會在點擊生效前消失。
 * - sessionId 由 conversation.input.dock 的隱形橋接傳入(overlay 槽位不帶該 prop)。
 * - 寫入走既有 /api/notes(add-note),成功後廣播事件讓筆記視圖即時刷新。
 */
import { createElement, useEffect, useReducer, type CSSProperties, type ReactNode } from 'react'

interface SlotsService {
  inject(key: string, fn: () => unknown): unknown
  register(registration: unknown, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
  effect?: (fn: () => (() => void) | void, label?: string) => unknown
}

interface ViewProps {
  sessionId?: string
  useProjection?: <K extends string>(key: K) => unknown
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const OWN_SELECTOR = '[data-dsh-insights-ui]'

/** 依賴注入:由 dock 橋接填入當前 sessionId。 */
const bridge: { sessionId: string } = { sessionId: '' }

/** 選區是否落在可輸入/可編輯區或本插件 UI 內(那些情況不該彈按鈕)。 */
function inExcluded(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : (node !== null ? node.parentElement : null)
  while (el !== null) {
    if (EDITABLE.has(el.tagName)) return true
    const ce = el.getAttribute('contenteditable')
    if (ce === 'true' || ce === '') return true
    if (typeof el.closest === 'function' && el.closest(OWN_SELECTOR) !== null) return true
    el = el.parentElement
  }
  return false
}

interface Pending { text: string; x: number; y: number }

const ui: { pending: Pending | null; flash: '' | 'saving' | 'ok' | 'err' } = { pending: null, flash: '' }
const listeners = new Set<() => void>()
function emit(): void {
  for (const fn of listeners) fn()
}
function useForce(): void {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const fn = (): void => force()
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
}

/** 讀當前選區:純文字 + 視口座標(多矩形選區取第一個)。 */
function currentSelection(): Pending | null {
  try {
    const sel = window.getSelection()
    if (sel === null || sel === undefined || sel.isCollapsed || sel.rangeCount === 0) return null
    const text = sel.toString()
    if (text.trim().length < 2) return null
    const range = sel.getRangeAt(0)
    if (inExcluded(range.startContainer) || inExcluded(range.endContainer)) return null
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { text: text.replace(/\s+$/, ''), x: Math.min(Math.max(80, rect.left + rect.width / 2), window.innerWidth - 80), y: rect.top }
  } catch {
    return null
  }
}

async function addNote(sessionId: string, text: string): Promise<boolean> {
  if (sessionId === '') return false
  try {
    const resp = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, action: 'add-note', text }),
    })
    const d = (await resp.json()) as { ok?: boolean }
    if (d !== null && d.ok === false) return false
    window.dispatchEvent(new CustomEvent('dsh-insights:note-added', { detail: { sessionId } }))
    return true
  } catch {
    return false
  }
}

const btn: CSSProperties = {
  position: 'fixed', zIndex: 70, transform: 'translateX(-50%)',
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.25))',
  fontSize: 12, fontWeight: 600, userSelect: 'none', touchAction: 'none',
}
const toast: CSSProperties = {
  position: 'fixed', zIndex: 70, left: '50%', bottom: 96, transform: 'translateX(-50%)',
  padding: '6px 12px', borderRadius: 8, fontSize: 12,
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.25))',
}

/** 隱形橋接:拿 sessionId(shell.overlay 槽位不帶此 prop)。 */
function SelectionNoteBridge(props: ViewProps): ReactNode {
  bridge.sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  return null
}

function SelectionNoteButton(): ReactNode {
  useForce()
  const p = ui.pending

  if (p === null) {
    if (ui.flash === 'ok') return createElement('div', { style: toast, 'data-dsh-insights-ui': '1' }, '✓ 已加到筆記')
    if (ui.flash === 'err') return createElement('div', { style: toast, 'data-dsh-insights-ui': '1' }, '✗ 加入失敗——請先開啟一個 session')
    return null
  }

  const saving = ui.flash === 'saving'
  return createElement('div', {
    style: { ...btn, left: p.x, top: p.y > 56 ? p.y - 40 : p.y + 24, opacity: saving ? 0.6 : 1 },
    'data-dsh-insights-ui': '1',
    title: '把選取的文字存進本 session 的筆記(支援 Markdown)',
    // 保住選區:否則 pointerdown 會清空 selection,按鈕在 click 前就消失
    onPointerDown: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault()
      e.stopPropagation()
    },
    onClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault()
      e.stopPropagation()
      if (saving) return
      const text = p.text
      ui.flash = 'saving'
      emit()
      void addNote(bridge.sessionId, text).then((ok) => {
        ui.flash = ok ? 'ok' : 'err'
        ui.pending = null
        try { window.getSelection()?.removeAllRanges() } catch { /* ignore */ }
        emit()
        window.setTimeout(() => {
          ui.flash = ''
          emit()
        }, 1800)
      })
    },
  },
    createElement('span', null, '＋'),
    createElement('span', null, saving ? '加入中…' : '加到筆記'),
  )
}

export function applySelectionToNote(ctx: ClientCtx): void {
  /** 掛載全局選取監聽(可逆)。 */
  const install = (): (() => void) => {
    let hideTimer: number | null = null

    const update = (e?: Event): void => {
      // 事件來自我們自己的按鈕:不更新(避免按下瞬間選區變動把按鈕抽掉)
      const target = e !== undefined && 'target' in e ? (e.target as Element | null) : null
      if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest(OWN_SELECTOR) !== null) return
      const next = currentSelection()
      if (next === null) {
        // 延遲清除:給 pointerdown → click 之間的選區保持留出餘裕
        if (hideTimer !== null) window.clearTimeout(hideTimer)
        hideTimer = window.setTimeout(() => {
          ui.pending = null
          emit()
        }, 150)
        return
      }
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
      const prev = ui.pending
      if (prev !== null && prev.text === next.text && Math.abs(prev.x - next.x) < 2 && Math.abs(prev.y - next.y) < 2) return
      ui.pending = next
      emit()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        ui.pending = null
        emit()
      }
    }

    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerup', update)
    document.addEventListener('pointercancel', update)
    document.addEventListener('keyup', update)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerup', update)
      document.removeEventListener('pointercancel', update)
      document.removeEventListener('keyup', update)
      document.removeEventListener('keydown', onKey)
      if (hideTimer !== null) window.clearTimeout(hideTimer)
      ui.pending = null
      listeners.clear()
    }
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'selection-note-bridge', order: 98 },
    SelectionNoteBridge,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'selection-note', order: 10, label: '選取加筆記' },
    SelectionNoteButton,
  ))
  if (typeof ctx.effect === 'function') ctx.effect(install, 'insights.selection-to-note')
  else install()
}
