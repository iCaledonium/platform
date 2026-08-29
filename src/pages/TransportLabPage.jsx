import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Transport ─────────────────────────────────────────────────────
//
// Session 155. The door lab's rule was "never force her present, author her
// past". Transport's transposition is **never teleport her, author where she
// has been**: this page will stand her at A, park a car at C, and write a
// contract that puts her inside a working block — all facts about her history —
// but there is no "make her arrive" button anywhere in it.
//
// Which is why stage 4 is a clock slider and not a destination field. The
// journey is begun for real, and then `transit_started_at` is moved BACKWARDS:
// she left earlier than she did. The polyline, the duration and the arrival
// state are the ones production computed, and check_advance does its own
// arithmetic against the moved clock exactly as it would at any other moment.
//
// Two provenance rules, both learned from the door lab's banner:
//   · a route says whether it came from Google or from the cache, because a
//     cached route makes a run look like routing worked when nothing was
//     fetched;
//   · a mode says what it was CHOSEN FROM, because "driving" picked with a car
//     parked here and "driving" coerced out of "cycling" by a fall-through are
//     the same word for two different events.

const GOLD = "rgba(201,151,58,";

const STAGES = [
  { id: "departure", name: "Departure",
    real: "Whether anything ever puts a go-somewhere entry in front of her.",
    authored: ["a contract that covers right now"] },
  { id: "mode", name: "Mode",
    real: "VehicleEngine.choose_transport — what she picks, and what from.",
    authored: ["the decision to go"] },
  { id: "route", name: "Route",
    real: "fetch_route, its cache, its id resolution and its fallbacks.",
    authored: ["the decision to go", "the mode"] },
  { id: "underway", name: "Underway",
    real: "check_advance, leg advance, arrival, parking, arrival_state.",
    authored: ["the decision", "the mode", "the route"] },
];

const MODES = ["(let her choose)", "driving", "walking", "cycling", "transit", "flight"];
const VEHICLE_TYPES = ["car", "bicycle", "moped", "motorcycle"];

const CANNED = [
  { label: "cycling", json: '{"mode":"cycling","vehicle_id":null,"reason":"The bike is right there."}' },
  { label: "driving", json: '{"mode":"driving","vehicle_id":null,"reason":"I am not walking in this."}' },
  { label: "walking", json: '{"mode":"walking","vehicle_id":null,"reason":"I could use the air."}' },
  { label: "transit", json: '{"mode":"transit","vehicle_id":null,"reason":"The tunnelbana is faster anyway."}' },
  { label: "garbage", json: 'not json at all' },
];

const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "rgba(255,255,255,.4)" };
const panel = { background: "rgba(255,255,255,.025)", border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 6, padding: "14px 16px" };
const input = { background: "rgba(0,0,0,.35)", border: "0.5px solid rgba(255,255,255,.14)", borderRadius: 4, color: "rgba(255,255,255,.9)", padding: "7px 9px", fontSize: 12, fontFamily: "'DM Sans',system-ui,sans-serif", width: "100%" };
const btn = (on = true) => ({ padding: "8px 14px", background: on ? GOLD + ".14)" : "transparent", border: `0.5px solid ${on ? GOLD + ".5)" : "rgba(255,255,255,.14)"}`, borderRadius: 4, cursor: "pointer", fontSize: 11.5, fontFamily: "'DM Sans',sans-serif", color: on ? GOLD + ".95)" : "rgba(255,255,255,.6)" });
const mono = { fontFamily: "ui-monospace,SFMono-Regular,monospace", fontSize: 10.5 };

const VERDICT_COLOR = { pass: "rgba(150,210,150,.9)", fail: "rgba(226,120,110,.95)", skip: "rgba(255,255,255,.35)" };

