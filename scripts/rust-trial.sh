#!/bin/bash
# Rust trial switch: run the board on the Rust front server (ckanban-rs, which starts the Bun daemon behind it) or go
# back to the Bun daemon alone.
#
#   scripts/rust-trial.sh on     build ckanban-rs if needed, back up the launchd file, point it at `ckanban-rs dev`, reload
#   scripts/rust-trial.sh off    put the backed-up launchd file back and reload (works even if `on` stopped half way)
#   scripts/rust-trial.sh board  the Rust board (docs/rust-port-board-plan.md 3.1): write <data>/rust-board, then
#                                restart once runs finish (`on` first, in one reload, if the front isn't installed yet)
#
# `on` and `off` also remove <data>/rust-board: the board goes back to Bun (front mode, or Bun alone).
#
# Run it from Terminal, not from a board chat: switching restarts the board, which would cut off that chat's run, so
# `on` and `off` refuse while board runs are active. `board` waits for them instead (the board's own restart).
#
# Settings (for testing on a throwaway launchd job; the defaults are the real ones from src/cli/launchd.ts):
#   CKANBAN_TRIAL_PLIST      the launchd file    (default ~/Library/LaunchAgents/io.ckanban.daemon.plist)
#   CKANBAN_TRIAL_LABEL      the launchd label   (default io.ckanban.daemon)
#   CKANBAN_TRIAL_BIN        the ckanban-rs binary (default <board's source folder>/rust/target/release/ckanban-rs)
#   CKANBAN_TRIAL_URL        where the board answers, to check for active runs (default http://127.0.0.1:<port>)
#   CKANBAN_TRIAL_LAUNCHCTL  the launchctl command (default launchctl)
#   CKANBAN_TRIAL_CARGO      the cargo command (default ~/.cargo/bin/cargo)
#   CKANBAN_TRIAL_WAIT       seconds to wait for the board to answer after the switch (default 60; 0 skips the check)
#   CKANBAN_HOME             the board's data folder (default ~/.claude-kanban), where the rust-board file goes
set -u

ACTION="${1:-}"
PLIST="${CKANBAN_TRIAL_PLIST:-$HOME/Library/LaunchAgents/io.ckanban.daemon.plist}"
LABEL="${CKANBAN_TRIAL_LABEL:-io.ckanban.daemon}"
LAUNCHCTL="${CKANBAN_TRIAL_LAUNCHCTL:-launchctl}"
CARGO="${CKANBAN_TRIAL_CARGO:-$HOME/.cargo/bin/cargo}"
WAIT="${CKANBAN_TRIAL_WAIT:-60}"
BACKUP="$PLIST.before-rust-trial"
DOMAIN="gui/$(id -u)"
SCRIPT_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CKANBAN_HOME:-$HOME/.claude-kanban}"
SWITCH="$DATA/rust-board"

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

board_url() {
  if [ -n "${CKANBAN_TRIAL_URL:-}" ]; then printf '%s' "$CKANBAN_TRIAL_URL"; return; fi
  local port="${CKANBAN_PORT:-}"
  local config="${CKANBAN_HOME:-$HOME/.claude-kanban}/config.json"
  if [ -z "$port" ] && [ -f "$config" ]; then
    port="$(/usr/bin/plutil -extract port raw -o - "$config" 2>/dev/null || true)"
  fi
  printf 'http://127.0.0.1:%s' "${port:-7777}"
}

