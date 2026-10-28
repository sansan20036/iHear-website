# P1↔P3 交接規格（線上教室 MVP）

| 項目 | 狀態 |
|---|---|
| 本文件 | 設計規格，2026-10-25 版 |
| 程式 | `classroom/*.mjs` 是**合成原型**，用來驗證規則；不是正式網站程式 |
| 驗證 | 只有合成資料的本機測試，見 [`p3-mvp-acceptance.md`](p3-mvp-acceptance.md)；尚未連到 Zoom |
| 正式網站、資料庫 | 都沒有修改；下面的資料表只是設計，等 P2 上線後依既有程序建立 |

相關文件：
- [`live-classroom-dashboard.md`](live-classroom-dashboard.md)：管理員即時教室總覽
- [`recording-failure-rules.md`](recording-failure-rules.md)：失敗處理規則
- [`p1-auto-filing.md`](p1-auto-filing.md)：P1 自動歸檔的實作與合成驗收（2026-10-28）
- [`zoom-account-check.md`](zoom-account-check.md)：Zoom 帳號查核
- [`p3-mvp-acceptance.md`](p3-mvp-acceptance.md)：MVP 驗收清單

標示說明：
- **待 Justine 決定**：政策選擇，表中寫的是建議預設值。
- **待官方文件確認**：官方文件沒寫清楚。
- **待實測**：要用真實的 Zoom 帳號測過才知道。

## 1. 分工

| | 負責 |
|---|---|
| P1 | 錄影同意、權限、保存期限、自動命名、存進 Google Drive、異常處理 |
| P3 | 每堂課一間獨立教室、視訊；P1 確認同意後，自動開始雲端錄影；管理員即時教室總覽 |

- 兩者都放在網站後端，和 P2 是同一個 Next.js 程式。命名規則直接重用 `apps-script/Core.js`。
- 廠商事件由 P3 轉成我們自己的格式後，才交給 P1，所以 P1 完全不認得 Zoom。改用 Daily 時，P1 不必修改。

## 2. 識別碼

所有送到 Zoom 的識別碼，都只用代碼，不放任何姓名。

| 我們的識別碼 | 用途 | 對應 Zoom |
|---|---|---|
| `lessonId`（最多 36 字） | 每堂課一筆 | JWT 的 `session_key`；webhook 會帶回 `session_key` |
| `roomName` = `ihear-` 加上小寫的 `lessonId` | 教室（session）名稱 | JWT 的 `tpc` |
| `participantId`（最多 36 字） | 名單上的每一個人 | JWT 的 `user_key`；webhook 會帶回 `user.user_key` |
| 角色 | `tutor`、`student`，以及之後才會用到的 `observer` | 小老師是 `role_type` 1（主持人），其他人是 0 |
| `providerSessionId`、`participantUuid`、`providerFileId` | Zoom 那一端的編號 | `session_id`、`participant_uuid`、錄影檔的 `id` |

教室畫面上要顯示什麼名字，待 Justine 決定。總覽和紀錄一律只用代碼。

## 3. 兩個資格判斷，彼此獨立

> 原則：家長沒有同意錄影時，課程照常進行，但整堂不錄影。

### 3.1 `getJoinEligibility()`：能不能進教室

只檢查以下四件事，**不看錄影同意**：
1. 課程存在，而且沒有取消。
2. 身分已經驗證：
   - 小老師要登入網站，而且必須是這堂課指派的人；
   - 學生用個人專屬入場連結或帳號（待 Justine 決定採用哪一種）。
3. 在這堂課的名單上。
4. 在入場時間內：開課前 15 分鐘到下課後 15 分鐘。

**不符合時：**
- 任何一項不符合，或者檢查本身出錯，都不發入場憑證。
- 回 403，附原因代碼：`LESSON_NOT_FOUND`、`LESSON_CANCELLED`、`NOT_ON_ROSTER`、`IDENTITY_UNVERIFIED`、`OUTSIDE_JOIN_WINDOW`、`OBSERVER_NOT_ENABLED`、`CHECK_FAILED`。
- 寫入一筆 `server.join_blocked` 事件。總覽只顯示次數。
- 通知管理員。

