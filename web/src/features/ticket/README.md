# ticket

The open ticket. `TicketDrawer.tsx` draws the panel; its layout and widths are in `drawerLayout.ts`, small parts in `DrawerParts.tsx`, and its logic in hooks beside it: `useDrawerTabs.ts`, `useDrawerSync.ts`, `useGoTo.ts`, `usePanelKeys.ts`. Also here: the ticket menu and sheet, the description editor, questions forms, follow-ups, pull request boxes, rewind and the Tasks tab helpers. `followUp.ts` and `questionForms.ts` are pure and the server imports them.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
