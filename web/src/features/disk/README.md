# disk

The low-disk banner: under the header on every screen while the Mac has under 10 GB free, with Free up space
(`POST /api/disk/free-up`) and its progress and result in the same line. The server reads the free space once a
minute (`GET /api/disk`, event `disk.space`); `CKANBAN_FAKE_FREE_GB` on the daemon fakes it for tests and screenshots.

Components are PascalCase `.tsx`, the rest camelCase. Unit tests sit next to their source (`*.test.ts`).