**通過時：** 簽發 Video SDK JWT。
- `role_type`；
- `tpc`；
- `session_key`；
- `user_key`；
- `iat`；
- `exp` 等於 `iat` 加 1800 秒，這是 Zoom 允許的最短效期；
- 小老師另加 `cloud_recording_option: 0`，只錄成一個合併影片。設成 1 會變成每人各一個檔，而且要另外請 Zoom 開啟。
- 只保存憑證的 SHA-256 雜湊值和到期時間。斷線重連時重新簽發。

### 3.2 `getRecordingEligibility()`：整堂課能不能錄（由 P1 提供）

**判斷方式：**
- 依**整份名單**判斷，下列條件全部成立才可以錄：
  - 每位學生都有有效的家長同意：狀態是已同意、版本符合目前的同意書、沒有撤回、也沒有過期；
  - 小老師已確認工作人員的錄影告知。
- 任何一項不符合，或者檢查本身出錯，整堂課都不錄影（`BLOCKED`），但**上課完全不受影響**。
- 開課前 15 分鐘做出決定，寫成 `server.recording_eligibility` 事件。

**原因代碼：**
- `CONSENT_MISSING`
- `CONSENT_WITHDRAWN`
- `CONSENT_EXPIRED`
- `CONSENT_VERSION_MISMATCH`
- `STAFF_NOTICE_MISSING`
- `ROSTER_INCOMPLETE`
- `LESSON_NOT_FOUND`
- `CHECK_FAILED`

結果只附人數，不會指出是哪一位學生。

**其他規則：**
- 開始錄影之前就決定好，不會先錄、之後再暫停。
- 同意如果到課中才補齊，這堂課仍然不錄（預設，待 Justine 決定）。

## 4. 錄影啟停

**誰能啟動：** 只有伺服器能啟動錄影，而且要同時符合四個條件：
- `getRecordingEligibility()` 判定可以錄；
- 沒有人撤回同意；
- session 已經開始；
- 小老師和至少一位學生都已經被確認在教室裡。

**怎麼啟動：**
- 主要做法：呼叫 REST `PATCH /v2/videosdk/sessions/{sessionId}/events`，內容是 `{"method":"recording.start"}`（限流等級 MEDIUM）。
- 備援做法：主持人端呼叫 `startCloudRecording()`。
- 官方文件寫明，這兩種做法的呼叫者都必須是 host 或 manager。伺服器端能不能直接啟動，**待實測**。

**送出之後：**
- 收到 202，只表示「已送出錄影啟動請求」，**不代表已經開始錄影**。
- 要收到以下任一項，才算「錄影中」：
  - 簽章正確的 `session.recording_started`；
  - 簽章正確的 `session.recording_resumed`；
  - 主持人端 SDK 回報 `RecordingStatus` 為 `Recording`。
- 目前沒有官方 API 能查詢「現在是否正在錄影」。session 詳情裡的 `has_recording` 是什麼意思，**待實測**。

**重試：**
- API 回錯誤時，最多試 3 次，間隔分別是 10 秒和 30 秒，三次都失敗就判定 `FAILED`。
- 收到 202，但 2 分鐘內沒有任何確認時：
  - 標示「錄影失敗（推測）」；
  - 再送一次 start。

### 4.1 狀態機（總覽也用同一套）

```
NOT_REQUESTED ──start──▶ START_REQUESTED ──Zoom 確認──▶ RECORDING ⇄ PAUSED
      │                       │                            │
      │                       └─失敗或未確認─▶ FAILED        └─Zoom 確認停止─▶ STOPPED ─▶ COMPLETED
      └─同意條件不符─▶ BLOCKED                  （session 結束但沒有停止通知 ▶ POSSIBLY_STOPPED〔推測〕）
```

暫停、繼續、停止，也都是先「送出請求」，等 Zoom 確認後才轉換狀態。

### 4.2 Zoom 帳號必須做的錄影設定（取得授權後設定並截圖）

| 設定 | 要求 | 原因 |
|---|---|---|
| Automatic recording | **關閉** | 官方說明：開啟後，session 一開始就自動錄到雲端，會繞過同意檢查 |
| Participants can start cloud recording when host is not in the meeting | **關閉** | 不讓學生自行開始錄影 |
| Participants can request host to start cloud recording | **關閉** | 錄影只能由我們的伺服器決定 |
| Allow hosts to record and save the session in the cloud | 開啟 | 沒有開啟就無法雲端錄影 |
| Display participants' names in the recording | 建議關閉（待 Justine 決定） | 避免把姓名錄進畫面 |
| Save chat messages from the session | 建議關閉（待 Justine 決定） | 聊天內容可能有個資 |
| Delete cloud recordings after N days | 開啟；N 要大於歸檔最長可能花的時間（待 Justine 決定） | 萬一歸檔失敗也會自動清掉，但絕不能早於歸檔完成 |

