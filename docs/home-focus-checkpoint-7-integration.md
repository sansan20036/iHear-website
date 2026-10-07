# CP7 阻塞解除 — Academy／首頁整合與平台唯讀查核

日期：2026-10-08（Asia/Taipei）。**本機整合驗收通過；正式DB對映與發布控制仍未完全解除。** 本輪沒有 push、遠端 Preview、正式備份、停寫、migration、部署或平台設定變更。**CP7 尚未正式發布。** 原 CP6／CP7 證據留在原工作樹，沒有以新清單替換舊清單。

## 候選與 Git 對應

| 節點 | 固定識別 |
| --- | --- |
| 原 CP6 候選 | `cp6-f30a433676f81d7a868e5a1a699a7a4505ab879fdb513b81dce990c0c1c5b61c` |
| 原候選 Git 基底、兩邊共同祖先 | `fd6a93dd433da347ca4e5d412c25d6f5280fc57f` |
| 原候選重建 checkpoint | `3d70a80decc1549fc90087bada334f2b70aeb38d` |
| 本輪 fetch 固定的遠端 main | `365181eb32418a39048bef6d265ba02579a5d349` |
| 新候選 | `cp7-integration-8e61dece65dc3d5863b3acacaa066c32a0a100defe95d21dd549a9515446a02c`；[candidate.json](../output/cp7-integration/candidate.json) 記錄377個交付檔，最終對應見 [completion.json](../output/cp7-integration/completion.json) |
| 本機整合 commit | 同一 manifest 的 `integrationCommit`；兩個父系均經 ancestor 核對，完整交付 tree 經 `verify-commit` 比對 |
| 分支 | `cp7/academy-home-integration`，僅本機 |
| 新 deployment | 無；本輪未建立 |

原工作樹：`C:/Users/sansa/OneDrive/桌面/iHear website`。隔離工作樹：`C:/Users/sansa/OneDrive/桌面/iHear website/output/cp7-integration/worktree`。本報告、更新手冊與新候選都在後者。原工作樹 HEAD、index、既有修改、原 manifest／報告／驗收證據於開始與結束核對。

原候選完整 **356 檔**，相對實際基底為 **29新增、26修改、0刪除／重新命名**；逐一驗證原始 hash 後重建，包含未追蹤新增、binary。只處理 manifest 明列的刪除，不將清單外檔案當成應刪檔。checkpoint 的 exact Git tree 比對通過；CRLF 原始 bytes 與 Git clean-filtered blobs 分別記錄，沒有重寫 SQL。見 [checkpoint-verification](../output/cp7-integration/checkpoint-verification.json)、[兩邊完整 binary diff 與路徑清單](../output/cp7-integration/)。

遠端本輪仍為六個提交、34 個差異路徑（16新增、18修改、0刪除／重新命名）；來源提交完整清單見 [remote-commits](../output/cp7-integration/remote-commits.txt)。整合使用固定 SHA 進行真正三方 merge，不整批選 ours/theirs。三處文字衝突為 generator、content catalog、inventory；其他自動合併結果逐項語意審查。新交付檔數由 manifest 計算，不以 356 加 16 推定。

原候選保留為歷史可驗證輸入，**已由本次整合候選取代，不可直接拿原 CP6 ID 發布目前 main**。結束時遠端重新 fetch 結果與時間另記 completion；未藉更新 manifest SHA 假裝納入程式。

## 三方整合決策與本輪新增差異

[逐檔三方 blob 表](../output/cp7-integration/three-way-files.json) 區分 CP6-only、remote-only、both、integration-only；[逐 key 語意與來源提交](../output/cp7-integration/content-decisions.json) 保留完整前後值。唯讀第二次審查見 [independent-review](../output/cp7-integration/independent-review.md)。

