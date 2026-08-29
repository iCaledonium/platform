import { useEffect, useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab ─────────────────────────────────────────────────────────────────
//
// Session 154 — the encounter is a pipeline, and this is where you choose which
// stage a run BEGINS at.
//
// Session 153 lost an evening to the alternative: to test "come over here" you
// first had to get through a door whose opening is a judgement she makes, so
// the test was a dice roll wearing a lab coat. The rule here is simple and
// load-bearing: a run may author the PAST — memories, vitals, a decision that
// already happened, lines already spoken — and from the chosen stage on it is
// the production path, same prompts, same parsing, same wiring.
//
// Which is why there is no force-open. An open that contradicts her state
// starts a conversation on a false premise: her prompt still carries the
// memories of a woman who would have said no while the scene insists she said
// yes, and the model gets weird in exactly the way it did the first time we
// tried it. Instead, begin at the threshold: the opening is authored, and the
// real opening sequence plays from it.
//
// Nothing in this page decides what a run MEANS. The provenance banner comes
// back from the server, assembled from what the fixture actually did, so it
// cannot flatter itself.

const GOLD = "rgba(201,151,58,";
const VERDICT_COLOR = { pass: "rgba(150,210,150,.9)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };
const VITALS = [
  ["desire", "Desire"], ["energy", "Energy"],
  ["loneliness", "Loneliness"], ["mood", "Mood"],
];
const REL = [["trust", "Trust"], ["warmth", "Warmth"], ["attraction", "Attraction"]];

const REFUSAL_LABEL = {
  send_text: "Sends a text", ignore: "Ignores you", pretend_away: "Pretends she's out",
};

export default function LabPage() {
  const navigate = useNavigate();

  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState("knock_actor_door");
  const [stageId, setStageId] = useState("knock");

  const [worlds, setWorlds] = useState([]);
  const [worldId, setWorldId] = useState("");
  const [actors, setActors] = useState([]);
  const [actorId, setActorId] = useState("");
  const [playerActorId, setPlayerActorId] = useState("");

  const [blank, setBlank] = useState(true);
  const [boost, setBoost] = useState(true);
  const [rel, setRel] = useState({ trust: 0.9, warmth: 0.95, attraction: 0.8 });
  const [vitals, setVitals] = useState({ desire: 0.85, energy: 0.75, loneliness: 0.3, mood: 0.6 });
  const [setVitalsOn, setSetVitalsOn] = useState(true);

  const [forcedRefusal, setForcedRefusal] = useState(null);

  const [liveOpening,   setLiveOpening]   = useState(false);
  const [herRoom, setHerRoom] = useState("bedroom");
  const [playerRoom, setPlayerRoom] = useState("living_room");
  const [history, setHistory] = useState([
    { from: "actor", text: "Come in. I just put the kettle on." },
  ]);
  const [narrative, setNarrative] = useState("");

  const [snapshots, setSnapshots] = useState([]);
  const [showSnaps, setShowSnaps] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [checks, setChecks] = useState(null);
  const [checksErr, setChecksErr] = useState(null); // null = first fetch in flight, "" = ok, text = last refresh failed
  const checksReqRef = useRef("");

  const scenario = useMemo(
    () => scenarios.find(s => s.id === scenarioId) || null, [scenarios, scenarioId]);
  const stage = useMemo(
    () => scenario?.stages?.find(s => s.id === stageId) || null, [scenario, stageId]);
  const rooms = scenario?.placement?.rooms || [];
  const presets = scenario?.placement?.presets || [];
  const atFirstStage = scenario?.stages?.[0]?.id === stageId;
  // Both door scenarios stage themselves at somebody's front door.
  const needsHome = scenarioId === "knock_actor_door";
  const chosenHasHome = actors.find(a => a.id === actorId)?.home !== false;

  useEffect(() => {
    (async () => {
      try {
        const [sc, ws] = await Promise.all([
          fetch("/api/test/scenarios", { credentials: "include" }).then(r => r.json()),
          fetch("/api/worlds", { credentials: "include" }).then(r => r.json()),
        ]);
        setScenarios(sc.scenarios || []);
        setWorlds(ws || []);
        let stored = null; try { stored = localStorage.getItem("labWorldId"); } catch {}
        // The first running world kept defaulting to TEST WORLD 2, whose cast
        // is empty — so Build sat disabled and the scorecard hid, three times
        // in one night. Your last-used world wins.
        const candidate = (ws || []).find(w => w.id === stored)
          || (ws || []).find(w => w.status === "running") || (ws || [])[0];
        if (candidate) setWorldId(candidate.id);
      } catch (e) { setError(String(e)); }
    })();
    refreshSnapshots();
  }, []);

  // Actors come from presence, which is also the honest answer to "is this
  // world actually running" — a stopped world has no one in it, and a fixture
  // against a stopped world dies on unhydrated LLM config.
  useEffect(() => {
    if (!worldId) return;
    (async () => {
      try {
        const [p, me] = await Promise.all([
          fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" }).then(r => r.json()),
          fetch("/api/me", { credentials: "include" }).then(r => r.json()),
        ]);
        const mine = me?.worlds?.find(w => w.world_id === worldId)?.actor_id || "";
        // The ambient cast exists to populate venues — nobody among them has
        // a door, a home, or a life the lab can author. Presence marks them
        // two ways (is_ambient on the merged NPC branch, actor_type on the
        // cast branch); honour both, and keep them out of the picker.
        const list = (p?.locations || []).flatMap(l => (l.actors || [])
          .filter(a => !a.is_ambient && a.actor_type !== "ambient")
          .map(a => ({
          id: a.actor_id, name: a.name, place: l.name,
          // A knock scenario builds a scene at her front door, so an actor
          // with no home on record cannot host one — the client resolves the
          // address itself and gives up with "no address on record".
          home: !!a.home_place_id,
        })));
        const seen = new Set();
        // Your own actor is the one person you cannot knock on the door of.
        const uniq = list
          .filter(a => a.id !== mine && !seen.has(a.id) && seen.add(a.id))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setActors(uniq);
        const preferred = uniq.find(a => a.home) || uniq[0];
        if (preferred && !uniq.some(a => a.id === actorId)) setActorId(preferred.id);
        setPlayerActorId(mine);
      } catch (e) { setError(String(e)); }
    })();
  }, [worldId]);

  useEffect(() => {
    if (scenario && !scenario.stages.some(s => s.id === stageId)) setStageId(scenario.stages[0].id);
    if (rooms.length && !rooms.includes(herRoom)) setHerRoom(rooms[0]);
    if (rooms.length && !rooms.includes(playerRoom)) setPlayerRoom(rooms[0]);
  }, [scenarioId, scenarios]);

  // Scorecard — assertions against live state, mirroring the transport bench.
  // A failed refresh keeps the last board up but says so in the header;
  // switching world/actor RESETS the board (a stale actor's rows must never
  // sit under a fresh selection); the request key discards out-of-order
  // responses when selections change faster than the simulator answers.
  async function refreshChecks() {
    if (!worldId || !actorId) return;
    const key = worldId + "|" + actorId;
    checksReqRef.current = key;
    try {
      const r = await fetch(`/api/test/encounter/checks?world_id=${encodeURIComponent(worldId)}&actor_id=${encodeURIComponent(actorId)}`, { credentials: "include" });
      const j = await r.json().catch(() => null);
      if (checksReqRef.current !== key) return; // a newer selection owns the board now
      if (j && j.ok) { setChecks(j); setChecksErr(""); }
      else setChecksErr(j && j.error ? `the simulator said: ${j.error}` : `the simulator answered HTTP ${r.status} without a usable board`);
    } catch {
      if (checksReqRef.current === key) setChecksErr("the simulator did not answer");
    }
  }
  useEffect(() => { setChecks(null); setChecksErr(null); refreshChecks(); /* eslint-disable-next-line */ }, [worldId, actorId]);

  async function refreshSnapshots() {
    try {
      const d = await fetch("/api/test/snapshots", { credentials: "include" }).then(r => r.json());
      // The simulator snapshot dir can carry stray .json (the transport lab
      // arms itself there) — a row with no id is not a snapshot.
      setSnapshots((d.snapshots || []).filter(s => s.id));
    } catch { /* the lab still works without a snapshot list */ }
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  async function takeSnapshot() {
    setBusy("snapshot"); setError(null);
    try {
      const d = await post("/api/test/actor/snapshot",
        { world_id: worldId, actor_id: actorId, player_actor_id: playerActorId });
      setResult({ kind: "snapshot", text: `Snapshot ${d.snapshot_id.slice(0, 8)} — ` +
        Object.entries(d.counts).map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`).join(", ") });
      refreshSnapshots();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function saveLabel(id, labelText) {
    setError(null);
    try {
      await post("/api/test/actor/snapshot/label", { snapshot_id: id, label: labelText || null });
      refreshSnapshots();
    } catch (e) { setError(String(e)); }
  }

  async function deleteSnapshot(id) {
    setBusy("delete"); setError(null); setConfirmDelete(null);
    try {
      await post("/api/test/actor/snapshot/delete", { snapshot_id: id });
      setResult({ kind: "delete", text: `Deleted snapshot ${id.slice(0, 8)}.` });
      refreshSnapshots();
    } catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }

  async function restoreSnapshot(id) {
    setBusy("restore"); setError(null);
    try {
      await post("/api/test/actor/restore", { snapshot_id: id });
      setResult({ kind: "restore", text: `Restored ${id.slice(0, 8)} — she is exactly as she was.` });
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function launch() {
    setBusy("launch"); setError(null); setResult(null);
    try {
      const body = {
        world_id: worldId, target_actor_id: actorId, player_actor_id: playerActorId,
        scenario: scenarioId, begin_at: stageId,
        her_room: rooms.length ? herRoom : null,
        player_room: rooms.length ? playerRoom : null,
        forced_refusal: atFirstStage ? forcedRefusal : null,
        narrative: narrative.trim() || null,
        seeded_history: atFirstStage ? [] : history.filter(h => h.text.trim()),
        first_words: liveOpening ? "real" : "none",
        prepare: (blank || boost || setVitalsOn) ? {
          blank,
          relationship: boost ? rel : {},
          vitals: setVitalsOn ? vitals : {},
        } : null,
      };
      const d = await post("/api/test/fixture", body);
      setResult({ kind: "launch", text: d.provenance, url: d.scene_url, id: d.encounter_id });
      // A successful build goes straight into the scene — the banner (and its
      // Enter button) only remain for the return trip / a failed navigation.
      if (d.scene_url) navigate(d.scene_url);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  // ── styling helpers, matched to the door scene's own vocabulary ────────────
  const label = { fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.42)" };
  const card = (on) => ({
    display: "flex", flexDirection: "column", gap: 6, padding: "14px 16px", borderRadius: 8,
    cursor: "pointer",
    border: `0.5px solid ${on ? GOLD + ".5)" : "rgba(255,255,255,.12)"}`,
    background: on ? GOLD + ".1)" : "rgba(255,255,255,.02)",
  });
  const chip = (on) => ({
    flex: 1, padding: "6px 0", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
    borderRadius: 4, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
    background: on ? GOLD + ".16)" : "transparent",
    border: `0.5px solid ${on ? GOLD + ".45)" : "rgba(255,255,255,.12)"}`,
    color: on ? GOLD + ".9)" : "rgba(255,255,255,.4)",
  });
  const field = { padding: "10px 12px", background: "rgba(255,255,255,.04)",
    border: "0.5px solid rgba(255,255,255,.14)", borderRadius: 6, color: "rgba(255,255,255,.78)",
    fontSize: 13, fontFamily: "'DM Sans',sans-serif", width: "100%" };
  const section = { display: "flex", flexDirection: "column", gap: 14,
    borderTop: "0.5px solid rgba(255,255,255,.08)", paddingTop: 20 };

  const Slider = ({ k, name, obj, set, max = 1 }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={label}>{name}</span>
        <span style={{ fontSize: 11, color: GOLD + ".85)", fontVariantNumeric: "tabular-nums" }}>
          {Number(obj[k] ?? 0).toFixed(2)}
        </span>
      </div>
      <input type="range" min={0} max={100} value={Math.round((obj[k] ?? 0) * 100 / max)}
        onChange={(e) => set({ ...obj, [k]: (Number(e.target.value) / 100) * max })}
        style={{ width: "100%", accentColor: "#c9973a" }} />
    </div>
  );

  const failing = (checks?.checks || []).filter(c => c.verdict !== "pass" && c.verdict !== "skip").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>owner's tool</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/lab/home")} style={{ ...chip(false), flex: "none", padding: "8px 16px" }}>All tests</button>
          <button onClick={() => navigate("/home")} style={{ ...chip(false), flex: "none", padding: "8px 16px" }}>Close</button>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        {/* scenario */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Scenario</span>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(scenarios.length, 1)}, minmax(0,1fr))`, gap: 10 }}>
            {scenarios.map(s => (
              <div key={s.id} onClick={() => setScenarioId(s.id)} style={card(s.id === scenarioId)}>
                <span style={{ fontSize: 12.5, color: s.id === scenarioId ? GOLD + ".95)" : "rgba(255,255,255,.55)" }}>{s.name}</span>
                <span style={{ fontSize: 9.5, lineHeight: 1.6, color: "rgba(255,255,255,.3)" }}>{s.blurb}</span>
              </div>
            ))}
          </div>
        </div>

        {/* stage */}
        {scenario && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={label}>Begin at</span>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${scenario.stages.length}, minmax(0,1fr))`, gap: 10 }}>
              {scenario.stages.map(st => (
                <div key={st.id} onClick={() => setStageId(st.id)} style={card(st.id === stageId)}>
                  <span style={{ fontSize: 12.5, color: st.id === stageId ? GOLD + ".95)" : "rgba(255,255,255,.55)" }}>{st.name}</span>
                  <span style={{ fontSize: 9.5, lineHeight: 1.6, color: "rgba(255,255,255,.3)" }}>{st.real}</span>
                </div>
              ))}
            </div>
            {stage && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                background: "rgba(255,255,255,.025)", border: "0.5px solid rgba(255,255,255,.08)", borderRadius: 6 }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,.3)" }}>
                  {stage.authored.length
                    ? `authored: ${stage.authored.join(" · ")}`
                    : "nothing is authored"}
                  {" — from here on, the production path"}
                </span>
              </div>
            )}
          </div>
        )}

        {/* subject */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={label}>World</span>
            <select value={worldId}
              onChange={(e) => { setWorldId(e.target.value); try { localStorage.setItem("labWorldId", e.target.value); } catch {} }}
              style={field}>
              {worlds.map(w => <option key={w.id} value={w.id}>{w.name}{w.status === "running" ? "" : " (stopped)"}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <span style={label}>Actor</span>
            <select value={actorId} onChange={(e) => setActorId(e.target.value)} style={field}>
              {actors.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.home ? "" : " — no home on record"}</option>
              ))}
            </select>
          </div>
        </div>
        {needsHome && actorId && !chosenHasHome && (
          <span style={{ fontSize: 10, color: "rgba(222,140,130,.85)" }}>
            This actor has no home on record, so there is no door to knock on — the scene gives up
            with "no address on record". Pick someone with an address, or use a venue scenario.
          </span>
        )}
        {!actors.length && worldId && (
          <span style={{ fontSize: 10, color: "rgba(222,140,130,.8)" }}>
            No one is present in this world — it is probably stopped, and a fixture against a stopped
            world dies on unhydrated LLM config. Start it first.
          </span>
        )}

        {/* state */}
        <div style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={label}>State — who she is when it begins</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={takeSnapshot} disabled={!actorId || busy}
                style={{ ...chip(false), flex: "none", padding: "5px 12px" }}>
                {busy === "snapshot" ? "…" : "Snapshot"}
              </button>
              {snapshots.length > 0 && (
                <button onClick={() => { setShowSnaps(v => !v); if (!showSnaps) refreshSnapshots(); }}
                  style={{ ...chip(showSnaps), flex: "none", padding: "5px 12px" }}>
                  Snapshots ({snapshots.length})
                </button>
              )}
            </div>
          </div>

          {/* The picker: every snapshot, not just the latest. The label input
              is the editor — name a state so future-you knows why it was
              worth keeping. Restore rewrites her rows; delete burns the file. */}
          {showSnaps && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {snapshots.map(sn => {
                const when = sn.taken_at
                  ? new Date(sn.taken_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                  : "?";
                const parts = Object.entries(sn.counts || {})
                  .filter(([, n]) => n > 0)
                  .map(([t, n]) => `${n} ${t.replace("actor_", "").replace(/_/g, " ")}`);
                return (
                  <div key={sn.id} style={{ display: "flex", flexDirection: "column", gap: 6,
                    padding: "10px 12px", background: "rgba(255,255,255,.02)",
                    border: "0.5px solid rgba(255,255,255,.08)", borderRadius: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input
                        defaultValue={sn.label || ""}
                        placeholder="unlabelled — click to name this state"
                        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        onBlur={e => { const v = e.currentTarget.value.trim(); if (v !== (sn.label || "")) saveLabel(sn.id, v); }}
                        style={{ flex: 1, padding: "6px 8px", background: "rgba(255,255,255,.03)",
                          border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 4,
                          color: "rgba(255,255,255,.85)", fontSize: 12,
                          fontFamily: "'DM Sans',system-ui,sans-serif" }} />
                      <button onClick={() => restoreSnapshot(sn.id)} disabled={busy}
                        style={{ ...chip(false), flex: "none", padding: "5px 12px" }}>
                        {busy === "restore" ? "…" : "Restore"}
                      </button>
                      {confirmDelete === sn.id ? (
                        <>
                          <button onClick={() => deleteSnapshot(sn.id)} disabled={busy}
                            style={{ ...chip(false), flex: "none", padding: "5px 12px",
                              borderColor: "rgba(222,140,130,.5)", color: "rgba(222,140,130,.95)" }}>
                            {busy === "delete" ? "…" : "Delete — sure?"}
                          </button>
                          <button onClick={() => setConfirmDelete(null)} disabled={busy}
                            style={{ ...chip(false), flex: "none", padding: "5px 12px" }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDelete(sn.id)} disabled={busy}
                          style={{ ...chip(false), flex: "none", padding: "5px 12px" }}>
                          Delete
                        </button>
                      )}
                    </div>
                    <span style={{ fontSize: 9.5, color: "rgba(255,255,255,.35)" }}>
                      <span style={{ fontFamily: "ui-monospace,monospace" }}>{sn.id.slice(0, 8)}</span>
                      {" · "}{sn.actor_name || sn.actor_id?.slice(0, 8)}{" · "}{when}
                      {parts.length > 0 && <>{" — "}{parts.join(", ")}</>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={blank} onChange={(e) => setBlank(e.target.checked)}
              style={{ accentColor: "#c9973a", width: 15, height: 15 }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>Blank her to her deployed state</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,.3)", marginLeft: "auto" }}>
              memories, thoughts, residues, SMS, sessions, conversations, scene, presence, needs
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={boost} onChange={(e) => setBoost(e.target.checked)}
              style={{ accentColor: "#c9973a", width: 15, height: 15 }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>Set the relationship</span>
          </label>
          {boost && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 20 }}>
              {REL.map(([k, n]) => <Slider key={k} k={k} name={n} obj={rel} set={setRel} />)}
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={setVitalsOn} onChange={(e) => setSetVitalsOn(e.target.checked)}
              style={{ accentColor: "#c9973a", width: 15, height: 15 }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>Set her vitals</span>
          </label>
          {setVitalsOn && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: "18px 28px" }}>
                {VITALS.map(([k, n]) => <Slider key={k} k={k} name={n} obj={vitals} set={setVitals} />)}
              </div>
              <span style={{ fontSize: 9, lineHeight: 1.55, color: "rgba(255,255,255,.24)" }}>
                Vitals drive her door decisions and her silence cadence. Desire past 0.70 leans the door
                open and quickens her silences — these are the numbers her refusals came from.
              </span>
            </>
          )}
        </div>

        {/* decision — first stage only */}
        {atFirstStage && (scenario?.forced_refusals?.length ?? 0) > 0 && (
          <div style={section}>
            <span style={label}>Decision</span>
            <div onClick={() => setForcedRefusal(null)} style={card(forcedRefusal === null)}>
              <span style={{ fontSize: 12, color: forcedRefusal === null ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.6)" }}>
                She decides — for real
              </span>
              <span style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,.4)" }}>
                Runs against the state above. The outcome is evidence about her.
              </span>
            </div>
            <div style={card(forcedRefusal !== null)}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,.6)" }}>Force a refusal — UI test</span>
              <span style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,.35)" }}>
                A refusal ends the encounter; nothing follows it, so nothing is contradicted.
              </span>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                {scenario.forced_refusals.map(r => (
                  <button key={r} onClick={() => setForcedRefusal(forcedRefusal === r ? null : r)}
                    style={chip(forcedRefusal === r)}>{REFUSAL_LABEL[r] || r}</button>
                ))}
              </div>
            </div>
            <span style={{ fontSize: 9, lineHeight: 1.55, color: "rgba(255,255,255,.24)" }}>
              There is no force-open. An open that contradicts her state poisons every turn that follows —
              begin at the next stage instead, where the opening is authored and plays for real.
            </span>
          </div>
        )}

        {/* her opening line */}
        {!atFirstStage && (
          <div style={section}>
            <span style={label}>Her opening line</span>
            <div onClick={() => setLiveOpening(false)} style={card(!liveOpening)}>
              <span style={{ fontSize: 12, color: !liveOpening ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.6)" }}>
                Authored — no model
              </span>
              <span style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,.4)" }}>
                The seeded lines below are what she has said. The run reaches the scene even with the
                model host switched off, which is what makes this a sandbox rather than a shortcut.
              </span>
            </div>
            <div onClick={() => setLiveOpening(true)} style={card(liveOpening)}>
              <span style={{ fontSize: 12, color: liveOpening ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.6)" }}>
                She writes it — for real
              </span>
              <span style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,.4)" }}>
                Choose this when the opening line is the thing under test. It needs the model, and if the
                model cannot be reached the encounter dies before the scene opens.
              </span>
            </div>
          </div>
        )}

        {/* placement */}
        {!atFirstStage && rooms.length > 0 && (
          <div style={section}>
            <span style={label}>Placement</span>
            {presets.length > 0 && (
              <div style={{ display: "flex", gap: 6 }}>
                {presets.map(p => {
                  const on = herRoom === p.her && playerRoom === p.player;
                  return (
                    <button key={p.id} onClick={() => { setHerRoom(p.her); setPlayerRoom(p.player); }}
                      style={chip(on)}>{p.name}</button>
                  );
                })}
              </div>
            )}
            {[["Her", herRoom, setHerRoom, GOLD + ".7)"], ["You", playerRoom, setPlayerRoom, "rgba(255,255,255,.45)"]]
              .map(([who, val, set, colour]) => (
              <div key={who} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 34, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: colour }}>{who}</span>
                <div style={{ display: "flex", gap: 6, flex: 1 }}>
                  {rooms.map(r => (
                    <button key={r} onClick={() => set(r)} style={chip(val === r)}>
                      {r.replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* seeded history */}
        {!atFirstStage && (
          <div style={section}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={label}>Seeded history — the past this run begins after</span>
              <span style={{ fontSize: 9, color: "rgba(255,255,255,.24)" }}>enters her log verbatim</span>
            </div>
            <input value={narrative} onChange={(e) => setNarrative(e.target.value)}
              placeholder="Narrative line (blank uses the stage's default)"
              style={{ ...field, fontFamily: "'Cormorant Garamond',Georgia,serif", fontStyle: "italic", textAlign: "center" }} />
            {history.map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => setHistory(hs => hs.map((x, n) =>
                  n === i ? { ...x, from: x.from === "actor" ? "player" : "actor" } : x))}
                  style={{ ...chip(h.from === "actor"), flex: "none", width: 70 }}>
                  {h.from === "actor" ? "Her" : "You"}
                </button>
                <input value={h.text} onChange={(e) => setHistory(hs => hs.map((x, n) =>
                  n === i ? { ...x, text: e.target.value } : x))} style={field} />
                <button onClick={() => setHistory(hs => hs.filter((_, n) => n !== i))}
                  style={{ ...chip(false), flex: "none", width: 34 }}>×</button>
              </div>
            ))}
            <button onClick={() => setHistory(hs => [...hs, { from: "player", text: "" }])}
              style={{ ...chip(false), flex: "none", alignSelf: "flex-start", padding: "8px 14px",
                border: "0.5px dashed rgba(255,255,255,.2)" }}>+ add a line</button>
          </div>
        )}

        {/* launch */}
        <div style={section}>
          {error && (
            <div style={{ padding: "12px 14px", border: "0.5px solid rgba(222,140,130,.4)", borderRadius: 6,
              background: "rgba(222,140,130,.08)", fontSize: 11, color: "rgba(222,140,130,.95)" }}>{error}</div>
          )}
          {result && result.kind !== "launch" && (
            <div style={{ padding: "12px 14px", border: "0.5px solid rgba(150,210,150,.35)", borderRadius: 6,
              background: "rgba(150,210,150,.07)", fontSize: 11, color: "rgba(255,255,255,.7)" }}>{result.text}</div>
          )}
          {result?.kind === "launch" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px",
              border: `0.5px solid ${GOLD}.3)`, borderRadius: 6, background: GOLD + ".07)" }}>
              <span style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: GOLD + ".75)" }}>
                This run means
              </span>
              <span style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.6)" }}>{result.text}</span>
              <button onClick={() => navigate(result.url)}
                style={{ ...chip(true), flex: "none", alignSelf: "flex-start", padding: "10px 22px", fontSize: 11 }}>
                Enter the scene →
              </button>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={launch}
              disabled={!worldId || !actorId || !playerActorId || busy || (needsHome && !chosenHasHome)}
              style={{ ...chip(true), flex: "none", padding: "13px 34px", fontSize: 12, letterSpacing: ".12em" }}>
              {busy === "launch" ? "Building…" : "Build the run"}
            </button>
          </div>
        </div>

        {/* scorecard */}
        {!checks && worldId && (
          <div style={section}>
            <span style={label}>Scorecard — assertions against live state</span>
            <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)" }}>
              {!actorId
                ? "Waiting for an eligible actor — this world has no one to assert about. Pick a world with a cast."
                : checksErr === null
                  ? "Checking\u2026"
                  : `Checks unavailable — ${checksErr}.`}
            </span>
          </div>
        )}
        {checks && (
          <div style={section}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={label}>Scorecard — assertions against live state</span>
              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {checksErr ? (
                  <span style={{ ...label, color: "rgba(226,120,110,.7)" }}>stale — last refresh failed</span>
                ) : null}
                <span style={{ ...label, color: failing ? "rgba(226,120,110,.95)" : "rgba(150,210,150,.85)" }}>
                  {failing ? `${failing} failing` : "no failures"}
                </span>
                <button onClick={refreshChecks} style={{ ...chip(false), flex: "none" }}>Recheck</button>
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", lineHeight: 1.6 }}>
              A board that cannot go red is not evidence. The known defects are expected to fail here until they are fixed.
            </div>
            <div>
              {(checks.checks || []).map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "7px 0", borderTop: i ? "0.5px solid rgba(255,255,255,.06)" : "none" }}>
                  <span style={{ ...label, fontSize: 9, minWidth: 34, color: VERDICT_COLOR[c.verdict] || "rgba(255,255,255,.6)" }}>{c.verdict}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)" }}>{c.name}</div>
                    <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", lineHeight: 1.6, marginTop: 2 }}>{c.detail}</div>
                  </div>
                  {c.verdict === "fail" && (
                    <button
                      title="Hand this failure to the watcher: diagnose, fix within its charter, re-run the check"
                      onClick={() => window.dispatchEvent(new CustomEvent("watcher:ask", { detail: { text:
                        `Developer pressed FIX on the failing scorecard check "${c.name}". Its detail: ${c.detail} — ` +
                        "Diagnose the root cause and FIX it within your charter: snapshot first if anything state-destroying, " +
                        "state writes only through the test endpoints, code changes compile-proofed (staged if a restart is " +
                        "needed — do not restart just for this; say so instead). When done, re-run the check " +
                        "(GET /internal/test/encounter/checks) and report whether it went green, or exactly why it must stay red." } }))}
                      style={{ alignSelf: "flex-start", flex: "none", padding: "4px 10px", borderRadius: 5,
                        cursor: "pointer", background: "rgba(201,151,58,.12)",
                        border: "0.5px solid rgba(201,151,58,.4)", color: "rgba(201,151,58,.9)",
                        fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase",
                        fontFamily: "'DM Sans',system-ui,sans-serif" }}>
                      Fix
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
