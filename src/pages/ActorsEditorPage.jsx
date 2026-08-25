import UndeployButton from "./UndeployButton.jsx";
import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import DeployWizardModal from "./DeployWizardModal.jsx";
import ActorModelPanel from "./ActorModelPanel.jsx";
import { NATIONALITIES, flagEmoji } from "./nationalities.js";
import { fmtAmount } from "../lib/money.js";

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
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:5 }}>{label}</div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color: value ? "#1a1814" : "#c8c5c0", background:"rgba(255,255,255,.55)", border:"1px solid rgba(0,0,0,.07)", borderRadius:8, padding: tall ? "10px 12px" : "8px 12px", lineHeight:1.6, whiteSpace: tall ? "pre-wrap" : "normal", maxWidth: full ? "100%" : 480 }}>{value || "—"}</div>
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
      const resp = await fetch("/api/generate/profile", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ prompt:`${context}\n\nWrite a compelling "${label}" for this character. Return only the text — no labels, no JSON, 2-3 sentences max.` }),
      });
      const data = await resp.json();
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
  const val = Math.round(raw <= 1.0 && raw > 0 ? raw * 100 : raw);
  const color = danger && val > 70 ? "#c0392b" : danger && val > 50 ? "#b05c08" : "#6b6760";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, color:"#6b6760", width:130, flexShrink:0 }}>{label}</div>
      <div style={{ flex:1, height:4, background:"rgba(0,0,0,.08)", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${val}%`, height:"100%", background: color, borderRadius:2, transition:"width .4s" }} />
      </div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, fontWeight:500, color:"#1a1814", width:26, textAlign:"right" }}>{val}</div>
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
    const next = {...prev};
    const parts = path.split(".");
    let obj = next;
    for (let i=0; i<parts.length-1; i++) obj = obj[parts[i]] = {...obj[parts[i]]};
    obj[parts[parts.length-1]] = val;
    return next;
  });
  if (!editing) return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      <Field label="First name"        value={a?.first_name} />
      <Field label="Last name"         value={a?.last_name} />
      <Field label="Age"               value={a?.age} />
      <Field label="Gender"            value={a?.gender} />
      <Field label="Nationality"       value={a?.nationality ? `${flagEmoji(a.nationality)} ${(NATIONALITIES.find(n=>n[0]===a.nationality)||[,a.nationality])[1]}` : ""} />
      <Field label="Occupation"        value={a?.occupation} />
      <Field label="Orientation"       value={p?.orientation} />
      <Field label="Marital status"    value={p?.marital_status} />
      <Field label="View on intimacy"  value={p?.view_on_sex} full tall />
    </div>
  );
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <EField label="First name"  value={a?.first_name} onChange={v=>upd("actor.first_name",v)} />
        <EField label="Last name"   value={a?.last_name}  onChange={v=>{upd("actor.last_name",v); upd("actor.name",((a?.first_name||"")+" "+v).trim());}} />
        <EField label="Age"         value={a?.age}        onChange={v=>upd("actor.age",v)} type="number" />
        <ESelect label="Gender" value={a?.gender} onChange={v=>upd("actor.gender",v)} options={["female","male","neutral"]} />
        <ESelect label="Nationality" value={a?.nationality} onChange={v=>upd("actor.nationality",v)}
          options={[{value:"",label:"— Optional —"}, ...NATIONALITIES.map(([code,label])=>({value:code, label:`${flagEmoji(code)} ${label}`}))]} />
        <EField label="Occupation" value={a?.occupation} onChange={v=>upd("actor.occupation",v)} />
        <ESelect label="Orientation" value={p?.orientation} onChange={v=>upd("psychology.orientation",v)}
          options={["straight","bisexual","gay","pansexual","asexual"]} />
        <ESelect label="Marital status" value={p?.marital_status} onChange={v=>upd("psychology.marital_status",v)}
          options={["single","casually_dating","in_relationship","married","separated","divorced","widowed"]} />
      </div>
      <EField label="View on intimacy" value={p?.view_on_sex} onChange={v=>upd("psychology.view_on_sex",v)} tall full />
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
          {/* Session 150 — read-only. The amount is world data, set at
              world-deploy from the actor's revenue sources; editing it here
              contradicted that and was one of three writers to one column. */}
          <Field label="Monthly income"      value={e.monthly_income ? fmtAmount(e.monthly_income) : "Set at deployment"} />
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
                {exp.category} · {exp.monthly_budget_ore ? `${fmtAmount(exp.monthly_budget_ore/100)} SEK/mo` : "—"}
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
      </div>
      <ESlider label={`Financial anxiety — ${Math.round((e?.financial_anxiety||0)*100)}%`}
        value={Math.round((e?.financial_anxiety||0)*100)} onChange={v=>upd("financial_anxiety",v/100)} />
      <EField label="Behavior note" value={e?.behavior_note} onChange={v=>upd("behavior_note",v)} tall full />
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
function InPlayPanel({ actorId, actorName }) {
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
              {/* Session 152 — remove her from this world, from the page that
                  shows she is in it. It only ever lived in the gallery list, as
                  a ✕ inside a chip that nobody could find. */}
              {isOwner && world.world_id && (
                <UndeployButton
                  actorId={actorId}
                  worldId={world.world_id}
                  worldName={world.world_name}
                  name={actorName}
                  onDone={() => setData(d => ({ ...d, data: d.data.filter(w => w.world_id !== world.world_id) }))}
                />
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
  { id: "model3d",     label: "3D character",         doneKey: d => !!d?.actor?.glb_url },
  { section: "Meta" },
  { id: "diagnoses",   label: "Diagnoses",             doneKey: d => d?.diagnoses?.length > 0 },
  { id: "expenses",    label: "Expenses",              doneKey: d => d?.expenses?.length > 0 },
];


// Session 150 — the only signal that an edit reached the server, now that there
// is no Save button to press and watch. Silence on failure is the risk this
// pattern carries, so failure is the case it renders most loudly.
function SaveStatus({ status, error, onRetry }) {
  if (status === "idle") return null;
  const map = {
    saving: ["#a8a5a0", "Saving…"],
    saved:  ["#1D9E75", "Saved"],
    error:  ["#993c1d", error || "Couldn't save"],
  };
  const [color, label] = map[status] || map.saving;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:9, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11.5, color }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:color,
        opacity: status === "saving" ? .5 : 1, flexShrink:0 }} />
      {label}
      {status === "error" && onRetry && (
        <button onClick={onRetry} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10.5,
          letterSpacing:".05em", textTransform:"uppercase", padding:"3px 9px", borderRadius:6,
          border:"1px solid rgba(192,57,43,.25)", background:"transparent", color:"#993c1d", cursor:"pointer" }}>Retry</button>
      )}
    </div>
  );
}

// ── Main editor page ──────────────────────────────────────────────────────────
export default function ActorsEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Where the back link goes. Defaults to the gallery, but a caller that knows
  // better — the world editor, which sends you here from a specific world — can
  // name its own return path so you land back where you were rather than in a
  // list you did not come from.
  const backTo = location.state?.from || { label: "Characters", path: "/actors" };
  const [data, setData]         = useState(null);
  const [tab, setTab]           = useState("identity");
  // Session 150 — no Edit/Save step: the panels are always live and every change
  // writes on its own. `editing` doubles as "may this person write", which is
  // exactly what the panels need to decide between an input and static text.
  //
  // Editing the TEMPLATE belongs to its owner alone. A shared character can be
  // deployed ("use") or forked ("copy"), but never edited in place — otherwise
  // there is no answer to how much editing makes it yours, which is the
  // ambiguity the permission ladder exists to remove.
  //
  // Until now this was hardcoded true, so a shared character rendered fully
  // editable and failed on save with a bare 404 from the server's ownership
  // check. The refusal was correct; arriving after the typing was not.
  const isOwner = data?.actor?.is_owner !== false;
  const editing = isOwner;
  const [status, setStatus]         = useState("idle");   // idle | saving | saved | error
  const [saveError, setSaveError]   = useState(null);
  const [editData, setEditData] = useState(null);
  const [showDeploy, setShowDeploy] = useState(false);

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

  // Session 150 — debounced autosave, replacing Edit / Cancel / Save.
  //
  // Debounced because the alternative is a PUT per keystroke: typing a backstory
  // would fire a request per character. 700ms after typing stops reads as
  // instant and is one write.
  //
  // Only CHANGED sections are sent. The old Save looped over all seven
  // regardless, so editing a name rewrote psychology, lifestyle and economics
  // too — harmless while it was one deliberate press, wasteful several times a
  // sentence.
  const pending  = useRef({});
  const timer    = useRef(null);
  const live     = useRef(true);
  const lastSent = useRef(null);

  useEffect(() => () => {
    live.current = false;
    if (timer.current) { clearTimeout(timer.current); flushEdits(); }
  }, []);

  // Baseline for change detection: whatever the server last confirmed.
  useEffect(() => { if (data && !lastSent.current) lastSent.current = JSON.parse(JSON.stringify(data)); }, [data]);

  const SECTIONS = ["actor", "psychology", "big5", "disc", "hds", "lifestyle", "economic"];

  // Commit whatever is queued and move the change-detection baseline forward.
  async function commitNow(snapshotSource) {
    const snapshot = JSON.parse(JSON.stringify(snapshotSource || editDataRef.current || data));
    clearTimeout(timer.current);
    await flushEdits();
    lastSent.current = snapshot;
  }

  // editData is read inside blur handlers that close over an older render, so
  // the latest value is mirrored into a ref.
  const editDataRef = useRef(null);

  async function flushEdits() {
    const next = pending.current;
    pending.current = {};
    const dirty = Object.keys(next);
    if (!dirty.length) return;

    setStatus("saving"); setSaveError(null);
    try {
      for (const section of dirty) {
        const r = await fetch(`/api/actors/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, data: next[section] }), keepalive: true,
        });
        if (!r.ok) {
          if (live.current) { setSaveError(`Couldn't save ${section} — HTTP ${r.status}`); setStatus("error"); }
          return;
        }
      }
      if (live.current) { setStatus("saved"); }
    } catch (e) {
      if (live.current) { setSaveError(`Couldn't save — ${e.message}`); setStatus("error"); }
    }
  }

  // Panels call setEditData; this wraps it so every mutation also queues a write.
  function updateEditData(updater) {
    if (!isOwner) return;   // read-only: nothing to stage, nothing to send
    setEditData(prev => {
      const base = prev || JSON.parse(JSON.stringify(data));
      const next = typeof updater === "function" ? updater(base) : updater;

      for (const section of SECTIONS) {
        const val  = section === "actor" ? next.actor : next[section];
        const prevVal = section === "actor" ? lastSent.current?.actor : lastSent.current?.[section];
        if (val && JSON.stringify(val) !== JSON.stringify(prevVal)) pending.current[section] = val;
      }

      if (Object.keys(pending.current).length) {
        setStatus("saving");
        clearTimeout(timer.current);
        // Session 150 — the real commit point is blur (see the panel body's
        // onBlur below), not this timer.
        //
        // A 700ms debounce was the first attempt and it is wrong for typing done
        // at a human pace: "300000" entered with ordinary pauses saved 30, then
        // 300, then 300000 — three writes, two of them values the character
        // never had. The fallback is kept and lengthened only so a control that
        // never blurs (a select the user leaves focused, then navigates away
        // from) still lands.
        timer.current = setTimeout(() => commitNow(next), 2500);
      }
      editDataRef.current = next;
      return next;
    });
  }

  if (!data) return (
    <div style={{ background:"#eeecea", minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Loading...</p>
    </div>
  );

  const { actor: a } = data;
  const c = sc(a?.attachment_style);

  const viewData = editData || data;

  const panels = {
    identity:    <IdentityPanel    d={viewData} editing={editing} setEditData={updateEditData} />,
    psych:       <PsychPanel       d={viewData} editing={editing} setEditData={updateEditData} />,
    assessments: <AssessmentsPanel d={viewData} editing={editing} setEditData={updateEditData} actorId={id} />,
    mental:      <MentalPanel      d={viewData} editing={editing} setEditData={updateEditData} />,
    lifestyle:   <LifestylePanel   d={viewData} editing={editing} setEditData={updateEditData} />,
    economic:    <EconomicPanel    d={viewData} editing={editing} setEditData={updateEditData} />,
    inplay:      <InPlayPanel      actorId={id} actorName={viewData?.actor?.name} />,
    model3d:     <ActorModelPanel  actorId={id} />,
    diagnoses:   <MentalPanel      d={viewData} editing={editing} setEditData={updateEditData} />,
    expenses:    <EconomicPanel    d={viewData} editing={editing} setEditData={updateEditData} />,
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
            <a onClick={() => navigate(backTo.path)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", cursor:"pointer", textDecoration:"none", display:"block", marginBottom:16 }}>← {backTo.label}</a>
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
                : <NavItem key={item.id} label={item.label} active={tab===item.id} done={item.doneKey(viewData)} onClick={() => setTab(item.id)} />
            )}
          </div>

          {/* Actions */}
          <div style={{ padding:"14px 16px", borderTop:"1px solid rgba(0,0,0,.06)", display:"flex", flexDirection:"column", gap:8 }}>
            <button onClick={() => setShowDeploy(true)} style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 16px", borderRadius:10, background:"#1a1814", border:"none", color:"#fff", cursor:"pointer" }}>
              Deploy to world
            </button>
          </div>
        </div>

        {showDeploy && viewData?.actor && (
          <DeployWizardModal
            actor={viewData.actor}
            onClose={() => setShowDeploy(false)}
            onDeployed={() => { setShowDeploy(false); }}
          />
        )}

        {/* ── Main content ───────────────────────────────────────────────── */}
        <div style={{ display:"flex", flexDirection:"column" }}>

          {/* Content header */}
          <div style={{ padding:"20px 28px 16px", borderBottom:"1px solid rgba(0,0,0,.06)", background:"rgba(255,255,255,.3)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, fontWeight:400, color:"#1a1814" }}>
              {activeNav?.label}
            </div>
            {isOwner
              ? <SaveStatus status={status} error={saveError} onRetry={flushEdits} />
              : (
                <div style={{ display:"flex", alignItems:"center", gap:9, fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11.5, color:"#6b6760" }}>
                  <span style={{ fontSize:12 }}>🔒</span>
                  Shared with you{data?.actor?.permission ? ` — you have “${data.actor.permission}”` : ""}. Only the owner can edit this profile.
                </div>
              )}
          </div>

          {/* Panel body — onBlur bubbles in React, so leaving any field in any
              panel commits it. This is the commit point; the timer above is only
              a fallback for controls that never blur. */}
          <div style={{ flex:1, overflowY:"auto", padding:"24px 28px" }}
            onBlur={() => { if (Object.keys(pending.current).length) commitNow(); }}>
            {panels[tab] || null}
          </div>
        </div>

      </div>
    </div>
  );
}