| 路徑／範圍 | 結果及原因 |
| --- | --- |
| `academy-site/**`、`scripts/prepare-academy.mjs`、`next.config.mjs`、`sitemap.xml`、layout slots | 完整繼承遠端課程來源、binary 圖片／字型、clean URL、舊網址 redirect、canonical／hreflang、課程／email CTA。課程實際支援英文與繁中；CMS `/academy` 保留三語。 |
| `index.html`、`stories.html` | 保留 CP6 已驗收內容，遠端相關變更原已包含；不移除焦點區、相簿影片或錨點。 |
| `assets/site.js`、`academy.html` | 保留遠端新 courses／email 按鈕；四筆原中譯 dictionary 與兩個舊 CTA content slot 放於 inert template 中維持語義。template 裡只有 span，沒有舊 href／layout hook，不會新增可見或可聚焦入口。 |
| `scripts/generate-content-slots.mjs`、catalog、inventory | 來源合併後由生成器重建。保留 CP0 決定性、CRLF／occurrence 處理、历史 checksum 防護；排除遠端尚存的 `--initial-seed` SQL 覆寫路徑。保留遠端新增 layout metadata。 |
| `scripts/prepare-public.mjs` | 同時生成獨立 Academy 子站與原首頁 SSR／Banner／三卡資產；不將首頁 controller 注入課程子站。 |
| 公開頁／production read-only 測試與 ESLint | 保留遠端 Academy 頁面／資產安全白名單、路由驗證與 script lint；保留 CP6 公開頁 smoke 的 OS-temp store 隔離。 |
| `package.json` | 原依賴不變。Operations 納入新候選防護測試，完整 check 最後增加 Academy／首頁往返驗收；加入獨立驗證入口。 |
| `scripts/integration-candidate.mjs`、`tests/integration-candidate.test.mjs` | 新候選 schema 2，原始檔案／刪除／文件 delivery digest／Git blobs、兩來源語義與24 SQL保全、checkpoint／remote ancestry。28項測試驗證篡改、增刪、文件身分、重複 key 與基線。 |
| `tests/content-generation.test.mjs` | 新案例證明舊值保留於 inert 節點、新 CTA 仍可見，`--initial-seed` 不改 SQL。 |
| `tests/academy-home-integration.smoke.mjs` | 新四組正式 build 瀏覽器流程，覆蓋共用入口／三語與課程兩語、首頁接管、資產及舊頁回歸。 |
| `vercel.json`、Operations 測試 | 加入 `git.deploymentEnabled:false` 及測試，避免後續以 push 後才跑 CI 作發布 gate。只存在本機候選，**未在平台生效**；第一次 push 的額外安全條件見手冊。CSP／其他 hosting 設定未放寬。 |
| `.vercelignore` | 實際CLI dry-run發現Git-ignored output與生成檔仍被選入，故新增部署來源過濾。用真正dry file inventory逐檔比對，保留來源catalog，排除測試／本機資料與生成產物；沒有執行upload。 |
| README、發布手冊、本報告 | README 改正自動發布描述及 install 指令；手冊依實證分開 CI、DB 寫入與 promotion 邊界。保留原恢復限制，不宣稱可立即 rollback 舊版本。 |

沒有產品 schema／migration／store／runner 改動。原 CP6 的115個 DB／store／API／runner／復原與依賴 lock 相關檔 raw hash 一致；24 SQL raw bytes 與 runner checksum 全相符。遠端沒有新增 migration，無編號碰撞。PG CP1與CP6已提交復原43 checks 可沿用於這些未變機制，**不等於本輪已讀到正式 DB**。

## 內容與工作樹保全

- 原可信311值與原CP6全部321值按 page/key 及完整語意比較，僅忽略生成 occurrences。321/321 保留，包含先前遠端移除的兩個舊 CTA key。
- 遠端293值全部保留；最終323值，新增 courses／email 兩個可見 key。沒有既有語意值被改成另一個值，沒有默默重設基線。遠端移除舊 key 的意圖由可見 UI 移除實現，資料相容保留於 inert template。
- 原 `.env`、未追蹤修改、CP7舊報告、output證據沒有搬走或刪除。新工作樹未複製 Production 設定。
- 新 manifest 排除 secrets、node_modules、public／.private／.next、output、backup及build metadata。程式 ID 不含文件以避免自引用；文件仍受完整 delivery digest／Git blobs 保護。常規檔 executable mode 不在比對範圍，現有入口使用 Node/npm。
- 遠端兩個新檔的 EOF 空白警告保留（`academy-site/self-hosted-fonts.css`、`academy-site/zh/index.html`），不是整合引入的內容差異。報告不把相對 checkpoint 的 `diff --check` 警告稱為零。

## 本機驗收與證據

