import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

// ── Shared styles ─────────────────────────────────────────────────────────────
const S = {
  serif:  { fontFamily:"'Cormorant Garamond',Georgia,serif" },
  sans:   { fontFamily:"'DM Sans',system-ui,sans-serif" },
  mono:   { fontFamily:"'DM Mono',monospace" },
  label:  { fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" },
};

const PAGE = {
  minHeight:"100vh", background:"#f5f2ef",
  display:"flex", flexDirection:"column", alignItems:"center", padding:"2.5rem 1rem 4rem",
};

const CARD = {
  background:"rgba(255,255,255,.7)", border:"1px solid rgba(0,0,0,.06)",
  borderRadius:16, padding:"1.75rem", marginBottom:"1rem", width:"100%", maxWidth:680,
};

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({ current }) {
  const steps = ["World", "Relationships", "Schedule", "Media", "Deploy"];
  return (
    <div style={{ display:"flex", alignItems:"center", width:"100%", maxWidth:680, marginBottom:"1.75rem" }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const done    = n < current;
        const active  = n === current;
        const pending = n > current;
        return (
          <div key={label} style={{ display:"flex", alignItems:"center", flex: i < steps.length - 1 ? 1 : "none" }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, flexShrink:0 }}>
              <div style={{
                width:28, height:28, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:12, fontWeight:500, flexShrink:0,
                background: done ? "rgba(29,158,117,.15)" : active ? "#1a1814" : "rgba(0,0,0,.06)",
                color: done ? "#0f6e56" : active ? "#faf8f4" : "#a8a5a0",
                border: done ? "1px solid rgba(29,158,117,.3)" : "none",
              }}>
                {done ? "✓" : n}
              </div>
              <span style={{ ...S.sans, fontSize:11, color: active ? "#1a1814" : "#a8a5a0", fontWeight: active ? 500 : 400 }}>
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div style={{ flex:1, height:.5, background:"rgba(0,0,0,.1)", margin:"0 10px" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Nav buttons ───────────────────────────────────────────────────────────────
function NavButtons({ step, onBack, onNext, nextLabel, loading }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", width:"100%", maxWidth:680, marginTop:8 }}>
      <button onClick={onBack} style={{ ...S.sans, fontSize:13, padding:"8px 20px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor: step === 1 ? "not-allowed" : "pointer", opacity: step === 1 ? .4 : 1 }} disabled={step === 1}>
        ← Back
      </button>
      <button onClick={onNext} disabled={loading} style={{ ...S.sans, fontSize:13, padding:"8px 28px", borderRadius:10, border:"none", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity: loading ? .6 : 1 }}>
        {loading ? "Working…" : (nextLabel || "Next →")}
      </button>
    </div>
  );
}

// ── Step 1: World ─────────────────────────────────────────────────────────────
function StepWorld({ actor, state, setState }) {
  const [worlds, setWorlds] = useState([]);

  useEffect(() => {
    fetch("/api/worlds").then(r => r.ok ? r.json() : []).then(setWorlds).catch(() => {});
  }, []);

  return (
    <div style={CARD}>
      <div style={{ ...S.serif, fontSize:22, fontWeight:500, color:"#1a1814", marginBottom:4 }}>Select world</div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:20 }}>Choose which world to deploy {actor?.first_name || actor?.name} into</p>

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {worlds.length === 0 && (
          <div style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Loading worlds…</div>
        )}
        {worlds.map(w => (
          <div key={w.id} onClick={() => setState(p => ({ ...p, world: w }))}
            style={{ padding:"14px 16px", borderRadius:12, border:`1.5px solid ${state.world?.id === w.id ? "#1a1814" : "rgba(0,0,0,.07)"}`, background: state.world?.id === w.id ? "rgba(26,24,20,.04)" : "rgba(255,255,255,.6)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ ...S.sans, fontSize:14, fontWeight:500, color:"#1a1814" }}>{w.name}</div>
              <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginTop:2 }}>{w.domain_type || "Stockholm"} · {w.status || "running"}</div>
            </div>
            {state.world?.id === w.id && <span style={{ color:"#1a1814", fontSize:14 }}>✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 2: Relationships ─────────────────────────────────────────────────────
function StepRelationships({ actor, state, setState }) {
  const [characters, setCharacters] = useState([]);
  const [relTypes, setRelTypes]     = useState({ lawful:[], romantic:[], social:[] });
  const [picked, setPicked]         = useState(null);
  const [selected, setSelected]     = useState({ lawful:[], romantic:[], social:[] });
  const [description, setDescription] = useState("");
  const [customInputs, setCustomInputs] = useState({ lawful:"", romantic:"", social:"" });
  const [dropOpen, setDropOpen]     = useState(false);

  const DEFAULT_LABELS = {
    lawful:   ["sister","mother","daughter","aunt","colleague","employer","mentor","employee"],
    romantic: ["partner","ex","affair","friends with benefits","unrequited","fling"],
    social:   ["best friend","close friend","friend","acquaintance","rival","strained"],
  };

  useEffect(() => {
    if (!state.world) return;
    fetch(`/api/worlds/${state.world.id}/actors`).then(r => r.ok ? r.json() : []).then(setCharacters).catch(() => {});
    fetch("/api/relationship-types").then(r => r.ok ? r.json() : null).then(d => {
      if (d) setRelTypes(d);
      else setRelTypes({ lawful: DEFAULT_LABELS.lawful, romantic: DEFAULT_LABELS.romantic, social: DEFAULT_LABELS.social });
    }).catch(() => setRelTypes({ lawful: DEFAULT_LABELS.lawful, romantic: DEFAULT_LABELS.romantic, social: DEFAULT_LABELS.social }));
  }, [state.world]);

  const catColors = {
    lawful:   { bg:"#E1F5EE", color:"#0F6E56", selBg:"#0F6E56", selColor:"#E1F5EE", border:"#5DCAA5" },
    romantic: { bg:"#FBEAF0", color:"#993556", selBg:"#993556", selColor:"#FBEAF0", border:"#ED93B1" },
    social:   { bg:"#E6F1FB", color:"#185FA5", selBg:"#185FA5", selColor:"#E6F1FB", border:"#85B7EB" },
  };

  function toggleChip(cat, label) {
    setSelected(p => {
      const arr = p[cat];
      return { ...p, [cat]: arr.includes(label) ? arr.filter(x => x !== label) : [...arr, label] };
    });
  }

  function addCustomLabel(cat) {
    const val = customInputs[cat].trim();
    if (!val) return;
    setRelTypes(p => ({ ...p, [cat]: [...p[cat], val] }));
    setCustomInputs(p => ({ ...p, [cat]: "" }));
    setSelected(p => ({ ...p, [cat]: [...p[cat], val] }));
  }

  function addRelationship() {
    if (!picked) return;
    const labels = [...selected.lawful, ...selected.romantic, ...selected.social];
    if (!labels.length) return;
    const rel = { character: picked, labels, description, selected };
    setState(p => ({ ...p, relationships: [...(p.relationships||[]), rel] }));
    setPicked(null);
    setSelected({ lawful:[], romantic:[], social:[] });
    setDescription("");
  }

  const initials = name => name?.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase() || "?";

  return (
    <div style={CARD}>
      <div style={{ ...S.serif, fontSize:22, fontWeight:500, color:"#1a1814", marginBottom:4 }}>Relationships</div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:20 }}>Define who {actor?.first_name || actor?.name} already knows in this world</p>

      {/* Character picker */}
      <div style={{ marginBottom:20 }}>
        <div style={{ ...S.label, marginBottom:8 }}>Character</div>
        <div style={{ position:"relative" }}>
          <div onClick={() => setDropOpen(p => !p)} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", border:"1px solid rgba(0,0,0,.1)", borderRadius:10, background:"rgba(255,255,255,.7)", cursor:"pointer" }}>
            {picked ? (
              <>
                <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, color:"#6b6760", flexShrink:0 }}>{initials(picked.name)}</div>
                <div>
                  <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{picked.first_name || picked.name}</div>
                  <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{picked.occupation}</div>
                </div>
              </>
            ) : (
              <span style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Select a character…</span>
            )}
            <span style={{ marginLeft:"auto", fontSize:10, color:"#a8a5a0" }}>▼</span>
          </div>
          {dropOpen && (
            <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, background:"#fff", border:"1px solid rgba(0,0,0,.1)", borderRadius:10, zIndex:20, overflow:"hidden", boxShadow:"0 4px 20px rgba(0,0,0,.1)" }}>
              {characters.filter(c => c.id !== actor?.id).map(c => (
                <div key={c.id} onClick={() => { setPicked(c); setDropOpen(false); }}
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", cursor:"pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f5f2ef"}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  {c.photo_url ? (
                    <img src={c.photo_url} style={{ width:32, height:32, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
                  ) : (
                    <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(0,0,0,.06)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:500, color:"#6b6760", flexShrink:0 }}>{initials(c.name)}</div>
                  )}
                  <div>
                    <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{c.first_name || c.name}</div>
                    <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{c.occupation}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Relationship chips per category */}
      {["lawful","romantic","social"].map(cat => {
        const c = catColors[cat];
        const labels = relTypes[cat] || DEFAULT_LABELS[cat] || [];
        return (
          <div key={cat} style={{ marginBottom:16 }}>
            <div style={{ ...S.label, color: c.color, marginBottom:8 }}>{cat}</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
              {labels.map(label => {
                const isSel = selected[cat].includes(label);
                return (
                  <span key={label} onClick={() => toggleChip(cat, label)}
                    style={{ padding:"5px 12px", borderRadius:20, fontSize:12, cursor:"pointer", border:`1px solid ${isSel ? c.selBg : c.border}`, background: isSel ? c.selBg : c.bg, color: isSel ? c.selColor : c.color, transition:"all .15s" }}>
                    {label}
                  </span>
                );
              })}
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <input value={customInputs[cat]} onChange={e => setCustomInputs(p => ({...p, [cat]:e.target.value}))}
                onKeyDown={e => e.key === "Enter" && addCustomLabel(cat)}
                placeholder={`New ${cat} label…`}
                style={{ flex:1, fontSize:12, padding:"5px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }} />
              <button onClick={() => addCustomLabel(cat)} style={{ ...S.sans, fontSize:12, padding:"5px 12px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>+ Add</button>
            </div>
          </div>
        );
      })}

      {/* Description */}
      <div style={{ marginBottom:16 }}>
        <div style={{ ...S.label, marginBottom:8 }}>Describe the relationship</div>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          placeholder={`Describe how ${actor?.first_name || actor?.name} and ${picked?.first_name || picked?.name || "this character"} know each other…`}
          style={{ width:"100%", minHeight:80, fontSize:13, padding:"10px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)", resize:"vertical" }} />
      </div>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <button onClick={addRelationship} style={{ ...S.sans, fontSize:12, padding:"7px 16px", borderRadius:8, border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>
          + Add relationship
        </button>
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {(state.relationships||[]).map((r, i) => (
            <span key={i} style={{ ...S.sans, fontSize:11, padding:"3px 10px", borderRadius:20, background:"rgba(29,158,117,.1)", color:"#0f6e56", border:"1px solid rgba(29,158,117,.2)" }}>
              {r.character.first_name || r.character.name} · {r.labels.slice(0,2).join(" · ")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Schedule ──────────────────────────────────────────────────────────
function StepSchedule({ actor, state, setState }) {
  const [generating, setGenerating] = useState(false);
  const [schedule, setSchedule]     = useState(state.schedule || null);

  const currentWeek = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 604800000);
  const [fromWeek, setFromWeek] = useState(currentWeek);

  async function generateSchedule() {
    setGenerating(true);
    try {
      const res = await fetch("/api/generate/schedule", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ actor_id: actor.id, world_id: state.world?.id }),
      });
      const data = res.ok ? await res.json() : null;
      const s = data || mockSchedule(actor);
      setSchedule(s);
      setState(p => ({ ...p, schedule: s, fromWeek }));
    } catch {
      const s = mockSchedule(actor);
      setSchedule(s);
      setState(p => ({ ...p, schedule: s, fromWeek }));
    } finally {
      setGenerating(false);
    }
  }

  function mockSchedule(a) {
    const occ = (a?.occupation || "").toLowerCase();
    if (occ.includes("surgeon") || occ.includes("doctor")) return [
      { day:"Mon–Tue", activity:"OR — surgery", time:"06:30–18:00" },
      { day:"Wed",     activity:"Clinic",        time:"08:00–16:00" },
      { day:"Thu",     activity:"Research",      time:"09:00–17:00" },
      { day:"Fri",     activity:"Flexible",      time:"08:00–14:00" },
      { day:"Sat–Sun", activity:"Personal",      time:"Free" },
    ];
    return [
      { day:"Mon–Fri", activity:a?.occupation || "Work", time:"09:00–17:00" },
      { day:"Sat–Sun", activity:"Personal",               time:"Free" },
    ];
  }

  useEffect(() => {
    setState(p => ({ ...p, fromWeek }));
  }, [fromWeek]);

  return (
    <div style={CARD}>
      <div style={{ ...S.serif, fontSize:22, fontWeight:500, color:"#1a1814", marginBottom:4 }}>Schedule</div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:20 }}>
        Generate a schedule template based on {actor?.first_name || actor?.name}'s profile
      </p>

      {!schedule ? (
        <div style={{ textAlign:"center", padding:"2rem 0" }}>
          <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:16 }}>
            No schedule yet — generate one based on occupation and psychology
          </p>
          <button onClick={generateSchedule} disabled={generating}
            style={{ ...S.sans, fontSize:13, padding:"10px 28px", borderRadius:10, border:"none", background:"#1a1814", color:"#faf8f4", cursor:"pointer", opacity: generating ? .6 : 1 }}>
            {generating ? "Generating…" : "Generate schedule"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:20 }}>
            {schedule.map((s, i) => (
              <div key={i} style={{ background:"rgba(0,0,0,.03)", border:"1px solid rgba(0,0,0,.06)", borderRadius:10, padding:"10px 12px" }}>
                <div style={{ ...S.mono, fontSize:10, color:"#a8a5a0", marginBottom:4, textTransform:"uppercase", letterSpacing:".08em" }}>{s.day}</div>
                <div style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{s.activity}</div>
                <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0", marginTop:2 }}>{s.time}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
            <div>
              <div style={{ ...S.label, marginBottom:6 }}>Roll out from week</div>
              <select value={fromWeek} onChange={e => setFromWeek(Number(e.target.value))}
                style={{ fontSize:13, padding:"6px 10px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"rgba(255,255,255,.7)" }}>
                {Array.from({length:52-currentWeek+1},(_,i)=>currentWeek+i).map(w => (
                  <option key={w} value={w}>Week {w}{w===currentWeek?" (now)":""} → week 52</option>
                ))}
              </select>
            </div>
            <button onClick={generateSchedule} disabled={generating}
              style={{ ...S.sans, fontSize:12, padding:"6px 14px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer", marginTop:18 }}>
              Regenerate
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Step 4: Media ─────────────────────────────────────────────────────────────
function StepMedia({ actor, state, setState }) {
  const [photos, setPhotos]           = useState([]);
  const [stateImages, setStateImages] = useState(state.stateImages || []);

  useEffect(() => {
    fetch(`/api/actors/${actor.id}/media`).then(r => r.ok ? r.json() : []).then(d => {
      setPhotos(d.filter(m => m.media_type === "profile_photo"));
      const existing = d.filter(m => m.media_type === "state_image").map(m => ({ slug:m.slug, path:m.path, hasImage:true, idleAnim:null, activeAnim:null }));
      const fromSchedule = (state.schedule || []).filter(s => s.activity !== "Personal" && s.activity !== "Free").map(s => ({
        slug: s.activity.toLowerCase().replace(/[^a-z0-9]+/g,"_"),
        label: s.activity,
        hasImage: false, idleAnim: null, activeAnim: null,
      }));
      const merged = fromSchedule.map(fs => existing.find(e => e.slug === fs.slug) || fs);
      setStateImages(merged);
      setState(p => ({ ...p, stateImages: merged }));
    }).catch(() => {});
  }, [actor.id]);

  return (
    <div style={CARD}>
      <div style={{ ...S.serif, fontSize:22, fontWeight:500, color:"#1a1814", marginBottom:4 }}>Media</div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:20 }}>Transfer portraits and generate state images and animations</p>

      {/* Portraits */}
      <div style={{ ...S.label, marginBottom:10 }}>Portrait photos · {photos.length} / 8</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:6, marginBottom:24 }}>
        {Array.from({length:8}).map((_, i) => {
          const p = photos[i];
          return (
            <div key={i} style={{ aspectRatio:"1", borderRadius:8, border:`1px ${p ? "solid" : "dashed"} ${p ? "rgba(29,158,117,.3)" : "rgba(0,0,0,.1)"}`, background: p ? "rgba(29,158,117,.08)" : "rgba(0,0,0,.03)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color: p ? "#0f6e56" : "#c8c5c0" }}>
              {p ? "✓" : "+"}
            </div>
          );
        })}
      </div>

      {/* State images & animations */}
      <div style={{ ...S.label, marginBottom:10 }}>State images & animations</div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {stateImages.map((si, i) => (
          <div key={si.slug} style={{ border:"1px solid rgba(0,0,0,.07)", borderRadius:10, overflow:"hidden" }}>
            {/* State image row */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 12px", background:"rgba(0,0,0,.02)" }}>
              <span style={{ ...S.sans, fontSize:13, fontWeight:500, color:"#1a1814" }}>{si.label || si.slug}</span>
              <div style={{ display:"flex", gap:6 }}>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(55,138,221,.3)", background:"rgba(55,138,221,.07)", color:"#185FA5", cursor:"pointer" }}>
                  Generate image
                </button>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>
                  Upload
                </button>
              </div>
            </div>
            {/* Idle animation */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 12px 7px 24px", borderTop:"1px solid rgba(0,0,0,.04)" }}>
              <span style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>↳ Idle animation</span>
              <div style={{ display:"flex", gap:6 }}>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(55,138,221,.3)", background:"rgba(55,138,221,.07)", color:"#185FA5", cursor:"pointer" }}>
                  Generate from image
                </button>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>
                  Upload
                </button>
              </div>
            </div>
            {/* Active animation */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 12px 7px 24px", borderTop:"1px solid rgba(0,0,0,.04)" }}>
              <span style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>↳ Active animation</span>
              <div style={{ display:"flex", gap:6 }}>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(55,138,221,.3)", background:"rgba(55,138,221,.07)", color:"#185FA5", cursor:"pointer" }}>
                  Generate from image
                </button>
                <button style={{ ...S.sans, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>
                  Upload
                </button>
              </div>
            </div>
          </div>
        ))}
        {stateImages.length === 0 && (
          <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>Complete the schedule step first to generate state image slots.</p>
        )}
      </div>
    </div>
  );
}

// ── Step 5: Review & Deploy ───────────────────────────────────────────────────
function StepDeploy({ actor, state, onDeploy, deploying }) {
  const rows = [
    ["Character",    actor?.name],
    ["World",        state.world?.name],
    ["Relationships", (state.relationships||[]).map(r => `${r.character.first_name || r.character.name} · ${r.labels.slice(0,2).join(" · ")}`).join(", ") || "None"],
    ["Schedule",     state.schedule ? `${state.schedule.length} blocks · week ${state.fromWeek} → 52` : "Not set"],
    ["Portraits",    `${(state.stateImages||[]).filter(s=>s.hasImage).length} ready`],
    ["Starting location", "Home"],
  ];
  return (
    <div style={CARD}>
      <div style={{ ...S.serif, fontSize:22, fontWeight:500, color:"#1a1814", marginBottom:4 }}>Review & deploy</div>
      <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0", marginBottom:20 }}>
        {actor?.first_name || actor?.name} will be spawned into {state.world?.name}
      </p>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
          <span style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>{label}</span>
          <span style={{ ...S.sans, fontSize:13, color:"#1a1814", fontWeight:500, textAlign:"right", maxWidth:360 }}>{value || "—"}</span>
        </div>
      ))}
      <div style={{ marginTop:20, padding:"12px 14px", background:"rgba(0,0,0,.03)", borderRadius:10 }}>
        <p style={{ ...S.sans, fontSize:12, color:"#a8a5a0", margin:0 }}>
          Once deployed, {actor?.first_name || actor?.name} will begin her schedule immediately. Seeded relationships will allow the world engine to generate natural encounters.
        </p>
      </div>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────
export default function DeployWizardPage() {
  const { id }       = useParams();
  const navigate     = useNavigate();
  const [step, setStep]     = useState(1);
  const [actor, setActor]   = useState(null);
  const [state, setState]   = useState({ world:null, relationships:[], schedule:null, fromWeek:1, stateImages:[] });
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    fetch(`/api/actors/${id}`).then(r => r.ok ? r.json() : null).then(d => setActor(d?.actor || d)).catch(() => {});
  }, [id]);

  function canProceed() {
    if (step === 1) return !!state.world;
    if (step === 3) return !!state.schedule;
    return true;
  }

  async function handleDeploy() {
    setDeploying(true);
    try {
      const res = await fetch(`/api/actors/${id}/deploy`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify(state),
      });
      if (res.ok) {
        navigate(`/actors`);
      }
    } catch {
      setDeploying(false);
    }
  }

  function next() {
    if (!canProceed()) return;
    if (step === 5) { handleDeploy(); return; }
    setStep(p => p + 1);
  }

  const stepLabels = ["", "Next →", "Next →", "Next →", "Next →", "Deploy"];

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={{ width:"100%", maxWidth:680, marginBottom:"1.5rem", display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={() => navigate(`/actors/${id}`)} style={{ ...S.sans, fontSize:12, padding:"6px 14px", borderRadius:8, border:"1px solid rgba(0,0,0,.1)", background:"none", color:"#6b6760", cursor:"pointer" }}>
          ← Cancel
        </button>
        <div style={{ ...S.serif, fontSize:26, fontWeight:500, color:"#1a1814" }}>
          Deploy {actor?.first_name || actor?.name}
        </div>
      </div>

      <StepBar current={step} />

      {step === 1 && <StepWorld       actor={actor} state={state} setState={setState} />}
      {step === 2 && <StepRelationships actor={actor} state={state} setState={setState} />}
      {step === 3 && <StepSchedule    actor={actor} state={state} setState={setState} />}
      {step === 4 && <StepMedia       actor={actor} state={state} setState={setState} />}
      {step === 5 && <StepDeploy      actor={actor} state={state} onDeploy={handleDeploy} deploying={deploying} />}

      <NavButtons
        step={step}
        onBack={() => setStep(p => Math.max(1, p-1))}
        onNext={next}
        nextLabel={stepLabels[step]}
        loading={deploying}
      />
    </div>
  );
}
