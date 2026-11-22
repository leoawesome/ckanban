# app

The shell of the web UI: the entry point (`main.tsx`), `App.tsx`, the header, phone navigation, command bar, keyboard shortcuts, panel state, live events, theme, and the global `styles.css` (design tokens at the top; the style checks in `scripts/style-scale.test.ts` read it here). Code here may import from every other folder.
`App.tsx` keeps the layout and wiring; its logic is split into `hash.ts` (URL and card focus), `appState.ts` (constants and saved state), and the hooks `useBoardData.ts`, `useInbox.ts`, `useInboxActions.tsx`, `useCardMoves.tsx` and `useAppKeys.ts`.

`liveEvents.ts`: one live connection per browser. The tab holding the "ckanban-events" Web Lock opens `/api/events`, relays every event on a BroadcastChannel and sends a heartbeat each second; a visible tab that hears nothing for 5 s takes the lock over (`steal`), the leader lets go when the page freezes or is put away, reopens a connection that gave up, and every take-over makes each tab refetch once.
