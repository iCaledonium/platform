import { useEffect, useState, useCallback } from "react";

// ── Test administration ──────────────────────────────────────────────────────
//
//   TEST CASE — one assertion. Built-in (a category returns it, defined in
//               code) or authored (written here).
//   CATEGORY  — where built-in cases come from: encounter, deploy, share…
//   SUITE     — a named set of test cases AND/OR whole categories.
//   RUNNER    — runs a suite, manually or on a schedule.
//
// A category can be a member of a suite in its own right, which matters: it
// means a case added to that category later is already in the suite, instead
// of the suite quietly going stale the way a hand-picked list does.

const GOLD = "rgba(201,151,58,";
const V = { pass: "#7fc08a", fail: "#e0736b", skip: "rgba(255,255,255,.4)",
            muted: "rgba(255,255,255,.3)", unknown: "#d9a441" };

const ago = (iso) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return `in ${Math.round(-s / 60)}m`;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function LabCaseAdmin() {
  const [cases, setCases] = useState(null);
  const [suites, setSuites] = useState([]);
  const [scheduler, setScheduler] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("suites");
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("all");

  const [editing, setEditing] = useState(null);       // suite being composed
  const [pickedCases, setPickedCases] = useState(new Set());
  const [pickedCats, setPickedCats] = useState(new Set());
  const [newSuite, setNewSuite] = useState("");
  const [running, setRunning] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const [worlds, setWorlds] = useState([]);
  const [actors, setActors] = useState([]);
  const [tWorld, setTWorld] = useState("");
  const [tActor, setTActor] = useState("");
  const [uncovered, setUncovered] = useState([]);
  const [coverage, setCoverage] = useState(null);
  // key -> display name, from the same place /lab/home gets them.
  const [catLabels, setCatLabels] = useState({});
  const [cats, setCats] = useState([]);          // the managed categories
  const [newCat, setNewCat] = useState("");
  const [selected, setSelected] = useState(new Set());  // cases picked for a move
  const [moveTo, setMoveTo] = useState("");
  const [draft, setDraft] = useState(null);
  const [tryResult, setTryResult] = useState(null);

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };
  const input = { padding: "6px 9px", borderRadius: 3, background: "rgba(255,255,255,.04)",
    border: "0.5px solid rgba(255,255,255,.12)", color: "rgba(255,255,255,.85)",
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, outline: "none" };
  const btn = (c, small) => ({ padding: small ? "4px 9px" : "7px 13px", borderRadius: 3,
    cursor: "pointer", background: "transparent", border: `0.5px solid ${c || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: small ? 10 : 11, color: c || "rgba(255,255,255,.6)" });
  const chip = (on) => ({ padding: "5px 11px", borderRadius: 3, cursor: "pointer", fontSize: 10.5,
    background: on ? GOLD + ".14)" : "transparent",
    border: `0.5px solid ${on ? GOLD + ".4)" : "rgba(255,255,255,.12)"}`,
    color: on ? GOLD + ".95)" : "rgba(255,255,255,.5)" });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/test/cases", { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setCases(j.cases || []);
      const s = await fetch("/api/test/suites", { credentials: "include" }).then(x => x.json());
      setSuites(s.suites || []);
      setScheduler(s.scheduler || null);
      const b = await fetch("/api/test/benches", { credentials: "include" }).then(x => x.json()).catch(() => null);
      setCoverage(b?.coverage || null);
      setCatLabels(Object.fromEntries((b?.benches || []).map(x => [x.key, x.label])));
      const cc = await fetch("/api/test/categories", { credentials: "include" })
        .then(x => x.json()).catch(() => null);
      setCats(cc?.categories || []);
      // Derived here rather than waiting for a run: a category in no suite is
      // a gap whether or not anybody has pressed anything today.
      const covered = new Set((s.suites || []).filter(x => x.enabled)
        .flatMap(x => (x.members || []).map(m => m.source)));
      setUncovered((b?.benches || []).map(x => x.key).filter(k => !covered.has(k)));
      setErr("");
    } catch (e) { setCases(null); setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/worlds", { credentials: "include" }).then(r => r.json())
      .then(ws => setWorlds(Array.isArray(ws) ? ws : []))
      .catch(() => setWorlds([]));
  }, []);

  // Same ambient filter the category pages use: ambient people populate venues,
  // have no home and no schedule, and were never addressable.
  useEffect(() => {
    if (!tWorld) { setActors([]); return; }
    (async () => {
      try {
        const r = await fetch(`/api/worlds/${tWorld}/presence`, { credentials: "include" });
        if (!r.ok) { setActors([]); return; }
        const p = await r.json();
        const list = (Array.isArray(p?.locations) ? p.locations : []).flatMap(l => (l.actors || [])
          .filter(a => !a.is_ambient && a.actor_type !== "ambient")
          .map(a => ({ id: a.actor_id, name: a.name })));
        const seen = new Set();
        setActors(list.filter(a => !seen.has(a.id) && seen.add(a.id))
          .sort((a, b) => (a.name || "").localeCompare(b.name || "")));
      } catch { setActors([]); }
    })();
  }, [tWorld]);

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // Fall back to the key: a category the catalogue knows but /api/test/benches
  // does not is exactly the gap the coverage check reports, and showing a bare
  // key there is more honest than inventing a name for it.
  const catName = (k) => catLabels[k] || k;
  // Does this suite touch a board that needs a world? Resolved through the
  // catalogue, since a category can now draw cases from several boards.
  const SCOPED = ["encounter", "transport", "behavior"];
  const suiteNeedsWorld = (s) => (s.members || []).some(m => {
    if (m.kind === "case") return SCOPED.includes(m.source);
    const name = cats.find(x => x.id === m.source)?.name;
    return (cases || []).some(c => c.category === name && SCOPED.includes(c.source));
  });
  // Organised by what a case is ABOUT. `source` is still shown on each row,
  // because which board runs it is worth knowing and is no longer the same
  // question.
  const categories = [...new Set((cases || []).map(c => c.category).filter(Boolean))].sort();
  const countIn = (cat) => (cases || []).filter(c => c.category === cat).length;
  const shown = (cases || []).filter(c =>
    (catFilter === "all" || c.category === catFilter) &&
    (!q || c.check_name.toLowerCase().includes(q.toLowerCase())));
  const ckey = (c) => `${c.source}|${c.check_name}`;

  function compose(s) {
    setEditing(s);
    setPickedCats(new Set((s.members || []).filter(m => m.kind === "category").map(m => m.source)));
    setPickedCases(new Set((s.members || []).filter(m => m.kind === "case").map(m => `${m.source}|${m.check_name}`)));
    setTab("compose");
  }

  async function saveMembers() {
    try {
      const members = [
        ...[...pickedCats].map(source => ({ kind: "category", source })),
        ...[...pickedCases].map(k => {
          const i = k.indexOf("|");
          return { kind: "case", source: k.slice(0, i), check_name: k.slice(i + 1) };
        }),
      ];
      const j = await post(`/api/test/suites/${editing.id}/members`, { members });
      setSuites(j.suites);
      setEditing(j.suites.find(s => s.id === editing.id));
    } catch (e) { setErr(String(e.message || e)); }
  }

  async function runSuite(s) {
    setRunning(s.id); setRunResult(null); setErr("");
    try {
      const j = await post(`/api/test/suites/${s.id}/run`, {});
      setRunResult(j.result); load();
    } catch (e) { setErr(String(e.message || e)); }
    finally { setRunning(null); }
  }

  async function saveSchedule(s, patch) {
    try {
      const j = await post("/api/test/suites", { id: s.id, name: s.name,
        description: s.description, schedule_kind: s.schedule_kind,
        schedule_value: s.schedule_value, enabled: s.enabled, ...patch });
      setSuites(j.suites);
    } catch (e) { setErr(String(e.message || e)); }
  }

  const describeSchedule = (s) =>
    s.schedule_kind === "interval" ? `every ${s.schedule_value} min`
    : s.schedule_kind === "daily" ? `daily at ${s.schedule_value}`
    : "manual only";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
        {/* The order IS the hierarchy: a suite holds categories, a category
            holds test cases. Listing them as three peers hid that. */}
        <span onClick={() => setTab("suites")} style={chip(tab === "suites")}>Suites ({suites.length})</span>
        <span style={{ color: "rgba(255,255,255,.2)", fontSize: 11 }}>›</span>
        <span onClick={() => setTab("categories")} style={chip(tab === "categories")}>
          Categories ({cats.length})
        </span>
        <span style={{ color: "rgba(255,255,255,.2)", fontSize: 11 }}>›</span>
        <span onClick={() => setTab("cases")} style={chip(tab === "cases")}>
          Test cases{cases ? ` (${cases.length})` : ""}
        </span>
        <span onClick={() => { setTab("author"); setDraft({ kind: "query", op: "eq", expected: 0, probe_method: "GET" }); setTryResult(null); }}
          style={chip(tab === "author")}>Write a test case</span>
        {editing && <span onClick={() => setTab("compose")} style={chip(tab === "compose")}>
          Composing: {editing.name}</span>}
        <button onClick={load} style={{ ...btn(), marginLeft: "auto" }}>Reload</button>
      </div>

      {err && <div style={{ padding: "9px 13px", borderRadius: 4, fontSize: 11,
        background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)", color: "#e0736b" }}>{err}</div>}

      {/* ── SUITES + RUNNER ───────────────────────────────────────────────── */}
      {tab === "suites" && (
        <>
          <div style={{ display: "flex", gap: 7 }}>
            <input value={newSuite} onChange={e => setNewSuite(e.target.value)}
              placeholder="new suite — e.g. Pre-deploy checks" style={{ ...input, width: 300 }} />
            <button style={btn()} onClick={async () => {
              try { const j = await post("/api/test/suites", { name: newSuite });
                setSuites(j.suites); setNewSuite(""); } catch (e) { setErr(String(e.message || e)); }
            }}>Create suite</button>
            <button style={btn(GOLD + ".85)")} disabled={!!running}
              onClick={async () => {
                setRunning("all"); setRunResult(null); setErr("");
                try {
                  const j = await post("/api/test/suites/run-all", {});
                  setUncovered(j.uncovered || []);
                  setRunResult({ suite: `${j.results.length} suite(s)`,
                    passed: j.results.reduce((a, r) => a + (r.passed || 0), 0),
                    failed: j.results.reduce((a, r) => a + (r.failed || 0), 0),
                    skipped: j.results.reduce((a, r) => a + (r.skipped || 0), 0),
                    muted: j.results.reduce((a, r) => a + (r.muted || 0), 0), cases: [] });
                  load();
                } catch (e) { setErr(String(e.message || e)); }
                finally { setRunning(null); }
              }}>{running === "all" ? "Running…" : "Run every suite"}</button>
          </div>

          {/* Two different gaps, both of which would otherwise be silent. */}
          {coverage?.unwired?.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#e0736b" }}>
              Live scorecard routes with no entry in the catalogue: {coverage.unwired.map(catName).join(", ")}.
              Nothing can run these until they are added to BENCHES in server/lab-incidents.js.
            </div>
          )}
          {coverage?.missing?.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#c96fd0" }}>
              Catalogued but no longer served: {coverage.missing.map(catName).join(", ")}. A renamed or removed
              category would otherwise show up only as one that mysteriously never fails.
            </div>
          )}
          {uncovered.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "#d9a441" }}>
              In no suite, so nothing runs them: {uncovered.map(catName).join(", ")}.
              A category no suite covers is not a passing category.
            </div>
          )}
          {coverage && !coverage.unwired?.length && !coverage.missing?.length && !uncovered.length && (
            <div style={{ fontSize: 10.5, color: "rgba(150,210,150,.65)" }}>
              Every category on this server is catalogued and covered by a suite ({coverage.detected.length}).
            </div>
          )}

          {scheduler && (
            <div style={{ fontSize: 10.5, color: scheduler.running ? "rgba(150,210,150,.7)" : "#d9a441" }}>
              Scheduler {scheduler.running ? "running" : "NOT running"} · {scheduler.scheduled.length} suite(s) on a schedule
            </div>
          )}

          {suites.length === 0 && (
            <div style={{ fontSize: 11.5, lineHeight: 1.7, color: "rgba(255,255,255,.45)" }}>
              No suites yet. A suite is a named set of test cases and/or whole categories — put a
              category in and every case added to it later is already covered. Then run it here, or
              give it a schedule.
            </div>
          )}

          {suites.map(s => {
            const scats = s.members.filter(m => m.kind === "category");
            const cs = s.members.filter(m => m.kind === "case");
            const lr = s.last_result;
            return (
              <div key={s.id} style={{ padding: "12px 14px", borderRadius: 5,
                background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.09)",
                display: "flex", flexDirection: "column", gap: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <div>
                    <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.88)" }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 3 }}>
                      {scats.length ? `${scats.length} categor${scats.length === 1 ? "y" : "ies"}` : ""}
                      {scats.length && cs.length ? " + " : ""}
                      {cs.length ? `${cs.length} test case(s)` : ""}
                      {!scats.length && !cs.length ? "empty — measures nothing" : ""}
                      {scats.length ? ` · ${scats.map(m => cats.find(x => x.id === m.source)?.name || m.source).join(", ")}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button style={btn(GOLD + ".85)", true)} disabled={!!running}
                      onClick={() => runSuite(s)}>{running === s.id ? "Running…" : "Run"}</button>
                    <button style={btn(null, true)} onClick={() => compose(s)}>Pick cases</button>
                    <button style={btn("#e0736b", true)} onClick={async () => {
                      try { const j = await post(`/api/test/suites/${s.id}/delete`); setSuites(j.suites); }
                      catch (e) { setErr(String(e.message || e)); }
                    }}>Delete</button>
                  </div>
                </div>

                {/* the runner's schedule for this suite */}
                <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap",
                  paddingTop: 8, borderTop: "0.5px solid rgba(255,255,255,.06)" }}>
                  <span style={{ ...label, fontSize: 9 }}>runs</span>
                  <select value={s.schedule_kind} style={{ ...input, padding: "3px 6px", fontSize: 10 }}
                    onChange={e => saveSchedule(s, { schedule_kind: e.target.value,
                      schedule_value: e.target.value === "interval" ? "60" : e.target.value === "daily" ? "03:00" : null })}>
                    <option value="manual" style={{ background: "#151310" }}>manually only</option>
                    <option value="interval" style={{ background: "#151310" }}>every N minutes</option>
                    <option value="daily" style={{ background: "#151310" }}>daily at</option>
                  </select>
                  {s.schedule_kind !== "manual" && (
                    <input defaultValue={s.schedule_value || ""} style={{ ...input, width: 70, padding: "3px 6px", fontSize: 10 }}
                      placeholder={s.schedule_kind === "interval" ? "60" : "03:00"}
                      onBlur={e => saveSchedule(s, { schedule_value: e.target.value })} />
                  )}
                  {s.schedule_kind !== "manual" && (
                    <button style={btn(null, true)} onClick={() => saveSchedule(s, { enabled: !s.enabled })}>
                      {s.enabled ? "pause" : "resume"}
                    </button>
                  )}
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,.35)" }}>
                    {describeSchedule(s)} · last run {ago(s.last_run_at)}
                    {s.next_run_at && s.enabled ? ` · next ${ago(s.next_run_at)}` : ""}
                  </span>
                </div>

                {/* Run configuration: which world (and actor) the SCOPED
                    categories run against. A suite of only platform-wide
                    categories never needs one, so it is not shown. */}
                {suiteNeedsWorld(s) && (
                  <div style={{ paddingTop: 8, borderTop: "0.5px solid rgba(255,255,255,.06)" }}>
                    <div style={{ ...label, fontSize: 9, marginBottom: 6 }}>runs against</div>
                    {(s.targets || []).length === 0 && (
                      <div style={{ fontSize: 10.5, color: "#d9a441", marginBottom: 6 }}>
                        No world set — this suite's world-scoped categories cannot run and will report
                        “not measured”, which is not the same as passing.
                      </div>
                    )}
                    {(s.targets || []).map(t => (
                      <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
                        <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.7)" }}>
                          {t.label || `world ${t.world_id.slice(0, 8)}`}
                          {t.actor_id ? "" : " · no actor (world-only categories)"}
                        </span>
                        <button style={btn(null, true)} onClick={async () => {
                          try {
                            const j = await post(`/api/test/suites/${s.id}/targets`,
                              { targets: (s.targets || []).filter(x => x.id !== t.id) });
                            setSuites(j.suites);
                          } catch (e) { setErr(String(e.message || e)); }
                        }}>remove</button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      <select value={tWorld} onChange={e => setTWorld(e.target.value)}
                        style={{ ...input, padding: "3px 6px", fontSize: 10 }}>
                        <option value="" style={{ background: "#151310" }}>— world —</option>
                        {worlds.map(w => <option key={w.id} value={w.id} style={{ background: "#151310" }}>
                          {w.name}{w.status === "running" ? " · running" : ` · ${w.status}`}</option>)}
                      </select>
                      <select value={tActor} onChange={e => setTActor(e.target.value)}
                        style={{ ...input, padding: "3px 6px", fontSize: 10 }}>
                        <option value="" style={{ background: "#151310" }}>— actor (optional) —</option>
                        {actors.map(a => <option key={a.id} value={a.id} style={{ background: "#151310" }}>{a.name}</option>)}
                      </select>
                      <button style={btn(null, true)} disabled={!tWorld} onClick={async () => {
                        if (!tWorld) return;
                        const w = worlds.find(x => x.id === tWorld);
                        const a = actors.find(x => x.id === tActor);
                        try {
                          const j = await post(`/api/test/suites/${s.id}/targets`, { targets: [
                            ...(s.targets || []).map(({ id, ...rest }) => rest),
                            { world_id: tWorld, actor_id: tActor || null,
                              label: [w?.name, a?.name].filter(Boolean).join(" · ") },
                          ] });
                          setSuites(j.suites);
                        } catch (e) { setErr(String(e.message || e)); }
                      }}>add target</button>
                    </div>
                  </div>
                )}

                {lr && (
                  <div style={{ fontSize: 10.5, display: "flex", gap: 12 }}>
                    <span style={{ color: V.pass }}>{lr.passed} pass</span>
                    <span style={{ color: lr.failed ? V.fail : "rgba(255,255,255,.35)" }}>{lr.failed} fail</span>
                    <span style={{ color: "rgba(255,255,255,.35)" }}>{lr.skipped} skip</span>
                    {lr.muted ? <span style={{ color: V.muted }}>{lr.muted} muted</span> : null}
                    {lr.empty && <span style={{ color: "#d9a441" }}>empty — measured nothing</span>}
                  </div>
                )}
              </div>
            );
          })}

          {runResult && (
            <div style={{ padding: "12px 14px", borderRadius: 5, background: "rgba(255,255,255,.03)",
              border: `0.5px solid ${runResult.failed ? V.fail : V.pass}` }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.85)", marginBottom: 8 }}>
                {runResult.suite} — {runResult.passed} pass · {runResult.failed} fail · {runResult.skipped} skip
                {runResult.muted ? ` · ${runResult.muted} muted` : ""}
                {runResult.unreadable ? ` · ${runResult.unreadable} category unreadable` : ""}
              </div>
              {(runResult.cases || []).map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 9, padding: "3px 0", alignItems: "baseline" }}>
                  <span style={{ ...label, fontSize: 8.5, minWidth: 34, color: V[c.verdict] || V.unknown }}>{c.verdict}</span>
                  <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.7)" }}>{c.name}</span>
                  <span style={{ ...label, fontSize: 8 }}>{catName(c.source)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── COMPOSE ───────────────────────────────────────────────────────── */}
      {tab === "compose" && editing && (
        <>
          <div style={{ padding: "10px 13px", borderRadius: 4, fontSize: 11,
            background: GOLD + ".08)", border: `0.5px solid ${GOLD}.3)`, color: GOLD + ".95)",
            display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span><strong>{editing.name}</strong> — {pickedCats.size} categor{pickedCats.size === 1 ? "y" : "ies"} + {pickedCases.size} case(s)</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button onClick={saveMembers} style={btn(GOLD + ".8)", true)}>Save</button>
              <button onClick={() => { setEditing(null); setTab("suites"); }} style={btn(null, true)}>Done</button>
            </span>
          </div>

          <div>
            <span style={label}>Whole categories</span>
            <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", margin: "5px 0 8px", lineHeight: 1.6 }}>
              Picking a category includes every case in it — <em>and every case added to it later</em>.
              That is the difference between a suite that stays current and a hand-picked list that
              silently goes stale.
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {cats.map(cat => (
                <span key={cat.id} style={chip(pickedCats.has(cat.id))}
                  onClick={() => setPickedCats(p => { const n = new Set(p); n.has(cat.id) ? n.delete(cat.id) : n.add(cat.id); return n; })}>
                  {cat.name} ({countIn(cat.name)})
                </span>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 6 }}>
            <span style={label}>Individual test cases</span>
            <div style={{ display: "flex", gap: 7, margin: "8px 0", flexWrap: "wrap" }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="search…" style={{ ...input, width: 200 }} />
              <span onClick={() => setCatFilter("all")} style={chip(catFilter === "all")}>all</span>
              {categories.map(c => <span key={c} onClick={() => setCatFilter(c)} style={chip(catFilter === c)}>{c}</span>)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 340, overflowY: "auto" }}>
              {shown.map(c => {
                const covered = [...pickedCats].some(id => cats.find(x => x.id === id)?.name === c.category);
                return (
                  <label key={ckey(c)} style={{ display: "flex", gap: 9, alignItems: "baseline",
                    padding: "5px 8px", borderRadius: 3, cursor: covered ? "default" : "pointer",
                    background: covered ? GOLD + ".06)" : "transparent" }}>
                    <input type="checkbox" disabled={covered}
                      checked={covered || pickedCases.has(ckey(c))}
                      onChange={() => setPickedCases(p => {
                        const n = new Set(p); const k = ckey(c); n.has(k) ? n.delete(k) : n.add(k); return n; })} />
                    <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.75)" }}>{c.check_name}</span>
                    <span style={{ ...label, fontSize: 8 }}>{catName(c.source)}</span>
                    {covered && <span style={{ ...label, fontSize: 8, color: GOLD + ".8)" }}>via category</span>}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── CATEGORIES ────────────────────────────────────────────────────── */}
      {tab === "categories" && (
        <>
          <div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.45)" }}>
            A category is what a test case is <em>about</em>. It is not the board that runs it —
            that is provenance, shown on each case as its source, and the two need not stay the
            same. One category is seeded per board so nothing moves on its own; make your own and
            move cases into it from the test-case list.
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            <input value={newCat} onChange={e => setNewCat(e.target.value)}
              placeholder="new category — e.g. Security" style={{ ...input, width: 280 }} />
            <button style={btn()} onClick={async () => {
              try { const j = await post("/api/test/categories", { name: newCat });
                setCats(j.categories); setNewCat(""); } catch (e) { setErr(String(e.message || e)); }
            }}>Create category</button>
          </div>
          {cats.map(c => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 12,
              alignItems: "center", padding: "9px 12px", borderRadius: 4,
              background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.08)" }}>
              <div>
                <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.85)" }}>{c.name}</div>
                <div style={{ fontSize: 9.5, color: "rgba(255,255,255,.35)", marginTop: 3 }}>
                  {countIn(c.name)} test case(s)
                  {c.builtin_source ? ` · seeded from the ${c.builtin_source} board` : " · yours"}
                </div>
              </div>
              {!c.builtin_source && (
                <button style={btn("#e0736b", true)} onClick={async () => {
                  try { const j = await post(`/api/test/categories/${c.id}/delete`); setCats(j.categories); }
                  catch (e) { setErr(String(e.message || e)); }
                }}>Delete</button>
              )}
            </div>
          ))}
        </>
      )}

      {/* ── CATALOGUE ─────────────────────────────────────────────────────── */}
      {tab === "cases" && (
        <>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="search test cases…" style={{ ...input, width: 220 }} />
            <span onClick={() => setCatFilter("all")} style={chip(catFilter === "all")}>all categories</span>
            {categories.map(c => <span key={c} onClick={() => setCatFilter(c)} style={chip(catFilter === c)}>{c} ({countIn(c)})</span>)}
          </div>

          {cases && cases.length === 0 && (
            <div style={{ padding: "16px", borderRadius: 5, fontSize: 11.5, lineHeight: 1.7,
              background: "rgba(255,255,255,.02)", border: "0.5px solid rgba(255,255,255,.08)",
              color: "rgba(255,255,255,.45)" }}>
              The catalogue is <em>learned, not declared</em> — it fills in with whatever each category
              actually returns. Run a sweep once and every test case appears.
            </div>
          )}

          {/* Move whatever is ticked into a category — this is "add existing
              test cases", and it works for built-in and authored alike. */}
          {selected.size > 0 && (
            <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap",
              padding: "9px 12px", borderRadius: 4, background: GOLD + ".08)",
              border: `0.5px solid ${GOLD}.3)` }}>
              <span style={{ fontSize: 11, color: GOLD + ".95)" }}>{selected.size} selected — move to</span>
              <select value={moveTo} onChange={e => setMoveTo(e.target.value)}
                style={{ ...input, padding: "3px 6px", fontSize: 10 }}>
                <option value="" style={{ background: "#151310" }}>— category —</option>
                {cats.map(c => <option key={c.id} value={c.id} style={{ background: "#151310" }}>{c.name}</option>)}
              </select>
              <button style={btn(GOLD + ".8)", true)} disabled={!moveTo} onClick={async () => {
                try {
                  const picks = [...selected].map(k => {
                    const i = k.indexOf("|");
                    return { source: k.slice(0, i), check_name: k.slice(i + 1) };
                  });
                  const j = await post(`/api/test/categories/${moveTo}/assign`, { cases: picks });
                  setCases(j.cases); setSelected(new Set()); setMoveTo("");
                } catch (e) { setErr(String(e.message || e)); }
              }}>Move</button>
              <button style={btn(null, true)} onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {shown.map(c => (
              <div key={ckey(c)} style={{ padding: "9px 12px", borderRadius: 4,
                background: c.enabled ? "rgba(255,255,255,.022)" : "rgba(255,255,255,.008)",
                border: "0.5px solid rgba(255,255,255,.08)", borderLeftWidth: 2, borderLeftStyle: "solid",
                borderLeftColor: c.enabled ? (V[c.last_verdict] || "rgba(255,255,255,.15)") : "rgba(255,255,255,.12)",
                display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input type="checkbox" style={{ marginTop: 3, cursor: "pointer" }}
                  checked={selected.has(ckey(c))}
                  onChange={() => setSelected(p => {
                    const n = new Set(p); const k = ckey(c); n.has(k) ? n.delete(k) : n.add(k); return n; })} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11.5, color: c.enabled ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.35)" }}>
                      {c.check_name}</span>
                    <span style={{ ...label, fontSize: 8.5, color: GOLD + ".7)" }}>{c.category || "no category"}</span>
                    <span style={{ ...label, fontSize: 8, color: "rgba(255,255,255,.3)" }}>runs from {c.source}</span>
                    {c.authored && <span style={{ ...label, fontSize: 8.5, color: GOLD + ".8)" }}>authored</span>}
                    {!c.enabled && <span style={{ ...label, fontSize: 8.5, color: "#d9a441" }}>muted</span>}
                    {c.severity === "advisory" && <span style={{ ...label, fontSize: 8.5 }}>advisory</span>}
                    {c.last_verdict && <span style={{ ...label, fontSize: 8.5, color: V[c.last_verdict] }}>last: {c.last_verdict}</span>}
                  </div>
                  {c.last_detail && <div style={{ marginTop: 4, fontSize: 10, color: "rgba(255,255,255,.38)", lineHeight: 1.5 }}>
                    {c.last_detail.slice(0, 160)}</div>}
                </div>
                <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
                  <select value={c.severity} style={{ ...input, padding: "3px 5px", fontSize: 9.5 }}
                    onChange={async e => {
                      try { const j = await post("/api/test/cases/settings",
                        { source: c.source, check_name: c.check_name, severity: e.target.value });
                        setCases(j.cases); } catch (x) { setErr(String(x.message || x)); }
                    }}>
                    <option value="blocking" style={{ background: "#151310" }}>blocking</option>
                    <option value="advisory" style={{ background: "#151310" }}>advisory</option>
                  </select>
                  <button style={btn(null, true)} onClick={async () => {
                    try { const j = await post("/api/test/cases/settings",
                      { source: c.source, check_name: c.check_name, enabled: !c.enabled });
                      setCases(j.cases); } catch (x) { setErr(String(x.message || x)); }
                  }}>{c.enabled ? "Mute" : "Unmute"}</button>
                  {c.authored && <button style={btn("#e0736b", true)} onClick={async () => {
                    try { await post(`/api/test/cases/authored/${c.id}/delete`); load(); }
                    catch (x) { setErr(String(x.message || x)); }
                  }}>Delete</button>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── AUTHORING ─────────────────────────────────────────────────────── */}
      {tab === "author" && draft && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px",
          borderRadius: 5, background: "rgba(255,255,255,.02)", border: "0.5px solid rgba(255,255,255,.08)" }}>
          <div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.45)" }}>
            A test case asks a question and compares the answer to a number. A <strong>query</strong> runs
            SQL on a <strong>read-only</strong> connection — SQLite itself refuses anything that writes.
            A <strong>probe</strong> makes an anonymous request to a path here and compares the status.
            An authored case is <em>run</em> from the authored board, but it belongs to whichever
            category you put it in — provenance and subject are different things.
          </div>
          <input value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="what it asserts — e.g. no share names its own owner" style={input} />
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <span style={{ ...label, fontSize: 9 }}>category</span>
            <select value={draft.category_id || ""} onChange={e => setDraft({ ...draft, category_id: e.target.value })}
              style={input}>
              <option value="" style={{ background: "#151310" }}>— what is it about? —</option>
              {cats.map(c => <option key={c.id} value={c.id} style={{ background: "#151310" }}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
            <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })} style={input}>
              <option value="query" style={{ background: "#151310" }}>query</option>
              <option value="probe" style={{ background: "#151310" }}>probe</option>
            </select>
            <select value={draft.op} onChange={e => setDraft({ ...draft, op: e.target.value })} style={input}>
              {[["eq", "="], ["ne", "≠"], ["lt", "<"], ["lte", "≤"], ["gt", ">"], ["gte", "≥"]]
                .map(([k, s]) => <option key={k} value={k} style={{ background: "#151310" }}>{s}</option>)}
            </select>
            <input value={draft.expected} onChange={e => setDraft({ ...draft, expected: e.target.value })}
              style={{ ...input, width: 80 }} />
            <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)" }}>
              {draft.kind === "query" ? "← what the query returns" : "← the status the path answers"}
            </span>
          </div>
          {draft.kind === "query" ? (
            <textarea value={draft.sql || ""} onChange={e => setDraft({ ...draft, sql: e.target.value })}
              rows={4} spellCheck={false} placeholder="SELECT COUNT(*) FROM actor_shares WHERE shared_with_id = owner_id"
              style={{ ...input, fontFamily: "ui-monospace,monospace", fontSize: 10.5, resize: "vertical" }} />
          ) : (
            <div style={{ display: "flex", gap: 7 }}>
              <select value={draft.probe_method} onChange={e => setDraft({ ...draft, probe_method: e.target.value })} style={input}>
                <option style={{ background: "#151310" }}>GET</option>
                <option style={{ background: "#151310" }}>POST</option>
              </select>
              <input value={draft.probe_path || ""} onChange={e => setDraft({ ...draft, probe_path: e.target.value })}
                placeholder="/api/gallery" style={{ ...input, flex: 1 }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 7 }}>
            <button style={btn()} onClick={async () => {
              setTryResult(null);
              try { const j = await post("/api/test/cases/authored/try", draft); setTryResult(j.result); }
              catch (e) { setTryResult({ verdict: "error", detail: String(e.message || e) }); }
            }}>Try it</button>
            <button style={btn(GOLD + ".8)")} onClick={async () => {
              try { await post("/api/test/cases/authored", draft); setDraft(null); setTab("cases"); load(); }
              catch (e) { setErr(String(e.message || e)); }
            }}>Save</button>
            <button style={btn()} onClick={() => { setDraft(null); setTab("cases"); }}>Cancel</button>
          </div>
          {tryResult && (
            <div style={{ padding: "9px 12px", borderRadius: 4, fontSize: 11, lineHeight: 1.6,
              background: "rgba(255,255,255,.03)", border: `0.5px solid ${V[tryResult.verdict] || "#e0736b"}`,
              color: V[tryResult.verdict] || "#e0736b" }}>
              <strong>{tryResult.verdict}</strong> — {tryResult.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
