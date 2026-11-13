import { useEffect, useState } from "react";
import { api, showTicket, subscribe, type AutomationProposal, type Pass } from "./api";
import { everyLabel, resolveProposedPass } from "./automations";
import { connectFromClaude, KeyForm, openSignIn } from "./passConnect";

/**
 * The setup chat proposed an automation (propose_automation). The card shows what it watches and the connections it
 * needs (Connect or paste a key for each one still missing); only the user's Save automation saves it. "Start Claude by
 * itself" starts ticked when Claude suggested it (proposal.autoStart): ticked saves to Ready with autoStart, so new
 * tickets start at once; unticked saves to Backlog, where they wait for the user.
 */

/** Asks the board (App.tsx) to open Automations on this automation. */
export const OPEN_AUTOMATIONS_EVENT = "ckanban:open-automations";
export const openAutomations = (loopId?: string) => window.dispatchEvent(new CustomEvent(OPEN_AUTOMATIONS_EVENT, { detail: { loopId } }));

export function AutomationCard({ slug, ticketId, uuid, proposal, saved, onOpenAutomations, onError }: {
  slug: string;
  ticketId: string;
  uuid: string;
  proposal: AutomationProposal;
  /** The automation this card saved (the ticket's automationCards), if any. */
  saved?: { loopId: string };
  onOpenAutomations?: (loopId: string) => void;
  onError: (m: string) => void;
}) {
  const [autoStart, setAutoStart] = useState(proposal.autoStart === true);
  /** What this card saved in this tab: shown at once, before the ticket update arrives. */
  const [justSaved, setJustSaved] = useState<{ loopId: string; autoStart: boolean } | null>(null);
  /** Saved earlier (or in another tab): whether it starts Claude by itself, read from the automation. */
  const [savedStarts, setSavedStarts] = useState<boolean | null>(null);
  const done = justSaved ?? saved ?? null;
  useEffect(() => {
    if (!saved || justSaved) return;
    // An automation list is small (a handful per board), so reading it whole is fine.
    api.loops(slug).then((ls) => {
      const l = ls.find((x) => x.id === saved.loopId);
      setSavedStarts(l ? l.autoStart && l.column !== "backlog" : null);
    }).catch(() => {});
  }, [slug, saved?.loopId, !!justSaved]);
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  const load = () => api.passes().then((r) => setPasses(r.passes)).catch(() => {});
  useEffect(() => {
    load();
    return subscribe((e) => {
      if (e.type === "integration.updated") load();
    });
  }, []);
  // The feature its tickets go into (partOf), by name; null: not found (saving then says why).
  const [featureTitle, setFeatureTitle] = useState<string | null>(null);
  useEffect(() => {
    if (proposal.partOf) api.ticket(slug, proposal.partOf).then((t) => setFeatureTitle(t.title)).catch(() => setFeatureTitle(null));
  }, [slug, proposal.partOf]);

  if (done) {
    const starts = justSaved ? justSaved.autoStart : savedStarts;
    const what = proposal.partOf ? "tasks" : "tickets";
    return (
      <div className="proposal applied auto-card auto-card-saved" role="status">
        <span className="proposal-tag">✓ Automation saved</span>
        <div className="proposal-title">{proposal.name}</div>
        <div className="muted small">
          Checks every {everyLabel(proposal.everyMinutes)}.
          {starts === true ? ` New ${what} start Claude by themselves.` : starts === false ? ` New ${what} wait for you to start them.` : ""}
        </div>
        {onOpenAutomations && <button className="btn ghost auto-card-open" onClick={() => onOpenAutomations(done.loopId)}>Open in Automations</button>}
      </div>
    );
  }

  const resolved = proposal.passes.map((p) => ({ p, ...resolveProposedPass(p, passes ?? [], slug) }));
  const ready = passes !== null && resolved.every((r) => r.need === null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const connect = (r: (typeof resolved)[number]) => run(`c:${r.p.name}`, async () => {
    let result: "done" | "signing_in" | "needs_key";
    if (r.p.from) {
      const server = (await api.mcp()).servers.find((s) => s.name === r.p.from);
      if (!server) throw new Error(`${r.p.from} isn't in Connections any more`);
      result = await connectFromClaude(server, r.pass);
    } else {
      const tab = window.open("about:blank", "_blank");
      try {
        const pass = r.pass ?? await api.addPass({ kind: "mcp", name: r.p.name, url: r.p.url });
        openSignIn(tab, (await api.authorizePass(pass.id)).url);
        result = "signing_in";
      } catch (e: any) {
        tab?.close();
        if (e?.code !== "no_registration") throw e;
        result = "needs_key";
      }
    }
    if (result === "needs_key") setKeyFor(r.p.name);
    if (result === "signing_in") setNote("Approve the board in the tab that just opened; this card updates when you are done.");
    await load();
  });

  const save = () => run("save", async () => {
    const ids = resolved.map((r) => r.pass!.id);
    const l = await api.createLoop(slug, {
      name: proposal.name, enabled: true, service: proposal.service, passes: ids, script: proposal.script, everyMinutes: proposal.everyMinutes,
      column: autoStart ? "ready" : "backlog", autoStart, askClaude: proposal.askClaude ?? { on: false, prompt: "" },
      instructions: proposal.instructions ?? "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}",
      ...(proposal.partOf ? { partOf: proposal.partOf } : {}),
    });
    setJustSaved({ loopId: l.id, autoStart });
    // The ticket's answer shows the saved card everywhere in this tab, even if the live connection is stalled.
    const t = await api.answerAutomationCard(slug, ticketId, uuid, l.id).catch((e) => {
      onError(`Saved, but the card couldn't be marked: ${e.message}`);
      return null;
    });
    if (t) showTicket(slug, t);
  });

  return (
    <div className="proposal auto-card">
      <span className="proposal-tag">Proposed automation</span>
      <div className="proposal-title">{proposal.name}</div>
      <div className="muted small">{proposal.summary}</div>
      <div className="auto-box">
        <div className="small">
          Checks {proposal.service} every {everyLabel(proposal.everyMinutes)}, without Claude.
          {proposal.partOf
            ? ` New items become tasks of "${featureTitle ?? proposal.partOf}" that ${autoStart ? "start Claude right away" : "wait until you or its main ticket start them"}.`
            : autoStart ? " New items become tickets in Ready that start Claude right away." : " New items become tickets in Backlog."}
          {proposal.askClaude?.on ? " Claude looks at each new item first (a little cost per new item)." : ""}
        </div>
        {resolved.length > 0 && (
          <div className="auto-passes">
            {resolved.map((r) => (
              <div key={r.p.name} className="auto-pass">
                <span>{r.p.name}</span>
                {r.need === null && <span className="badge ok">✓ connected</span>}
                {r.need === "connect" && (
                  <button className="btn small primary" disabled={!!busy} onClick={() => connect(r)}>{busy === `c:${r.p.name}` ? "Connecting…" : "Connect"}</button>
                )}
                {r.need === "key" && keyFor !== r.p.name && <button className="btn small primary" onClick={() => setKeyFor(r.p.name)}>Paste a key</button>}
                {r.need === "missing" && <span className="badge blocked">not connected: connect it in Connections</span>}
                {keyFor === r.p.name && (
                  <KeyForm name={r.p.name} claudeName={r.p.from ?? null} url={r.p.envName ? null : r.pass?.url ?? r.p.url ?? null} envName={r.p.envName} help={r.p.keyHelp} board={r.p.envName && !r.pass ? slug : undefined}
                    onCancel={() => setKeyFor(null)} onSaved={() => { setKeyFor(null); load(); }} />
                )}
              </div>
            ))}
          </div>
        )}
        <button type="button" className="link-btn small" aria-expanded={showScript} onClick={() => setShowScript((v) => !v)}>
          {showScript ? "▾" : "▸"} How it checks
        </button>
        {showScript && <pre className="mcp-raw">{proposal.script}</pre>}
      </div>
      <label className="auto-card-start">
        <input type="checkbox" checked={autoStart} disabled={!!busy} onChange={(e) => setAutoStart(e.target.checked)} />
        <span>
          <b>Start Claude by itself</b>
          <span className="muted small">Each new {proposal.partOf ? "task" : "ticket"} starts right away (each run costs a little). Untick to start them yourself.</span>
        </span>
      </label>
      {note && <div className="muted small">{note}</div>}
      <div className="proposal-actions">
        <button className="btn primary" disabled={!ready || !!busy} title={ready ? "" : "Connect what it needs first"} onClick={save}>
          {busy === "save" ? "Saving…" : "Save automation"}
        </button>
      </div>
    </div>
  );
}
