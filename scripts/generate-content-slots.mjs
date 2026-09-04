import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const write = process.argv.includes("--write");
const htmlFiles = [
  "index.html", "about.html", "programs.html", "impact.html", "team.html",
  "submit-bio.html", "stories.html", "get-involved.html", "academy.html",
  "donate.html", "resources.html", "faq.html", "contact.html",
];
const pageNames = { "index.html": "home" };
const dynamicKeys = new Set([
  "latest_label", "latest_period", "latest_headline", "latest_description", "latest_link",
  "stat_asof", "stat_countries_sub",
]);
const optionalSections = {
  "index.html": ["stats", "about", "programs", "how", "impact", "stories", "video", "involve", "donate"],
  "about.html": ["journey"], "programs.html": ["how"], "stories.html": ["video"],
};
const groupDefinitions = {
  "index.html": [
    ["pillars", "home.mission.pillars", "article", "pillar", ["inclusive", "awareness", "volunteer"]],
    ["prog-grid", "programs.services", "article", "prog-card", ["tutoring", "outreach"], "/__global__"],
    ["steps", "programs.steps", "article", "step", ["request", "match", "learn"], "/__global__"],
    ["testi-grid", "stories.testimonials", "figure", "testi", ["story1", "story2", "story3", "story4"], "/__global__"],
    ["involve-grid", "involvement.options", "article", "involve", ["tutor", "student"], "/__global__"],
    ["donate-grid", "donate.options", "div", "donate-card", ["monthly", "materials", "outreach"], "/__global__"],
  ],
  "about.html": [["pillars", "about.mission.pillars", "article", "pillar", ["inclusive", "awareness", "volunteer"]]],
  "programs.html": [["prog-grid", "programs.services", "article", "prog-card", ["tutoring", "outreach"], "/__global__"], ["steps", "programs.steps", "article", "step", ["request", "match", "learn"], "/__global__"]],
  "stories.html": [["testi-grid", "stories.testimonials", "figure", "testi", ["story1", "story2", "story3", "story4"], "/__global__"]],
  "get-involved.html": [["involve-grid", "involvement.options", "article", "involve", ["tutor", "student"], "/__global__"]],
  "donate.html": [["donate-grid", "donate.options", "div", "donate-card", ["monthly", "materials", "outreach"], "/__global__"]],
  "contact.html": [["contact-grid", "contact.methods", "div", "contact-card", ["email", "social"]]],
  "resources.html": [["res-chips", "resources.guides", "span", "chip", ["communication", "classroom", "family", "hearing-loss", "implant", "hearing-aid", "activities", "tracking", "handbook"]]],
};

const text3 = (en, zhHant, zhHans = zhHant) => ({ en, zhHant, zhHans });
const layoutPages = {
  "/": text3("Home", "首頁", "首页"),
  "/about": text3("About us", "關於我們", "关于我们"),
  "/academy": text3("Academy", "線上學院", "在线学院"),
  "/contact": text3("Contact", "聯絡我們", "联系我们"),
  "/donate": text3("Donate", "捐款支持", "捐款支持"),
  "/get-involved": text3("Get involved", "參與我們", "参与我们"),
  "/programs": text3("Programs", "服務項目", "服务项目"),
  "/resources": text3("Resources", "學習資源", "学习资源"),
  "/stories": text3("Stories", "生命故事", "生命故事"),
  "/team": text3("Team", "團隊介紹", "团队介绍"),
  "/__global__": text3("Shared across the site", "全站共用", "全站共用"),
};

