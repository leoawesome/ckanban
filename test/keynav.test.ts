import { expect, test } from "bun:test";
import { boardDigit, canStartFromProposal, cardDir, cardKey, escLeavesField, inDock, isInboxKey, isUndoKey, listKey, panelBoardKey, stepIndex, drawerTabs, hintParts, hintStep, isBoardPickerKey, isComboKeys, isStopKey, isTyping, newTicketKey, nextStep, panelStep, stepBoard, stepCard, stepTab } from "../web/src/keynav";

test("cardDir maps J/K/H/L and arrows, ignores other keys", () => {
  expect(cardDir("j")).toBe("down");
  expect(cardDir("ArrowDown")).toBe("down");
  expect(cardDir("K")).toBe("up");
  expect(cardDir("ArrowUp")).toBe("up");
  expect(cardDir("h")).toBe("left");
  expect(cardDir("ArrowRight")).toBe("right");
  expect(cardDir("l")).toBe("right");
  expect(cardDir("n")).toBeNull();
  expect(cardDir("Enter")).toBeNull();
});

test("stepCard with nothing selected picks the first card of the first non-empty column", () => {
  expect(stepCard([0, 0, 3, 1], null, "down")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0, 3, 1], null, "left")).toEqual({ col: 2, row: 0 });
  expect(stepCard([0, 0], null, "down")).toBeNull();
});

test("stepCard moves up and down within a column, clamped", () => {
  expect(stepCard([3], { col: 0, row: 0 }, "down")).toEqual({ col: 0, row: 1 });
  expect(stepCard([3], { col: 0, row: 2 }, "down")).toEqual({ col: 0, row: 2 });
  expect(stepCard([3], { col: 0, row: 0 }, "up")).toEqual({ col: 0, row: 0 });
});

test("stepCard sideways skips empty columns, keeps the row and clamps to shorter columns", () => {
  expect(stepCard([4, 0, 2], { col: 0, row: 1 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 0, row: 3 }, "right")).toEqual({ col: 2, row: 1 });
  expect(stepCard([4, 0, 2], { col: 2, row: 1 }, "left")).toEqual({ col: 0, row: 1 });
  // At the edge: stay put.
  expect(stepCard([4, 0, 2], { col: 2, row: 0 }, "right")).toEqual({ col: 2, row: 0 });
  expect(stepCard([4, 0, 0], { col: 0, row: 2 }, "right")).toEqual({ col: 0, row: 2 });
});

test("stepCard recovers when the selected column emptied", () => {
  expect(stepCard([0, 2], { col: 0, row: 0 }, "down")).toEqual({ col: 1, row: 0 });
});

test("stepBoard wraps around both ways", () => {
  expect(stepBoard(3, 0, 1)).toBe(1);
  expect(stepBoard(3, 2, 1)).toBe(0);
  expect(stepBoard(3, 0, -1)).toBe(2);
  expect(stepBoard(1, 0, 1)).toBe(0);
  expect(stepBoard(3, -1, 1)).toBe(0);
  expect(stepBoard(0, 0, 1)).toBe(-1);
});

test("boardDigit reads the physical key, 1-9 only", () => {
  expect(boardDigit("Digit1")).toBe(0);
  expect(boardDigit("Digit9")).toBe(8);
  expect(boardDigit("Numpad2")).toBe(1);
  expect(boardDigit("Digit0")).toBeNull();
  expect(boardDigit("KeyA")).toBeNull();
});

