import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";

const STYLE_COLOR = {
  fearful_avoidant:  { bg: "rgba(55,138,221,.10)",  border: "rgba(55,138,221,.2)",  text: "#185fa5", init: "rgba(55,138,221,.15)" },
  avoidant_secure:   { bg: "rgba(29,158,117,.10)",  border: "rgba(29,158,117,.2)",  text: "#0f6e56", init: "rgba(29,158,117,.15)" },
  avoidant:          { bg: "rgba(29,158,117,.10)",  border: "rgba(29,158,117,.2)",  text: "#0f6e56", init: "rgba(29,158,117,.15)" },
  secure_anxious:    { bg: "rgba(176,92,8,.10)",    border: "rgba(176,92,8,.2)",    text: "#854f0b", init: "rgba(176,92,8,.15)"   },
  anxious:           { bg: "rgba(212,83,126,.10)",  border: "rgba(212,83,126,.2)",  text: "#993556", init: "rgba(212,83,126,.15)" },
  secure:            { bg: "rgba(99,153,34,.10)",   border: "rgba(99,153,34,.2)",   text: "#3b6d11", init: "rgba(99,153,34,.15)"  },
  default:           { bg: "rgba(136,135,128,.10)", border: "rgba(136,135,128,.2)", text: "#5f5e5a", init: "rgba(136,135,128,.15)"},
};

function sc(s) { return STYLE_COLOR[s] || STYLE_COLOR.default; }
function ini(name) { return name?.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase()||"?"; }

function Field({ label, value, tall, full }) {
  if (!value && value !== 0) return null;
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:5 }}>{label}</div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.55)", border:"1px solid rgba(0,0,0,.07)", borderRadius:8, padding: tall ? "10px 12px" : "8px 12px", lineHeight:1.6, whiteSpace: tall ? "pre-wrap" : "normal", maxWidth: full ? "100%" : 480 }}>{value}</div>
    </div>
  );
}

// ── Edit helpers ──────────────────────────────────────────────────────────────
function EField({ label, value, onChange, tall, full, type="text" }) {
  return (
    <div style={{ marginBottom:14, maxWidth: full ? "100%" : 480 }}>
      <label style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", display:"block", marginBottom:5 }}>{label}</label>
      {tall
        ? <textarea value={value||""} onChange={e=>onChange(e.target.value)} rows={4}
            style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.8)", border:"1px solid rgba(176,92,8,.25)", borderRadius:8, padding:"10px 12px", width:"100%", resize:"vertical", lineHeight:1.6, outline:"none" }} />
        : <input type={type} value={value||""} onChange={e=>onChange(e.target.value)}
            style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.8)", border:"1px solid rgba(176,92,8,.25)", borderRadius:8, padding:"8px 12px", width:"100%", outline:"none" }} />
      }
    </div>
  );
}

function ESelect({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", display:"block", marginBottom:5 }}>{label}</label>
      <select value={value||""} onChange={e=>onChange(e.target.value)}
        style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.8)", border:"1px solid rgba(176,92,8,.25)", borderRadius:8, padding:"8px 12px", width:"100%", outline:"none", appearance:"none" }}>
        {options.map(o => <option key={o.value||o} value={o.value||o}>{o.label||o}</option>)}
      </select>
    </div>
  );
}

function ESlider({ label, value, onChange, min=0, max=100 }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
      <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#6b6760", width:130, flexShrink:0 }}>{label}</span>
      <input type="range" min={min} max={max} value={value||0} onChange={e=>onChange(Number(e.target.value))} style={{ flex:1, accentColor:"#b05c08", height:4 }} />
      <span style={{ fontFamily:"'DM Mono',monospace,sans-serif", fontSize:12, color:"#b05c08", width:28, textAlign:"right" }}>{value||0}</span>
    </div>
  );
}

function InspireBtn({ fieldKey, label, context, onResult, disabled }) {
  const [loading, setLoading] = useState(false);
  async function go() {
    setLoading(true);
    try {
      const r = await fetch("/api/generate/profile", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ prompt:`${context}\n\nWrite a compelling "${label}" for this character. Return only the text — no labels, no JSON, 2-3 sentences max.` }),
      });
      const data = await r.json();
      let val = (data.text||"").trim().replace(/```json|```/gi,"").trim();
      try { const j=JSON.parse(val); val=j[fieldKey]||j.text||j.value||val; } catch {}
      onResult(val);
    } catch {}
    setLoading(false);
  }
  return (
    <button onClick={go} disabled={disabled||loading}
      style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".08em", textTransform:"uppercase", padding:"4px 10px", borderRadius:6, background:"rgba(176,92,8,.08)", border:"1px solid rgba(176,92,8,.2)", color:"#b05c08", cursor:"pointer", flexShrink:0 }}>
      {loading?"…":"✦ Inspire"}
    </button>
  );
}

function EFieldInspire({ label, fieldKey, value, onChange, tall, context }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:5 }}>
        <label style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" }}>{label}</label>
        <InspireBtn fieldKey={fieldKey} label={label} context={context} onResult={onChange} />
      </div>
      <textarea value={value||""} onChange={e=>onChange(e.target.value)} rows={tall?4:3}
        style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.8)", border:"1px solid rgba(176,92,8,.25)", borderRadius:8, padding:"10px 12px", width:"100%", resize:"vertical", lineHeight:1.6, outline:"none" }} />
    </div>
  );
}

