# FAQ: safety, privacy and cost

Short answers to what people ask before installing ckanban. This file is the one source for these answers: the README links here and the landing page reuses them.

### Is it safe to let it run Claude on my code?

Runs use Claude Code with `--permission-mode bypassPermissions`, so Claude can run any command in the ticket's folder without asking you first. Only add folders you are happy for Claude to change. When your project has version history (git), each ticket works in its own copy of the folder, so your main folder isn't touched until you merge.

### What happens if my project has no version history?

Then the run works in the folder itself and lists every file it changed when it ends. Nothing is blocked because git, a remote or GitHub is missing.

### Where does it listen? Can other people on my network reach it?

The board runs at http://localhost:7777 and listens on `127.0.0.1` only, so other computers on your Wi-Fi can't reach it. It also turns away requests that don't use a localhost address or that come from another website, so a web page you visit can't drive it.

### How does phone access work, and who else can get in?

Phone access is off until you turn it on with `ckanban remote on` (or **⋯ → Phone access**) on the Mac. It uses `tailscale serve`, which only devices signed in to your own Tailscale network can reach (never Tailscale Funnel, never the public internet), and the board only accepts the Tailscale login that turned it on. `ckanban remote off` turns it off again, and board runs can't change it.

### Where is my data kept?

In plain files on your Mac, under `~/.claude-kanban/`: tickets, chats, run logs, schedules and settings. The copies of the folder for tickets sit next to your project in `.ckanban-worktrees/`. ckanban has no account, no server of its own and no analytics.

### What leaves my machine?

Your code and prompts go to Anthropic through your own Claude Code, the same as when you use Claude Code yourself. ckanban itself only contacts: GitHub's releases page to check for updates (at most every 6 hours), Anthropic to show your Claude plan usage in the header, and GitHub through `gh` to read and merge your pull requests.

### What is only sent when I turn it on?

Notifications to a phone go through the browser's own push service (Apple, Google or Mozilla), encrypted, and only to devices where you turned them on. A webhook or ntfy address gets a short message only if you set one. claude.ai artifacts (off by default), MCP connections you add, and bug reports (you see and can untick everything before it is filed on GitHub) also only happen when you use them.

### What does it cost?

ckanban is free and open source (MIT License). Runs use your own Claude plan or API usage, nothing on top. Each card shows what its runs cost, and huddles stop at a spending limit you set.

### Does it work without GitHub or `gh`?

Yes. `gh` is only needed for pull requests, PR checks and filing bug reports from the board. Without it, runs still finish and tell you what changed.

### How do I update?

Run `ckanban update` in a terminal; the board shows a banner when a new version is out. The download is checked against the release's checksums before it replaces the old one.

### How do I uninstall?

Run `ckanban uninstall` to stop the background service, then delete `~/.local/bin/ckanban`. If you added the board to Claude Code or Codex, run `ckanban mcp uninstall` first. Your boards stay in `~/.claude-kanban/`; delete that folder too to remove everything.
