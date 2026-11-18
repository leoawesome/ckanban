import { describe, expect, test } from "bun:test";
import { freshDefault, freshNote, proposalPatch } from "./freshChat";

const withCache = (cache: any) => ({ session: { cache } as any });

describe("Start work in a fresh chat", () => {
  test("pre-ticked over 50k, unticked when short or unknown, with the note for each", () => {
    const long = freshDefault(withCache({ tokens: 90_000, coldTokens: 86_200, at: "x", ttl: "1h", model: "m", costUsd: 0 }));
    expect(long).toEqual({ tokens: 86_200, on: true });
    expect(freshNote(long)).toBe("The planning chat is long (86k). Claude starts from this ticket and the chosen mockups, and can look back at the planning chat when it needs to.");
    // Unticked by the user, the note still describes the chat.
    expect(freshNote({ ...long, on: false })).toBe(freshNote(long));
    const short = freshDefault(withCache({ tokens: 9_000, at: "x", ttl: "1h", model: "m", costUsd: 0 }));
    expect(short).toEqual({ tokens: 9_000, on: false });
    expect(freshNote(short)).toBe("The planning chat is short (9k), so Claude keeps it. Tick to start from the ticket only.");
    expect(freshDefault(withCache({ tokens: 50_000 })).on).toBe(false);
    for (const t of [{ session: null }, {}, withCache(null)]) {
      const d = freshDefault(t as any);
      expect(d).toEqual({ tokens: null, on: false });
      expect(freshNote(d)).not.toMatch(/\d/);
    }
    // Plain words only.
    for (const n of [freshNote(long), freshNote(short), freshNote({ tokens: null, on: false })]) expect(n).not.toMatch(/session|context|token/i);
  });

  test("Apply & start work sends the box's choice; Apply only sends none", () => {
    const p = { title: "T", description: "D" } as any;
    expect(proposalPatch(p, { fresh: true })).toEqual({ title: "T", body: "D", status: "ready", freshChat: true });
    expect(proposalPatch(p, { fresh: false })).toEqual({ title: "T", body: "D", status: "ready", freshChat: false });
    expect(proposalPatch(p)).toEqual({ title: "T", body: "D" });
  });
});
