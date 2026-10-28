# A1：Google Drive 測試環境操作手冊

| 項目 | 狀態 |
|---|---|
| 本文件 | 2026-10-28 版。**只是準備，還沒有執行。** 建立 Google Cloud 專案、OAuth client，或取得 token 之前，都要先核准 A1 |
| 工具 | 準備好了，已用本機模擬服務自我測試通過（`run-a1.mjs self-test`），沒有連到 Google |
| 範圍 | 只用既有的 P1 測試帳號，只申請 `drive.file` 權限，只用合成影片，只動一個測試資料夾 |
| 不在範圍內 | A2～A4、正式排程、Migration 027、正式 OAuth、網站與 Vercel、正式資料庫、真實學生錄影 |
| P2 | 完全不受影響：不碰網站程式、部署、環境變數或資料庫 |

> 這個 repo 是公開的。本文件和工具都不寫入任何帳號資訊；測試帳號只寫在 repo 之外的本機設定檔裡。

## 1. 需要的授權範圍

| 項目 | 內容 |
|---|---|
| OAuth 權限 | **只有 `https://www.googleapis.com/auth/drive.file`**。Google 把它列為建議使用的 non-sensitive 權限：只能存取這個 app 自己建立的檔案，或使用者用 app 開啟的檔案，看不到測試帳號 Drive 裡的其他東西 |
| OAuth client 類型 | Desktop app。Google 說明 Desktop app 是公開的 client，client secret 不算機密；**真正要保護的是 refresh token** |
| 同意畫面 | External，發布狀態維持 **Testing**，測試使用者只有 P1 測試帳號 |
| Token 效期 | Testing 狀態的 refresh token **7 天就失效**（Google 官方說明），所以 A1 要在 7 天內做完並撤銷 |
| 費用 | 不建立帳單帳戶。Drive API 不需要付費 |
| 其他 API | 只啟用 Google Drive API |

工具額外的保護：

- **權限範圍：** 授權回來的權限只要不是剛好 `drive.file`，就立刻撤銷，也不存 token。
- **帳號：** 每次測試前先確認 token 屬於設定檔裡的測試帳號，不對就停。ihearprogram@gmail.com 和 `--deny` 列出的帳號一律拒絕。
- **Token 檔：** 放在只有目前 Windows 使用者能讀的資料夾。資料夾的權限是先設好才寫入檔案（10/26 金鑰事件的教訓）。
- **證據檔：** 只記錄 HTTP 狀態碼和 Range，不記錄 token 或上傳 session URI。

## 2. OAuth 設定步驟

全程使用 **P1 測試帳號專用的瀏覽器設定檔**（`%LOCALAPPDATA%\ihear-google-test-profile`）。開始前先確認右上角登入的是測試帳號，不是日常帳號。

1. **建立專案：**
   - 開啟 Google Cloud Console，建立新專案，名稱例如 `ihear-p1-a1-test`。
   - **不要連結帳單帳戶。**
2. **啟用 API：**
   - Menu > **APIs & Services** > **Library**，搜尋「Google Drive API」，按 **Enable**。
   - 只啟用這一個。
3. **設定同意畫面：**
   - Menu > **Google Auth platform** > **Branding**，按 **Get Started**。
   - App Information：App name 填 `iHear P1 A1 test`，User support email 選測試帳號，按 **Next**。
   - Audience：選 **External**，按 **Next**。
   - Contact Information：填測試帳號，按 **Next**。
   - Finish：勾選同意 Google API Services User Data Policy，按 **Continue**，再按 **Create**。
4. **加入測試使用者：**
   - **Audience** > Test users > **Add users**，只加 P1 測試帳號，按 **Save**。
   - 發布狀態維持 **Testing**，**不要**按 Publish。
5. **設定權限範圍：**
   - **Data Access** > **Add or Remove Scopes**，只勾 `.../auth/drive.file`，按 **Save**。
6. **建立 OAuth client：**
   - **Clients** > **Create Client**。
   - Application type 選 **Desktop app**，Name 填 `iHear P1 A1 desktop`。
   - **不要**勾「Use this client for an AI-powered agent」。
   - 按 **Create**，然後在 client 詳細頁下載 JSON。
