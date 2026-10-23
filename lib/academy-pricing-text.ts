import {
  ACADEMY_CURRENCIES,
  ACADEMY_DURATIONS,
  ACADEMY_PLANS,
  ACADEMY_TUTORS,
  academyPackagePrice,
  academyPackageSaving,
  type AcademyCurrency,
  type AcademyDuration,
  type AcademyLocale,
  type AcademyPlan,
  type AcademyRates,
  type AcademyTutor,
} from "./academy-content-types";

// Every price sentence on the course pages comes from this module: the
// server-rendered first paint, the price-picker lookups and the editor preview.
const SYMBOLS: Record<AcademyCurrency, string> = { TWD: "NT$", USD: "US$" };

export const ACADEMY_DEFAULT_SELECTION: Record<AcademyLocale, { currency: AcademyCurrency; duration: AcademyDuration; tutor: AcademyTutor; plan: AcademyPlan }> = {
  zhHant: { currency: "TWD", duration: "60", tutor: "highschool", plan: "single" },
  en: { currency: "USD", duration: "60", tutor: "highschool", plan: "single" },
};

export type AcademyTutorNames = Record<AcademyTutor, string>;
export type AcademyPriceView = { symbol: string; amount: string; unit: string; detail: string };

export function academyAmount(amount: number) {
  return amount.toLocaleString("en-US");
}

export function academyMoney(currency: AcademyCurrency, amount: number) {
  return SYMBOLS[currency] + academyAmount(amount);
}