const sectionMetadata = {
  "home.stats": ["Impact numbers", "成果數字", "成果数字", "Student, class, and volunteer totals.", "顯示學生、課程與志工成果。", "显示学生、课程与志工成果。", "chart"],
  "home.about": ["About iHear", "認識 iHear", "认识 iHear", "A short introduction to our work.", "簡介 iHear 的服務與理念。", "简介 iHear 的服务与理念。", "heart"],
  "home.programs": ["Programs", "服務項目", "服务项目", "Tutoring and community outreach services.", "一對一輔導與社區推廣服務。", "一对一辅导与社区推广服务。", "cards"],
  "home.how": ["How it works", "服務流程", "服务流程", "The steps from request to learning.", "從提出申請到開始學習的流程。", "从提出申请到开始学习的流程。", "steps"],
  "home.impact": ["Our impact", "我們的影響力", "我们的影响力", "Stories and outcomes from the community.", "社群故事與服務成果。", "社群故事与服务成果。", "spark"],
  "home.stories": ["Student stories", "學習故事", "学习故事", "Experiences shared by learners and families.", "學員與家庭分享的經驗。", "学员与家庭分享的经验。", "quote"],
  "home.video": ["Impact video", "影響力影片", "影响力影片", "The featured video on the home page.", "首頁中的精選影片。", "首页中的精选影片。", "video"],
  "home.involve": ["Get involved", "參與我們", "参与我们", "Ways to volunteer or request support.", "成為志工或申請服務的方式。", "成为志工或申请服务的方式。", "people"],
  "home.donate": ["Support our work", "支持我們", "支持我们", "Donation options and their impact.", "捐款方式與可帶來的改變。", "捐款方式与可带来的改变。", "gift"],
  "about.journey": ["Our journey", "我們的歷程", "我们的历程", "Milestones in iHear's development.", "iHear 發展的重要里程碑。", "iHear 发展的重要里程碑。", "timeline"],
  "programs.how": ["How to get started", "如何開始", "如何开始", "The application and matching process.", "申請、媒合到學習的流程。", "申请、媒合到学习的流程。", "steps"],
  "stories.video": ["Featured story video", "精選故事影片", "精选故事影片", "A video story from the iHear community.", "iHear 社群的精選故事影片。", "iHear 社群的精选故事影片。", "video"],
};

