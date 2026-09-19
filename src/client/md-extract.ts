/**
 * dsh-insights · 選區 DOM → Markdown 純函數(可測試,無 react / 無瀏覽器依賴)。
 *
 * 為什麼需要:對話是以 Markdown 渲染成 HTML 的,表格的「|」語法在 DOM 裡
 * 並不存在——`selection.toString()` 只會拿到「儲存格文字用 tab 併起來」的一行,
 * 貼進筆記就變成一段文字而不是表格(用戶 2026-09-19 回報)。
 * 因此改為走訪選區 DOM,依結構重建 Markdown:
 *   table → GFM 表格(表頭 + 分隔列)、pre → 圍欄程式碼、ul/ol → 清單、
 *   h1–h6 → #、行內 code/strong/em/a/del → 對應語法。
 *
 * 設計約束:
 * - 只依賴 nodeType / nodeValue / tagName / childNodes / getAttribute,不用
 *   querySelectorAll / closest,方便在 Node 端以極簡 DOM shim 做回歸測試。
 * - 型別以最小結構介面描述,DOM 的 Node / Range 可直接傳入(結構相容)。
 */

export interface DomNode {
  nodeType: number
  nodeValue?: string | null
  tagName?: string
  childNodes: ArrayLike<DomNode>
  parentElement?: DomNode | null
  getAttribute?: (name: string) => string | null
}

export interface DomRange {
  startContainer: DomNode
  endContainer: DomNode
  cloneContents(): DomNode
  intersectsNode(node: DomNode): boolean
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

function tagOf(node: DomNode): string {
  return typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
}

function children(node: DomNode): DomNode[] {
  const out: DomNode[] = []
  const list = node.childNodes
  for (let i = 0; i < list.length; i += 1) {
    const child = list[i]
    if (child !== undefined && child !== null) out.push(child)
  }
  return out
}

/** 深度優先收集子孫中符合 tag 集合的節點(不含自己)。 */
function descendants(node: DomNode, tags: string[]): DomNode[] {
  const out: DomNode[] = []
  const walk = (n: DomNode): void => {
    for (const child of children(n)) {
      if (child.nodeType === ELEMENT_NODE) {
        if (tags.includes(tagOf(child))) out.push(child)
        walk(child)
      }
    }
  }
  walk(node)
  return out
}

/** 節點純文字(遞迴,不依賴 textContent)。 */
export function textOf(node: DomNode): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
  let out = ''
  for (const child of children(node)) out += textOf(child)
  return out
}

/** 行內節點 → Markdown(保留 code / 粗體 / 斜體 / 連結 / 刪除線 / 換行)。 */
export function inlineMd(node: DomNode): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== ELEMENT_NODE) return ''
  const inner = children(node).map(inlineMd).join('')
  switch (tagOf(node)) {
    case 'CODE': return inner === '' ? '' : '`' + inner + '`'
    case 'STRONG':
    case 'B': return inner === '' ? '' : '**' + inner + '**'
    case 'EM':
    case 'I': return inner === '' ? '' : '*' + inner + '*'
    case 'DEL':
    case 'S': return inner === '' ? '' : '~~' + inner + '~~'
    case 'BR': return ' '
    case 'A': {
      const get = node.getAttribute
      const href = typeof get === 'function' ? (get.call(node, 'href') ?? '') : ''
      return href !== '' && inner !== '' ? `[${inner}](${href})` : inner
    }
    default: return inner
  }
}

