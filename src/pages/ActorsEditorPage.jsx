import { useState, useEffect } from "react";
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
  if (value == null || value === "") return null;
  return (
    <div style={{ gridColumn: full ? "1/-1" : undefined }}>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:9, letterSpacing:".15em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:5 }}>{label}</div>
      <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", background:"rgba(255,255,255,.5)", border:"1px solid rgba(0,0,0,.07)", borderRadius:10, padding:"8px 12px", lineHeight:1.6, minHeight: tall ? 64 : "auto" }}>{String(value)}</div>
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
function IdentityPanel({ d }) {
  const { actor: a, psychology: p } = d;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      <Field label="Name"          value={a?.name} />
      <Field label="Age"           value={a?.age} />
      <Field label="Gender"        value={a?.gender} />
      <Field label="Occupation"    value={a?.occupation} />
      <Field label="Appearance"    value={a?.appearance} tall full />
      <Field label="Orientation"   value={p?.orientation} />
      <Field label="Marital status" value={p?.marital_status} />
      <Field label="View on intimacy" value={p?.view_on_sex} full tall />
    </div>
  );
}

// ── Panel: Psychological profile ──────────────────────────────────────────────
function PsychPanel({ d }) {
  const { psychology: p, upbringing: u, education: ed } = d;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      {u && <>
        <Field label="Childhood region"         value={u.childhood_region} />
        <Field label="Background"               value={u.socioeconomic_background} />
        <Field label="Family education"         value={u.family_education_level} />
        <Field label="Upbringing note"          value={u.upbringing_note} full tall />
      </>}
      {ed?.length > 0 && ed.map((e,i) => (
        <Field key={i} label={`Education ${i+1}`} value={[e.level,e.field,e.institution].filter(Boolean).join(" · ")} />
      ))}
      <div style={{ gridColumn:"1/-1", height:1, background:"rgba(0,0,0,.06)", margin:"4px 0" }} />
      <Field label="Backstory"      value={p?.backstory}      full tall />
      <Field label="Wound"          value={p?.wound}          full tall />
      <Field label="What they want" value={p?.what_they_want} full tall />
      <Field label="Blindspot"      value={p?.blindspot}      full tall />
      <Field label="Contradiction"  value={p?.contradiction}  full tall />
      <Field label="Self view"      value={p?.self_view}      tall />
      <Field label="Others view"    value={p?.others_view}    tall />
      <Field label="Defenses"       value={p?.defenses}       full tall />
      <Field label="Coping"         value={p?.coping_mechanisms} full tall />
      <Field label="Family model"   value={p?.family_model}   full tall />
      <Field label="How they read relationships" value={p?.relationship_read_pattern} full tall />
    </div>
  );
}

// ── Panel: Assessments ────────────────────────────────────────────────────────
function AssessmentsPanel({ d }) {
  const { big5: b, disc: dc, hds: h, psychology: p } = d;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {b && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Big Five (OCEAN)</div>
          <ScoreBar label="Openness"          value={b.openness} />
          <ScoreBar label="Conscientiousness" value={b.conscientiousness} />
          <ScoreBar label="Extraversion"      value={b.extraversion} />
          <ScoreBar label="Agreeableness"     value={b.agreeableness} />
          <ScoreBar label="Neuroticism"       value={b.neuroticism} danger />
        </div>
      )}
      {dc && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>DISC</div>
          <ScoreBar label="Dominance"  value={dc.d} />
          <ScoreBar label="Influence"  value={dc.i} />
          <ScoreBar label="Steadiness" value={dc.s} />
          <ScoreBar label="Compliance" value={dc.c} />
        </div>
      )}
      {h && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Hogan HDS — dark side under stress</div>
          {["bold","cautious","colorful","diligent","dutiful","excitable","imaginative","leisurely","mischievous","reserved","skeptical"].filter(k => h[k] != null).map(k => (
            <ScoreBar key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={h[k]} danger />
          ))}
        </div>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <Field label="Attachment style"   value={p?.attachment_style?.replace(/_/g," ")} />
        <Field label="Identity certainty" value={p?.identity_certainty != null ? Number(p.identity_certainty).toFixed(2) : null} />
      </div>
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
function LifestylePanel({ d }) {
  const { lifestyle: l } = d;
  if (!l) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>No lifestyle data</p>;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
      <Field label="Sleep pattern"    value={l.sleep_pattern} />
      <Field label="Sleep quality"    value={l.sleep_quality} />
      <Field label="Exercise"         value={l.exercise_habit} />
      <Field label="Exercise type"    value={l.exercise_type} />
      <Field label="Diet"             value={l.diet} />
      <Field label="Social frequency" value={l.social_frequency} />
      <Field label="Alcohol"          value={l.alcohol_relationship} />
      <Field label="Drug use"         value={l.drug_use} />
      <Field label="Substance context" value={l.substance_context} full tall />
      <Field label="Note"             value={l.lifestyle_note} full tall />
    </div>
  );
}

