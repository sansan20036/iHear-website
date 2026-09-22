// Read-only public presentation policy. The migration owns the persisted marker.
export const GUIDE_TAKEOVER_SETTING = "resource_guides_takeover_v1";
export const migratedGuideIds = ["communication", "classroom", "family", "hearing-loss", "implant", "hearing-aid", "activities", "tracking", "handbook"].map(key => `guide-${key}`);
type Topic = { id: string };
type Item = { id: string; topicId: string; type: string };
export type GuidesTakeover = "legacy" | "complete" | "unavailable";
export function guidesTakeoverState(marker: unknown, topics: Topic[], items: Item[]): GuidesTakeover {
  const candidates = items.filter(item => item.topicId === "guides" || migratedGuideIds.includes(item.id));
  if (marker === undefined || marker === false) return candidates.length ? "unavailable" : "legacy";
  if (marker !== true && marker !== "complete") return "unavailable";
  // Count all records, including drafts/archives: hiding a guide never revives legacy content.
  if (!topics.some(topic => topic.id === "guides")) return "unavailable";
  const ids = new Set(topics.map(topic => topic.id));
  if (!migratedGuideIds.every(id => {
    const matches = items.filter(item => item.id === id);
    return matches.length === 1 && ids.has(matches[0].topicId);
  })) return "unavailable";
  return "complete";
}
