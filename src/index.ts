/**
 * @bryan-cmf/dsh-insights — Host half(永久化)。
 *
 * 觀測 → 記憶 → 洞察 → 筆記:價值導向的研發觀測/洞察管線,四合一套件。
 * (原 dsh-infra-observability / dsh-vector-memory / dsh-view-perspectives /
 * dsh-insight-agent 四套件合併;各功能在 host/ 下以模組保留。)
 *
 * 模組:
 * - infra        :結構觀測層(tools/result 記錄、agent 生命週期、watchdog、
 *                  infraView 投影、usage_report / audit_skills / infra_health 工具)
 * - memory       :持久記憶核心(vector_memory 域、mem_save / mem_search /
 *                  mem_health 工具、vectorMemory 服務、memActivity 投影)
 * - perspectives :session 投影(fileActivity / mechEvents / goalTrace /
 *                  insightsScan)+ 觀測智能體(digest fold → turn/end 增量 →
 *                  敘事/里程碑/建議待辦 → observation 域持久化 + 路由組:
 *                  /api/observation[/rebuild]、/api/observations、/api/notes、
 *                  /api/prompt/optimize、/api/insight/summary)+ 洞察自動存檔
 *                  (重要性 ≥2 → vector_memory,重啟回放對齊)
 * - insight      :洞察智能體(POST /api/insight/chat,deepseek-v4-flash 深思
 *                  max,併發閘 2 + FIFO 佇列)
 *
 * Client half 見 src/client/(觀測/記憶/洞察/筆記四視圖 + 洞察浮窗)。
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { applyInfra } from './host/infra.ts'
import { applyMemory } from './host/memory.ts'
import { applyPerspectives, type ProjectionCtx } from './host/perspectives.ts'
import { applyInsightChat, type InsightCtx } from './host/insight.ts'

const name = 'insights'

const Config = z.object({
  /** Ring-buffer cap for recent execution records (infra). */
  maxRecords: z.number().min(100).max(100000).default(5000),
  /** Watchdog check interval (infra). */
  healthIntervalMs: z.number().min(5000).max(3600000).default(60000),
  /** Alert when this many agent errors occur within any 5-minute window (infra). */
  errorAlertThreshold: z.number().min(1).max(1000).default(5),
  /** Default TTL in days for saved memories; 0 = never expire (memory). */
  ttlDays: z.number().min(0).max(3650).default(90),
  /** Default result count for mem_search (memory). */
  maxResults: z.number().min(1).max(100).default(10),
})

interface ConfigType {
  maxRecords: number
  healthIntervalMs: number
  errorAlertThreshold: number
  ttlDays: number
  maxResults: number
}

// 四模組注入的聯集;全部服務在 web profile 中均由宿主提供。
const inject = ['tools', 'timer', 'skills', 'storageDomain', 'sessionProjections', 'llm', 'webServer', 'sessionQuery']

function apply(ctx: Context, config: ConfigType): void {
  applyInfra(ctx, config)
  applyMemory(ctx, config)
  // perspectives/insight 模組以結構化最小介面定義所需服務;
  // 入口 inject 已保證全部存在,直接轉型。
  applyPerspectives(ctx as unknown as ProjectionCtx)
  applyInsightChat(ctx as unknown as InsightCtx)
}

export { Config, apply, inject, name }
