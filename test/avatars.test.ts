import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { RUN_HEADER } from "../src/server/scheduler";
import { Store } from "../src/server/store";
import * as server from "../src/server/avatars";
import {
  AVATAR_ACCESSORIES, AVATAR_FACES, AVATAR_HAIRS, avatarFor, avatarKey, CLAUDE_LOOK, cleanAvatarLook, defaultAvatar, TEAMMATE_LOOKS, YOU_LOOK,
} from "../web/src/avatarLook";
import { faceLook } from "../web/src/huddleText";
import { tempDir } from "./helpers";

test("the server and the UI know the same parts", () => {
  expect([...server.AVATAR_FACES]).toEqual([...AVATAR_FACES]);
  expect([...server.AVATAR_HAIRS]).toEqual([...AVATAR_HAIRS]);
  expect([...server.AVATAR_ACCESSORIES]).toEqual([...AVATAR_ACCESSORIES]);
});

test("Claude is a brand-colour robot, the user a person", () => {
  expect(defaultAvatar("claude")).toEqual(CLAUDE_LOOK);
  expect(CLAUDE_LOOK).toMatchObject({ face: "robot", color: "#b0502f" });
  expect(defaultAvatar("you").face).toBe("person");
  expect(defaultAvatar({ handle: "leo", kind: "human" })).toEqual(YOU_LOOK);
});

test("built-in teammates keep their role colours and get their look", () => {
  for (const [name, look] of Object.entries(TEAMMATE_LOOKS)) {
    expect(defaultAvatar(name)).toEqual(look);
    expect(look.color).toBe(faceLook({ handle: name }).color);
  }
  expect(defaultAvatar("reviewer")).toMatchObject({ accessory: "glasses" });
  expect(defaultAvatar("ponytail")).toMatchObject({ face: "person", hair: "ponytail", accessory: "bow" });
  expect(defaultAvatar("qa")).toMatchObject({ accessory: "headset" });
});

test("handles and custom roles match like faceLook: qa-2 is qa, a code reviewer a reviewer", () => {
  expect(defaultAvatar("qa-2")).toEqual(TEAMMATE_LOOKS.qa);
  expect(defaultAvatar({ handle: "qa-2" })).toEqual(TEAMMATE_LOOKS.qa);
  expect(defaultAvatar({ handle: "bob", role: "Code reviewer" })).toEqual(TEAMMATE_LOOKS.reviewer);
  expect(defaultAvatar({ handle: "x", preset: "security" })).toEqual(TEAMMATE_LOOKS.security);
});

test("unknown names get a stable default from the name", () => {
  for (const name of ["perf-hunter", "alice", "z"]) {
    const a = defaultAvatar(name);
    expect(defaultAvatar(name)).toEqual(a);
    expect(a.color).toBe(faceLook({ handle: name }).color);
    expect(AVATAR_HAIRS).toContain(a.hair);
  }
  expect(defaultAvatar("perf-hunter-2")).toEqual(defaultAvatar("perf-hunter"));
  const many = Array.from({ length: 60 }, (_, i) => defaultAvatar(`custom-${i}x`));
  expect(many.every((a) => AVATAR_HAIRS.includes(a.hair))).toBe(true);
  const colours = new Set(many.map((a) => a.color));
  expect(colours.size).toBeGreaterThan(2);
});

test("a saved choice wins field by field; damaged data falls back to the default", () => {
  const saved = { reviewer: { face: "critter", color: "#123456" }, claude: { hair: "bun" } } as any;
  expect(avatarFor("reviewer", saved)).toEqual({ ...TEAMMATE_LOOKS.reviewer, face: "critter", color: "#123456" });
  expect(avatarFor({ handle: "reviewer-2" }, saved).face).toBe("critter");
  expect(avatarFor("claude", saved)).toEqual({ ...CLAUDE_LOOK, hair: "bun" });
  for (const bad of [null, undefined, "x", 42, [], { reviewer: "nope" }, { reviewer: { face: "dragon", color: "red", hair: 3 } }]) {
    expect(avatarFor("reviewer", bad as any)).toEqual(TEAMMATE_LOOKS.reviewer);
  }
  expect(avatarFor("constructor", {})).toEqual(defaultAvatar("constructor"));
  expect(avatarKey({ handle: "qa-2", preset: "qa" })).toBe("qa");
});

