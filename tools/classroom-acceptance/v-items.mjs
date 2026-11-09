// P3-Multi B6 (2026-11-09): the real-service acceptance items V-1～V-17 (planning, 2026-11-09 Zoom
// acceptance plan) and two Drive items, each with what this repository already checks locally and
// what only a real account can show. Categories:
//   fake-api   our requests, answers and safety rules, checked against fake Zoom / Google APIs
//   browser    the pages, checked in a local browser with the stand-in Zoom SDK
//   zoom       still needs a real Zoom Video SDK account (how Zoom itself behaves)
//   drive      still needs a real Google Drive (a test account's folder)
//   owner      needs the iHear account holder: credentials, approval of recording or cost, a device
// A local pass never stands in for a real one (synthetic and real results are reported apart).
// No account details here: the repository is public.

export const CATEGORIES = {
  'fake-api': 'Fake API 已驗證',
  browser: '本機瀏覽器已驗證',
  zoom: '待真實 Zoom',
  drive: '待真實 Drive',
  owner: '需 iHear 帳號持有人操作',
};

// evidence: [file, part of a test's name]; browser: the multi-room browser test's step ids.
export const V_ITEMS = [
  { id: 'V-1', title: 'webhook 是否帶 session_name／session_key（多人教室靠 session_name 對應房間）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-multi.test.mjs', 'several rooms at once are separate sessions'], ['tests/p0-session-id.sim.test.mjs', 'a webhook with a bad signature is refused']],
    real: '開一場測試 session，收 session.started／user_joined／user_left／ended 與錄影事件，檢查每筆都有 session_id 與等於 tpc（小寫）的 session_name。' },
  { id: 'V-2', title: '真實 Session ID：SDK getSessionInfo().sessionId 是否等於 REST 的 id（含 / 與 // 的二次編碼）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-vendors.test.mjs', 'session ids go into paths as Zoom'], ['tests/classroom-vendors.test.mjs', 'a session id the tutor'], ['tests/classroom-vendors.test.mjs', 'once joined, the page says which Zoom session it is in']],
    real: '主持人頁回報的 id 直接用於 GET /videosdk/sessions/{id}?type=live，回 200 且 session_name 相符。' },
  { id: 'V-3', title: '自簽 API JWT 能否呼叫 REST（先做，只讀）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-vendors.test.mjs', 'the REST token is an hour-long JWT']],
    real: '帳號持有人建立 Video SDK API Key／Secret 後，唯讀 GET 回 200；過期或簽錯回 401（記下錯誤格式）。' },
  { id: 'V-4', title: 'tpc 不同就是不同 session（每房一個 tpc、generation）', categories: ['fake-api', 'zoom'],
    evidence: [['tests/p1p3-integration.e2e.test.mjs', 'revoking mid-recording: new tokens lead to generation 1'], ['tests/classroom-multi.test.mjs', 'several rooms at once are separate sessions']],
    real: 'ihear-<id> 與 ihear-<id>-g1 得到不同 session_id，webhook 與錄影檔各自分開。' },
  { id: 'V-5', title: '停止錄影到 webhook 確認要多久；重複停止', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-api.test.mjs', 'consent withdrawn mid-lesson: stop at once on both channels'], ['tests/recording-operations.test.mjs', 'a stop whose executor stopped after Zoom took it']],
    real: '量 10 次 recording.stop → session.recording_stopped，最大值須 ≤ 30 秒；第二次停止的回應碼記錄下來。需要雲端錄影（帳號持有人核准）。' },
  { id: 'V-6', title: 'session 結束後舊 token 能否開出同名新 session', categories: ['fake-api', 'zoom'],
    evidence: [['tests/classroom-vendors.test.mjs', 'ending a session is PUT status end'], ['tests/classroom-multi.test.mjs', 'ending the block: no new token anywhere']],
    real: 'PUT …/status end 後用結束前簽的 token 加入，記錄能否進入、是否產生新 session_id。' },
  { id: 'V-7', title: '已在 session 的人 token 到期後會怎樣', categories: ['fake-api', 'zoom'],
    evidence: [['tests/classroom-vendors.test.mjs', 'the join token is the Video SDK JWT for this lesson and person']],
    real: '用 exp 30 分鐘的 token 入場並停留超過到期：是否被踢出、斷線重連是否被拒。' },
  { id: 'V-8', title: 'Zoom 換房與手機：離開再加入新房間要多久、會不會再問鏡頭／麥克風權限', categories: ['browser', 'zoom', 'owner'],
    evidence: [['tests/classroom-vendors.test.mjs', 'a new room waits until the previous one has released Zoom'], ['tests/classroom-multi.test.mjs', 'ASSIGNED → JOINING → JOINED']],
    browser: ['E7', 'E8', 'E9', 'E13'],
    real: '每種裝置各 5 次（Windows／macOS Chrome、Edge、Safari，iPad Safari，Android 平板，iPhone，Android 手機）：從伺服器指示換房到影音恢復的時間（中位數、最大值），是否重新詢問權限。頁面只會「提供」恢復裝置，不會自動開啟。' },
  { id: 'V-9', title: '我方回 503 時 webhook 的重送（次數、間隔、內容、順序）', categories: ['fake-api', 'zoom'],
    evidence: [['tests/p0-session-id.sim.test.mjs', 'G-1: a stop asked for before Zoom']],
    pathway: true,
    real: '測試端點對指定事件回 503，記錄重送次數與間隔（官方：5、20、60 分鐘），去重後只存一筆。' },
  { id: 'V-10', title: 'PUT …/status end 的效果（錄影中結束；重送 end）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/p0-session-id.sim.test.mjs', 'G-2: after the end request failed'], ['tests/classroom-vendors.test.mjs', 'ending a session is PUT status end']],
    real: '錄影中結束 session：session.ended、錄影停止、recording_completed 都要到，檔案完整；對已結束的 session 再送 end，記錄回應碼。需要雲端錄影。' },
  { id: 'V-11', title: '錄影控制只作用在指定 session；沒在錄影時送停止', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-multi.test.mjs', 'Classroom + Recording: each room records on its own'], ['tests/p0-session-id.sim.test.mjs', 'G-3: with two live sessions'], ['tests/p1p3-integration.e2e.test.mjs', 'two lessons recording at the same time']],
    real: '兩間房同時進行，只對 A 送開始與停止，B 不受影響；B 沒在錄影時送停止，記錄回應碼。' },
  { id: 'V-12', title: 'user.remove（不在範圍，D-3；改由伺服器停發 token 與頁面自動離開）', categories: [], outOfScope: true, evidence: [], real: '不測。' },
  { id: 'V-13', title: 'recording_start 代表什麼（不追溯、BEFORE_CONSENT 的 10 秒容許）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-api.test.mjs', 'consent entered before anyone is in the room counts']],
    real: '記下五個時間（送出開始、202、recording_started、檔案的 recording_start／end）並與畫面上的伺服器時鐘比對，差距 ≤ 10 秒才維持現行容許值。' },
  { id: 'V-14', title: '錄影 UNKNOWN：Zoom 能否回報進行中 session 的錄影狀態', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/recording-operations.test.mjs', 'an answer that was lost and a Zoom state that cannot be told: UNKNOWN']],
    real: '錄影中、暫停、停止時各呼叫 GET …?type=live，看 has_recording 是否即時；主持人端 getCloudRecordingStatus() 與 recording-change 是否即時。決定 UNKNOWN 能否自動解開（目前一律人工）。' },
  { id: 'V-15', title: '跨房 JWT：A 房的 token 不能進 B 房（tpc 綁房）', categories: ['fake-api', 'browser', 'zoom'],
    evidence: [['tests/classroom-multi.test.mjs', 'a student, a tutor and a moved student are refused in other rooms']],
    browser: ['E6'],
    real: '用 A 房 token 加入 B 房（含 tpc 大小寫不同），join 必須失敗。我方伺服器不會給 B 房 token（本機已驗）；Zoom 端是否擋下目前是推測。' },
  { id: 'V-16', title: '多間房同時錄影（同 RT-8；先 2 間，5／10 間另核准）', categories: ['fake-api', 'zoom', 'owner'],
    evidence: [['tests/classroom-multi.test.mjs', 'Classroom + Recording: each room records on its own'], ['tests/p1p3-integration.e2e.test.mjs', 'two lessons recording at the same time']],
    real: '每間各自有開始與完成事件、檔案不混房；記錄 REST 是否碰到 429。並行錄影上限官方沒有記載（未知）。' },
  { id: 'V-17', title: '主會議室（Lobby）沒人時多久關閉；之後再回來是否開新 session', categories: ['zoom'],
    evidence: [['tests/classroom-multi.test.mjs', 'with the manager gone, rooms carry on']],
    real: 'Lobby 的人全部進入教學房間後，記錄 session.ended 的時間；之後有人回 Lobby 時是否產生新 session_id。' },
  { id: 'D-1', title: '真實 MP4 下載與上傳（Zoom 錄影檔 → Drive）', categories: ['fake-api', 'zoom', 'drive', 'owner'],
    evidence: [['tests/classroom-vendors.test.mjs', 'a recording range is downloaded from the address listed for the file'], ['tests/classroom-multi-filing.test.mjs', 'the upload finished but writing the result failed']],
    pathway: true,
    real: '一段 TEST- 錄影（需雲端錄影核准）：下載大小與 Zoom 一致、上傳後 Drive 的大小與 md5 核對無誤、名稱與資料夾照 §9、Zoom 副本保留（刪除開關維持關閉）。' },
  { id: 'D-2', title: 'Drive 既有資料夾寫入（drive.file＋Picker 或服務帳戶；權限政策）', categories: ['fake-api', 'drive', 'owner'],
    evidence: [['tests/classroom-drive-google.test.mjs', 'with a parent folder named by configuration'], ['tests/classroom-drive-google.test.mjs', 'only a grant of exactly drive.file is used'], ['tests/classroom-multi-filing.test.mjs', 'a parent folder shared with anyone']],
    real: '測試帳號的資料夾（絕不用日常帳號，也不用任何老師或工作人員的真實資料夾）：資料夾擁有者用 Picker 選定後，drive.file 能否在其中建立子資料夾與檔案（官方文件未寫明，未知）；不行時改用方案 B（服務帳戶或共用雲端硬碟）。' },
];
