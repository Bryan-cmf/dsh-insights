/**
 * dsh-insights · Markdown 渲染共用元件。
 *
 * 直接使用官方 @deepseek-ai/dsh-client-ui-primitives 的 MarkdownText
 * (與主對話頁同一渲染管線:GFM + KaTeX,禁原始 HTML/不安全協議):
 * - 執行期:web shell 的 staticModules 已注入該模組,外置 require,零打包成本;
 * - 型別:見 ./primitives.d.ts(與發布版 .d.ts 對照)。
 *
 * 封裝為 Md:統一裁掉記憶 row 的「[模塊] 」前綴後再渲染,
 * 並補上與觀測頁一致的預設排版(line-height / 字號)。
 */
import { createElement, type ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

const mdHost: {
  lineHeight: number
  fontSize: number
  wordBreak: string
  color: string
} = {
  lineHeight: 1.6,
  fontSize: 12,
  wordBreak: 'break-word',
  color: 'var(--dsw-alias-label-primary)',
}

/** 記憶 row 的「[挫折] 內容」式前綴(標籤已由 badge 展示,渲染時去掉)。 */
const TAG_PREFIX_RE = /^\[[^\]\n]{1,12}\]\s*/

export interface MdProps {
  text: string
  /** 記憶 row 的前綴標籤是否剝離(預設剝離)。 */
  stripTagPrefix?: boolean
  fontSize?: number
}

export function Md(props: MdProps): ReactNode {
  if (props.text === '' || typeof props.text !== 'string') return null
  let text = props.text
  if (props.stripTagPrefix !== false) text = text.replace(TAG_PREFIX_RE, '')
  return createElement('div', {
    style: {
      ...mdHost,
      ...(typeof props.fontSize === 'number' ? { fontSize: props.fontSize } : {}),
    },
  }, createElement(MarkdownText, { text }))
}
