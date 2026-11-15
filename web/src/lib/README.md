# lib

Plain helpers with no React components: the API client (`api.ts`, code in `api/`), time, mini markdown, fuzzy
search, models, drafts, links, file paths and the like. Some (`fuzzy.ts`, `models.ts`) are also imported by the
server in `src/`, so they stay free of DOM and React.

`api/`: `types/` holds the shapes the daemon sends, one file per feature (re-exported by `types/index.ts`);
`request.ts` the fetch wrapper and the live event connection; `client.ts` the `api` object. Import from `lib/api`.
