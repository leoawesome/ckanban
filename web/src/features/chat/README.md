# chat

A ticket's chat with Claude. `Chat.tsx` draws the timeline and the message box; its logic lives in hooks beside it: `useChatSend.ts` (sending), `useQueuedEdits.ts` (queued messages), `useChatRewind.tsx` (rewind, undo, fork) and `useChatForms.tsx` (forms and proposal cards). `ChatParts.tsx` holds the small pieces it draws. Also here: message turns, tool rows, the Context panel and the side panels column.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
