#!/usr/bin/env bash
# install.sh — restore repo copy -> host. This is the recovery path for
# "the fault watcher got overwritten / deleted and there is no other copy".
#
#   ./install.sh --dry-run    show what would change (default is to ask)
#   ./install.sh --yes        do it (needs sudo)
#
# Binaries land in /usr/local/bin as 0755 root:root; units in
# /etc/systemd/system as 0644 root:root followed by `systemctl daemon-reload`.
# Any file it is about to overwrite is backed up next to itself first.
set -euo pipefail
cd "$(dirname "$0")"
mode="ask"
case "${1:-}" in --dry-run) mode=dry ;; --yes|-y) mode=go ;; "") mode=ask ;;
  *) echo "usage: $0 [--dry-run|--yes]" >&2; exit 2 ;; esac

units_touched=0
plan=()
while read -r want name; do
  [ -n "${name:-}" ] || continue
  case "$name" in
    systemd/*) dest="/etc/systemd/system/${name#systemd/}"; mode_bits=0644; units_touched=1 ;;
    *)         dest="/usr/local/bin/$name";                 mode_bits=0755 ;;
  esac
  if [ -e "$dest" ] && [ "$(sha256sum "$dest" | awk '{print $1}')" = "$want" ]; then
    echo "same     $dest"; continue
  fi
  [ -e "$dest" ] && echo "REPLACE  $dest" || echo "CREATE   $dest"
  plan+=("$name|$dest|$mode_bits")
done < MANIFEST.sha256

[ "${#plan[@]}" -eq 0 ] && { echo "nothing to do."; exit 0; }
[ "$mode" = dry ] && { echo "(dry run — nothing written)"; exit 0; }
if [ "$mode" = ask ]; then
  read -r -p "apply the above? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || { echo aborted; exit 1; }
fi

for row in "${plan[@]}"; do
  IFS='|' read -r name dest bits <<<"$row"
  if [ -e "$dest" ]; then
    bak="$dest.bak-install-$(date +%s)"
    sudo cp -p "$dest" "$bak"; echo "backed up $dest -> $bak"
  fi
  sudo install -o root -g root -m "$bits" "$name" "$dest"
  echo "installed $dest"
done
[ "$units_touched" = 1 ] && { sudo systemctl daemon-reload; echo "daemon-reload done — restart the units you replaced"; }
./verify.sh
