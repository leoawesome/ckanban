import { expect, test } from "bun:test";
import { KEY_ROW, keyToInput, withCtrl, type KeyLike } from "../web/src/termKeys";

const ev = (over: Partial<KeyLike>): KeyLike => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...over,
});

test("Shift+Enter keydown sends ESC CR", () => {
  expect(keyToInput(ev({ shiftKey: true }))).toBe("\x1b\r");
});

test("Shift+Enter keypress/keyup are swallowed", () => {
  expect(keyToInput(ev({ shiftKey: true, type: "keypress" }))).toBeNull();
  expect(keyToInput(ev({ shiftKey: true, type: "keyup" }))).toBeNull();
});

test("plain Enter and other keys are left to xterm", () => {
  expect(keyToInput(ev({}))).toBeUndefined();
  expect(keyToInput(ev({ key: "a", shiftKey: true }))).toBeUndefined();
  for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
    expect(keyToInput(ev({ shiftKey: true, [mod]: true }))).toBeUndefined();
  }
  expect(keyToInput(ev({ shiftKey: true, isComposing: true }))).toBeUndefined();
});

test("Ctrl from the phone key row turns a letter into its control code", () => {
  expect(withCtrl("c")).toBe("\x03");
  expect(withCtrl("C")).toBe("\x03");
  expect(withCtrl("[")).toBe("\x1b");
  expect(withCtrl("d")).toBe("\x04");
  expect(withCtrl("1")).toBe("1");
  expect(withCtrl("ab")).toBe("ab");
});

test("phone key row sends Esc, Tab and arrow sequences", () => {
  const by = Object.fromEntries(KEY_ROW.map((k) => [k.label, k.data]));
  expect(by.Esc).toBe("\x1b");
  expect(by.Tab).toBe("\t");
  expect(by["↑"]).toBe("\x1b[A");
  expect(by["→"]).toBe("\x1b[C");
});
