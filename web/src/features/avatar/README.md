# avatar

The Claude avatar: its face (`AvatarFace.tsx`), the editor for its look and name (`AvatarEditor.tsx`), and the rules for its parts and moods (`avatarLook.ts`, `avatarMood.ts`). The server checks avatar files against the part lists in `avatarLook.ts`.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
