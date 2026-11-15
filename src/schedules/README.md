# schedules

Work the board starts by itself at a set time. Repeating schedules (`scheduler.ts`, cron parsing in `cron.ts`, the per-schedule log in `schedule-history.ts`), quiet schedules and proactive check-ins (`quiet.ts`, `checkin-guides.ts`), one-time jobs (`jobs.ts`), follow-ups where Claude comes back to its own ticket (`followup.ts`), and automations: check scripts on a timer (`loops.ts`) and the setup chat's proposal card (`automation-proposal.ts`).
The scripts these run and the services they reach live in `src/integrations/` (`script.ts`, `passes.ts`).
Tests sit next to the code (`*.test.ts`); tests that boot the server are in `test/`.