test("panelStep: plain arrows and J/K step tickets, modifiers and other keys don't", () => {
  const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    panelStep({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  expect(k("ArrowUp")).toBe("prev");
  expect(k("k")).toBe("prev");
  expect(k("ArrowDown")).toBe("next");
  expect(k("J")).toBe("next");
  expect(k("ArrowLeft")).toBeNull();
  expect(k("e")).toBeNull();
  expect(k("ArrowUp", { altKey: true })).toBeNull();
  expect(k("ArrowDown", { shiftKey: true })).toBeNull();
  expect(k("j", { metaKey: true })).toBeNull();
});

test("nextStep applies a pending proposal first (starting work from Backlog/Planning), then the column's action", () => {
  expect(nextStep({ status: "planning", working: false, proposalPending: true })).toBe("apply-start");
  expect(nextStep({ status: "backlog", working: false, proposalPending: true })).toBe("apply-start");
  expect(nextStep({ status: "ready", working: false, proposalPending: true })).toBe("apply");
  expect(nextStep({ status: "planning", working: false, proposalPending: false })).toBe("start");
  expect(nextStep({ status: "backlog", working: false, proposalPending: false })).toBe("start");
  expect(nextStep({ status: "review", working: false, proposalPending: false })).toBe("done");
  expect(nextStep({ status: "review", working: false, proposalPending: true })).toBe("apply");
  expect(nextStep({ status: "ready", working: false, proposalPending: false })).toBeNull();
  expect(nextStep({ status: "done", working: false, proposalPending: false })).toBeNull();
  expect(nextStep({ status: "planning", working: true, proposalPending: true })).toBeNull();
});

test("nextStep moves a planner whose plan is finished to Done instead of starting work", () => {
  expect(nextStep({ status: "planning", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "backlog", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "review", working: false, proposalPending: false, planFinished: true })).toBe("done");
  expect(nextStep({ status: "done", working: false, proposalPending: false, planFinished: true })).toBeNull();
  expect(nextStep({ status: "planning", working: false, proposalPending: true, planFinished: true })).toBe("apply-start");
  expect(nextStep({ status: "planning", working: true, proposalPending: false, planFinished: true })).toBeNull();
});

test("hintStep: holding ⌘ arms, any other key or releasing hides", () => {
  expect(hintStep({ type: "keydown", key: "Meta" }, true)).toBe("arm");
  expect(hintStep({ type: "keydown", key: "Meta", repeat: true }, true)).toBe("none");
  expect(hintStep({ type: "keydown", key: "c" }, true)).toBe("hide");
  expect(hintStep({ type: "keydown", key: "Shift" }, true)).toBe("hide");
  expect(hintStep({ type: "keyup", key: "Meta" }, true)).toBe("hide");
  expect(hintStep({ type: "keyup", key: "c" }, true)).toBe("none");
  // Ctrl is the hint key off Mac only.
  expect(hintStep({ type: "keydown", key: "Control" }, true)).toBe("hide");
  expect(hintStep({ type: "keydown", key: "Control" }, false)).toBe("arm");
  expect(hintStep({ type: "keydown", key: "Meta" }, false)).toBe("hide");
});

test("isTyping is true in text fields only", () => {
  expect(isTyping({ target: { tagName: "INPUT" } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "TEXTAREA" } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "DIV", isContentEditable: true } as any })).toBe(true);
  expect(isTyping({ target: { tagName: "BUTTON", isContentEditable: false } as any })).toBe(false);
  expect(isTyping({ target: null })).toBe(false);
});

test("canStartFromProposal only from Backlog or Planning while Claude is idle", () => {
  expect(canStartFromProposal({ status: "planning", working: false })).toBe(true);
  expect(canStartFromProposal({ status: "backlog", working: false })).toBe(true);
  expect(canStartFromProposal({ status: "planning", working: true })).toBe(false);
  for (const status of ["ready", "in_progress", "review", "done"]) expect(canStartFromProposal({ status, working: false })).toBe(false);
});

test("newTicketKey: ⌘/Ctrl + Enter, S, I, D; nothing without the modifier or with Shift/Alt", () => {
  const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = { metaKey: true }) =>
    newTicketKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  expect(k("Enter")).toBe("start");
  expect(k("s")).toBe("create");
  expect(k("S", { ctrlKey: true })).toBe("create");
  expect(k("i")).toBe("mode");
  expect(k("d")).toBe("star");
  expect(k("x")).toBeNull();
  expect(k("s", {})).toBeNull();
  expect(k("s", { metaKey: true, shiftKey: true })).toBeNull();
  expect(k("s", { metaKey: true, altKey: true })).toBeNull();
  expect(k("Enter", { metaKey: true, isComposing: true })).toBeNull();
});

