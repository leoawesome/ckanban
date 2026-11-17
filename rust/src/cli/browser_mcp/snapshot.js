(() => {
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
const ROLES = new Set(["link","button","checkbox","radio","textbox","searchbox","combobox","tab","menuitem","menuitemcheckbox","option","switch","slider","treeitem","row","gridcell","listitem"]);
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const shown = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden") return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 || s.display === "contents"; };
const roleOf = (el) => {
  const r = el.getAttribute("role"); if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "input") { const ty = (el.type || "text").toLowerCase(); if (ty === "hidden") return null; if (["button","submit","reset","image"].includes(ty)) return "button"; if (ty === "checkbox" || ty === "radio") return ty; if (ty === "search") return "searchbox"; return "textbox"; }
  if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "img") return "img";
  if (t === "iframe") return "iframe";
  return null;
};
const nameOf = (el) => {
  const lb = el.getAttribute("aria-labelledby");
  const by = lb ? clean(lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ")) : "";
  return cut(clean(el.getAttribute("aria-label")) || by || clean(el.getAttribute("alt")) || clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder")) || clean(el.innerText) || clean(el.value), 100);
};
const refOf = (el) => { let r = CK.back.get(el); if (!r) { r = "e" + (++CK.n); CK.back.set(el, r); CK.map.set(r, new WeakRef(el)); } return r; };
const lines = []; let size = 0; let more = 0;
const add = (depth, s) => { if (size > 40000) { more++; return; } const l = "  ".repeat(Math.min(depth, 8)) + s; lines.push(l); size += l.length + 1; };
const walk = (node, depth, inside) => {
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { if (!inside) { const t = clean(c.textContent); if (t) add(depth, "- text: " + JSON.stringify(cut(t, 300))); } continue; }
    if (c.nodeType !== 1) continue;
    const el = c; const tag = el.tagName.toLowerCase();
    if (["script","style","noscript","template","svg","head"].includes(tag)) continue;
    if (!shown(el)) continue;
    const role = roleOf(el);
    const ti = el.getAttribute("tabindex");
    const act = (role && ROLES.has(role)) || (ti !== null && Number(ti) >= 0 && el !== document.body);
    if (role === "iframe") { add(depth, "- iframe " + JSON.stringify(cut(el.src || "", 80)) + " (contents not shown)"); continue; }
    if (role === "heading") { add(depth, "- heading " + JSON.stringify(nameOf(el)) + " [level=" + (tag[1] || el.getAttribute("aria-level") || "?") + "]"); continue; }
    if (role === "img") { const n = nameOf(el); if (n) add(depth, "- img " + JSON.stringify(n)); continue; }
    if (act) {
      let extra = "";
      if (role === "checkbox" || role === "radio" || role === "switch") extra += el.checked || el.getAttribute("aria-checked") === "true" ? " [checked]" : "";
      if ((role === "textbox" || role === "searchbox" || role === "combobox") && "value" in el && el.value) extra += " value=" + JSON.stringify(cut(String(el.value), 200));
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extra += " [disabled]";
      if (el.getAttribute("aria-selected") === "true") extra += " [selected]";
      add(depth, "- " + (role || "clickable") + " " + JSON.stringify(nameOf(el)) + extra + " [ref=" + refOf(el) + "]");
      walk(el, depth + 1, true);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, true);
      continue;
    }
    walk(el, depth, inside);
    if (el.shadowRoot) walk(el.shadowRoot, depth, inside);
  }
};
if (document.body) walk(document.body, 0, false);
if (more) lines.push("… " + more + " more lines cut. Scroll (browser_press_key PageDown) or use browser_evaluate for the rest.");
return lines.join("\n");
})()