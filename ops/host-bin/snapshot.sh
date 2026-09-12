#!/usr/bin/env bash
# snapshot.sh — record the host's live anima-* tooling INTO this repo copy.
# Run this after any legitimate edit to /usr/local/bin/anima-watch (e.g. adding
# a classification signature) so the versioned copy stays current. Then commit.
# Never needs sudo: every tracked file is world-readable.
set -euo pipefail
cd "$(dirname "$0")"
while read -r _ name; do
  [ -n "${name:-}" ] || continue
  case "$name" in
    systemd/*) src="/etc/systemd/system/${name#systemd/}" ;;
    *)         src="/usr/local/bin/$name" ;;
  esac
  [ -e "$src" ] || { echo "refusing: $src does not exist (restore it first: ./install.sh)" >&2; exit 1; }
  cp "$src" "$name"; chmod 0644 "$name"
done < MANIFEST.sha256
# shellcheck disable=SC2046
sha256sum $(awk '{print $2}' MANIFEST.sha256) > MANIFEST.sha256.new
mv MANIFEST.sha256.new MANIFEST.sha256
echo "snapshot updated:"; cat MANIFEST.sha256
echo; echo "now: git add ops/host-bin && git commit"
