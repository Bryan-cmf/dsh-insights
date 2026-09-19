/**
 * dsh-insights · 選區 → Markdown 提取測試(用戶 2026-09-19 回報的 bug)。
 *
 * 症狀:在對話裡選取一個表格、加到筆記,筆記裡出現「一段文字」而不是表格。
 * 根因:對話是 Markdown 渲染成 HTML 的,表格的「|」語法在 DOM 裡不存在,
 *       `selection.toString()` 只會拿到儲存格文字用 tab 併起來的一行。
 * 修法:走訪選區 DOM 依結構重建 Markdown(見 src/client/md-extract.ts)。
 *
 * 本測試以極簡 DOM shim 直接驅動真實模組(Node 26 直跑 TS 原始碼),
 * 覆蓋:表格(整表/部分列/缺表頭)、程式碼區塊、清單、標題、行內語法、
 * 管線逸出、混合內容、以及「退回純文字」的兜底路徑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectionMarkdown, inlineMd, tableMd, textOf } from '../src/client/md-extract.ts'

// ── 極簡 DOM shim(只實作 md-extract 依賴的成員)────────────────────────────
let ELEMENT_NODE_ID = 0
function el(tag, ...children) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: children,
    parentElement: null,
    attrs: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null },
  }
  for (const c of children) if (c && typeof c === 'object') c.parentElement = node
  ELEMENT_NODE_ID += 1
  return node
}
function txt(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [] }
}
/**
 * 深拷貝:真實 DOM 的 range.cloneContents() 回傳的是**副本**,不會動到原節點。
 * shim 若不拷貝而直接掛進 fragment,會把原節點的 parentElement 改掉,
 * 讓 tableOf(startContainer) 找不到表格(第一版測試就踩了這個坑)。
 */
function cloneNode(node) {
  if (node.nodeType === 3) return txt(node.nodeValue)
  const copy = el(node.tagName, ...Array.from(node.childNodes).map(cloneNode))
  copy.attrs = { ...node.attrs }
  return copy
}
function frag(...children) {
  return el('#fragment', ...children.map(cloneNode))
}
/** 選區:intersects 決定哪些列被框到;cloneContents 回傳整份或部分片段。 */
function range(startContainer, endContainer, intersects = () => true, fragment) {
  return {
    startContainer,
    endContainer,
    intersectsNode: intersects,
    cloneContents: () => fragment ?? frag(startContainer),
  }
}
/** 選「整張表」的選區。 */
function fullTableRange(table) {
  return range(table, table, () => true, frag(table))
}

/** 建一張 GFM 語義的表格:thead>tr>th 表頭 + tbody>tr>td 資料。 */
function table(headerCells, rows, opts = {}) {
  const th = headerCells.map((t) => el('th', txt(t)))
  const headRow = el('tr', ...th)
  const thead = el('thead', headRow)
  const bodyRows = rows.map((cells) => el('tr', ...cells.map((c) => el('td', txt(c)))))
  const tbody = el('tbody', ...bodyRows)
  const t = opts.noThead ? el('table', el('tr', ...headerCells.map((c) => el('td', txt(c)))), tbody) : el('table', thead, tbody)
  return t
}

function eqBlocks(actual, expected) {
  assert.equal(actual.replace(/\s+$/g, ''), expected)
}

test('表格:整表選取 → GFM 表格(表頭 + 分隔列 + 資料列)', () => {
  const t = table(['工具', '呼叫數'], [['bash', '25,682'], ['read', '7,159']])
  const md = selectionMarkdown(fullTableRange(t))
  eqBlocks(md, [
    '| 工具 | 呼叫數 |',
    '| --- | --- |',
    '| bash | 25,682 |',
    '| read | 7,159 |',
  ].join('\n'))
})

test('表格:只選到部分資料列 → 表頭自動補上(否則 GFM 渲染不出表格)', () => {
  const t = table(['工具', '呼叫數'], [['bash', '25,682'], ['read', '7,159'], ['edit', '3,700']])
  const bodyRows = t.childNodes[1].childNodes
  const only = bodyRows[1] // 只框到 read 這列
  const md = selectionMarkdown(range(only, only, (node) => node === only, frag(only)))
  eqBlocks(md, [
    '| 工具 | 呼叫數 |',
    '| --- | --- |',
    '| read | 7,159 |',
  ].join('\n'))
})

