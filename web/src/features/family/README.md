# family

A ticket's family: parents, tasks and plans (`family.ts`, `PlanPanel.tsx`, `FamilyTab.tsx`, `ProposalCard.tsx`). `family.ts` is pure and the server imports it, so it must stay free of React and the DOM.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