正式build與所有測試只在隔離 worktree執行。沒有 `.env.local`；父程序清空 PostgreSQL／Supabase／Vercel相關設定，各既有測試使用自己的 OS-temp／隔離 fixture。新smoke另清空全部相關 DB/storage變數、強制 file store、使用唯一 OS-temp目錄。任何正式首頁返回 link 在browser邊界精確攔截改向本機，未向正式／外部應用發出請求。

實際命令、exit codes、數量與build ID見 [validation-summary](../output/cp7-integration/validation-summary.json)、[完整check.log](../output/cp7-integration/check.log)、[新瀏覽器結果](../output/cp7-academy-home/results.json)、[畫面審查](../output/cp7-academy-home/visual-review.md)。`npm run check` 已涵蓋 lint、typecheck、API、Operations、E2E、controller契約、build及smoke，不重複獨立再跑相同閘門；`npm run content:check` 另執行。

最終 `npm run check` **exit 0**；`npm run content:check` **exit 0**。build ID：`XZqERDUfqoeJdFKMAZnRw`。Node24.11.1／Playwright1.62.0，Chromium正式build瀏覽器驗收，所有下列案例0失敗／0跳過。

| 最終check中的驗證 | 實際結果 |
| --- | --- |
| lint／typecheck／build | 全通過 |
| API | 427／427 |
| Operations（含新候選28、內容生成7） | 104／104 |
| E2E | 87／87 |
| Banner／三卡controller契約 | 24／24、29／29 |
| 公開頁／Academy | 13個CMS頁、2個課程語言、13個課程資產通過 |
| CP3 SSR／CP4 Banner瀏覽器／CP5三卡瀏覽器 | 12／12、16／16、16／16 |
| Banner後台 | 10／10 |
| 原media／Resources／team後台workflow | 全通過 |
| 新Academy／首頁往返 | 4／4，6張畫面 |
| content生成核對 | 323 slots／13頁 |

最終完整check起始輸入另封存於 `full-check-input.json`，包含新測試及 `.vercelignore`。部署過濾以實際CLI dry-run另外驗證；最終dry允許CLI既有忽略的`.gitignore`及零byte目錄項，其餘必要來源無缺漏、無多餘檔、逐檔bytes吻合。文件收尾可改變delivery digest，不能改變已測程式ID；詳細見最終preservation與平台dry證據。

保留早期診斷：新增測試 `finally` 的 lint 錯誤已修正；一次 root 設定父層 `IHEAR_TEST_DATA_DIR` 覆蓋既有測試 mocked-cwd 位置，導致3個API失敗，移除後通過。新增Academy smoke最初誤認公開content API包含預設catalog值，另缺測試AUTH_SECRET；修正為驗證API overrides與SSR內嵌store一致、SSR文字按override／catalog回退，並提供純測試auth環境。最後目視發現手機選單截圖停在關閉動畫中間幀，故讓截圖等待既有動畫結束；中止尚未跑到新末段的一次check並重新凍結。所有診斷log保留，沒有改產品、降低斷言或延長產品timeout來通過，也未將失敗或中止標為成功。

新四組流程涵蓋：SSR hidden／管理操作排除及三語無JS；桌面首頁→三語CMS Academy→繁中課程→新分頁首頁；390px選單／語言→英文課程→首頁；Resources分類、原stories影片與CSS／JS／字型／圖片資產。課程的英文／繁中是獨立URL，沒有宣稱其支援簡中；從課程返回首頁仍依CMS既有語言選擇。畫面位置 `output/playwright/cp7-academy-home/`。

## 平台唯讀結果與仍缺的證據

[平台證據](../output/cp7-integration/platform/) 僅控制面GET／CLI唯讀結果，未發出正式應用GET或SQL。Vercel CLI59.13.1已認證 `sansan20036`，不是缺少登入、team錯誤或已證實無專案權限。

正式team `team_ebxQ8WweOsZkpbvdopoO0A61`（sansan20036s-projects，Hobby）、project `prj_x1wwpRjVY46LGAjNcd3QOpAf1ssJ`（i-hear-website）、repo `sansan20036/iHear-website`、Production Branch `main`。實际`www.ihearus.org`／`ihearus.org` alias均指向 **`dpl_5angoHLGKe6ruagB2dyG3bj2Drjx`**、SHA **`365181eb32418a39048bef6d265ba02579a5d349`**，READY；apex配置308至www。這是alias控制面證據，不是只挑最新READY紀錄，也不是實際HTTP健康／CDN／CSP驗收。

