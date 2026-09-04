export type NamedTeamProfile = {
  id: string;
  name: string;
};

const englishNameCollator = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});

function firstName(name: string) {
  return String(name || "").trim().split(/\s+/u)[0] || "";
}

export function sortTeamProfilesByFirstName<T extends NamedTeamProfile>(profiles: readonly T[]): T[] {
  return [...profiles].sort((left, right) =>
    englishNameCollator.compare(firstName(left.name), firstName(right.name))
    || englishNameCollator.compare(String(left.name || "").trim(), String(right.name || "").trim())
    || englishNameCollator.compare(left.id, right.id),
  );
}
