import { expect, test } from "bun:test";
import { callerPort, FRONT_PEER_HEADER, FRONT_SECRET_HEADER, fromFront, onFrontNotice, readFront } from "./front";

const SECRET = "a".repeat(64);

function stdin(): { stream: ReadableStream<Uint8Array>; write: (s: string) => void; close: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return { stream, write: (s) => ctl.enqueue(new TextEncoder().encode(s)), close: () => ctl.close() };
}

test("without CKANBAN_FRONT_PORT nothing is read and there is no front", async () => {
  const s = stdin();
  expect(await readFront({}, s.stream, () => {})).toBeNull();
  expect(s.stream.locked).toBe(false);
});

test("reads the secret line, then calls onGone at end of input", async () => {
  const s = stdin();
  let gone = false;
  const p = readFront({ CKANBAN_FRONT_PORT: "7777" }, s.stream, () => void (gone = true), 4242);
  s.write(SECRET.slice(0, 10));
  s.write(SECRET.slice(10) + " 5151\n");
  expect(await p).toEqual({ publicPort: 7777, secret: SECRET, pid: 5151 });
  await Bun.sleep(5);
  expect(gone).toBe(false);
  s.close();
  await Bun.sleep(5);
  expect(gone).toBe(true);
});

test("later lines are notices, whole lines only, even in the secret's chunk", async () => {
  const s = stdin();
  const got: string[] = [];
  onFrontNotice((line) => void got.push(line));
  try {
    const p = readFront({ CKANBAN_FRONT_PORT: "7777" }, s.stream, () => {}, 4242);
    s.write(`${SECRET} 5151\nchanged a.json\nchan`);
    await p;
    await Bun.sleep(5);
    expect(got).toEqual(["changed a.json"]);
    s.write("ged b.json\n\n  \n");
    await Bun.sleep(5);
    expect(got).toEqual(["changed a.json", "changed b.json"]);
    s.close();
  } finally {
    onFrontNotice(null);
  }
});

test("a front port without a good secret refuses to start", async () => {
  const empty = stdin();
  empty.close();
  await expect(readFront({ CKANBAN_FRONT_PORT: "7777" }, empty.stream, () => {})).rejects.toThrow(/no secret/);
  const short = stdin();
  short.write("abc\n");
  await expect(readFront({ CKANBAN_FRONT_PORT: "7777" }, short.stream, () => {})).rejects.toThrow(/malformed/);
  const noPid = stdin();
  noPid.write(SECRET + "\n");
  expect((await readFront({ CKANBAN_FRONT_PORT: "7777" }, noPid.stream, () => {}, 4242))?.pid).toBe(4242);
  const badPid = stdin();
  badPid.write(SECRET + " x\n");
  await expect(readFront({ CKANBAN_FRONT_PORT: "7777" }, badPid.stream, () => {})).rejects.toThrow(/pid/);
  await expect(readFront({ CKANBAN_FRONT_PORT: "nope" }, stdin().stream, () => {})).rejects.toThrow(/not a port/);
});

const front = { publicPort: 7777, secret: SECRET, pid: 1 };
const req = (h: Record<string, string>) => new Request("http://127.0.0.1:5000/api/x", { headers: h });

test("fromFront: always true alone; behind a front only with the exact secret", () => {
  expect(fromFront(req({}), null)).toBe(true);
  expect(fromFront(req({}), front)).toBe(false);
  expect(fromFront(req({ [FRONT_SECRET_HEADER]: "b".repeat(64) }), front)).toBe(false);
  expect(fromFront(req({ [FRONT_SECRET_HEADER]: SECRET + "x" }), front)).toBe(false);
  expect(fromFront(req({ [FRONT_SECRET_HEADER]: SECRET }), front)).toBe(true);
});

test("callerPort: the socket's alone (the header ignored), the header's behind a front", () => {
  expect(callerPort(req({ [FRONT_PEER_HEADER]: "1234" }), 5555, null)).toBe(5555);
  expect(callerPort(req({}), undefined, null)).toBe(0);
  expect(callerPort(req({ [FRONT_PEER_HEADER]: "1234" }), 5555, front)).toBe(1234);
  for (const bad of ["", "0", "70000", "12.5", "x"]) expect(callerPort(req({ [FRONT_PEER_HEADER]: bad }), 5555, front)).toBe(0);
});
