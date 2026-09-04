import { describe, expect, test } from "vitest";
import { sortTeamProfilesByFirstName } from "../lib/team-sort";

describe("team first-name sorting", () => {
  test("sorts the complete tutor list by first name without mutating it", () => {
    const profiles = [
      { id: "zoe", name: "Zoe Lu" },
      { id: "amy-chen", name: "Amy Chen" },
      { id: "howard", name: "Howard M. Ren" },
      { id: "alvaro", name: "Álvaro Cruz" },
      { id: "amy-adams", name: "amy Adams" },
    ];
    const originalOrder = profiles.map(profile => profile.id);

    const sorted = sortTeamProfilesByFirstName(profiles);

    expect(sorted.map(profile => profile.id)).toEqual([
      "alvaro",
      "amy-adams",
      "amy-chen",
      "howard",
      "zoe",
    ]);
    expect(profiles.map(profile => profile.id)).toEqual(originalOrder);
    expect(sorted).not.toBe(profiles);
  });

  test("uses a stable id tie-breaker for identical names", () => {
    const sorted = sortTeamProfilesByFirstName([
      { id: "person-2", name: "Ryan Lin" },
      { id: "person-1", name: "Ryan Lin" },
    ]);

    expect(sorted.map(profile => profile.id)).toEqual(["person-1", "person-2"]);
  });
});