function ScoreBar({ label, value, danger }) {
  const raw = value ?? 0;
  const v = Math.round(raw <= 1.0 && raw > 0 ? raw * 100 : raw);
  const color = danger && v > 70 ? "#c0392b" : danger && v > 50 ? "#b05c08" : "#6b6760";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#6b6760", width:130, flexShrink:0 }}>{label}</div>
      <div style={{ flex:1, height:4, background:"rgba(0,0,0,.08)", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${v}%`, height:"100%", background: color, borderRadius:2, transition:"width .4s" }} />
      </div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, fontWeight:500, color:"#1a1814", width:26, textAlign:"right" }}>{v}</div>
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function NavSection({ label }) {
  return <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".18em", textTransform:"uppercase", color:"#a8a5a0", padding:"10px 20px 4px" }}>{label}</div>;
}
function NavItem({ label, active, done, onClick }) {
  return (
    <div onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:8,
      padding:"8px 20px", cursor:"pointer",
      fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12,
      color: active ? "#1a1814" : "#6b6760",
      background: active ? "rgba(255,255,255,.5)" : "transparent",
      borderLeft: active ? "2px solid #b05c08" : "2px solid transparent",
      fontWeight: active ? 500 : 400,
      transition:"all .15s",
    }}>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0, background: done ? "#34c759" : "rgba(0,0,0,.12)" }} />
      {label}
    </div>
  );
}

// ── Panel: Identity ───────────────────────────────────────────────────────────
function IdentityPanel({ d, editing, setEditData }) {
  const { actor: a, psychology: p } = d;
  const upd = (path, val) => setEditData(prev => {
    const n = {...prev};
    const parts = path.split(".");
    let obj = n;
    for (let i=0; i<parts.length-1; i++) obj = obj[parts[i]] = {...obj[parts[i]]};
    obj[parts[parts.length-1]] = val;
    return n;
  });
  if (!editing) return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      <Field label="First name"        value={a?.first_name} />
      <Field label="Last name"         value={a?.last_name} />
      <Field label="Age"               value={a?.age} />
      <Field label="Gender"            value={a?.gender} />
      <Field label="Occupation"        value={a?.occupation} />
      <Field label="Orientation"       value={p?.orientation} />
      <Field label="Marital status"    value={p?.marital_status} />
      <Field label="View on intimacy"  value={p?.view_on_sex} full tall />
      <Field label="Appearance"        value={a?.appearance} tall full />
    </div>
  );
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <EField label="First name"  value={a?.first_name} onChange={v=>upd("actor.first_name",v)} />
        <EField label="Last name"   value={a?.last_name}  onChange={v=>{upd("actor.last_name",v); upd("actor.name",((a?.first_name||"")+" "+v).trim());}} />
        <EField label="Age"         value={a?.age}        onChange={v=>upd("actor.age",v)} type="number" />
        <ESelect label="Gender" value={a?.gender} onChange={v=>upd("actor.gender",v)} options={["female","male","neutral"]} />
        <EField label="Occupation" value={a?.occupation} onChange={v=>upd("actor.occupation",v)} />
        <ESelect label="Orientation" value={p?.orientation} onChange={v=>upd("psychology.orientation",v)}
          options={["straight","bisexual","gay","pansexual","asexual"]} />
        <ESelect label="Marital status" value={p?.marital_status} onChange={v=>upd("psychology.marital_status",v)}
          options={["single","casually_dating","in_relationship","married","separated","divorced","widowed"]} />
      </div>
      <EField label="View on intimacy" value={p?.view_on_sex} onChange={v=>upd("psychology.view_on_sex",v)} tall full />
      <EField label="Appearance"       value={a?.appearance}  onChange={v=>upd("actor.appearance",v)}  tall full />
    </div>
  );
}

// ── Panel: Psychological profile ──────────────────────────────────────────────
function PsychPanel({ d, editing, setEditData }) {
  const { psychology: p, upbringing: u, education: ed, actor: a } = d;
  const upd = (key, val) => setEditData(prev => ({...prev, psychology:{...prev.psychology,[key]:val}}));
  const ctx = `Character: ${a?.name||"unknown"}, ${a?.age||"?"}yo, ${a?.gender||""}, ${a?.occupation||""}. ${Object.entries(p||{}).filter(([k,v])=>v&&["wound","backstory","what_they_want","blindspot"].includes(k)).map(([k,v])=>`${k}: ${v}`).join(". ")}`;

  if (!editing) return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      {u && <>
        <Field label="Childhood region"     value={u.childhood_region} />
        <Field label="Background"           value={u.socioeconomic_background} />
        <Field label="Family education"     value={u.family_education_level} />
        <Field label="Upbringing note"      value={u.upbringing_note} full tall />
      </>}
      {ed?.length > 0 && ed.map((e,i) => (
        <Field key={i} label={`Education ${i+1}`} value={[e.level,e.field,e.institution].filter(Boolean).join(" · ")} />
      ))}
      <div style={{ gridColumn:"1/-1", height:1, background:"rgba(0,0,0,.06)", margin:"4px 0" }} />
      <Field label="Backstory"      value={p?.backstory}             full tall />
      <Field label="Wound"          value={p?.wound}                 full tall />
      <Field label="What they want" value={p?.what_they_want}        full tall />
      <Field label="Blind spot"     value={p?.blindspot}             full tall />
      <Field label="Contradiction"  value={p?.contradiction}         full tall />
      <Field label="Defenses"       value={p?.defenses}              full tall />
      <Field label="Coping"         value={p?.coping_mechanisms}     full tall />
      <Field label="Self view"      value={p?.self_view}             tall />
      <Field label="Others view"    value={p?.others_view}           tall />
      <Field label="Family model"   value={p?.family_model}          full tall />
      <Field label="Relationship read pattern" value={p?.relationship_read_pattern} full tall />
    </div>
  );
  return (
    <div>
      {[
        { key:"backstory",              label:"Backstory" },
        { key:"wound",                  label:"The Wound" },
        { key:"what_they_want",         label:"What They Actually Want" },
        { key:"blindspot",              label:"The Blind Spot" },
        { key:"contradiction",          label:"The Contradiction" },
        { key:"defenses",               label:"Defenses" },
        { key:"coping_mechanisms",      label:"Coping Mechanisms" },
        { key:"family_model",           label:"Family Model" },
        { key:"relationship_read_pattern", label:"How They Read Relationships" },
      ].map(f => (
        <EFieldInspire key={f.key} fieldKey={f.key} label={f.label} value={p?.[f.key]} onChange={v=>upd(f.key,v)} tall context={ctx} />
      ))}
    </div>
  );
}

// ── Panel: Personality / Assessments ─────────────────────────────────────────
function AssessmentsPanel({ d, editing, setEditData, actorId }) {
  const { big5: b, disc: dc, hds: h, psychology: p } = d;
  const updB  = (k,v) => setEditData(prev => ({...prev, big5:{...prev.big5,[k]:v}}));
  const updD  = (k,v) => setEditData(prev => ({...prev, disc:{...prev.disc,[k]:v}}));
  const updH  = (k,v) => setEditData(prev => ({...prev, hds:{...prev.hds,[k]:v}}));
  const updP  = (k,v) => setEditData(prev => ({...prev, psychology:{...prev.psychology,[k]:v}}));

  const secLabel = (label, extra) => (
    <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
      <span>{label}</span>{extra}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>

      {/* Run assessments button */}
      <div style={{ background:"rgba(176,92,8,0.06)", border:"1px solid rgba(176,92,8,0.15)", borderRadius:12, padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#6b6760" }}>Run the full assessment pipeline to regenerate all scores from character context.</div>
        <button onClick={() => window.location.href=`/actors/${actorId}?tab=assessments&run=1`}
          style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", padding:"8px 18px", borderRadius:8, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer", flexShrink:0, marginLeft:16 }}>
          Run assessments →
        </button>
      </div>

      {/* Attachment style */}
      <div>
        {editing
          ? <ESelect label="Attachment style" value={p?.attachment_style} onChange={v=>updP("attachment_style",v)}
              options={["secure","anxious","avoidant","fearful_avoidant","avoidant_secure"]} />
          : <Field label="Attachment style" value={p?.attachment_style?.replace(/_/g," ")} />
        }
      </div>

      {/* Big Five */}
      {(b || editing) && (
        <div>
          {secLabel("Big Five (OCEAN)")}
          {editing
            ? ["openness","conscientiousness","extraversion","agreeableness","neuroticism"].map(k => (
                <ESlider key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={b?.[k]||50} onChange={v=>updB(k,v)} />
              ))
            : <>
                <ScoreBar label="Openness"          value={b?.openness} />
                <ScoreBar label="Conscientiousness" value={b?.conscientiousness} />
                <ScoreBar label="Extraversion"      value={b?.extraversion} />
                <ScoreBar label="Agreeableness"     value={b?.agreeableness} />
                <ScoreBar label="Neuroticism"       value={b?.neuroticism} danger />
              </>
          }
        </div>
      )}

      {/* DISC */}
      {(dc || editing) && (
        <div>
          {secLabel("DISC")}
          {editing
            ? [["d","Dominance"],["i","Influence"],["s","Steadiness"],["c","Conscientiousness"]].map(([k,l]) => (
                <ESlider key={k} label={l} value={dc?.[k]||50} onChange={v=>updD(k,v)} />
              ))
            : <>
                <ScoreBar label="Dominance"  value={dc?.d} />
                <ScoreBar label="Influence"  value={dc?.i} />
                <ScoreBar label="Steadiness" value={dc?.s} />
                <ScoreBar label="Compliance" value={dc?.c} />
              </>
          }
        </div>
      )}

      {/* HDS */}
      {(h || editing) && (
        <div>
          {secLabel("Hogan HDS — dark side under stress")}
          {editing
            ? ["bold","cautious","colorful","diligent","dutiful","excitable","imaginative","leisurely","mischievous","reserved","skeptical"].map(k => (
                <ESlider key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={h?.[k]||30} onChange={v=>updH(k,v)} />
              ))
            : ["bold","cautious","colorful","diligent","dutiful","excitable","imaginative","leisurely","mischievous","reserved","skeptical"].filter(k => h?.[k] != null).map(k => (
                <ScoreBar key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={h[k]} danger />
              ))
          }
        </div>
      )}
    </div>
  );
}

// ── Panel: Mental Health ──────────────────────────────────────────────────────
function MentalPanel({ d }) {
  const { mental: m, diagnoses: dx } = d;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {m && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Risk profile</div>
          {["depression_risk","anxiety_risk","substance_risk","isolation_risk","identity_fragility","crisis_threshold","obsessive_tendency"].filter(k => m[k] != null).map(k => (
            <ScoreBar key={k} label={k.replace(/_/g," ")} value={m[k]} danger />
          ))}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginTop:14 }}>
            <Field label="Risk note"          value={m.risk_note} full tall />
            <Field label="Protective factors" value={m.protective_factors} full tall />
          </div>
        </div>
      )}
      {dx?.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Diagnoses</div>
          {dx.map((diag,i) => (
            <div key={i} style={{ background:"rgba(255,255,255,.5)", border:"1px solid rgba(0,0,0,.07)", borderRadius:12, padding:"12px 14px", marginBottom:8 }}>
              <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, color:"#1a1814", marginBottom:4 }}>{diag.diagnosis}</div>
              <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#6b6760" }}>
                {diag.severity} · {diag.diagnosed ? "diagnosed" : "undiagnosed"} · {diag.medicated ? `medicated — ${diag.medication}` : "unmedicated"}
              </div>
              {diag.awareness && <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginTop:3 }}>Awareness: {diag.awareness}</div>}
              {diag.behavioral_note && <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#6b6760", marginTop:6, lineHeight:1.5 }}>{diag.behavioral_note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel: Lifestyle ──────────────────────────────────────────────────────────
function LifestylePanel({ d, editing, setEditData }) {
  const { lifestyle: l } = d;
  const upd = (k,v) => setEditData(prev => ({...prev, lifestyle:{...prev.lifestyle,[k]:v}}));
  if (!l && !editing) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>No lifestyle data</p>;
  if (!editing) return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      <Field label="Sleep pattern"     value={l?.sleep_pattern} />
      <Field label="Sleep quality"     value={l?.sleep_quality} />
      <Field label="Exercise"          value={l?.exercise_habit} />
      <Field label="Exercise type"     value={l?.exercise_type} />
      <Field label="Diet"              value={l?.diet} />
      <Field label="Social frequency"  value={l?.social_frequency} />
      <Field label="Alcohol"           value={l?.alcohol_relationship} />
      <Field label="Drug use"          value={l?.drug_use} />
      <Field label="Substance context" value={l?.substance_context} full tall />
      <Field label="Note"              value={l?.lifestyle_note} full tall />
    </div>
  );
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <ESelect label="Sleep pattern" value={l?.sleep_pattern} onChange={v=>upd("sleep_pattern",v)}
          options={["early_riser","normal","night_owl","irregular"]} />
        <ESelect label="Sleep quality" value={l?.sleep_quality} onChange={v=>upd("sleep_quality",v)}
          options={["good","variable","poor"]} />
        <ESelect label="Exercise habit" value={l?.exercise_habit} onChange={v=>upd("exercise_habit",v)}
          options={["sedentary","occasional","regular","athlete"]} />
        <EField label="Exercise type" value={l?.exercise_type} onChange={v=>upd("exercise_type",v)} />
        <EField label="Diet" value={l?.diet} onChange={v=>upd("diet",v)} />
        <ESelect label="Social frequency" value={l?.social_frequency} onChange={v=>upd("social_frequency",v)}
          options={["rarely","monthly","weekly","daily"]} />
        <ESelect label="Alcohol" value={l?.alcohol_relationship} onChange={v=>upd("alcohol_relationship",v)}
          options={["non_drinker","rare","moderate","regular","heavy"]} />
        <ESelect label="Drug use" value={l?.drug_use} onChange={v=>upd("drug_use",v)}
          options={["none","cannabis_occasional","cannabis_regular","mdma_occasional","cannabis_mdma","cocaine_occasional","mixed_recreational","prescription_only"]} />
      </div>
      <EField label="Substance context" value={l?.substance_context} onChange={v=>upd("substance_context",v)} tall full />
      <EField label="Lifestyle note"    value={l?.lifestyle_note}    onChange={v=>upd("lifestyle_note",v)}    tall full />
    </div>
  );
}

// ── Panel: Economic ───────────────────────────────────────────────────────────
function EconomicPanel({ d, editing, setEditData }) {
  const { economic: e, expenses: ex } = d;
  const upd = (k,v) => setEditData(prev => ({...prev, economic:{...prev.economic,[k]:v}}));
  if (!editing) return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {e && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
          <Field label="Financial situation" value={e.financial_situation} />
          <Field label="Income stability"    value={e.income_stability} />
          <Field label="Spending style"      value={e.spending_style} />
          <Field label="Attitude to wealth"  value={e.attitude_to_wealth} />
          <Field label="Savings habit"       value={e.savings_habit} />
          <Field label="Financial anxiety"   value={e.financial_anxiety != null ? Number(e.financial_anxiety).toFixed(2) : null} />
          <Field label="Monthly income"      value={e.monthly_income_sek ? `${Number(e.monthly_income_sek).toLocaleString()} SEK` : null} />
          <Field label="Behavior note"       value={e.behavior_note} full tall />
        </div>
      )}
      {ex?.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:12 }}>Expense defaults</div>
          {ex.map((exp,i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.06)" }}>
              <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814" }}>{exp.name}</span>
              <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0" }}>
                {exp.category} · {exp.monthly_budget_ore ? `${Math.round(exp.monthly_budget_ore/100).toLocaleString()} SEK/mo` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <ESelect label="Financial situation" value={e?.financial_situation} onChange={v=>upd("financial_situation",v)}
          options={["struggling","precarious","stable","comfortable","wealthy"]} />
        <ESelect label="Income stability" value={e?.income_stability} onChange={v=>upd("income_stability",v)}
          options={["unemployed","freelance","stable","high_earner"]} />
        <ESelect label="Spending style" value={e?.spending_style} onChange={v=>upd("spending_style",v)}
          options={["frugal","balanced","spender","impulsive"]} />
        <ESelect label="Attitude to wealth" value={e?.attitude_to_wealth} onChange={v=>upd("attitude_to_wealth",v)}
          options={["indifferent","practical","aspirational","anxious"]} />
        <ESelect label="Savings habit" value={e?.savings_habit} onChange={v=>upd("savings_habit",v)}
          options={["none","minimal","moderate","disciplined"]} />
        <EField label="Monthly income (SEK)" value={e?.monthly_income_sek} onChange={v=>upd("monthly_income_sek",v)} type="number" />
      </div>
      <ESlider label={`Financial anxiety — ${Math.round((e?.financial_anxiety||0)*100)}%`}
        value={Math.round((e?.financial_anxiety||0)*100)} onChange={v=>upd("financial_anxiety",v/100)} />
      <EField label="Behavior note" value={e?.behavior_note} onChange={v=>upd("behavior_note",v)} tall full />
    </div>
  );
}

// ── Panel: Media ──────────────────────────────────────────────────────────────
const PHOTO_SLOTS = [
  { slug:"profile",        label:"Profile" },
  { slug:"photo_close",    label:"Close-up" },
  { slug:"photo_halfbody", label:"Half Body" },
  { slug:"photo_full_body",label:"Full Body" },
  { slug:"photo_side",     label:"Side" },
  { slug:"photo_behind",   label:"Behind" },
  { slug:"photo_bikini",   label:"Bikini" },
  { slug:"photo_intimate", label:"Intimate" },
];

function MediaPanel({ actorId }) {
  const [media, setMedia]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [uploading, setUploading] = useState(null);
  const fileRef = useRef(null);
  const activeSlotRef = useRef(null);
  const stateFileRef = useRef(null);

  async function resizeFile(file, maxPx) {
    return new Promise(res => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width*scale); c.height = Math.round(img.height*scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => res(new File([b], "img.jpg", {type:"image/jpeg"})), "image/jpeg", 0.88);
      };
      img.onerror = () => res(file);
      img.src = url;
    });
  }

  async function uploadStateImage(file) {
    const slug = window.prompt("State image name (must match simulator activity slug):", file.name.replace(/\.\w+$/, "").toLowerCase().replace(/\s+/g,"_"));
    if (!slug) return;
    setUploading("state_"+slug);
    const resized = await resizeFile(file, 800);
    const fd = new FormData();
    fd.append("photo", resized);
    fd.append("state_slug", slug);
    fd.append("media_type", "state_image");
    fd.append("filename", slug+".jpg");
    const r = await fetch(`/api/actors/${actorId}/media`, { method:"POST", body:fd });
    const d = await r.json();
    setMedia(prev => [...prev, { id:d.id, media_type:"state_image", state_slug:slug, url:d.url, filename:d.filename }]);
    setUploading(null);
  }

  useEffect(() => {
    if (!actorId) return;
    fetch(`/api/actors/${actorId}/media`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { setMedia(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [actorId]);

  async function uploadSlot(slug, file) {
    if (!file) return;
    setUploading(slug);
    // Resize to 1200px before upload
    const resized = await new Promise(res => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 1200, scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => res(new File([b], slug+".jpg", {type:"image/jpeg"})), "image/jpeg", 0.88);
      };
      img.onerror = () => res(file);
      img.src = url;
    });
    const fd = new FormData();
    fd.append("photo", resized);
    fd.append("state_slug", slug);
    fd.append("media_type", "photo");
    fd.append("filename", slug+".jpg");
    const r = await fetch(`/api/actors/${actorId}/media`, { method:"POST", body:fd });
    const d = await r.json();
    setMedia(prev => {
      const filtered = prev.filter(m => !(m.media_type==="photo" && m.state_slug===slug));
      return [...filtered, { id:d.id, media_type:"photo", state_slug:slug, url:d.url, filename:d.filename }];
    });
    setUploading(null);
  }

  async function deleteMedia(mediaId, slug) {
    if (!window.confirm(`Delete ${slug?.replace(/_/g," ")} photo?`)) return;
    await fetch(`/api/actors/${actorId}/media/${mediaId}`, { method:"DELETE" });
    setMedia(prev => prev.filter(m => m.id !== mediaId));
  }

  const photos = media.filter(m => m.media_type === "photo");
  const states = media.filter(m => m.media_type === "state_image");
  const animations = media.filter(m => m.media_type === "animation");
  const photoBySlug = Object.fromEntries(photos.map(m => [m.state_slug, m]));

  if (loading) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Loading media...</p>;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:28 }}>

      {/* Portrait photo slots */}
      <div>
        <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Portrait photos</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, maxWidth:480 }}>
          {PHOTO_SLOTS.map(slot => {
            const existing = photoBySlug[slot.slug];
            return (
              <div key={slot.slug}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) uploadSlot(slot.slug, f); }}
                onClick={() => { if (!existing) { activeSlotRef.current = slot.slug; fileRef.current?.click(); }}}
                style={{ border:`1px dashed ${existing?"rgba(176,92,8,0.4)":"rgba(0,0,0,0.12)"}`, borderRadius:10, overflow:"hidden", aspectRatio:"3/4", position:"relative", cursor:existing?"default":"pointer", background:"rgba(255,255,255,0.5)" }}>
                {uploading===slot.slug && (
                  <div style={{ position:"absolute", inset:0, background:"rgba(255,255,255,0.8)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#b05c08" }}>uploading…</div>
                )}
                {existing ? (<>
                  <img src={existing.url} alt={slot.label} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
                  <div style={{ position:"absolute", bottom:0, left:0, right:0, background:"rgba(0,0,0,0.5)", padding:"4px 6px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <span style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#fff", letterSpacing:"0.08em", textTransform:"uppercase" }}>{slot.label}</span>
                    <div style={{ display:"flex", gap:4 }}>
                      <button onClick={e => { e.stopPropagation(); activeSlotRef.current = slot.slug; fileRef.current?.click(); }}
                        style={{ background:"rgba(255,255,255,0.2)", border:"none", borderRadius:4, padding:"2px 5px", cursor:"pointer", color:"#fff", fontSize:9 }}>↺</button>
                      <button onClick={e => { e.stopPropagation(); deleteMedia(existing.id, slot.slug); }}
                        style={{ background:"rgba(192,57,43,0.6)", border:"none", borderRadius:4, padding:"2px 5px", cursor:"pointer", color:"#fff", fontSize:9 }}>✕</button>
                    </div>
                  </div>
                </>) : (
                  <div style={{ width:"100%", height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4 }}>
                    <div style={{ fontSize:18, opacity:.2 }}>+</div>
                    <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#a8a5a0", letterSpacing:"0.1em", textTransform:"uppercase" }}>{slot.label}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }}
          onChange={e => { const f = e.target.files[0]; if (f && activeSlotRef.current) uploadSlot(activeSlotRef.current, f); e.target.value=""; }} />
      </div>

      {/* State images — editable */}
      <div>
        <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:6 }}>State images</div>
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginBottom:14 }}>Activity images used by the simulator. Names must match simulator activity slugs.</div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10, marginBottom:12 }}>
          {states.map(m => (
            <StateImageCard key={m.id} m={m} actorId={actorId}
              onDeleted={id => setMedia(prev => prev.filter(x => x.id !== id))}
              onRenamed={(id, newSlug) => setMedia(prev => prev.map(x => x.id===id ? {...x, state_slug:newSlug} : x))}
            />
          ))}

          {/* Upload new state image */}
          <div
            onClick={() => { stateFileRef.current?.click(); }}
            onDragOver={e => e.preventDefault()}
            onDrop={async e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) uploadStateImage(f); }}
            style={{ border:"1px dashed rgba(0,0,0,0.12)", borderRadius:10, aspectRatio:"1/1", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4, cursor:"pointer", background:"rgba(255,255,255,0.5)" }}>
            <div style={{ fontSize:20, opacity:.2 }}>+</div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#a8a5a0", letterSpacing:"0.1em", textTransform:"uppercase" }}>Add state</div>
          </div>
        </div>
        <input ref={stateFileRef} type="file" accept="image/*" style={{ display:"none" }}
          onChange={e => { const f = e.target.files[0]; if (f) uploadStateImage(f); e.target.value=""; }} />
      </div>

      {/* ── State animations ── */}
      <StateAnimationsSection actorId={actorId} animations={animations}
        onUploaded={m => setMedia(prev => [...prev, m])}
        onDeleted={id => setMedia(prev => prev.filter(x => x.id !== id))} />

    </div>
  );
}

// ── StateAnimationsSection ────────────────────────────────────────────────────
// ── VideoThumb — top-level to satisfy Rules of Hooks ─────────────────────────
function VideoThumb({ url, onClick }) {
  const [thumb, setThumb] = useState(null);
  useEffect(() => {
    const v = document.createElement("video");
    v.src = url; v.crossOrigin = "anonymous"; v.preload = "metadata";
    v.onloadeddata = () => { v.currentTime = 0.5; };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 180;
      const ctx = c.getContext("2d");
      const vw = v.videoWidth||240, vh = v.videoHeight||180;
      const scale = Math.max(c.width/vw, c.height/vh);
      const sw = c.width/scale, sh = c.height/scale;
      ctx.drawImage(v, (vw-sw)/2, (vh-sh)/2, sw, sh, 0, 0, c.width, c.height);
      setThumb(c.toDataURL("image/jpeg", 0.8));
    };
  }, [url]);
  return (
    <div onClick={onClick} style={{ width:"100%", height:"100%", position:"relative", cursor:"pointer" }}>
      {thumb
        ? <img src={thumb} style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
        : <div style={{ width:"100%", height:"100%", background:"rgba(0,0,0,0.05)", display:"flex", alignItems:"center", justifyContent:"center" }}><div style={{ fontSize:18, opacity:.2 }}>▶</div></div>
      }
      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(0,0,0,0.45)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ fontSize:14, color:"#fff", marginLeft:2 }}>▶</div>
        </div>
      </div>
    </div>
  );
}

// ── AnimSlot — top-level to satisfy Rules of Hooks ────────────────────────────
function AnimSlot({ stateName, type, bySlug, uploading, uploadTarget, idleFileRef, talkFileRef, setPlaying, deleteAnim }) {
  const slug = `${stateName}_${type}`;
  const m    = bySlug[slug];
  const busy = uploading === slug;
  const fileRef = type === "idle" ? idleFileRef : talkFileRef;
  return (
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#a8a5a0", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4, textAlign:"center" }}>{type}</div>
      <div
        onClick={() => { if (!m) { uploadTarget.current = { stateName, type }; fileRef.current?.click(); } else setPlaying({ url:m.url, title:slug.replace(/_/g," ") }); }}
        style={{ border:`1px ${m?"solid rgba(176,92,8,0.3)":"dashed rgba(0,0,0,0.12)"}`, borderRadius:8, aspectRatio:"4/3", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", cursor:"pointer", background:m?"rgba(176,92,8,0.04)":"rgba(255,255,255,0.5)", position:"relative", overflow:"hidden" }}>
        {busy ? (
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#b05c08" }}>uploading…</div>
        ) : m ? (<>
          <VideoThumb url={m.url} onClick={() => setPlaying({ url:m.url, title:slug.replace(/_/g," ") })} />
          <button onClick={e=>{e.stopPropagation();deleteAnim(m.id,slug);}}
            style={{ position:"absolute",top:4,right:4,width:16,height:16,borderRadius:"50%",background:"rgba(192,57,43,0.7)",border:"none",cursor:"pointer",color:"#fff",fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",zIndex:2 }}>✕</button>
          <button onClick={e=>{e.stopPropagation();uploadTarget.current={stateName,type};fileRef.current?.click();}}
            style={{ position:"absolute",top:4,left:4,width:16,height:16,borderRadius:"50%",background:"rgba(0,0,0,0.4)",border:"none",cursor:"pointer",color:"#fff",fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",zIndex:2 }}>↺</button>
        </>) : (<>
          <div style={{ fontSize:16, opacity:.2 }}>+</div>
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:8, color:"#a8a5a0", marginTop:2 }}>upload</div>
        </>)}
      </div>
    </div>
  );
}

function StateAnimationsSection({ actorId, animations, onUploaded, onDeleted }) {
  const [playing, setPlaying]     = useState(null);
  const [uploading, setUploading] = useState(null);
  const idleFileRef   = useRef(null);
  const talkFileRef   = useRef(null);
  const uploadTarget  = useRef(null);

  const stateNames = [...new Set(animations.map(a => a.state_slug?.replace(/_idle$|_talking$/, "")))].sort();
  const bySlug = Object.fromEntries(animations.map(a => [a.state_slug, a]));

  async function uploadAnim(stateName, type, file) {
    const slug = `${stateName}_${type}`;
    setUploading(slug);
    const fd = new FormData();
    fd.append("photo", file);
    fd.append("state_slug", slug);
    fd.append("media_type", "animation");
    fd.append("filename", `${slug}.mp4`);
    const r = await fetch(`/api/actors/${actorId}/media`, { method:"POST", body:fd });
    const d = await r.json();
    onUploaded({ id:d.id, media_type:"animation", state_slug:slug, url:d.url, filename:d.filename });
    setUploading(null);
  }

  async function deleteAnim(id, slug) {
    if (!window.confirm(`Delete animation "${slug}"?`)) return;
    await fetch(`/api/actors/${actorId}/media/${id}`, { method:"DELETE" });
    onDeleted(id);
  }

  return (<>
    <div>
      <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:6 }}>State animations</div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginBottom:16 }}>Idle loops while inactive. Talking plays during speech. Paired per state.</div>

      {stateNames.length === 0 && (
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>No animations uploaded yet.</div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px,1fr))", gap:16 }}>
        {stateNames.map(stateName => (
          <div key={stateName} style={{ background:"rgba(255,255,255,0.6)", border:"1px solid rgba(0,0,0,0.06)", borderRadius:12, padding:"12px 12px 10px" }}>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#6b6760", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>{stateName.replace(/_/g," ")}</div>
            <div style={{ display:"flex", gap:8 }}>
              <AnimSlot stateName={stateName} type="idle"    bySlug={bySlug} uploading={uploading} uploadTarget={uploadTarget} idleFileRef={idleFileRef} talkFileRef={talkFileRef} setPlaying={setPlaying} deleteAnim={deleteAnim} />
              <AnimSlot stateName={stateName} type="talking" bySlug={bySlug} uploading={uploading} uploadTarget={uploadTarget} idleFileRef={idleFileRef} talkFileRef={talkFileRef} setPlaying={setPlaying} deleteAnim={deleteAnim} />
            </div>
          </div>
        ))}

        {/* Add new animation pair */}
        <div
          onClick={() => {
            const name = window.prompt("State name (e.g. home_coffee):");
            if (!name) return;
            uploadTarget.current = { stateName: name.toLowerCase().replace(/\s+/g,"_"), type:"idle" };
            idleFileRef.current?.click();
          }}
          style={{ border:"1px dashed rgba(0,0,0,0.1)", borderRadius:12, minHeight:120, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6, cursor:"pointer", background:"rgba(255,255,255,0.3)" }}>
          <div style={{ fontSize:20, opacity:.2 }}>+</div>
          <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, color:"#a8a5a0", letterSpacing:"0.1em", textTransform:"uppercase" }}>Add state pair</div>
        </div>
      </div>

      <input ref={idleFileRef}   type="file" accept="video/mp4,video/*" style={{ display:"none" }}
        onChange={e => { const f=e.target.files[0]; if(f&&uploadTarget.current) uploadAnim(uploadTarget.current.stateName,"idle",f); e.target.value=""; }} />
      <input ref={talkFileRef}   type="file" accept="video/mp4,video/*" style={{ display:"none" }}
        onChange={e => { const f=e.target.files[0]; if(f&&uploadTarget.current) uploadAnim(uploadTarget.current.stateName,"talking",f); e.target.value=""; }} />
    </div>

    {/* Video player popup */}
    {playing && (
      <div onClick={()=>setPlaying(null)} style={{ position:"fixed",inset:0,zIndex:2000,background:"rgba(0,0,0,0.85)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16 }}>
        <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"rgba(255,255,255,0.7)",letterSpacing:"0.1em",textTransform:"uppercase" }}>{playing.title}</div>
        <video src={playing.url} controls autoPlay loop
          onClick={e=>e.stopPropagation()}
          style={{ maxWidth:"min(480px,90vw)",maxHeight:"70vh",borderRadius:12,border:"1px solid rgba(255,255,255,0.1)" }} />
        <button onClick={()=>setPlaying(null)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"rgba(255,255,255,0.5)",background:"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"7px 20px",cursor:"pointer" }}>Close</button>
      </div>
    )}
  </>);
}

// ── StateImageCard ────────────────────────────────────────────────────────────
function StateImageCard({ m, actorId, onDeleted, onRenamed }) {
  const [editing, setEditing] = useState(false);
  const [slug, setSlug]       = useState(m.state_slug || "");

  async function saveRename() {
    if (!slug || slug === m.state_slug) { setEditing(false); return; }
    // Update DB slug via rename endpoint
    await fetch(`/api/actors/${actorId}/media/${m.id}/rename`, {
      method:"PATCH", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ state_slug: slug }),
    });
    onRenamed(m.id, slug);
    setEditing(false);
  }

  async function handleDelete() {
    if (!window.confirm(`Delete state image "${m.state_slug}"?`)) return;
    await fetch(`/api/actors/${actorId}/media/${m.id}`, { method:"DELETE" });
    onDeleted(m.id);
  }

  return (
    <div style={{ position:"relative", borderRadius:10, overflow:"hidden", border:"1px solid rgba(0,0,0,.07)" }}>
      <img src={m.url} alt={m.state_slug} style={{ width:"100%", aspectRatio:"1/1", objectFit:"cover", display:"block" }} />
      <div style={{ padding:"5px 6px", background:"rgba(255,255,255,0.95)", borderTop:"1px solid rgba(0,0,0,.06)" }}>
        {editing ? (
          <div style={{ display:"flex", gap:4 }}>
            <input value={slug} onChange={e=>setSlug(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") saveRename(); if(e.key==="Escape") setEditing(false); }}
              autoFocus
              style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#1a1814", border:"1px solid rgba(176,92,8,0.3)", borderRadius:4, padding:"2px 5px", flex:1, outline:"none" }} />
            <button onClick={saveRename} style={{ fontSize:10, background:"#b05c08", color:"#fff", border:"none", borderRadius:4, padding:"2px 5px", cursor:"pointer" }}>✓</button>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:4 }}>
            <span onClick={()=>setEditing(true)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#6b6760", cursor:"pointer", flex:1, textOverflow:"ellipsis", overflow:"hidden", whiteSpace:"nowrap" }} title="Click to rename">
              {m.state_slug?.replace(/_/g," ")}
            </span>
            <div style={{ display:"flex", gap:3, flexShrink:0 }}>
              <button onClick={()=>setEditing(true)} style={{ fontSize:9, background:"none", border:"1px solid rgba(0,0,0,.1)", borderRadius:3, padding:"1px 5px", cursor:"pointer", color:"#a8a5a0" }}>✎</button>
              <button onClick={handleDelete} style={{ fontSize:9, background:"none", border:"1px solid rgba(192,57,43,.2)", borderRadius:3, padding:"1px 5px", cursor:"pointer", color:"#c0392b" }}>✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── FoldableSection ───────────────────────────────────────────────────────────
function FoldableSection({ label, S, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div onClick={() => setOpen(p => !p)}
        style={{ display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", marginBottom: open ? 12 : 0, userSelect:"none" }}>
        <div style={{ ...S.label }}>{label}</div>
        <span style={{ ...S.sans, fontSize:12, color:"#a8a5a0" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && children}
    </div>
  );
}

// ── MemoryList ────────────────────────────────────────────────────────────────
function MemoryList({ mems, expanded, setExpanded, S }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      {mems.map(m => {
        const isExp = expanded[m.id];
        const isHeavy = m.wound_resonance || (m.emotional_weight||0) > 0.7;
        const wc = m.weight==="core"?"#c0392b":m.weight==="strong"?"#b05c08":"#a8a5a0";
        const tag = m.emotional_tag ? m.emotional_tag.split(/(?=[A-Z])/).slice(0,2).join(" · ").toLowerCase() : null;
        return (
          <div key={m.id} onClick={() => setExpanded(p=>({...p,[m.id]:!p[m.id]}))}
            style={{ padding:"10px 14px", background:"rgba(255,255,255,0.6)", border:`1px solid ${isHeavy?"rgba(176,92,8,0.2)":"rgba(0,0,0,0.05)"}`, borderRadius:10, cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              {tag && <span style={{ ...S.sans, fontSize:9, letterSpacing:".08em", textTransform:"uppercase", color:wc, flexShrink:0 }}>{tag}</span>}
              <span style={{ ...S.sans, fontSize:12, color:"#1a1814", flex:1, lineHeight:1.5 }}>
                {m.summary || (m.content||"").slice(0,120)+((m.content||"").length>120?"…":"")}
              </span>
              {m.other_name && <span style={{ ...S.sans, fontSize:10, color:"#a8a5a0", flexShrink:0 }}>{m.other_name.split(" ")[0]}</span>}
              {isHeavy && <span>⚡</span>}
              <span style={{ ...S.mono, fontSize:9, color:"#c8c5c0", flexShrink:0 }}>{m.inserted_at?.slice(0,10)}</span>
              <span style={{ ...S.sans, fontSize:10, color:"#c8c5c0" }}>{isExp?"▲":"▼"}</span>
            </div>
            {isExp && (
              <div style={{ ...S.sans, fontSize:12, color:"#3d3b37", lineHeight:1.7, borderTop:"1px solid rgba(0,0,0,0.06)", paddingTop:8, marginTop:8 }}>
                {m.content}
                <div style={{ display:"flex", gap:12, marginTop:6 }}>
                  <span style={{ fontSize:10, color:"#a8a5a0" }}>{m.weight} · {m.memory_type}</span>
                  {m.emotional_weight && <span style={{ fontSize:10, color:"#a8a5a0" }}>{Math.round(m.emotional_weight*100)}%</span>}
                  <span style={{ fontSize:10, color:"#a8a5a0", marginLeft:"auto" }}>{m.inserted_at?.slice(0,10)}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Panel: In Play ────────────────────────────────────────────────────────────
function InPlayPanel({ actorId }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [expanded, setExpanded]   = useState({});
  const [openWorlds, setOpenWorlds] = useState({});

  useEffect(() => {
    fetch(`/api/actors/${actorId}/in-play`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setData(d);
        setOpenWorlds({});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [actorId]);

  if (loading) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!data?.data?.length) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Not deployed to any world yet.</p>;

  const isOwner = data.is_owner;
  const S = {
    label: { fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" },
    serif: { fontFamily:"'Cormorant Garamond',Georgia,serif" },
    sans:  { fontFamily:"'DM Sans',system-ui,sans-serif" },
    mono:  { fontFamily:"'DM Mono',monospace" },
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {data.data.map((world, idx) => {
        const wkey = world.world_id || idx;
        const isOpen = !!openWorlds[wkey];
        const rels = world.relationships || [];
        const mems = world.memories || [];

        const uniqueRels = Object.values(rels.reduce((acc, r) => {
          if (!acc[r.target_id] || (r.warmth||0) > (acc[r.target_id].warmth||0)) acc[r.target_id] = r;
          return acc;
        }, {}));

        const myActorId = world.my_actor_id;
        const allMemsSorted = [...mems].sort((a,b) => (b.inserted_at||"").localeCompare(a.inserted_at||""));
        console.log("myActorId:", myActorId, "total mems:", allMemsSorted.length, "sample other_actor_ids:", allMemsSorted.slice(0,5).map(m=>m.other_actor_id+"/"+m.other_type));
        const memsWithMe     = allMemsSorted.filter(m => myActorId && m.other_actor_id === myActorId);
        const memsWithOthers = allMemsSorted.filter(m => {
          if (!m.other_actor_id) return false;
          if (myActorId && m.other_actor_id === myActorId) return false;
          if (m.other_type === "player" || m.other_type === "user") return false;
          return true;
        });
        console.log("memsWithMe:", memsWithMe.length, "memsWithOthers:", memsWithOthers.length);

        return (
          <div key={wkey} style={{ background:"rgba(255,255,255,0.5)", border:"1px solid rgba(0,0,0,0.06)", borderRadius:14, overflow:"hidden" }}>

            {/* World header */}
            <div onClick={() => setOpenWorlds(p => ({...p, [wkey]: !p[wkey]}))}
              style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 18px", cursor:"pointer", borderBottom: isOpen?"1px solid rgba(0,0,0,0.06)":"none", userSelect:"none" }}>
              <div style={{ ...S.serif, fontSize:20, fontWeight:500, color:"#1a1814", flex:1 }}>{world.world_name}</div>
              {world.current_activity && <div style={{ ...S.sans, fontSize:11, color:"#a8a5a0" }}>{world.current_activity.replace(/_/g," ")}</div>}
              {isOwner && world.memory_counts && (
                <div style={{ display:"flex", gap:8 }}>
                  {["core","strong","medium","weak"].filter(w => world.memory_counts[w]).map(w => (
                    <span key={w} style={{ ...S.sans, fontSize:10, color: w==="core"?"#c0392b":w==="strong"?"#b05c08":"#a8a5a0" }}>{world.memory_counts[w]} {w}</span>
                  ))}
                </div>
              )}
              <span style={{ ...S.sans, fontSize:14, color:"#a8a5a0" }}>{isOpen?"▲":"▼"}</span>
            </div>

            {isOpen && (
              <div style={{ padding:"18px", display:"flex", flexDirection:"column", gap:24 }}>

                {/* Relationships */}
                {uniqueRels.length > 0 && (
                  <div>
                    <div style={{ ...S.label, marginBottom:12 }}>Relationships · {uniqueRels.length}</div>
                    {uniqueRels.map(r => (
                      <div key={r.target_id} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 12px", background:"rgba(255,255,255,0.6)", border:"1px solid rgba(0,0,0,0.05)", borderRadius:10, marginBottom:6 }}>
                        <div style={{ ...S.sans, fontSize:13, color:"#1a1814", width:140, flexShrink:0 }}>
                          {r.first_name || r.target_name?.split(" ")[0]}
                          {r.rel_type && <span style={{ fontSize:10, color:"#a8a5a0", marginLeft:6 }}>{r.rel_type.replace(/_/g," ")}</span>}
                        </div>
                        <div style={{ flex:1, display:"flex", gap:14, flexWrap:"wrap" }}>
                          {[["warmth",r.warmth],["trust",r.trust],["tension",r.tension],["attraction",r.attraction]].filter(([,v])=>v!=null&&v>0.05).map(([label,val])=>(
                            <div key={label} style={{ display:"flex", alignItems:"center", gap:5 }}>
                              <span style={{ ...S.sans, fontSize:9, color:"#a8a5a0", letterSpacing:".1em", textTransform:"uppercase" }}>{label}</span>
                              <div style={{ width:50, height:3, background:"rgba(0,0,0,0.08)", borderRadius:2 }}>
                                <div style={{ width:`${Math.round((val||0)*100)}%`, height:"100%", background:label==="tension"?"#c0392b":label==="attraction"?"#b05c08":"#34c759", borderRadius:2 }} />
                              </div>
                              <span style={{ ...S.mono, fontSize:10, color:"#6b6760" }}>{Math.round((val||0)*100)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Memories with you */}
                {memsWithMe.length > 0 && (
                  <FoldableSection label={`Memories with you · ${memsWithMe.length}`} S={S}>
                    <MemoryList mems={memsWithMe} expanded={expanded} setExpanded={setExpanded} S={S} />
                  </FoldableSection>
                )}

                {/* Memories with others — grouped by actor */}
                {memsWithOthers.length > 0 && (() => {
                  const byActor = memsWithOthers.reduce((acc, m) => {
                    const key = m.other_actor_id;
                    const name = m.other_name || m.other_actor_id;
                    if (!acc[key]) acc[key] = { name, mems: [] };
                    acc[key].mems.push(m);
                    return acc;
                  }, {});
                  return (
                    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                      {Object.entries(byActor).map(([actorId, { name, mems: actorMems }]) => (
                        <FoldableSection key={actorId} label={`${name.split(" ")[0]} · ${actorMems.length}`} S={S}>
                          <MemoryList mems={actorMems} expanded={expanded} setExpanded={setExpanded} S={S} />
                        </FoldableSection>
                      ))}
                    </div>
                  );
                })()}

                {uniqueRels.length === 0 && mems.length === 0 && (
                  <p style={{ ...S.sans, fontSize:13, color:"#a8a5a0" }}>No data yet.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Nav config ────────────────────────────────────────────────────────────────
const NAV = [
  { section: "Profile" },
  { id: "identity",    label: "Identity",             doneKey: () => true },
  { id: "psych",       label: "Psychological profile", doneKey: d => !!d?.psychology?.wound },
  { section: "Assessments" },
  { id: "assessments", label: "Personality",           doneKey: d => d?.big5?.openness != null },
  { id: "mental",      label: "Mental health",         doneKey: d => !!d?.mental },
  { section: "Context" },
  { id: "lifestyle",   label: "Lifestyle",             doneKey: d => !!d?.lifestyle?.sleep_pattern },
  { id: "economic",    label: "Economic",              doneKey: d => !!d?.economic?.financial_situation },
  { section: "Worlds" },
  { id: "inplay",      label: "In Play",               doneKey: () => true },
  { section: "Media" },
  { id: "media",       label: "Photos & media",        doneKey: d => !!d?.actor?.photo_url },
  { section: "Meta" },
  { id: "diagnoses",   label: "Diagnoses",             doneKey: d => d?.diagnoses?.length > 0 },
  { id: "expenses",    label: "Expenses",              doneKey: d => d?.expenses?.length > 0 },
];

// ── Main editor page ──────────────────────────────────────────────────────────
export default function ActorsEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData]         = useState(null);
  const [tab, setTab]           = useState("identity");
  const [editing, setEditing]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [editData, setEditData] = useState(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/actors/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setData(d);
        document.title = `Anima — ${d?.actor?.name || "Actor"}`;
      })
      .catch(() => {});
  }, [id]);

  if (!data) return (
    <div style={{ background:"#eeecea", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Loading...</p>
    </div>
  );

  const { actor: a } = data;
  const c = sc(a?.attachment_style);

  function startEdit() {
    setEditData(JSON.parse(JSON.stringify(data)));
    setEditing(true);
  }
  function cancelEdit() { setEditing(false); setEditData(null); }

  async function saveEdit() {
    if (!editData) return;
    setSaving(true);
    try {
      const sections = ["actor","psychology","big5","disc","hds","lifestyle","economic"];
      for (const section of sections) {
        const sdata = section === "actor" ? editData.actor : editData[section];
        if (!sdata) continue;
        await fetch(`/api/actors/${id}`, {
          method:"PUT", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ section, data: sdata }),
        });
      }
      setData(editData);
      setEditing(false); setEditData(null);
    } catch(e) { alert("Save failed: "+e.message); }
    setSaving(false);
  }

  const d = editing ? editData : data;

  const panels = {
    identity:    <IdentityPanel    d={d} editing={editing} setEditData={setEditData} />,
    psych:       <PsychPanel       d={d} editing={editing} setEditData={setEditData} />,
    assessments: <AssessmentsPanel d={d} editing={editing} setEditData={setEditData} actorId={id} />,
    mental:      <MentalPanel      d={d} editing={editing} setEditData={setEditData} />,
    lifestyle:   <LifestylePanel   d={d} editing={editing} setEditData={setEditData} />,
    economic:    <EconomicPanel    d={d} editing={editing} setEditData={setEditData} />,
    inplay:      <InPlayPanel      actorId={id} />,
    media:       <MediaPanel       actorId={id} />,
    diagnoses:   <MentalPanel      d={d} editing={editing} setEditData={setEditData} />,
    expenses:    <EconomicPanel    d={d} editing={editing} setEditData={setEditData} />,
  };

  const activeNav = NAV.find(n => n.id === tab);

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, display:"grid", gridTemplateColumns:"240px 1fr", minHeight:"100vh" }}>

        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        <div style={{ background:"rgba(255,255,255,.55)", backdropFilter:"blur(40px)", WebkitBackdropFilter:"blur(40px)", borderRight:"1px solid rgba(255,255,255,.9)", display:"flex", flexDirection:"column" }}>

          {/* Actor header */}
          <div style={{ padding:"20px 20px 16px", borderBottom:"1px solid rgba(0,0,0,.06)" }}>
            <a onClick={() => navigate("/actors")} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", cursor:"pointer", textDecoration:"none", display:"block", marginBottom:16 }}>← Characters</a>
            {a?.photo_url
              ? <img src={a.photo_url} alt={a.name} style={{ width:52, height:52, borderRadius:"50%", objectFit:"cover", marginBottom:12, border:`1px solid ${c.border}` }} />
              : <div style={{ width:52, height:52, borderRadius:"50%", background:c.init, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:17, fontWeight:500, color:c.text, marginBottom:12 }}>{ini(a?.name)}</div>
            }
            <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:20, fontWeight:500, color:"#1a1814", lineHeight:1.1 }}>{a?.name}</div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0", marginTop:3 }}>
              {[a?.age, a?.gender, a?.occupation].filter(Boolean).join(" · ")}
            </div>
            {a?.attachment_style && (
              <span style={{ display:"inline-block", fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".08em", padding:"3px 8px", borderRadius:5, background:c.bg, color:c.text, border:`1px solid ${c.border}`, marginTop:8 }}>
                {a.attachment_style.replace(/_/g," ")}
              </span>
            )}
          </div>

          {/* Nav */}
          <div style={{ flex:1, overflowY:"auto", paddingBottom:8 }}>
            {NAV.map((item, i) =>
              item.section
                ? <NavSection key={i} label={item.section} />
                : <NavItem key={item.id} label={item.label} active={tab===item.id} done={item.doneKey(data)} onClick={() => setTab(item.id)} />
            )}
          </div>

          {/* Actions */}
          <div style={{ padding:"14px 16px", borderTop:"1px solid rgba(0,0,0,.06)", display:"flex", flexDirection:"column", gap:8 }}>
            <button style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 16px", borderRadius:10, background:"none", border:"1px solid rgba(0,0,0,.1)", color:"#6b6760", cursor:"pointer" }}>
              Deploy to world
            </button>
          </div>
        </div>

        {/* ── Main content ───────────────────────────────────────────────── */}
        <div style={{ display:"flex", flexDirection:"column" }}>

          {/* Content header */}
          <div style={{ padding:"20px 28px 16px", borderBottom:"1px solid rgba(0,0,0,.06)", background:"rgba(255,255,255,.3)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, fontWeight:400, color:"#1a1814" }}>
              {activeNav?.label}
            </div>
            {editing ? (
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={cancelEdit} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", padding:"7px 16px", borderRadius:8, background:"none", border:"1px solid rgba(0,0,0,.1)", color:"#6b6760", cursor:"pointer" }}>Cancel</button>
                <button onClick={saveEdit} disabled={saving} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", padding:"7px 16px", borderRadius:8, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer", opacity:saving?.6:1 }}>{saving?"Saving…":"Save"}</button>
              </div>
            ) : (
              <button onClick={startEdit} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", padding:"7px 16px", borderRadius:8, background:"none", border:"1px solid rgba(0,0,0,.1)", color:"#6b6760", cursor:"pointer" }}>Edit</button>
            )}
          </div>

          {/* Panel body */}
          <div style={{ flex:1, overflowY:"auto", padding:"24px 28px" }}>
            {panels[tab] || null}
          </div>
        </div>

      </div>
    </div>
  );
}
