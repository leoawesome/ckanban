# board

The board: columns and cards (`Board.tsx`, `Card.tsx`), the phone's Now list (`NowView.tsx`), new tickets and snippets, tags, Done paging and the card motion rules. `columns.ts`, `tagText.ts`, `donePaging.ts` and `proposalMatch.ts` are pure and the server imports them too, so they must stay free of React and the DOM.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