**兩道防線：**
- 設定錯了：如果發生沒有核准紀錄的 `recording_started`，就標記 `UNAPPROVED_RECORDING_START`，列為錯誤。這堂課如果不能錄，就啟動第 5 節的停止保護程序。
- 小老師按了主持人自己的錄影按鈕：網站的教室畫面不提供這顆按鈕。萬一還是發生了，處理方式也一樣。

## 5. 上課途中撤回同意：停止保護程序

最優先的目標，是**不再錄到未同意的人**。

1. **撤回生效。** P1 記下撤回的時間，寫成 `server.consent_withdrawn` 事件。從這一刻起，整堂課都不能再錄。
2. **同時下兩道停止指令：**
   - 伺服器呼叫 REST `recording.stop`；
   - 主持人端呼叫 `stopCloudRecording()`。錄影期間，主持人端每 10 秒向伺服器確認一次是否仍允許錄影。
3. **等待確認，最多 30 秒。** 確認的來源可以是：
   - webhook `session.recording_stopped` 或 `paused`；
   - 主持人端 SDK 回報 `Stopped`；
   - 從 API 查到 session 已結束。
4. **停止失敗時的保護措施：**
   - 30 秒仍沒有確認：再送一次停止指令。
   - 60 秒仍沒有確認：伺服器呼叫 `PUT /v2/videosdk/sessions/{sessionId}/status`（end），直接結束 session。session 一結束，錄影一定跟著停止。
   - 結束後，師生自動重新進入同一堂課的新 session，繼續上課。這堂課已經標記為不能錄，帳號層級的自動錄影也是關閉的，所以新 session 不會錄影。
5. **已經產生的錄影檔：**
   - 一律標記，不放進正式資料夾。
   - 只要內容超過撤回時間，就絕不上傳，保留在 Zoom 端等管理員決定（`HOLD`）。
   - 全部在撤回之前錄的檔案，隔離到 `_待確認`（`QUARANTINED`）。要保留還是刪除，待 Justine 決定。
6. **通知與紀錄：**
   - 立即通知管理員。
   - 每一步都寫成事件，供稽核使用。
   - 要求結束 session 已經 60 秒，仍無法確認錄影停止時，標記 `WITHDRAWAL_STOP_UNCONFIRMED`，列為錯誤，並通知管理員。

**不明身分的參與者：** 出現沒有有效入場紀錄的 `user_key` 時：
- 主持人端把對方移出教室，並標記 `UNKNOWN_PARTICIPANT`。
- 如果正在錄影，就走同一套停止保護程序。
- 對方加入之後才錄到的檔案，一律 `HOLD`。

## 6. Webhook 與事件持久化

端點：`POST /api/recordings/zoom/webhook`。

**Zoom 官方的送達規則：**
- 必須在 3 秒內回 200 或 204。
- 遇到 5xx、連線逾時或連線被拒，Zoom 會再送 3 次：5 分鐘後一次，再隔 20 分鐘一次，再隔 60 分鐘一次。
- 3xx 和 4xx 一律不重送。
- 官方沒有說明重送的內容是否和第一次完全相同。
- 端點每 72 小時會被重新驗證一次。連續失敗 6 次，Zoom 就停用這個訂閱。

**我們的處理順序：**
1. **驗證簽章和時間戳。** 簽章計算方式是 `x-zm-signature = v0=HMAC_SHA256(secret, "v0:{timestamp}:{raw body}")`，以 timing-safe 方式比對，時間差必須在 ±5 分鐘內。
   - 驗證失敗就回 401，Zoom 不會重送。
   - 連續失敗時通知管理員。漏掉的事件靠狀態重新核對補回。
2. **處理端點驗證：** `endpoint.url_validation` 要回傳 `plainToken`，以及 `encryptedToken = HMAC_SHA256(secret, plainToken)`。
3. **去除個資。** 寫入資料庫之前，先丟掉姓名、電話、IP、裝置、`download_url`、`download_token`、`file_name` 和 `file_path`。
4. **計算語意去重鍵。** 鍵由事件的意義組成，不依賴原始內容的雜湊，例如：
   - `session.user_joined:{session}:{participant_uuid}:{join_time}`；
   - `session.recording_completed:{session}:{排序後的檔案 id}`。

   API 核對查到的同一件事，也會產生同一把鍵。
