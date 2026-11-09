# P1 自動歸檔：本機實作與驗證

| 項目 | 狀態 |
|---|---|
| 本文件 | 2026-10-28 版 |
| 分支 | `feat/p1-auto-filing`，以 P3 的 `917a488` 為基底（P3 已經把共用規則改成非同步，P1 歸檔直接接在上面，不另開一份） |
| 驗證 | **只有合成資料的本機測試**。沒有連到 Zoom、Google Drive、正式資料庫或 Vercel |
| 正式網站、資料庫、Vercel 設定 | 都沒有修改；沒有推送、沒有部署 |

相關文件：
- [`p1-p3-handoff-spec.md`](p1-p3-handoff-spec.md)：P1↔P3 交接規格
- [`recording-failure-rules.md`](recording-failure-rules.md)：失敗處理規則（第 7 節已依本文件更新）
- [`live-classroom-dashboard.md`](live-classroom-dashboard.md)：管理員即時教室總覽
- [`recording-adapter.md`](recording-adapter.md)：Recording Adapter，P1 與視訊供應商之間的介面（2026-10-31）

## 1. 流程

1. **Zoom 通知錄影完成。** Webhook 驗證簽章後，在同一個資料庫交易裡寫入三樣東西，**commit 成功才回 200**，否則回 503 讓 Zoom 重送：
   - 去除個資後的事件；
   - 每個檔案一筆紀錄；
   - 每個要歸檔的檔案一筆工作。
2. **登記檔案時就決定好歸檔方式**（`webhook-ingest.mjs` 的 `recordFiles`）：
   - **課堂識別：** `session_key` 就是我方的課程 ID。找不到這堂課就 `HOLD`（`UNKNOWN_SESSION`），不上傳。
   - **錄影同意：** 整堂課不符合錄影條件就 `HOLD`（`NO_CONSENT`）。撤回同意之後錄到的，`HOLD`（`AFTER_WITHDRAWAL`）；撤回之前錄到的，放進 `_待確認`。出現身分不明的人之後錄到的，`HOLD`。
   - **命名：** 直接用 P1 的 `Core.js`（沒有改寫）：`日期_學生代碼_小老師代碼_P01.mp4`。多位學生用 `+` 連接，放在 `[iHear] MM.YYYY.Zoom Recordings`。
   - **分段編號：** 同一則通知裡的檔案依錄影開始時間排序，編成 P01、P02……；之後的通知接著往下編。
3. **背景 worker 把錄影搬進 Drive**（新模組 `recording-filing.mjs`）：
   - 從 Zoom 依位元組範圍分段下載，經由 Drive 的 resumable 上傳分段送出。
   - 每送完一段，就把上傳 session 和 **Drive 確認收到的位元組數**存進資料庫，並延長租約。
4. **完成後：**
   - 以「大小相符的最早一份」為準，其他副本移到垃圾桶。
   - 標記 `STORED`，同時排入「刪除 Zoom 副本」的工作。**Zoom 的副本只在 Drive 有核對過的副本之後才刪。**

## 2. 背景處理：Vercel 函式結束時，工作不會遺失

| 風險 | 做法 |
|---|---|
| 函式隨時可能被停止 | 工作存在資料庫，以租約和防護號領取；被停止的呼叫只會失去租約，租約到期後別的呼叫接手 |
| 一支影片大於一次呼叫能搬的量 | 每次呼叫有時間預算。在截止前 15 秒（或最慢一段所需時間的 2 倍）就不再開始新的一段，先存好進度、把工作放回佇列（`CONTINUE`），下一次呼叫從 Drive 確認的位元組接著傳 |
| 大檔案傳很久，被誤判為卡住 | 每段完成就延長租約（2 分鐘）。重試次數只計算「上次有進度之後」的次數，所以傳得慢但一直有進度的上傳不會被放棄 |
| 一直在同一個地方被停止 | 連續被領取超過 5 次都沒有任何進度，就判定失敗並通知（`FILING_FAILED`），不會無限循環 |
| Drive 一直回報沒有進度 | 連續兩段都沒有前進，就結束這次嘗試，退避之後再試，不會原地空轉到截止時間 |
| 剛上傳的檔案，Drive 搜尋還找不到 | 用檔案 ID 直接讀取核對，不會誤刪剛傳好的檔案再重傳 |
| 沒有任何呼叫來執行工作 | Webhook 已經存下的工作不會遺失。完成通知送達 60 分鐘後仍未歸檔，總覽顯示 `FILING_DELAYED`（警告），6 小時後升為錯誤 |

