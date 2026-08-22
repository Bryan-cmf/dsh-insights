/**
 * 環境型別宣告:@deepseek-ai/dsh-client-ui-primitives。
 *
 * 執行期不打包此套件——web 前端 shell 的 staticModules 已提供
 * (@deepseek-ai/dsh-client-ui-primitives 與 react 同級,見
 * dsh-web-frontend shell 的 Jd() 靜態種子表),本 bundle 僅需
 * `require(...)` 對外引用(tsdown neverBundle 保持外部)。
 *
 * 此處只宣告實際使用的 MarkdownText,API 與
 * `dsh-client-ui-primitives@0.1.1-rc.2` 發布的
 * `lib/types/markdown/MarkdownText.d.ts` 精確一致(2026-08-22 對照)。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'

  /** 局部化後的代碼區塊複製按鈕標籤(轉發給 MarkdownText 的 codeLabels)。 */
  export interface MarkdownCodeLabels {
    [key: string]: string
  }
  /** 檔案提及解析器(docs/檔案路徑 → 互動連結)。 */
  export interface MarkdownFileMentions {
    [key: string]: unknown
  }

  /**
   * 渲染不可信 assistant 產出的 Markdown 為語意化 React 元素:
   * GFM + KaTeX 數學;禁用原始 HTML、相對連結與不安全協議,絕對 http(s) 圖片直出。
   */
  export const MarkdownText: React.MemoExoticComponent<(props: {
    text: string
    streaming?: boolean
    codeLabels?: MarkdownCodeLabels | undefined
    fileMentions?: MarkdownFileMentions | undefined
  }) => React.JSX.Element>
}
