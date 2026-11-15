# huddle

Huddles: a shared message room where several headless Claude sessions work on one ticket. The `Huddles` class (`huddle.ts`) keeps the fields, constructor and reading; its other methods live by topic in `huddle-*.ts` (presets-api, templates-api, changing, auto, handin, messages, routing, agents, lifecycle) as functions with `this: Huddles`, and `huddle-types.ts` holds the shared types, limits and helpers.
Around it: the roster and handles (`huddle-roster.ts`), participant sessions (`huddle-session.ts`), teammate presets, templates and role notes (`huddle-presets.ts`, `huddle-templates.ts`, `huddle-notes.ts`), helpers' own copies of the folder (`huddle-copies.ts`, `output-copies.ts`), usage (`huddle-usage.ts`), squads (`squad.ts`), teammate proposals (`teammate-proposal.ts`) and the plan file a plan review reads (`plan-review-file.ts`).
Tests sit next to the code (`*.test.ts`); tests that boot the server are in `test/`.
