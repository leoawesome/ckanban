import { Modal } from "../../components/Modal";

/**
 * How to fix "the board can't find Claude Code" (opened from the red strip): install it and sign in from Terminal,
 * then reinstall the board's service so it records where Claude is. The strip goes away by itself at the next check
 * (every 10 minutes).
 */
export function ClaudeMissingSheet({ path, onClose }: { path: string | null; onClose: () => void }) {
  return (
    <Modal title="Help the board find Claude Code" onClose={onClose} className="cs-sheet">
      <div className="cs-content">
        <p className="cs-sub">Tasks run with Claude Code on your Mac. Do these steps on the Mac.</p>
        <ol className="cs-steps">
          <li className="cs-step">
            <span className="cs-n" aria-hidden>1</span>
            <div className="cs-body">
              <b>Install Claude Code and sign in</b>
              <span className="cs-hint">
                If it isn't installed yet, install it from{" "}
                <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>. Then open Terminal and
                run <code className="cs-cmd">claude auth login</code>
              </span>
            </div>
          </li>
          <li className="cs-step">
            <span className="cs-n" aria-hidden>2</span>
            <div className="cs-body">
              <b>Let the board find it</b>
              <span className="cs-hint">
                In the same Terminal window, run <code className="cs-cmd">ckanban install</code>.
                {path && (
                  <>
                    {" "}If Terminal says it can't find ckanban, run this instead:{" "}
                    <code className="cs-cmd">{`${/\s/.test(path) ? `"${path}"` : path} install`}</code>
                  </>
                )}
              </span>
            </div>
          </li>
        </ol>
        <p className="cs-hint cs-later">The board checks again every 10 minutes. This message goes away once it finds Claude Code.</p>
        <div className="cs-actions">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