5. **同一個交易內寫入：** 事件本身（`INSERT … ON CONFLICT DO NOTHING`），以及後續工作（outbox）。
   - 錄影完成時，每個檔案都建立一筆 `recording_files`，以及一筆歸檔工作。
   - 交易的語句逾時設為 2 秒，留在 Zoom 的 3 秒限制之內。
6. **commit 成功才回 200，** 重複的事件也回 200。資料庫出錯或逾時就回 503，讓 Zoom 重送。逾時後才遲到的 commit 不會造成重複，因為去重鍵會擋下。
7. **不使用記憶體佇列，也不在請求裡面歸檔。**
   - worker 從 `classroom_jobs` 領取工作，帶有租約（5 分鐘）和防護號，記錄嘗試次數，失敗後依退避時間重試：30 秒起，每次加倍，最長 30 分鐘。
   - 每分鐘的排程（Vercel Pro）、總覽輪詢、下一筆 webhook，都可以喚醒 worker。
   - 結果正不正確，只取決於資料表的內容。

**小老師端回報：** `POST /api/classroom/{lessonId}/host-events`。
- 必須登入，而且是這堂課的小老師。
- 回報類型：`heartbeat`、`recording_status`、`user_added`、`user_removed`、`connection`、`participant_failover`。
- 一樣先寫入資料庫，再回 200。
- 瀏覽器回報的時間和伺服器差超過 5 分鐘時，改用伺服器時間。
- 心跳不算歷史紀錄，每堂課只保留最新一筆。

### 6.1 我們自己的事件格式（與廠商無關）

| 欄位 | 說明 |
|---|---|
| `type` | Zoom 事件名（例如 `session.user_joined`）、`host.*`、`api.snapshot`、`server.*`、`p1.filing` |
| `source` | `zoom_webhook`、`zoom_api`、`host_sdk`、`server`、`p1` |
| `lessonId`、`providerSessionId`、`participantId`、`participantUuid` | 只有代碼 |
| `occurredAt`、`receivedAt` | 事件實際發生的時間，以及我們收到的時間 |
| `status`、`state`、`leaveReason`、`files[]`、`issues[]` | 依事件類型而定。`files[]` 只有 `providerFileId`、種類、副檔名、大小、狀態、起訖時間 |
| `key` | 語意去重鍵 |

## 7. 存進 Drive（P1）

**檔名：** 由 `Core.js` 產生，用的是 `baseName`、`fileName`、`nextPart`、`cleanName`、`monthlyFolderName`。
- 範例：`2026-11-03_TEST-S001_TEST-T001_P01.mp4`，放在 `[iHear] 11.2026.Zoom Recordings`。
- 檔名用代碼還是姓名，待 Justine 決定。
- 檔名在錄影完成事件寫入的同一個交易裡就決定好，所以重試時不會變。

**保留哪些檔案：** 只保留合併的 MP4（`recording_type` 預期是 `shared_screen_with_speaker_view`，**待實測**）。純音訊等其他檔案只記錄、不上傳。

**檔案的去向：**

| 情況 | 處理 |
|---|---|
| 一般 | 上傳到月份資料夾，標記 `STORED` |
| 整堂判定不能錄（`NO_CONSENT`） | `HOLD`：不上傳，留在 Zoom 端等管理員處理 |
| 內容超過撤回時間（`AFTER_WITHDRAWAL`） | `HOLD` |
| 不明身分的人加入之後錄到的（`UNKNOWN_PARTICIPANT`） | `HOLD` |
| 不在我們排課表上的 session（`UNKNOWN_SESSION`） | `HOLD` |
| 全部在撤回之前錄的（`CONSENT_WITHDRAWN`） | 隔離到 `_待確認`，標記 `QUARANTINED` |

**不會重複歸檔：**
- **唯一鍵：** `recording_files` 以「廠商 + 檔案 id」作為唯一鍵；歸檔工作的 id 是固定的 `file:{providerFileId}`。
- **租約與防護號：**
  - worker 領取工作時，會拿到新的防護號（`lease_version`）。
  - 寫入 `STORED` 時必須帶著這個號碼（`WHERE lease_version = 我的號碼`）。
  - 租約已過期的舊 worker 寫不進去。這時它會去查 Drive，看到別的 worker 已經存好，就把自己多傳的那份移到垃圾桶。
