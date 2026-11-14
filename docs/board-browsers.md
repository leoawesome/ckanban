# Board browsers

A board browser is a Google Chrome the board starts itself, one per set of logins (for example "Fatt Interior WhatsApp" and "Personal WhatsApp"). Each keeps its own saved logins in its own folder, separate from your everyday Chrome, and works whatever Claude account you use. Tasks drive it through the board, not through the Claude in Chrome extension. Set them up in More, then Browsers.

- **Sign in / Open window** opens a normal Chrome window on your Mac. Sign in to the sites the browser is for, then close the window. The logins are saved when Chrome closes.
- **Hidden while tasks use it.** A task that uses the browser starts it without a window and closes it about 10 minutes after the last task is done.
- **Keep running** starts it with the board and starts it again if it stops (for a watcher script that needs WhatsApp open all day). Open window on such a browser shows the window; when you close the window, it goes back to running hidden.
- **Signed in, Needs sign-in, Not checked.** About every 30 seconds the board looks at the open tabs of each running board browser: their addresses and titles, and for WhatsApp Web a small check inside the page (chat list, or the QR code / "Log into WhatsApp Web" page). It never clicks, types, reloads or opens anything there. A login page means Needs sign-in, with the site. A browser that isn't running shows what the last look said and when ("checked 10 min ago"); one never looked at shows Not checked. The login signs are listed in `src/server/sign-in-signs.ts`, one place, so more can be added.
- **Logged-out alert.** When a signed-in browser shows a login page on two looks in a row (about a minute), the board sends you an urgent message on every channel you set up (phone push, ntfy, Telegram, the Mac), once per logout: "Fatt Interior WhatsApp is logged out of WhatsApp. Open More, Browsers to sign in again." Open boards show it as an urgent line too. A new alert only comes after it was signed in again.
- **Sign in from your phone.** While a running browser needs sign-in, its card in More, Browsers shows its login page live (a new picture every 3 seconds while the window is open). Scan a WhatsApp QR code from it with the phone that has that WhatsApp, or tap the picture to press buttons there and type in the box below (for "Log in with phone number"). Only you, from the board, can see or tap it; the pictures are never saved. "Open window" always opens a window on the Mac, not on the phone.
- **Log lines.** daemon.log gets a `[browsers]` line when the board starts a board browser (hidden or with a window, and why), closes one (idle, by you, window closed, quit), picks one up again after a restart, sees one stop, and when its sign-in state changes. Only the site's name is written, never page contents, full addresses or cookies.
- The board never force-quits a board browser (that loses logins). It asks Chrome to close and waits. When the board itself restarts, board browsers keep running and the board picks them up again.

## For scripts: reaching a running board browser

Scripts outside board tasks (for example a watcher that counts unread WhatsApp chats) can use a running board browser directly:

- Its folder is `~/.claude-kanban/browsers/<id>/` (the id is shown in More, Browsers, e.g. `fatt-interior-whatsapp`).
- While it runs, the file `~/.claude-kanban/browsers/<id>/DevToolsActivePort` holds the debugging port on line 1 and the browser's address path (`/devtools/browser/<uuid>`) on line 2. Chrome writes it on every start.
- **The port changes on every start.** Read the file each time; don't save the port.
- **A missing file, a port that doesn't answer, or an answer whose `webSocketDebuggerUrl` path differs from line 2 all mean "not running".** The file can stay behind after Chrome closes, so always check: `curl -s http://127.0.0.1:<port>/json/version` and compare the path. `http://127.0.0.1:<port>/json/list` lists the open tabs.
- The port only listens on this Mac (127.0.0.1). Anything on this Mac that runs as your user can read that folder and use the browser and its logins, board tasks' own commands included. So the browsers you choose per board decide which ones a task is given and told about, but they are not a lock. The board sets the folders to your user only.
- Read only, and don't close tabs or the browser from a script: tasks may be using it. Turn on Keep running if the script needs the browser all the time.