test("only known parts and #rrggbb colours are kept", () => {
  const raw = { face: "robot", color: "#ABCDEF", hair: "mohawk", hairColor: "url(#x)", accessory: "<script>", extra: "x" };
  expect(cleanAvatarLook(raw)).toEqual({ face: "robot", color: "#abcdef" });
  expect(server.cleanLook(raw)).toEqual({ face: "robot", color: "#abcdef" });
  expect(server.cleanLook({ color: "#fff" })).toEqual({});
  expect(server.cleanLook({ color: "#12345678" })).toEqual({});
  expect(server.cleanAvatars({ ok: { face: "person" }, "Bad Name": { face: "robot" }, "../x": { face: "robot" }, empty: { face: "x" } }))
    .toEqual({ ok: { face: "person" } });
  expect(server.cleanAvatars([1, 2])).toEqual({});
  expect(() => server.withAvatar({}, "qa", { face: "dragon" })).toThrow();
  expect(() => server.withAvatar({}, "__proto__", { face: "robot" })).toThrow();
});

// ---- Saving and loading through the daemon ----

let srv: ReturnType<typeof createServer>;
let store: Store;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  srv = createServer({ store, bus, board: new Board(store, bus, { claudeBin: "/bin/false" }), port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv.stop(true));

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test("saves a choice for every board, loads it back after a restart, and resets it", async () => {
  expect(await (await send("GET", "/api/avatars")).json()).toEqual({});
  let r = await send("PUT", "/api/avatars/reviewer", { face: "person", color: "#2B5FB8", hair: "dragon", accessory: "crown", junk: 1 });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ reviewer: { face: "person", color: "#2b5fb8", accessory: "crown" } });
  await send("PUT", "/api/avatars/claude", { hair: "bun" });
  // A new Store on the same folder: what a restart reads.
  const again = new Store(store.root);
  expect(again.listAvatars()).toEqual({ reviewer: { face: "person", color: "#2b5fb8", accessory: "crown" }, claude: { hair: "bun" } });
  expect(avatarFor("reviewer", again.listAvatars())).toEqual({ ...TEAMMATE_LOOKS.reviewer, face: "person", accessory: "crown" });
  r = await send("DELETE", "/api/avatars/reviewer");
  expect(await r.json()).toEqual({ claude: { hair: "bun" } });
});

test("rejects bad names, empty looks and runs", async () => {
  expect((await send("PUT", "/api/avatars/Bad%20Name", { face: "robot" })).status).toBe(400);
  expect((await send("PUT", "/api/avatars/qa", { face: "dragon", color: "javascript:x" })).status).toBe(400);
  expect((await send("PUT", "/api/avatars/qa", { face: "robot" }, { [RUN_HEADER]: "b/t" })).status).toBe(403);
  expect((await (await send("GET", "/api/avatars")).json() as any).qa).toBeUndefined();
});

test("a damaged avatars.json shows the defaults instead of breaking", async () => {
  const file = join(store.root, "avatars.json");
  writeFileSync(file, "{not json");
  expect(store.listAvatars()).toEqual({});
  expect(await (await send("GET", "/api/avatars")).json()).toEqual({});
  writeFileSync(file, JSON.stringify({ qa: { face: "critter", color: "#zzzzzz" }, junk: "x", "x y": { face: "robot" } }));
  expect(store.listAvatars()).toEqual({ qa: { face: "critter" } });
  // Saving over a damaged file writes a clean one.
  await send("PUT", "/api/avatars/claude", { face: "robot" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ qa: { face: "critter" }, claude: { face: "robot" } });
});