const groupMetadata = {
  "home.mission.pillars": ["Mission highlights", "使命重點", "使命重点", "The three ideas behind our mission.", "支持使命的三項核心理念。", "支持使命的三项核心理念。", "pillars", {
    inclusive: ["Inclusive communication", "包容性溝通", "包容性沟通", "Support through accessible communication.", "以無障礙溝通提供支持。", "以无障碍沟通提供支持。"],
    awareness: ["Community awareness", "社區意識", "社区意识", "Build understanding in the community.", "提升社區對聽損議題的理解。", "提升社区对听损议题的理解。"],
    volunteer: ["Volunteer driven", "志工驅動", "志工驱动", "Powered by committed volunteers.", "由投入服務的志工共同推動。", "由投入服务的志工共同推动。"],
  }],
  "about.mission.pillars": ["Mission highlights", "使命重點", "使命重点", "The three ideas behind our mission.", "支持使命的三項核心理念。", "支持使命的三项核心理念。", "pillars", {
    inclusive: ["Inclusive communication", "包容性溝通", "包容性沟通", "Support through accessible communication.", "以無障礙溝通提供支持。", "以无障碍沟通提供支持。"],
    awareness: ["Community awareness", "社區意識", "社区意识", "Build understanding in the community.", "提升社區對聽損議題的理解。", "提升社区对听损议题的理解。"],
    volunteer: ["Volunteer driven", "志工驅動", "志工驱动", "Powered by committed volunteers.", "由投入服務的志工共同推動。", "由投入服务的志工共同推动。"],
  }],
  "programs.services": ["Services", "服務項目", "服务项目", "Tutoring and community outreach options.", "一對一英語輔導與社區推廣。", "一对一英语辅导与社区推广。", "cards", {
    tutoring: ["One-to-one English tutoring", "一對一英語輔導", "一对一英语辅导", "Personal learning support for students.", "為學生提供個人化學習支持。", "为学生提供个人化学习支持。"],
    outreach: ["Community outreach and talks", "社區推廣與講座", "社区推广与讲座", "Awareness activities for schools and communities.", "為學校與社區提供倡議活動。", "为学校与社区提供倡议活动。"],
  }],
  "programs.steps": ["Learning journey", "服務流程", "服务流程", "The three steps to begin tutoring.", "開始輔導服務的三個步驟。", "开始辅导服务的三个步骤。", "steps", {
    request: ["Submit a request", "提出申請", "提出申请", "Tell us what support is needed.", "告訴我們需要的協助。", "告诉我们需要的协助。"],
    match: ["Get matched", "進行媒合", "进行媒合", "We find a suitable volunteer tutor.", "由團隊媒合合適的志工老師。", "由团队媒合合适的志工老师。"],
    learn: ["Start learning", "開始學習", "开始学习", "Meet online and work toward goals.", "在線上見面並朝學習目標前進。", "在线上见面并朝学习目标前进。"],
  }],
  "stories.testimonials": ["Community stories", "社群故事", "社群故事", "Stories shared by students and families.", "學生與家庭分享的服務經驗。", "学生与家庭分享的服务经验。", "quote", Object.fromEntries([1,2,3,4].map((n) => [`story${n}`, [`Story ${n}`, `故事 ${n}`, `故事 ${n}`, "A story from the iHear community.", "來自 iHear 社群的真實經驗。", "来自 iHear 社群的真实经验。"]]))],
  "involvement.options": ["Ways to participate", "參與方式", "参与方式", "Volunteer or request tutoring support.", "成為志工或申請輔導服務。", "成为志工或申请辅导服务。", "people", {
    tutor: ["Become a tutor", "成為志工老師", "成为志工老师", "Share your time as a volunteer tutor.", "投入時間陪伴學生學習。", "投入时间陪伴学生学习。"],
    student: ["Request tutoring", "申請輔導服務", "申请辅导服务", "Apply for one-to-one learning support.", "申請一對一學習支持。", "申请一对一学习支持。"],
  }],
  "donate.options": ["Donation options", "捐款用途", "捐款用途", "Ways a donation can support our work.", "了解捐款可支持的服務項目。", "了解捐款可支持的服务项目。", "gift", {
    monthly: ["Monthly support", "每月支持", "每月支持", "Help sustain tutoring over time.", "長期支持輔導服務。", "长期支持辅导服务。"],
    materials: ["Learning materials", "學習教材", "学习教材", "Provide accessible learning resources.", "提供無障礙學習資源。", "提供无障碍学习资源。"],
    outreach: ["Community outreach", "社區推廣", "社区推广", "Support awareness events and talks.", "支持倡議活動與講座。", "支持倡议活动与讲座。"],
  }],
  "contact.methods": ["Contact methods", "聯絡方式", "联系方式", "Ways visitors can reach iHear.", "訪客可以聯絡 iHear 的方式。", "访客可以联系 iHear 的方式。", "contact", {
    email: ["Email us", "電子郵件", "电子邮件", "Contact the team by email.", "透過電子郵件聯絡團隊。", "通过电子邮件联系团队。"],
    social: ["Social media", "社群媒體", "社群媒体", "Connect with iHear on social platforms.", "在社群平台關注 iHear。", "在社群平台关注 iHear。"],
  }],
  "resources.guides": ["Resource topics", "資源主題", "资源主题", "Browse guides by topic.", "依主題瀏覽學習指南。", "依主题浏览学习指南。", "book", Object.fromEntries([
    ["communication", "Communication", "溝通", "沟通"], ["classroom", "Classroom", "教室", "教室"], ["family", "Family", "家庭", "家庭"],
    ["hearing-loss", "Hearing loss", "聽力損失", "听力损失"], ["implant", "Cochlear implants", "人工電子耳", "人工耳蜗"],
    ["hearing-aid", "Hearing aids", "助聽器", "助听器"], ["activities", "Activities", "活動", "活动"],
    ["tracking", "Progress tracking", "進度追蹤", "进度追踪"], ["handbook", "Handbook", "手冊", "手册"],
  ].map(([id,en,hant,hans]) => [id, [en,hant,hans,"A guide in this resource topic.","此主題的實用學習指南。","此主题的实用学习指南。"]]))],
};

