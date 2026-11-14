// The ticket panel's open tab and Outputs file in the link (web/src/tabLink.ts).
import { expect, test } from "bun:test";
import { hashIsTicket, readTabLink, withTabLink } from "../web/src/tabLink";

test("reads the tab and the Outputs file from a ticket link", () => {
  expect(readTabLink("#/kanban/t_1?tab=outputs&file=a%2Freport.md")).toEqual({ tab: "outputs", file: "a/report.md" });
  expect(readTabLink("#/kanban/t_1?tab=family&file=x")).toEqual({ tab: "family", file: null });
  expect(readTabLink("#/kanban/t_1?tab=nope")).toEqual({ tab: null, file: null });
  expect(readTabLink("#/kanban/t_1")).toEqual({ tab: null, file: null });
});

test("writes the tab, leaves Chat out and keeps other keys", () => {
  expect(withTabLink("#/kanban/t_1", "outputs", "a/report.md")).toBe("#/kanban/t_1?tab=outputs&file=a%2Freport.md");
  expect(withTabLink("#/kanban/t_1?tab=outputs&file=x", "chat", null)).toBe("#/kanban/t_1");
  expect(withTabLink("#/kanban/t_1?browsers", "family", "x")).toBe("#/kanban/t_1?browsers=&tab=family");
});

test("knows the ticket a link is for", () => {
  expect(hashIsTicket("#/kanban/t_1?tab=family", "t_1")).toBe(true);
  expect(hashIsTicket("#/kanban", "t_1")).toBe(false);
  expect(hashIsTicket("#/kanban/t_2", "t_1")).toBe(false);
});
