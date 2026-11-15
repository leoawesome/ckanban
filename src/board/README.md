# board

Tickets and the board around them: the `Board` class (`board.ts`), creating, moving and deleting tickets, plans, families, features and main tickets, follow-ups, links, tags, attachments, snippets, recall and lessons.
`board.ts` keeps the fields, constructor and core run loop; the other methods live by topic in `board-*.ts` as functions with `this: Board`, and `board-types.ts` holds the shared types and helpers.
Tests sit next to the code (`*.test.ts`).
