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
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((left, right) => {
      const leftFirstName = firstName(left.profile.name);
      const rightFirstName = firstName(right.profile.name);
      if (!leftFirstName || !rightFirstName) {
        if (leftFirstName) return -1;
        if (rightFirstName) return 1;
        return left.index - right.index;
      }
      return englishNameCollator.compare(leftFirstName, rightFirstName)
        || englishNameCollator.compare(
          String(left.profile.name || "").trim(),
          String(right.profile.name || "").trim(),
        )
        || left.index - right.index;
    })
    .map(({ profile }) => profile);
}