// ── Panel: Economic ───────────────────────────────────────────────────────────
function EconomicPanel({ d }) {
  const { economic: e, expenses: ex } = d;
  return (
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
}

// ── Panel: Media ──────────────────────────────────────────────────────────────
function MediaPanel({ actorId }) {
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!actorId) return;
    fetch(`/api/actors/${actorId}/media`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setMedia(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [actorId]);

  if (loading) return <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>Loading media...</p>;

  const photos = media.filter(m => m.media_type === "photo");
  const states = media.filter(m => m.media_type === "state_image");

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {photos.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>Portrait photos</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:10 }}>
            {photos.map(m => (
              <div key={m.id}>
                <img src={m.url} alt={m.state_slug} style={{ width:"100%", aspectRatio:"3/4", objectFit:"cover", borderRadius:12, border:"1px solid rgba(0,0,0,.07)" }} />
                <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#a8a5a0", marginTop:5 }}>{m.state_slug?.replace(/_/g," ")}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {states.length > 0 && (
        <div>
          <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, fontWeight:500, color:"#1a1814", marginBottom:14 }}>State images</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:10 }}>
            {states.map(m => (
              <div key={m.id}>
                <img src={m.url} alt={m.state_slug} style={{ width:"100%", aspectRatio:"1/1", objectFit:"cover", borderRadius:10, border:"1px solid rgba(0,0,0,.07)" }} />
                <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:10, color:"#a8a5a0", marginTop:4 }}>{m.state_slug?.replace(/_/g," ")}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {media.length === 0 && <p style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#a8a5a0" }}>No media uploaded</p>}
    </div>
  );
}

// ── Nav config ────────────────────────────────────────────────────────────────
const NAV = [
  { section: "Profile" },
  { id: "identity",    label: "Identity",             doneKey: () => true },
  { id: "psych",       label: "Psychological profile", doneKey: d => !!d?.psychology?.wound },
  { section: "Assessments" },
  { id: "assessments", label: "Big Five / DISC / HDS", doneKey: d => d?.big5?.openness != null },
  { id: "mental",      label: "Mental health",         doneKey: d => !!d?.mental },
  { section: "Context" },
  { id: "lifestyle",   label: "Lifestyle",             doneKey: d => !!d?.lifestyle?.sleep_pattern },
  { id: "economic",    label: "Economic",              doneKey: d => !!d?.economic?.financial_situation },
  { section: "Media" },
  { id: "media",       label: "Photos & media",        doneKey: () => false },
  { section: "Meta" },
  { id: "diagnoses",   label: "Diagnoses",             doneKey: d => d?.diagnoses?.length > 0 },
  { id: "expenses",    label: "Expenses",              doneKey: d => d?.expenses?.length > 0 },
];

// ── Main editor page ──────────────────────────────────────────────────────────
export default function ActorsEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab]   = useState("identity");

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

  const panels = {
    identity:    <IdentityPanel    d={data} />,
    psych:       <PsychPanel       d={data} />,
    assessments: <AssessmentsPanel d={data} />,
    mental:      <MentalPanel      d={data} />,
    lifestyle:   <LifestylePanel   d={data} />,
    economic:    <EconomicPanel    d={data} />,
    media:       <MediaPanel       actorId={id} />,
    diagnoses:   <MentalPanel      d={data} />,
    expenses:    <EconomicPanel    d={data} />,
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
            <button style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 16px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer" }}>
              Run assessments ↗
            </button>
            <button style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:12, letterSpacing:".06em", textTransform:"uppercase", padding:"10px 16px", borderRadius:10, background:"none", border:"1px solid rgba(0,0,0,.1)", color:"#6b6760", cursor:"pointer" }}>
              Add to world
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
            <button style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, letterSpacing:".08em", textTransform:"uppercase", padding:"7px 16px", borderRadius:8, background:"none", border:"1px solid rgba(0,0,0,.1)", color:"#6b6760", cursor:"pointer" }}>
              Edit
            </button>
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
