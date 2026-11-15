# browser

Browsers, devices and terminals the board's runs use. Board browsers, each its own Chrome with a sign-in check (`board-browsers.ts`, `sign-in-signs.ts`), the Chrome DevTools Protocol calls (`cdp.ts`), and `ckanban browser-mcp`, the stdio MCP server a run gets per board browser (`browser-mcp.ts`; started by that CLI command, never by file path).
Also: the user's named Chromes for Claude in Chrome (`chromes.ts`), shared devices only one ticket may use at a time (`devices.ts`), interactive shells on a pseudo-terminal (`shell.ts`) and which tickets are open in a terminal (`terminals.ts`).
Tests sit next to the code (`*.test.ts`); tests that boot the server are in `test/`.