const linkMetadata = {
  "site.cta.request_tutoring.href": ["Request tutoring button", "申請輔導服務按鈕", "申请辅导服务按钮", "Used by tutoring calls to action across the site.", "用於全站的輔導服務行動按鈕。", "用于全站的辅导服务行动按钮。", "Header, programs, and involvement calls to action", "頁首、服務項目與參與頁面", "页首、服务项目与参与页面"],
  "site.nav.request_tutoring.href": ["Navigation request button", "導覽列申請按鈕", "导航栏申请按钮", "The request button in the main navigation.", "主導覽列中的申請按鈕。", "主导航栏中的申请按钮。", "Main navigation", "主導覽列", "主导航栏"],
  "site.cta.request_seminar.href": ["Request a seminar button", "申請講座按鈕", "申请讲座按钮", "Used by seminar calls to action across the site.", "用於全站講座申請的行動按鈕。", "用于全站讲座申请的行动按钮。", "Programs and outreach calls to action", "服務項目與推廣頁面", "服务项目与推广页面"],
  "site.cta.volunteer.href": ["Volunteer button", "志工申請按鈕", "志工申请按钮", "Used by volunteer calls to action across the site.", "用於全站志工招募的行動按鈕。", "用于全站志工招募的行动按钮。", "Home and involvement calls to action", "首頁與參與頁面", "首页与参与页面"],
  "shared.donate.cta.href": ["Donation button", "捐款按鈕", "捐款按钮", "Used by donation calls to action across the site.", "用於全站捐款行動按鈕。", "用于全站捐款行动按钮。", "Home and donation calls to action", "首頁與捐款頁面", "首页与捐款页面"],
  "shared.inv1.cta.href": ["Get involved button", "參與我們按鈕", "参与我们按钮", "Used by participation calls to action across the site.", "用於全站參與行動按鈕。", "用于全站参与行动按钮。", "Home and involvement calls to action", "首頁與參與頁面", "首页与参与页面"],
  "academy.acad.cta1.href": ["Academy primary button", "學院主要按鈕", "学院主要按钮", "The main action on the Academy page.", "線上學院頁面的主要行動按鈕。", "在线学院页面上的主要行动按钮。", "Academy page", "線上學院頁面", "在线学院页面"],
  "academy.acad.cta2.href": ["Academy secondary button", "學院次要按鈕", "学院次要按钮", "The secondary action on the Academy page.", "線上學院頁面的次要行動按鈕。", "在线学院页面的次要行动按钮。", "Academy page", "線上學院頁面", "在线学院页面"],
  "contact.contact.email.cta.href": ["Contact email link", "聯絡信箱連結", "联系邮箱链接", "Opens an email to the iHear team.", "開啟寄給 iHear 團隊的電子郵件。", "开启寄给 iHear 团队的电子邮件。", "Contact page", "聯絡頁面", "联系页面"],
  "contact.contact.form.cta.href": ["Contact form button", "聯絡表單按鈕", "联系表单按钮", "Opens the contact form.", "開啟 iHear 聯絡表單。", "开启 iHear 联系表单。", "Contact page", "聯絡頁面", "联系页面"],
  "resources.res.cta.href": ["Resources button", "資源按鈕", "资源按钮", "The main resource action link.", "學習資源頁面的主要連結。", "学习资源页面的主要链接。", "Resources page", "學習資源頁面", "学习资源页面"],
  "team.team.cta.href": ["Team action button", "團隊頁面按鈕", "团队页面按钮", "The main action on the Team page.", "團隊頁面的主要行動按鈕。", "团队页面的主要行动按钮。", "Team page", "團隊頁面", "团队页面"],
};

function extractObject(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const objectStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(objectStart, index + 1);
  }
  throw new Error(`Unterminated ${marker}`);
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, " ").trim();
}

function semanticTail(key) {
  const replacements = [
    [/_h1a$/, ".title.lead"], [/_h1b$/, ".title.emphasis"], [/_h2$/, ".heading"],
    [/_eyebrow$/, ".eyebrow"], [/_tagline$/, ".tagline"], [/_sub$/, ".subtitle"],
    [/_cta$/, ".cta"], [/_h$/, ".title"], [/_p$/, ".body"],
  ];
  for (const [pattern, suffix] of replacements) {
    if (pattern.test(key)) return key.replace(pattern, "").replaceAll("_", ".") + suffix;
  }
  return key.replaceAll("_", ".");
}

