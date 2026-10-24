# Zoom 帳號查核：現有 Meetings 授權與 Video SDK

前提：iHear 已有付費的 Zoom 帳號，這點不必再確認。這份文件只寫通用的查核結果和步驟。帳號名稱、方案、授權數等資訊不寫進 repo，另外放在 repo 外的 planning 文件。

本次查核只讀了官方文件（2026-10-25），沒有登入任何帳號。

## 1. 結論

1. **現有的 Meetings 付費授權不包含 Video SDK。**
   - Video SDK 屬於 Zoom Build Platform，用預付點數，依分鐘用量計費。
   - Workplace 價目頁沒有列出 Video SDK。
   - 官方 FAQ 說，Video SDK 是「自己的影音雲，Zoom App 和 Zoom Meetings 都連不進去」。
2. **可能可以掛在現有帳號下，但要登入才能確認。**
   - 官方帳單文件列出兩種帳號型態：
     - 「Workplace Pro 帳號加上 Build Platform add-on」：帳單併在 Workplace 帳號裡；
     - 直接另開的 Build Platform 帳號：在 Platform Studio 建立，「不需要信用卡」，可以試用。
   - Workplace 使用者可以從 Admin Center 的「Delegated accounts」管理 Build 帳號。
   - Build 帳號也可以邀請既有的 Zoom 帳號協助管理，但受邀帳號必須已登記信用卡。
   - 論壇上有人說 Pro 帳號無法直接使用 Video SDK，和官方文件不一致，所以要登入確認。
3. **Video SDK 雲端錄影的條件：**
   - 必須有 Cloud Recording Storage Plan；
   - 要在 Build 帳號的 Account Settings → Recording 開啟。
4. **價格未公開。** 官方開發者價目頁沒有任何數字。第三方資料寫每參與者分鐘約 US$0.0035，錄影每分鐘 US$0.01–0.015（2023 年的舊資料），都**未確認**。

## 2. Meetings 授權與 Video SDK 的差異

| 項目 | Zoom Meetings（現有付費授權） | Zoom Video SDK（Build Platform） |
|---|---|---|
| 是否已包含 | 已有 | 沒有：要加掛 add-on，或另開 Build 帳號 |
| 計費方式 | 依主持人授權，按月或按年付費 | 依分鐘用量扣預付點數；錄影另需 Storage Plan |
| 上課入口 | Zoom App 或瀏覽器 | 只能從我們網站的教室進入 |
| 同時上課 | 每場同時進行的會議需要一位有授權的主持人：Pro 一次 1 場，Business 可主持 2 場（轉載的支援文章，官方原文待確認） | 官方：同時進行的 session 數不限，每場最多 5,000 人 |
| 雲端錄影空間 | Pro 和 Business 每個授權 10 GB，全帳號共用，可另外加購 | Storage Plan 的價格未公開；可以設定 N 天後自動刪除，也可以改存到自己的 S3 |
| 自動錄影 | 建立會議時設定 `auto_recording: cloud`，只能依名單事先決定 | 帳號層級有 Automatic recording 開關，**必須關閉**；改由我們的伺服器在確認同意後才啟動 |
| 分組 | 分組討論室只能本機錄影 | 每堂課一個 session |
| 開發者功能 | Marketplace 的 Server-to-Server OAuth app（要有「檢視和編輯 S2S app」的權限，admin 範圍另需 admin 角色）、webhook、Meeting SDK（Free、Pro、Business+ 都包含） | SDK Key／Secret、API Key／Secret（JWT）、`session.*` webhook、REST API |
| 錄影完成通知 | `recording.completed`，附帶 24 小時有效的 `download_token` | `session.recording_completed`，同樣附帶 24 小時有效的 `download_token` |
| API 限額 | 依方案；Pro 是 HEAVY 每秒 10 次，HEAVY 和 RESOURCE-INTENSIVE 合計每天 30,000 次 | Build 帳號比照 Pro |
| 價格（官方美國牌價） | Pro 每人每月 US$14.16（年繳）或 US$16.99（月繳）；Business US$18.33 或 US$21.99；經認證的非營利組織，Workplace Pro 和 Business 打 5 折 | 未公開 |
| 資料範圍 | 帳號裡已有真實課程和錄影；有錄影權限的 app 可以讀取全部錄影 | 預期是獨立的 project 和憑證，與 Meetings 分開（**待確認**） |

