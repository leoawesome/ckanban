# core

Shared server code every feature builds on: the data folder store (`store.ts`, the main entry), shared types (`types.ts`), the event bus (`events.ts`), atomic and JSON file writes (`atomic.ts`, `json-dir.ts`), the lag guard (`lag.ts`), env and header names (`env.ts`), and small helpers (`util.ts`, `version.ts`, `locale.ts`, `files.ts`, `update.ts`, `housekeeping.ts`, `changefeed.ts`, `layers.ts`, `cpuprof.ts`).
Core depends on no feature at runtime, with one allowed exception: `store.ts` imports the small file stores of features (avatars, huddle presets/templates/notes, board tools/keys, activity digest, run log, schedule history). `types.ts` and `events.ts` import feature types only (`import type`), and pure shared helpers from `web/src` (`family`, `models`).
Unit tests sit next to the file they test (`*.test.ts`).
