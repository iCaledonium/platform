import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Restart broker ────────────────────────────────────────────────
//
// A status window onto the always-alive daemon that runs on the local Mac
// (~/bin/anima-restart-daemon, launchd-managed — outside any Claude session,
// so it does not die with one) — this page does not run anything itself, it
// only polls what the daemon last pushed over ssh via restart-broker-cli.mjs
// into the `restart_broker` table.
//
// 2026-09-05 (Magnus): "you need two kinds of flags, one anima-platform-
// restart-flag and one anima-simulator-restart-flag... if they need both
// flags that is a third lease." One shared lease across two unrelated hosts
// was the actual bottleneck (resolution-manager runs up to 6 concurrent
// workers, all funneling into one FIFO - queue depth regularly hit 4-11 and
// workers burned their entire turn budget just waiting, several proving
// live that they never restarted anything at all). Now three independent
// leases: platform and simulator can be held at the same time by two
// different holders, and `both` is granted only the instant NEITHER
// individual lease is held (atomic all-or-nothing - never one-then-the-
// other, which is exactly how two locks deadlock) - it is for the rare fix
// that genuinely needs both services bounced together as one step.
//
// Read-only board, deliberately: the daemon administrates all three queues
// mechanically (grant the head, reclaim on TTL expiry or on evidence a
// stalled holder never actually restarted) and never reviews what a session
// is deploying — this page keeps the same posture. No pause/resume here.

const GOLD = "rgba(201,151,58,";

// granted_at comes from the Mac shell script's own `%Y-%m-%dT%H:%M:%S%z`
// (e.g. "2026-09-05T21:54:53+0100") - it already carries an explicit
// offset, unlike the resolution-manager's timestamps (bare
// toISOString() with no offset, where appending "Z" is correct). Blindly
// appending "Z" here turned "...+0100" into "...+0100Z", an invalid
// string that parsed to Invalid Date and printed "NaNd ago". Only append
// Z when the string carries no zone information at all.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;
const ago = (iso) => {
  if (!iso) return "—";
  const withZone = HAS_ZONE.test(iso) ? iso : iso + "Z";
  const ms = Date.now() - new Date(withZone).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, ms / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const inWord = (secs) => {
  if (secs == null) return "—";
  if (secs <= 0) return "overdue";
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
};

const shortId = (id) => (id ? id.slice(0, 8) : "—");

// There is no requester "name" anywhere in this data - only a Claude session
// id and a free-text reason. Most autonomous benches (behavior-watch,
// conduct-watch, signup-lab, ...) write their own name as a leading
// hyphenated slug in the reason ("behavior-watch: ...", "signup-lab world:
// control..." - note not every one uses a colon), so prefer that human-
// readable label when it's there and fall back to the short session id
// otherwise.
const BENCH_PREFIX = /^([a-z][a-z]*(?:-[a-z]+)+)\b:?/;
const requesterLabel = (entry) => {
  const m = entry?.reason ? BENCH_PREFIX.exec(entry.reason) : null;
  return m ? m[1] : shortId(entry?.session_id);
};

const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
  color: "rgba(255,255,255,.4)" };

