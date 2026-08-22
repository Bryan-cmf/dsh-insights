# @bryan-cmf/dsh-insights

<div align="center">

🌐 <a href="./README.md">English</a> · **繁體中文**

DeepSeek Harness 的價值導向觀測/洞察/記憶管線 — DSH 四合一套件,持續迭代中。

[![npm version](https://img.shields.io/npm/v/@bryan-cmf/dsh-insights)](https://www.npmjs.com/package/@bryan-cmf/dsh-insights)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

## 它做什麼

對話 → 軌跡 → 觀測(敘事/里程碑)→ 洞察(價值導向)→ 建議 → 傳回主對話。
以技術服務價值,讓程序員不迷失。

## 三個智能體

| 智能體 | 職責 |
|---|---|
| **觀測智能體** | digest 折疊 → turn/end 增量 LLM 觀測(deepseek-v4-flash)→ 滾動敘事/主題/里程碑/建議待辦,持久化於 `observation` 域;手動「重新觀測」分段續寫全歷史;全失敗不覆寫好敘事(資料保護) |
| **洞察智能體** | 右下浮窗對話(深思 max、過程可展開、對話歷史連貫),全面服務於價值/潛力路徑/發展方向;【建議】一鍵傳主對話框;併發閘(2 併發 + FIFO + 60s 逾時 → 429) |
| **記憶智能體** | 每 3 輪從近期軌跡提煉長期記憶,LLM 理解後歸入模塊:**挫折 / 技術 / 學習 / 決策**(像人腦:記住挫折與深刻的事、技術的沉澱與發現);對照近期記憶去重 |

## 四個視圖(conversation view ring)

- **觀測**(order 20)— 文字優先:觀測敘事/里程碑、全項目一覽在上;概覽統計、檔案活動、機制事件、工具/技能 TOP、最近執行沉底
- **記憶**(order 30)— 智能記憶模塊,**嚴格按 session 隔離**(不混入其他 session 的內容——v0.10.0 起;`mem_save` 新寫入會蓋上呼叫 session id 戳記;舊「同 cwd 聚合」行為保留為 `/api/memories?scope=project` 白名單)+ 記憶活動四透鏡
- **洞察**(order 40)— 價值錨點(目標/任務)、自動洞察卡(每 5 輪)、價值總結卡、**方向演變**時間線、**潛力路徑**生成器(可採納為待辦/傳主對話框);生成物持久化,切頁不丟
- **筆記**(order 50)— 手寫待辦/筆記 + 觀測建議待辦一鍵採納,回合結束自動刷新

**外加** — 提示詞優化器(composer「優化」按鈕)、洞察浮窗 FAB(夜間模式可讀、可拖動任意位置)、**洞察面板可自由調整大小**(拖右緣/下緣/右下角,尺寸跨刷新保持)、正文一律**原生 Markdown 渲染**(觀測敘事/記憶模塊/自動洞察/價值總結/洞察對話)——與主對話同一條 `MarkdownText` 渲染管線。

## 錯誤三分類

工具錯誤按 `policy`(沙箱/審批/FS 政策攔截——規則內有益保護,只計數不打擾)、`transient`(重啟/網絡/限流——至多一條提示)、`real`(真踩坑——按工具聚合,自動寫記憶標籤「挫折」)分類。只有深刻的事進記憶。

## 平台面

- **工具**:`mem_save` / `mem_search` / `mem_health`、`usage_report` / `audit_skills` / `infra_health`
- **服務**:`vectorMemory`(供其他插件 inject)
- **session 投影**:`infraView`、`memActivity`、`fileActivity`、`mechEvents`、`goalTrace`、`insightsScan`
- **HTTP 路由**:`/api/observation`、`/api/observation/rebuild`、`/api/observations`、`/api/notes`、`/api/prompt/optimize`、`/api/insight/summary`、`/api/insight/paths`、`/api/insight/chat`、`/api/memories`
- **持久化域**:`vector_memory`、`observation`、`session_notes`、`insight_chat`
- **LLM 呼叫不設 maxTokens**:provider 缺省不帶 max_tokens,模型自主決定輸出長度;JSON 解析具字串感知平衡擷取 + 控制符清洗 + section 打撈兜底

## 安裝(profile)

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "@bryan-cmf/dsh-insights": "^0.10.0" },
  "dsh": { "profile": { "bundles": ["@bryan-cmf/dsh-insights"] } }
}
```

重啟 `dsh web` 後生效。(開發期間可將依賴指向本地目錄:`file:/path/to/dsh-insights`。)

## 開發

```bash
pnpm install        # fresh clone
pnpm build          # clean + types (tsc) + bundle (tsdown) → lib/
node scripts/smoke-host.mjs   # host 結構冒煙:9 路由/6 投影/6 工具/1 服務 + 儲存域單例斷言
```

源碼結構:host 入口 `src/index.ts`(合併 Config + inject 聯集),功能模組在 `src/host/`(infra / memory / perspectives / insight / domains);client 入口 `src/client/index.ts`,視圖模組在 `src/client/`(observation-view / memory-view / insights-views / insight-float)。

## 版本歷史

| 版本 | 亮點 |
|---|---|
| v0.10.0 | 記憶嚴格按 session 隔離;正文原生 Markdown 渲染(官方 `MarkdownText` 管線);洞察面板可調整大小 |
| v0.9.0 | 可拖動洞察 FAB(位置持久化) |
| v0.8.0 | 洞察對話歷史持久化(`insight_chat` 域,按 session) |
| v0.7.0 | JSON 解析瘟疫修復;記憶按項目(cwd)隔離;記憶頁只顯示本項目 |
| v0.6.0 | FAB 夜間模式修復;記憶分類學改革(挫折/技術/學習/決策) |
| v0.5.x | 價值總結與潛力路徑持久化;記憶智能體(每 3 輪)+ `/api/memories` |
| v0.4.x | 方向演變時間線;潛力路徑生成器;字串感知 JSON 平衡擷取 |
| v0.3.x | 價值導向布局;對話歷史補全;全面移除 maxTokens 上限 |
| v0.2.0 | 錯誤三分類(policy / transient / real);洞察頁轉向價值/方向 |
| v0.1.0 | 四套件合併為單一插件發布;儲存域單例修復 |

## License

MIT
