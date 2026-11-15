import { useLayoutEffect, useRef, useState } from "react";

/**
 * A row that scrolls sideways (the board's column tabs, Team's views): which edges have more to scroll to. Spread the
 * result on the row (`ref`, `onScroll` and `data-more-left` / `data-more-right`) and styles.css fades those edges.
 */
export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
  };
  useLayoutEffect(onScroll);
  useLayoutEffect(() => {
    window.addEventListener("resize", onScroll);
    return () => window.removeEventListener("resize", onScroll);
  }, []);
  return { ref, onScroll, "data-more-left": fade.left || undefined, "data-more-right": fade.right || undefined };
}