function specialKey(page, legacyKey, shared) {
  const fixed = {
    cta_request: "site.cta.request_tutoring.label",
    cta_volunteer: "site.cta.volunteer.label",
    cta_seminar: "site.cta.request_seminar.label",
    nav_cta: "site.nav.request_tutoring",
    prog1_h: "programs.services.tutoring.title",
    prog1_p: "programs.services.tutoring.body",
    prog2_h: "programs.services.outreach.title",
    prog2_p: "programs.services.outreach.body",
    tlnote_h: "team.leadership_note.heading",
    tlnote_p: "team.leadership_note.body",
  };
  if (fixed[legacyKey]) return fixed[legacyKey];
  if (legacyKey === "mission_h2") return `${page}.mission.heading`;
  if (legacyKey.startsWith("nav_")) return `site.nav.${semanticTail(legacyKey.slice(4))}`;
  if (legacyKey.startsWith("foot_")) return `site.footer.${semanticTail(legacyKey.slice(5))}`;
  if (legacyKey === "skip") return "site.accessibility.skip_to_content";
  if (shared) return `shared.${semanticTail(legacyKey)}`;
  return `${page}.${semanticTail(legacyKey)}`;
}

function modeFor(tag, key, english) {
  if (["p", "blockquote"].includes(tag) || english.length > 180 || /(?:_p|_sub|_desc)$/.test(key) || /^f\d+a$/.test(key)) return "multiline";
  return "singleline";
}

function maxLengthFor(mode, tag) {
  if (mode === "multiline") return 5000;
  if (["a", "button", "label", "span", "strong", "b", "time"].includes(tag)) return 120;
  return 200;
}

function sqlText(value) { return `'${value.replaceAll("'", "''")}'`; }

const siteJs = await readFile(path.join(root, "assets", "site.js"), "utf8");
const dictionaries = vm.runInNewContext(`(${extractObject(siteJs, "const I18N =")})`);
const sourcePages = new Map();
const keyPages = new Map();
const occurrencePattern = /<(?<tag>[a-z][a-z0-9-]*)(?<attrs>[^>]*\bdata-i18n=["'](?<legacy>[^"']+)["'][^>]*)>(?<body>[\s\S]*?)<\/\k<tag>>/gi;

for (const file of htmlFiles) {
  const html = await readFile(path.join(root, file), "utf8");
  sourcePages.set(file, html);
  for (const match of html.matchAll(occurrencePattern)) {
    const key = match.groups.legacy;
    if (dynamicKeys.has(key)) continue;
    if (!keyPages.has(key)) keyPages.set(key, new Set());
    keyPages.get(key).add(file);
  }
}

const slots = new Map();
const outputPages = new Map();
const layoutSections = [];
const layoutGroups = [];
const layoutLinks = [];

