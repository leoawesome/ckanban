import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribe } from "./api";
import {
  checkedText, chipText, contextRows, percentText, phoneRows, shortPath, tokenText, type ContextReport, type ContextRow, type ContextView,
} from "./contextText";
import { CloseIcon } from "./icons";
import { useLayer } from "./layers";
import { MenuSheet } from "./MenuSheet";
import { useNow } from "./useNow";
import { usePhone } from "./usePhone";

/**
 * The chat footer's Context chip ("N% used", "Context" before the first check) and its panel: how full Claude's memory
 * for this chat is and what fills it (Claude Code's `/context`, run by the daemon on a throwaway copy of the chat).
 * A popover on desktop, a bottom sheet on a phone. It loads the last result when shown and checks only when opened
 * without one, or on Refresh; the daemon refreshes it after each run of a chat that was checked. Whatever happens
 * here, the chat keeps working: every failure stays inside the panel.
 * openRequest: a Date.now() stamp; a new one opens the panel from elsewhere (the ticket ⋯ menu, the old-chat line).
 */
export function ContextChip({ slug, kind, id, openRequest = 0 }: { slug: string; kind: "ticket" | "chat"; id: string; openRequest?: number }) {
  const [view, setView] = useState<ContextView | null>(null);
  const [busy, setBusy] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const phone = usePhone();
  const key = `${kind}/${slug}/${id}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const fetchView = useCallback((check: boolean) =>
    kind === "ticket" ? api.ticketContext(slug, id, check) : api.chatContext(slug, id, check), [kind, slug, id]);

  const load = useCallback(() => {
    const k = key;
    fetchView(false).then((v) => {
      if (keyRef.current === k) setView(v);
    }).catch(() => {});
  }, [fetchView, key]);

  const check = useCallback(() => {
    const k = key;
    setBusy(true);
    setNetError(null);
    fetchView(true).then((v) => {
      if (keyRef.current === k) setView(v);
    }).catch((e) => {
      if (keyRef.current === k) setNetError((e as Error).message || "Couldn't reach the board.");
    }).finally(() => {
      if (keyRef.current === k) setBusy(false);
    });
  }, [fetchView, key]);

  useEffect(() => {
    setView(null);
    setNetError(null);
    setBusy(false);
    load();
  }, [load]);
  // A check finished (this tab's, another tab's, or the one after a run ended).
  useEffect(() => subscribe((e) => {
    if (e.type === "context.updated" && e.profile === slug && e.kind === kind && e.id === id) load();
  }), [slug, kind, id, load]);

  const running = busy || view?.state === "running";
  // Opened without a result: check once (never on render, only when the panel is open).
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!open) {
      autoChecked.current = false;
      return;
    }
    if (autoChecked.current || !view || view.state === "none" || view.result || view.error || running) return;
    autoChecked.current = true;
    check();
  }, [open, view, running, check]);

  // A request from elsewhere is a timestamp: a new one opens the panel, also one made just before this chip mounted
  // (the ⋯ menu switches to the Chat tab first).
  const handled = useRef(openRequest && Date.now() - openRequest < 2000 ? 0 : openRequest);
  useEffect(() => {
    if (!openRequest || openRequest === handled.current) return;
    handled.current = openRequest;
    setOpen(true);
  }, [openRequest]);

  useLayer(() => {
    setOpen(false);
    chip.current?.focus();
  }, { active: open });
  useEffect(() => {
    if (!open || phone) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, phone]);

  const report = view?.result?.report ?? null;
  const pct = report ? Math.min(100, Math.max(0, report.percent)) : 0;
  return (
    <div className="ctx" ref={root}>
      {/* A small ring filled to the share used, then "34%" ("Context" before the first check); accent when nearly full. */}
      <button ref={chip} className={`ctx-chip${pct >= 80 ? " warn" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={report ? `Context: ${chipText(view)} used. Show what fills it` : "Context: show how much Claude is holding in mind"}
        title={report ? `Claude is holding ${tokenText(report.used)} of ${tokenText(report.window)} in mind for this chat` : "How much Claude is holding in mind for this chat"}
        onClick={() => setOpen((v) => !v)}>
        <span className="ctx-ring" aria-hidden style={{ "--p": pct } as React.CSSProperties} />
        {chipText(view)}
      </button>
      {open && (
        <MenuSheet onClose={() => setOpen(false)}>
          <div className="ctx-pop" role="dialog" aria-label="How much Claude is holding in mind">
            <h3>
              <span>How much Claude is holding in mind</span>
              {!phone && <button className="icon-btn ctx-close" aria-label="Close" onClick={() => setOpen(false)}><CloseIcon size={14} /></button>}
            </h3>
            <ContextBody view={view} running={running} netError={netError} phone={phone} onCheck={check} />
          </div>
        </MenuSheet>
      )}
    </div>
  );
}