export default function TransportLabPage() {
  const navigate = useNavigate();

  const [worlds, setWorlds] = useState([]);
  const [worldId, setWorldId] = useState("");
  const [actors, setActors] = useState([]);
  const [actorId, setActorId] = useState("");

  const [ctx, setCtx] = useState(null);
  const [checks, setChecks] = useState(null);
  const [stage, setStage] = useState("departure");

  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [mode, setMode] = useState(MODES[0]);
  const [arrivalState, setArrivalState] = useState("work_deep");
  const [compress, setCompress] = useState(0);

  const [garage, setGarage] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState([]);

  const stageDef = STAGES.find(s => s.id === stage) || STAGES[0];
  const places = ctx?.places || [];
  const armed = !!ctx?.armed?.armed;

  const placeName = (pid) => places.find(p => p.place_id === pid)?.name || pid || "—";

  function note(kind, title, body) {
    setLog(l => [{ at: new Date().toLocaleTimeString(), kind, title, body }, ...l].slice(0, 40));
  }

  async function call(path, body) {
    const init = { credentials: "include" };
    let url = `/api/test/transport/${path}`;
    if (body) {
      init.method = "POST";
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify({ world_id: worldId, actor_id: actorId, ...body });
    } else {
      url += `?world_id=${encodeURIComponent(worldId)}&actor_id=${encodeURIComponent(actorId)}`;
    }
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  useEffect(() => {
    (async () => {
      try {
        const ws = await fetch("/api/worlds", { credentials: "include" }).then(r => r.json());
        setWorlds(ws || []);
        const running = (ws || []).find(w => w.status === "running") || (ws || [])[0];
        if (running) setWorldId(running.id);
      } catch (e) { setError(String(e)); }
    })();
  }, []);

  // Same ambient filter as the door lab: the ambient cast populates venues and
  // has no home, no work and no schedule, so none of them can be sent anywhere.
  useEffect(() => {
    if (!worldId) return;
    (async () => {
      try {
        const p = await fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" }).then(r => r.json());
        const list = (p?.locations || []).flatMap(l => (l.actors || [])
          .filter(a => !a.is_ambient && a.actor_type !== "ambient")
          .map(a => ({ id: a.actor_id, name: a.name })));
        const seen = new Set();
        const uniq = list.filter(a => !seen.has(a.id) && seen.add(a.id))
                         .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setActors(uniq);
        if (uniq.length && !uniq.some(a => a.id === actorId)) setActorId(uniq[0].id);
      } catch (e) { setError(String(e)); }
    })();
  }, [worldId]);

  async function refresh() {
    if (!worldId || !actorId) return;
    try {
      const [c, k] = await Promise.all([call("context"), call("checks")]);
      setCtx(c);
      setChecks(k);
      setGarage((c.vehicles || []).map(v => ({ ...v })));
      if (!origin) setOrigin(c.state?.current_location || c.actor?.home_place_id || "");
      if (!dest) setDest(c.actor?.work_place_id || "");
      setError("");
    } catch (e) { setError(String(e.message || e)); }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [worldId, actorId]);

  async function run(name, fn) {
    setBusy(name);
    setError("");
    try { await fn(); }
    catch (e) { setError(String(e.message || e)); note("fail", name, String(e.message || e)); }
    finally { setBusy(""); }
  }

  const doArm = () => run("arm", async () => {
    const r = await call("arm", { minutes_before: 30, minutes_after: 180 });
    note("ok", `Armed — ${r.day} ${r.block.start}–${r.block.end}`,
      `Contract authored over now. Original kept: ${r.original.work_days} ${r.original.work_blocks}. ` +
      `Next tick should offer "go to work".`);
    await refresh();
  });

  const doDisarm = () => run("disarm", async () => {
    const r = await call("disarm", {});
    note("ok", "Disarmed", `Contract restored. ${r.absences_removed.length} absence row(s) from the armed window removed.`);
    await refresh();
  });

  const doGarage = () => run("garage", async () => {
    const r = await call("garage", { vehicles: garage });
    note("ok", `Garage set — ${r.count} vehicle(s)`,
      (r.vehicles || []).map(v => `${v.type} at ${v.place_name || v.current_place_id || "nowhere"}`).join(", ") || "empty");
    await refresh();
  });

  const doCanned = (c) => run("canned", async () => {
    const r = await fetch("/api/test/llm/canned", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "transport_mode", responses: [c.json] }),
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || "canned failed");
    note("ok", `Scripted next mode reply: ${c.label}`, c.json);
  });

  const doMode = () => run("mode", async () => {
    const r = await call("mode", { origin_place_id: origin, destination_place_id: dest });
    const warn = r.coercion_warnings || [];
    note(warn.length ? "warn" : "ok",
      `Mode → ${r.decision.mode}${r.decision.vehicle_id ? " (with a vehicle)" : " (no vehicle)"}`,
      `"${r.decision.reason}" · walking distance ${r.walking_km ?? "?"} km · ` +
      `chosen from: ${r.available.length ? r.available.map(v => v.type).join(", ") : "nothing here"}` +
      (r.away.length ? ` · parked elsewhere: ${r.away.map(v => v.type).join(", ")}` : "") +
      (warn.length ? `\n⚠ ${warn.join("\n⚠ ")}` : ""));
  });

  const doRoute = () => run("route", async () => {
    const r = await call("route", { origin_place_id: origin, destination_place_id: dest,
                                    mode: mode === MODES[0] ? "driving" : mode });
    if (!r.ok) { note("fail", `Route failed (${r.mode})`, r.error); return; }
    note(r.provenance === "cache" ? "warn" : "ok",
      `Route ${r.duration_minutes} min / ${r.distance_km} km — ${r.provenance}`,
      `${r.polyline_bytes} bytes of polyline in ${r.elapsed_ms} ms. ` +
      `Server-side decoder made ${r.polyline_points_server_side} points of it` +
      (r.polyline_points_server_side === 0 ? " — decode_polyline/1 is broken (raises, rescues to []). The map decodes in JS, so this is latent." : "."));
  });

  const doDepart = () => run("depart", async () => {
    const r = await call("depart", {
      origin_place_id: origin, destination_place_id: dest,
      arrival_state: arrivalState, mode: mode === MODES[0] ? null : mode,
    });
    note(r.outcome === "underway" ? (r.mode_note ? "warn" : "ok") : "warn",
      `Depart → ${r.outcome}`,
      (r.outcome === "underway"
        ? `${r.duration_minutes} min to ${placeName(dest)}. She is on the road; compress the clock to watch her arrive.`
        : (r.note || JSON.stringify(r))) +
      (r.mode_note ? `\n⚠ ${r.mode_note}` : ""));
    await refresh();
  });

  const doAdvance = () => run("advance", async () => {
    const r = await call("advance", { minutes: Number(compress) || 0 });
    note(r.result === "arrived" ? "ok" : "info",
      `Advance −${compress} min → ${r.result}`,
      r.result === "arrived"
        ? `Arrived at ${placeName(r.place_id)} in state "${r.arrival_state}". ` +
          `Vehicles now: ${(r.vehicles || []).map(v => `${v.type}@${v.place_name || "?"}`).join(", ") || "none"}`
        : r.result === "continuing" ? `${Math.round((r.progress || 0) * 100)}% of the way there.`
        : "She is not in transit.");
    await refresh();
  });

  const doClear = () => run("clear", async () => {
    await call("clear", { place_id: origin });
    note("ok", "Journey abandoned", `Transit state cleared; she is standing at ${placeName(origin)}.`);
    await refresh();
  });

  const sameAB = origin && dest && origin === dest;
  const canAct = worldId && actorId && !busy;

  const failing = (checks?.checks || []).filter(c => c.verdict === "fail").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif", color: "rgba(255,255,255,.9)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21 }}>Test Lab · Transport</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>A → B</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} style={btn(false)}>Refresh</button>
          {worldId && (
            <button onClick={() => navigate(`/world/${worldId}?lab=transport`)} style={btn(false)}
              title="Transport's visual surface — the live map, lab-stamped so the watcher rides along">
              World map →
            </button>
          )}
          <button onClick={() => navigate("/lab/home")} style={btn(false)}>Back</button>
        </div>
      </div>

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 24px 80px", display: "flex", flexDirection: "column", gap: 18 }}>

        {/* Provenance. The banner must be able to say the run is not real. */}
        <div style={{ ...panel, borderColor: ctx?.directions ? "rgba(150,210,150,.35)" : "rgba(226,120,110,.5)" }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ ...label, color: ctx?.directions ? "rgba(150,210,150,.9)" : "rgba(226,120,110,.95)" }}>
              {ctx?.directions ? "Directions reachable" : "DIRECTIONS UNREACHABLE — every route will fall back or teleport"}
            </span>
            {ctx?.world && (
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>
                {ctx.world.name} · {ctx.world.city} · engine clock {ctx.world.engine_timezone}{" "}
                {ctx.world.local_time ? new Date(ctx.world.local_time).toLocaleTimeString() : "?"}
              </span>
            )}
            {armed && <span style={{ ...label, color: GOLD + ".95)" }}>● contract armed</span>}
          </div>
          {ctx?.world && ctx.world.engine_timezone !== ctx.world.timezone && (
            <div style={{ fontSize: 10.5, color: "rgba(226,120,110,.95)", lineHeight: 1.6, marginTop: 8 }}>
              CLOCK SKEW — actors run on {ctx.world.engine_timezone} while worlds.timezone says {ctx.world.timezone}.
              Every work block and hour-gated rule in the engine is shifted by the difference. This bench authors
              its blocks against the <i>engine</i> clock so the departure stage still works, but any reasoning you
              do about “her 08:00 start” is off by that much until it is fixed.
            </div>
          )}
        </div>

        {/* Who */}
        <div style={{ ...panel, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ ...label, marginBottom: 6 }}>World</div>
            <select value={worldId} onChange={e => setWorldId(e.target.value)} style={input}>
              {worlds.map(w => <option key={w.id} value={w.id}>{w.name} — {w.status}</option>)}
            </select>
          </div>
          <div>
            <div style={{ ...label, marginBottom: 6 }}>Actor</div>
            <select value={actorId} onChange={e => setActorId(e.target.value)} style={input}>
              {actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {/* Stages */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Stage — everything from here on is the production path</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
            {STAGES.map(s => (
              <div key={s.id} onClick={() => setStage(s.id)}
                style={{ ...panel, cursor: "pointer", padding: "11px 13px",
                  borderColor: stage === s.id ? GOLD + ".55)" : "rgba(255,255,255,.1)",
                  background: stage === s.id ? GOLD + ".07)" : "rgba(255,255,255,.02)" }}>
                <div style={{ fontSize: 12.5, color: stage === s.id ? GOLD + ".95)" : "rgba(255,255,255,.65)" }}>{s.name}</div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5, color: "rgba(255,255,255,.4)", marginTop: 5 }}>{s.real}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)" }}>
            Authored for this stage: {stageDef.authored.length ? stageDef.authored.join(" · ") : "nothing — she decides"}
          </div>
        </div>

        {/* A → B */}
        <div style={panel}>
          <div style={{ ...label, marginBottom: 10 }}>The journey</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ ...label, marginBottom: 6, fontSize: 9 }}>A — from</div>
              <select value={origin} onChange={e => setOrigin(e.target.value)} style={input}>
                <option value="">(nowhere — tests the nil-origin teleport)</option>
                {places.map(p => <option key={"o" + p.place_id} value={p.place_id}>
                  {p.role ? `★ ${p.role} — ` : ""}{p.name}{p.category ? ` (${p.category})` : ""}
                </option>)}
              </select>
            </div>
            <div>
              <div style={{ ...label, marginBottom: 6, fontSize: 9 }}>B — to</div>
              <select value={dest} onChange={e => setDest(e.target.value)} style={input}>
                {places.map(p => <option key={"d" + p.place_id} value={p.place_id}>
                  {p.role ? `★ ${p.role} — ` : ""}{p.name}{p.category ? ` (${p.category})` : ""}
                </option>)}
              </select>
            </div>
          </div>
          {sameAB && (
            <div style={{ fontSize: 10.5, color: GOLD + ".85)", marginTop: 8 }}>
              A and B are the same place — begin_transit will teleport rather than travel. That is a case, not a mistake.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <div>
              <div style={{ ...label, marginBottom: 6, fontSize: 9 }}>Mode</div>
              <select value={mode} onChange={e => setMode(e.target.value)} style={input}>
                {MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <div style={{ ...label, marginBottom: 6, fontSize: 9 }}>Arrival state</div>
              <input value={arrivalState} onChange={e => setArrivalState(e.target.value)} style={input} />
            </div>
          </div>
        </div>

        {/* Garage */}
        <div style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={label}>Garage — what she owns, and where it is parked</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn(false)} onClick={() => setGarage(g => [...g, { type: "car", make: "Volvo", model: "V60", color: "grey", current_place_id: origin, is_primary: g.length === 0 }])}>+ vehicle</button>
              <button style={btn()} disabled={!canAct} onClick={doGarage}>Save garage</button>
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.38)", marginBottom: 10, lineHeight: 1.6 }}>
            A vehicle is available only where it is parked. Drive A→B and it is at B — the return leg may use it, a leg from A may not.
            That is the invariant the round-trip case tests, and the reason this panel asks "where" and not just "what".
          </div>
          {garage.length === 0 && <div style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>No vehicles — every choice will land on transit.</div>}
          {garage.map((v, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 90px 40px", gap: 8, marginBottom: 7, alignItems: "center" }}>
              <select value={v.type} onChange={e => setGarage(g => g.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} style={input}>
                {VEHICLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input value={v.make || ""} placeholder="make" onChange={e => setGarage(g => g.map((x, j) => j === i ? { ...x, make: e.target.value } : x))} style={input} />
              <select value={v.current_place_id || ""} onChange={e => setGarage(g => g.map((x, j) => j === i ? { ...x, current_place_id: e.target.value } : x))} style={input}>
                <option value="">(nowhere)</option>
                {places.map(p => <option key={p.place_id} value={p.place_id}>{p.name}</option>)}
              </select>
              <label style={{ fontSize: 10.5, color: "rgba(255,255,255,.5)", display: "flex", gap: 5, alignItems: "center" }}>
                <input type="checkbox" checked={!!v.is_primary} onChange={e => setGarage(g => g.map((x, j) => j === i ? { ...x, is_primary: e.target.checked } : x))} />
                primary
              </label>
              <button style={{ ...btn(false), padding: "6px 8px" }} onClick={() => setGarage(g => g.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>

        {/* Actions per stage */}
        <div style={panel}>
          <div style={{ ...label, marginBottom: 10 }}>Run</div>

          {stage === "departure" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.5)" }}>
                Arming writes a contracted block over the current time and stands the schedule up around it.
                It authors her <i>contract</i>, not the clock — her hours are a fact about her in the way the time of day is not,
                and a lab that lied about the time would have every circadian read in the engine quietly disagreeing with it.
                The original is kept and restored on disarm, along with any absence the armed window recorded.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn(!armed)} disabled={!canAct || armed} onClick={doArm}>Arm — put her inside a working block</button>
                <button style={btn(false)} disabled={!canAct || !armed} onClick={doDisarm}>Disarm & restore</button>
              </div>
              {armed && (
                <div style={{ fontSize: 10.5, color: GOLD + ".8)", lineHeight: 1.6 }}>
                  Armed. Watch the journal for the pool entry — it is the first one this service has ever produced:
                  <div style={{ ...mono, marginTop: 6, color: "rgba(255,255,255,.55)" }}>
                    journalctl -u deliver-worlds -f | grep -E "go to work|TransitEngine"
                  </div>
                </div>
              )}
            </div>
          )}

          {stage === "mode" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,.5)" }}>
                Script the next reply so the answer does not depend on whether a 70B on another continent is switched on.
                A stage whose point is watching a coercion must not die because the model is asleep.
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {CANNED.map(c => <button key={c.label} style={btn(false)} disabled={!canAct} onClick={() => doCanned(c)}>say “{c.label}”</button>)}
              </div>
              <button style={btn()} disabled={!canAct || !origin || !dest} onClick={doMode}>Choose transport for A → B</button>
            </div>
          )}

          {stage === "route" && (
            <button style={btn()} disabled={!canAct || !dest} onClick={doRoute}>Fetch the route (and say where it came from)</button>
          )}

          {stage === "underway" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <button style={btn()} disabled={!canAct || !dest} onClick={doDepart}>Depart for real (synchronous — returns the tuple)</button>
              <div>
                <div style={{ ...label, marginBottom: 6, fontSize: 9 }}>
                  Compress the clock — she left {compress} minutes earlier than she did
                </div>
                <input type="range" min="0" max="240" value={compress} onChange={e => setCompress(e.target.value)} style={{ width: "100%" }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn()} disabled={!canAct} onClick={doAdvance}>Advance & ask the engine</button>
                <button style={btn(false)} disabled={!canAct} onClick={doClear}>Abandon journey</button>
              </div>
              {ctx?.state?.in_transit && (
                <div style={{ ...mono, color: "rgba(255,255,255,.5)", lineHeight: 1.7 }}>
                  in transit → {placeName(ctx.state.transit_destination)} · {ctx.state.transit_duration_minutes} min ·
                  {" "}{ctx.state.transit_polyline_bytes} B polyline · arrival “{ctx.state.transit_arrival_state}”
                  {ctx.state.transit_vehicle_id ? " · with a vehicle" : " · no vehicle"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scorecard */}
        <div style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={label}>Scorecard — assertions against live state</span>
            <span style={{ ...label, color: failing ? "rgba(226,120,110,.95)" : "rgba(150,210,150,.85)" }}>
              {failing ? `${failing} failing` : "no failures"}
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.35)", marginBottom: 10, lineHeight: 1.6 }}>
            A board that cannot go red is not evidence. The known defects are expected to fail here until they are fixed.
          </div>
          {(checks?.checks || []).map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "7px 0", borderTop: i ? "0.5px solid rgba(255,255,255,.06)" : "none" }}>
              <span style={{ ...label, fontSize: 9, minWidth: 34, color: VERDICT_COLOR[c.verdict] }}>{c.verdict}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.75)" }}>{c.name}</div>
                <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", lineHeight: 1.6, marginTop: 2 }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {error && <div style={{ ...panel, borderColor: "rgba(226,120,110,.5)", color: "rgba(226,120,110,.95)", fontSize: 11.5 }}>{error}</div>}

        {/* Run log */}
        {log.length > 0 && (
          <div style={panel}>
            <div style={{ ...label, marginBottom: 10 }}>Run log</div>
            {log.map((l, i) => (
              <div key={i} style={{ padding: "8px 0", borderTop: i ? "0.5px solid rgba(255,255,255,.06)" : "none" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ ...mono, color: "rgba(255,255,255,.3)" }}>{l.at}</span>
                  <span style={{ fontSize: 11.5, color: l.kind === "fail" ? "rgba(226,120,110,.95)"
                    : l.kind === "warn" ? GOLD + ".95)" : "rgba(255,255,255,.8)" }}>{l.title}</span>
                </div>
                <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.45)", lineHeight: 1.65, marginTop: 3, whiteSpace: "pre-wrap" }}>{l.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
