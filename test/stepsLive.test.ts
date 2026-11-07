import { describe, expect, test } from "bun:test";
import { workingInFamily } from "../web/src/family";
import { stepsLine, stepsLineText, stepsWorking } from "../web/src/stepsLive";

const at = (n: number) => `2026-11-07T00:00:0${n}Z`;
const t = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, status: "backlog", createdAt: at(0), running: false, ...extra });

describe("the chat's steps working line", () => {
  test("no line with nothing running", () => {
    expect(stepsLine([])).toBeNull();
    expect(stepsLineText([])).toBe("");
  });
  test("one step names it", () => {
    expect(stepsLineText(["Build the login page"])).toBe("Working: Build the login page");
  });
  test("several steps count and name them, then and N more", () => {
    expect(stepsLineText(["Build the login page", "Test the signup"])).toBe("2 tasks working: Build the login page, Test the signup");
    expect(stepsLineText(["A", "B", "C", "D"])).toBe("4 tasks working: A, B and 2 more");
    expect(stepsLine(["A", "B", "C"])!.more).toBe(1);
  });
});

describe("which tickets of a feature are working", () => {
  const main = t("m", { main: true, status: "review", running: true });
  const board = [
    main,
    t("a", { tool: true, partOf: "m", running: true, status: "in_progress", createdAt: at(1) }),
    t("b", { tool: true, partOf: "m", status: "done", createdAt: at(2) }),
    t("c", { partOf: "m", running: true, createdAt: at(3) }), // added by the user, not a tool ticket
    t("d", { tool: true, partOf: "m", status: "ready", createdAt: at(4) }),
    t("x", { running: true }), // another feature's ticket
  ];
  test("running and queued steps count, an added running ticket too, the main ticket and others never", () => {
    expect(stepsWorking(board, main).map((x) => x.id)).toEqual(["a", "c", "d"]);
  });
  test("only a main ticket's chat shows the line", () => {
    expect(stepsWorking(board, { id: "m" })).toEqual([]);
  });
  test("the main ticket alone running gives no line", () => {
    expect(stepsWorking([main, t("b", { tool: true, partOf: "m", status: "done" })], main)).toEqual([]);
  });
  test("the shared rule leaves the main ticket out even when it is listed", () => {
    expect(workingInFamily(board.slice(0, 5), "m", (x) => !!x.running).map((x) => x.id)).toEqual(["a", "c", "d"]);
  });
});
