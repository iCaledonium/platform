import { useState, useEffect } from "react";

// ── Colour palette per attachment style ────────────────────────────────────
const STYLE_COLOR = {
  fearful_avoidant:  { bg: "#E6F1FB", fg: "#0C447C", badge: "#B5D4F4" },
  avoidant_secure:   { bg: "#E1F5EE", fg: "#085041", badge: "#9FE1CB" },
  avoidant:          { bg: "#E1F5EE", fg: "#085041", badge: "#9FE1CB" },
  secure_anxious:    { bg: "#FAECE7", fg: "#712B13", badge: "#F5C4B3" },
  anxious:           { bg: "#FBEAF0", fg: "#72243E", badge: "#F4C0D1" },
  secure:            { bg: "#EAF3DE", fg: "#27500A", badge: "#C0DD97" },
  default:           { bg: "#F1EFE8", fg: "#444441", badge: "#D3D1C7" },
};

function styleColor(s) { return STYLE_COLOR[s] || STYLE_COLOR.default; }

function Initials({ name, size = 44, style: attachment }) {
  const ini = name?.split(" ").map(n => n[0]).join("").slice(0,2).toUpperCase() || "?";
  const c = styleColor(attachment);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: c.bg, color: c.fg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.33, fontWeight: 500, flexShrink: 0,
    }}>{ini}</div>
  );
}

// ── Completion dots ────────────────────────────────────────────────────────
const SECTIONS = ["identity","psych","assessments","lifestyle","economic","mental","upbringing","diagnoses"];

function completionDots(actor) {
  const done = [
    true,
    !!(actor.wound),
    !!(actor.openness),
    !!(actor.alcohol_relationship),
    !!(actor.financial_situation),
    false,
    false,
    false,
  ];
  return done;
}

function Dots({ actor }) {
  const dots = completionDots(actor);
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
      {dots.map((on, i) => (
        <div key={i} style={{
          width: 5, height: 5, borderRadius: "50%",
          background: on ? "#1D9E75" : "var(--color-border-secondary)",
        }} />
      ))}
    </div>
  );
}

// ── Actor gallery card ────────────────────────────────────────────────────
function ActorCard({ actor, selected, onClick }) {
  const c = styleColor(actor.attachment_style);
  return (
    <div onClick={onClick} style={{
      background: selected ? "var(--color-background-info)" : "var(--color-background-secondary)",
      border: selected ? "1.5px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
      borderRadius: "var(--border-radius-lg)",
      padding: "14px 12px", cursor: "pointer",
      transition: "border-color .15s",
    }}>
      <Initials name={actor.name} style={actor.attachment_style} size={40} />
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", marginTop: 10, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {actor.name}
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {actor.occupation || "—"}
      </div>
      {actor.attachment_style && (
        <span style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 20,
          background: c.badge, color: c.fg,
          display: "inline-block",
        }}>{actor.attachment_style.replace(/_/g, " ")}</span>
      )}
      <Dots actor={actor} />
    </div>
  );
}

// ── Nav item ──────────────────────────────────────────────────────────────
function NavItem({ label, active, done, partial, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "7px 16px", fontSize: 12, cursor: "pointer",
      color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
      background: active ? "var(--color-background-primary)" : "transparent",
      borderLeft: active ? "2px solid #378ADD" : "2px solid transparent",
      fontWeight: active ? 500 : 400,
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
        background: done ? "#1D9E75" : partial ? "#BA7517" : "var(--color-border-secondary)",
      }} />
      {label}
    </div>
  );
}

function NavSection({ label }) {
  return (
    <div style={{ padding: "8px 16px 3px", fontSize: 10, color: "var(--color-text-tertiary)", letterSpacing: ".07em", textTransform: "uppercase" }}>
      {label}
    </div>
  );
}

// ── Field display ─────────────────────────────────────────────────────────
function Field({ label, value, tall, full }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: full ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{
        fontSize: 12, color: "var(--color-text-primary)",
        padding: "7px 10px",
        background: "var(--color-background-secondary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-md)",
        lineHeight: 1.6,
        minHeight: tall ? 60 : 32,
      }}>{value}</div>
    </div>
  );
}