- **上傳前先查：** 用 Drive 的 `appProperties.providerFileId` 查詢。如果已經有一份通過核對的檔案，就直接採用。所以上傳完成後、寫入資料庫前當機，重試時會找到那份檔案，不會再傳一次。
- **續傳：** resumable 上傳的 session 網址存在 `recording_files`。上傳中斷後，接續同一個上傳 session，不另開新檔。
- **上傳後再查一次：** 如果同一個 `providerFileId` 有好幾份，只保留最早一份通過大小（及 md5）核對的，其他的移到垃圾桶，並記錄下來。
- **刪除 Zoom 上的副本：** 只有在 `STORED` 之後，才建立刪除 Zoom 副本的工作。刪除用哪一支 API，**待官方文件確認**。

**下載：**
- webhook 附帶的 `download_token` 只有 24 小時效期，而且不保存。
- 歸檔時改用 `GET /v2/videosdk/sessions/{sessionId}/recordings` 取得新的下載網址（限流等級 LIGHT）。
- 下載內容直接串流到 Drive 的分段上傳，不留在我們的伺服器。這樣也避開 Vercel 函式的時間上限：Hobby 300 秒、Pro 800 秒。

**失敗：** 歸檔試 5 次仍失敗，就標記 `FAILED`，通知管理員，總覽顯示「歸檔失敗」。

**權限：**
- Drive 只用 `drive.file` 權限。
- 目的地資料夾由程式自己建立。
- 不修改任何分享設定。

## 8. API 清單

**我們的端點**（都等 P2 上線後才建立）：

| 方法與路徑 | 用途 | 權限 |
|---|---|---|
| `GET /admin/classrooms` | 總覽頁 | 網站 owner |
| `GET /api/admin/classrooms/live` | 總覽資料，只有代碼；回應標頭為 `private, no-store` | 網站 owner |
| `POST /api/admin/classrooms/{lessonId}/reconcile` | 手動重新核對；有頻率限制，並寫入稽核紀錄 | 網站 owner |
| `POST /api/classroom/{lessonId}/join` | 入場檢查，並簽發入場憑證 | 名單上已驗證身分的人 |
| `POST /api/classroom/{lessonId}/host-events` | 小老師端回報 | 這堂課的小老師 |
| `POST /api/recordings/zoom/webhook` | 接收 Zoom 事件 | 以簽章驗證 |

**用到的 Zoom Video SDK REST API**（官方文件記載）：

| 方法與路徑 | 用途 | 限流等級 |
|---|---|---|
| `GET /v2/videosdk/sessions/{sessionId}?type=live` 或 `past` | session 詳情（`start_time`、`end_time`、`user_count`、`has_recording`） | HEAVY |
| `GET /v2/videosdk/sessions/{sessionId}/users` | 名單和進出時間（回應裡的 `name`、`ip_address`、`device` 會立刻丟掉） | HEAVY |
| `GET /v2/videosdk/sessions/{sessionId}/recordings` | 錄影檔和下載網址 | LIGHT |
| `PATCH /v2/videosdk/sessions/{sessionId}/events` | `recording.start`、`stop`、`pause`、`resume` | MEDIUM |
| `PUT /v2/videosdk/sessions/{sessionId}/status` | 結束 session | LIGHT |

## 9. 資料模型（只有設計，未建表）

| 資料表 | 重點欄位 |
|---|---|
| `lessons` | `id`、`code`、`date`、`starts_at`、`ends_at`、`cancelled` |
| `lesson_participants` | `lesson_id`、`participant_id`、`code`、`role`（`tutor`、`student`、`observer`） |
| `consent_records` | `participant_id`、`status`、`version`、`granted_at`、`withdrawn_at`、`expires_at` |
| `staff_notices` | `participant_id`、`version`、`acknowledged_at` |
| `join_tokens` | `lesson_id`、`participant_id`、`token_hash`、`issued_at`、`expires_at` |
| `classroom_events` | 只增不改；`key` 唯一；`type`、`source`、`occurred_at`、`received_at`、只有代碼的欄位。心跳例外，改存在 `classroom_presence` 的「最新一筆」 |
| `classroom_jobs` | `id`（固定）、`type`、`status`、`attempts`、`lease_owner`、`lease_until`、`lease_version`、`available_at` |
| `classroom_state` | 總覽用的快取，可以隨時由事件重新算出；有 `version` 欄位 |
| `reconciliation_runs` | `lesson_id`、時間、原因、用掉的呼叫數、結果 |
| `recording_files` | `provider`、`provider_file_id`（兩者合起來唯一）、`lesson_id`、`size`、`planned_name`、`status`、`hold`、`upload_session_uri`、`drive_file_id` |
| `observer_visits`（之後才用） | `lesson_id`、管理員、原因、進出時間 |
| 稽核紀錄 | 沿用 P2 的 `admin_activity_log` 寫法 |

