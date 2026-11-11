import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Loaded on the first PDF opened, so PDF.js stays out of the main bundle. */
let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjs ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  }).catch((e) => { pdfjs = null; throw e; });
  return pdfjs;
}

/** Widest canvas we draw, in device pixels: sharp on a phone or a retina pane without eating memory. */
const MAX_CANVAS = 2400;
/** Pages within this many view heights of the view are drawn; further away their canvas is dropped. */
const AHEAD = 1.5;

interface Size { w: number; h: number }

/** Zoom steps: 1 fits the pane's width. */
const ZOOMS = [1, 1.5, 2, 3];

/**
 * A PDF as a column of pages fitting the pane's width, with a "Page N of M" pill. PDF.js draws each page to a canvas
 * only (no text, annotation or form layer), so nothing in the file can run or link anywhere. Pages render when they
 * come near the view and are dropped again far from it, so long PDFs stay light on a phone.
 */
export function PdfView({ url, name, downloadUrl }: { url: string; name: string; downloadUrl: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  // Where the view was (as a share of the whole), so a zoom keeps the same spot in view.
  const spot = useRef<{ y: number; x: number } | null>(null);
  const zoomTo = (z: number) => {
    const el = scroller.current;
    // From fit-to-width, start at the left edge (where lines begin); once zoomed, keep the same spot.
    if (el) spot.current = { y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight, x: el.scrollWidth > el.clientWidth ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : -1 };
    setZoom(z);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const at = spot.current;
    if (!el || !at) return;
    spot.current = null;
    el.scrollTop = at.y * el.scrollHeight - el.clientHeight / 2;
    el.scrollLeft = at.x < 0 ? 0 : at.x * el.scrollWidth - el.clientWidth / 2;
  }, [zoom]);
  const zi = ZOOMS.indexOf(zoom);

  useEffect(() => {
    let gone = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setSizes([]);
    setError(null);
    setPage(1);
    setZoom(1);
    (async () => {
      const lib = await loadPdfjs();
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = new Uint8Array(await r.arrayBuffer());
      loaded = await lib.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
      if (gone) return void loaded.destroy();
      // Every page starts at the first page's shape; each takes its own when it renders.
      const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (gone) return;
      setSizes(Array.from({ length: loaded.numPages }, () => ({ w: first.width, h: first.height })));
      setDoc(loaded);
    })().catch((e) => {
      if (gone) return;
      setError(e?.name === "PasswordException" ? "This PDF is password-protected, so it can't be previewed here."
        : e?.name === "InvalidPDFException" ? "This file isn't a valid PDF, or it's damaged."
        : `Couldn't open this PDF: ${e?.message ?? e}`);
    });
    return () => { gone = true; loaded?.destroy(); };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // The page crossing the middle of the view is the current one.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
    const pages = el.querySelectorAll<HTMLElement>(".pdf-page");
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].getBoundingClientRect().bottom >= mid) { setPage(i + 1); return; }
    }
  };

  if (error) {
    return (
      <div className="pdf-note">
        <p>{error}</p>
        <a className="btn small" href={downloadUrl} download={name}>Download</a>
      </div>
    );
  }
  if (!doc) return <div className="pdf-note muted"><span className="spinner" /> Loading PDF…</div>;
  return (
    <div className="pdf-view">
      <div className={`pdf-scroll${zoom > 1 ? " zoomed" : ""}`} ref={scroller} onScroll={onScroll}>
        {width > 0 && sizes.map((s, i) => (
          <PdfPage key={i} doc={doc} n={i + 1} size={s} width={width} zoom={zoom} root={scroller}
            onSize={(size) => setSizes((all) => all.map((x, j) => (j === i ? size : x)))} />
        ))}
      </div>
      {/* In the corner, so it covers the page margin, not the text; zoom out / in beside the page count. */}
      <div className="pdf-tools">
        <button className="pdf-zoom" aria-label="Zoom out" disabled={zi <= 0} onClick={() => zoomTo(ZOOMS[zi - 1])}>−</button>
        <span className="pdf-count" aria-live="polite" title={`Page ${page} of ${doc.numPages}`}>{page} / {doc.numPages}</span>
        <button className="pdf-zoom" aria-label="Zoom in" disabled={zi >= ZOOMS.length - 1} onClick={() => zoomTo(ZOOMS[zi + 1])}>+</button>
      </div>
    </div>
  );
}

function PdfPage({ doc, n, size, width, zoom, root, onSize }: {
  doc: PDFDocumentProxy; n: number; size: Size; width: number; zoom: number; root: React.RefObject<HTMLDivElement>; onSize: (s: Size) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  // Fit the pane's width (a narrow phone pane keeps only a slim margin), but don't blow a portrait page up past a
  // readable width on a wide desktop pane; zoom scales from there.
  const cssW = Math.round(Math.max(Math.min(width - (width < 500 ? 8 : 24), 900), 80) * zoom);
  const cssH = Math.round((cssW * size.h) / size.w);

  useEffect(() => {
    const el = box.current;
    if (!el || !root.current) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: `${AHEAD * 100}% 0px`, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!near) {
      // Free the bitmap; the box keeps its height so the scroll position stays put.
      c.width = c.height = 0;
      setDrawn(false);
      return;
    }
    let task: RenderTask | null = null;
    let gone = false;
    doc.getPage(n).then((p) => {
      if (gone) return;
      const base = p.getViewport({ scale: 1 });
      if (Math.abs(base.width - size.w) > 0.5 || Math.abs(base.height - size.h) > 0.5) onSize({ w: base.width, h: base.height });
      const px = Math.min(cssW * (window.devicePixelRatio || 1), MAX_CANVAS);
      const vp = p.getViewport({ scale: px / base.width });
      const off = document.createElement("canvas");
      off.width = Math.round(vp.width);
      off.height = Math.round(vp.height);
      task = p.render({ canvasContext: off.getContext("2d")!, viewport: vp });
      return task.promise.then(() => {
        if (gone) return;
        // Drawn off-screen then copied, so a re-render at a new width never flashes blank.
        c.width = off.width;
        c.height = off.height;
        c.getContext("2d")!.drawImage(off, 0, 0);
        setDrawn(true);
      });
    }).catch((e) => {
      if (!gone && e?.name !== "RenderingCancelledException") console.warn(`PDF page ${n}:`, e);
    });
    return () => { gone = true; task?.cancel(); };
  }, [doc, n, near, cssW, size.w, size.h]);

  return (
    <div className={`pdf-page${drawn ? "" : " blank"}`} ref={box} style={{ width: cssW, height: cssH }} aria-label={`Page ${n}`}>
      <canvas ref={canvas} />
    </div>
  );
}
