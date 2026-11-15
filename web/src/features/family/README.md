# family

A ticket's family: parents, tasks and a main ticket's plan (`family.ts`, `FamilyTab.tsx`, `PlanPanel.tsx` for its Pause / Resume and Plan finished), and the proposal card in chat (`ProposalCard.tsx`, one ticket's new title and description or follow-up work). Main tickets with tasks are the only way to split work; the old planned tickets (Plan tab, Start plan on a plain ticket, proposed child cards) are gone. `family.ts` is pure and the server imports it, so it must stay free of React and the DOM.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