test('表格:沒有 thead(全是 td)→ 首列當表頭,仍輸出合法 GFM', () => {
  const t = table(['a', 'b'], [['1', '2']], { noThead: true })
  const md = selectionMarkdown(fullTableRange(t))
  eqBlocks(md, ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'))
})

test('表格:儲存格含管線 → 逸出為 \\|,不破壞表格結構', () => {
  const t = table(['表達式', '結果'], [['a | b', '真']])
  const md = selectionMarkdown(fullTableRange(t))
  assert.match(md, /\| a \\\| b \| 真 \|/)
})

test('表格:欄數不一致 → 補空欄,維持方正', () => {
  const t = table(['x', 'y', 'z'], [['1']])
  const md = selectionMarkdown(fullTableRange(t))
  eqBlocks(md, ['| x | y | z |', '| --- | --- | --- |', '| 1 |  |  |'].join('\n'))
})

test('程式碼區塊:<pre> → 圍欄程式碼,內容原樣保留', () => {
  const pre = el('pre', el('code', txt('const a = 1\nif (a | 2) {}\n')))
  const md = selectionMarkdown(range(pre, pre, () => true, frag(pre)))
  eqBlocks(md, '```\nconst a = 1\nif (a | 2) {}\n```')
})

test('清單:<ul>/<ol> → - / 1. 項目', () => {
  const ul = el('ul', el('li', txt('第一項')), el('li', txt('第二項')))
  eqBlocks(selectionMarkdown(range(ul, ul, () => true, frag(ul))), '- 第一項\n- 第二項')
  const ol = el('ol', el('li', txt('步驟一')), el('li', txt('步驟二')))
  eqBlocks(selectionMarkdown(range(ol, ol, () => true, frag(ol))), '1. 步驟一\n2. 步驟二')
})

test('標題:h1–h6 → # 前綴', () => {
  const h3 = el('h3', txt('三段標題'))
  eqBlocks(selectionMarkdown(range(h3, h3, () => true, frag(h3))), '### 三段標題')
})

test('行內語法:code / strong / em / 連結 / 刪除線 還原', () => {
  const p = el('p',
    txt('設定 '),
    el('code', txt('autoInsight: false')),
    txt(' 之後,'),
    el('strong', txt('預設關閉')),
    txt(';詳見 '),
    el('a', txt('文件')),
    txt('。'))
  p.childNodes[5].attrs = { href: 'https://example.com/x' }
  eqBlocks(selectionMarkdown(range(p, p, () => true, frag(p))),
    '設定 `autoInsight: false` 之後,**預設關閉**;詳見 [文件](https://example.com/x)。')
  assert.equal(inlineMd(el('em', txt('斜'))), '*斜*')
  assert.equal(inlineMd(el('del', txt('刪'))), '~~刪~~')
})

test('混合內容:表格與段落並存 → 區塊間以空行分隔', () => {
  const t = table(['k', 'v'], [['a', '1']])
  const p = el('p', txt('結論如上表。'))
  const wrap = frag(t, p)
  const md = selectionMarkdown(range(t, p, () => true, wrap))
  eqBlocks(md, ['| k | v |', '| --- | --- |', '| a | 1 |', '', '結論如上表。'].join('\n'))
})

test('兜底:無法結構化時回空字串(呼叫端退回純文字,不丟內容)', () => {
  const broken = { nodeType: 1, tagName: 'DIV', childNodes: [], parentElement: null }
  Object.defineProperty(broken, 'childNodes', { get() { throw new Error('boom') } })
  const r = { startContainer: broken, endContainer: broken, cloneContents() { throw new Error('boom') }, intersectsNode() { return true } }
  assert.equal(selectionMarkdown(r), '')
})

test('textOf / tableMd 基本契約', () => {
  assert.equal(textOf(el('div', txt('a'), el('span', txt('b')))), 'ab')
  assert.equal(tableMd([]), '')
  assert.equal(tableMd([[]]), '')
})
