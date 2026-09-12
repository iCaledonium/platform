#!/usr/bin/env bash
# verify.sh — compare the host's live anima-* tooling against this repo copy.
#
# Exit 0 = every tracked file is installed and byte-identical.
# Exit 1 = something is MISSING or has DRIFTED. Both are worth a look:
#   MISSING -> the live file was deleted or renamed away (this is what happened
#              on 2026-09-11: an unrelated Mac-side tool called "anima-watch"
#              was installed over the Python fault watcher on both hosts, then
#              the revert deleted the path instead of restoring it).
#   DRIFT   -> the live file was edited without the repo copy being refreshed.
#              That is legitimate and routine (fault-triage adds classification
#              signatures to anima-watch), but the edit is then UNVERSIONED
#              again. Refresh the repo copy: ./snapshot.sh
#
# Read-only. Touches nothing.
set -uo pipefail
cd "$(dirname "$0")"

dest_for() {
  case "$1" in
    systemd/*) echo "/etc/systemd/system/${1#systemd/}" ;;
    *)         echo "/usr/local/bin/$1" ;;
  esac
}

rc=0
while read -r want name; do
  [ -n "${name:-}" ] || continue
  dest="$(dest_for "$name")"
  if [ ! -e "$dest" ]; then
    printf 'MISSING  %-34s (no file at %s)\n' "$name" "$dest"; rc=1; continue
  fi
  got="$(sha256sum "$dest" | awk '{print $1}')"
  if [ "$got" = "$want" ]; then
    printf 'OK       %-34s %s\n' "$name" "$dest"
  else
    printf 'DRIFT    %-34s %s\n' "$name" "$dest"
    printf '         repo %s\n         live %s\n' "$want" "$got"; rc=1
  fi
done < MANIFEST.sha256

if [ "$rc" = 0 ]; then echo "all tracked files match the repo copy"
else echo "MISMATCH — see above. ./install.sh restores repo -> host; ./snapshot.sh records host -> repo."; fi
exit $rc
