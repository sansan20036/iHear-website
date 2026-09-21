# 團隊卡片隱藏與重新顯示

管理員在 `/team` 開啟「管理團隊檔案」，或進入 `/admin/team`，可從已發布卡片按「隱藏／重新顯示」。編輯視窗也有「暫時隱藏此卡片」，按「儲存變更」才生效。只有顯示設定改變時不呼叫翻譯服務、不更新共用人物。

隱藏以版位為單位：同一人的 Leaders 與 Tutors 獨立。照片、三語內容、人工翻譯狀態與排序值全部保留。取消隱藏不發布草稿，也不恢復回收區資料。獨立管理的統計文字不會改寫。

後台有全部、已發布、已隱藏、草稿篩選。操作成功的卡片在目前清單暫留並標示結果；切換篩選、搜尋或重整後才重新過濾。背景刷新不清除暫留標示。暫留時停用排序。已隱藏卡片仍有清楚可讀的文字與操作按鈕。

公開管理模式退出或登出時立即清除草稿與隱藏 DOM，再取得公開資料；舊管理回應不覆蓋新狀態。公開讀取失敗顯示重試，不用管理清單作為備援。隱藏是網站目錄展示控制，並不是撤銷既有照片網址的存取權。

## API 與資料

- Migration `022` 新增 `team_profiles.is_hidden BOOLEAN NOT NULL DEFAULT FALSE`，不修改既有內容。檔案模式缺值視為 false。
- `PATCH /api/team-profiles/{id}/visibility`：JSON `{ "isHidden": true, "profileVersion": 1 }`，回傳 `{ ok, profile, revision }`。管理員、同來源、限流、版本衝突規則沿用既有 API。
- 快捷操作只更新隱藏設定、卡片版本與修改者／時間，記錄 `team.hidden` 或 `team.shown`。
- 一般內容 API 接受選填 `isHidden`；未提供時保留資料庫值。公開讀取只允許 published、未隱藏、未回收的版位；管理讀取包含隱藏項目。

## 驗證與部署

`npm run test:api` 驗證權限、版本、PostgreSQL 交易及隔離檔案儲存；`npm run build && npm run test:team-visibility` 操作隔離的真實後台與公開管理頁，驗證回饋、三語、320/390/1440px、衝突及延遲回應。測試使用 `IHEAR_FORCE_FILE_STORE=1` 和獨立 `IHEAR_TEST_DATA_DIR`，不操作正式名冊。

部署順序：`npm run db:backup` → `npm run db:verify-backup-file -- <before>` → `npm run db:migrate` → 再次備份 → `node scripts/verify-team-visibility-preservation.mjs <before> <after>` → 推送與部署 → 唯讀巡檢。遷移可重複執行，備份使用 SELECT *，包含新欄位。

**回退限制：不得直接回退到此功能之前的完整程式版本。** 舊版本不會過濾 `is_hidden`，可能重新公開人員。如需回退介面，建立相容修正版，保留欄位、公開查詢過濾及退出管理模式的清理，再重新部署；不刪除新欄位或重設隱藏值。
