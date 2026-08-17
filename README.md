# @bryan-cmf/dsh-insights

**價值導向的研發觀測/洞察管線 — DSH 四合一套件。**

對話 → 軌跡 → 觀測(敘事/里程碑)→ 洞察(價值導向)→ 建議 → 傳回主對話。
以技術服務價值,讓程序員不迷失。

合併自四個獨立套件(它們的獨立 repo 僅保留作歷史):

| 原套件 | 成為本套件的 |
|---|---|
| `dsh-infra-observability` | infra 模組(host)+ 觀測視圖(client) |
| `dsh-vector-memory` | memory 模組(host)+ 記憶視圖(client) |
| `dsh-view-perspectives` | perspectives 模組(host)+ 洞察/筆記視圖(client) |
| `dsh-insight-agent` | insight 模組(host)+ 洞察浮窗(client) |

## 功能

### 四個視圖(conversation view ring)

- **觀測**(order 20)— 概覽統計、觀測敘事/里程碑(觀測智能體產物)、全項目觀測一覽、檔案活動、機制事件、最近執行
- **記憶**(order 30)— 四透鏡:卡點 / 失敗 / 技術 / 學習,失敗高亮;tab 標籤帶即時徽標
- **洞察**(order 40)— 掃描洞察(工具失敗/用戶糾正/壓縮/無產出,重要性 ≥2 自動寫入記憶並標 ✓已存)、價值錨點(goal/todos)、價值總結卡、自動洞察卡(每 5 輪)
- **筆記**(order 50)— 手寫待辦/筆記(per-session 持久化)+ 觀測建議待辦一鍵採納,回合結束自動刷新

### 兩個智能體

- **觀測智能體**(host)— digest 折疊 → turn/end 增量 LLM 觀測(deepseek-v4-flash)→ 滾動敘事 / 主題 / 里程碑 / 建議待辦,持久化於 `observation` 域;手動「重新觀測」分段續寫全歷史(1000 條/段);里程碑自動寫記憶(標籤 里程碑)
- **洞察智能體**(host + 浮窗)— 右下角 FAB 對話面板,per-session 對話,DeepSeek V4 flash 深思 max(深思過程可展開),【建議】一鍵傳回主對話框;`/api/insight/chat` 讀觀測產物併入 context,併發閘(2 併發 + FIFO 佇列 + 60s 逾時 → 429)

### 平台面

- **工具**:`mem_save` / `mem_search` / `mem_health`、`usage_report` / `audit_skills` / `infra_health`
- **服務**:`vectorMemory`(供其他插件 inject)
- **session 投影**:`infraView`、`memActivity`、`fileActivity`、`mechEvents`、`goalTrace`、`insightsScan`
- **HTTP 路由**:`/api/observation`、`/api/observation/rebuild`、`/api/observations`、`/api/notes`、`/api/prompt/optimize`、`/api/insight/summary`、`/api/insight/chat`
- **持久化域**:`vector_memory`、`observation`、`session_notes`(跨 session、跨重啟)
- **提示詞優化器**:composer 工具列「優化」按鈕,把草稿結構化後寫回

## 安裝(profile)

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "@bryan-cmf/dsh-insights": "file:/path/to/dsh-insights" },
  "dsh": { "profile": { "bundles": ["@bryan-cmf/dsh-insights"] } }
}
```

重啟 web 後生效。記憶 key 帶 session 前綴(`sid:<key>` / `ms:<sid>:<seq>-<title>`)。

## 開發

```bash
pnpm build   # clean + types (tsc) + bundle (tsdown) → lib/
```

Host 入口 `src/index.ts`(合併 Config:maxRecords / healthIntervalMs /
errorAlertThreshold / ttlDays / maxResults);client 入口 `src/client/index.ts`。
各功能在 `src/host/`、`src/client/` 下以模組保留,便於逐模組迭代。

## License

MIT
