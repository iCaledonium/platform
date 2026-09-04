import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Incidents ─────────────────────────────────────────────────────
//
// One board for everything every bench and every routine found. The store is
// fingerprinted (server/lab-incidents.js), so a check that fails on ninety
// nightly sweeps is ONE row seen ninety times — the occurrence count and the
// first/last-seen pair are the history, not ninety rows of it.
//
// Three statuses exist for three different truths, and conflating them is what
// makes a board like this stop being read:
//   open / acknowledged — a fault, unfixed. Auto-resolves the moment its check
//                         comes back green on a sweep.
//   known               — red BY DESIGN. Three of the encounter board's checks
//                         are deliberate standing evidence that the board CAN
//                         go red; they keep counting occurrences but stay out
//                         of the unresolved list, or the page ships permanently
//                         red and stops meaning anything.
//   wontfix             — judged and declined.

const GOLD = "rgba(201,151,58,";

const SEVERITY = {
  fail:    { label: "fail",    color: "#e0736b" },
  unknown: { label: "unknown", color: "#d9a441" },
  error:   { label: "not measured", color: "#c96fd0" },
};

const STATUS = {
  open:         { label: "open",         color: "#e0736b" },
  acknowledged: { label: "acknowledged", color: "#d9a441" },
  known:        { label: "known",        color: "rgba(255,255,255,.45)" },
  resolved:     { label: "resolved",     color: "#7fc08a" },
  wontfix:      { label: "won't fix",    color: "rgba(255,255,255,.35)" },
};

// Open/Acknowledged/Known dropped 2026-09-04 (Magnus): those three statuses
// have no row action left that sets them from this page (Acknowledge and
// Known were removed earlier; Open only ever meant "not yet touched"), so a
// filter chip for each was a control with nothing on the other end for most
// of what a person does here. Unresolved already covers open+acknowledged
// for anyone just asking "what still needs attention" - the two are still
// real statuses (a routine or the CLI can still set them) and still counted
// in the tiles above, just not each worth their own chip.
const FILTERS = [
  { key: "unresolved", label: "Unresolved" },
  { key: "resolved",   label: "Resolved" },
  { key: "wontfix",    label: "Won't fix" },
  { key: "all",        label: "All" },
];

// Two of the row actions open an inline compose box instead of firing
// immediately. "Hand to watcher" takes an optional note; "Won't fix"
// requires one — a judgment call with no reason recorded is not useful to
// whoever reads it back. There is no manual Resolve action (2026-09-04,
// Magnus): a row only reaches `resolved` two ways now — a sweep sees the
// check pass, or whoever is fixing it (a watcher session, a routine) closes
// it themselves over ssh once they have re-verified it, via
// `lab-incidents-cli.mjs status resolved --source "<bench>" --check "<name>"`
// (quote every placeholder - a bare "<bench>" is shell input redirection, not a
// placeholder, and errors as "bench: No such file or directory").
// Both are a claim someone actually re-measured, never a click made from
// habit.
const COMPOSE = {
  watcher: { label: "Note for the watcher — sent with the incident, not saved on it",
             placeholder: "anything the watcher should know before it starts",
             required: false, confirmLabel: "Send to watcher", color: GOLD + ".8)" },
  wontfix: { label: "Reason (required — saved on the incident)",
             placeholder: "why this won't be fixed",
             required: true, confirmLabel: "Won't fix", color: undefined },
};

