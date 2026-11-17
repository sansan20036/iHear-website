// Time zones as the admin pages show them (2026-11-17): a plain name in the admin's language first,
// the IANA code only as a hint. Shared by the lesson form and the lessons list.
import type { AdminLocale } from "../admin-context";
import { describeInstant, formatUtcOffset, offsetMinutes, wallIn } from "../../../lib/zoned-time";

export const INTL_LOCALE: Record<AdminLocale, string> = { en: "en-US", zhHant: "zh-TW", zhHans: "zh-CN" };

const NAMES: Record<string, Record<AdminLocale, string>> = {
  "America/New_York": { en: "US Eastern (New York)", zhHant: "美東（紐約）", zhHans: "美东（纽约）" },
  "America/Chicago": { en: "US Central (Chicago)", zhHant: "美中（芝加哥）", zhHans: "美中（芝加哥）" },
  "America/Denver": { en: "US Mountain (Denver)", zhHant: "美山（丹佛）", zhHans: "美山（丹佛）" },
  "America/Los_Angeles": { en: "US Pacific (Los Angeles)", zhHant: "美西（洛杉磯）", zhHans: "美西（洛杉矶）" },
  "Asia/Taipei": { en: "Taiwan (Taipei)", zhHant: "台灣（台北）", zhHans: "台湾（台北）" },
  "Asia/Shanghai": { en: "Mainland China (Shanghai)", zhHant: "中國大陸（上海）", zhHans: "中国大陆（上海）" },
  "Asia/Tokyo": { en: "Japan (Tokyo)", zhHant: "日本（東京）", zhHans: "日本（东京）" },
  "Europe/London": { en: "UK (London)", zhHant: "英國（倫敦）", zhHans: "英国（伦敦）" },
};

/** The zone's generic name in the language ("Central European Time", 中歐時間), or null. */
function genericName(zone: string, locale: AdminLocale) {
  try {
    const name = new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(0).find((part) => part.type === "timeZoneName")?.value;
    return name && !/^(GMT|UTC)/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** "美東（紐約）"; for a zone outside the common list "中歐時間（Europe/Paris）". */
export function zoneName(zone: string, locale: AdminLocale) {
  const known = NAMES[zone]?.[locale];
  if (known) return known;
  const generic = genericName(zone, locale);
  const city = zone.split("/").pop()!.replace(/_/g, " ");
  return locale === "en" ? `${generic ?? city} (${zone})` : `${generic ?? city}（${zone}）`;
}

/** Every IANA zone the browser knows, for the search list (falls back to none). */
export function allTimeZones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
  return Array.isArray(list) ? list.filter((zone) => zone.includes("/")) : [];
}

/** A zone's offset at an instant, for the option labels: "UTC−05:00". */
export const offsetAt = (instant: number, zone: string) => formatUtcOffset(offsetMinutes(instant, zone));

/** A short stamp for lists: "11/20（週五）18:00", "Fri 11/20 18:00". */
export function shortStamp(instant: number, zone: string, locale: AdminLocale) {
  const { date, time } = wallIn(instant, zone);
  const day = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const { weekday } = describeInstant(instant, zone, INTL_LOCALE[locale]);
  return locale === "en" ? `${weekday} ${day} ${time}` : `${day}（${weekday}）${time}`;
}

/** The zone's abbreviation or, where it has none, its UTC offset: "EST", "BST", "UTC+08:00". */
export function zoneMark(instant: number, zone: string) {
  const { abbreviation, offset } = describeInstant(instant, zone, "en-US");
  return abbreviation ?? offset;
}