function addSyntheticSlot(page, key, mode, maxLength, values, file) {
  slots.set(`${page}\0${key}`, { page, key, mode, maxLength, values, occurrences: [{ file, legacyKey: "react", tag: "react", line: 1 }] });
}
for (const file of htmlFiles) {
  const page = pageNames[file] || path.basename(file, ".html").replaceAll("-", "_");
  const original = sourcePages.get(file);
  const updated = original.replace(occurrencePattern, (whole, _tag, _attrs, _legacy, _body, _offset, _source, groups) => {
    const { tag, attrs, legacy, body } = groups;
    if (dynamicKeys.has(legacy)) return whole;
    const shared = keyPages.get(legacy)?.size > 1 || /^(nav_|foot_|cta_)/.test(legacy) || legacy === "skip";
    const key = specialKey(page, legacy, shared);
    const english = decodeHtml(body);
    if (!english) return whole;
    const mode = modeFor(tag.toLowerCase(), legacy, english);
    const maxLength = maxLengthFor(mode, tag.toLowerCase());
    const scope = key.startsWith("site.") || key.startsWith("shared.") || key.startsWith("programs.services.") ? "/__global__" : `/${page === "home" ? "" : file.replace(/\.html$/, "")}`;
    const values = { en: english, zhHant: dictionaries.zhTW[legacy] ?? english, zhHans: dictionaries.zhCN[legacy] ?? english };
    const existing = slots.get(`${scope}\0${key}`);
    if (existing && JSON.stringify(existing.values) !== JSON.stringify(values)) {
      throw new Error(`Conflicting defaults for ${scope} / ${key}`);
    }
    const slot = existing || { page: scope, key, mode, maxLength, values, occurrences: [] };
    const before = original.slice(0, original.indexOf(whole));
    slot.occurrences.push({ file, legacyKey: legacy, tag: tag.toLowerCase(), line: before.split(/\r?\n/).length });
    slots.set(`${scope}\0${key}`, slot);
    let nextAttrs = attrs
      .replace(/\sdata-editable-content=["'][^"']+["']/g, "")
      .replace(/\sdata-editable-page=["'][^"']+["']/g, "")
      .replace(/\sdata-editable-mode=["'][^"']+["']/g, "")
      .replace(/\sdata-editable-maxlength=["'][^"']+["']/g, "");
    nextAttrs += ` data-editable-content="${key}" data-editable-mode="${mode}" data-editable-maxlength="${maxLength}"`;
    if (scope !== `/${page === "home" ? "" : file.replace(/\.html$/, "")}`) nextAttrs += ` data-editable-page="${scope}"`;
    return `<${tag}${nextAttrs}>${body}</${tag}>`;
  });
  let layoutHtml = updated.replace(/\sdata-layout-(?:section|group|item|page|link)=["'][^"']+["']/g, "");
  for (const id of optionalSections[file] || []) {
    const key = `${page}.${id}`;
    const scope = `/${page === "home" ? "" : file.replace(/\.html$/, "")}`;
    layoutHtml = layoutHtml.replace(new RegExp(`<section(?=[^>]*\\bid=["']${id}["'])`, "i"), `<section data-layout-section="${key}"`);
    layoutSections.push({ page: scope, key, label: key });
  }
  for (const [containerClass, key, itemTag, itemClass, itemIds, explicitPage] of groupDefinitions[file] || []) {
    const scope = explicitPage || `/${page === "home" ? "" : file.replace(/\.html$/, "")}`;
    layoutHtml = layoutHtml.replace(new RegExp(`(<[^>]+class=["'][^"']*\\b${containerClass}\\b[^"']*["'])([^>]*>)`, "i"), `$1 data-layout-group="${key}"${explicitPage ? ` data-layout-page="${explicitPage}"` : ""}$2`);
    let itemIndex = 0;
    const itemPattern = new RegExp(`<${itemTag}(?=[^>]*class=["'][^"']*\\b${itemClass}\\b[^"']*["'])`, "gi");
    layoutHtml = layoutHtml.replace(itemPattern, (opening) => itemIndex < itemIds.length ? `${opening} data-layout-item="${itemIds[itemIndex++]}"` : opening);
    layoutGroups.push({ page: scope, key, items: itemIds });
  }
  layoutHtml = layoutHtml.replace(/<a(?<attrs>[^>]*\bclass=["'][^"']*\bbtn\b[^"']*["'][^>]*\bdata-editable-content=["'](?<key>[^"']+)["'][^>]*)>/gi, (whole, _attrs, _key, _offset, _source, groups) => {
    const key = groups.key.endsWith(".label") ? groups.key.replace(/\.label$/, ".href") : `${groups.key}.href`;
    const href = /\bhref=["']([^"']+)["']/i.exec(whole)?.[1] || "";
    const scope = /\bdata-editable-page=["']([^"']+)["']/i.exec(whole)?.[1] || `/${page === "home" ? "" : file.replace(/\.html$/, "")}`;
    layoutLinks.push({ page: scope, key, defaultHref: href });
    return whole.replace(/>$/, ` data-layout-link="${key}"${scope === "/__global__" ? ' data-layout-page="/__global__"' : ""}>`);
  });
  outputPages.set(file, layoutHtml);
}

