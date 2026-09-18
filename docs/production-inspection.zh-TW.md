# 正式網站唯讀巡檢

這套測試以未登入訪客身分瀏覽 `https://www.ihearus.org`，和本機的 72 項
模擬 API 測試分開。執行時不需要管理員帳號、資料庫連線或環境密鑰。

## 手動執行

```powershell
npm run test:production
```

5 個頁面（首頁、Programs、Impact、Team、Resources）各測桌面 1440px、
手機 390px 與 320px，共 15 項。一次只執行一項，避免同時大量讀取正式站。

```powershell
# 只測桌面
npm run test:production -- --project=desktop

# 查看報告
npm run test:production:report

# 觀看慢速操作；每項最多 3 分鐘
$env:IHEAR_E2E_SLOWMO="800"
npm run test:production -- --headed --timeout=180000
Remove-Item Env:IHEAR_E2E_SLOWMO
```

`npm run test:e2e` 與 `npm run check` 不會執行正式站巡檢；它們仍使用原本的
本機測試。正式巡檢不需啟動本機伺服器，也不會重新產生 public 網頁。

## 檢查內容

- 頁面 HTTP 200、主要標題與內容可見。
- 公開資料 API 成功回應；團隊人數、Resources 連結與當次 API 資料一致，
  不把管理員之後正常改名、隱藏或調整人數誤認為故障。
- 圖片欄位完成載入，捲動觸發延遲載入後，展示中的圖片與影片封面可解碼。
- 手機頁面無橫向溢出，選單能開啟和關閉。
- 未登入訪客看不到編輯、上傳、排序、管理資源等控制項。
- 記錄本站 HTTP 錯誤、未捕捉的 JavaScript 例外與遭攔截請求。
- Resources 公開連結須為 HTTPS、另開分頁，並有 noopener；核對清單與 API
  一致，但不開啟或提交外部 Google 表單，也不驗證表單內部題目。

本階段不播放影片、不輪流檢查所有相簿項目、不登入後台、不比較所有歷史照片，
也不取代資料庫備份與完整功能回歸測試。

## 唯讀限制

每項測試使用全新、未登入的瀏覽器環境，不讀取你平常瀏覽器的登入狀態。
瀏覽器請求攔截器只准 GET／HEAD，限制公開頁面與已核對的公開 API，阻擋管理
端點、外部頁面導覽及 WebSocket。Service Worker 也停用，避免繞過攔截器。
即使網頁意外嘗試送出寫入請求，也會先攔截並讓巡檢失敗。

不要在這套測試加入 `request.post()`、直接 fetch 寫入、資料庫操作或管理員登入。
Playwright 的 APIRequestContext 不會經過瀏覽器 route，新增檢查請沿用受保護的
page/context。普通存取日誌與平台流量統計仍會記錄這些訪問。

## GitHub 排程與報告

工作流程：`.github/workflows/production-browser.yml`，名稱為
**Production read-only browser inspection**。

- 合併／推送到預設分支後才可啟用排程；本機建立檔案不代表排程已運作。
- 每 6 小時執行一次（UTC 00:43、06:43、12:43、18:43；台北時間
  08:43、14:43、20:43、02:43）。GitHub 排程可能延後。
- 也可在 GitHub → Actions → 該工作流程 → Run workflow 手動執行。
- 遠端失敗會重試一次；報告保留重試紀錄，不應把偶發失敗當成從未發生。
- 報告與失敗截圖、trace 作為 artifact 保留 7 天，包含當時的公開網站內容。
- 不新增寄信、Slack 或 issue 發送；通知依個人的 GitHub Actions 通知設定。
- 和原本每小時首頁／health 監控並存，不影響它的既有告警規則。

本機報告位於 `output/playwright-production/report`，失敗證據位於
`output/playwright-production/test-results`，不會覆蓋本機功能測試的報告。

若失敗，先查看報告的實際網址、狀態碼與截圖。確認是網站問題、第三方圖片服務
暫時失敗、正常內容異動，或巡檢條件需要更新，再處理。不要直接放寬條件或反覆
重跑到綠燈而忽略原始失敗證據。