# Refuses while board runs are active: switching restarts the board and would cut them off.
# `check_no_runs off`: a board that doesn't answer doesn't stop going back to Bun (a failed switch looks like that).
check_no_runs() {
  local url answer waiting
  url="$(board_url)"
  if ! answer="$(curl -fsS --max-time 5 "$url/api/restart" 2>/dev/null)"; then
    if [ "${CKANBAN_TRIAL_BOARD_STOPPED:-}" = "1" ]; then return 0; fi
    if [ "${1:-}" = "off" ]; then say "The board isn't answering at $url; going back to Bun anyway."; return 0; fi
    fail "The board isn't answering at $url, so I can't check whether tasks are running. Nothing changed.
If the board is stopped on purpose, run this again with CKANBAN_TRIAL_BOARD_STOPPED=1 in front."
  fi
  waiting="$(printf '%s' "$answer" | /usr/bin/plutil -extract waiting raw -o - - 2>/dev/null || true)"
  case "$waiting" in
    ''|*[!0-9]*) fail "The board answered, but not with a count of running tasks ($answer). Nothing changed." ;;
  esac
  if [ "$waiting" != "0" ]; then
    fail "$waiting board task(s) are running right now. Switching restarts the board and would cut them off. Nothing changed.
Wait until they finish (or stop them), then run this again from Terminal."
  fi
}

reload() {
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  # bootout returns before the old job is gone; bootstrap fails until it is.
  local i=0
  while [ $i -lt 50 ] && "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; do sleep 0.1; i=$((i + 1)); done
  for _ in 1 2 3 4 5; do
    if "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

wait_for_board() {
  [ "$WAIT" = "0" ] && return 0
  local url i=0
  url="$(board_url)"
  while [ $i -lt "$WAIT" ]; do
    curl -fsS --max-time 2 "$url/api/restart" >/dev/null 2>&1 && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

json_string() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

# `on keep`: leave the rust-board file (the `board` action switches the front and the board in one reload).
on() {
  [ -f "$PLIST" ] || fail "There is no launchd file at $PLIST, so the board isn't installed to start on its own. Nothing changed.
Install it first with: ckanban install"
  # Always start from the Bun version: the backup if an earlier `on` made one, else the file as it is now.
  local source="$PLIST"
  [ -f "$BACKUP" ] && source="$BACKUP"
  /usr/bin/plutil -lint "$source" >/dev/null 2>&1 || fail "The launchd file $source can't be read. Nothing changed."
  local bun cli repo
  bun="$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$source" 2>/dev/null || true)"
  cli="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$source" 2>/dev/null || true)"
  case "$cli" in
    */src/cli.ts) repo="$(dirname "$(dirname "$cli")")" ;;
    *) fail "The board runs from the downloaded app, not from its source folder ($bun). The Rust trial needs the source folder. Nothing changed." ;;
  esac
  local bin="${CKANBAN_TRIAL_BIN:-$repo/rust/target/release/ckanban-rs}"

  if [ ! -x "$bin" ]; then
    if [ -n "${CKANBAN_TRIAL_BIN:-}" ]; then fail "The Rust server isn't at $bin. Nothing changed."; fi
    [ -f "$repo/rust/Cargo.toml" ] || fail "The Rust server isn't in $repo yet (no rust folder). Nothing changed."
    [ -x "$CARGO" ] || fail "Rust isn't installed ($CARGO is missing), so the Rust server can't be built. Nothing changed."
    say "Building the Rust server (the first build takes a few minutes)..."
    # scripts/build-rust.sh signs the build on macOS so folder access (Desktop...) sticks across builds.
    if [ -f "$repo/scripts/build-rust.sh" ]; then
      CARGO="$CARGO" /bin/bash "$repo/scripts/build-rust.sh"
    else
      (cd "$repo/rust" && "$CARGO" build --release)
    fi || fail "The Rust server didn't build (see above). Nothing changed."
    [ -x "$bin" ] || fail "The build finished but $bin is still missing. Nothing changed."
  fi

  check_no_runs

  [ "${1:-}" = "keep" ] || rm -f "$SWITCH"
  if [ ! -f "$BACKUP" ]; then
    cp -p "$PLIST" "$BACKUP" || fail "Couldn't save a copy of $PLIST. Nothing changed."
  fi
  # Same file, same env; only the command changes, plus where the Rust server finds Bun and the source folder.
  local next="$PLIST.rust-trial-new"
  cp "$BACKUP" "$next" &&
    /usr/bin/plutil -replace ProgramArguments -json "[$(json_string "$bin"),\"dev\"]" "$next" &&
    /usr/bin/plutil -replace EnvironmentVariables.CKANBAN_BUN -string "$bun" "$next" &&
    /usr/bin/plutil -replace EnvironmentVariables.CKANBAN_REPO -string "$repo" "$next" &&
    /usr/bin/plutil -lint "$next" >/dev/null &&
    mv "$next" "$PLIST"
  if [ $? -ne 0 ]; then
    rm -f "$next"
    cp -p "$BACKUP" "$PLIST"
    rm -f "$BACKUP"
    fail "Couldn't change the launchd file; it is back as it was. Nothing changed."
  fi
  if ! reload; then
    fail "The launchd file now points at the Rust server, but launchd wouldn't load it.