/** 表格儲存格文字:壓平空白、逸出管線,避免破壞表格結構。 */
export function cellMd(cell: DomNode): string {
  return inlineMd(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/** 列集合 → GFM 表格(第一列當表頭,欄數不足補空)。 */
export function tableMd(rows: DomNode[][]): string {
  const clean = rows.filter((r) => r.length > 0)
  if (clean.length === 0) return ''
  const cols = Math.max(...clean.map((r) => r.length))
  const pad = (row: DomNode[]): string[] => {
    const cells = row.map(cellMd)
    while (cells.length < cols) cells.push('')
    return cells
  }
  const head = pad(clean[0] as DomNode[])
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const row of clean.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`)
  return lines.join('\n')
}

function isHeaderRow(tr: DomNode): boolean {
  const parent = tr.parentElement
  if (parent !== undefined && parent !== null && tagOf(parent) === 'THEAD') return true
  return descendants(tr, ['TH']).length > 0
}

/** 由真實表格 + 選區 → GFM 表格(表頭一律帶上,否則 GFM 渲染不出表格)。 */
export function tableFromRange(table: DomNode, range: DomRange): string {
  const trs = descendants(table, ['TR'])
  if (trs.length === 0) return ''
  const headerTr = trs.find((tr) => isHeaderRow(tr))
  let covered: DomNode[] = []
  try {
    covered = trs.filter((tr) => range.intersectsNode(tr))
  } catch {
    covered = []
  }
  const picked = covered.length > 0 ? covered : trs
  const rows: DomNode[][] = []
  // 選區沒框到表頭 → 補上,讓貼出去的表格仍有表頭
  if (headerTr !== undefined && !picked.includes(headerTr)) rows.push(descendants(headerTr, ['TH', 'TD']))
  for (const tr of picked) rows.push(descendants(tr, ['TH', 'TD']))
  return tableMd(rows)
}

/** 向上找出節點所屬的 table。 */
export function tableOf(node: DomNode): DomNode | null {
  let el: DomNode | null = node
  while (el !== null && el !== undefined) {
    if (tagOf(el) === 'TABLE') return el
    el = el.parentElement ?? null
  }
  return null
}

const BLOCK_TAGS = ['TABLE', 'PRE', 'UL', 'OL', 'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE']

/**
 * 走訪節點 → Markdown 區塊序列。
 * range 提供時,表格以「真實表格 + 選區覆蓋列」處理(表頭齊全);否則以片段自身重建。
 */
export function blocksMd(root: DomNode, range?: DomRange): string {
  const out: string[] = []
  const push = (block: string): void => {
    const t = block.trim()
    if (t !== '') out.push(t)
  }

  const walk = (node: DomNode): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/[ \t]+/g, ' ').trim()
      if (text !== '') push(text)
      return
    }
    if (node.nodeType !== ELEMENT_NODE) {
      for (const child of children(node)) walk(child)
      return
    }
    switch (tagOf(node)) {
      case 'TABLE': {
        const inRange = range !== undefined && tableOf(range.startContainer) === node
        const md = inRange
          ? tableFromRange(node, range as DomRange)
          : tableMd(descendants(node, ['TR']).map((tr) => descendants(tr, ['TH', 'TD'])))
        push(md)
        return
      }
      case 'PRE': {
        const code = textOf(node).replace(/\n+$/, '')
        if (code.trim() !== '') push('```\n' + code + '\n```')
        return
      }
      case 'UL':
      case 'OL': {
        const items = children(node).filter((c) => tagOf(c) === 'LI')
        const lines = items.map((li, i) => {
          const body = inlineMd(li).replace(/\s+/g, ' ').trim()
          return tagOf(node) === 'OL' ? `${i + 1}. ${body}` : `- ${body}`
        })
        push(lines.join('\n'))
        return
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const text = inlineMd(node).replace(/\s+/g, ' ').trim()
        if (text !== '') push('#'.repeat(Number(tagOf(node).slice(1))) + ' ' + text)
        return
      }
      case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'LI': case 'BLOCKQUOTE': {
        const kids = children(node)
        const hasBlockChild = kids.some((c) => BLOCK_TAGS.includes(tagOf(c)))
        if (!hasBlockChild) {
          const inline = inlineMd(node).replace(/[ \t]+/g, ' ').trim()
          if (inline !== '') push(inline)
          return
        }
        // 混合內容:<p> 內含表格/清單等區塊 → 行內文字與區塊分別收錄
        const inline = kids
          .filter((c) => c.nodeType === TEXT_NODE)
          .map((c) => (c.nodeValue ?? '').replace(/[ \t]+/g, ' ').trim())
          .filter((t) => t !== '')
          .join(' ')
        if (inline !== '') push(inline)
        for (const child of kids) if (child.nodeType === ELEMENT_NODE) walk(child)
        return
      }
      default: {
        for (const child of children(node)) walk(child)
      }
    }
  }

  for (const child of children(root)) walk(child)
  return out.join('\n\n')
}

/** 取選區的 Markdown;無法結構化時回空字串(呼叫端可退回純文字)。 */
export function selectionMarkdown(range: DomRange): string {
  try {
    const table = tableOf(range.startContainer)
    // 常見情境:整段選取都落在同一個表格內 → 由真實表格重建
    if (table !== null && tableOf(range.endContainer) === table) {
      const md = tableFromRange(table, range)
      if (md.trim() !== '') return md
    }
    const frag = range.cloneContents()
    const md = blocksMd(frag, range)
    if (md.trim() !== '') return md
  } catch {
    // 落到純文字兜底
  }
  return ''
}
