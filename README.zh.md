# @bryan-cmf/dsh-insights

<div align="center">

🌐 <a href="./README.md">English</a> · **繁體中文**

DeepSeek Harness 的價值導向觀測/洞察/記憶管線 — DSH 單一套件,持續迭代中。

[![npm version](https://img.shields.io/npm/v/@bryan-cmf/dsh-insights)](https://www.npmjs.com/package/@bryan-cmf/dsh-insights)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

## 它做什麼

對話 → 軌跡 → 觀測(敘事/里程碑)→ 洞察(價值導向)→ 建議 → 傳回主對話。
以技術服務價值,讓程序員不迷失。

## 三個智能體

| 智能體 | 職責 |
|---|---|
| **觀測智能體** | digest 折疊 → turn/end 增量 LLM 觀測(deepseek-v4-flash)→ 滾動敘事/主題/里程碑,持久化於 `observation` 域。v0.12.0 起只觀測跑到 **≥ 2 回合**的 session(實測 96% 記錄來自單回合 session),且記憶欄位每 3 輪附帶在同一次呼叫裡——每個被觀測回合僅 1 次 LLM,不再有獨立記憶代理。手動「重新觀測」分段續寫全歷史;全失敗不覆寫好敘事(資料保護) |
| **記憶智能體** | v0.12.0 起併入觀測呼叫(每 3 個被觀測回合一次)——LLM 理解後歸入模塊:**挫折 / 技術 / 學習 / 決策**(像人腦:記住挫折與深刻的事、技術的沉澱與發現);對照近期記憶去重。工具失敗不再沉澱成記憶(實測全庫 42% 是「工具 X 失敗」噪音)——掃描洞察仍即時提醒 |

## 四個視圖(conversation view ring)

- **觀測**(order 20)— 文字優先:觀測敘事/里程碑、全項目一覽在上;概覽統計、檔案活動、機制事件、工具/技能 TOP、最近執行沉底
- **記憶**(order 30)— 智能記憶模塊,**嚴格按 session 隔離**(不混入其他 session 的內容——v0.10.0 起;`mem_save` 新寫入會蓋上呼叫 session id 戳記;舊「同 cwd 聚合」行為保留為 `/api/memories?scope=project` 白名單)+ 記憶活動四透鏡
- **洞察**(order 40)— 價值錨點(目標/任務)、價值總結卡、**方向演變**時間線、**潛力路徑**生成器(可採納為待辦/傳主對話框);生成物持久化,切頁不丟。自動洞察(每 5 輪一次 LLM)v0.12.0 起**預設關閉**(實測 35 天僅 35 條),需要時以 `autoInsight: true` 開回
- **筆記**(order 50)— 手寫待辦與**Markdown 渲染的筆記**(多行輸入框,Enter 送出 / Shift+Enter 換行),回合結束自動刷新。在對話中**選取任意文字**,選區旁浮出「＋ 加到筆記」——一鍵存進當前 session 筆記(表格/程式碼/清單會以 Markdown 原樣保留)

**外加** — 提示詞優化器(composer「優化」按鈕)、**選取文字加筆記**(夜間模式可讀的浮動按鈕、支援觸控、Esc 取消)、正文一律**原生 Markdown 渲染**(觀測敘事/記憶模塊/筆記/自動洞察/價值總結)——與主對話同一條 `MarkdownText` 渲染管線。

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
| v0.12.1 | 修復「選取表格加筆記只得到一段文字」:選區改為**走訪 DOM 重建 Markdown**——表格→GFM 表格(表頭自動補齊、管線逸出)、程式碼→圍欄、清單/標題/行內 code·粗體·連結一併還原;附 12 項回歸測試(含部分列選取、缺表頭、混合內容) |
| v0.12.0 | **減法版**(基於 35 天真實用量回顧):自動洞察預設關閉;觀測只收 ≥2 回合的 session(初始編年史同樣設門檻,35 天省約 2,700 次白燒呼叫);記憶欄位合併進觀測呼叫(不再有獨立記憶代理);工具失敗不再寫入記憶(清掉 1,279 條噪音);移除 `hits` 死欄位與建議待辦生成;移除洞察浮窗 FAB(35 天僅用 4 次)與 `/api/insight/chat` 路由;**筆記支援 Markdown 渲染** + 多行輸入;新增**對話選取文字→加到筆記**。並修復狀態競態:歷史回放會覆寫即時折疊狀態、導致回合計數被重置 |
| v0.11.0 | 設置頁「記憶數據」看板——分類/參數/增長趨勢(`/api/memory/stats`) |
| v0.10.1 | 手機端修復:FAB / 面板頭 / 縮放手柄改用 Pointer Events + `touch-action: none`——觸控可拖,不再被當成頁面滾動 |
| v0.10.0 | 記憶嚴格按 session 隔離;正文原生 Markdown 渲染(官方 `MarkdownText` 管線);洞察面板可調整大小 |
| v0.9.0 | 可拖動洞察 FAB(位置持久化) |
| v0.8.0 | 洞察對話歷史持久化(`insight_chat` 域,按 session) |
| v0.7.0 | JSON 解析瘟疫修復;記憶按項目(cwd)隔離;記憶頁只顯示本項目 |
| v0.6.0 | FAB 夜間模式修復;記憶分類學改革(挫折/技術/學習/決策) |
| v0.5.x | 價值總結與潛力路徑持久化;記憶智能體(每 3 輪)+ `/api/memories` |
| v0.4.x | 方向演變時間線;潛力路徑生成器;字串感知 JSON 平衡擷取 |
| v0.3.x | 價值導向布局;對話歷史補全;全面移除 maxTokens 上限 |
| v0.2.0 | 錯誤三分類(policy / transient / real);洞察頁轉向價值/方向 |
| v0.1.0 | 首個統一單一插件發布;儲存域單例修復 |

## License

MIT