7. **本機準備**（在 `%LOCALAPPDATA%\iHear-p1-filing` 執行）：
   ```
   node tools/recording-pathway/drive-test/run-a1.mjs init --account <P1 測試帳號> --deny <日常帳號>
   ```
   - 這一步會建立 `%LOCALAPPDATA%\iHear-p1-drive-test\`，以及只有你能讀的 `private\` 資料夾和設定檔。
   - 把步驟 6 下載的 JSON 改名為 `client.json`，放進 `private\`。
8. **登入取得 token：**
   ```
   node tools/recording-pathway/drive-test/run-a1.mjs auth
   ```
   - 把畫面上的網址貼到測試帳號的瀏覽器設定檔開啟。
   - 同意畫面上要確認兩件事：帳號是測試帳號；權限只有「查看、編輯、建立及刪除您透過這個應用程式使用的 Google 雲端硬碟檔案」這一項。

## 3. 執行

```
node tools/recording-pathway/drive-test/run-a1.mjs media    # 產生合成影片：每個畫面都有「合成測試影片／非真實錄影」
node tools/recording-pathway/drive-test/run-a1.mjs run      # 依序執行 D1～D9，證據存在 work\evidence\
node tools/recording-pathway/drive-test/run-a1.mjs cleanup  # 永久刪除測試資料夾和裡面所有測試檔
node tools/recording-pathway/drive-test/run-a1.mjs revoke   # 撤銷授權，確認 refresh 被拒，刪除 token 檔
```

合成影片有兩支：

- **小檔：** 約 1.2 MB，10 秒的測試圖案。
- **中檔：** 約 24 MB，會分成 3 段、每段 8 MiB 上傳。

## 4. D1～D9 驗收條件

- **D1 是關卡：** 沒通過就全部停止。
- **其他項目的判定：** 標示 FAIL 的要停下來回報。標示 OBSERVED 的，代表 Google 實際行為和預期不同，要記錄並討論，但不代表資料出錯。
- **合成與實測分開：** 本文件記錄的是實測結果，和合成驗收分開計算。

| 編號 | 內容 | 通過條件（PASS） | 證據 |
|---|---|---|---|
| D1 | 授權、權限範圍、帳號 | token 換得到 access token；權限**只有** `drive.file`；Drive 回報的帳號就是測試帳號，而且不在禁止名單上 | 權限範圍、帳號是否相符（不記錄 token） |
| D2 | 測試資料夾 | 建立 `[測試] iHear P1 自動歸檔 A1`，以及底下的月份資料夾和 `_待確認`。3 秒後換一個新的連線（不共用記憶），用搜尋找回的必須是**同一批 ID** | 每個資料夾搜尋到幾個 |
| D3 | 分段上傳與完整性 | 小檔每段 256 KiB：每次 308 的 `Range` 依序是 `bytes=0-262143`、`bytes=0-524287`……（包含結尾的位元組），最後一段回 200 或 201。中檔每段 8 MiB，分 3 段。兩支影片的 `size`、`md5Checksum` 都和本機一致；檔名依 P1 規則（小檔 `_P01`；中檔因為 `_P01` 已經有人用，所以是 `_P02`）；都放在月份資料夾 | 每一段的狀態碼和 Range、md5 比對、檔名 |
| D4 | 中斷後續傳 | 傳 2 段之後強制停止程序。下一次執行時先查詢狀態（回 308，`Range: bytes=0-524287`），再從第 524,288 個位元組接著傳，全程只開過 **1 個** session。最後 md5 一致、狀態是 STORED | 查詢狀態的回應、開過幾個 session、md5 |
| D5 | session 失效、分段起點錯誤 | 不存在的 session 判讀為作廢（404）。故意從錯誤的起點送出一段，記錄 Drive 實際怎麼回應（官方文件沒有寫）。依「先查狀態，再接續或重來」完成上傳後，md5 一致 | 錯誤起點那一段的實際回應 |
| D6 | 搜尋延遲 | 上傳 5 個檔案，每個都能**立刻**用 ID 讀到；記錄每個要多久才搜尋得到。60 秒內都搜尋得到是 PASS，超過就是 OBSERVED | 5 個檔案的延遲毫秒數 |
| D7 | 容量查詢 | `storageQuota` 的 `limit` 和 `usage` 都讀得到 | 剩餘空間 |
| D8 | 重複副本收斂 | 先放入 3 份帶有相同 `providerFileId` 的檔案（最早的一份、較晚的一份、一份大小不對的）。worker 必須採用最早的一份，其他兩份移到垃圾桶，而且**完全不重新上傳**（開過 0 個 session） | 保留的是哪一份、哪些進了垃圾桶 |
| D9 | 錯誤原因對照 | 讀取不存在的檔案：回 404 `notFound`，對應到 `DRIVE_FOLDER_MISSING`，用 ID 讀取時回傳空值。用無效 token：回 401 `authError`，對應到 `DRIVE_AUTH` | 實際的狀態碼和錯誤原因 |

**A1 整體通過的條件：**
- D1～D9 都是 PASS；D5、D6 也可以是 OBSERVED，只要有記錄、而且沒有任何資料損壞；
- 清理完成：測試資料夾已刪除；
- 撤銷完成：refresh 被拒，token 檔已刪除。

**不以實測驗證的項目：** Drive 5xx、空間不足、速率限制。這些在真實環境沒辦法、也不應該刻意製造，所以維持合成驗收，報告裡分開標示。

## 5. 停止條件

遇到下列任何一種，立刻停止，不自動重試，不改設定繞過：

- 同意畫面或 Drive 回報的帳號不是測試帳號；
- 授權的權限不只有 `drive.file`；
- 任何一項是 FAIL；
- 出現測試資料夾以外的檔案異動；
- 證據檔裡出現 token 或 session URI。工具本身會擋下這種情況，拒絕寫入。

## 6. 測試後撤銷憑證與收尾

依序做完，每一步都要留下確認紀錄：

1. **撤銷授權：** 執行 `run-a1.mjs revoke`。
   - 它會呼叫 Google 的撤銷端點 `https://oauth2.googleapis.com/revoke`。Google 說明撤銷 refresh token 也會讓對應的 access token 失效。
   - 接著確認 refresh 回 `invalid_grant`，最後刪除 token 檔。