addSyntheticSlot("/_system/not-found", "errors.not_found.title", "singleline", 200, { en: "Page not found", zhHant: "找不到此頁面", zhHans: "找不到此页面" }, "app/not-found.tsx");
addSyntheticSlot("/_system/not-found", "errors.not_found.description", "multiline", 5000, { en: "The address may have changed, or the page may no longer exist.", zhHant: "網址可能已變更，或此頁面已不存在。", zhHans: "网址可能已更改，或此页面已不存在。" }, "app/not-found.tsx");
addSyntheticSlot("/_system/not-found", "errors.not_found.home", "singleline", 120, { en: "Return home", zhHant: "回到首頁", zhHans: "返回首页" }, "app/not-found.tsx");
addSyntheticSlot("/_system/not-found", "errors.not_found.contact", "singleline", 120, { en: "Contact us", zhHant: "聯絡我們", zhHans: "联系我们" }, "app/not-found.tsx");
const authSource = await readFile(path.join(root, "app", "auth-error", "auth-error-client.tsx"), "utf8");
const authCopy = vm.runInNewContext(`(${extractObject(authSource, "const copy:")})`);
for (const [kind, english] of Object.entries(authCopy.en)) {
  const semanticKind = kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  for (const field of ["eyebrow", "title", "description", "home", "contact", "reference"]) {
    addSyntheticSlot("/auth-error", `errors.auth.${semanticKind}.${field}`, field === "description" ? "multiline" : "singleline", field === "description" ? 5000 : 200, { en: english[field], zhHant: authCopy.zhHant[kind][field], zhHans: authCopy.zhHans[kind][field] }, "app/auth-error/auth-error-client.tsx");
  }
}

const catalog = [...slots.values()].sort((left, right) => left.page.localeCompare(right.page) || left.key.localeCompare(right.key));
const catalogJson = `${JSON.stringify({ version: 1, generatedAt: "source-controlled", slots: catalog }, null, 2)}\n`;
const inventory = [
  "# iHear content slot inventory", "", `Logical slots: ${catalog.length}`, "",
  "| content_key | scope/page | mode | max | English default | Traditional Chinese | Simplified Chinese | occurrences |",
  "|---|---|---:|---:|---|---|---|---|",
  ...catalog.map((slot) => `| \`${slot.key}\` | \`${slot.page}\` | ${slot.mode} | ${slot.maxLength} | ${slot.values.en.replaceAll("|", "\\|")} | ${slot.values.zhHant.replaceAll("|", "\\|")} | ${slot.values.zhHans.replaceAll("|", "\\|")} | ${slot.occurrences.map((item) => `${item.file}:${item.line}`).join("<br>")} |`),
  "",
].join("\n");

const rows = catalog.flatMap((slot) => Object.entries(slot.values).map(([locale, value]) =>
  `  (${sqlText(slot.page)}, ${sqlText(slot.key)}, ${sqlText(locale)}, ${sqlText(value)}, NOW(), 'migration-013')`
));
const migration = `-- Generated by scripts/generate-content-slots.mjs. Run with --check to verify.\n` +
`-- Preserve the four known legacy edits under their semantic keys before defaults are inserted.\n` +
`INSERT INTO public.localized_content_overrides (page, key, locale, value, updated_at, updated_by)\n` +
`SELECT '/__global__', 'programs.services.tutoring.title', locale, value, updated_at, updated_by FROM public.localized_content_overrides WHERE page='/' AND key='i18n:prog1_h' AND locale='en'\nON CONFLICT (page,key,locale) DO NOTHING;\n` +
`INSERT INTO public.localized_content_overrides (page, key, locale, value, updated_at, updated_by)\n` +
`SELECT '/about', 'about.mission.heading', locale, value, updated_at, updated_by FROM public.localized_content_overrides WHERE page='/about' AND key='section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>h2:nth-of-type(1)' AND locale='zhHant'\nON CONFLICT (page,key,locale) DO NOTHING;\n` +
`INSERT INTO public.localized_content_overrides (page, key, locale, value, updated_at, updated_by)\n` +
`SELECT '/team', CASE key WHEN 'i18n:tlnote_h' THEN 'team.leadership_note.heading' ELSE 'team.leadership_note.body' END, locale, value, updated_at, updated_by FROM public.localized_content_overrides WHERE page='/team' AND key IN ('i18n:tlnote_h','i18n:tlnote_p') AND locale='en'\nON CONFLICT (page,key,locale) DO NOTHING;\n\n` +
`INSERT INTO public.localized_content_overrides (page, key, locale, value, updated_at, updated_by) VALUES\n${rows.join(",\n")}\nON CONFLICT (page,key,locale) DO NOTHING;\n`;