function ScoreBar({ label, value, color }) {
  const v = Math.round(value || 0);
  const barColor = color || (v > 70 ? "#E24B4A" : v > 50 ? "#378ADD" : "#888780");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", width: 120, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 5, background: "var(--color-background-secondary)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${v}%`, height: "100%", background: barColor, borderRadius: 3 }} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-primary)", width: 24, textAlign: "right" }}>{v}</div>
    </div>
  );
}

// ── Tab panels ────────────────────────────────────────────────────────────
function IdentityPanel({ data }) {
  const { actor, psychology } = data;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      <Field label="Name"       value={actor?.name} />
      <Field label="Age"        value={actor?.age} />
      <Field label="Gender"     value={actor?.gender} />
      <Field label="Occupation" value={actor?.occupation} />
      <Field label="Appearance" value={actor?.appearance} tall full />
      <Field label="Orientation"    value={psychology?.orientation} />
      <Field label="Marital status" value={psychology?.marital_status} />
      <Field label="View on sex"    value={psychology?.view_on_sex} full tall />
    </div>
  );
}

function PsychPanel({ data }) {
  const { psychology, upbringing, education } = data;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      {upbringing && <>
        <Field label="Childhood region"        value={upbringing.childhood_region} />
        <Field label="Socioeconomic background" value={upbringing.socioeconomic_background} />
        <Field label="Family education"         value={upbringing.family_education_level} />
        <Field label="Upbringing note"          value={upbringing.upbringing_note} full tall />
      </>}
      {education?.length > 0 && education.map((e, i) => (
        <Field key={i} label={`Education ${i+1}`} value={`${e.level || ""} ${e.field || ""} — ${e.institution || ""}`} />
      ))}
      <div style={{ gridColumn: "1 / -1", height: 1, background: "var(--color-border-tertiary)", margin: "4px 0" }} />
      <Field label="Wound"         value={psychology?.wound}          full tall />
      <Field label="What they want" value={psychology?.what_they_want} full tall />
      <Field label="Blindspot"     value={psychology?.blindspot}      full tall />
      <Field label="Contradiction" value={psychology?.contradiction}   full tall />
      <Field label="Self view"     value={psychology?.self_view}      tall />
      <Field label="Others view"   value={psychology?.others_view}    tall />
      <Field label="Defenses"      value={psychology?.defenses}       full tall />
      <Field label="Coping"        value={psychology?.coping_mechanisms} full tall />
      <Field label="Family model"  value={psychology?.family_model}   full tall />
    </div>
  );
}

function AssessmentsPanel({ data }) {
  const { big5, disc, hds, psychology } = data;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      {big5 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Big Five (OCEAN)</div>
          <ScoreBar label="Openness"          value={big5.openness} />
          <ScoreBar label="Conscientiousness" value={big5.conscientiousness} />
          <ScoreBar label="Extraversion"      value={big5.extraversion} />
          <ScoreBar label="Agreeableness"     value={big5.agreeableness} />
          <ScoreBar label="Neuroticism"       value={big5.neuroticism} color={big5.neuroticism > 70 ? "#E24B4A" : undefined} />
        </div>
      )}
      {disc && (
        <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>DISC</div>
          <ScoreBar label="Dominance"   value={disc.d} />
          <ScoreBar label="Influence"   value={disc.i} />
          <ScoreBar label="Steadiness"  value={disc.s} />
          <ScoreBar label="Compliance"  value={disc.c} />
        </div>
      )}
      {hds && (
        <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Hogan HDS — dark side under stress</div>
          {["bold","cautious","colorful","diligent","dutiful","excitable","imaginative","leisurely","mischievous","reserved","skeptical"]
            .filter(k => hds[k] != null)
            .map(k => <ScoreBar key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={hds[k]} color={hds[k] > 65 ? "#BA7517" : undefined} />)}
        </div>
      )}
      <Field label="Attachment style" value={psychology?.attachment_style?.replace(/_/g," ")} />
      <Field label="Identity certainty" value={psychology?.identity_certainty != null ? Number(psychology.identity_certainty).toFixed(2) : null} />
    </div>
  );
}

function LifestylePanel({ data }) {
  const { lifestyle } = data;
  if (!lifestyle) return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>No lifestyle data</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      <Field label="Sleep pattern"    value={lifestyle.sleep_pattern} />
      <Field label="Sleep quality"    value={lifestyle.sleep_quality} />
      <Field label="Exercise"         value={lifestyle.exercise_habit} />
      <Field label="Exercise type"    value={lifestyle.exercise_type} />
      <Field label="Diet"             value={lifestyle.diet} />
      <Field label="Social frequency" value={lifestyle.social_frequency} />
      <Field label="Alcohol"          value={lifestyle.alcohol_relationship} />
      <Field label="Drug use"         value={lifestyle.drug_use} />
      <Field label="Substance context" value={lifestyle.substance_context} full tall />
      <Field label="Lifestyle note"   value={lifestyle.lifestyle_note} full tall />
    </div>
  );
}

function EconomicPanel({ data }) {
  const { economic, expenses } = data;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      {economic && <>
        <Field label="Financial situation" value={economic.financial_situation} />
        <Field label="Income stability"    value={economic.income_stability} />
        <Field label="Spending style"      value={economic.spending_style} />
        <Field label="Attitude to wealth"  value={economic.attitude_to_wealth} />
        <Field label="Savings habit"       value={economic.savings_habit} />
        <Field label="Financial anxiety"   value={economic.financial_anxiety != null ? Number(economic.financial_anxiety).toFixed(2) : null} />
        <Field label="Monthly income"      value={economic.monthly_income_sek ? `${economic.monthly_income_sek.toLocaleString()} SEK` : null} />
        <Field label="Behavior note"       value={economic.behavior_note} full tall />
      </>}
      {expenses?.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Expense defaults</div>
          {expenses.map((e, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 12 }}>
              <span style={{ color: "var(--color-text-primary)" }}>{e.name}</span>
              <span style={{ color: "var(--color-text-secondary)" }}>{e.category} · {e.monthly_budget_ore ? `${Math.round(e.monthly_budget_ore/100).toLocaleString()} SEK/mo` : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MentalHealthPanel({ data }) {
  const { mental, diagnoses } = data;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "18px 20px", alignContent: "start" }}>
      {mental && (
        <div style={{ gridColumn: "1 / -1" }}>
          {["depression_risk","anxiety_risk","substance_risk","isolation_risk","identity_fragility","crisis_threshold","obsessive_tendency"]
            .filter(k => mental[k] != null)
            .map(k => <ScoreBar key={k} label={k.replace(/_/g," ")} value={mental[k]*100} color={mental[k] > 0.7 ? "#E24B4A" : undefined} />)}
          <Field label="Risk note"           value={mental.risk_note} full tall />
          <Field label="Protective factors"  value={mental.protective_factors} full tall />
        </div>
      )}
      {diagnoses?.length > 0 && (
        <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Diagnoses</div>
          {diagnoses.map((d, i) => (
            <div key={i} style={{ padding: "8px 10px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>{d.diagnosis}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                {d.severity} · {d.diagnosed ? "diagnosed" : "undiagnosed"} · {d.medicated ? `medicated (${d.medication})` : "unmedicated"}
              </div>
              {d.awareness && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>Awareness: {d.awareness}</div>}
              {d.behavioral_note && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4 }}>{d.behavioral_note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MediaPanel({ data, actorId }) {
  const [media, setMedia] = useState([]);
  useEffect(() => {
    fetch(`/api/actors/${actorId}/media`)
      .then(r => r.ok ? r.json() : [])
      .then(setMedia)
      .catch(() => {});
  }, [actorId]);

  const photos = media.filter(m => m.media_type === "photo");
  const states = media.filter(m => m.media_type === "state_image");

  return (
    <div style={{ padding: "18px 20px" }}>
      {photos.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Portrait photos</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px,1fr))", gap: 8, marginBottom: 20 }}>
            {photos.map(m => (
              <div key={m.id}>
                <img src={m.url} alt={m.state_slug} style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-tertiary)" }} />
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 4 }}>{m.state_slug?.replace(/_/g," ")}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {states.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>State images</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px,1fr))", gap: 8 }}>
            {states.map(m => (
              <div key={m.id}>
                <img src={m.url} alt={m.state_slug} style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-tertiary)" }} />
                <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 4 }}>{m.state_slug?.replace(/_/g," ")}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {media.length === 0 && (
        <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>No media</div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function ActorsPage() {
  const [actors, setActors]     = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [tab, setTab]           = useState("identity");
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    fetch("/api/actors")
      .then(r => r.ok ? r.json() : [])
      .then(data => { setActors(data); if (data.length) selectActor(data[0]); })
      .catch(() => {});
  }, []);

  function selectActor(actor) {
    setSelected(actor);
    setTab("identity");
    setLoading(true);
    fetch(`/api/actors/${actor.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setDetail(data); setLoading(false); })
      .catch(() => setLoading(false));
  }

  const NAV = [
    { section: "Profile" },
    { id: "identity",     label: "Identity",            done: true },
    { id: "psych",        label: "Psychological profile", done: !!(detail?.psychology?.wound) },
    { section: "Assessments" },
    { id: "assessments",  label: "Big Five / DISC / HDS", done: !!(detail?.big5?.openness) },
    { id: "mental",       label: "Mental health",         done: !!(detail?.mental), partial: !!(detail?.mental) },
    { section: "Context" },
    { id: "lifestyle",    label: "Lifestyle",             done: !!(detail?.lifestyle?.sleep_pattern) },
    { id: "economic",     label: "Economic",              done: !!(detail?.economic?.financial_situation) },
    { section: "Media" },
    { id: "media",        label: "Photos & media",        done: false },
    { section: "Meta" },
    { id: "diagnoses",    label: "Diagnoses",             done: !!(detail?.diagnoses?.length) },
    { id: "expenses",     label: "Expenses",              done: !!(detail?.expenses?.length) },
  ];

  const PANELS = {
    identity:    <IdentityPanel    data={detail || {}} />,
    psych:       <PsychPanel       data={detail || {}} />,
    assessments: <AssessmentsPanel data={detail || {}} />,
    mental:      <MentalHealthPanel data={detail || {}} />,
    lifestyle:   <LifestylePanel   data={detail || {}} />,
    economic:    <EconomicPanel    data={detail || {}} />,
    media:       <MediaPanel       data={detail || {}} actorId={selected?.id} />,
    diagnoses:   <MentalHealthPanel data={detail || {}} />,
    expenses:    <EconomicPanel    data={detail || {}} />,
  };

  const c = selected ? styleColor(selected.attachment_style) : styleColor("default");

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>

      {/* Back nav */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <a href="/home" style={{ fontSize: 12, color: "var(--color-text-secondary)", textDecoration: "none" }}>← Home</a>
        <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>/</span>
        <span style={{ fontSize: 12, color: "var(--color-text-primary)" }}>Actors</span>
      </div>

      {/* Gallery */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>Actor registry</div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{actors.length} canonical profiles</div>
        </div>
        <button style={{ fontSize: 12, padding: "6px 14px", border: "0.5px solid var(--color-border-info)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-info)", color: "var(--color-text-info)", cursor: "pointer" }}>
          New actor +
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px,1fr))", gap: 10, marginBottom: 28 }}>
        {actors.map(a => (
          <ActorCard key={a.id} actor={a} selected={selected?.id === a.id} onClick={() => selectActor(a)} />
        ))}
      </div>

      {/* Editor */}
      {selected && (
        <>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 12 }}>
            Editor · {selected.name}
          </div>
          <div style={{
            display: "grid", gridTemplateColumns: "200px 1fr",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: "var(--border-radius-lg)", overflow: "hidden",
            background: "var(--color-background-primary)",
            minHeight: 560,
          }}>
            {/* Sidebar */}
            <div style={{ borderRight: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "14px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <Initials name={selected.name} style={selected.attachment_style} size={44} />
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)", marginTop: 8 }}>{selected.name}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                  {selected.age && `${selected.age} · `}{selected.gender && `${selected.gender} · `}{selected.occupation}
                </div>
                {selected.attachment_style && (
                  <span style={{ display: "inline-block", fontSize: 10, padding: "2px 7px", borderRadius: 20, background: c.badge, color: c.fg, marginTop: 5 }}>
                    {selected.attachment_style.replace(/_/g," ")}
                  </span>
                )}
              </div>

              <div style={{ flex: 1, padding: "6px 0", overflowY: "auto" }}>
                {NAV.map((item, i) =>
                  item.section
                    ? <NavSection key={i} label={item.section} />
                    : <NavItem key={item.id} label={item.label} active={tab === item.id} done={item.done} partial={item.partial} onClick={() => setTab(item.id)} />
                )}
              </div>

              <div style={{ padding: "10px 14px", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", flexDirection: "column", gap: 7 }}>
                <button style={{ fontSize: 12, padding: "7px 12px", border: "0.5px solid var(--color-border-info)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-info)", color: "var(--color-text-info)", cursor: "pointer" }}>
                  Run assessments ↗
                </button>
                <button style={{ fontSize: 12, padding: "7px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "transparent", color: "var(--color-text-primary)", cursor: "pointer" }}>
                  Clone into world
                </button>
              </div>
            </div>

            {/* Main content */}
            <div style={{ display: "flex", flexDirection: "column", overflowY: "auto" }}>
              <div style={{ padding: "14px 20px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                    {NAV.find(n => n.id === tab)?.label}
                  </div>
                </div>
                <button style={{ fontSize: 11, padding: "4px 10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                  Edit
                </button>
              </div>
              {loading
                ? <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Loading...</div>
                : PANELS[tab]
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}