**誰來觸發 worker：**
- 現有的三種觸發（webhook 回應後、小老師心跳、總覽輪詢）都會順便執行，但時間預算很短，只有 10 秒。
- 新增 `GET /api/classroom/scheduled-tick`，給排程呼叫：
  - 要帶 `Authorization: Bearer <CRON_SECRET>`。沒有設定 `CRON_SECRET`（至少 32 字元）時回 503，什麼都不做。
  - 執行完整的 tick：決策、核對、歸檔、異常同步。歸檔可以用到 50 秒，因為 `maxDuration` 是 60 秒，保留 10 秒緩衝。
- **這個路由目前沒有任何排程在呼叫。** 用哪一種排程，需要另外決定（見第 6 節）。

**仍在歸檔中的舊課程不會從總覽消失：** 總覽和排程 tick 原本只看前後一天的課程。現在也會納入還有歸檔工作沒完成的課程（例如 Drive 滿了好幾天），直到歸檔完成為止。

## 3. Google Drive 各種情況

| 情況 | 系統動作 | 總覽 |
|---|---|---|
| 成功 | 一份副本，名稱和資料夾正確，每個位元組都正確 | 已歸檔 |
| 5xx 或網路中斷 | 退避後重試：30 秒起，每次加倍，最長 30 分鐘；沿用同一個上傳 session，從 Drive 已收到的位元組接著傳 | 歸檔中 |
| 速率限制（429、403 `userRateLimitExceeded`） | 不早於 `Retry-After` 才重試；因為是 4xx，下次開新的 session 從頭傳 | 歸檔中 |
| 連續失敗 5 次 | `FAILED`，保留 Zoom 副本 | 歸檔失敗（`FILING_FAILED`，錯誤） |
| 容量不足（上傳前檢查，或上傳中出現 403 `storageQuotaExceeded`） | **暫停（BLOCKED），不消耗重試次數**，保留 Zoom 副本，每 30 分鐘再檢查一次；有空間後自動繼續。上傳中途遇到的，該 session 作廢，之後開新的 session 從頭傳 | 歸檔暫停（雲端硬碟空間不足）（`FILING_BLOCKED`，錯誤） |
| 授權失效（401、403 權限不足）或資料夾不見 | 同上，暫停到管理員處理好為止 | 原因分別顯示 |
| 上傳 session 過期（Drive 一週後失效） | 開新的 session 從頭傳；舊的半成品不會變成檔案 | 歸檔中 |
| Drive 只收了一部分，或 Zoom 少給一個位元組 | 一律以 Drive 確認的位元組為準，短少的那段重新下載 | — |
| Zoom 上已經沒有這個檔案（404） | 立刻 `FAILED`，不重試 | 歸檔失敗 |
| 重複檔案：上傳完成後當機、兩個 worker 搶同一筆工作、之前留下的多份 | 只保留最早一份核對過的，其餘移到垃圾桶；`STORED` 只記一次 | 已歸檔 |
| 資料夾裡已經有別人的同名檔案 | 不動那份檔案，我方改用下一個分段編號 | — |

Drive 和 Zoom 的 HTTP 回應如何分類（`classifyDriveResponse`、`classifyVendorResponse`），以及上傳 session 的狀態怎麼判讀（`driveUploadState`），都是依官方文件寫的，要等實測確認（見第 5 節）。

**2026-10-28 依官方上傳指南修正：** 指南寫明「For any 4xx errors (including 403) during a resumable upload, restart the upload」。所以現在只要上傳 session 收到任何 4xx，就作廢這個 session，下次從頭傳；5xx 則沿用原 session 接續。官方文件逐條對照見 [`p1-integration-test-plan.md`](p1-integration-test-plan.md) 第 2 節。

## 4. 驗收結果（合成資料，2026-10-28）

**合成驗收和實測驗收分開計算。** 以下全部是合成驗收，只能證明我方的邏輯正確。

| 要求 | 測試 | 結果 |
|---|---|---|
| 課堂識別 | `recording-filing.test.mjs`：我方課程歸檔、不明 session 留在 Zoom | 合成通過 |
| 錄影同意 | `webhook-ingest.test.mjs`：未同意、撤回前後、不明身分；`classroom-api.test.mjs`：完整課程流程 | 合成通過 |
| 檔案命名 | 單一學生、多位學生、P1 命名格式、月份資料夾 | 合成通過 |
| 分段編號 | 同一則通知亂序、跨通知接續、晚到的較早分段（編號不重複，並顯示 `PART_OUT_OF_ORDER` 警告）、同名的外部檔案 | 合成通過 |
| 重複事件防護 | 重送 3 次加上核對、內容順序不同的重送、503 後重送 | 合成通過 |
| 異常隔離 | `HOLD`、`_待確認`、`FAILED`、`BLOCKED`、`FILING_DELAYED`，總覽顯示原因 | 合成通過 |
| 背景處理 | 多次呼叫才傳完、不超過截止時間、**在任一步驟被停止（逐一測試每一步）**、反覆被停止時放棄、租約防護、60 組隨機情境（停止、Drive 與 Zoom 失敗、時間預算不同） | 合成通過 |
| Drive 情境 | 第 3 節每一列 | 合成通過 |
| 網站端 | 檔案型與 PostgreSQL store 的共同規約、排程路由的授權、容量不足後恢復、兩天後的舊課程仍留在總覽 | 合成通過 |

測試數字見提交時的回報。另外用 6 種刻意植入的錯誤檢查測試本身：其中 5 種都有測試抓到。第 6 種是「不採用 Drive 確認的位元組數」，它被「沒有進度就停止」與「下次從 Drive 狀態接續」兩道防護自動修正，最後結果仍然正確。

## 5. 尚未驗證的外部行為（需要實測）

**Zoom Video SDK：**
- `session.recording_completed` 的實際欄位：檔案 ID、`recording_type` 的值、副檔名、大小，以及是否提供 checksum。目前只核對大小。
- 下載網址是否支援 Range（分段下載）。下載用 `download_token` 還是 OAuth token；token 的有效期限。
- 停止後再開始錄影時，會產生幾個檔案、幾則通知。
- 雲端錄影自動刪除的天數。**這個天數必須長於歸檔可能暫停的最長時間**，例如 Drive 滿了沒人處理的那幾天。
- 刪除錄影的 API 與回應。

**Google Drive：**
- 上傳中途收到 403 之後，同一個 session 能否繼續傳。官方指南說 resumable 上傳遇到 4xx 要開新的 session；我方每次先查 session 狀態，查不到就開新的，所以兩種情況都能處理，但要實測確認。
- 每段大小要是 256 KiB 的倍數。目前預設 8 MiB，符合這個要求。查詢進度時 308 回應裡的 `Range` 格式，以及起始位置不符時 Drive 怎麼回應。
- 搜尋延遲：剛上傳的檔案多久才搜尋得到。
- **儲存空間：**
  - 一般 Google 帳號免費 15 GB；service account 沒有自己的空間，必須上傳到共用雲端硬碟，或代表某個使用者上傳。
  - 一堂 60 分鐘課的檔案大小還不知道（RT-6）。每月需要多少空間，**推測**是容量規劃的主要問題。

**Vercel：**
- 專案有沒有啟用 Fluid compute（推測）。有的話，Hobby 方案的函式最長可以執行 300 秒；沒有的話最長 60 秒。排程路由設成 60 秒，兩種情況都能用。
- Zoom → Vercel → Drive 的實際傳輸速度、流量費用，以及每次呼叫實際能搬多少。

## 6. 下一階段需要的決定與授權

每一項都要另外核准。