2. **檢查 Google 帳戶：**
   - 用測試帳號開啟 https://myaccount.google.com/linkedapps，選 **Access to your Google Account**。
   - 確認清單上已經沒有 `iHear P1 A1 test`。
   - 如果還在：選它 > **See details** > **Remove access** > **Confirm**。
3. **刪除 OAuth client：** Google Auth platform > **Clients**，刪除 `iHear P1 A1 desktop`。
4. **刪除專案（可選）：**
   - 在 Console 的 **Manage Resources** 頁面，選取 `ihear-p1-a1-test`，排定刪除。
   - Google 官方說明是「30 天後完全刪除」。這段期間內能不能復原，官方頁面沒有寫，要看另一份說明（推測可以）。
   - 如果近期還要再測，也可以先保留專案，只刪除 client。
5. **清理 Drive：** `run-a1.mjs cleanup` 會永久刪除測試資料夾。之後再打開測試帳號的雲端硬碟「垃圾桶」，確認沒有 `a1-`、`leftover-` 開頭的殘留檔案。
6. **清理本機：**
   - 刪除 `%LOCALAPPDATA%\iHear-p1-drive-test\private\`（client.json）和 `work\media\`；
   - 保留 `work\evidence\`，作為驗收紀錄。
7. **時限：** 從取得 token 開始，最晚 7 天內做完 1～6。

## 7. 仍然保留的風險

| 編號 | 風險 | 狀態 |
|---|---|---|
| R1 | **Zoom 下載是否支援 Range** | 保留，要等 A2 的真實 Video SDK 測試（Z4）才能判定 |
| R6 | **Vercel 能不能撐得住長時間搬移**：函式時間上限、有沒有啟用 Fluid compute、實際傳輸速度 | 保留，要等真實 SDK 和真實檔案大小出來才能判定 |
| A1-1 | Drive 搜尋延遲：其他程序可能在延遲期間建立重複的資料夾；歸檔後清理多餘副本時，也可能漏掉剛建立的副本 | 由 D2、D6 實測。延遲明顯的話，資料夾 ID 要改存在資料庫，並且加一次延後的多餘副本清理 |
| A1-2 | `drive.file` 看不到人工放進資料夾的檔案，所以偵測不到和人工檔案撞名；Drive 允許同名檔案並存，不會出錯 | 已知限制，不影響資料正確性 |
| A1-3 | 分段起點錯誤時 Drive 怎麼回應，官方文件沒有寫 | 由 D5 記錄；我方先查狀態再接續或重來，兩種情況都能處理 |
| A1-4 | 正式環境不能沿用測試 client；換 client 之後，舊檔案的 `appProperties` 也會看不到 | 正式環境另外建立 client，並且固定使用同一個，另外核准 |

## 來源

- 同意畫面設定：https://developers.google.com/workspace/guides/configure-oauth-consent
- 建立 OAuth client：https://developers.google.com/workspace/guides/create-credentials
- Desktop app 授權流程（loopback、PKCE、撤銷）：https://developers.google.com/identity/protocols/oauth2/native-app
- Refresh token 效期（Testing 狀態 7 天）：https://developers.google.com/identity/protocols/oauth2
- `drive.file` 權限範圍：https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Drive 續傳上傳：https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Drive 錯誤處理：https://developers.google.com/workspace/drive/api/guides/handle-errors
- Drive 搜尋：https://developers.google.com/workspace/drive/api/guides/search-files
- 移除第三方存取權：https://support.google.com/accounts/answer/13533235
- 刪除專案（30 天）：https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects
