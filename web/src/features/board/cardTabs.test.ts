import { expect, test } from "bun:test";
import { lockCardTabs, unlockCardTabs } from "../web/src/cardTabs";
import { teamButtonText } from "../web/src/huddleText";

/** A tiny stand-in for a card's controls: attribute maps, matched by the two selectors cardTabs uses. */
function fakeCard(controls: Record<string, string>[]) {
  const els = controls.map((attrs) => {
    const a = new Map(Object.entries(attrs));
    return {
      a,
      getAttribute: (n: string) => a.get(n) ?? null,
      setAttribute: (n: string, v: string) => void a.set(n, v),
      removeAttribute: (n: string) => void a.delete(n),
      hasAttribute: (n: string) => a.has(n),
    };
  });
  return {
    els,
    querySelectorAll: (sel: string) => (sel.startsWith("[data-card-tab") ? els.filter((e) => e.a.has("data-card-tab")) : els),
  };
}

test("lockCardTabs takes the card's controls out of the Tab order and unlock gives each its own tabindex back", () => {
  const card = fakeCard([{}, { tabindex: "0" }, { tabindex: "-1" }]);
  lockCardTabs(card);
  expect(card.els.map((e) => e.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);
  // Locking twice keeps the remembered tabindex.
  lockCardTabs(card);
  unlockCardTabs(card);
  expect(card.els.map((e) => e.getAttribute("tabindex"))).toEqual([null, "0", "-1"]);
  expect(card.els.some((e) => e.hasAttribute("data-card-tab"))).toBe(false);
});

test("teamButtonText puts the counts in the name and writes the tooltip without a double full stop", () => {
  expect(teamButtonText(0, 0)).toEqual({ label: "Team", title: "Teammates, squads and huddles (T)" });
  expect(teamButtonText(1, 1)).toEqual({
    label: "Team, 1 huddle live, 1 new lesson",
    title: "Teammates, squads and huddles (T). 1 huddle live. 1 new lesson.",
  });
  expect(teamButtonText(2, 0).label).toBe("Team, 2 huddles live");
  expect(teamButtonText(0, 3).title).toBe("Teammates, squads and huddles (T). 3 new lessons.");
});
