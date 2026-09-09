(function () {
  "use strict";
  const I18N = {
  "en": {},
  "zhTW": {
    "skip": "跳至主要內容",
    "nav_about": "關於我們",
    "nav_programs": "服務項目",
    "nav_impact": "成果",
    "nav_involve": "加入我們",
    "nav_cta": "申請輔導服務",
    "nav_resources": "資源",
    "nav_donate": "捐款",
    "hero_eyebrow": "學生主導 · 501(c)(3) 公益計畫 · 完全免費",
    "hero_h1a": "建立自信",
    "hero_h1b": "溝通",
    "hero_tagline": "包容性溝通。真實連結。",
    "hero_sub": "為聽力損失及其他溝通需求的學生提供包容性英語溝通支持，由受過訓練的學生志工和社區合作夥伴提供服務。",
    "cta_request": "申請輔導服務",
    "cta_volunteer": "成為志工導師",
    "cta_seminar": "預約講座",
    "trust_free": "100% 免費課程",
    "trust_sessions": "每週 40 分鐘課程",
    "trust_countries": "服務 4 個國家",
    "stat_sessions": "完成的輔導課程",
    "stat_asof": "截至 2026 年 6 月",
    "stat_students": "受惠學生",
    "stat_students_sub": "透過免費輔導",
    "stat_volunteers": "活躍志工",
    "stat_volunteers_sub": "8–12 年級學生導師",
    "stat_countries": "服務國家",
    "stat_countries_sub": "臺灣 · 中國 · 美國 · 加拿大",
    "latest_label": "最新成果",
    "latest_period": "2026 年 6 月",
    "latest_headline": "35+ 位志工 · 50+ 位學生 · 1,200+ 堂課",
    "latest_description": "匯聚來自 6+ 所高中的 35+ 位活躍志工，支持超過 50 位學生，累計完成 1,200+ 堂一對一英語溝通課程。",
    "latest_link": "查看我們的歷程 →",
    "mission_eyebrow": "我們的使命",
    "mission_h2": "iHear 為何而存在",
    "mission_text": "iHear 的使命是透過為有聽力或溝通需求的學生提供免費、個人化的溝通支持，推動溝通無障礙。我們同時舉辦教育講座提升社區對聽力健康的認識——減少溝通障礙，促進更具包容性的學習環境。",
    "pillar1_h": "包容性溝通",
    "pillar1_p": "透過免費一對一英語溝通輔導，支持聽力損失學生。",
    "pillar2_h": "社區意識",
    "pillar2_p": "透過講座和工作坊，教育社區認識聽力健康與溝通障礙。",
    "pillar3_h": "志工驅動",
    "pillar3_p": "100% 免費課程，由受過訓練、致力於創造改變的學生志工提供。",
    "prog_eyebrow": "服務項目",
    "prog_h2": "建立包容性溝通的兩種方式",
    "prog_sub": "直接的學生支持與社區教育——全球社群，在地行動，遍及臺灣、中國、美國與加拿大。",
    "prog1_h": "一對一英語輔導",
    "prog1_p": "由受過訓練的高中志工透過 Zoom 提供免費、個人化的英語溝通課程——服務聽力損失及其他溝通需求的學生（包括自閉症譜系與需要協助的 ESL 學習者）。AI 輔助的課程計畫以專業教案為基礎，並參考言語治療師的意見。",
    "prog1_b1": "每週 40 分鐘 Zoom 課程（年齡較小的學生為 30 分鐘）",
    "prog1_b2": "受訓學生導師，雙導師制確保課程連續性",
    "prog1_b3": "100% 免費——專注於會話、發音、閱讀與寫作",
    "prog2_h": "社區推廣與講座",
    "prog2_p": "為銀髮中心、輔助生活機構、社區團體與家庭舉辦互動式聽力健康講座——涵蓋聽力損失的影響、實用溝通策略、消除偏見與營造包容環境。",
    "prog2_b2": "客製化簡報——線上或實體皆可",
    "train1_h": "每月培訓工作坊",
    "train1_p": "每位志工皆完成包容性溝通策略、聽力健康意識與有效教學的結構化培訓——講者包括言語治療師與聽力健康專業人員。",
    "train2_h": "導師制與雙導師教學",
    "train2_p": "新導師與資深導師配對進行雙導師課程——傳承經驗、建立信心，確保每位學生的課程穩定連貫。",
    "steps_eyebrow": "如何開始",
    "steps_h2": "簡單三步驟，開始您的學習之旅",
    "step1_h": "填寫申請表",
    "step1_p": "填寫簡單的線上申請表，告訴我們您的需求和目標——或直接寄信給我們。",
    "step2_h": "配對輔導老師",
    "step2_p": "我們會根據您的需求，為您配對最合適的輔導老師（通常需 1–2 週），並安排初次見面。",
    "step3_h": "開始學習",
    "step3_p": "與您的輔導老師建立學習計畫，開始您的英語溝通提升之旅！",
    "impact_eyebrow": "我們的成果",
    "impact_h2": "以數據呈現的實際成效",
    "impact_sub": "根據 2025 年 10 至 12 月收集的 260 份導師課後反思與 60 份學員/家長回饋。",
    "impact_learners_h": "學習成果",
    "impact_learners_src": "由學員與家長回報",
    "outcome_conf": "自信心提升",
    "outcome_pron": "發音清晰度",
    "outcome_flu": "口說流利度",
    "outcome_sat": "整體滿意度",
    "impact_tutors_h": "導師觀察",
    "impact_tutors_src": "來自 260 份課後反思",
    "tobs_conf": "自信心成長",
    "tobs_flu": "自然的語言流暢度",
    "tobs_pron": "更清晰準確的發音",
    "tobs_ssl": "已頒發志工服務時數（SSL）",
    "key_label": "關鍵發現：",
    "key_text": "學員將自信心的提升評為本計畫最重要的成果。",
    "journey_eyebrow": "我們的歷程",
    "journey_h2": "從兩位學生到四個國家",
    "tl1_when": "2024 年 6 月",
    "tl1_h": "試辦階段開始",
    "tl1_p": "Zoe Lu 開始為兩位配戴人工耳蝸的兒童提供個別化英語溝通支持（由奇美醫學中心轉介）。",
    "tl2_when": "2024 年 11 月",
    "tl2_h": "與婦聯聽障文教基金會合作",
    "tl2_p": "Howard Ren 加入擔任共同會長。與婦聯聽覺健康基金會的合作將服務擴展至另外 13 位學生。",
    "tl3_when": "2024 年 12 月",
    "tl3_h": "成為 CAPA-MC 旗下計畫",
    "tl3_p": "iHear 正式獲准成為 501(c)(3) 非營利組織 CAPA-MC 旗下的計畫，取得正式架構與種子資金。",
    "tl4_when": "2025 年 6 月",
    "tl4_h": "正式啟動會議",
    "tl4_p": "正式啟動，匯聚志工導師與領導團隊，確立使命與倡議目標。",
    "tl5_when": "2025 年 9 月",
    "tl5_h": "社區推廣啟動",
    "tl5_p": "在銀髮中心舉辦第一場聽力健康講座。每月導師培訓工作坊啟動。",
    "tl6_when": "2025 年 10 月",
    "tl6_h": "MBHS 分部與組長制度",
    "tl6_p": "於 Montgomery Blair 高中成立分部。導入組長（Team Lead）制度與課後反思表，落實品質管理。",
    "tl7_when": "2025 年 11 月",
    "tl7_h": "獲頒 AAHI 補助",
    "tl7_p": "獲蒙哥馬利郡 AAHI 補助（頒予 CAPA-MC），支持長者聽力健康相關的社區推廣活動。",
    "tl8_when": "2025 年 12 月",
    "tl8_h": "36 位志工 · 40+ 位學生 · 639 堂課",
    "tl8_p": "達成來自 6+ 所高中的 36 位活躍志工，支持 4 個國家（臺灣、中國、美國、加拿大）超過 40 位學生，共完成 639 堂輔導課程。",
    "nav_team": "團隊",
    "team_eyebrow": "我們的團隊",
    "team_h2": "認識我們的團隊",
    "team_sub": "致力於透過包容性、個人化支持建立自信溝通的學生志工。",
    "team_intro": "iHear 由學生領導團隊帶領，致力於為有多元需求的學習者打造包容、高品質的溝通支持。我們的領導者共同塑造計畫願景、教學品質與日常執行，確保 iHear 始終以使命為導向、以影響力為核心。",
    "role_leadtutor": "首席導師",
    "tlnote_h": "組長——計畫營運與協調",
    "tlnote_p": "組長支持日常計畫協調，包括導師排課、入職流程、內部溝通與營運工作流程。他們的工作確保導師與各項計畫獲得充分支持，同時維護 iHear 的標準。",
    "ts1_b": "35+ 位活躍導師",
    "ts1_s": "來自美國與臺灣 6+ 所高中的熱忱志工",
    "ts2_b": "完整培訓",
    "ts2_s": "所有導師皆完成包容性溝通策略培訓",
    "team_cta": "查看完整導師檔案",
    "roster_h": "我們的導師",
    "roster_sub": "所有 iHear 導師的完整檔案。點選姓名閱讀他們的故事。",
    "roster_more_h": "其他團隊成員",
    "roster_bio_p": "您是還沒有檔案的 iHear 導師嗎？",
    "roster_bio_cta": "提交您的簡介",
    "bio_eyebrow": "iHear 導師專區",
    "bio_h2": "提交您的簡介",
    "bio_sub": "讓學生和家長認識您。您的檔案將在審核後顯示於團隊頁面。",
    "bf_name": "全名 *",
    "bf_school": "學校",
    "bf_grade": "年級",
    "bf_langs": "您會說的語言",
    "bf_tags": "教學專長（例如：發音指導、建立自信）",
    "bf_short": "簡短介紹：一到兩句話描述您的教學方式 *",
    "bf_long": "完整介紹：您加入 iHear 的原因與課程的樣貌",
    "bf_hobbies": "興趣與愛好",
    "bf_consent": "我同意 iHear 將所提交的姓名、學校／年級（如有提供）及簡介發布於公開的團隊頁面。若我未滿法定年齡，我確認已取得適用的家長或監護人同意。",
    "bf_note": "送出後會在您的郵件程式中開啟一封寄給 ihearprogram@gmail.com 的預填郵件。本網站不會儲存任何資料。",
    "bf_send": "寄出我的簡介",
    "testi_eyebrow": "成功故事",
    "testi_h2": "家長與學生見證",
    "testi_sub": "聽聽我們的學生和家長怎麼說——來自 iHear 社群的真實回饋。",
    "q1": "「上了一兩堂課後，我真的感受到一種強烈的渴望，想要流利地說英語。每次下課後，我都會開心地說：『我今天進步好多！』這真的很神奇。」",
    "q1_by": "— 學生",
    "q2": "「感謝團隊培育出這麼多優秀的年輕導師，讓學曜願意重新開始全英語沉浸式課程。」",
    "q2_by": "— X.Y. 家長（臺灣）",
    "q3": "「老師會先讓我朗讀，然後放慢速度示範朗讀，希望我觀察、找出差異並嘗試自我修正。Kevin 現在不再害怕，朗讀也更流利了。」",
    "q3_by": "— K. 的家長",
    "q4": "「老師非常有耐心，而且真正理解我孩子的需求。我們看到了顯著的進步，不僅是在英語能力上，更重要的是在自信心上。」",
    "q4_by": "— 家長",
    "video_h2": "看看我們的影響力",
    "video_sub": "看我們如何一起建立自信的溝通。",
    "involve_eyebrow": "加入我們",
    "involve_h2": "在 iHear，總有屬於您的位置",
    "involve_sub": "無論您是想尋求支持，還是想成為志工，我們都在這裡協助您。",
    "inv1_h": "成為志工導師",
    "inv1_p": "透過擔任英語溝通導師志工，為聽損學生帶來改變——幫助他們建立自信，同時累積 SSL 服務時數並培養領導能力。",
    "inv1_b1": "8–12 年級 · 每週 1–2 小時 · 每月培訓工作坊",
    "inv1_b2": "提供完整培訓——歡迎雙語及純英語導師",
    "inv1_b3": "彈性線上課程 · 已頒發 600+ 小時 SSL 服務時數",
    "inv1_cta": "申請成為導師",
    "inv2_h": "申請免費輔導",
    "inv2_p": "獲得由受訓學生志工提供的免費個人化英語溝通支援。專為聽損學生及其他有溝通需求的學生設計。",
    "inv2_b1": "100% 免費課程",
    "inv2_b2": "一對一個人化課程",
    "inv2_b3": "專注於您的學習目標",
    "donate_eyebrow": "支持 iHear 的使命",
    "donate_h2": "每一份支持，都在創造機會",
    "donate_sub": "您的每一份支持，都在為有溝通需求的學生創造改變的機會——每一份捐款，無論金額大小，都是對學生未來的投資。",
    "don1_h": "支持更多學生",
    "don1_p": "讓我們能夠服務更多國家中有聽力損失與溝通需求的學生。",
    "don2_h": "提升教學品質",
    "don2_p": "投資於導師培訓、課程開發與 AI 輔助學習工具。",
    "don3_h": "擴大全球影響",
    "don3_p": "將無障礙溝通帶到世界更多社區。",
    "donate_line": "任何金額的捐款都將直接支持我們的使命——iHear 團隊與老師衷心感謝您的支持與信任！",
    "donate_cta": "立即捐款",
    "res_eyebrow": "免費資源",
    "res_h2": "給家庭與教育工作者的指南",
    "res_sub": "九份實用指南，提供英文、繁體中文、簡體中文與西班牙文版本。歡迎來信索取，完全免費。",
    "res_cta": "來信索取指南",
    "res1": "有效溝通策略",
    "res2": "課堂溝通指南",
    "res3": "家庭溝通工具包",
    "res4": "理解聽力損失",
    "res5": "人工耳蝸基礎知識",
    "res6": "助聽器保養指南",
    "res7": "英語學習活動",
    "res8": "進度追蹤範本",
    "res9": "志工導師手冊",
    "faqcat1": "計畫資格",
    "faqcat2": "課程安排",
    "faqcat3": "導師資格",
    "faqcat4": "技術需求",
    "faqcat5": "如何開始",
    "f1q": "誰符合 iHear 輔導資格？",
    "f1a": "本計畫為有聽力損失或其他溝通需求、希望提升英語溝通能力的學生設計。我們歡迎各年齡層的學生，從小學到高中及以上。配戴人工耳蝸、助聽器或任何程度聽力損失的學生都歡迎申請。",
    "f2q": "輔導需要付費嗎？",
    "f2a": "不需要，所有 iHear 輔導服務對學生和家庭完全免費。我們的計畫由訓練有素的志願導師和社區支持提供支持。我們相信每位學生無論經濟狀況，都應獲得高品質的英語溝通支持。",
    "f3q": "需要住在特定地區才能參加嗎？",
    "f3a": "不需要！所有課程皆透過 Zoom 進行，我們可以服務世界任何地方的學生。目前我們的學生遍及 4 個國家，並與不同時區的家庭協調合適的上課時間。",
    "f4q": "學生需要具備什麼英語程度？",
    "f4a": "歡迎任何英語程度的學生！導師會根據每位學生目前的能力與目標量身設計課程。無論您的孩子剛開始學英語，還是想精進高階溝通技巧，我們都能提供協助。",
    "f5q": "每堂課多長？",
    "f5a": "標準課程為每週一次、每次 40 分鐘。年齡較小或注意力有限的學生可選擇 30 分鐘課程。課程長度可依孩子的需求與偏好調整。",
    "f6q": "課程多久一次？",
    "f6a": "課程通常每週一次，固定在同一天同一時間。規律的時間表有助於建立習慣，讓學生穩定進步。我們會與家庭協調合適的時間。",
    "f7q": "可以更改上課時間嗎？",
    "f7a": "可以！我們理解時間安排會有變化。如需調整固定上課時間或改期，請來信 ihearprogram@gmail.com，我們會與您和導師一起找到大家都方便的新時間。",
    "f8q": "如果我們在不同時區怎麼辦？",
    "f8a": "我們與多個時區的家庭合作！申請輔導時，請告知您的時區與偏好的上課時間，我們會為您配對時間相符的導師。",
    "f9q": "計畫需要承諾多久？",
    "f9a": "沒有固定的承諾期限。只要課程對學生有幫助，就可以持續參加。許多學生與導師合作數月至一年以上。您可以隨時通知我們暫停或結束輔導。",
    "f10q": "iHear 的導師是誰？",
    "f10a": "我們的導師是自願奉獻時間、支持聽力損失學生的高中生。他們熱衷於包容性溝通，致力於引導學生克服障礙，建立英語溝通的自信與能力。",
    "f11q": "導師接受什麼培訓？",
    "f11a": "所有導師皆完成包容性溝通策略、聽損學生教學及有效線上教學方法的完整培訓。他們學習人工耳蝸、助聽器、視覺溝通技巧，以及如何打造無障礙的學習環境。",
    "f12q": "如何為學生配對導師？",
    "f12a": "我們根據學生的年齡、學習目標、興趣、溝通需求與時間安排等多項因素細心配對，力求建立讓學生與導師都能正向成長的夥伴關係。",
    "f13q": "如果師生配對效果不佳怎麼辦？",
    "f13a": "我們持續追蹤師生配對成效，確保良好的學習體驗。如對配對有任何疑慮，請來信 ihearprogram@gmail.com，我們將與您討論並共同找出最適合孩子的方案。",
    "f14q": "課程使用什麼平台？",
    "f14a": "所有輔導課程皆透過 Zoom 進行。該平台提供穩定的視訊品質、螢幕分享功能，以及對聽損學生特別有幫助的即時字幕等無障礙功能。",
    "f15q": "我們需要什麼設備？",
    "f15a": "您需要一台有鏡頭與麥克風的電腦、平板或智慧型手機，以及穩定的網路連線。建議使用耳機以獲得更好的音質。若孩子使用助聽器或人工耳蝸，上課時請配戴。",
    "f16q": "遇到技術問題怎麼辦？",
    "f16a": "技術問題難免發生！若連線 Zoom 或上課中遇到問題，請聯繫 ihearprogram@gmail.com。我們可以協助排除問題或改期。導師也會耐心協助解決小型技術狀況。",
    "f17q": "配對輔導老師需要多久？",
    "f17a": "配對通常需要 1–2 週，視導師的時間與您的排程偏好而定。我們重視「找到最合適的導師」勝過速度，確保您的孩子與最能支持其學習目標的導師配對。",
    "f18q": "第一堂課會做什麼？",
    "f18a": "第一堂課是導師與學生互相認識的時間——討論學習目標、興趣與溝通偏好。導師會評估學生目前的英語程度，並開始規劃個人化課程。歡迎家長一同參與第一堂課。",
    "f19q": "課程期間家長需要在場嗎？",
    "f19a": "這取決於學生的年齡與自在程度。年幼的學生可能希望家長在附近提供支持；年長的學生通常偏好獨立上課。我們鼓勵家長定期與導師交流，了解學習進度。",
    "f20q": "我的孩子會在輔導課程中學到什麼？",
    "f20a": "課程依每位學生的目標量身打造：發音、英語會話、詞彙累積、閱讀理解、寫作能力，以及口語溝通的自信。導師會結合學生的興趣設計課程，讓學習保持趣味。",
    "growth_h": "6 個月成長 6 倍",
    "growth_src": "從試辦計畫成長為服務臺灣、中國、美國與加拿大學習者的全球社群。",
    "growth_a_when": "2025 年 6 月",
    "growth_a1": "11 位導師",
    "growth_a2": "12 位學員",
    "growth_a3": "105 堂課程",
    "growth_b_when": "2025 年 12 月",
    "growth_b1": "36 位導師",
    "growth_b2": "40+ 位學員",
    "growth_b3": "639 堂課程 · 4 個國家",
    "ins_h": "iHear 有效的原因",
    "ins1": "導師的耐心——約 40% 的家庭回饋中提及",
    "ins2": "清楚的講解與靈活調整的教學方法",
    "ins3": "依個人需求量身打造的個人化學習",
    "ins4": "雙語支持，理解無障礙",
    "ins5": "約 55% 的學員希望有更多英語沉浸練習",
    "ins6": "曾經受挫的學習者重新投入英語學習",
    "other_p": "除了輔導之外，我們正在發展更多志工角色：行政支援、社區推廣與活動協調。",
    "other_cta": "表達您的興趣",
    "acad_eyebrow": "iHear Academy",
    "acad_h2": "以使命為本的付費輔導，支持免費服務",
    "acad_p1": "iHear Academy 是與使命一致的付費輔導計畫。計畫收入用於導師報酬、培訓與課程開發，盈餘則再投入 iHear Program，擴大為聽力與溝通需求學習者提供的免費服務。",
    "acad_p2": "Academy 專注於最實用的核心能力：發音、口說流利度、聽力理解、詞彙，以及最重要的——敢於開口的自信。在沉浸式環境中，學生從「學習英文」進步到「用英文學習」。滿意度達 93%。",
    "acad_cta1": "洽詢 iHear Academy",
    "acad_cta2": "學費方案與課程",
    "donor_p": "我們正在建立捐贈者名單，您的名字可以在這裡！捐贈者將依級別致謝：創始捐贈者、主要捐贈者（$500+）、支持捐贈者（$100–$499）與 iHear 之友。",
    "prog2_b1": "已觸及 200+ 位社區成員 · 兩場社區講座 120+ 位參與者（2025 年 10 月與 2026 年 1 月）",
    "prog2_b3": "與 CAPA-MC 合作，由 AAHI（亞裔美國人健康倡議）資助",
    "faq_eyebrow": "常見問題",
    "faq_h2": "我們能幫上什麼忙？",
    "contact_eyebrow": "聯絡我們",
    "contact_h2": "我們很樂意聽到您的聲音",
    "contact_sub": "有任何問題？想加入我們？歡迎隨時聯繫——中英文皆可。",
    "contact_email_h": "寫信給我們",
    "contact_email_p": "申請輔導時，請附上學生姓名與年齡、溝通需求或目標、偏好的上課時間，以及任何有助於我們服務您的資訊。",
    "contact_email_cta": "寄送電子郵件",
    "contact_region_h": "服務跨區域的學習者",
    "contact_region_p": "我們的志工導師主要位於美國（包括馬里蘭州與密西根州）與臺灣——服務臺灣、中國、美國與加拿大的學生。所有課程皆透過 Zoom 線上進行。",
    "contact_forms_h": "偏好使用表單？",
    "contact_form_cta": "開啟申請表單",
    "foot_tag": "建立自信溝通——從每一次對話開始。",
    "foot_desc": "為聽力損失及其他溝通需求的學生提供包容性英語溝通支持。",
    "foot_prog_h": "服務項目",
    "foot_prog1": "英語輔導",
    "foot_prog2": "社區推廣",
    "foot_prog3": "資源庫",
    "foot_prog4": "iHear Academy",
    "foot_inv_h": "加入我們",
    "foot_inv1": "成為 iHear 志工",
    "foot_inv2": "申請輔導服務",
    "foot_inv3": "支持我們的使命",
    "foot_inv4": "課程回饋表",
    "foot_inv5": "提交導師簡介",
    "foot_more_h": "更多",
    "foot_more1": "關於我們",
    "foot_more2": "我們的成果",
    "foot_more3": "聯絡我們",
    "foot_more4": "我們的團隊",
    "foot_more5": "常見問題",
    "foot_more6": "學員故事",
    "foot_copy": "© 2024–Present iHear Program 版權所有。隸屬於 CAPA-MC（501(c)(3)）。",
    "foot_made": "由 Monnast 設計、發布與維護。"
  },
  "zhCN": {
    "skip": "跳至主要内容",
    "nav_about": "关于我们",
    "nav_programs": "服务项目",
    "nav_impact": "成果",
    "nav_involve": "加入我们",
    "nav_cta": "申请辅导服务",
    "nav_resources": "资源",
    "nav_donate": "捐款",
    "hero_eyebrow": "学生主导 · 501(c)(3) 公益项目 · 完全免费",
    "hero_h1a": "建立自信",
    "hero_h1b": "沟通",
    "hero_tagline": "包容性沟通。真实连结。",
    "hero_sub": "为听力损失及其他沟通需求的学生提供包容性英语沟通支持，由受过训练的学生志愿者和社区合作伙伴提供服务。",
    "cta_request": "申请辅导服务",
    "cta_volunteer": "成为志愿导师",
    "cta_seminar": "预约讲座",
    "trust_free": "100% 免费课程",
    "trust_sessions": "每周 40 分钟课程",
    "trust_countries": "服务 4 个国家",
    "stat_sessions": "完成的辅导课程",
    "stat_asof": "截至 2026 年 6 月",
    "stat_students": "受惠学生",
    "stat_students_sub": "通过免费辅导",
    "stat_volunteers": "活跃志愿者",
    "stat_volunteers_sub": "8–12 年级学生导师",
    "stat_countries": "服务国家",
    "stat_countries_sub": "台湾 · 中国 · 美国 · 加拿大",
    "latest_label": "最新成果",
    "latest_period": "2026 年 6 月",
    "latest_headline": "35+ 位志愿者 · 50+ 位学生 · 1,200+ 节课",
    "latest_description": "汇聚来自 6+ 所高中的 35+ 位活跃志愿者，支持超过 50 位学生，累计完成 1,200+ 节一对一英语沟通课程。",
    "latest_link": "查看我们的历程 →",
    "mission_eyebrow": "我们的使命",
    "mission_h2": "iHear 为何而存在",
    "mission_text": "iHear 的使命是通过为有听力或沟通需求的学生提供免费、个性化的沟通支持，推动沟通无障碍。我们同时举办教育讲座提升社区对听力健康的认识——减少沟通障碍，促进更具包容性的学习环境。",
    "pillar1_h": "包容性沟通",
    "pillar1_p": "通过免费一对一英语沟通辅导，支持听力损失学生。",
    "pillar2_h": "社区意识",
    "pillar2_p": "通过讲座和工作坊，教育社区认识听力健康与沟通障碍。",
    "pillar3_h": "志愿者驱动",
    "pillar3_p": "100% 免费课程，由受过训练、致力于创造改变的学生志愿者提供。",
    "prog_eyebrow": "服务项目",
    "prog_h2": "建立包容性沟通的两种方式",
    "prog_sub": "直接的学生支持与社区教育——全球社群，本地行动，遍及台湾、中国、美国与加拿大。",
    "prog1_h": "一对一英语辅导",
    "prog1_p": "由受过训练的高中志愿者通过 Zoom 提供免费、个性化的英语沟通课程——服务听力损失及其他沟通需求的学生（包括自闭症谱系与需要帮助的 ESL 学习者）。AI 辅助的课程计划以专业教案为基础，并参考言语治疗师的意见。",
    "prog1_b1": "每周 40 分钟 Zoom 课程（年龄较小的学生为 30 分钟）",
    "prog1_b2": "受训学生导师，双导师制确保课程连续性",
    "prog1_b3": "100% 免费——专注于会话、发音、阅读与写作",
    "prog2_h": "社区推广与讲座",
    "prog2_p": "为老年中心、辅助生活机构、社区团体与家庭举办互动式听力健康讲座——涵盖听力损失的影响、实用沟通策略、消除偏见与营造包容环境。",
    "prog2_b2": "定制化演讲——线上或线下皆可",
    "train1_h": "每月培训工作坊",
    "train1_p": "每位志愿者都完成包容性沟通策略、听力健康意识与有效教学的结构化培训——讲者包括言语治疗师与听力健康专业人员。",
    "train2_h": "导师制与双导师教学",
    "train2_p": "新导师与资深导师配对进行双导师课程——传承经验、建立信心，确保每位学生的课程稳定连贯。",
    "steps_eyebrow": "如何开始",
    "steps_h2": "简单三步骤，开始您的学习之旅",
    "step1_h": "填写申请表",
    "step1_p": "填写简单的在线申请表，告诉我们您的需求和目标——或直接给我们发邮件。",
    "step2_h": "匹配辅导老师",
    "step2_p": "我们会根据您的需求，为您匹配最合适的辅导老师（通常需 1–2 周），并安排初次见面。",
    "step3_h": "开始学习",
    "step3_p": "与您的辅导老师建立学习计划，开始您的英语沟通提升之旅！",
    "impact_eyebrow": "我们的成果",
    "impact_h2": "以数据呈现的实际成效",
    "impact_sub": "根据 2025 年 10 至 12 月收集的 260 份导师课后反思与 60 份学员/家长反馈。",
    "impact_learners_h": "学习成果",
    "impact_learners_src": "由学员与家长报告",
    "outcome_conf": "自信心提升",
    "outcome_pron": "发音清晰度",
    "outcome_flu": "口语流利度",
    "outcome_sat": "整体满意度",
    "impact_tutors_h": "导师观察",
    "impact_tutors_src": "来自 260 份课后反思",
    "tobs_conf": "自信心成长",
    "tobs_flu": "自然的语言流畅度",
    "tobs_pron": "更清晰准确的发音",
    "tobs_ssl": "已颁发志愿服务时数（SSL）",
    "key_label": "关键发现：",
    "key_text": "学员将自信心的提升评为本项目最重要的成果。",
    "journey_eyebrow": "我们的历程",
    "journey_h2": "从两位学生到四个国家",
    "tl1_when": "2024 年 6 月",
    "tl1_h": "试点阶段开始",
    "tl1_p": "Zoe Lu 开始为两位佩戴人工耳蜗的儿童提供个性化英语沟通支持（由奇美医学中心转介）。",
    "tl2_when": "2024 年 11 月",
    "tl2_h": "与妇联听障文教基金会合作",
    "tl2_p": "Howard Ren 加入担任联合会长。与妇联听觉健康基金会的合作将服务扩展至另外 13 位学生。",
    "tl3_when": "2024 年 12 月",
    "tl3_h": "成为 CAPA-MC 旗下项目",
    "tl3_p": "iHear 正式获准成为 501(c)(3) 非营利组织 CAPA-MC 旗下的项目，获得正式架构与种子资金。",
    "tl4_when": "2025 年 6 月",
    "tl4_h": "正式启动会议",
    "tl4_p": "正式启动，汇聚志愿导师与领导团队，确立使命与倡议目标。",
    "tl5_when": "2025 年 9 月",
    "tl5_h": "社区推广启动",
    "tl5_p": "在老年中心举办第一场听力健康讲座。每月导师培训工作坊启动。",
    "tl6_when": "2025 年 10 月",
    "tl6_h": "MBHS 分部与组长制度",
    "tl6_p": "于 Montgomery Blair 高中成立分部。引入组长（Team Lead）制度与课后反思表，落实质量管理。",
    "tl7_when": "2025 年 11 月",
    "tl7_h": "获颁 AAHI 资助",
    "tl7_p": "获蒙哥马利县 AAHI 资助（颁予 CAPA-MC），支持长者听力健康相关的社区推广活动。",
    "tl8_when": "2025 年 12 月",
    "tl8_h": "36 位志愿者 · 40+ 位学生 · 639 节课",
    "tl8_p": "达成来自 6+ 所高中的 36 位活跃志愿者，支持 4 个国家（台湾、中国、美国、加拿大）超过 40 位学生，共完成 639 节辅导课程。",
    "nav_team": "团队",
    "team_eyebrow": "我们的团队",
    "team_h2": "认识我们的团队",
    "team_sub": "致力于通过包容性、个性化支持建立自信沟通的学生志愿者。",
    "team_intro": "iHear 由学生领导团队带领，致力于为有多元需求的学习者打造包容、高质量的沟通支持。我们的领导者共同塑造项目愿景、教学质量与日常执行，确保 iHear 始终以使命为导向、以影响力为核心。",
    "role_leadtutor": "首席导师",
    "tlnote_h": "组长——项目运营与协调",
    "tlnote_p": "组长支持日常项目协调，包括导师排课、入职流程、内部沟通与运营工作流程。他们的工作确保导师与各项目获得充分支持，同时维护 iHear 的标准。",
    "ts1_b": "35+ 位活跃导师",
    "ts1_s": "来自美国与台湾 6+ 所高中的热忱志愿者",
    "ts2_b": "完整培训",
    "ts2_s": "所有导师均完成包容性沟通策略培训",
    "team_cta": "查看完整导师档案",
    "roster_h": "我们的导师",
    "roster_sub": "所有 iHear 导师的完整档案。点击姓名阅读他们的故事。",
    "roster_more_h": "其他团队成员",
    "roster_bio_p": "您是还没有档案的 iHear 导师吗？",
    "roster_bio_cta": "提交您的简介",
    "bio_eyebrow": "iHear 导师专区",
    "bio_h2": "提交您的简介",
    "bio_sub": "让学生和家长认识您。您的档案将在审核后显示于团队页面。",
    "bf_name": "全名 *",
    "bf_school": "学校",
    "bf_grade": "年级",
    "bf_langs": "您会说的语言",
    "bf_tags": "教学专长（例如：发音指导、建立自信）",
    "bf_short": "简短介绍：一到两句话描述您的教学方式 *",
    "bf_long": "完整介绍：您加入 iHear 的原因与课程的样子",
    "bf_hobbies": "兴趣与爱好",
    "bf_consent": "我同意 iHear 将所提交的姓名、学校／年级（如有提供）及简介发布于公开的团队页面。若我未满法定年龄，我确认已取得适用的家长或监护人同意。",
    "bf_note": "提交后会在您的邮件程序中打开一封发给 ihearprogram@gmail.com 的预填邮件。本网站不会存储任何数据。",
    "bf_send": "发送我的简介",
    "testi_eyebrow": "成功故事",
    "testi_h2": "家长与学生见证",
    "testi_sub": "听听我们的学生和家长怎么说——来自 iHear 社群的真实反馈。",
    "q1": "「上了一两堂课后，我真的感受到一种强烈的渴望，想要流利地说英语。每次下课后，我都会开心地说：'我今天进步好多！'这真的很神奇。」",
    "q1_by": "— 学生",
    "q2": "「感谢团队培育出这么多优秀的年轻导师，让学曜愿意重新开始全英语沉浸式课程。」",
    "q2_by": "— X.Y. 家长（台湾）",
    "q3": "「老师会先让我朗读，然后放慢速度示范朗读，希望我观察、找出差异并尝试自我修正。Kevin 现在不再害怕，朗读也更流利了。」",
    "q3_by": "— K. 的家长",
    "q4": "「老师非常有耐心，而且真正理解我孩子的需求。我们看到了显著的进步，不仅是在英语能力上，更重要的是在自信心上。」",
    "q4_by": "— 家长",
    "video_h2": "看看我们的影响力",
    "video_sub": "看我们如何一起建立自信的沟通。",
    "involve_eyebrow": "加入我们",
    "involve_h2": "在 iHear，总有属于您的位置",
    "involve_sub": "无论您是想寻求支持，还是想成为志愿者，我们都在这里帮助您。",
    "inv1_h": "成为志愿导师",
    "inv1_p": "通过担任英语沟通导师志愿者，为听损学生带来改变——帮助他们建立自信，同时积累 SSL 服务时数并培养领导能力。",
    "inv1_b1": "8–12 年级 · 每周 1–2 小时 · 每月培训工作坊",
    "inv1_b2": "提供完整培训——欢迎双语及纯英语导师",
    "inv1_b3": "灵活在线课程 · 已颁发 600+ 小时 SSL 服务时数",
    "inv1_cta": "申请成为导师",
    "inv2_h": "申请免费辅导",
    "inv2_p": "获得由受训学生志愿者提供的免费个性化英语沟通支持。专为听损学生及其他有沟通需求的学生设计。",
    "inv2_b1": "100% 免费课程",
    "inv2_b2": "一对一个性化课程",
    "inv2_b3": "专注于您的学习目标",
    "donate_eyebrow": "支持 iHear 的使命",
    "donate_h2": "每一份支持，都在创造机会",
    "donate_sub": "您的每一份支持，都在为有沟通需求的学生创造改变的机会——每一份捐款，无论金额大小，都是对学生未来的投资。",
    "don1_h": "支持更多学生",
    "don1_p": "让我们能够服务更多国家中有听力损失与沟通需求的学生。",
    "don2_h": "提升教学质量",
    "don2_p": "投资于导师培训、课程开发与 AI 辅助学习工具。",
    "don3_h": "扩大全球影响",
    "don3_p": "将无障碍沟通带到世界更多社区。",
    "donate_line": "任何金额的捐款都将直接支持我们的使命——iHear 团队与老师衷心感谢您的支持与信任！",
    "donate_cta": "立即捐款",
    "res_eyebrow": "免费资源",
    "res_h2": "给家庭与教育工作者的指南",
    "res_sub": "九份实用指南，提供英文、繁体中文、简体中文与西班牙文版本。欢迎来信索取，完全免费。",
    "res_cta": "来信索取指南",
    "res1": "有效沟通策略",
    "res2": "课堂沟通指南",
    "res3": "家庭沟通工具包",
    "res4": "理解听力损失",
    "res5": "人工耳蜗基础知识",
    "res6": "助听器保养指南",
    "res7": "英语学习活动",
    "res8": "进度跟踪模板",
    "res9": "志愿导师手册",
    "faqcat1": "项目资格",
    "faqcat2": "课程安排",
    "faqcat3": "导师资格",
    "faqcat4": "技术要求",
    "faqcat5": "如何开始",
    "f1q": "谁符合 iHear 辅导资格？",
    "f1a": "本项目为有听力损失或其他沟通需求、希望提升英语沟通能力的学生设计。我们欢迎各年龄段的学生，从小学到高中及以上。佩戴人工耳蜗、助听器或任何程度听力损失的学生都欢迎申请。",
    "f2q": "辅导需要付费吗？",
    "f2a": "不需要，所有 iHear 辅导服务对学生和家庭完全免费。我们的项目由训练有素的志愿者导师和社区支持提供支持。我们相信每位学生无论经济状况，都应获得高质量的英语沟通支持。",
    "f3q": "需要住在特定地区才能参加吗？",
    "f3a": "不需要！所有课程均通过 Zoom 进行，我们可以服务世界任何地方的学生。目前我们的学生遍及 4 个国家，并与不同时区的家庭协调合适的上课时间。",
    "f4q": "学生需要具备什么英语水平？",
    "f4a": "欢迎任何英语水平的学生！导师会根据每位学生目前的能力与目标量身设计课程。无论您的孩子刚开始学英语，还是想精进高阶沟通技巧，我们都能提供帮助。",
    "f5q": "每节课多长？",
    "f5a": "标准课程为每周一次、每次 40 分钟。年龄较小或注意力有限的学生可选择 30 分钟课程。课程长度可根据孩子的需求与偏好调整。",
    "f6q": "课程多久一次？",
    "f6a": "课程通常每周一次，固定在同一天同一时间。规律的时间表有助于建立习惯，让学生稳定进步。我们会与家庭协调合适的时间。",
    "f7q": "可以更改上课时间吗？",
    "f7a": "可以！我们理解时间安排会有变化。如需调整固定上课时间或改期，请发邮件至 ihearprogram@gmail.com，我们会与您和导师一起找到大家都方便的新时间。",
    "f8q": "如果我们在不同时区怎么办？",
    "f8a": "我们与多个时区的家庭合作！申请辅导时，请告知您的时区与偏好的上课时间，我们会为您匹配时间相符的导师。",
    "f9q": "项目需要承诺多久？",
    "f9a": "没有固定的承诺期限。只要课程对学生有帮助，就可以持续参加。许多学生与导师合作数月至一年以上。您可以随时通知我们暂停或结束辅导。",
    "f10q": "iHear 的导师是谁？",
    "f10a": "我们的导师是自愿奉献时间、支持听力损失学生的高中生。他们热衷于包容性沟通，致力于引导学生克服障碍，建立英语沟通的自信与能力。",
    "f11q": "导师接受什么培训？",
    "f11a": "所有导师均完成包容性沟通策略、听损学生教学及有效在线教学方法的完整培训。他们学习人工耳蜗、助听器、视觉沟通技巧，以及如何打造无障碍的学习环境。",
    "f12q": "如何为学生匹配导师？",
    "f12a": "我们根据学生的年龄、学习目标、兴趣、沟通需求与时间安排等多项因素细心匹配，力求建立让学生与导师都能正向成长的伙伴关系。",
    "f13q": "如果师生配对效果不佳怎么办？",
    "f13a": "我们持续跟踪师生配对成效，确保良好的学习体验。如对配对有任何疑虑，请发邮件至 ihearprogram@gmail.com，我们将与您讨论并共同找出最适合孩子的方案。",
    "f14q": "课程使用什么平台？",
    "f14a": "所有辅导课程均通过 Zoom 进行。该平台提供稳定的视频质量、屏幕共享功能，以及对听损学生特别有帮助的实时字幕等无障碍功能。",
    "f15q": "我们需要什么设备？",
    "f15a": "您需要一台有摄像头与麦克风的电脑、平板或智能手机，以及稳定的网络连接。建议使用耳机以获得更好的音质。若孩子使用助听器或人工耳蜗，上课时请佩戴。",
    "f16q": "遇到技术问题怎么办？",
    "f16a": "技术问题难免发生！若连接 Zoom 或上课中遇到问题，请联系 ihearprogram@gmail.com。我们可以协助排查问题或改期。导师也会耐心协助解决小型技术状况。",
    "f17q": "匹配辅导老师需要多久？",
    "f17a": "匹配通常需要 1–2 周，视导师的时间与您的日程偏好而定。我们重视「找到最合适的导师」胜过速度，确保您的孩子与最能支持其学习目标的导师配对。",
    "f18q": "第一节课会做什么？",
    "f18a": "第一节课是导师与学生互相认识的时间——讨论学习目标、兴趣与沟通偏好。导师会评估学生目前的英语水平，并开始规划个性化课程。欢迎家长一同参加第一节课。",
    "f19q": "课程期间家长需要在场吗？",
    "f19a": "这取决于学生的年龄与舒适程度。年幼的学生可能希望家长在附近提供支持；年长的学生通常更喜欢独立上课。我们鼓励家长定期与导师交流，了解学习进度。",
    "f20q": "我的孩子会在辅导课程中学到什么？",
    "f20a": "课程依每位学生的目标量身定制：发音、英语会话、词汇积累、阅读理解、写作能力，以及口语沟通的自信。导师会结合学生的兴趣设计课程，让学习保持趣味。",
    "growth_h": "6 个月增长 6 倍",
    "growth_src": "从试点项目成长为服务台湾、中国、美国与加拿大学习者的全球社群。",
    "growth_a_when": "2025 年 6 月",
    "growth_a1": "11 位导师",
    "growth_a2": "12 位学员",
    "growth_a3": "105 节课程",
    "growth_b_when": "2025 年 12 月",
    "growth_b1": "36 位导师",
    "growth_b2": "40+ 位学员",
    "growth_b3": "639 节课程 · 4 个国家",
    "ins_h": "iHear 有效的原因",
    "ins1": "导师的耐心——约 40% 的家庭反馈中提及",
    "ins2": "清晰的讲解与灵活调整的教学方法",
    "ins3": "依个人需求量身定制的个性化学习",
    "ins4": "双语支持，理解无障碍",
    "ins5": "约 55% 的学员希望有更多英语沉浸练习",
    "ins6": "曾经受挫的学习者重新投入英语学习",
    "other_p": "除了辅导之外，我们正在发展更多志愿者角色：行政支持、社区推广与活动协调。",
    "other_cta": "表达您的兴趣",
    "acad_eyebrow": "iHear Academy",
    "acad_h2": "以使命为本的付费辅导，支持免费服务",
    "acad_p1": "iHear Academy 是与使命一致的付费辅导项目。项目收入用于导师报酬、培训与课程开发，盈余则再投入 iHear Program，扩大为听力与沟通需求学习者提供的免费服务。",
    "acad_p2": "Academy 专注于最实用的核心能力：发音、口语流利度、听力理解、词汇，以及最重要的——敢于开口的自信。在沉浸式环境中，学生从『学习英文』进步到『用英文学习』。满意度达 93%。",
    "acad_cta1": "咨询 iHear Academy",
    "acad_cta2": "学费方案与课程",
    "donor_p": "我们正在建立捐赠者名单，您的名字可以在这里！捐赠者将按级别致谢：创始捐赠者、主要捐赠者（$500+）、支持捐赠者（$100–$499）与 iHear 之友。",
    "prog2_b1": "已触及 200+ 位社区成员 · 两场社区讲座 120+ 位参与者（2025 年 10 月与 2026 年 1 月）",
    "prog2_b3": "与 CAPA-MC 合作，由 AAHI（亚裔美国人健康倡议）资助",
    "faq_eyebrow": "常见问题",
    "faq_h2": "我们能帮上什么忙？",
    "contact_eyebrow": "联系我们",
    "contact_h2": "我们很乐意听到您的声音",
    "contact_sub": "有任何问题？想加入我们？欢迎随时联系——中英文皆可。",
    "contact_email_h": "给我们写信",
    "contact_email_p": "申请辅导时，请附上学生姓名与年龄、沟通需求或目标、偏好的上课时间，以及任何有助于我们服务您的信息。",
    "contact_email_cta": "发送电子邮件",
    "contact_region_h": "服务跨区域的学习者",
    "contact_region_p": "我们的志愿导师主要位于美国（包括马里兰州与密歇根州）与台湾——服务台湾、中国、美国与加拿大的学生。所有课程均通过 Zoom 在线进行。",
    "contact_forms_h": "更喜欢使用表单？",
    "contact_form_cta": "打开申请表单",
    "foot_tag": "建立自信沟通——从每一次对话开始。",
    "foot_desc": "为听力损失及其他沟通需求的学生提供包容性英语沟通支持。",
    "foot_prog_h": "服务项目",
    "foot_prog1": "英语辅导",
    "foot_prog2": "社区推广",
    "foot_prog3": "资源库",
    "foot_prog4": "iHear Academy",
    "foot_inv_h": "加入我们",
    "foot_inv1": "成为 iHear 志愿者",
    "foot_inv2": "申请辅导服务",
    "foot_inv3": "支持我们的使命",
    "foot_inv4": "课程反馈表",
    "foot_inv5": "提交导师简介",
    "foot_more_h": "更多",
    "foot_more1": "关于我们",
    "foot_more2": "我们的成果",
    "foot_more3": "联系我们",
    "foot_more4": "我们的团队",
    "foot_more5": "常见问题",
    "foot_more6": "学员故事",
    "foot_copy": "© 2024–Present iHear Program 版权所有。隶属于 CAPA-MC（501(c)(3)）。",
    "foot_made": "由 Monnast 设计、发布与维护。"
  }
};

  const languageAttributes = { en: "en", zhTW: "zh-Hant", zhCN: "zh-Hans" };
  const localeKeys = { en: "en", zhTW: "zhHant", zhCN: "zhHans" };
  const englishText = new Map();
  let activeLanguage = "en";

  const uiText = {
    en: {
      menu: "Menu", closeMenu: "Close menu", backTop: "Back to top", close: "Close",
      external: "opens in a new tab", faqLabel: "Search frequently asked questions",
      faqPlaceholder: "Search questions or answers", faqResults: (count) => `${count} question${count === 1 ? "" : "s"} found`,
      faqEmpty: "No matching questions. Try a shorter or different search.", required: "This field is required.",
      tooLong: (max) => `Please use ${max} characters or fewer.`, formErrors: "Please review the highlighted fields.",
      mail: "Open mail app", copy: "Copy full draft", copied: "The complete email draft was copied.",
      copyFailed: "Could not copy automatically. Select and copy the draft manually.",
      mailFallback: "If your mail app did not open, use “Copy full draft” and paste it into an email to ihearprogram@gmail.com.",
      subject: "Tutor bio submission",
      fields: { name: "Name", school: "School", grade: "Grade", languages: "Languages", strengths: "Teaching strengths", short_bio: "Short bio", long_bio: "Full bio", hobbies: "Hobbies", consent: "Publication consent: Confirmed" },
    },
    zhTW: {
      menu: "選單", closeMenu: "關閉選單", backTop: "返回頂端", close: "關閉",
      external: "另開新分頁", faqLabel: "搜尋常見問題", faqPlaceholder: "搜尋問題或答案",
      faqResults: (count) => `找到 ${count} 個問題`, faqEmpty: "找不到相符問題，請縮短關鍵字或改用其他詞語。",
      required: "此欄位為必填。", tooLong: (max) => `請勿超過 ${max} 個字元。`, formErrors: "請檢查標示的欄位。",
      mail: "開啟郵件 App", copy: "複製完整草稿", copied: "已複製完整郵件草稿。",
      copyFailed: "無法自動複製，請手動選取並複製草稿。",
      mailFallback: "若郵件 App 沒有開啟，請使用「複製完整草稿」，再貼到寄給 ihearprogram@gmail.com 的郵件。",
      subject: "提交 iHear 導師簡介",
      fields: { name: "姓名", school: "學校", grade: "年級", languages: "語言", strengths: "教學專長", short_bio: "短介", long_bio: "完整介紹", hobbies: "興趣", consent: "公開刊登同意：已確認" },
    },
    zhCN: {
      menu: "菜单", closeMenu: "关闭菜单", backTop: "返回顶部", close: "关闭",
      external: "在新标签页打开", faqLabel: "搜索常见问题", faqPlaceholder: "搜索问题或答案",
      faqResults: (count) => `找到 ${count} 个问题`, faqEmpty: "找不到匹配问题，请缩短关键词或尝试其他词语。",
      required: "此字段为必填。", tooLong: (max) => `请勿超过 ${max} 个字符。`, formErrors: "请检查标示的字段。",
      mail: "打开邮件 App", copy: "复制完整草稿", copied: "已复制完整邮件草稿。",
      copyFailed: "无法自动复制，请手动选择并复制草稿。",
      mailFallback: "如果邮件 App 没有打开，请使用“复制完整草稿”，再粘贴到发给 ihearprogram@gmail.com 的邮件。",
      subject: "提交 iHear 导师简介",
      fields: { name: "姓名", school: "学校", grade: "年级", languages: "语言", strengths: "教学专长", short_bio: "短介", long_bio: "完整介绍", hobbies: "兴趣", consent: "公开发布同意：已确认" },
    },
  };

  function textForUi() {
    return uiText[activeLanguage] || uiText.en;
  }

  function normalizePath(value) {
    const path = String(value || "/").split(/[?#]/)[0].replace(/\/index\.html$/, "/").replace(/\.html$/, "");
    return path !== "/" ? path.replace(/\/$/, "") : path;
  }

  function captureEnglish() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      if (key && !englishText.has(key)) englishText.set(key, element.textContent || "");
    });
  }

  function setLocalizedText(element, value) {
    if (!element.children.length) { element.textContent = value; return; }
    const textNodes = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
    const target = textNodes.find((node) => node.nodeValue.trim()) || textNodes[0];
    if (target) {
      target.nodeValue = value;
      textNodes.filter((node) => node !== target).forEach((node) => { node.nodeValue = ""; });
    } else element.appendChild(document.createTextNode(value));
  }

  function updateTranslatedText() {
    const dictionary = I18N[activeLanguage] || I18N.en;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      const translated = activeLanguage === "en" ? englishText.get(key) : dictionary[key];
      if (translated != null) setLocalizedText(element, translated);
      else if (englishText.has(key)) setLocalizedText(element, englishText.get(key));
    });
    document.documentElement.lang = languageAttributes[activeLanguage] || "en";
    document.querySelectorAll("#langSwitch button[data-lang]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-lang") === activeLanguage));
    });
  }

  function persistLanguageCookie(language) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `ihear-lang=${encodeURIComponent(language)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }

  function setLanguage(language, options) {
    if (!languageAttributes[language]) language = "en";
    if (language === activeLanguage && !(options && options.force)) return true;
    const before = new CustomEvent("ihear:before-language", {
      cancelable: true,
      detail: { from: activeLanguage, to: language, locale: localeKeys[language] },
    });
    if (!window.dispatchEvent(before)) return false;
    activeLanguage = language;
    updateTranslatedText();
    try { localStorage.setItem("ihear-lang", language); } catch {}
    persistLanguageCookie(language);
    window.dispatchEvent(new CustomEvent("ihear:language", {
      detail: { language, locale: localeKeys[language] },
    }));
    return true;
  }

  function initialLanguage() {
    let saved = "";
    try { saved = localStorage.getItem("ihear-lang") || ""; } catch {}
    if (languageAttributes[saved]) return saved;
    const browserLanguage = (navigator.language || "").toLowerCase();
    if (!browserLanguage.startsWith("zh")) return "en";
    return /tw|hk|mo|hant/.test(browserLanguage) ? "zhTW" : "zhCN";
  }

  function installToast() {
    const region = document.createElement("div");
    region.className = "site-toast-region";
    document.body.appendChild(region);

    window.iHearToast = function (message, options) {
      const settings = options || {};
      const toast = document.createElement("div");
      toast.className = `site-toast${settings.error ? " is-error" : ""}`;
      toast.setAttribute("role", settings.error ? "alert" : "status");
      toast.setAttribute("aria-atomic", "true");
      const copy = document.createElement("p");
      copy.textContent = String(message || "");
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", textForUi().close);
      close.textContent = "×";
      const remove = () => toast.remove();
      close.addEventListener("click", remove);
      toast.append(copy, close);
      region.appendChild(toast);
      window.setTimeout(remove, settings.error ? 8000 : 4500);
      return toast;
    };
  }

  function installSkipLink() {
    const skipLink = document.querySelector('.skip-link[href="#main"]');
    const main = document.getElementById("main");
    if (!skipLink || !main) return;

    main.setAttribute("tabindex", "-1");
    skipLink.addEventListener("click", () => {
      main.focus({ preventScroll: true });
    });
  }

  function installNavigation() {
    const nav = document.getElementById("nav");
    const toggle = document.getElementById("navToggle");
    const drawer = document.getElementById("navLinks");
    if (!nav || !toggle || !drawer) return;

    const languageSwitch = document.getElementById("langSwitch");
    const cta = nav.querySelector(".nav-inner > .btn-cta");

    const media = window.matchMedia("(max-width: 1024px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const supportsInert = "inert" in HTMLElement.prototype;
    const placeholder = languageSwitch ? document.createComment("language-switch") : null;
    const languageItem = document.createElement("li");
    languageItem.className = "nav-language-item";
    const ctaPlaceholder = cta ? document.createComment("navigation-cta") : null;
    const ctaItem = document.createElement("li");
    ctaItem.className = "nav-cta-item";
    if (languageSwitch && placeholder) languageSwitch.parentNode.insertBefore(placeholder, languageSwitch);
    if (cta && ctaPlaceholder) cta.parentNode.insertBefore(ctaPlaceholder, cta);

    const focusSelector = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]";
    function disableDrawerFocus() {
      drawer.querySelectorAll(focusSelector).forEach((element) => {
        if (!element.hasAttribute("data-site-tabindex")) {
          element.setAttribute("data-site-tabindex", element.hasAttribute("tabindex") ? element.getAttribute("tabindex") : "__none__");
        }
        element.setAttribute("tabindex", "-1");
      });
    }
    function restoreDrawerFocus() {
      drawer.querySelectorAll("[data-site-tabindex]").forEach((element) => {
        const previous = element.getAttribute("data-site-tabindex");
        if (previous === "__none__") element.removeAttribute("tabindex");
        else element.setAttribute("tabindex", previous);
        element.removeAttribute("data-site-tabindex");
      });
    }
    function finalizeClosed() {
      drawer.classList.remove("open", "is-closing");
      drawer.hidden = true;
    }
    function closeMenu(options) {
      const settings = options || {};
      if (!media.matches) return;
      const wasOpen = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", textForUi().menu);
      drawer.setAttribute("aria-hidden", "true");
      if (supportsInert) drawer.inert = true;
      disableDrawerFocus();
      if (!wasOpen || settings.immediate || reducedMotion.matches || typeof drawer.animate !== "function") {
        finalizeClosed();
      } else {
        drawer.classList.add("is-closing");
        drawer.animate(
          [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-12px)" }],
          { duration: 220, easing: "ease", fill: "both" },
        ).finished.then(finalizeClosed, finalizeClosed);
      }
      if (settings.restoreFocus) toggle.focus();
    }
    function openMenu() {
      if (!media.matches) return;
      drawer.hidden = false;
      drawer.classList.remove("is-closing");
      drawer.classList.add("open");
      drawer.removeAttribute("aria-hidden");
      if (supportsInert) drawer.inert = false;
      restoreDrawerFocus();
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", textForUi().closeMenu);
      if (!reducedMotion.matches && typeof drawer.animate === "function") {
        drawer.animate(
          [{ opacity: 0, transform: "translateY(-12px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: 220, easing: "ease-out" },
        );
      }
    }
    function syncLayout() {
      if (media.matches) {
        if (languageSwitch && languageSwitch.parentNode !== languageItem) {
          languageItem.appendChild(languageSwitch);
          drawer.appendChild(languageItem);
        }
        if (cta && cta.parentNode !== ctaItem) {
          ctaItem.appendChild(cta);
          drawer.appendChild(ctaItem);
        }
        closeMenu({ immediate: true });
      } else {
        drawer.hidden = false;
        drawer.classList.remove("open", "is-closing");
        drawer.removeAttribute("aria-hidden");
        if (supportsInert) drawer.inert = false;
        restoreDrawerFocus();
        toggle.setAttribute("aria-expanded", "false");
        if (languageSwitch && placeholder && placeholder.parentNode) {
          placeholder.parentNode.insertBefore(languageSwitch, placeholder.nextSibling);
        }
        if (cta && ctaPlaceholder && ctaPlaceholder.parentNode) {
          ctaPlaceholder.parentNode.insertBefore(cta, ctaPlaceholder.nextSibling);
        }
        languageItem.remove();
        ctaItem.remove();
      }
    }

    toggle.addEventListener("click", () => {
      if (toggle.getAttribute("aria-expanded") === "true") closeMenu();
      else openMenu();
    });
    drawer.addEventListener("click", (event) => { if (event.target.closest("a")) closeMenu(); });
    document.addEventListener("pointerdown", (event) => {
      if (
        media.matches
        && toggle.getAttribute("aria-expanded") === "true"
        && !drawer.contains(event.target)
        && !toggle.contains(event.target)
      ) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") closeMenu({ restoreFocus: true });
    });
    if (media.addEventListener) media.addEventListener("change", syncLayout);
    else media.addListener(syncLayout);
    new MutationObserver(() => {
      if (media.matches && drawer.getAttribute("aria-hidden") === "true") disableDrawerFocus();
    }).observe(drawer, { childList: true, subtree: true });
    window.addEventListener("ihear:language", () => {
      toggle.setAttribute("aria-label", toggle.getAttribute("aria-expanded") === "true" ? textForUi().closeMenu : textForUi().menu);
    });
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    syncLayout();
  }

  function markCurrentNavigation() {
    let current = normalizePath(window.location.pathname);
    if (current === "/submit-bio") current = "/team";
    document.querySelectorAll(".nav-links a[href]").forEach((link) => {
      let target;
      try { target = normalizePath(new URL(link.href, window.location.href).pathname); } catch { return; }
      if (target === current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function installRevealAnimations() {
    const elements = Array.from(document.querySelectorAll("[data-animate]"));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let counted = false;
    function finish(element) {
      element.classList.add("in");
      if (!counted && element.querySelector("[data-count]")) {
        counted = true;
        element.querySelectorAll("[data-count]").forEach(animateCount);
      }
      element.querySelectorAll(".bar-fill").forEach((bar) => {
        bar.style.transform = `scaleX(${(Number.parseFloat(bar.getAttribute("data-width")) || 0) / 100})`;
      });
    }
    function animateCount(element) {
      let target = Number.parseInt(element.getAttribute("data-count"), 10) || 0;
      if (reduced) { element.textContent = target.toLocaleString("en-US"); return; }
      let start;
      function tick(time) {
        target = Number.parseInt(element.getAttribute("data-count"), 10) || 0;
        if (start == null) start = time;
        const progress = Math.min((time - start) / 1400, 1);
        element.textContent = Math.round(target * (1 - Math.pow(1 - progress, 3))).toLocaleString("en-US");
        if (progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    if (reduced || !("IntersectionObserver" in window)) elements.forEach(finish);
    else {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          finish(entry.target);
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.12 });
      elements.forEach((element) => observer.observe(element));
    }
  }

  function installExternalHints() {
    function update() {
      document.querySelectorAll('a[target="_blank"]').forEach((link) => {
        link.rel = `${link.rel || ""} noopener noreferrer`.trim().replace(/\s+/g, " ");
        let hint = link.querySelector(":scope > .external-hint");
        if (!hint) {
          hint = document.createElement("span");
          hint.className = "external-hint sr-only";
          link.appendChild(hint);
        }
        hint.textContent = `(${textForUi().external})`;
      });
    }
    update();
    window.addEventListener("ihear:language", update);
  }

  function installBackToTop() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "back-to-top";
    button.innerHTML = '<span aria-hidden="true">↑</span>';
    const updateLabel = () => button.setAttribute("aria-label", textForUi().backTop);
    const updateVisibility = () => button.classList.toggle("is-visible", window.scrollY > Math.max(600, window.innerHeight));
    button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    window.addEventListener("scroll", updateVisibility, { passive: true });
    window.addEventListener("ihear:language", updateLabel);
    updateLabel();
    updateVisibility();
    document.body.appendChild(button);
  }

  function installFaqSearch() {
    const list = document.querySelector(".faq-list");
    if (!list) return;
    const wrapper = document.createElement("div");
    wrapper.className = "faq-search-wrap";
    const label = document.createElement("label");
    label.className = "faq-search-label";
    label.htmlFor = "faqSearch";
    const input = document.createElement("input");
    input.id = "faqSearch";
    input.className = "faq-search";
    input.type = "search";
    input.autocomplete = "off";
    const status = document.createElement("p");
    status.className = "faq-search-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const empty = document.createElement("p");
    empty.className = "faq-empty";
    empty.hidden = true;
    wrapper.append(label, input, status, empty);
    list.parentNode.insertBefore(wrapper, list);

    function filter() {
      const query = input.value.trim().toLocaleLowerCase(document.documentElement.lang);
      const details = Array.from(list.querySelectorAll("details"));
      let count = 0;
      details.forEach((detail) => {
        const matches = !query || detail.textContent.toLocaleLowerCase(document.documentElement.lang).includes(query);
        detail.hidden = !matches;
        if (matches) count += 1;
      });
      list.querySelectorAll(".faq-cat").forEach((heading) => {
        let next = heading.nextElementSibling;
        let visible = false;
        while (next && !next.classList.contains("faq-cat")) {
          if (next.matches("details") && !next.hidden) visible = true;
          next = next.nextElementSibling;
        }
        heading.hidden = !visible;
      });
      status.textContent = query ? textForUi().faqResults(count) : "";
      empty.textContent = textForUi().faqEmpty;
      empty.hidden = count > 0;
    }
    function localize() {
      label.textContent = textForUi().faqLabel;
      input.placeholder = textForUi().faqPlaceholder;
      filter();
    }
    input.addEventListener("input", filter);
    window.addEventListener("ihear:language", localize);
    localize();
  }

  function installBioForm() {
    const form = document.getElementById("bioForm");
    if (!form) return;
    const limits = { name: 100, school: 160, grade: 40, languages: 200, strengths: 500, short_bio: 600, long_bio: 2400, hobbies: 300 };
    const requiredNames = new Set(["name", "short_bio"]);
    form.noValidate = true;
    const summary = document.createElement("p");
    summary.className = "field-error";
    summary.setAttribute("role", "alert");
    summary.hidden = true;
    form.insertBefore(summary, form.firstChild);

    Object.entries(limits).forEach(([name, maximum]) => {
      const field = form.elements.namedItem(name);
      if (!field) return;
      field.maxLength = maximum;
      const error = document.createElement("p");
      error.className = "field-error";
      error.id = `${field.id}Error`;
      error.hidden = true;
      field.insertAdjacentElement("afterend", error);
      const describedBy = [field.getAttribute("aria-describedby"), error.id].filter(Boolean);
      if (field.tagName === "TEXTAREA") {
        const counter = document.createElement("span");
        counter.className = "field-counter";
        counter.id = `${field.id}Counter`;
        counter.setAttribute("aria-live", "off");
        error.insertAdjacentElement("afterend", counter);
        describedBy.push(counter.id);
        const updateCounter = () => {
          counter.textContent = `${field.value.length} / ${maximum}`;
          counter.classList.toggle("is-near-limit", field.value.length >= maximum * 0.9);
        };
        field.addEventListener("input", updateCounter);
        updateCounter();
      }
      field.setAttribute("aria-describedby", describedBy.join(" "));
      field.addEventListener("input", () => clearError(field));
    });

    const consent = form.elements.namedItem("publication_consent");
    if (consent) {
      const error = document.createElement("p");
      error.className = "field-error";
      error.id = "bfConsentError";
      error.hidden = true;
      consent.closest("label").insertAdjacentElement("afterend", error);
      consent.setAttribute("aria-describedby", error.id);
      consent.addEventListener("change", () => clearError(consent));
    }

    const submit = form.querySelector('button[type="submit"]');
    const actions = document.createElement("div");
    actions.className = "bio-form-actions";
    submit.parentNode.insertBefore(actions, submit);
    actions.appendChild(submit);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn btn-ghost bio-copy";
    actions.appendChild(copy);
    const help = document.createElement("p");
    help.className = "bio-form-help";
    help.hidden = true;
    actions.appendChild(help);

    function clearError(field) {
      field.removeAttribute("aria-invalid");
      const error = document.getElementById(`${field.id}Error`);
      if (error) { error.hidden = true; error.textContent = ""; }
    }
    function setError(field, message) {
      field.setAttribute("aria-invalid", "true");
      const error = document.getElementById(`${field.id}Error`);
      if (error) { error.textContent = message; error.hidden = false; }
    }
    function validate() {
      const invalid = [];
      Object.entries(limits).forEach(([name, maximum]) => {
        const field = form.elements.namedItem(name);
        clearError(field);
        const value = field.value.trim();
        if (requiredNames.has(name) && !value) { setError(field, textForUi().required); invalid.push(field); }
        else if (value.length > maximum) { setError(field, textForUi().tooLong(maximum)); invalid.push(field); }
      });
      if (consent) {
        clearError(consent);
        if (!consent.checked) { setError(consent, textForUi().required); invalid.push(consent); }
      }
      summary.textContent = invalid.length ? textForUi().formErrors : "";
      summary.hidden = invalid.length === 0;
      if (invalid.length) invalid[0].focus();
      return invalid.length === 0;
    }
    function draft() {
      const lines = Object.keys(limits).map((name) => {
        const value = form.elements.namedItem(name).value.trim();
        return value ? `${textForUi().fields[name]}: ${value}` : "";
      }).filter(Boolean);
      if (consent && consent.checked) lines.push(textForUi().fields.consent);
      return { subject: textForUi().subject, body: lines.join("\n\n") };
    }
    async function copyDraft() {
      if (!validate()) return;
      if (form.elements.namedItem("website")?.value) return;
      const message = draft();
      const complete = `Subject: ${message.subject}\n\n${message.body}`;
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(complete);
        else {
          const temporary = document.createElement("textarea");
          temporary.value = complete;
          temporary.className = "sr-only";
          document.body.appendChild(temporary);
          temporary.select();
          if (!document.execCommand("copy")) throw new Error("copy failed");
          temporary.remove();
        }
        window.iHearToast(textForUi().copied);
      } catch {
        window.iHearToast(textForUi().copyFailed, { error: true });
      }
    }
    function localize() {
      submit.textContent = textForUi().mail;
      copy.textContent = textForUi().copy;
      help.textContent = textForUi().mailFallback;
    }
    copy.addEventListener("click", copyDraft);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.elements.namedItem("website")?.value || !validate()) return;
      const message = draft();
      help.hidden = false;
      window.location.href = `mailto:ihearprogram@gmail.com?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
    });
    window.addEventListener("ihear:language", localize);
    localize();
  }

  function limitLiveRegions() {
    document.querySelectorAll("[aria-live]").forEach((element) => {
      if (!element.matches('[role="status"],[role="alert"]') && element.textContent.trim().length > 300) element.removeAttribute("aria-live");
    });
  }

  function boot() {
    captureEnglish();
    installToast();
    activeLanguage = initialLanguage();
    updateTranslatedText();
    persistLanguageCookie(activeLanguage);
    document.getElementById("langSwitch")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-lang]");
      if (button) setLanguage(button.getAttribute("data-lang"));
    });
    window.iHearSetLanguage = setLanguage;
    window.iHearLanguage = { get: () => activeLanguage, locale: () => localeKeys[activeLanguage] };
    markCurrentNavigation();
    installSkipLink();
    installNavigation();
    installRevealAnimations();
    installExternalHints();
    installBackToTop();
    installFaqSearch();
    installBioForm();
    limitLiveRegions();
    window.dispatchEvent(new CustomEvent("ihear:language", { detail: { language: activeLanguage, locale: localeKeys[activeLanguage] } }));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