Go back to Bun with: $0 off"
  fi
  if ! wait_for_board; then
    fail "Switched to the Rust server, but the board didn't answer within $WAIT seconds.
Look at the board's log (daemon.log in the data folder), or go back to Bun with: $0 off"
  fi
  say "The board now runs on the Rust server ($bin). Go back to Bun any time with: $0 off"
}

off() {
  if [ ! -f "$BACKUP" ]; then
    if [ -f "$PLIST" ] && grep -q "ckanban-rs" "$PLIST"; then
      fail "The launchd file points at the Rust server but its backup is gone. Put the Bun version back with: ckanban install"
    fi
    rm -f "$SWITCH"
    say "The board already runs on Bun (no Rust trial backup at $BACKUP). Nothing to do."
    return 0
  fi
  check_no_runs off
  rm -f "$SWITCH"
  cp -p "$BACKUP" "$PLIST" || fail "Couldn't put the backup back over $PLIST. The backup is still at $BACKUP."
  if ! reload; then
    fail "The launchd file is back to Bun, but launchd wouldn't load it. Try: ckanban install
The backup is still at $BACKUP."
  fi
  rm -f "$BACKUP"
  if ! wait_for_board; then
    fail "Back on Bun, but the board didn't answer within $WAIT seconds. Look at the board's log (daemon.log in the data folder)."
  fi
  say "The board runs on Bun again."
}

board() {
  mkdir -p "$DATA" || fail "Couldn't create the data folder $DATA. Nothing changed."
  if [ ! -f "$BACKUP" ] || ! grep -q "ckanban-rs" "$PLIST" 2>/dev/null; then
    # The front isn't installed: install it with the switch already on, in one reload.
    printf 'on\n' > "$SWITCH" || fail "Couldn't write $SWITCH. Nothing changed."
    ( on keep ) || { rm -f "$SWITCH"; exit 1; }
    say "The Rust board is on. Go back to Bun's board with: $0 on   (or all the way back with: $0 off)"
    return 0
  fi
  local url answer
  url="$(board_url)"
  printf 'on\n' > "$SWITCH" || fail "Couldn't write $SWITCH. Nothing changed."
  # The board's own restart: no new run starts, active ones finish (at most 2 minutes), then launchd starts it again.
  if ! answer="$(curl -fsS --max-time 5 -X POST -H 'content-type: application/json' -d '{}' "$url/api/restart" 2>/dev/null)"; then
    fail "Wrote $SWITCH, but the board isn't answering at $url to restart. It takes effect at the board's next start
(or remove the file to cancel: rm $SWITCH)."
  fi
  say "Switching to the Rust board at the board's next idle moment ($answer). Go back to Bun's board with: $0 on"
}

case "$ACTION" in
  on) on ;;
  off) off ;;
  board) board ;;
  *) fail "Usage: $0 on|off|board   (on: run the board on the Rust server; off: back to Bun; board: the Rust board)" ;;
esac
