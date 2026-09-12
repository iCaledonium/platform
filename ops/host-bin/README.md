# ops/host-bin — the host's anima-* tooling, under version control

Everything in this directory is a **byte-exact copy of a file that is installed
on this host outside any repo**, plus the scripts to check and restore it.

| repo path                   | installed at                    |
|-----------------------------|---------------------------------|
| `anima-watch`               | `/usr/local/bin/anima-watch`     (0755 root:root) |
| `anima-faults`              | `/usr/local/bin/anima-faults`    (0755 root:root) |
| `systemd/*.service`, `*.timer` | `/etc/systemd/system/`        (0644 root:root) |


`MANIFEST.sha256` is the checksum of each file as installed at snapshot time.

## Why this exists

`/usr/local/bin/anima-watch` is the Python fault watcher: it follows journald
for one systemd unit, classifies faults, and writes them to
`/var/lib/anima-watch/faults.db`, which is what `anima-faults` and the Test Lab
fault-triage routine read. **Until 2026-09-11 the only copy of it in existence
was that one root-owned file on each of the two hosts.** It was in no
repository and no backup other than whatever `/tmp/anima-watch.bak-auto-*`
happened to survive.

On 2026-09-11 that bill came due. A session building an unrelated **Mac-side**
terminal-attach tool that was *also* named `anima-watch` installed it to the
same path on both Ubuntu hosts, overwriting the Python watcher. The Mac tool is
loopback-only by design, so on a server it could only exit 1 — crash-loop every
10s. The revert an hour later deleted the path on both hosts (correctly
removing the intruder) but could not restore what it had displaced, because
nothing anywhere held a copy. Result:

* `.58` fault detection was **dead for ~1h45m** (617 failed restarts). Every
  "the simulator is clean" reading in that window was an absence of
  measurement, not evidence.
* `.59` merely *looked* healthy: its process was still running the deleted
  inode from memory — working, but unrestartable, one reboot from dying
  identically.

Recovery required reconstructing the source from a stale `/tmp` backup plus the
contents of the fault database. Any reboot would have cleared `/tmp` and made
even that impossible.

## The rule

**Any edit to a file listed above is not finished until `./snapshot.sh` has
been run and the result committed.** The live file is the thing that runs; this
directory is the thing that survives.

```sh
sudo -e /usr/local/bin/anima-watch   # e.g. fault-triage adds a signature
sudo systemctl restart anima-watch
./snapshot.sh                        # host -> repo
git add ops/host-bin && git commit   # <- the step that was missing
```

## Checking

```sh
./verify.sh      # read-only: is every tracked file installed and identical?
```

`OK` for everything means the live host matches this commit. `DRIFT` means
someone edited the live file and did not snapshot it — refresh with
`./snapshot.sh`. `MISSING` means the live file is gone, which is the 2026-09-11
failure repeating.

## Recovering

```sh
./install.sh --dry-run   # show what would change
./install.sh --yes       # repo -> host (sudo; backs up anything it replaces)
sudo systemctl restart anima-watch
systemctl is-active anima-watch && anima-faults --list | head
```

`anima-watch` and `anima-faults` are **byte-identical on both hosts** (only the
unit file differs, in its `--unit` argument), so either host's copy restores the
other.

A second, reboot-surviving copy of the watcher also sits next to its database
at `/var/lib/anima-watch/anima-watch.source-<sha8>.py`, read-only. That is a
belt-and-braces copy for the case where the repo is not checked out or the
other host is unreachable; it is not a substitute for committing this
directory.

## Watch out: the name `anima-watch` is overloaded

There have been **two** different things called `anima-watch`:

1. **this one** — `/usr/local/bin/anima-watch`, Python, runs on the two Ubuntu
   servers under `anima-watch.service`, reads journald, writes `faults.db`;
2. a Mac-side `anima-watch.mjs` terminal-attach tool in the
   `anima-watcher-bridge` repo, which talked to a loopback websocket bridge.
   It was reverted on 2026-09-11 (`3cc0f33`) and is not installed anywhere now.

They are unrelated and (2) is the one that destroyed (1). If anything Mac-side
ever reclaims that name, **do not install it to `/usr/local/bin` on either
server**; `./verify.sh` will report `DRIFT` on `anima-watch` if it happens
again.
## anima-watch-sentinel — who watches the watcher

Added 2026-09-11 after the outage in which `/usr/local/bin/anima-watch` was
overwritten and then deleted on both hosts. On the simulator the unit
crash-looped 203/EXEC for ~1h45m (617 failed restarts) and nothing noticed: an
empty fault table is exactly what a healthy host looks like, so the board read
the host as clean for the whole window. On the platform the running process kept
executing the deleted inode, so the host worked but was unrestartable — quieter
still.

`anima-watch-sentinel` is a small oneshot run by `anima-watch-sentinel.timer`
every 5 minutes. It is a SEPARATE PROGRAM on purpose: pointing a second
`anima-watch` instance at `anima-watch.service` would be useless in exactly the
observed failure, because both instances exec the same binary — if that binary
is gone the self-watcher is 203/EXEC too and reports nothing.

It reports, as ordinary rows in `faults.db` (so the normal fault-triage sweep
picks them up with no new plumbing):

| category                | means                                                        |
|-------------------------|--------------------------------------------------------------|
| `watcher-unit-missing`  | `anima-watch.service` is not installed at all                |
| `watcher-down`          | the unit is not active (includes 203/EXEC crash-loops)       |
| `watcher-binary-missing`| active, but its `ExecStart` binary is gone from disk         |
| `watcher-binary-deleted`| active on a deleted inode — works now, dies on next restart  |
| `watcher-not-ingesting` | up past the grace period with no ingest watermark at all     |
| `watcher-wedged`        | alive, but its watermark trails the watched unit's journal tail |

`watcher-wedged` compares the watermark against the JOURNAL TAIL, not wall
clock, so a unit that is merely quiet is never reported.

Dry run (read-only, writes nothing): `anima-watch-sentinel --dry-run`.

The chain terminates here by design: the sentinel itself is covered by
`verify.sh`/`MANIFEST.sha256` and by `systemctl list-timers`, not by a third
watcher.