**這一輪不做：** 在現有的 Meetings 帳號上建立有錄影權限的 Server-to-Server OAuth app，因為它的權限會涵蓋所有真實錄影。之後如果要做，必須另外核准，並把權限範圍縮到最小。

## 3. 必須確認或設定的錄影選項

詳細內容見交接規格第 4.2 節。

- Automatic recording：**關閉**。
- 主持人不在場時，參與者可以開始錄影：**關閉**。
- 參與者可以請主持人開始錄影：**關閉**。
- 允許主持人錄到雲端：開啟。
- 錄影畫面顯示姓名、儲存聊天訊息：建議關閉，待 Justine 決定。
- N 天後自動刪除：N 要大於歸檔最長可能花的時間。

## 4. 取得授權後的步驟（本輪都不做，每一步都要另外核准）

| 步驟 | 內容 | 停止條件 |
|---|---|---|
| S1：唯讀查看 | 由你決定誰操作，我不登入。要看的是：<br>- 方案和授權數、年繳或月繳、有沒有非營利折扣；<br>- 雲端錄影空間的用量；<br>- 這個帳號的角色，以及是否已開啟兩步驟驗證；<br>- Marketplace 能不能建立 app（只看，不建立）；<br>- Platform Studio 或開發者價目頁有沒有 add-on 或試用、價格多少 | 一出現付款畫面或「啟用」按鈕就停止。**不要打開錄影清單**，因為裡面有真實學生的錄影 |
| S2：試用或 project | 如果不用付款：啟用 Build Platform 試用或 add-on，建立一個獨立的測試 project，並確認它和真實會議、錄影是分開的 | 需要付款就停止，回到 S4 |
| S3：憑證 | 建立 Video SDK 憑證和 webhook secret，只存進密碼管理器 | 要放進本機環境變數做測試時，另外核准 |
| S4：購買 | 點數、Storage Plan、加購授權 | 每一項都先附上金額，另外核准 |
| 備案 | 如果現有帳號無法加掛，或一定要先付款：改用新的組織專用信箱另開 Build 帳號，之後再邀請現有帳號一起管理 | 另外核准 |

憑證和密碼不要貼進對話或 repo。

## 5. 尚未確認

1. iHear 的帳號能不能加掛 Build Platform，要不要先付款。
2. 實際費率：
   - 用量是按參與者分鐘還是 session 分鐘計；
   - 點數方案和免費額度；
   - 錄影每分鐘多少錢；
   - Storage Plan 的價格，以及是不是非買不可。
3. 一個帳號能同時錄幾場。
4. 試用帳號能不能雲端錄影、收不收得到錄影 webhook。官方有一句「這些 webhook 限 universal credit 帳號」，但沒說是哪些。
5. Build 帳號和現有 Meetings 帳號的資料、權限，是否完全分開。
6. 錄影檔存放在哪個地區、預設保存幾天。
7. Meetings 同時主持上限的官方原文；台灣地區的價格；非營利折扣是否適用。

## 來源

**官方：**
- Build 平台：
  - 帳單：https://developers.zoom.us/docs/build/billing/
  - 帳號：https://developers.zoom.us/docs/build/account/
  - 角色：https://developers.zoom.us/docs/build/roles/
  - 雲端錄影：https://developers.zoom.us/docs/build/cloud-recording/
  - Platform Studio：https://developers.zoom.us/docs/build/platform-studio/
- 價目：
  - 開發者價目：https://zoom.us/pricing/developer
  - Workplace 價目：https://zoom.us/pricing
- 雲端錄影空間：https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067670
- Video SDK：
  - Sessions：https://developers.zoom.us/docs/video-sdk/web/sessions/
  - JWT：https://developers.zoom.us/docs/video-sdk/auth/
  - Webhook 事件：https://developers.zoom.us/docs/api/video-sdk/events/
  - REST API：https://developers.zoom.us/docs/api/video-sdk/
- Webhook 送達規則：https://developers.zoom.us/docs/api/webhooks/
- API 限額：https://developers.zoom.us/docs/api/rate-limits/
- 建立 S2S app：https://developers.zoom.us/docs/internal-apps/create/

**非官方（僅供參考）：**
- Meetings 同時主持：https://itservices.risd.edu/support/solutions/articles/18000058791
- Pro 帳號與 Video SDK：https://devforum.zoom.us/t/need-help-with-video-sdk-app/145384
- 費率：
  - https://trtc.io/blog/details/zoom-video-sdk-pricing-2026
  - https://devforum.zoom.us/t/pricing-for-zoom-video-sdk-recording-module/97925