1. **排程方式**（讓 `/api/classroom/scheduled-tick` 每分鐘被呼叫）：

   | 選項 | 費用 | 需要的操作 | 備註 |
   |---|---|---|---|
   | Supabase `pg_cron` + `pg_net` | 不需新帳號 | 在正式資料庫啟用擴充功能、把密鑰放進 Vault、建立 cron job | **建議**。要改正式資料庫，所以需要授權；`pg_net` 目前是 beta |
   | Vercel Pro 方案的 Cron | 付費 | 升級方案，在 `vercel.json` 加上 `crons` | Hobby 方案的 Cron 一天只能跑一次，而且時間可能差到 59 分鐘，只能當每日安全網 |
   | GitHub Actions 排程 | 免費 | 新增 workflow | 實測過：標示每小時執行的排程，實際 2–10 小時才跑一次，不適合 |

   不論選哪一種，都要在 Vercel 加上 `CRON_SECRET` 環境變數。
2. **Google Drive 測試授權：** 用既有的測試帳號，以 `drive.file` 權限實作並驗收 Drive adapter，涵蓋分段上傳、查詢進度、session 過期、搜尋延遲。
3. **Zoom Video SDK 帳號與憑證：** 屬於另外計費的 Build Platform。用來實測通知欄位、Range 下載、自動刪除天數、刪除 API。
4. **錄影存放位置與空間方案：** 由 Justine 或 iHear 決定用哪一個帳號或共用雲端硬碟，以及需要多少容量。
5. **Migration 028（原 027，10/30 改號，027 給首頁行事曆）：** 本分支在 028 加了兩個欄位：`classroom_jobs.blocked_reason` 和 `classroom_recording_files.uploaded_bytes`。027 還沒有在任何正式環境執行過，要等 P3 核准後依既有程序上線。

## 7. 檔案

| 檔案 | 內容 |
|---|---|
| `classroom/recording-filing.mjs` | **新增**：分段搬移、時間預算、租約延長、失敗分類、Drive 與 Zoom 回應分類、worker 迴圈 |
| `classroom/webhook-ingest.mjs` | 歸檔程式移到上面的新檔（原本的匯入方式不變）；新增分段順序檢查 |
| `classroom/lesson-state.mjs`、`live-dashboard.mjs` | `BLOCKED`、`RESUMED`、`FILING_BLOCKED`、`FILING_DELAYED`、`PART_OUT_OF_ORDER`，以及暫停原因的文字 |
| `test/recording-filing.test.mjs` | **新增**：26 個合成驗收測試 |
| `dryrun/auto-filing-acceptance.mjs` | **新增**：12 個步驟的端到端驗收流程（合成），之後實測沿用同一份步驟 |
| `test/fake-classroom-store.mjs` | Drive 模擬加上容量、分段上傳、搜尋延遲；新增 Zoom 下載模擬、模擬時鐘、「函式被停止」開關 |
| `lib/classroom-store.ts`、`db/migrations/028_classroom_mvp.sql` | 新增 `recordTransfer`、`rescheduleJob`、`listOpenFilingLessonIds`；`failJob` 支援 `Retry-After`；新增兩個欄位 |
| `lib/classroom-drive.ts`、`lib/classroom-provider.ts` | 本機 Drive 替身改成分段上傳，並可設定容量；下載改成依範圍 |
| `lib/classroom-service.ts` | tick 的歸檔時間預算；仍在歸檔中的舊課程留在總覽 |
| `app/api/classroom/scheduled-tick/route.ts` | **新增**：排程用的 tick 路由 |
| `app/admin/classrooms/page.tsx` | 總覽卡片顯示暫停原因 |

## 來源

- Vercel Cron 方案限制：https://vercel.com/docs/cron-jobs/usage-and-pricing
- Vercel 函式時間與記憶體限制：https://vercel.com/docs/functions/limitations
- Google Drive resumable 上傳：https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Google Drive 錯誤處理：https://developers.google.com/workspace/drive/api/guides/handle-errors
- Supabase `pg_net`：https://supabase.com/docs/guides/database/extensions/pgnet
- Supabase 排程呼叫：https://supabase.com/docs/guides/functions/schedule-functions
