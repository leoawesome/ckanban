# claudeSignin

Signing Claude Code back in from the board (also on a phone). `ClaudeSignInStrip` sits under the header: yellow a few
days before Claude's sign-in on the Mac runs out, red once it is signed out (only for a Claude account: an API key or
cloud provider gets no strip), red with How to fix (`ClaudeMissingSheet`) when the board can't find Claude Code at all.
Sign in opens `ClaudeSignInSheet`, three
steps (open the sign-in page, approve and copy the code, paste it and Finish sign-in). The server side is
`rust/src/outside/claude_signin.rs` (`/api/claude-signin*`, event `claude-signin.updated`): it checks the status in the
background and runs `claude auth login` on the Mac. Start, paste and cancel are for the user only. `signinText.ts`
holds the strip's words and the pasted code's check.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
