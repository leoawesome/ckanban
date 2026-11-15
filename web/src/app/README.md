# app

The shell of the web UI: the entry point (`main.tsx`), `App.tsx`, the header, phone navigation, command bar,
keyboard shortcuts, panel state, live events, theme, and the global `styles.css` (design tokens at the top; the style
checks in `scripts/style-scale.test.ts` read it here). Code here may import from every other folder.

`App.tsx` keeps the layout and wiring; its logic is split into `hash.ts` (URL and card focus), `appState.ts`
(constants and saved state), and the hooks `useBoardData.ts`, `useInbox.ts`, `useInboxActions.tsx`, `useCardMoves.tsx`
and `useAppKeys.ts`.
