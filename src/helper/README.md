# helper

The helper: the side call that decides when and how to tell the user something waits on them, and the channels it uses. The runner (`runner.ts`, class `HelperRunner`; constants and types in `runner-config.ts`, text helpers in `runner-text.ts`, all re-exported from `runner.ts`) wakes the helper, checks its decision (`decide.ts`) and carries it out through the core (`core.ts`).
Also here: waits and snoozes (`waits.ts`, `attention.ts`), messages and summaries (`messages.ts`, `summary.ts`, `line.ts`), settings and night hours (`settings.ts`), notifications (`notify.ts`, `channels.ts`, phone push `push.ts`, `webpush.ts`), and Telegram with its front desk (`telegram.ts`, `tg*.ts`, `frontdesk*.ts`).
Tests sit next to the code (`*.test.ts`); tests that boot the server are in `test/`.
