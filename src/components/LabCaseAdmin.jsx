import { useEffect, useState, useCallback } from "react";

// ── Test-case administration ─────────────────────────────────────────────────
//
// The vocabulary, settled:
//   TEST CASE — one assertion. Either BUILT-IN (a source returns it, defined in
//               code) or AUTHORED (written here).
//   SOURCE    — where a built-in case comes from. Nine of them.
//   BOARD     — a named set of test cases you compose. A VIEW: the same case in
//               five boards is one case with one incident.
//
// The catalogue is learned, not declared — it fills in as sweeps observe what
// each source returns. So a case you add in code appears here after the next
// sweep with no registration step, and this panel says as much rather than
// showing an empty list that looks like a bug.

const GOLD = "rgba(201,151,58,";

const V = { pass: "#7fc08a", fail: "#e0736b", skip: "rgba(255,255,255,.4)",
            muted: "rgba(255,255,255,.3)", unknown: "#d9a441" };

export default function LabCaseAdmin({ onChanged }) {
  const [cases, setCases] = useState(null);
  const [boards, setBoards] = useState([]);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("cases");
  const [q, setQ] = useState("");
  const [srcFilter, setSrcFilter] = useState("all");

  // board composer
  const [activeBoard, setActiveBoard] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [newBoardName, setNewBoardName] = useState("");

  // authoring
  const [draft, setDraft] = useState(null);
  const [tryResult, setTryResult] = useState(null);

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };
  const input = { padding: "6px 9px", borderRadius: 3, background: "rgba(255,255,255,.04)",
    border: "0.5px solid rgba(255,255,255,.12)", color: "rgba(255,255,255,.85)",
    fontFamily: "'DM Sans',sans-serif", fontSize: 11, outline: "none" };
  const btn = (c, small) => ({ padding: small ? "4px 9px" : "7px 13px", borderRadius: 3,
    cursor: "pointer", background: "transparent",
    border: `0.5px solid ${c || "rgba(255,255,255,.16)"}`,
    fontFamily: "'DM Sans',sans-serif", fontSize: small ? 10 : 11,
    color: c || "rgba(255,255,255,.6)" });
  const chip = (on) => ({ padding: "5px 11px", borderRadius: 3, cursor: "pointer", fontSize: 10.5,
    background: on ? GOLD + ".14)" : "transparent",
    border: `0.5px solid ${on ? GOLD + ".4)" : "rgba(255,255,255,.12)"}`,
    color: on ? GOLD + ".95)" : "rgba(255,255,255,.5)" });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/test/cases", { credentials: "include" });
      if (r.status === 401) throw new Error("not signed in on this origin");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCases(Array.isArray(j.cases) ? j.cases : []);
      const b = await fetch("/api/test/boards", { credentials: "include" }).then(x => x.json());
      setBoards(Array.isArray(b.boards) ? b.boards : []);
      setErr("");
    } catch (e) { setCases(null); setErr(String(e.message || e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function setSetting(c, patch) {
    try {
      const j = await post("/api/test/cases/settings",
        { source: c.source, check_name: c.check_name, ...patch });
      setCases(j.cases); onChanged?.();
    } catch (e) { setErr(String(e.message || e)); }
  }

  const sources = [...new Set((cases || []).map(c => c.source))].sort();
  const shown = (cases || []).filter(c =>
    (srcFilter === "all" || c.source === srcFilter) &&
    (!q || c.check_name.toLowerCase().includes(q.toLowerCase()) || c.source.includes(q.toLowerCase())));

  const key = (c) => `${c.source}|${c.check_name}`;

  // ── board composing ────────────────────────────────────────────────────────
  function openBoard(b) {
    setActiveBoard(b);
    setPicked(new Set((b.members || []).map(m => `${m.source}|${m.check_name}`)));
    setTab("cases");
  }
  async function saveMembers() {
    try {
      const members = [...picked].map(k => {
        const i = k.indexOf("|");
        return { source: k.slice(0, i), check_name: k.slice(i + 1) };
      });
      const j = await post(`/api/test/boards/${activeBoard.id}/members`, { members });
      setBoards(j.boards);
      setActiveBoard(j.boards.find(b => b.id === activeBoard.id) || null);
    } catch (e) { setErr(String(e.message || e)); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
        <span onClick={() => setTab("cases")} style={chip(tab === "cases")}>
          Test cases{cases ? ` (${cases.length})` : ""}
        </span>
        <span onClick={() => setTab("boards")} style={chip(tab === "boards")}>
          Boards ({boards.length})
        </span>
        <span onClick={() => { setTab("author"); setDraft({ kind: "query", op: "eq", expected: 0, probe_method: "GET" }); setTryResult(null); }}
          style={chip(tab === "author")}>Write a test case</span>
        <button onClick={load} style={{ ...btn(), marginLeft: "auto" }}>Reload</button>
      </div>

      {err && <div style={{ padding: "9px 13px", borderRadius: 4, fontSize: 11,
        background: "rgba(224,115,107,.1)", border: "0.5px solid rgba(224,115,107,.35)",
        color: "#e0736b" }}>{err}</div>}

      {/* ── CATALOGUE ─────────────────────────────────────────────────────── */}
      {tab === "cases" && (
        <>
          {activeBoard && (
            <div style={{ padding: "10px 13px", borderRadius: 4, fontSize: 11,
              background: GOLD + ".08)", border: `0.5px solid ${GOLD}.3)`, color: GOLD + ".95)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span>Composing <strong>{activeBoard.name}</strong> — {picked.size} test case(s) picked</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button onClick={saveMembers} style={btn(GOLD + ".8)", true)}>Save board</button>
                <button onClick={() => { setActiveBoard(null); setPicked(new Set()); }} style={btn(null, true)}>Done</button>
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="search test cases…"
              style={{ ...input, width: 220 }} />
            <span onClick={() => setSrcFilter("all")} style={chip(srcFilter === "all")}>all sources</span>
            {sources.map(s => <span key={s} onClick={() => setSrcFilter(s)} style={chip(srcFilter === s)}>{s}</span>)}
          </div>

          {cases === null && !err && <span style={label}>Loading…</span>}

          {cases && cases.length === 0 && (
            <div style={{ padding: "16px", borderRadius: 5, fontSize: 11.5, lineHeight: 1.7,
              background: "rgba(255,255,255,.02)", border: "0.5px solid rgba(255,255,255,.08)",
              color: "rgba(255,255,255,.45)" }}>
              The catalogue is empty because it is <em>learned, not declared</em> — it fills in with
              whatever each source actually returns, so nothing here is hardcoded and nothing goes
              stale. Run a sweep once and every built-in test case appears.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {shown.map(c => {
              const k = key(c);
              const on = picked.has(k);
              return (
                <div key={k} style={{ padding: "9px 12px", borderRadius: 4,
                  background: c.enabled ? "rgba(255,255,255,.022)" : "rgba(255,255,255,.008)",
                  border: "0.5px solid rgba(255,255,255,.08)",
                  borderLeftWidth: 2, borderLeftStyle: "solid",
                  borderLeftColor: c.enabled ? (V[c.last_verdict] || "rgba(255,255,255,.15)") : "rgba(255,255,255,.12)",
                  display: "flex", gap: 10, alignItems: "flex-start" }}>

                  {activeBoard && (
                    <input type="checkbox" checked={on} style={{ marginTop: 3, cursor: "pointer" }}
                      onChange={() => setPicked(p => {
                        const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; })} />
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11.5,
                        color: c.enabled ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.35)" }}>
                        {c.check_name}
                      </span>
                      <span style={{ ...label, fontSize: 8.5 }}>{c.source}</span>
                      {c.authored && <span style={{ ...label, fontSize: 8.5, color: GOLD + ".8)" }}>authored</span>}
                      {!c.enabled && <span style={{ ...label, fontSize: 8.5, color: "#d9a441" }}>muted</span>}
                      {c.severity === "advisory" && <span style={{ ...label, fontSize: 8.5 }}>advisory</span>}
                      {c.last_verdict && <span style={{ ...label, fontSize: 8.5, color: V[c.last_verdict] }}>
                        last: {c.last_verdict}</span>}
                    </div>
                    {c.last_detail && <div style={{ marginTop: 4, fontSize: 10,
                      color: "rgba(255,255,255,.38)", lineHeight: 1.5 }}>{c.last_detail.slice(0, 160)}</div>}
                  </div>

                  <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
                    <select value={c.severity} onChange={e => setSetting(c, { severity: e.target.value })}
                      style={{ ...input, padding: "3px 5px", fontSize: 9.5 }}>
                      <option value="blocking" style={{ background: "#151310" }}>blocking</option>
                      <option value="advisory" style={{ background: "#151310" }}>advisory</option>
                    </select>
                    <button onClick={() => setSetting(c, { enabled: !c.enabled })} style={btn(null, true)}>
                      {c.enabled ? "Mute" : "Unmute"}
                    </button>
                    {c.authored && (
                      <button style={btn("#e0736b", true)}
                        onClick={async () => {
                          try { await post(`/api/test/cases/authored/${c.id}/delete`); load(); }
                          catch (e) { setErr(String(e.message || e)); }
                        }}>Delete</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {cases && cases.length > 0 && (
            <div style={{ fontSize: 10, lineHeight: 1.7, color: "rgba(255,255,255,.3)" }}>
              A muted test case files no incident and fails no run — but it is still counted and still
              shown as muted, because a board that reads green only because three cases were turned off
              is not a green board.
            </div>
          )}
        </>
      )}

      {/* ── BOARDS ────────────────────────────────────────────────────────── */}
      {tab === "boards" && (
        <>
          <div style={{ display: "flex", gap: 7 }}>
            <input value={newBoardName} onChange={e => setNewBoardName(e.target.value)}
              placeholder="new board name — e.g. release checklist" style={{ ...input, width: 280 }} />
            <button style={btn()} onClick={async () => {
              try { const j = await post("/api/test/boards", { name: newBoardName });
                setBoards(j.boards); setNewBoardName(""); } catch (e) { setErr(String(e.message || e)); }
            }}>Create</button>
          </div>

          {boards.length === 0 && (
            <div style={{ fontSize: 11.5, lineHeight: 1.7, color: "rgba(255,255,255,.45)" }}>
              No boards yet. A board is a named set of test cases drawn from any source — a release
              checklist, the things you care about before a deploy. It is a <em>view</em>: a case in
              five boards is still one case with one incident.
            </div>
          )}

          {boards.map(b => (
            <div key={b.id} style={{ padding: "11px 13px", borderRadius: 4,
              background: "rgba(255,255,255,.022)", border: "0.5px solid rgba(255,255,255,.08)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.85)" }}>{b.name}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 3 }}>
                  {(b.members || []).length} test case(s)
                  {b.members?.length ? ` · ${[...new Set(b.members.map(m => m.source))].join(", ")}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={btn(GOLD + ".8)", true)} onClick={() => openBoard(b)}>Pick test cases</button>
                <button style={btn("#e0736b", true)} onClick={async () => {
                  try { const j = await post(`/api/test/boards/${b.id}/delete`); setBoards(j.boards); }
                  catch (e) { setErr(String(e.message || e)); }
                }}>Delete</button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* ── AUTHORING ─────────────────────────────────────────────────────── */}
      {tab === "author" && draft && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10,
          padding: "14px 16px", borderRadius: 5, background: "rgba(255,255,255,.02)",
          border: "0.5px solid rgba(255,255,255,.08)" }}>

          <div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.45)" }}>
            A test case asks a question and compares the answer to a number. A <strong>query</strong> runs
            SQL on a <strong>read-only</strong> connection to the platform database — SQLite itself refuses
            anything that writes, so this is not a keyword filter you could word your way around. A{" "}
            <strong>probe</strong> makes an anonymous request to a path on this server and compares the
            status code, which is how every “this door refuses strangers” case in the lab is written.
          </div>

          <input value={draft.name || ""} onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="what it asserts — e.g. no membership points at a ghost" style={input} />

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
              style={{ ...input, width: 80 }} placeholder="0" />
            <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)" }}>
              {draft.kind === "query" ? "← the number the query returns" : "← the HTTP status the path answers"}
            </span>
          </div>

          {draft.kind === "query" ? (
            <textarea value={draft.sql || ""} onChange={e => setDraft({ ...draft, sql: e.target.value })}
              rows={4} spellCheck={false}
              placeholder="SELECT COUNT(*) FROM actor_shares WHERE shared_with_id = owner_id"
              style={{ ...input, fontFamily: "ui-monospace,monospace", fontSize: 10.5, resize: "vertical" }} />
          ) : (
            <div style={{ display: "flex", gap: 7 }}>
              <select value={draft.probe_method} onChange={e => setDraft({ ...draft, probe_method: e.target.value })}
                style={input}>
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
              background: "rgba(255,255,255,.03)",
              border: `0.5px solid ${V[tryResult.verdict] || "#e0736b"}`,
              color: V[tryResult.verdict] || "#e0736b" }}>
              <strong>{tryResult.verdict}</strong> — {tryResult.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
