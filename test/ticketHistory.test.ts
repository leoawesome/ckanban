import { expect, test } from "bun:test";
import { closeSteps, openDepth } from "../web/src/ticketHistory";

test("tickets opened in a row on one board count up from the board", () => {
  const a = { ckDepth: openDepth(null, "kanban", "kanban"), ckBoard: "kanban" };
  expect(a.ckDepth).toBe(1);
  const b = { ckDepth: openDepth(a, "kanban", "kanban"), ckBoard: "kanban" };
  expect(b.ckDepth).toBe(2);
  expect(closeSteps(b, "kanban")).toBe(2);
});

test("a ticket on another board starts over, so closing stays on its board", () => {
  const a = { ckDepth: 1, ckBoard: "kanban" };
  const other = { ckDepth: openDepth(a, "kanban", "hyrox"), ckBoard: "hyrox" };
  expect(closeSteps(other, "hyrox")).toBe(0);
  const next = { ckDepth: openDepth(other, "hyrox", "hyrox"), ckBoard: "hyrox" };
  expect(closeSteps(next, "hyrox")).toBe(1);
});

test("entries the app didn't add (pasted links, other states) are not gone back over", () => {
  expect(closeSteps(null, "kanban")).toBe(0);
  expect(closeSteps({ ckFileViewer: true }, "kanban")).toBe(0);
  expect(closeSteps({ ckDepth: 2, ckBoard: "hyrox" }, "kanban")).toBe(0);
  expect(openDepth({ ckFileViewer: true }, "kanban", "kanban")).toBe(1);
});
