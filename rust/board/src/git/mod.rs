//! R6: git, copies of the folder and landing. Ports of `src/runs/git.ts` (`cmd`, `repo`), `worktree-setup.ts`
//! (`setup`), `diff.ts` (`diff`), `prstatus.ts`, `prpoller.ts` and `board/prs.ts` (`pr`), `board/share.ts` (`share`),
//! `core/files.ts` and the outputs listing of `core/store.ts` (`files`), and the git half of `board-repo.ts` and
//! `board-main.ts` (`landing`: ticket copies, merge into main, land, branch, the worktree sweep). `routes` answers the
//! read routes board mode can serve from files alone.

pub mod cmd;
pub mod repo;
pub mod diff;
pub mod ops;
pub mod pr;
pub mod setup;
pub mod files;
pub mod share;
pub mod landing;
