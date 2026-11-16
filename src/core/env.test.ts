import { expect, test } from "bun:test";
import { tickMs } from "./env";

test("CKANBAN_TICK_MS: a whole number of ms from 50 to 60000, else the timers' defaults", () => {
  expect(tickMs({})).toBeUndefined();
  expect(tickMs({ CKANBAN_TICK_MS: "500" })).toBe(500);
  expect(tickMs({ CKANBAN_TICK_MS: " 50 " })).toBe(50);
  expect(tickMs({ CKANBAN_TICK_MS: "60000" })).toBe(60_000);
  for (const bad of ["", "0", "49", "60001", "1.5", "-5", "fast", "1e3"]) expect(tickMs({ CKANBAN_TICK_MS: bad })).toBeUndefined();
});
