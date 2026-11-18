// Kept apart from board.ts (no imports), so the disk banner's unit tests type-check without the browser globals.

/** `GET /api/disk`: free space on the disk of the ticket folders (kept a minute by the server). */
export interface DiskSpace {
  freeBytes: number | null;
  low: boolean;
  lowBelowBytes: number;
  checkedAt: string;
}

/** `GET`/`POST /api/disk/free-up`: Free up space (old ticket copies, then packages of finished tickets). */
export interface FreeUp {
  state: "idle" | "running" | "done";
  phase: "removing" | "trimming" | null;
  reportOnly: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  bytesFreed: number;
  foldersRemoved: number;
  foldersTrimmed: number;
  error?: string;
  alreadyRunning?: boolean;
}