const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function LabIncidentsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("unresolved");
  const [bench, setBench] = useState("all");
  const [benches, setBenches] = useState([]);
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState({});
  // At most one compose box open at a time: { id: incident id, kind: "watcher" | "resolve" | "wontfix" }.
  const [compose, setCompose] = useState(null);
  const [drafts, setDrafts] = useState({});

  // Every source that either RUNS (a category with a scorecard) or has FILED
  // (a routine). Built from both, because a routine has no category entry and
  // would otherwise be filterable by nothing at all; and it keeps its own
  // bench_label, so a routine names itself rather than showing a bare key.
  const sources = (() => {
    const byKey = new Map();
    for (const b of benches) byKey.set(b.key, { key: b.key, label: b.label });
    for (const i of rows || []) {
      if (!byKey.has(i.bench)) byKey.set(i.bench, { key: i.bench, label: i.bench_label || i.bench });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  })();

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/test/incidents?status=${filter}&bench=${bench}`, { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin — the API answered 401");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRows(j.incidents || []);
      setCounts(j.counts || {});
      setError("");
    } catch (e) {
      // A failed load must not leave the previous filter's rows on screen
      // pretending to be this one's.
      setRows(null);
      setError(String(e.message || e));
    } finally { setBusy(false); }
  }, [filter, bench]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/test/benches", { credentials: "include" })
      .then(r => r.json()).then(j => setBenches(Array.isArray(j.benches) ? j.benches : [])).catch(() => {});
  }, []);

  async function setStatus(id, status, note) {
    try {
      const r = await fetch(`/api/test/incidents/${id}/status`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note ? { status, note } : { status }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      load();
    } catch (e) { setError(String(e.message || e)); }
  }

  // Hand a fault to the watcher that OWNS that bench. Watchers are bound per
  // surface, so the ask is dispatched after navigating to the bench's own page
  // — dispatching it here would land it in whatever conversation the unbound
  // /lab/home panel happens to be holding.
  function handToWatcher(inc, note) {
    const page = benches.find(b => b.key === inc.bench)?.page;
    const text =
      `Incident from the Test Lab board — ${inc.bench_label || inc.bench}\n\n` +
      `Check: ${inc.check_name}\n` +
      `Scope: ${inc.scope_label || "global"}` +
      (inc.world_id ? `\nworld_id: ${inc.world_id}` : "") +
      (inc.actor_id ? `\nactor_id: ${inc.actor_id}` : "") +
      `\nSeverity: ${inc.severity} · seen ${inc.occurrences}× · first ${inc.first_seen_at} · last ${inc.last_seen_at}\n\n` +
      `Detail: ${inc.detail || "(none)"}` +
      (note ? `\n\nOperator note: ${note}` : "") +
      `\n\nDiagnose this. Read-only first: confirm the finding is real before proposing anything, ` +
      `and remember a count or a grep returning 0 indicts the query before the code.`;
    if (page) {
      navigate(page);
      setTimeout(() => window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text } })), 700);
    } else {
      window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text } }));
    }
  }

  const chip = (active) => ({
    padding: "5px 11px", borderRadius: 3, cursor: "pointer",
    fontFamily: "'DM Sans',sans-serif", fontSize: 10.5,
    background: active ? GOLD + ".14)" : "transparent",
    border: `0.5px solid ${active ? GOLD + ".4)" : "rgba(255,255,255,.12)"}`,
    color: active ? GOLD + ".95)" : "rgba(255,255,255,.5)",
  });

  const btn = (color) => ({
    padding: "4px 9px", borderRadius: 3, cursor: "pointer", background: "transparent",
    border: `0.5px solid ${color || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: 10,
    color: color || "rgba(255,255,255,.55)",
  });

  const composeKey = (id, kind) => `${id}:${kind}`;
  const draftFor = (id, kind) => drafts[composeKey(id, kind)] || "";
  const setDraft = (id, kind, text) =>
    setDrafts(d => ({ ...d, [composeKey(id, kind)]: text }));
  const toggleCompose = (id, kind) =>
    setCompose(c => (c && c.id === id && c.kind === kind) ? null : { id, kind });

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span onClick={() => navigate("/lab/home")} style={{ cursor: "pointer",
            fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>incidents</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home/testmanager")} style={btn(GOLD + ".7)")}>Test manager</button>
          <button onClick={load} style={btn()}>{busy ? "Loading…" : "Refresh"}</button>
          <button onClick={() => navigate("/lab/home")} style={btn()}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "24px 24px 80px",
        display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {Object.entries(STATUS).map(([k, s]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 20, color: s.color,
                fontFamily: "'Cormorant Garamond',Georgia,serif" }}>{counts[k] ?? 0}</span>
              <span style={{ ...label, fontSize: 9 }}>{s.label}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          {FILTERS.map(f => (
            <span key={f.key} onClick={() => setFilter(f.key)} style={chip(filter === f.key)}>{f.label}</span>
          ))}
          <span style={{ width: 12 }} />
          <span onClick={() => setBench("all")} style={chip(bench === "all")}>All sources</span>
          {sources.map(s => (
            <span key={s.key} onClick={() => setBench(s.key)} style={chip(bench === s.key)}>{s.label}</span>
          ))}
        </div>

        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 4, fontSize: 11.5,
            background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>
            The board could not be read — {error}. Nothing below is current.
          </div>
        )}

        {rows === null && !error && <span style={{ ...label }}>Reading…</span>}

        {rows && rows.length === 0 && (
          <div style={{ padding: "20px 18px", borderRadius: 5, background: "rgba(255,255,255,.02)",
            border: "0.5px solid rgba(255,255,255,.08)", fontSize: 12, color: "rgba(255,255,255,.45)", lineHeight: 1.7 }}>
            Nothing filed under this filter.
            {filter === "unresolved" && <> That is only evidence if a sweep has actually run — an empty
              board and an unrun board look identical here. Check the last run on the{" "}
              <span onClick={() => navigate("/lab/home/testmanager")}
                style={{ color: GOLD + ".9)", cursor: "pointer" }}>test manager</span>.</>}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(rows || []).map(inc => {
            const sev = SEVERITY[inc.severity] || SEVERITY.fail;
            const st = STATUS[inc.status] || STATUS.open;
            // Settled: the severity is history now, not a live verdict.
            const settled = inc.status === "resolved" || inc.status === "wontfix";
            // A sticky row is never un-stuck by a pass — that is the point of
            // known. But a red-by-design check that has GONE GREEN must not read
            // identically to one still failing. Both stamps come off the same
            // clock in the same ISO-Z format, so the later string is the later
            // observation, and the last observation is what the row means.
            const sticky = inc.status === "known" || inc.status === "wontfix";
            const greenAgain = sticky && inc.last_pass_at && inc.last_pass_at > inc.last_seen_at;
            const isOpen = !!open[inc.id];
            return (
              <div key={inc.id} style={{ padding: "12px 15px", borderRadius: 5,
                background: "rgba(255,255,255,.022)",
                borderLeft: `2px solid ${sev.color}`,
                border: "0.5px solid rgba(255,255,255,.09)",
                borderLeftWidth: 2, borderLeftColor: settled ? st.color : sev.color }}>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "baseline" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: "rgba(255,255,255,.88)" }}>{inc.check_name}</span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>
                      {inc.bench_label || inc.bench} · {inc.scope_label || "global"} · seen {inc.occurrences}×
                      {" · first "}{ago(inc.first_seen_at)}{" · last "}{ago(inc.last_seen_at)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {!settled && <span style={{ ...label, fontSize: 9, color: sev.color }}>{sev.label}</span>}
                    <span style={{ ...label, fontSize: 9, color: st.color }}>{st.label}</span>
                    {greenAgain && <span style={{ ...label, fontSize: 9, color: "#7fc08a" }}>
                      passing since {ago(inc.last_pass_at)}</span>}
                  </div>
                </div>

                <div onClick={() => setOpen(o => ({ ...o, [inc.id]: !isOpen }))}
                  style={{ marginTop: 7, fontSize: 11, lineHeight: 1.65, cursor: "pointer",
                    color: "rgba(255,255,255,.5)",
                    display: "-webkit-box", WebkitLineClamp: isOpen ? "unset" : 2,
                    WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {inc.detail || "(no detail recorded)"}
                </div>

                {isOpen && (
                  <div style={{ marginTop: 8, fontSize: 9.5, fontFamily: "ui-monospace,monospace",
                    color: "rgba(255,255,255,.3)", lineHeight: 1.7 }}>
                    <div>fingerprint {inc.fingerprint}</div>
                    <div>recorded as {sev.label}{settled ? " when it was last seen" : ""}</div>
                    <div>source {inc.source} · first seen {inc.first_seen_at} · last seen {inc.last_seen_at}</div>
                    {inc.resolved_at && <div>resolved {inc.resolved_at} by {inc.resolved_by}</div>}
                    {inc.last_pass_at && <div>last pass {inc.last_pass_at}
                      {greenAgain ? " — green at the last look" : " — it has failed since"}</div>}
                    {inc.note && <div style={{ marginTop: 5, whiteSpace: "pre-wrap" }}>note: {inc.note}</div>}
                    {inc.first_detail && inc.first_detail !== inc.detail &&
                      <div style={{ marginTop: 5, whiteSpace: "pre-wrap" }}>first detail: {inc.first_detail}</div>}
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <button onClick={() => toggleCompose(inc.id, "watcher")} style={btn(GOLD + ".8)")}>Hand to watcher</button>
                  {benches.find(b => b.key === inc.bench)?.page && (
                    <button onClick={() => navigate(benches.find(b => b.key === inc.bench).page)}
                      style={btn()}>Open bench</button>
                  )}
                  {inc.status !== "wontfix" &&
                    <button onClick={() => toggleCompose(inc.id, "wontfix")} style={btn()}>Won't fix</button>}
                  {inc.status !== "open" &&
                    <button onClick={() => setStatus(inc.id, "open")} style={btn()}>Unresolved</button>}
                </div>

                {compose && compose.id === inc.id && (() => {
                  const meta = COMPOSE[compose.kind];
                  const text = draftFor(inc.id, compose.kind);
                  const blocked = meta.required && !text.trim();
                  const confirm = () => {
                    if (blocked) return;
                    if (compose.kind === "watcher") handToWatcher(inc, text.trim());
                    else setStatus(inc.id, compose.kind === "resolve" ? "resolved" : "wontfix", text.trim() || undefined);
                    setDraft(inc.id, compose.kind, "");
                    setCompose(null);
                  };
                  return (
                    <div style={{ marginTop: 8, padding: "9px 11px", borderRadius: 4,
                      background: "rgba(255,255,255,.03)", border: "0.5px solid rgba(255,255,255,.1)" }}>
                      <div style={{ ...label, fontSize: 9, marginBottom: 6 }}>{meta.label}</div>
                      <textarea
                        autoFocus
                        value={text}
                        onChange={(e) => setDraft(inc.id, compose.kind, e.target.value)}
                        placeholder={meta.placeholder}
                        rows={2}
                        style={{ width: "100%", resize: "vertical", boxSizing: "border-box",
                          background: "rgba(0,0,0,.3)", border: "0.5px solid rgba(255,255,255,.14)",
                          borderRadius: 3, padding: "6px 8px", fontFamily: "'DM Sans',sans-serif",
                          fontSize: 11, color: "rgba(255,255,255,.85)" }}
                      />
                      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                        <button onClick={confirm} disabled={blocked}
                          style={{ ...btn(meta.color), opacity: blocked ? 0.4 : 1,
                            cursor: blocked ? "not-allowed" : "pointer" }}>{meta.confirmLabel}</button>
                        <button onClick={() => setCompose(null)} style={btn()}>Cancel</button>
                        {blocked &&
                          <span style={{ ...label, fontSize: 9, color: sev.color }}>a reason is required</span>}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 10.5, lineHeight: 1.8, color: "rgba(255,255,255,.32)",
          borderTop: "0.5px solid rgba(255,255,255,.07)", paddingTop: 14 }}>
          An incident closes on its own the moment its check comes back <em>pass</em> on a sweep.
          A check that merely <em>disappears</em> from its board is left open on purpose — its absence
          is not a fix. A board that could not be read resolves nothing and files
          “{"the bench answered"}” against itself instead, because an empty board and a clean
          board are the same shape. A <em>known</em> or <em>won't fix</em> row is sticky — no sweep
          moves it — but if its check comes back <em>pass</em> the row says so, and a person decides
          what that means.
          <br />
          There is no button for Resolved. A row gets there by a sweep seeing its check pass, or by
          whoever fixed it closing it themselves, over ssh, once they have re-verified it:{" "}
          <code style={{ color: "rgba(255,255,255,.45)" }}>
            node ~/platform/server/lab-incidents-cli.mjs status resolved --source "&lt;bench&gt;" --check "&lt;name&gt;"
          </code>
          <br />
          Routines file here over ssh:{" "}
          <code style={{ color: "rgba(255,255,255,.45)" }}>
            node ~/platform/server/lab-incidents-cli.mjs report --source routine:&lt;name&gt;
          </code>
        </div>
      </div>
    </div>
  );
}
