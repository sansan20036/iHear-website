# Recording Adapter：P1 與視訊供應商之間的介面

| 項目 | 狀態 |
|---|---|
| 本文件 | 2026-10-31 版 |
| 分支 | `feat/p1-p3-recording-adapter`，以 `26a4434` 為基底 |
| 程式 | [`classroom/recording-adapter.mjs`](../classroom/recording-adapter.mjs) |
| 驗證 | **只有合成資料的本機測試**，加上本機一次性的 PostgreSQL 容器。沒有連到任何視訊服務、Google Drive、正式資料庫或 Vercel |

相關文件：
- [`p1-auto-filing.md`](p1-auto-filing.md)：P1 歸檔的流程與 Drive 處理
- [`p1-p3-handoff-spec.md`](p1-p3-handoff-spec.md)：P1↔P3 交接規格
- [`recording-failure-rules.md`](recording-failure-rules.md)：失敗處理規則

## 1. 為什麼要有這一層

P1 原本只認得 Zoom：要歸檔哪一種錄影，是用 Zoom 的 `recording_type` 名稱判斷的。P3 可能改用 LCIC 或其他廠商，所以把「廠商的通知」和「P1 的歸檔」分開：

```
視訊供應商的通知（Zoom webhook、LCIC callback、API 對帳）
  → Recording Adapter：normalize，轉成統一的錄影事實，並通過 validateRecordingFact
  → P1：事件和歸檔工作寫進同一個交易
  → worker：檢查同意 → 去重 → 分段下載與上傳 → 核對大小 → 記錄結果
  → Google Drive：月份資料夾；撤回同意前錄到的內容放到 _待確認
  → Recording Adapter：deleteVendorCopy，只在 STORED 之後才刪除廠商的副本
```

每個廠商的 adapter 只做三件事，P1 對廠商的其他事情一概不知：

| 成員 | 作用 | 在網站裡的位置 |
|---|---|---|
| `normalize(notice)` | 把廠商自己的通知轉成錄影事實 | `classroom/webhook-ingest.mjs`（Zoom）、`classroom/lcic-callback.mjs`（LCIC） |
| `download(record, range)` | 讀取已完成錄影的一段位元組。每次都向廠商重新取得位址，不保存任何簽名連結 | `lib/classroom-vendors/*` 的 `download()` |
| `deleteVendorCopy(record)` | 檔案存好並核對無誤之後，刪除廠商的副本 | `lib/classroom-vendors/*` 的 `deleteRecording()` |

## 2. 統一的錄影事實

這就是 P3 交給 P1 的資料。事件類型沿用第一個廠商的名稱 `session.recording_completed`，意思是「這個 session 的錄影檔已經可以下載」。

| 欄位 | 內容 |
|---|---|
| `provider` | 廠商，必須是登錄表裡的名稱（第 4 節） |
| `lessonId` | iHear 的課程 ID。網站建立 session 時帶入（Zoom 的 `session_key`、LCIC 的教室對照表）。不是我們的 session 時為 `null` |
| `providerSessionId` | 廠商的 session ID |
| `occurredAt` | 錄影完成的時間：取各檔案結束時間的最大值，沒有就用通知時間 |
| `receivedAt` | 我們收到通知的時間 |
| `key` | 依內容意義算出的去重鍵：同一批檔案，不論重送幾次、或由對帳再找到一次，鍵都相同 |
| `files[].providerFileId` | 錄影檔 ID，跨廠商唯一（第 4 節的前綴規則） |
| `files[].kind` | 中性類型：`composite`（合併的課程影片）、`audio`、`chat`、`transcript`、`other`。**只歸檔 `composite`** |
| `files[].extension`、`size` | 副檔名（小寫）與位元組數。P1 用 `size` 核對 Drive 上的副本 |
| `files[].status`、`recordingStart`、`recordingEnd` | 廠商回報的狀態，以及錄影起訖時間（毫秒） |