## 10. 流程

```
課前   排課 → lessons、lesson_participants
       開課前 15 分鐘：伺服器呼叫 getRecordingEligibility()，寫入結果
       師生進入教室：getJoinEligibility() 通過後，才簽發 30 分鐘的 JWT
課中   Zoom 傳來 webhook；小老師端回報心跳和 SDK 事件 → 先寫入資料庫，再回 200
       planActions()：條件符合就 start；撤回同意、不明身分、未經核准的錄影 → 停止保護程序
       dueReconciliations()：webhook 延遲或遺失時，向 REST API 查詢
課後   session 結束 → recording_completed，或靠核對查到檔案
       → recording_files 加上歸檔工作 → worker 存進 Drive（具冪等性）→ p1.filing 事件
       → 總覽顯示「已歸檔」 → 刪除 Zoom 上的副本
```

## 11. 安全規則

- **密鑰：** SDK Key／Secret、API Key／Secret、webhook secret 都只放在伺服器的環境變數，測試和正式環境分開。絕不放進 repo、紀錄或對話。
- **紀錄只寫代碼：** 不寫姓名、聯絡方式、下載網址或 token。
- **總覽：** 只有網站 owner 能看，回應一律 `Cache-Control: private, no-store`。巡堂功能預設關閉。
- **錄影檔：** 只串流經過我們的伺服器，不留在伺服器上。Zoom 端的副本要等 `STORED` 之後才刪除。

## 12. 合成原型對應

| 規格 | 程式 | 測試 |
|---|---|---|
| 3.1、3.2 兩個資格判斷，以及 JWT | `classroom/eligibility.mjs` | `test/eligibility.test.mjs` |
| 6 持久化、7 歸檔 | `classroom/webhook-ingest.mjs` | `test/webhook-ingest.test.mjs` |
| 4、5 狀態、停止保護、核對 | `classroom/lesson-state.mjs` | `test/live-dashboard.test.mjs` |
| 總覽與權限 | `classroom/live-dashboard.mjs` | `test/live-dashboard.test.mjs` |
| 2、5、10 堂並行的端到端模擬 | `test/fake-zoom.mjs`、`dryrun/live-dashboard.mjs` | `test/live-dashboard.test.mjs` |

測試用的資料庫和 Drive 都是記憶體中的替身（`test/fake-classroom-store.mjs`），只能證明「在交易、唯一鍵、租約這些保證之下，我們的邏輯是對的」，不能證明 PostgreSQL、Drive 或 Zoom 本身的行為。

## 13. 尚未確認

**待官方文件確認，或待實測：**
- 伺服器端 `recording.start` 能不能用，需不需要主持人在場。
- 主持人離開或直接關機時，錄影會不會繼續。
- `has_recording` 的意思。
- `recording_stopped` 實際上什麼時候送出；官方說明疑似寫錯。
- session 結束時會不會送出 `recording_stopped`。
- `RecordingStatus` 中 `Ask`、`Accept`、`Decline` 的意思。
- 合併影片的 `recording_type` 值。
- `leave_reason` 的實際文字內容。
- 刪除 Zoom 錄影要用哪一支 API。
- webhook 實際的延遲分布。

**待 Justine 決定：**
- 學生用什麼方式入場。
- 教室畫面和檔名顯示姓名還是代碼。
- 撤回前錄到的內容要保留還是刪除。
- 課中才補齊同意時，要不要開始錄影。
- 錄影設定裡的姓名浮水印和聊天紀錄。
- Zoom 端自動刪除的天數。
- 小老師離開後幾分鐘停止錄影（預設 5 分鐘）、幾分鐘結束 session（預設 15 分鐘）。
