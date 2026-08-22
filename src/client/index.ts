/**
 * @bryan-cmf/dsh-insights — Client half(永久化)。
 *
 * 單一套件的瀏覽器半邊,視圖模組:
 * - observation-view :「觀測」tab(order 20)——概覽統計 + 觀測敘事/里程碑 +
 *                      全項目一覽 + 檔案活動 + 機制事件 + 最近執行
 * - memory-view      :「記憶」tab(order 30)——四透鏡(卡點/失敗/技術/學習),失敗高亮
 * - insights-views   :「洞察」tab(order 40)+「筆記」tab(order 50)+ 提示詞優化器按鈕
 * - insight-float    :洞察浮窗(shell.overlay FAB + 面板)+ 投影橋接(input.dock)
 *
 * Host half 見 src/index.ts。
 */
import { applyObservabilityView } from './observation-view.ts'
import { applyMemoryView } from './memory-view.ts'
import { applyPerspectivesViews } from './insights-views.ts'
import { applyInsightFloat } from './insight-float.ts'

const name = 'insights-client'

interface SlotsService {
  inject(key: string, fn: () => unknown): unknown
  register(registration: unknown, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
}

const inject = ['slots']

function apply(ctx: ClientCtx): void {
  applyObservabilityView(ctx)
  applyMemoryView(ctx)
  applyPerspectivesViews(ctx)
  applyInsightFloat(ctx)
}

export { apply, inject, name }