**檔案位置不是網址。** 位置就是「廠商 + `providerFileId`」，adapter 下載時才向廠商查詢實際位址。這樣資料庫裡不會有可以直接下載影片的簽名連結。

## 3. 檢查規則（`validateRecordingFact`）

- `provider` 必須在登錄表裡。
- `lessonId` 只能是英數字和 `-`，最多 36 字，或是 `null`。
- 至少一個檔案。`providerFileId` 1～200 字，而且要有該廠商的前綴。
- `kind` 必須是中性類型；`extension` 只能是小寫英數字，最多 5 字。
- `size` 是 0 以上的整數，而 **`composite` 必須至少 1 位元組**：大小不明的課程影片無法核對，P1 不收。
- 時間是毫秒或 `null`，開始不能晚於結束。
- 任何層級都不能出現姓名、email、網址、token、密碼或主題這類欄位（依鍵名判斷）。

**不符合時：**
- 整批拒收，回 **422**。同一批裡合格的事實也不寫入。
- 另外寫一筆 `server.recording_refused` 事件：只記下來源、課程、廠商 session 和問題清單，**不含檔案內容**。同一則通知重送，也只記一次。
- 總覽立刻出現錯誤等級的異常 `RECORDING_REFUSED`，並通知管理員。不必等 6 小時後才以「錄影檔逾時未到」被發現。

## 4. 廠商登錄表（`VENDORS`）

| 廠商 | 檔案 ID 前綴 | 類型對照 | 下載 | 刪除副本 |
|---|---|---|---|---|
| `zoom-video-sdk` | 無（第一個廠商，沿用原始 ID） | `shared_screen_with_speaker_view` → `composite`；`audio_only` → `audio`；`chat_file` → `chat`；`audio_transcript`、`closed_caption` → `transcript` | 已實作，未用真實錄影驗證；從檔案自己的 session 下載，核對 `Content-Range` | **未接上**：官方有刪除 API（`DELETE …/recordings/{id}?action=trash`），刻意不接，回 501 |
| `tencent-lcic` | `lcic-` | `lcic_mixed` → `composite` | 已實作，未驗證；核對 `Content-Range` | 已實作（`DeleteRecord`），未驗證；**刪除開關關閉時不送出**（預設關閉） |
| `synthetic` | 無 | 中性類型本身，以及 Zoom 的類型名稱 | 本機合成 | 本機合成 |

- 沒列出的類型一律是 `other`，不歸檔。
- 查表只看自己的鍵：`constructor`、`__proto__` 這類名稱不會被當成類型或廠商。
- `recording_files` 只用 `provider_file_id` 當主鍵（migration 028），所以第一個廠商之後的每個廠商都要加上自己的前綴。

## 5. 新增一個廠商

1. 在 `VENDORS` 加上類型對照和檔案 ID 前綴。
2. 寫 `normalize`，加進 `test/fake-recording-adapter.mjs`。`recording-adapter.test.mjs` 和 `p1-p3-simulated.test.mjs` 都要通過；後者會確認「同一堂課換這個廠商，P1 的結果完全相同」。
3. 在 `lib/classroom-vendors/` 實作 `download()` 和 `deleteRecording()`。
4. 把它的通知來源名稱加進 `lesson-state.mjs` 的 `CONFIRMING_SOURCES` 和 `SOURCE_RANK`，總覽才會把它當成「已確認」。
5. 資料庫：`classroom_recording_files.provider` 和 `classroom_events.source` 的 CHECK 都要允許它。這要另外提案，見整合計畫。
6. 用真實錄影確認：類型名稱、大小的單位、是否支援 Range、刪除 API。

## 6. 測試（合成，2026-10-31）