test("isStopKey: ⌘. or Ctrl+. only", () => {
  const base = { key: ".", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  expect(isStopKey({ ...base, metaKey: true })).toBe(true);
  expect(isStopKey({ ...base, ctrlKey: true })).toBe(true);
  expect(isStopKey(base)).toBe(false);
  expect(isStopKey({ ...base, metaKey: true, shiftKey: true })).toBe(false);
  expect(isStopKey({ ...base, key: ",", metaKey: true })).toBe(false);
});

test("stepTab cycles through the visible tabs and wraps", () => {
  const tabs = ["chat", "huddle", "outputs", "usage"];
  expect(stepTab(tabs, "chat", 1)).toBe("huddle");
  expect(stepTab(tabs, "usage", 1)).toBe("chat");
  expect(stepTab(tabs, "chat", -1)).toBe("usage");
  // A tab that isn't shown (e.g. Plan after its children went away) starts from the first.
  expect(stepTab(tabs, "family", 1)).toBe("chat");
  expect(stepTab([], "chat", 1)).toBeNull();
});

test("drawerTabs puts a Ticket tab first on phones only, and Family / Changes only when they apply", () => {
  expect(drawerTabs({ phone: false, family: false, changes: false })).toEqual(["chat", "huddle", "outputs", "usage"]);
  expect(drawerTabs({ phone: true, family: false, changes: false })).toEqual(["ticket", "chat", "huddle", "outputs", "usage"]);
  expect(drawerTabs({ phone: true, family: true, changes: true })).toEqual(["ticket", "chat", "family", "huddle", "changes", "outputs", "usage"]);
  // Huddle only once there is one; Usage only while opened from the cost chip.
  expect(drawerTabs({ phone: false, family: false, changes: false, huddle: false, usage: false })).toEqual(["chat", "outputs"]);
  expect(drawerTabs({ phone: false, family: false, changes: true, huddle: true, usage: true })).toEqual(["chat", "huddle", "changes", "outputs", "usage"]);
});

test("isComboKeys: ⌘ or Ctrl means hold a modifier; plain keys are not combos", () => {
  expect(isComboKeys("⌘B")).toBe(true);
  expect(isComboKeys("⌘⇧↵ after Apply")).toBe(true);
  expect(isComboKeys("Ctrl+`")).toBe(true);
  expect(isComboKeys("N")).toBe(false);
  expect(isComboKeys("↵ open · Space move")).toBe(false);
  expect(isComboKeys("Esc")).toBe(false);
});

test("hintParts splits only mixed badges", () => {
  expect(hintParts("⌘⇧↵ · R")).toEqual([{ text: "⌘⇧↵", combo: true }, { text: "R", combo: false }]);
  expect(hintParts("↵ open · D done · Space move")).toEqual([{ text: "↵ open · D done · Space move", combo: false }]);
  expect(hintParts("⌘K")).toEqual([{ text: "⌘K", combo: true }]);
});

test("isBoardPickerKey: ⌘B or Ctrl+B only", () => {
  const k = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  expect(isBoardPickerKey({ ...k, metaKey: true })).toBe(true);
  expect(isBoardPickerKey({ ...k, ctrlKey: true, key: "B" })).toBe(true);
  expect(isBoardPickerKey(k)).toBe(false);
  expect(isBoardPickerKey({ ...k, metaKey: true, shiftKey: true })).toBe(false);
  expect(isBoardPickerKey({ ...k, metaKey: true, altKey: true })).toBe(false);
  expect(isBoardPickerKey({ ...k, metaKey: true, isComposing: true })).toBe(false);
  expect(isBoardPickerKey({ ...k, metaKey: true, key: "k" })).toBe(false);
});

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing", boolean>> & { code?: string } = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });

test("panelBoardKey: plain N, ? and B only", () => {
  expect(panelBoardKey(key("n"))).toBe("new");
  expect(panelBoardKey(key("N", { shiftKey: true }))).toBe("new");
  expect(panelBoardKey(key("?", { shiftKey: true }))).toBe("shortcuts");
  expect(panelBoardKey(key("b"))).toBe("boards");
  expect(panelBoardKey(key("b", { metaKey: true }))).toBeNull();
  expect(panelBoardKey(key("n", { ctrlKey: true }))).toBeNull();
  expect(panelBoardKey(key("n", { isComposing: true }))).toBeNull();
  expect(panelBoardKey(key("e"))).toBeNull();
  expect(panelBoardKey(key("1"))).toBeNull();
});

test("cardKey: S star, M move, D done; not with modifiers or Shift", () => {
  expect(cardKey(key("s"))).toBe("star");
  expect(cardKey(key("M"))).toBe("move");
  expect(cardKey(key("d"))).toBe("done");
  expect(cardKey(key("s", { metaKey: true }))).toBeNull(); // ⌘S belongs to the browser / dialogs
  expect(cardKey(key("D", { shiftKey: true }))).toBeNull();
  expect(cardKey(key("x"))).toBeNull();
});

test("isUndoKey and isInboxKey: the plain letter only", () => {
  expect(isUndoKey(key("u"))).toBe(true);
  expect(isUndoKey(key("U"))).toBe(true);
  expect(isUndoKey(key("u", { metaKey: true }))).toBe(false);
  expect(isUndoKey(key("U", { shiftKey: true }))).toBe(false);
  expect(isInboxKey(key("i"))).toBe(true);
  expect(isInboxKey(key("i", { metaKey: true }))).toBe(false); // ⌘I switches mode in New ticket
  expect(isInboxKey(key("j"))).toBe(false);
});

test("escLeavesField: Esc in a text field nobody used yet", () => {
  const box = { tagName: "TEXTAREA" } as unknown as EventTarget;
  const btn = { tagName: "BUTTON" } as unknown as EventTarget;
  expect(escLeavesField({ key: "Escape", defaultPrevented: false, target: box })).toBe(true);
  expect(escLeavesField({ key: "Escape", defaultPrevented: true, target: box })).toBe(false); // the box cancelled something itself
  expect(escLeavesField({ key: "Escape", isComposing: true, defaultPrevented: false, target: box })).toBe(false);
  expect(escLeavesField({ key: "Escape", defaultPrevented: false, target: btn })).toBe(false);
  expect(escLeavesField({ key: "Enter", defaultPrevented: false, target: box })).toBe(false);
});

test("inDock: true only inside the bottom panel or the side chat", () => {
  // A tiny closest(): matches when one of the selector's parts is the element's class.
  const at = (cls: string | null) => ({ target: { closest: (sel: string) => (cls && sel.split(",").map((s) => s.trim()).includes(cls) ? {} : null) } as unknown as EventTarget });
  expect(inDock(at(".dock"))).toBe(true);
  expect(inDock(at(".side-chat"))).toBe(true);
  expect(inDock(at(".board"))).toBe(false);
  expect(inDock(at(null))).toBe(false);
  expect(inDock({ target: null })).toBe(false);
});

test("stepIndex clamps at the ends and starts from the right end with nothing picked", () => {
  expect(stepIndex(3, 0, 1)).toBe(1);
  expect(stepIndex(3, 2, 1)).toBe(2);
  expect(stepIndex(3, 0, -1)).toBe(0);
  expect(stepIndex(3, -1, 1)).toBe(0);
  expect(stepIndex(3, -1, -1)).toBe(2);
  expect(stepIndex(0, 0, 1)).toBe(-1);
});

test("listKey: arrows and J/K move, Enter picks the active row, digits pick by number", () => {
  expect(listKey(key("ArrowDown"))).toEqual({ move: 1 });
  expect(listKey(key("k"))).toEqual({ move: -1 });
  expect(listKey(key("Enter"))).toEqual({ pick: "active" });
  expect(listKey(key("3", { code: "Digit3" }))).toEqual({ pick: 2 });
  expect(listKey(key("Enter", { metaKey: true }))).toBeNull();
  expect(listKey(key("x"))).toBeNull();
});
