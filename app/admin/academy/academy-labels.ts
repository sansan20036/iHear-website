import type { AcademyField } from "../../../lib/academy-content-types";

// Course pages are English and Traditional Chinese only, so the editor offers
// those two interface languages; the Simplified admin interface uses Traditional.
export type AcademyUiLocale = "en" | "zhHant";

type Label = { zhHant: string; en: string };

const SECTIONS: Record<string, Label> = {
  hero: { zhHant: "首頁主視覺", en: "Hero" },
  ribbon: { zhHant: "標語列", en: "Ribbon" },
  subjects: { zhHant: "英文課程", en: "Subjects" },
  approach: { zhHant: "學習方式", en: "Our approach" },
  learners: { zhHant: "適合對象", en: "Who we help" },
  tutors: { zhHant: "認識導師", en: "Tutors" },
  pricing: { zhHant: "課程費用", en: "Pricing" },
  purpose: { zhHant: "使命", en: "Purpose" },
  faq: { zhHant: "常見問題", en: "FAQ" },
  start: { zhHant: "開始詢問", en: "Get started" },
  footer: { zhHant: "頁尾", en: "Footer" },
};

const PARTS: Record<string, Label> = {
  eyebrow: { zhHant: "小標", en: "Eyebrow" },
  title: { zhHant: "標題", en: "Heading" },
  titleLead: { zhHant: "標題第一行", en: "Heading, first line" },
  titleEmphasis: { zhHant: "標題強調文字", en: "Heading, emphasized text" },
  titleTrail: { zhHant: "標題最後一行", en: "Heading, last line" },
  lead: { zhHant: "引言", en: "Lead paragraph" },
  body: { zhHant: "內文", en: "Body text" },
  intro: { zhHant: "說明", en: "Introduction" },
  cta: { zhHant: "主要按鈕文字", en: "Main button text" },
  link: { zhHant: "連結文字", en: "Link text" },
  caption: { zhHant: "圖片說明", en: "Photo caption" },
  missionLabel: { zhHant: "使命小標", en: "Mission label" },
  missionTitle: { zhHant: "使命標題", en: "Mission heading" },
  missionLink: { zhHant: "使命連結文字", en: "Mission link text" },
  label: { zhHant: "卡片標籤", en: "Card label" },
  button: { zhHant: "按鈕文字", en: "Button text" },
  fine: { zhHant: "附註", en: "Fine print" },
  note: { zhHant: "附註", en: "Note" },
  noteTitle: { zhHant: "附註標題", en: "Note heading" },
  noteText: { zhHant: "附註內容", en: "Note text" },
  question: { zhHant: "問題", en: "Question" },
  answer: { zhHant: "答案", en: "Answer" },
  answerLead: { zhHant: "答案（價格列表之前）", en: "Answer, before the price list" },
  answerNote: { zhHant: "答案（價格列表之後）", en: "Answer, after the price list" },
  tagline: { zhHant: "標語", en: "Tagline" },
  text: { zhHant: "說明", en: "Text" },
  "tutor.highschool": { zhHant: "高中生導師名稱", en: "High-school tutor name" },
  "tutor.college": { zhHant: "大學生導師名稱", en: "College tutor name" },
};

const NUMBERED: Record<string, Label> = {
  tag: { zhHant: "標籤", en: "Tag" },
  item: { zhHant: "項目", en: "Item" },
  include: { zhHant: "包含項目", en: "Included item" },
  body: { zhHant: "內文段落", en: "Paragraph" },
};

const NESTED: Record<string, Label> = {
  step: { zhHant: "步驟", en: "Step" },
  row: { zhHant: "第 {n} 列", en: "Row {n}" },
};

export function academyBlockLabel(block: string, ui: AcademyUiLocale) {
  const [section, part] = block.split(".");
  const name = SECTIONS[section]?.[ui] ?? block;
  if (!part) return ["subjects", "approach", "learners", "pricing", "faq"].includes(section) ? `${name}${ui === "zhHant" ? "：區塊標題" : ": section heading"}` : name;
  const number = /\d+$/.exec(part)?.[0];
  const kind = part.replace(/\d+$/, "");
  const zh: Record<string, string> = { card: `第 ${number} 張卡片`, point: `重點 ${number}`, item: `第 ${number} 題`, loop: "一堂課的節奏", inquiry: "詢問清單", aside: "旁欄說明" };
  const en: Record<string, string> = { card: `card ${number}`, point: `point ${number}`, item: `question ${number}`, loop: "learning loop", inquiry: "inquiry checklist", aside: "side notes" };
  if (section === "pricing" && part === "card") return ui === "zhHant" ? `${name}：價格卡` : `${name}: price card`;
  const detail = (ui === "zhHant" ? zh : en)[kind] ?? part;
  return ui === "zhHant" ? `${name}：${detail}` : `${name}: ${detail}`;
}

export function academyFieldLabel(field: AcademyField, ui: AcademyUiLocale) {
  const part = field.id.slice(field.block.length + 1);
  if (PARTS[part]) return PARTS[part][ui];
  const numbered = /^([a-z]+)(\d+)$/i.exec(part);
  if (numbered && NUMBERED[numbered[1]]) return `${NUMBERED[numbered[1]][ui]} ${numbered[2]}`;
  const nested = /^([a-z]+)(\d+)\.([a-z]+)$/i.exec(part);
  if (nested && NESTED[nested[1]]) {
    const prefix = NESTED[nested[1]][ui].includes("{n}") ? NESTED[nested[1]][ui].replace("{n}", nested[2]) : `${NESTED[nested[1]][ui]} ${nested[2]}`;
    const suffix = PARTS[nested[3]]?.[ui] ?? nested[3];
    return ui === "zhHant" ? `${prefix}${suffix}` : `${prefix} ${suffix.toLowerCase()}`;
  }
  return part;
}

export function academyBlockSection(block: string) {
  return block.split(".")[0];
}

export function academySectionLabel(section: string, ui: AcademyUiLocale) {
  return SECTIONS[section]?.[ui] ?? section;
}
