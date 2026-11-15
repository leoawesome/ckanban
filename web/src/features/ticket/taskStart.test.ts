import { expect, test } from "bun:test";
import { taskStart } from "./taskStart";

test("a task waiting in Backlog can be started; other tasks there wait for their main ticket; tickets keep their buttons", () => {
  expect(taskStart({ tool: true, status: "backlog", waitsForStart: true })).toBe("start");
  expect(taskStart({ tool: true, status: "backlog" })).toBe("waits");
  expect(taskStart({ tool: true, status: "review", waitsForStart: true })).toBeNull();
  expect(taskStart({ status: "backlog" })).toBeNull();
});