// One lease+queue panel - platform, simulator, or both each render one of
// these against their own {lease, queue} pair.
function LeasePanel({ title, pair }) {
  const lease = pair?.lease || null;
  const queue = pair?.queue || [];
  const nowEpoch = Date.now() / 1000;
  const remaining = lease ? lease.expires_at_epoch - nowEpoch : null;
  const leaseColor = remaining != null && remaining <= 0 ? "#e0736b" : "#d9a441";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ ...label, color: GOLD + ".55)" }}>{title}</span>

      <div style={{ padding: "16px 18px", borderRadius: 6,
        background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.09)",
        borderLeft: `2px solid ${lease ? leaseColor : "rgba(255,255,255,.2)"}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 18, fontFamily: "'Cormorant Garamond',Georgia,serif",
            color: lease ? leaseColor : "rgba(255,255,255,.5)",
            textTransform: "uppercase", letterSpacing: ".08em" }}>
            {lease ? lease.service : "no lease held"}
          </span>
          {lease && <span style={{ ...label, fontSize: 9 }}>{inWord(remaining)} remaining</span>}
        </div>

        {lease ? (
          <>
            <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,255,255,.75)" }}>
              {lease.reason}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap",
              fontSize: 10, color: "rgba(255,255,255,.4)" }}>
              <span>held by {requesterLabel(lease)}</span>
              <span>granted {ago(lease.granted_at)}</span>
              <span>declared need {lease.need_seconds}s</span>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,.45)" }}>
            Nothing held — the daemon grants the queue head the moment one appears.
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...label, fontSize: 9 }}>Queue{queue.length ? ` · ${queue.length}` : ""}</span>
        {queue.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)" }}>Empty.</div>
        )}
        {queue.map((q, i) => (
          <div key={`${q.session_id}:${i}`}
            style={{ padding: "9px 11px", borderRadius: 4,
              background: "rgba(255,255,255,.02)", border: "0.5px solid rgba(255,255,255,.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.75)" }}>
                #{i + 1} · {requesterLabel(q)}
              </span>
              <span style={{ ...label, fontSize: 9 }}>needs {q.need_seconds}s</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 10.5, color: "rgba(255,255,255,.5)" }}>{q.reason}</div>
            <div style={{ marginTop: 4, fontSize: 9, color: "rgba(255,255,255,.35)" }}>
              queued {ago(q.ts)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RestartBrokerPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/test/restart-broker/status", { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin — the API answered 401");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStatus(j.status);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  // The daemon loops every 8s; a person watching this page after granting or
  // reclaiming a lease wants to see it move within a handful of seconds.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const btn = (color) => ({
    padding: "4px 9px", borderRadius: 3, cursor: "pointer", background: "transparent",
    border: `0.5px solid ${color || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: 10,
    color: color || "rgba(255,255,255,.55)",
  });

  const nowEpoch = Date.now() / 1000;
  // The daemon writes its own heartbeat every loop tick (8s) - not the
  // status push cadence, which only happens on a lease change or every
  // ~20s. A gap over ~90s (more than 10 missed ticks) means the launchd-
  // managed process itself has stopped, independent of whether the last
  // pushed status looks fine.
  const daemonAgeS = status?.daemon_heartbeat_epoch ? nowEpoch - status.daemon_heartbeat_epoch : null;
  const daemonStale = daemonAgeS == null || daemonAgeS > 90;

  const EMPTY_PAIR = { lease: null, queue: [] };

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span onClick={() => navigate("/lab/home")} style={{ cursor: "pointer",
            fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>restart broker</span>
        </div>
        <button onClick={() => navigate("/lab/home")} style={btn()}>Close</button>
      </div>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 24px 80px",
        display: "flex", flexDirection: "column", gap: 20 }}>

        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5,
            background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>
            The status could not be read — {error}.
          </div>
        )}

        {status && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "8px 14px", borderRadius: 4,
              background: daemonStale ? "rgba(224,115,107,.06)" : "rgba(127,192,138,.06)",
              border: `0.5px solid ${daemonStale ? "rgba(224,115,107,.3)" : "rgba(127,192,138,.25)"}` }}>
              <span style={{ fontSize: 11, color: daemonStale ? "#e0736b" : "#7fc08a" }}>
                {daemonStale ? "daemon not responding" : "daemon alive"}
              </span>
              <span style={{ ...label, fontSize: 9 }}>
                heartbeat {daemonAgeS != null ? `${Math.round(daemonAgeS)}s ago` : "never seen"}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
              <LeasePanel title="Platform-api" pair={status.platform || EMPTY_PAIR} />
              <LeasePanel title="Deliver-worlds (simulator)" pair={status.simulator || EMPTY_PAIR} />
              <LeasePanel title="Both (combined)" pair={status.both || EMPTY_PAIR} />
            </div>

            {(status.recent || []).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Recent activity (all three)</span>
                {status.recent.map((line, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: "rgba(255,255,255,.45)",
                    fontFamily: "ui-monospace,monospace", lineHeight: 1.6 }}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 10.5, lineHeight: 1.8, color: "rgba(255,255,255,.32)",
          borderTop: "0.5px solid rgba(255,255,255,.07)", paddingTop: 14 }}>
          Every restart of <em>deliver-worlds</em> or <em>platform-api</em> goes through one of
          three independent leases — a hook denies the systemctl call outright unless the caller
          holds the relevant one. Platform and simulator can be held at the same time by two
          different sessions; <em>both</em> exists for a fix that genuinely needs both services
          bounced together, and is granted only the instant neither individual lease is held
          (atomic, all-or-nothing — never one-then-the-other, which is how two locks deadlock). A
          session declares how long it needs (min 30s, max 1800s) when it asks; the daemon
          reclaims the instant that window is up, whether or not the holder finished, and also
          reclaims early on evidence the holder never actually restarted rather than waiting out
          the full window. This board only reports what the daemon already decided — nothing here
          can grant, reclaim, or reorder any queue.
        </div>
      </div>
    </div>
  );
}
