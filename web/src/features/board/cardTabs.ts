/**
 * One Tab stop per board card (roving tabindex): the chips and buttons inside a card are skipped by Tab until the
 * card itself has focus. Then Tab walks into them, and Escape from one of them returns to the card (useCardTabs.ts).
 * DOM-free, so the root typecheck and tests can import it.
 */

/** Holds a control's own tabindex ("" when it had none) while the card keeps it out of the Tab order. */
const MARK = "data-card-tab";
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

type El = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
};
type Root = { querySelectorAll(selector: string): Iterable<El> | ArrayLike<El> };

/** Take every control inside `card` out of the Tab order, remembering its own tabindex. Already-skipped ones stay as they are. */
export function lockCardTabs(card: Root) {
  for (const el of Array.from(card.querySelectorAll(FOCUSABLE))) {
    if (el.hasAttribute(MARK)) continue;
    const own = el.getAttribute("tabindex");
    if (own !== null && Number(own) < 0) continue;
    el.setAttribute(MARK, own ?? "");
    el.setAttribute("tabindex", "-1");
  }
}

/** Put the controls back in the Tab order with their own tabindex. */
export function unlockCardTabs(card: Root) {
  for (const el of Array.from(card.querySelectorAll(`[${MARK}]`))) {
    const own = el.getAttribute(MARK);
    if (own) el.setAttribute("tabindex", own);
    else el.removeAttribute("tabindex");
    el.removeAttribute(MARK);
  }
}