const uniqueBy = (items, identity) => [...new Map(items.map((item) => [identity(item), item])).values()];
const localizedFrom = (values, offset = 0) => text3(values[offset], values[offset + 1], values[offset + 2]);
const sectionCatalog = uniqueBy(layoutSections, (item) => `${item.page}\0${item.key}`).map((item) => {
  const metadata = sectionMetadata[item.key];
  if (!metadata) throw new Error(`Missing layout section metadata for ${item.key}`);
  return {
    ...item,
    label: localizedFrom(metadata),
    description: localizedFrom(metadata, 3),
    icon: metadata[6],
    previewSelector: `[data-layout-section="${item.key}"]`,
  };
}).sort((a, b) => a.key.localeCompare(b.key));
const groupCatalog = uniqueBy(layoutGroups, (item) => `${item.page}\0${item.key}`).map((item) => {
  const metadata = groupMetadata[item.key];
  if (!metadata) throw new Error(`Missing layout group metadata for ${item.key}`);
  const itemMetadata = metadata[7];
  return {
    ...item,
    label: localizedFrom(metadata),
    description: localizedFrom(metadata, 3),
    icon: metadata[6],
    previewSelector: `[data-layout-group="${item.key}"]`,
    items: item.items.map((id) => {
      const details = itemMetadata[id];
      if (!details) throw new Error(`Missing layout item metadata for ${item.key}.${id}`);
      return { id, label: localizedFrom(details), description: localizedFrom(details, 3) };
    }),
  };
}).sort((a, b) => a.key.localeCompare(b.key));
const linkCatalog = uniqueBy(layoutLinks, (item) => `${item.page}\0${item.key}`).map((item) => {
  const metadata = linkMetadata[item.key];
  if (!metadata) throw new Error(`Missing layout link metadata for ${item.key}`);
  return {
    ...item,
    label: localizedFrom(metadata),
    description: localizedFrom(metadata, 3),
    locations: localizedFrom(metadata, 6),
    shared: item.page === "/__global__",
    usageCount: layoutLinks.filter((candidate) => candidate.page === item.page && candidate.key === item.key).length,
    previewSelector: `[data-layout-link="${item.key}"]`,
  };
}).sort((a, b) => a.key.localeCompare(b.key));
const layoutCatalog = {
  version: 2,
  pages: Object.entries(layoutPages).map(([page, label]) => ({ page, label })),
  sections: sectionCatalog,
  groups: groupCatalog,
  links: linkCatalog,
};

const outputs = new Map([
  ["data/content-slots.json", catalogJson],
  ["docs/content-slot-inventory.md", inventory],
  ["db/migrations/013_content_slots_seed.sql", migration],
  ["data/layout-slots.json", `${JSON.stringify(layoutCatalog, null, 2)}\n`],
  ...outputPages,
]);

const mismatches = [];
for (const [relative, expected] of outputs) {
  const target = path.join(root, relative);
  let actual = "";
  try { actual = await readFile(target, "utf8"); } catch {}
  if (actual !== expected) {
    if (write) await writeFile(target, expected, "utf8");
    else mismatches.push(relative);
  }
}
if (mismatches.length) {
  console.error(`Content slot artifacts are stale: ${mismatches.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`${write ? "Generated" : "Verified"} ${catalog.length} logical content slots across ${htmlFiles.length} pages.`);
}
