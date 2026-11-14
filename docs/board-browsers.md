# Board browsers

A board browser is a Google Chrome the board starts itself, one per set of logins (for example "Fatt Interior WhatsApp" and "Personal WhatsApp"). Each keeps its own saved logins in its own folder, separate from your everyday Chrome, and works whatever Claude account you use. Tasks drive it through the board, not through the Claude in Chrome extension. Set them up in More, then Browsers.

- **Sign in / Open window** opens a normal Chrome window on your Mac. Sign in to the sites the browser is for, then close the window. The logins are saved when Chrome closes.
- **Hidden while tasks use it.** A task that uses the browser starts it without a window and closes it about 10 minutes after the last task is done.
- **Keep running** starts it with the board and starts it again if it stops (for a watcher script that needs WhatsApp open all day). Open window on such a browser shows the window; when you close the window, it goes back to running hidden.
- The board never force-quits a board browser (that loses logins). It asks Chrome to close and waits. When the board itself restarts, board browsers keep running and the board picks them up again.

## For scripts: reaching a running board browser

Scripts outside board tasks (for example a watcher that counts unread WhatsApp chats) can use a running board browser directly:

- Its folder is `~/.claude-kanban/browsers/<id>/` (the id is shown in More, Browsers, e.g. `fatt-interior-whatsapp`).
- While it runs, the file `~/.claude-kanban/browsers/<id>/DevToolsActivePort` holds the debugging port on line 1 and the browser's address path (`/devtools/browser/<uuid>`) on line 2. Chrome writes it on every start.
- **The port changes on every start.** Read the file each time; don't save the port.
- **A missing file, a port that doesn't answer, or an answer whose `webSocketDebuggerUrl` path differs from line 2 all mean "not running".** The file can stay behind after Chrome closes, so always check: `curl -s http://127.0.0.1:<port>/json/version` and compare the path. `http://127.0.0.1:<port>/json/list` lists the open tabs.
- The port only listens on this Mac (127.0.0.1). Anything on this Mac that can read that folder can use the browser and its logins, so keep the folder private (the board sets it to your user only).
- Read only, and don't close tabs or the browser from a script: tasks may be using it. Turn on Keep running if the script needs the browser all the time.
