# P1 外部整合測試計畫（最小範圍）

| 項目 | 狀態 |
|---|---|
| 本文件 | 2026-10-28 版，外部整合**之前**的準備 |
| 已完成 | 本機實作與合成驗收，見 [`p1-auto-filing.md`](p1-auto-filing.md) |
| 本文件的每一項實測 | **都還沒做**，每一項都要另外授權 |
| 不在本計畫內 | 正式 Supabase、Vercel Production、正式 OAuth、Migration 027、任何付費資源、推送或部署 |

## 0. 隔離原則

- **只用合成資料：**
  - 只用 `TEST-` 代碼；
  - 影片是自製的測試畫面（P1 `test-env/make-test-media.mjs`），不拍真人；
  - Zoom 測試只用測試身分。
- **帳號：**
  - 只用測試帳號；
  - 不用 ihearprogram@gmail.com，不用 Justine 老師的帳號，也不用使用者的日常帳號。
- **執行環境：**
  - 本機的網站，加上用完即刪的 Docker PostgreSQL；
  - 不連正式資料庫，不用 Vercel Production。
- **憑證：**
  - 只放在本機的檔案裡，先限制好存取權限（ACL）才放進去；
  - 不寫進程式、日誌或報告。
- **每一階段結束都要收拾：**
  - 撤銷 token；
  - 刪除測試檔案和 Zoom 測試錄影；
  - 移除憑證檔。
- **出問題就停：** 任何一步失敗，立即停止，不自動重試，回報後再決定。

## 1. P1 與 P3 的相容性（2026-10-28 唯讀檢查）

| 檢查 | 結果 |
|---|---|
| Commit 關係 | `6d1912a`（P1 自動歸檔）建立在 P3 `917a488` 之上。P3 的 `61f78a3`、`969eba3` 和 P1 原型的 `58e6e10`、`b0c9b0f` patch-id 相同，是同一份變更 |
| `Core.js`、`Code.js` | 在 `b0c9b0f`、`917a488`、`6d1912a` 三個 commit 裡完全相同（blob `4f4ee23`、`f362fe4`）。命名規則沒有改 |
| 舊的 P1 原型分支 `b0c9b0f` | 是同步版、已過時的副本；之後以 `6d1912a` 為準，不要再從舊分支開發 |
| 資料模型 | Migration 027 在本機 PostgreSQL 17 上，跑完檔案型與 PostgreSQL 兩套共同規約（13 項），全部通過。新增的兩個欄位、事件來源 `p1`、檔案狀態、暫停原因與異常代碼，都符合 027 的 CHECK 條件 |
| RLS | 027 對 9 張 classroom 表都開啟 Row Level Security，而且沒有任何 policy，所以只有伺服器能存取。`schema_migrations` 也開啟 RLS。025、026 沒有新建資料表 |
| 編號 | 正式 main（`bd91928`）的 migration 到 026 為止。10/30 起 027 是首頁行事曆（`feat/home-calendar`），教室改為 028 |
| Migration 鎖定 | `migrate-database.mjs` 會記錄每個 migration 的 checksum，之後檔案一改就拒絕執行。**027 一旦在任何會保留的資料庫執行過，就不能再改，只能新增 028。** 依紀錄，027 只在用完即刪的測試資料庫跑過（推測沒有其他地方執行過；正式資料庫這次沒有查） |
| 資料庫稽核 | `audit-database.mjs` 會比對本機的 migration 檔和資料庫紀錄。含有 027 的程式如果先合併、但 027 還沒執行，稽核會回報「027 not tracked」。**027 和程式碼要在同一次發布上線**；備份與稽核的資料表清單也要一併加上 classroom 表 |
| 合併進正式 main | 直接合併有 10 個衝突，因為 P3 的基底是 P2 上線前的 `cf0cc1d`。如果只套用 classroom 相關的 commit（從 `cf0cc1d` 到 `6d1912a`），只剩 `package.json` 的測試指令清單 1 處衝突，兩邊合併即可。發布前要把 classroom 的 commit rebase 到當時的 main 上 |

