import { describe, expect, test } from "vitest";
import { sortTeamProfilesByFirstName } from "../lib/team-sort";

describe("team first-name sorting", () => {
  test("sorts the complete tutor list by first name without mutating it", () => {
    const profiles = [
      { id: "zoe", name: "Zoe Lu" },
      { id: "amy-chen", name: "Amy Chen" },
      { id: "howard", name: "Howard M. Ren" },
      { id: "tristan", name: "Tristan Lee" },
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
      "tristan",
      "zoe",
    ]);
    expect(profiles.map(profile => profile.id)).toEqual(originalOrder);
    expect(sorted).not.toBe(profiles);
  });

  test("preserves the current relative order for identical names and puts missing names last", () => {
    const sorted = sortTeamProfilesByFirstName([
      { id: "person-2", name: "Ryan Lin" },
      { id: "missing-1", name: "  " },
      { id: "person-1", name: "Ryan Lin" },
      { id: "missing-2", name: "" },
    ]);

    expect(sorted.map(profile => profile.id)).toEqual([
      "person-2",
      "person-1",
      "missing-1",
      "missing-2",
    ]);
  });
});
