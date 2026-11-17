
const CK = (window[Symbol.for("ckanban.refs")] ??= { n: 0, map: new Map(), back: new WeakMap() });
const ckEl = (ref, sel) => {
  if (ref) {
    const w = CK.map.get(ref); const el = w && w.deref();
    if (!el || !el.isConnected) throw new Error("ref " + ref + " is gone from the page: take a new browser_snapshot");
    return el;
  }
  if (!sel) throw new Error("give ref (from browser_snapshot) or selector");
  const el = document.querySelector(sel);
  if (!el) throw new Error("nothing on the page matches " + sel);
  return el;
};