## 2. Google Drive 官方文件對照（續傳）

來源：[Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[Resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)、[Search for files](https://developers.google.com/workspace/drive/api/guides/search-files)。

| 官方說法（原文） | 我方處理 | 合成測試 | 實測 |
|---|---|---|---|
| "A resumable session URI expires after one week." | 每次接續前先查 session 狀態；查不到就開新的 session 從頭傳 | 「過期的 session 開新的一個」 | D5 |
| "Create chunks in multiples of 256 KB … except for the final chunk" | 預設每段 8 MiB；只有最後一段可以較小 | — | D3 |
| "a `Range` header of `bytes=0-42` indicates that the first 43 bytes … were received" | `driveUploadState`：已收到 = 結尾位元組 + 1 | 「session 狀態依上傳指南判讀」 | D3、D4 |
| "If the response doesn't have a `Range` header, no bytes have been received." | 判讀為已收到 0 bytes | 同上 | D4 |
| "Don't assume that the server received all bytes sent in the previous request." | 一律從 Drive 確認的位元組接著傳；連續兩段沒有前進就結束這次嘗試 | 「Drive 只收了一部分」 | D4 |
| 查詢進度：對 session URI 送出空的 `PUT`，加上 `Content-Range: */size` | 由 adapter 實作 `uploadStatus` | 在模擬環境實作 | D4 |
| "A `200 OK` or `201 Created` response indicates that the upload was completed" | 判讀為完成，取得檔案 ID，再用檔案 ID 讀回、核對大小 | 「剛上傳的檔案依 ID 核對」 | D3 |
| "A `404 Not Found` response indicates the upload session has expired" | 判讀為 session 作廢（`SESSION_GONE`） | 同上 | D5 |
| "For any `4xx` errors (including `403`) during a resumable upload, restart the upload." | **2026-10-28 修正**：session 收到任何 4xx 都作廢，下次開新的 session | 「4xx 後重新開始，5xx 後接續」 | D5 |
| "For `5xx` errors, resume or retry uploads" | 沿用 session，退避後接續 | 「Drive 5xx 會退避並接續」 | 只能用合成測試 |
| `storageQuotaExceeded`（403）是儲存空間用完 | 暫停（BLOCKED），不消耗重試次數 | 「Drive 空間不足」兩項 | 實際很難製造，只做合成測試 |
| `userRateLimitExceeded`、`rateLimitExceeded`（403/429）：用指數退避重試 | 退避，不早於 `Retry-After` | 「速率限制」 | D9 |
| `authError`（401）："Refresh the access token" | **adapter 必須先自己 refresh token**；refresh 失敗才暫停（`DRIVE_AUTH`） | 「授權失效」 | D1 |
| `appProperties has { key='…' and value='…' }`，加上 `trashed = false` | 依此查詢 `providerFileId`，並且要讀完所有分頁 | — | D6 |
| 搜尋結果多久才更新：官方沒有說明 | 剛上傳的檔案用 ID 直接讀取，不依賴搜尋（推測可能有延遲，屬於預防措施） | 「搜尋延遲」 | D6 測量延遲 |
| 初始化之後對 session URI 的 PUT：官方範例沒有帶 Authorization | session URI 視同機密，不寫進日誌（推測它本身就具有上傳權限） | — | D3 確認 |

## 3. 最小整合測試

### 3.1 Google Drive（D1–D9）

> 2026-10-28 更新：實際操作步驟、工具和 D1～D9 的驗收條件，以 [`a1-drive-test-runbook.md`](a1-drive-test-runbook.md) 為準，內容比下表更精確。

**前提：**
- 在**測試帳號**底下建立一個 Google Cloud 專案和 OAuth client：
  - 同意畫面設為 External、Testing，測試使用者只有測試帳號；
  - 權限只要 `drive.file`。官方把它列為建議使用的 non-sensitive 權限，只能存取這個 app 建立或開啟的檔案。
- **Testing 狀態的 refresh token 7 天就失效**（[官方](https://developers.google.com/identity/protocols/oauth2)），所以每輪測試都要在 7 天內做完。

| 編號 | 內容 | 通過條件 |
|---|---|---|
| D1 | 授權並取得 refresh token；換發 access token；確認拿到的權限只有 `drive.file`；把 token 撤銷之後，確認 refresh 會失敗 | 拿到的權限正確；撤銷後 `invalid_grant` → 判定為 `DRIVE_AUTH` |
| D2 | 建立測試根資料夾，以及月份資料夾和 `_待確認` | 資料夾 ID 可以重複使用 |
| D3 | 用 256 KiB 分段上傳 1 MiB 的合成影片 | 中間回應都是 308，`Range` 判讀正確；最後回 200 或 201；`size` 和 `md5Checksum` 跟本機一致 |
| D4 | 傳 2 段後讓程序結束，查詢狀態後接著傳 | 從 `Range` 判讀出來的位元組接續；md5 一致；只有一個檔案 |
| D5 | 用不存在的 session URI；故意送錯起始位置的一段 | 第一種回 404 → 開新 session；第二種要**記錄 Drive 的實際回應**（官方沒有寫） |
| D6 | 用 `appProperties` 搜尋剛上傳的檔案，連續 10 次，記錄要多久才搜尋得到 | 用 ID 讀取一定找得到；記下搜尋延遲 |
| D7 | 讀取 `about.get` 的 `storageQuota` | 拿得到 `limit` 和 `usage`。不去真的把空間用完 |
| D8 | 造一份重複的副本，讓 worker 自己收斂 | 剩下一份；另一份移到垃圾桶；`drive.file` 權限可以把它移到垃圾桶 |
| D9 | 記錄 404、403、429 的實際錯誤內容（`reason`） | 跟 `classifyDriveResponse` 的判斷一致 |

**收尾：** 刪除測試資料夾，在 Google 帳號設定裡撤銷授權，刪除本機的 token 檔。

### 3.2 Zoom Video SDK（Z1–Z7）

**前提：**
- 一個 Video SDK（Build Platform）帳號。
  - 官方費率頁寫的是 Pay As You Go：年費 $0、每月含 10,000 分鐘、超過的部分每分鐘 $0.0035。但那一頁沒有日期，是 ©2021 的頁面，**現行價格要再確認**。
  - 雲端錄影是另外計費的加購項目。開發者論壇（非官方）說 Pay As You Go 每分鐘 $0.015。
  - **可能需要綁定付款方式，所以要先取得核准。**
- 需要的憑證：SDK key 和 secret、REST 用的 API key 和 secret、webhook secret token。
- 帳號設定照 [`zoom-account-check.md`](zoom-account-check.md) 檢查，例如自動錄影要關閉。

| 編號 | 內容 | 通過條件與要記錄的事 |
|---|---|---|
| Z1 | 用我方簽發的 JWT，讓兩個測試身分進入同一個合成 session | 成功入場；`user_key` 是參與者 ID |
| Z2 | 用我方的 provider 開始和停止 3 分鐘的錄影，畫面是分享的測試圖案 | REST 回應；確實收到開始與停止的確認 |
| Z3 | 先用 REST 查錄影清單（核對路徑，不需要 webhook），再看 `recording_completed` | 記錄實際的欄位名稱，例如 `recording_type`、副檔名、大小、checksum；和 `minimizeZoomEvent` 對照；記錄從停止錄影到「錄影完成」要多久 |
| Z4 | **下載**：確認下載要用哪種授權；用 `Range: bytes=0-262143` 測試 | 預期回 **206** 和 `Content-Range`。如果不支援 Range，見第 7 節風險 R1 |
| Z5 | 刪除錄影的 API | 回成功，查詢後確認已經沒有 |
| Z6 | 自動刪除天數和錄影相關設定 | 截圖存證；自動刪除天數要長於歸檔可能暫停的最長時間 |
| Z7（可選） | Webhook：URL 驗證、簽章、我方回 503 時 Zoom 會不會重送 | 需要一個公開的 HTTPS 網址，見第 4 節第 3 階段 |

**用量估計（推測）：** 約 10 次、每次 5 分鐘、2 人，約 100 分鐘的 session 用量，在每月包含的分鐘數內。雲端錄影約 50 分鐘，依非官方價格算，約 US$0.75。

### 3.3 排程（S1–S4）

| 編號 | 內容 | 環境 |
|---|---|---|
| S1 | 每分鐘呼叫 `/api/classroom/scheduled-tick`，連續 1 小時，同時有合成檔案在歸檔。另外刻意讓兩個排程同時呼叫 | 本機（不需要授權）。通過條件：沒有重複歸檔、沒有超時、結果摘要正確 |
| S2 | 密鑰錯誤回 401；沒有設定密鑰回 503；換密鑰的程序 | 本機 |
| S3 | 選定的排程服務實際每分鐘呼叫一次，持續 24 小時；記錄延遲、漏掉的次數、重複的次數 | 需要授權。如果用 Supabase：建議先在**另開的免費測試專案**測，不碰正式資料庫 |
| S4 | 停掉排程 60 分鐘，總覽要出現 `FILING_DELAYED`；恢復排程後要自動補上 | 同 S3 |

## 4. 完整驗收流程（錄影完成 → 下載 → Drive 續傳 → 歸檔 → 異常恢復）

12 個步驟都寫在 `dryrun/auto-filing-acceptance.mjs`：

1. 收到錄影完成通知；
2. 重送不會重複；
3. 一次傳不完時，分次傳；
4. 函式被停止；
5. 從 Drive 確認的位元組接續；
6. Drive 回 5xx；
7. Drive 空間不足就暫停；
8. 暫停期間不重試；
9. 恢復後重新開始；
10. 只有一份、命名正確、SHA-256 跟 Zoom 的原檔相同；
11. 歸檔之後才刪除 Zoom 的副本；
12. 總覽的異常解除。

每個階段都跑同樣的步驟，只是把替身換成真的服務：

| 階段 | Zoom | Drive | 觸發 | 授權 | 狀態 |
|---|---|---|---|---|---|
| 0 本機合成 | 替身 | 替身 | 測試程式 | 不需要 | **12/12 PASS（合成）** |
| 1 真的 Drive | 替身（提供合成影片） | 測試帳號 | 本機呼叫 | A1 | 未做 |
| 2 真的 Zoom 和 Drive | Video SDK 測試帳號；用 REST 核對代替 webhook | 測試帳號 | 本機呼叫 | A1、A2 | 未做 |
| 3 Webhook 和排程 | 同上，加上 webhook | 測試帳號 | 排程服務 | A1、A2、A3、A4 | 未做 |

- 第 6、7 步（Drive 5xx、空間不足）在實測環境沒辦法刻意製造，所以**一直維持合成驗收**，報告裡分開標示。
- 第 3 階段需要一個公開的 HTTPS 網址讓 Zoom 送 webhook。兩個選擇：
  - 臨時通道，例如 Cloudflare quick tunnel，不需要帳號，但會把本機暴露在網路上；
  - Vercel Preview 加上另一個測試資料庫。

  兩者都要另外核准；也可以先只靠 REST 核對，不測 webhook。
- **停止條件：** 任何一步不符合預期，就停止並回報，不自動重試，也不改設定繞過去。

## 5. 排程方式比較

| 方式 | 頻率與可靠性 | 需要的權限與變更 | 安全性 | 費用 |
|---|---|---|---|---|
| **Supabase `pg_cron` + `pg_net`** | 最短可以每秒一次。官方建議同時執行不超過 8 個 job，每個不超過 10 分鐘。`pg_net` 還是 beta，官方說可以穩定處理每秒最多 200 個請求；請求和回應存在 unlogged 表，資料庫當機時可能遺失，但下一分鐘會再呼叫。預設逾時只有 2000 ms，要調長 | **正式資料庫**：啟用兩個擴充功能、把密鑰放進 Vault、建立 cron job（要依 runbook 用 `psql -f` 執行） | 密鑰放在 Vault；官方說明 `net` schema 預設對 `PUBLIC` 開放 USAGE，要限縮；資料庫本身就能對外發送 HTTP，也是一種新的風險面 | 免費（各方案都有）。推測 |
| **Cloudflare Workers Cron Trigger** | 可以每分鐘一次；免費方案每個帳號最多 5 個排程、每天 10 萬個請求、每次 CPU 10 ms（等待 HTTP 回應不算 CPU）、單次最長 15 分鐘 | 在**既有的 Cloudflare 帳號**（目前管 DNS）新增一個 Worker | 密鑰放在 Worker 的 secret；和資料庫、Vercel 都分開，不會互相影響 | 免費方案 |
| Vercel Cron（Pro） | 每分鐘一次，準時到分鐘 | 升級 Pro，在 `vercel.json` 加 `crons`，然後部署 | Vercel 會自動帶 `CRON_SECRET` | 每個開發者席位每月 US$20 |
| Vercel Cron（Hobby） | **一天只能一次，而且可能差到 59 分鐘** | 修改 `vercel.json`，然後部署 | 同上 | 免費 |
| GitHub Actions 排程 | 實測過：標示每小時執行的排程，實際 2–10 小時才跑一次 | 新增 workflow；密鑰放 GitHub Secret | repo 是公開的，要特別小心 | 免費 |
| 外部排程服務（例如 cron-job.org、Upstash QStash） | 依各家服務 | 要開新的第三方帳號 | 密鑰交給第三方 | 免費或付費 |
| 現況：總覽一直開著 | 要靠人 | 不需要 | — | 免費 |

**建議（推測，要等 S3 實測確認）：**

1. **主要排程：Supabase `pg_cron` + `pg_net`，每分鐘一次。**
   - 理由：不用開新帳號、免費，而且排程就在資料所在的地方。
   - 要求：先在另開的免費測試專案通過 S3，再依 runbook 套用到正式資料庫。這一步要另外核准。
   - 套用時要做的設定：
     - `timeout_milliseconds` 設成 65,000 以上；
     - 收回 `net` 的 `PUBLIC` 權限；
     - 定期清理 `cron.job_run_details`。
2. **備用：Cloudflare Workers Cron Trigger。**
   - 如果不想讓正式資料庫多出對外連線的能力，可以改用它當主要排程。
   - 也可以每 5 分鐘呼叫一次，當作第二道保險；同時呼叫也安全，因為有租約保護。
3. **不建議：**
   - GitHub Actions：實測延遲太大。
   - 只為了排程而升級 Vercel Pro：要付費。
   - 外部 SaaS：要把密鑰交給新的第三方。

## 6. 下一階段的最小授權（每一項分開核准）

| 編號 | 內容 | 用途 | 不包含 |
|---|---|---|---|
| A1 | 在既有的 P1 測試帳號建立 Google Cloud 專案和測試用 OAuth client：Testing 狀態、只有 `drive.file` 權限、測試使用者只有這個帳號；token 放在權限限縮的本機檔案；7 天內用完並撤銷 | D1–D9；第 1、2 階段 | 正式 OAuth、發布同意畫面、ihearprogram@gmail.com |
| A2 | 建立 Zoom Video SDK 帳號（Pay As You Go），並決定由哪個帳號持有、能不能接受綁定付款方式，以及雲端錄影費用的上限（例如 US$5） | Z1–Z6；第 2 階段 | 現有的 Zoom Meetings 帳號設定、正式課程 |
| A3（可選） | 臨時 HTTPS 通道，或 Vercel Preview 加上測試資料庫 | Z7；第 3 階段的 webhook | Production |
| A4 | 排程實測：另開一個免費的 Supabase 測試專案；或用既有 Cloudflare 帳號新增一個測試 Worker | S3、S4 | 正式資料庫 |

**更後面才需要的（不在下一階段）：**
- 正式的 OAuth client 和同意畫面發布（可能需要基本驗證）；
- Zoom 的正式憑證；
- 錄影存放在哪個帳號、需要多少空間；
- 正式環境的排程和 `CRON_SECRET`；
- Migration 027 加上程式碼的合併與發布。

## 7. 仍存在的技術風險

| 編號 | 風險 | 影響 | 如何降低 |
|---|---|---|---|
| R1 | **不確定 Zoom 下載支不支援 Range** | 不支援的話，大檔案沒辦法分次傳，目前「每次搬一段」的設計就要改 | Z4 最先測。替代方案：同一次呼叫用串流一路傳完；Hobby 方案啟用 Fluid compute 時最長 300 秒，是否夠用要看檔案大小和速度（推測）。或者把搬移工作移到 Vercel 以外 |
| R2 | Zoom 下載 token 的效期、自動刪除天數 | token 過期就下載不了；Zoom 先刪掉就救不回來 | Z4、Z6；自動刪除天數要長於最長暫停時間 |
| R3 | Drive 在起始位置不符時怎麼回應；4xx 之後要從頭重傳 | 浪費流量和時間 | D5、D9 記錄實際行為 |
| R4 | `appProperties` 只有寫入它的 app 看得到；Testing 狀態的 token 7 天失效 | 換了 OAuth client，就找不到以前歸檔的檔案，重複防護會失效 | 正式環境固定用同一個 client，測試另外一個；正式環境要發布同意畫面 |
| R5 | 儲存空間：個人 Google 帳號 15 GB；service account 沒有自己的空間，要用 Workspace 的共用雲端硬碟 | 推測每月可能會滿 | 由 Justine 決定存放方式；用 RT-6 量測實際檔案大小 |
| R6 | Vercel：不確定有沒有 Fluid compute；影片會經過函式傳輸；**Hobby 方案的定位是「personal, non-commercial use」** | 時間不夠用；方案是否合規（推測，需確認） | 實測吞吐量；確認方案 |
| R7 | `pg_net` 是 beta；用 unlogged 表；預設逾時 2 秒；`net` 預設對 `PUBLIC` 開放 | 呼叫遺失；權限太寬 | 下一分鐘會再呼叫；調整逾時；收回權限；`FILING_DELAYED` 會發出警示 |
| R8 | Migration 027 的上線順序和 checksum 鎖定 | 稽核失敗；027 一旦執行就不能再改 | 027 和程式碼同一次發布；稽核和備份清單加上 classroom 表 |
| R9 | P3 的基底是 P2 上線前的版本 | 合併時會有衝突 | 發布前把 classroom 的 commit rebase 到 main（只剩 1 個小衝突） |
| R10 | 錄影同意政策還沒定案 | 不能用真實課程測試 | 等 Justine 決定 |
| R11 | 本機 C 槽只剩約 2.8 GB；page file 一直變大；Docker 裡有其他專案在跑 | 測試變慢、逾時；沒有空間建置網站 | 見清理清單（由你決定） |

## 來源

- Google Drive：
  - 上傳：https://developers.google.com/workspace/drive/api/guides/manage-uploads
  - 錯誤處理：https://developers.google.com/workspace/drive/api/guides/handle-errors
  - 搜尋：https://developers.google.com/workspace/drive/api/guides/search-files
  - 權限範圍：https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Google OAuth（Testing 狀態下 refresh token 的效期）：https://developers.google.com/identity/protocols/oauth2
- Supabase：
  - Cron：https://supabase.com/docs/guides/cron
  - pg_net：https://supabase.com/docs/guides/database/extensions/pgnet
- Cloudflare Workers：
  - 排程：https://developers.cloudflare.com/workers/configuration/cron-triggers/
  - 限制：https://developers.cloudflare.com/workers/platform/limits/
- Vercel：
  - Cron：https://vercel.com/docs/cron-jobs/usage-and-pricing
  - 函式限制：https://vercel.com/docs/functions/limitations
  - 價格：https://vercel.com/pricing
- Zoom Video SDK 費率（官方頁面，未標日期）：https://explore.zoom.us/docs/en-us/video-sdk-rates.html
- Zoom 雲端錄影價格（開發者論壇，非官方）：https://devforum.zoom.us/t/pricing-for-zoom-video-sdk-recording-module/97925/4