查核時間為2026-10-07 18:09:36 UTC（aliases），部署細節18:17:37 UTC。部署URL為 `https://i-hear-website-qe7jf8mf2-sansan20036s-projects.vercel.app`、target `production`。project `rootDirectory:null` 使用repository root，沒有deploy hook；既有Git整合與CLI可建立部署，GitHub Actions沒有部署step。當前project設定與已部署build設定分別保存，未混為同一個環境快照。

目前 `POSTGRES_URL` env ID `KhSkpobkDZoZxeMB` 同時用於Production與Preview，無branch override；這是設定共享的實證。`DATABASE_URL`不存在，`SUPABASE_URL`為Production專用。敏感值不能回讀、整合resource list為空、已部署env metadata只提供名稱，故**無法確認實際Supabase ref／branch／database，也不能把本機連線或目前project設定視為歷史deployment使用值**。已向維護者請求非機密映射；正式 SQL ledger／CHECK／gallery／topic與snapshot尚未查核。

GitHub CI run **37511470953** 與正在服務的部署是**同一SHA**；完整CI失敗於既有team管理320px刷新檢查，而Vercel Production先成功。main無branch protection／ruleset，GitHub環境無保護。CI沒有部署／migration步驟；Vercel Git integration是獨立發布路徑，不能把CI當成已生效的部署阻擋。

實際程式的公開內容GET可能初始化schema／搬入既有locale資料；公開API也可能寫rate-limit。`--skip-domain`與Deployment Checks僅控制發佈／域名階段，不能證明DB未寫入。精確入口、排程／外部writer、第一個可能觸及DB的動作及正式域名切換邊界，見[更新手冊](home-focus-release-runbook.md)。本轮沒有停用排程、WAF、變更Secrets或啟用任何平台防線。

## 可審閱的後續發布順序及限制

1. 完成正式DB非機密對映與direct/session連線來源確認；只用無初始化副作用的SQL工具讀取真實023／024狀態，不使用app GET作前置查核。
2. 在首個push之前，依手冊先證實平台Git部署阻斷或Preview DB隔離；本機`deploymentEnabled:false`尚未實際生效，不靠未實測首次push時序保障Production。
3. 推送精確已驗候選的安全CI分支，要求完整CI exact head SHA通過；目前沒有新的遠端CI結果。main增量先核對整合，不force push。
4. 證實所有HTTP／admin／job／SQL writer停止與在途工作排空，才做完整native backup、獨立restore驗證、實際runner適用migration及正式資料保全比對。
5. 以同候選建立staged Production（`--prod --skip-domain`），讀取實際deployment/input識別並驗收；再明確promote同一production deployment，最後正式域名smoke／CDN／CSP，通過後解除停寫。沒有以domain尚未切換取代DB保護。

平台變更、停寫執行者、可用WAF／bypass範圍、備份保存／金鑰保管與復原destination仍待實作驗證。手冊提供確切建議、確認方式及還原邊界，不把未套用設定寫成已解除。若restore會覆寫備份後新資料，先保全並協調新寫入，不破壞性覆蓋。已驗證的是新database恢復，沒有已驗舊程式立即rollback承諾。

沿用已確認的手機empty收合／恢復CLS最大window **0.3017248981639321**；相同snapshot刷新0新增位移。首頁controller／CSS未改，沒有扣除規格重排或重做全排列量測。真實BFCache命中、實際螢幕閱讀器、原生Safari／iPhone、完整其他引擎矩陣、正式CDN／CSP與底層store讀取不可取消限制繼續保留。

`npm ci`與唯讀`npm audit --json`亦揭露繼承的7個有風險套件（1 critical、4 high、2 moderate）；兩來源與整合lockfile相同，**未因此宣稱風險解除**。Next／Sharp等適用性尚未全面驗證，無exploit測試；依本輪相依變更限於整合的範圍，未自動升級。完整advisory與引用分析見[dependency-audit-summary](../output/cp7-integration/dependency-audit-summary.json)，應於後續發布決策明確處理，修正依賴將需要新的候選與受影響驗收。

**停止點：交付新本機候選與可審閱手冊；平台DB對映及發布控制仍有待完成項，沒有宣稱CP7正式發布通過。**
