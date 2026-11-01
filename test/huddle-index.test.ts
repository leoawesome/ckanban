// The board's huddle list is parsed once and shared (Store.huddleIndex): a change must still show in the next view.
import { expect, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Huddle } from "../src/server/types";
import { api, host, huddles, idle, store, useHuddleEnv } from "./huddle-env";

useHuddleEnv();

const costOf = async (id: string) => ((await (await api(`/tickets/${id}`)).json()) as { costUsd: number }).costUsd;
const withCost = (h: Huddle, usd: number): Huddle =>
  ({ ...h, participants: h.participants.map((p) => (p.handle === "reviewer" ? { ...p, costUsd: usd } : p)) });

test("a huddle saved by the board, or renamed into the folder from outside, shows in the next ticket view", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  store.saveHuddle("p", withCost(store.getHuddle("p", h.id)!, 0));
  const base = await costOf(t.id);
  // The cache is warm now: change the huddle through saveHuddle.
  store.saveHuddle("p", withCost(store.getHuddle("p", h.id)!, 1.5));
  expect(await costOf(t.id)).toBeCloseTo(base + 1.5);

  // An outside writer: write a temp file, rename it over the huddle (as atomicWrite does).
  const dir = join(store.root, "profiles", "p", "huddles");
  const tmp = join(dir, `${h.id}.json.tmp-x`);
  writeFileSync(tmp, JSON.stringify(withCost(store.getHuddle("p", h.id)!, 4)));
  renameSync(tmp, join(dir, `${h.id}.json`));
  expect(await costOf(t.id)).toBeCloseTo(base + 4);
}, 30000);

test("listHuddles hands out copies: changing one doesn't change the shared list", async () => {
  const t = await host();
  const h = huddles.create("p", t.id, [{ preset: "reviewer" }]);
  await idle();
  store.listHuddles("p")[0].participants[0].handle = "changed";
  expect(store.huddleIndex("p")[0].participants[0].handle).not.toBe("changed");
  expect(store.huddleIndex("p")[0].id).toBe(h.id);
}, 30000);