function ContextBody({ view, running, netError, phone, onCheck }: { view: ContextView | null; running: boolean; netError: string | null; phone: boolean; onCheck: () => void }) {
  const now = useNow();
  if (!view && !netError) return <p className="muted small">Loading…</p>;
  if (view?.state === "none") return <p className="muted small">No chat yet. Once Claude has replied here, this shows how much of its memory the chat fills.</p>;
  const error = netError ?? view?.error ?? null;
  const result = view?.result ?? null;
  return (
    <>
      {error && (
        <div className="ctx-error" role="alert">
          <span>Couldn't check: {error}</span>
          <button className="btn small" onClick={onCheck} disabled={running}>{running ? "Checking…" : "Retry"}</button>
        </div>
      )}
      {!result && running && <p className="muted small ctx-loading"><span className="spinner" /> Checking… this takes a few seconds.</p>}
      {result && <ContextNumbers report={result.report} phone={phone} />}
      {result && (
        <div className="ctx-when">
          <span title={new Date(result.checkedAt).toLocaleString()}>{checkedText(result.checkedAt, now)}</span>
          <button className="link-btn" onClick={onCheck} disabled={running}>{running ? "Checking…" : "Refresh"}</button>
        </div>
      )}
    </>
  );
}

function ContextNumbers({ report, phone }: { report: ContextReport; phone: boolean }) {
  const all = contextRows(report.categories);
  const rows = phone ? phoneRows(all) : all;
  const used = rows.filter((r) => !r.deferred);
  const onDemand = rows.filter((r) => r.deferred);
  const share = (r: ContextRow) => (report.window ? (r.tokens / report.window) * 100 : r.percent ?? 0);
  const toolCount = report.mcpServers.reduce((s, x) => s + x.tools.length, 0);
  return (
    <>
      <div className="ctx-top"><b>{Math.round(report.percent)}% used</b><span className="ctx-n">{tokenText(report.used)} / {tokenText(report.window)}</span></div>
      <div className="ctx-bar" aria-hidden>
        {used.filter((r) => !r.free && r.tokens > 0).map((r) => <i key={r.key} style={{ width: `${share(r)}%`, background: r.color }} />)}
      </div>
      {used.map((r) => <Row key={r.key} r={r} phone={phone} />)}
      {onDemand.length > 0 && <div className="ctx-sep" />}
      {onDemand.map((r) => <Row key={r.key} r={r} phone={phone} />)}
      {(toolCount > 0 || report.memoryFiles.length > 0) && <div className="ctx-sep" />}
      {toolCount > 0 && (
        <details className="ctx-list">
          <summary><span>Connected app tools</span><span className="ctx-n">{toolCount}</span></summary>
          <div className="ctx-sub">
            {report.mcpServers.map((s) => (
              <div key={s.server}>
                <div className="ctx-group"><span>{s.server}</span><span className="ctx-n">{tokenText(s.tokens)}</span></div>
                {[...s.tools].sort((a, b) => b.tokens - a.tokens).map((t) => (
                  <div key={t.name} className="ctx-item"><span>{t.name}</span><span className="ctx-n">{tokenText(t.tokens)}</span></div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
      {report.memoryFiles.length > 0 && (
        <details className="ctx-list">
          <summary><span>Memory files</span><span className="ctx-n">{report.memoryFiles.length}</span></summary>
          <div className="ctx-sub">
            {report.memoryFiles.map((f) => (
              <div key={f.path} className="ctx-item" title={`${f.path}${f.type ? ` (${f.type})` : ""}`}>
                <span>{shortPath(f.path)}</span><span className="ctx-n">{tokenText(f.tokens)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function Row({ r, phone }: { r: ContextRow; phone: boolean }) {
  return (
    <div className={`ctx-row${r.deferred ? " deferred" : ""}`}>
      <i className={`ctx-sw${r.free ? " free" : ""}`} style={r.free ? undefined : { background: r.color }} />
      <span className={phone ? undefined : "ctx-label"} title={phone ? undefined : r.title}>{r.label}</span>
      <span className="ctx-n">{tokenText(r.tokens)}</span>
      <span className="ctx-n">{percentText(r.percent)}</span>
      {phone && r.hint && <span className="ctx-hint">{r.hint}</span>}
    </div>
  );
}