// English sentences use the tutor label mid-sentence ("with a high-school tutor").
export function academySentenceLabel(label: string) {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

function article(phrase: string) {
  return /^[aeiou]/i.test(phrase) ? "an" : "a";
}

export function academyPriceView(
  locale: AcademyLocale, names: AcademyTutorNames, rates: AcademyRates,
  currency: AcademyCurrency, duration: AcademyDuration, tutor: AcademyTutor, plan: AcademyPlan,
): AcademyPriceView {
  const rate = rates[currency][duration][tutor];
  const total = academyPackagePrice(rate);
  const saving = academyPackageSaving(rate);
  const symbol = SYMBOLS[currency];
  if (locale === "zhHant") {
    const name = names[tutor];
    return plan === "package"
      ? { symbol, amount: academyAmount(total), unit: `/ 十堂・每堂 ${duration} 分鐘`, detail: `十堂 ${duration} 分鐘課程共 ${academyMoney(currency, total)}（九折），比購買十堂單堂課程省下 ${academyMoney(currency, saving)}，相當於一堂課。由${name}授課。` }
      : { symbol, amount: academyAmount(rate), unit: `/ 堂・${duration} 分鐘`, detail: `${name}的一對一課程，每堂 ${duration} 分鐘 ${academyMoney(currency, rate)}。本頁各項英文學習服務皆適用相同費率。` };
  }
  const phrase = academySentenceLabel(names[tutor]);
  return plan === "package"
    ? { symbol, amount: academyAmount(total), unit: `/ ten ${duration}-minute sessions`, detail: `Ten ${duration}-minute sessions with ${article(phrase)} ${phrase}: ${academyMoney(currency, total)} at 10% off, saving ${academyMoney(currency, saving)}, the cost of one session.` }
    : { symbol, amount: academyAmount(rate), unit: `/ ${duration}-minute session`, detail: `One ${duration}-minute session with ${article(phrase)} ${phrase}: ${academyMoney(currency, rate)}. The same rate applies to all available subjects, including SAT/PSAT.` };
}

export function academyOptionPrice(locale: AcademyLocale, rates: AcademyRates, currency: AcademyCurrency, duration: AcademyDuration, tutor: AcademyTutor) {
  return academyMoney(currency, rates[currency][duration][tutor]) + (locale === "zhHant" ? "／堂" : "/session");
}

/** Lookups for the price picker, keyed "currency|duration|tutor|plan" and "currency|duration". */
export function academyPriceLookups(locale: AcademyLocale, names: AcademyTutorNames, rates: AcademyRates) {
  const views: Record<string, AcademyPriceView> = {};
  const options: Record<string, Record<AcademyTutor, string>> = {};
  for (const currency of ACADEMY_CURRENCIES) {
    for (const duration of ACADEMY_DURATIONS) {
      options[`${currency}|${duration}`] = Object.fromEntries(ACADEMY_TUTORS.map(tutor => [tutor, academyOptionPrice(locale, rates, currency, duration, tutor)])) as Record<AcademyTutor, string>;
      for (const tutor of ACADEMY_TUTORS) {
        for (const plan of ACADEMY_PLANS) {
          views[`${currency}|${duration}|${tutor}|${plan}`] = academyPriceView(locale, names, rates, currency, duration, tutor, plan);
        }
      }
    }
  }
  return { views, options };
}

export type AcademyPriceTableRow = { label: string[]; cells: Record<AcademyTutor, string[]> };

/** The no-JavaScript price table: both currencies, both durations, single and package. */
export function academyPriceTable(locale: AcademyLocale, names: AcademyTutorNames, rates: AcademyRates) {
  const order: AcademyCurrency[] = locale === "zhHant" ? ["TWD", "USD"] : ["USD", "TWD"];
  const rows: AcademyPriceTableRow[] = [];
  for (const plan of ACADEMY_PLANS) {
    for (const duration of ACADEMY_DURATIONS) {
      const label = locale === "zhHant"
        ? [`${duration} 分鐘`, plan === "package" ? "十堂九折" : "單堂"]
        : [`${duration} min`, plan === "package" ? "10 sessions, 10% off" : "individual"];
      const cells = Object.fromEntries(ACADEMY_TUTORS.map(tutor => [tutor, order.map(currency => {
        const rate = rates[currency][duration][tutor];
        return academyMoney(currency, plan === "package" ? academyPackagePrice(rate) : rate);
      })])) as Record<AcademyTutor, string[]>;
      rows.push({ label, cells });
    }
  }
  return {
    caption: locale === "zhHant" ? "一對一課程價格（新台幣／美元）" : "One-on-one session prices (US$ / NT$)",
    option: locale === "zhHant" ? "方案" : "Option",
    tutors: names,
    rows,
  };
}

/** The sentence listing every price inside the pricing FAQ answer. */
export function academyFaqPrices(locale: AcademyLocale, names: AcademyTutorNames, rates: AcademyRates) {
  const pair = (duration: AcademyDuration, tutor: AcademyTutor, packaged: boolean) => {
    const amount = (currency: AcademyCurrency) => {
      const rate = rates[currency][duration][tutor];
      return academyMoney(currency, packaged ? academyPackagePrice(rate) : rate);
    };
    return locale === "zhHant" ? `${amount("TWD")}／${amount("USD")}` : `${amount("USD")} / ${amount("TWD")}`;
  };
  if (locale === "zhHant") {
    const single = (tutor: AcademyTutor) => `${names[tutor]}：45 分鐘 ${pair("45", tutor, false)}、60 分鐘 ${pair("60", tutor, false)}`;
    const packaged = (tutor: AcademyTutor) => `${names[tutor]} 45 分鐘 ${pair("45", tutor, true)}、60 分鐘 ${pair("60", tutor, true)}`;
    return `${single("highschool")}；${single("college")}。十堂方案為九折：${packaged("highschool")}；${packaged("college")}。`;
  }
  const single = (tutor: AcademyTutor) => `${names[tutor]}: ${pair("45", tutor, false)} for 45 minutes, ${pair("60", tutor, false)} for 60 minutes.`;
  const packaged = (tutor: AcademyTutor) => `${academySentenceLabel(names[tutor])} ${pair("45", tutor, true)} (45 minutes) or ${pair("60", tutor, true)} (60 minutes)`;
  return `${single("highschool")} ${single("college")} Ten-session packages are 10% off: ${packaged("highschool")}; ${packaged("college")}.`;
}