| 測試 | 數量 | 內容 |
|---|---|---|
| `test/recording-adapter.test.mjs` | 10 | 三種 adapter 和對帳的輸出都符合規則；類型對照；登錄表；去個資；18 種不符合的寫法各自指出路徑；LCIC 沒有大小時拒收；整批拒收並記錄一次；總覽與通知；adapter 成員檢查；LCIC 對帳的已知限制 |
| `test/p1-p3-simulated.test.mjs` | 13 | 同一堂課經 Zoom、LCIC、合成廠商三種 adapter，Drive 結果完全相同；介面欄位；命名與分段；去重（重送 3 次加 1 次對帳）；同意與撤回；不明 session；短暫失敗重試；廠商檔案已不存在；在 20 個不同位置強制停止 worker；Drive 空間不足後恢復；無法刪除副本；LCIC 通知在總覽算已確認；Zoom 通知不符合規則 |
| `tests/classroom-store.test.mjs` | +1 | `databaseProvider`：028 的廠商名稱對照；不在名單上的廠商（包括 `__proto__`）一律拒絕 |
| `tests/classroom-postgres.test.mjs` | +1 | 一次性 PostgreSQL：Zoom 存成 `zoom`、合成存成 `synthetic`；LCIC 在 028 上整批拒收；大小不明的影片只留下拒收紀錄 |

**突變測試：** 4 項。把 LCIC 從確認來源移除、拿掉影片大小規則、不記錄拒收、拿掉 `fileColumns` 的廠商名稱對照，對應的測試都會失敗。最後一項只有 PostgreSQL 測試抓得到，檔案型 store 測不出來。

**這些測試不能證明的事：** 任何廠商的實際欄位和時序、Range 支援、大小單位、刪除 API；Google Drive、PostgreSQL 正式環境或 Vercel 的實際行為。

**第三階段的本機修正（2026-10-31）：**
- 沒有 webhook 時，Zoom session ID 的取得與確認（P-1）；
- 已結束 session 的查詢（P-2）；
- 一堂課有多個 session（P-3）；
- ID 雙重編碼（P-4）；
- 下載錯誤分類與大小核對（P-5、P-7）；
- 附屬檔未完成時的處理（P-8）；
- 測試執行器與 Google Drive 串接。

對應測試：`test/p3-polling.test.mjs`、`tests/classroom-vendors.test.mjs`、`tests/classroom-api.test.mjs`、`tests/classroom-drive-google.test.mjs`、`tests/classroom-recording-test.test.mjs`。執行器說明見 `docs/classroom-recording-test.md`。

## 7. 已知限制

- **廠商副本一律保留：** 刪除開關（`CLASSROOM_VENDOR_DELETION`）預設關閉（2026-10-31）。歸檔完成後，刪除工作不呼叫廠商，直接記下 `p1.vendor_copy_kept` 後結束。副本留到廠商自己的自動刪除。
- **刪除重複執行（開關打開以後才會發生）：** worker 在廠商刪除成功之後、工作完成之前被中斷時，下一次會再刪一次。廠商若對已刪除的檔案回 404，這個工作會被視為失敗。
- **大小單位：** 下載時，會把 `Content-Range` 的總長度和通知裡的大小比對。不同就立即判定歸檔失敗（`SIZE_MISMATCH`），並保留原檔（2026-10-31）。LCIC 的 `RecordSize` 和 Zoom 的 `file_size` 的單位，仍要用真實錄影確認。缺少大小的情況已經會被拒收。
- **LCIC 的對帳找不到錄影：** `DescribeRoom` 的回應還沒有大小和狀態。
- **migration 028 只允許 `zoom`、`synthetic`，以及 Zoom 和我方自己的事件來源：** LCIC 的錄影在 PostgreSQL 上會整批拒收。程式明確拒絕，不會改標成其他廠商。
- **月份資料夾名稱寫著 `Zoom Recordings`：** 沿用 P1 的 `Core.monthlyFolderName`，其他廠商的錄影也會放進這個名稱的資料夾。要不要改名，待決定。
