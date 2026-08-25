import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { fmtAmount, fmtSigned } from "../lib/money.js";
import AmountInput from "../lib/AmountInput.jsx";
import UndeployButton from "./UndeployButton.jsx";

// ── WorldActorPage ────────────────────────────────────────────────────────────
//
// Session 150 — the deployed character, at /my-worlds/:worldId/actors/:actorId.
//
// This is the INSTANCE, not the template. /actors/:id edits the character that a
// deploy ships; this edits the copy the simulator actually runs. The two diverge
// the moment you change anything here, and that is the point: she can be a
// different person in a different world.
//
// Scope note — this first pass is built strictly on endpoints that already
// exist, so it ships without touching the simulator:
//   Runtime  GET /api/actors/:id/in-play   relationships, memories
//   Home     GET /api/worlds/:wid/actors/:aid/home
// Economy, schedule and the profile sections have no read or write route yet —
// the simulator only ever inserts those at deploy and deletes them at teardown.
// They are listed here as pending rather than hidden, so the shape of the page
// is honest about what is not wired up.

const F     = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

function ini(n) { return (n || "?").split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase(); }

function NavSection({ label }) {
  return <div style={{ ...F, fontSize:9, letterSpacing:".18em", textTransform:"uppercase", color:"#a8a5a0", padding:"10px 20px 4px" }}>{label}</div>;
}

function NavItem({ label, active, pending, onClick }) {
  return (
    <div onClick={pending ? undefined : onClick} style={{
      display:"flex", alignItems:"center", gap:8, padding:"8px 20px", ...F, fontSize:12,
      cursor: pending ? "default" : "pointer",
      color: pending ? "#c4c1bb" : active ? "#1a1814" : "#6b6760",
      background: active ? "rgba(255,255,255,.5)" : "transparent",
      borderLeft: active ? "2px solid #b05c08" : "2px solid transparent",
      fontWeight: active ? 500 : 400,
    }}>
      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
        background: pending ? "rgba(0,0,0,.06)" : "#34c759" }} />
      {label}
      {pending && <span style={{ marginLeft:"auto", fontSize:9, letterSpacing:".06em", textTransform:"uppercase", color:"#c4c1bb" }}>soon</span>}
    </div>
  );
}

function Pending({ what }) {
  return (
    <div style={{ maxWidth:520, padding:"16px 18px", background:"rgba(0,0,0,.02)",
      border:"1px dashed rgba(0,0,0,.1)", borderRadius:10 }}>
      <p style={{ ...F, fontSize:13, color:"#6b6760", margin:0, lineHeight:1.7 }}>
        {what} isn't editable yet. The simulator writes it once during deploy and deletes
        it on undeploy — there's no read or update route for it, so this panel has nothing
        to talk to until those are added.
      </p>
    </div>
  );
}



// Session 150 — with no Save button, a write that fails has nothing to show for
// itself. This is the only feedback that an edit reached the simulator, so it
// has to be honest about all three outcomes rather than only the happy one.
function SaveStatus({ status, error, onRetry }) {
  if (status === "idle") return null;
  const map = {
    saving: ["#a8a5a0", "Saving…"],
    saved:  ["#1D9E75", "Saved"],
    error:  ["#993c1d", error || "Couldn't save"],
  };
  const [color, label] = map[status] || map.saving;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:9, ...F, fontSize:11.5, color }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:color,
        opacity: status === "saving" ? .5 : 1, flexShrink:0 }} />
      {label}
      {status === "error" && onRetry && (
        <button onClick={onRetry} style={{ ...F, fontSize:10.5, letterSpacing:".05em", textTransform:"uppercase",
          padding:"3px 9px", borderRadius:6, border:"1px solid rgba(192,57,43,.25)",
          background:"transparent", color:"#993c1d", cursor:"pointer" }}>Retry</button>
      )}
    </div>
  );
}


// Session 150 — free-text and numeric fields commit on blur or Enter, never on
// a timer.
//
// The first version debounced every keystroke by 700ms, which is fine for fast
// typing and wrong for deliberate typing: entering "300000" with ordinary pauses
// wrote 30, then 300, then 300000 as three separate saves. On a balance field
// that meant a running actor's account really did hold 30 SEK for two seconds,
// and financial_anxiety recomputes from live balance — so the intermediate
// states were not merely cosmetic, and each one left a row in her ledger.
//
// Holding the keystrokes locally and committing once on blur keeps the "no save
// button" behaviour while making a half-typed number unrepresentable.
function CommitInput({ value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(value ?? "");
  const dirty = useRef(false);

  // Track the outside value unless the user is mid-edit, or a save round-trip
  // would yank the field out from under them.
  useEffect(() => { if (!dirty.current) setDraft(value ?? ""); }, [value]);

  function commit() {
    if (!dirty.current) return;
    dirty.current = false;
    if (String(draft) !== String(value ?? "")) onCommit(draft);
  }

  return (
    <input {...rest} value={draft}
      onChange={e => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        if (e.key === "Escape") { dirty.current = false; setDraft(value ?? ""); e.currentTarget.blur(); }
      }} />
  );
}


function Field({ label, children }) {
  return (
    <label style={{ display:"flex", flexDirection:"column", gap:4, minWidth:0 }}>
      <span style={{ ...F, fontSize:9, letterSpacing:".14em", textTransform:"uppercase", color:"#a8a5a0" }}>{label}</span>
      {children}
    </label>
  );
}
// Session 150 — a control you may not use should look like one.
//
// The world editor rendered every field as editable regardless of role, so a
// player could type into a salary, tab away, and only then be told 403 by the
// server. The permission was enforced and invisible, which is the worst of both:
// the work is lost and the reason arrives too late to be useful.
const roStyle = ro => ro ? { background:"rgba(0,0,0,.025)", color:"#6b6760", cursor:"default" } : null;

function ReadOnlyNotice({ what = "this character" }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:9, padding:"11px 13px", marginBottom:18,
      background:"rgba(0,0,0,.025)", border:"1px solid rgba(0,0,0,.07)", borderRadius:10 }}>
      <span style={{ color:"#a8a5a0", fontSize:13, lineHeight:1.3, flexShrink:0 }}>🔒</span>
      <div style={{ ...F, fontSize:12, color:"#6b6760", lineHeight:1.6 }}>
        You're a player in this world, not an owner, so {what} is read-only here.
      </div>
    </div>
  );
}

const inputS = { ...F, fontSize:13, padding:"7px 10px", borderRadius:8,
  border:"1px solid rgba(0,0,0,.12)", background:"rgba(255,255,255,.75)", color:"#1a1814", width:"100%", boxSizing:"border-box" };


// ── useLiveSection ────────────────────────────────────────────────────────────
//
// Session 150 — the load / edit / autosave cycle the Economy panel established,
// extracted so Identity, Psychology and Lifestyle share it rather than repeating
// it three times.
//
// Same contract as Economy: typed fields commit on blur, discrete controls
// commit immediately, and only the sections the caller actually touched are
// sent — a partial PATCH must not nil out fields it never mentioned.
function useLiveSection(url, buildBody) {
  const [data, setData]     = useState(undefined);
  const [status, setStatus] = useState("idle");
  const [error, setError]   = useState(null);
  const pending = useRef(null);
  const timer   = useRef(null);
  const live    = useRef(true);

  useEffect(() => () => { live.current = false; if (timer.current) { clearTimeout(timer.current); flush(); } }, []);
  useEffect(() => {
    fetch(url).then(r => r.ok ? r.json() : null).then(d => setData(d || null)).catch(() => setData(null));
  }, [url]);

  async function flush() {
    const body = pending.current;
    if (!body) return;
    pending.current = null;
    setStatus("saving"); setError(null);
    try {
      const r = await fetch(url, { method:"PATCH", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(body), keepalive: true });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        if (live.current) { setError(e.error || `Couldn't save — HTTP ${r.status}`); setStatus("error"); }
        return;
      }
      const fresh = await r.json();
      if (live.current) { setData(fresh); setStatus("saved"); }
    } catch (e) {
      if (live.current) { setError(`Couldn't save — ${e.message}`); setStatus("error"); }
    }
  }

  function push(next) {
    setData(next);
    pending.current = buildBody(next);
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 120);
  }

  return { data, status, error, push, retry: flush };
}

// A labelled text field that commits when you leave it.
function TextRow({ label, value, onCommit, multiline, placeholder, readOnly }) {
  const [draft, setDraft] = useState(value ?? "");
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(value ?? ""); }, [value]);
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    if (String(draft) !== String(value ?? "")) onCommit(draft);
  };
  const common = {
    value: draft,
    onChange: e => { dirty.current = true; setDraft(e.target.value); },
    onBlur: commit,
    placeholder,
    disabled: !!readOnly,
    style: { ...inputS, ...(multiline ? { minHeight: 78, resize: "vertical", lineHeight: 1.6 } : {}), ...roStyle(readOnly) },
  };
  return (
    <Field label={label}>
      {multiline ? <textarea {...common} /> : <input {...common} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />}
    </Field>
  );
}

// ── IdentityPanel ─────────────────────────────────────────────────────────────
function IdentityPanel({ actorId, worldId, canEdit = true }) {
  const url = `/api/worlds/${worldId}/actors/${actorId}/profile`;
  const { data, status, error, push, retry } = useLiveSection(url, next => ({ identity: next.identity }));

  if (data === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!data?.identity)    return <p style={{ ...F, fontSize:13, color:"#993c1d" }}>No identity row for her in this world.</p>;

  const set = (k, v) => push({ ...data, identity: { ...data.identity, [k]: v } });
  const i = data.identity;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16, maxWidth:620 }}>
      {!canEdit && <ReadOnlyNotice what="her identity" />}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <TextRow label="First name" value={i.first_name} onCommit={v => set("first_name", v)} readOnly={!canEdit} />
        <TextRow label="Last name"  value={i.last_name}  onCommit={v => set("last_name", v)} readOnly={!canEdit} />
        <TextRow label="Age"        value={i.age}        onCommit={v => set("age", Number(v) || null)} readOnly={!canEdit} />
        <TextRow label="Gender"     value={i.gender}     onCommit={v => set("gender", v)} readOnly={!canEdit} />
        <TextRow label="Occupation" value={i.occupation} onCommit={v => set("occupation", v)} readOnly={!canEdit} />
        <TextRow label="Nationality" value={i.nationality} onCommit={v => set("nationality", v)} readOnly={!canEdit} />
      </div>
      <TextRow label="Appearance" value={i.appearance} multiline onCommit={v => set("appearance", v)}
        placeholder="How she looks, in this world" readOnly={!canEdit} />
      <p style={{ ...F, fontSize:11, color:"#a8a5a0", lineHeight:1.6, margin:0 }}>
        Editing here changes the deployed copy only. Her basic profile — the template a deploy ships from — is untouched.
      </p>
      <SaveStatus status={status} error={error} onRetry={retry} />
    </div>
  );
}

// ── PsychologyPanel ───────────────────────────────────────────────────────────
const ATTACHMENT = ["secure","anxious","avoidant","fearful_avoidant"];
const BIG5 = [["openness","Openness"],["conscientiousness","Conscientiousness"],
              ["extraversion","Extraversion"],["agreeableness","Agreeableness"],
              ["neuroticism","Neuroticism"]];
const PSYCH_TEXT = [
  ["wound", "The wound"], ["what_they_want", "What she actually wants"],
  ["blindspot", "The blind spot"], ["contradiction", "The contradiction"],
  ["defenses", "Defenses"], ["coping_mechanisms", "Coping mechanisms"],
  ["backstory", "Backstory"], ["self_view", "How she sees herself"],
  ["others_view", "How others see her"], ["view_on_sex", "View on intimacy"],
  ["family_model", "Family model"], ["relationship_read_pattern", "How she reads relationships"],
];

function PsychologyPanel({ actorId, worldId, canEdit = true }) {
  const url = `/api/worlds/${worldId}/actors/${actorId}/profile`;
  const { data, status, error, push, retry } = useLiveSection(url,
    next => ({ personality: next.personality, big5: next.big5, attachment: next.attachment }));

  if (data === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!data?.personality) return <p style={{ ...F, fontSize:13, color:"#993c1d" }}>No psychology rows for her in this world.</p>;

  const setP = (k, v) => push({ ...data, personality: { ...data.personality, [k]: v } });
  const setB = (k, v) => push({ ...data, big5: { ...data.big5, [k]: v } });

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20, maxWidth:620 }}>
      {!canEdit && <ReadOnlyNotice what="her psychology" />}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <Field label="Attachment style">
          <select disabled={!canEdit} value={data.attachment?.attachment_style || ""} style={inputS}
            onChange={e => push({ ...data, attachment: { ...(data.attachment||{}), attachment_style: e.target.value } })}>
            {ATTACHMENT.map(a => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <TextRow label="Marital status" value={data.personality.marital_status} onCommit={v => setP("marital_status", v)} readOnly={!canEdit} />
      </div>

      {data.big5 && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>Big five</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"9px 18px" }}>
            {BIG5.map(([k, label]) => (
              <div key={k}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                  <span style={{ ...F, fontSize:11.5, color:"#6b6760" }}>{label}</span>
                  <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11.5, color:"#1a1814" }}>{data.big5[k] ?? 50}</span>
                </div>
                <input disabled={!canEdit} type="range" min={0} max={100} step={1} value={data.big5[k] ?? 50}
                  onChange={e => setB(k, Number(e.target.value))}
                  style={{ width:"100%", accentColor:"#1a1814" }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {PSYCH_TEXT.map(([k, label]) => (
          <TextRow key={k} label={label} value={data.personality[k]} multiline onCommit={v => setP(k, v)} readOnly={!canEdit} />
        ))}
      </div>

      <SaveStatus status={status} error={error} onRetry={retry} />
    </div>
  );
}

// ── SchedulePanel ─────────────────────────────────────────────────────────────
//
// Read-only. The slots are generated from her revenue sources' work days and
// blocks, so editing a row here would be overwritten the next time a schedule is
// regenerated — the durable edit is on the revenue source, in Economy.
const DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function SchedulePanel({ actorId, worldId }) {
  const [d, setD] = useState(undefined);
  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/schedule`)
      .then(r => r.ok ? r.json() : null).then(x => setD(x || null)).catch(() => setD(null));
  }, [actorId, worldId]);

  if (d === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!d || !d.week_count) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>No schedule in this world.</p>;

  // Session 150 — a calendar grid rather than a list of times per day.
  //
  // Read as a list, "08:00–12:00 Work deep" seven times over says nothing about
  // shape. Laid out against a shared clock, the shape IS the information: where
  // the gaps are, that the weekend is empty, that lunch is the same hour every
  // day. Blocks are positioned by their real start and end, so an odd shift is
  // visible as an odd shape instead of having to be read for.
  const slots = d.slots || [];
  const toMin = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

  // Crop the day to what is actually used, so an all-day-at-home schedule does
  // not render as 24 rows of one colour.
  const used = slots.filter(s => (s.activity_slug || "") !== "relaxing");
  const dayStart = used.length ? Math.max(0, Math.min(...used.map(s => toMin(s.start_time))) - 60) : 6 * 60;
  const dayEnd   = used.length ? Math.min(24 * 60, Math.max(...used.map(s => toMin(s.end_time || "24:00"))) + 60) : 22 * 60;
  const span = Math.max(60, dayEnd - dayStart);
  const H = 460;
  const y = min => ((min - dayStart) / span) * H;

  const COLOR = {
    work_deep: ["rgba(29,158,117,.13)", "rgba(29,158,117,.32)", "#0F6E56"],
    eating:    ["rgba(186,117,23,.13)", "rgba(186,117,23,.30)", "#854F0B"],
    relaxing:  ["rgba(0,0,0,.035)",     "rgba(0,0,0,.09)",      "#6b6760"],
  };
  const hours = [];
  for (let h = Math.ceil(dayStart / 60); h * 60 <= dayEnd; h++) hours.push(h);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <p style={{ ...F, fontSize:12, color:"#6b6760", margin:0, lineHeight:1.6, maxWidth:620 }}>
        {d.week_count} weeks, {d.weeks[0]?.label} to {d.weeks[d.weeks.length-1]?.label}. Every week repeats this
        pattern — it's generated from her work days and hours, so change those in Economy rather than here.
      </p>

      <div style={{ display:"grid", gridTemplateColumns:"52px repeat(7, minmax(0,1fr))", gap:0,
        border:"1px solid rgba(0,0,0,.08)", borderRadius:11, overflow:"hidden", background:"rgba(255,255,255,.4)" }}>

        <div style={{ borderBottom:"1px solid rgba(0,0,0,.08)", background:"rgba(0,0,0,.02)" }} />
        {DAY_ORDER.map(day => (
          <div key={day} style={{ ...F, fontSize:9.5, letterSpacing:".12em", textTransform:"uppercase",
            color:"#6b6760", textAlign:"center", padding:"8px 0", borderLeft:"1px solid rgba(0,0,0,.06)",
            borderBottom:"1px solid rgba(0,0,0,.08)", background:"rgba(0,0,0,.02)" }}>
            {day.slice(0, 3)}
          </div>
        ))}

        <div style={{ position:"relative", height:H }}>
          {hours.map(h => (
            <div key={h} style={{ position:"absolute", top:y(h * 60) - 6, right:7, ...F,
              fontSize:9.5, color:"#a8a5a0", fontFamily:"'DM Mono',monospace" }}>
              {String(h).padStart(2, "0")}
            </div>
          ))}
        </div>

        {DAY_ORDER.map(day => (
          <div key={day} style={{ position:"relative", height:H, borderLeft:"1px solid rgba(0,0,0,.06)" }}>
            {hours.map(h => (
              <div key={h} style={{ position:"absolute", left:0, right:0, top:y(h * 60),
                borderTop:"1px solid rgba(0,0,0,.04)" }} />
            ))}
            {slots.filter(sl => sl.day_of_week === day).map(sl => {
              const top = y(toMin(sl.start_time));
              const bot = y(toMin(sl.end_time === "24:00" ? "24:00" : sl.end_time));
              const [bg, br, fg] = COLOR[sl.activity_slug] || COLOR.relaxing;
              const tall = bot - top > 30;
              return (
                <div key={sl.id}
                  title={`${sl.start_time}–${sl.end_time} · ${sl.activity_name || sl.activity_slug}${sl.state_note ? ` · ${sl.state_note}` : ""}`}
                  style={{ position:"absolute", left:2, right:2, top:Math.max(0, top),
                    height:Math.max(11, bot - top - 1.5), background:bg, border:`1px solid ${br}`,
                    borderRadius:5, padding: tall ? "3px 5px" : "0 5px", overflow:"hidden", boxSizing:"border-box" }}>
                  <div style={{ ...F, fontSize:9.5, color:fg, fontWeight:500, lineHeight:1.25,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {sl.activity_name || sl.activity_slug}
                  </div>
                  {tall && sl.state_note && (
                    <div style={{ ...F, fontSize:9, color:fg, opacity:.72, lineHeight:1.3, marginTop:1,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {sl.state_note}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MediaPanel ────────────────────────────────────────────────────────────────
function MediaPanel({ actorId, worldId }) {
  const [d, setD] = useState(undefined);
  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/media`)
      .then(r => r.ok ? r.json() : null).then(x => setD(x || null)).catch(() => setD(null));
  }, [actorId, worldId]);

  if (d === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!d?.items?.length) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>No media captured in this world yet.</p>;

  // Session 150 — grouped by what the file IS, taken from its MIME type rather
  // than its media_type. The two disagree: her voice sample is stored as
  // media_type "image" with mime "audio/mpeg", so trusting the label would put
  // an MP3 in the picture grid.
  const kind = m => {
    const t = m.mime_type || "";
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("audio/")) return "audio";
    if (t.startsWith("video/")) return "video";
    return "file";
  };
  const images = d.items.filter(m => kind(m) === "image");
  const audio  = d.items.filter(m => kind(m) === "audio");
  const others = d.items.filter(m => !["image", "audio"].includes(kind(m)));
  const label = m => m.state || m.name || (m.path || "").split("/").pop();

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, maxWidth:640 }}>
      <p style={{ ...F, fontSize:12, color:"#6b6760", margin:0, lineHeight:1.6 }}>
        {d.count} item{d.count === 1 ? "" : "s"} the simulator holds for her here. Undeploying erases these;
        the platform keeps its own archived copies.
      </p>

      {images.length > 0 && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>
            Images — {images.length}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(132px, 1fr))", gap:11 }}>
            {images.map(m => (
              <a key={m.id} href={m.path} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}>
                <div style={{ aspectRatio:"3/4", borderRadius:10, overflow:"hidden",
                  border:"1px solid rgba(0,0,0,.08)", background:"rgba(0,0,0,.03)" }}>
                  <img src={m.path} alt={label(m)} loading="lazy"
                    style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
                    onError={e => { e.currentTarget.style.display = "none"; }} />
                </div>
                <div style={{ ...F, fontSize:11, color:"#6b6760", marginTop:5, overflow:"hidden",
                  textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label(m)}</div>
              </a>
            ))}
          </div>
        </div>
      )}

      {audio.length > 0 && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>
            Voice — {audio.length}
          </div>
          {audio.map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 0" }}>
              <span style={{ ...F, fontSize:12.5, color:"#1a1814", width:132, flexShrink:0 }}>{label(m)}</span>
              <audio controls preload="none" src={m.path} style={{ height:32, flex:1, minWidth:0 }} />
            </div>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>
            Other — {others.length}
          </div>
          {others.map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"baseline", gap:11, padding:"7px 0",
              borderBottom:"1px solid rgba(0,0,0,.05)" }}>
              <span style={{ ...F, fontSize:9, letterSpacing:".08em", textTransform:"uppercase", color:"#6b6760",
                background:"rgba(0,0,0,.04)", padding:"2px 7px", borderRadius:5, flexShrink:0 }}>{m.media_type}</span>
              <a href={m.path} target="_blank" rel="noreferrer"
                style={{ ...F, fontSize:13, color:"#b05c08", flex:1, minWidth:0, overflow:"hidden",
                  textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{label(m)}</a>
              <span style={{ ...F, fontSize:11, color:"#a8a5a0", flexShrink:0 }}>
                {m.size_bytes ? `${Math.round(m.size_bytes / 1024).toLocaleString("de-DE")} kB` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SITUATIONS = ["struggling","precarious","stable","comfortable","wealthy"];
const STABILITY  = ["unemployed","freelance","stable","high_earner"];
const BASES      = ["monthly","per_contract","variable"];
const TYPES      = ["employment","freelance","business","investment","benefit","other"];
const EXP_CATEGORIES = ["rent","utilities","transit","food","phone","insurance","subscription","leisure","childcare","debt","other"];
// Only what payment_due_today? recognises — anything else is never charged.
const EXP_CADENCES   = ["monthly","quarterly","annual"];
const PER_MONTH      = { monthly: 1, quarterly: 1/3, annual: 1/12 };

function EconomyPanel({ actorId, worldId, currency, canEdit = true }) {
  const [data, setData]   = useState(undefined);
  const [status, setStatus] = useState("idle");   // idle | saving | saved | error
  const [error, setError]   = useState(null);

  const URL = `/api/worlds/${worldId}/actors/${actorId}/economy`;

  // Session 150 — no Save button: every edit writes straight to the simulator.
  //
  // Debounced, because the alternative is a PATCH per keystroke against a
  // character who is actively ticking — typing "92000" would fire five writes,
  // four of them describing salaries she never had. 700ms after you stop is
  // still "immediately" to a person and is one write to the server.
  //
  // The pending edit is held in a ref rather than read from state inside the
  // timer, so a burst of changes collapses into one PATCH carrying the latest
  // values instead of the values as of whenever the timer was armed.
  const pending = useRef(null);
  const timer   = useRef(null);
  const live    = useRef(true);
  useEffect(() => () => {
    live.current = false;
    // Flush on the way out, or an edit made a moment before navigating away is
    // silently dropped — the one failure mode a Save button made impossible.
    if (timer.current) { clearTimeout(timer.current); flush(); }
  }, []);

  async function flush() {
    const body = pending.current;
    if (!body) return;
    pending.current = null;
    setStatus("saving"); setError(null);
    try {
      const r = await fetch(URL, {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(body), keepalive: true,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        if (live.current) { setError(e.error || `Couldn't save — HTTP ${r.status}`); setStatus("error"); }
        return;
      }
      const fresh = await r.json();
      if (live.current) { setData(toMajor(fresh)); setStatus("saved"); }
    } catch (e) {
      if (live.current) { setError(`Couldn't save — ${e.message}`); setStatus("error"); }
    }
  }

  // `next` is passed in rather than read from state: setState is async, so
  // reading it here would serialise the value from before this very edit.
  // Every caller is now a completed edit — a committed field, a chosen option, a
  // clicked button — so there is nothing to debounce. The short timer only
  // coalesces changes that genuinely land together (removing a source also
  // renumbers the list) into one request.
  function push(next) {
    setData(next);
    pending.current = {
      revenue_sources: (next.revenue_sources || []).map(s => ({ ...s,
        monthly_amount: Number(s.monthly_amount) || 0,
        pay_day: s.pay_day === "" || s.pay_day == null ? null : Number(s.pay_day) })),
      balance_minor: Math.round(Number(next.bank_account?.balance_minor) || 0),
      economic: next.economic || {},
      fixed_expenses: (next.fixed_expenses || []).map(e => ({ ...e,
        amount: Number(e.amount) || 0,
        debit_day: Math.min(28, Math.max(1, Number(e.debit_day) || 1)) })),
    };
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 120);
  }

  // The server speaks minor units; this panel edits major ones. Convert on the
  // way in so every control below deals in kronor, and push() converts back.
  const toMajor = d => d && ({ ...d,
    fixed_expenses: (d.fixed_expenses || []).map(e => ({ ...e, amount: (e.amount_minor ?? 0) / 100 })) });

  useEffect(() => {
    fetch(URL).then(r => r.ok ? r.json() : null).then(d => setData(toMajor(d) || null)).catch(() => setData(null));
  }, [actorId, worldId]);

  if (data === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (data === null)      return <p style={{ ...F, fontSize:13, color:"#993c1d" }}>Couldn't load her economy — the simulator may be down.</p>;

  const cur = data.bank_account?.currency || currency || "SEK";
  const minor = 100;  // display only; the server owns the real minor-unit ratio

  const setSrc  = (i, patch) => push({ ...data, revenue_sources: data.revenue_sources.map((s, j) => j === i ? { ...s, ...patch } : s) });
  const dropSrc = (i)         => push({ ...data, revenue_sources: data.revenue_sources.filter((_, j) => j !== i) });
  const setExp  = (i, patch) => push({ ...data, fixed_expenses: (data.fixed_expenses||[]).map((e, j) => j === i ? { ...e, ...patch } : e) });
  const dropExp = (i)         => push({ ...data, fixed_expenses: (data.fixed_expenses||[]).filter((_, j) => j !== i) });
  const addExp  = ()          => push({ ...data, fixed_expenses: [...(data.fixed_expenses||[]),
      { name:"", category:"other", amount:0, cadence:"monthly", debit_day:1 }] });

  const addSrc  = ()          => push({ ...data, revenue_sources: [...data.revenue_sources,
      { name:"", source_type:"employment", monthly_amount:0, currency:cur, amount_basis:"monthly", pay_day:25 }] });

  const monthlyTotal = data.revenue_sources.reduce((t, s) => t + (Number(s.monthly_amount) || 0), 0);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, maxWidth:640 }}>
      {!canEdit && <ReadOnlyNotice what="her economy" />}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10 }}>
        {/* Session 150 — salaries are entered gross and taxed on payday, so
            showing only the headline figure overstates what she lives on. */}
        <div style={{ background:"rgba(0,0,0,.03)", borderRadius:10, padding:"11px 13px" }}>
          <div style={{ ...F, fontSize:11, color:"#a8a5a0" }}>Monthly income</div>
          <div style={{ fontFamily:"'DM Mono',monospace", fontSize:16, color:"#1a1814", marginTop:2 }}>
            {fmtAmount(monthlyTotal)} {cur}
          </div>
          {data.tax && data.tax.monthly_tax > 0 && (
            <div style={{ ...F, fontSize:11, color:"#6b6760", marginTop:5, lineHeight:1.5 }}>
              <span style={{ fontFamily:"'DM Mono',monospace" }}>{fmtAmount(data.tax.net_monthly)} {cur}</span> after tax
              <span style={{ color:"#a8a5a0" }}>
                {" · "}{(data.tax.effective_rate * 100).toFixed(1).replace(".", ",")}%
                {data.tax.country ? ` ${data.tax.country}` : ""}
                {data.tax.known === false ? " (estimated)" : ""}
              </span>
            </div>
          )}
        </div>
        <div style={{ background:"rgba(0,0,0,.03)", borderRadius:10, padding:"11px 13px" }}>
          <div style={{ ...F, fontSize:11, color:"#a8a5a0" }}>Balance</div>
          <AmountInput disabled={!canEdit} value={Math.round((data.bank_account?.balance_minor ?? 0) / minor)}
            onCommit={v => push({ ...data,
              bank_account: { ...(data.bank_account||{}), balance_minor: Math.round((v || 0) * minor) } })}
            style={{ ...inputS, fontFamily:"'DM Mono',monospace", fontSize:15, padding:"2px 6px", marginTop:2, border:"1px solid rgba(0,0,0,.1)" }} />
        </div>
      </div>

      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:9 }}>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" }}>
            Revenue sources — {data.revenue_sources.length}
          </div>
          {canEdit && <button onClick={addSrc} style={{ ...F, fontSize:11, padding:"5px 12px", borderRadius:7,
            border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>+ Add</button>}
        </div>

        {data.revenue_sources.length === 0 && (
          <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>No income in this world.</p>
        )}

        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {data.revenue_sources.map((src, i) => (
            <div key={src.id || `new-${i}`} style={{ border:"1px solid rgba(0,0,0,.09)", borderRadius:11, padding:"12px 13px" }}>
              <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:9, marginBottom:9 }}>
                <Field label="Name">
                  <CommitInput disabled={!canEdit} value={src.name || ""} onCommit={v => setSrc(i, { name: v })}
                    placeholder="Employer or client" style={inputS} />
                </Field>
                <Field label="Type">
                  <select disabled={!canEdit} value={src.source_type || "employment"} onChange={e => setSrc(i, { source_type: e.target.value })} style={inputS}>
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))", gap:9 }}>
                <Field label={`Amount (${cur})`}>
                  <AmountInput disabled={!canEdit} value={src.monthly_amount ?? 0}
                    onCommit={v => setSrc(i, { monthly_amount: v ?? 0 })} style={inputS} />
                </Field>
                <Field label="Basis">
                  <select disabled={!canEdit} value={src.amount_basis || "monthly"} onChange={e => setSrc(i, { amount_basis: e.target.value })} style={inputS}>
                    {BASES.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
                <Field label="Pay day">
                  <CommitInput type="number" min="1" max="28" value={src.pay_day ?? ""}
                    onCommit={v => setSrc(i, { pay_day: v })}
                    disabled={!canEdit || src.amount_basis === "per_contract"}
                    style={{ ...inputS, opacity: src.amount_basis === "per_contract" ? .45 : 1 }} />
                </Field>
              </div>
              {src.work_address && (
                <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:9 }}>{src.work_address}</div>
              )}
              <div style={{ display:"flex", justifyContent:"flex-end", marginTop:9 }}>
                {canEdit && <button onClick={() => dropSrc(i)} title="Remove this source"
                  style={{ ...F, fontSize:11, padding:"4px 10px", borderRadius:7, border:"1px solid rgba(192,57,43,.2)",
                    background:"rgba(192,57,43,.05)", color:"#993c1d", cursor:"pointer" }}>Remove</button>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Fixed expenses ──────────────────────────────────────────────────
          Session 150 — what leaves her account, and when.

          The endpoint has returned these since it was written; the panel simply
          never rendered them, so a character configured with six expenses in the
          wizard looked, here, like someone with no outgoings at all. Each row is
          charged by ScheduledPaymentProcess on its debit_day and shows up in the
          ledger below, which is why the two sit next to each other. */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:9 }}>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0" }}>
            Fixed expenses — {(data.fixed_expenses || []).length}
          </div>
          {canEdit && <button onClick={addExp} style={{ ...F, fontSize:11, padding:"5px 12px", borderRadius:7,
            border:"1px solid rgba(0,0,0,.12)", background:"none", color:"#6b6760", cursor:"pointer" }}>+ Add</button>}
        </div>

        {(data.fixed_expenses || []).length === 0 && (
          <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:"0 0 4px" }}>
            Nothing leaves her account — her balance can only grow, and runway can't be computed.
          </p>
        )}

        {(data.fixed_expenses || []).map((exp, i) => (
          <div key={exp.id || `new-${i}`}
            style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr .9fr .9fr .6fr auto",
              gap:7, alignItems:"center", padding:"7px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
            <CommitInput disabled={!canEdit} value={exp.name || ""} onCommit={v => setExp(i, { name: v })} placeholder="Rent"
              style={{ ...inputS, fontSize:12.5, padding:"6px 9px" }} />
            <select disabled={!canEdit} value={exp.category || "other"} onChange={e => setExp(i, { category: e.target.value })}
              style={{ ...inputS, fontSize:12.5, padding:"6px 9px" }}>
              {EXP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <AmountInput disabled={!canEdit} value={exp.amount ?? 0} onCommit={v => setExp(i, { amount: v || 0 })}
              style={{ ...inputS, fontSize:12.5, padding:"6px 9px", fontFamily:"'DM Mono',monospace" }} />
            <select disabled={!canEdit} value={exp.cadence || "monthly"} onChange={e => setExp(i, { cadence: e.target.value })}
              style={{ ...inputS, fontSize:12.5, padding:"6px 9px" }}>
              {EXP_CADENCES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <CommitInput disabled={!canEdit} type="number" min="1" max="28" value={exp.debit_day ?? 1}
              onCommit={v => setExp(i, { debit_day: Math.min(28, Math.max(1, Number(v) || 1)) })}
              title="Day of the month it is charged"
              style={{ ...inputS, fontSize:12.5, padding:"6px 9px", fontFamily:"'DM Mono',monospace" }} />
            {canEdit && <span onClick={() => dropExp(i)} title={`Remove ${exp.name || "this expense"}`}
              style={{ ...F, fontSize:13, color:"#c0392b", cursor:"pointer", padding:"0 4px" }}>✕</span>}
          </div>
        ))}

        {(data.fixed_expenses || []).length > 0 && (() => {
          const out = (data.fixed_expenses || [])
            .reduce((t, e) => t + (Number(e.amount) || 0) * (PER_MONTH[e.cadence || "monthly"] || 1), 0);
          // Session 150 — measured against take-home, not gross. Subtracting her
          // costs from a figure the tax authority takes 39% of reported a margin
          // she does not have.
          const spendable = data.tax && data.tax.monthly_tax > 0
            ? (monthlyTotal - data.tax.gross_monthly) + data.tax.net_monthly
            : monthlyTotal;
          const net = spendable - out;
          const runway = out > 0 ? ((data.bank_account?.balance_minor ?? 0) / 100) / out : null;
          return (
            <div style={{ ...F, fontSize:11.5, color:"#6b6760", marginTop:9, display:"flex", gap:14, flexWrap:"wrap" }}>
              <span>{fmtAmount(out)} {cur}/month out</span>
              <span style={{ color: net < 0 ? "#993c1d" : "#0F6E56" }}>
                {fmtSigned(net)} {cur} left
                {net < 0 ? " — she loses money every month" : ""}
              </span>
              {runway !== null && <span style={{ color:"#a8a5a0" }}>{runway.toFixed(1)} months runway</span>}
            </div>
          );
        })()}
      </div>

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>Disposition</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:9 }}>
          <Field label="Financial situation">
            <select disabled={!canEdit} value={data.economic?.financial_situation || ""} style={inputS}
              onChange={e => push({ ...data, economic: { ...(data.economic||{}), financial_situation: e.target.value } })}>
              {SITUATIONS.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Income stability">
            <select disabled={!canEdit} value={data.economic?.income_stability || ""} style={inputS}
              onChange={e => push({ ...data, economic: { ...(data.economic||{}), income_stability: e.target.value } })}>
              {STABILITY.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {(data.transactions || []).length > 0 && (
        <div>
          <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:9 }}>Ledger</div>
          {data.transactions.slice(0, 8).map((t, i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
              <span style={{ ...F, fontSize:12, color:"#1a1814", flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {t.description || t.category}
              </span>
              <span style={{ fontFamily:"'DM Mono',monospace", fontSize:12,
                color: t.amount_minor < 0 ? "#993c1d" : "#0F6E56" }}>
                {fmtSigned(t.amount_minor / minor)}
              </span>
              <span style={{ ...F, fontSize:10, color:"#a8a5a0", width:78, textAlign:"right" }}>
                {(t.inserted_at || "").slice(0, 10)}
              </span>
            </div>
          ))}
        </div>
      )}

      <SaveStatus status={status} error={error} onRetry={flush} />
    </div>
  );
}

function RuntimePanel({ actorId, worldId }) {
  const [block, setBlock] = useState(undefined);

  useEffect(() => {
    fetch(`/api/actors/${actorId}/in-play`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setBlock((d?.data || []).find(w => w.world_id === worldId) || null))
      .catch(() => setBlock(null));
  }, [actorId, worldId]);

  if (block === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;
  if (!block) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>No runtime state in this world yet.</p>;

  const rels = Object.values((block.relationships || []).reduce((acc, r) => {
    if (!acc[r.target_id] || (r.warmth || 0) > (acc[r.target_id].warmth || 0)) acc[r.target_id] = r;
    return acc;
  }, {}));
  const mems = [...(block.memories || [])].sort((a,b) => (b.inserted_at || "").localeCompare(a.inserted_at || ""));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, maxWidth:620 }}>
      {block.current_activity && (
        <div style={{ ...F, fontSize:13, color:"#6b6760" }}>
          Right now — <span style={{ color:"#1a1814" }}>{block.current_activity}</span>
        </div>
      )}

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>
          Relationships — {rels.length}
        </div>
        {rels.length === 0 && <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>None formed yet.</p>}
        {rels.map(r => (
          <div key={r.target_id} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
            <span style={{ ...F, fontSize:13, color:"#1a1814", flex:1 }}>{r.target_name || r.other_name || "—"}</span>
            {r.rel_type && <span style={{ ...F, fontSize:10, padding:"2px 8px", borderRadius:5, background:"rgba(0,0,0,.04)", color:"#6b6760" }}>{r.rel_type}</span>}
            {r.warmth != null && <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#a8a5a0" }}>warmth {Number(r.warmth).toFixed(2)}</span>}
          </div>
        ))}
      </div>

      <div>
        <div style={{ ...F, fontSize:10, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>
          Memories — {mems.length}
        </div>
        {mems.length === 0 && <p style={{ ...F, fontSize:13, color:"#a8a5a0", margin:0 }}>Nothing remembered yet.</p>}
        {mems.slice(0,25).map(m => (
          <div key={m.id} style={{ padding:"8px 0", borderBottom:"1px solid rgba(0,0,0,.05)" }}>
            <p style={{ ...F, fontSize:13, color:"#1a1814", margin:"0 0 2px", lineHeight:1.6 }}>{m.summary || m.content}</p>
            <span style={{ ...F, fontSize:10, color:"#a8a5a0" }}>
              {[m.memory_type, m.emotional_tag, (m.inserted_at || "").slice(0,10)].filter(Boolean).join(" · ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HomePanel({ actorId, worldId }) {
  const [home, setHome] = useState(undefined);
  const [econ, setEcon] = useState(null);

  useEffect(() => {
    // GET .../home did not exist until Session 150 — only the POST did. Express's
    // SPA catch-all skipped /api paths without responding, so this fetch never
    // settled and the panel showed "Loading…" indefinitely rather than an error.
    fetch(`/api/worlds/${worldId}/actors/${actorId}/home`)
      .then(r => r.ok ? r.json() : null).then(d => setHome(d || null)).catch(() => setHome(null));
    // Workplaces live on the revenue sources, not on the actor.
    fetch(`/api/worlds/${worldId}/actors/${actorId}/economy`)
      .then(r => r.ok ? r.json() : null).then(setEcon).catch(() => {});
  }, [actorId, worldId]);

  if (home === undefined) return <p style={{ ...F, fontSize:13, color:"#a8a5a0" }}>Loading…</p>;

  const workplaces = (econ?.revenue_sources || []).filter(r => r.work_address);
  const Card = ({ label, title, sub, note }) => (
    <div style={{ padding:"13px 15px", background:"rgba(0,0,0,.02)", border:"1px solid rgba(0,0,0,.06)", borderRadius:11 }}>
      <div style={{ ...F, fontSize:9, letterSpacing:".16em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:6 }}>{label}</div>
      <div style={{ ...F, fontSize:14, color:"#1a1814" }}>{title}</div>
      {sub  && <div style={{ ...F, fontSize:12, color:"#6b6760", marginTop:3 }}>{sub}</div>}
      {note && <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:7 }}>{note}</div>}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12, maxWidth:560 }}>
      {home?.home_address
        ? <Card label="Home" title={home.home_address}
            sub={home.home_lat ? `${Number(home.home_lat).toFixed(4)}, ${Number(home.home_lng).toFixed(4)}` : null}
            note="Move her on the world's Residences map." />
        : <Card label="Home" title="No home set in this world" note="Set one on the world's Residences map." />}

      {workplaces.length === 0
        ? <Card label="Work" title="No workplace on any revenue source" note="Add one in Economy." />
        : workplaces.map(w => (
            <Card key={w.id} label="Work" title={w.name || "Workplace"} sub={w.work_address}
              note={`${w.work_days ? (typeof w.work_days === "string" ? JSON.parse(w.work_days) : w.work_days).length : 0} days a week · edit in Economy`} />
          ))}
    </div>
  );
}

export default function WorldActorPage() {
  const { worldId, actorId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Session 150 — the deploy wizard hands this over in router state, so it shows
  // once on arrival and is gone on reload. Dismissed by clearing the history
  // entry's state rather than a flag, so a back-navigation cannot resurrect it.
  const [deployed, setDeployed] = useState(location.state?.justDeployed || null);

  // Read on every location change, not only at mount. A useState initialiser
  // runs once, so arriving at this route while the component is already mounted
  // — the router reusing it across a param change — would drop the banner.
  useEffect(() => {
    if (location.state?.justDeployed) setDeployed(location.state.justDeployed);
  }, [location.state]);
  function dismissDeployed() {
    setDeployed(null);
    if (location.state?.justDeployed) navigate(location.pathname, { replace: true, state: null });
  }
  const [actor, setActor] = useState(null);
  const [world, setWorld] = useState(null);
  const [tab, setTab]     = useState("runtime");

  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors`)
      .then(r => r.ok ? r.json() : [])
      .then(list => {
        const a = (Array.isArray(list) ? list : []).find(x => x.id === actorId) || null;
        setActor(a);
        if (a) document.title = `Anima — ${a.name}`;
      }).catch(() => {});
    fetch("/api/worlds")
      .then(r => r.ok ? r.json() : [])
      .then(ws => setWorld(ws.find(w => w.id === worldId) || null)).catch(() => {});
  }, [worldId, actorId]);

  const LABELS = {
    economy:"Economy", homework:"Home and work", schedule:"Schedule",
    identity:"Identity", psych:"Psychology", media:"Media", runtime:"Runtime",
  };

  // A player may look but not build. The server enforces this on
  // every PATCH; this makes the answer visible before anything is typed.
  const canEdit = world?.role === "owner";

  const panels = {
    runtime:  <RuntimePanel actorId={actorId} worldId={worldId} />,
    homework: <HomePanel actorId={actorId} worldId={worldId} />,
    economy:  <EconomyPanel actorId={actorId} worldId={worldId} currency={world?.currency} canEdit={canEdit} />,
    schedule: <SchedulePanel actorId={actorId} worldId={worldId} />,
    identity: <IdentityPanel actorId={actorId} worldId={worldId} canEdit={canEdit} />,
    psych:    <PsychologyPanel actorId={actorId} worldId={worldId} canEdit={canEdit} />,
    media:    <MediaPanel actorId={actorId} worldId={worldId} />,
  };

  return (
    <div style={{ background:"#eeecea", minHeight:"100vh", position:"relative" }}>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, background:"radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%), #eeecea" }} />
      <div style={{ position:"relative", zIndex:1, display:"grid", gridTemplateColumns:"240px 1fr", minHeight:"100vh" }}>

        <div style={{ background:"rgba(255,255,255,.55)", backdropFilter:"blur(40px)", WebkitBackdropFilter:"blur(40px)", borderRight:"1px solid rgba(255,255,255,.9)", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 20px 16px", borderBottom:"1px solid rgba(0,0,0,.06)" }}>
            <a onClick={() => navigate(`/my-worlds/${worldId}`)} style={{ ...F, fontSize:11, letterSpacing:".08em", textTransform:"uppercase", color:"#a8a5a0", cursor:"pointer", display:"block", marginBottom:16 }}>
              ← {world?.name || "World"}
            </a>
            {actor?.photo_url
              ? <img src={actor.photo_url} alt="" style={{ width:52, height:52, borderRadius:"50%", objectFit:"cover", marginBottom:12 }} />
              : <div style={{ width:52, height:52, borderRadius:"50%", background:"rgba(0,0,0,.07)", display:"flex", alignItems:"center", justifyContent:"center", ...F, fontSize:17, color:"#6b6760", marginBottom:12 }}>{ini(actor?.name)}</div>}
            <div style={{ ...serif, fontSize:20, fontWeight:500, color:"#1a1814", lineHeight:1.1 }}>{actor?.name || "…"}</div>
            <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginTop:3 }}>{actor?.occupation || ""}</div>
            {/* Session 150 — carry the origin across.
                The basic profile's back link is hard-wired to "← Characters",
                which is right when you arrived from the gallery and wrong when
                you came from here: it sends you to a list instead of back to the
                world you were working in. */}
            <a onClick={() => navigate(`/actors/${actorId}`, {
                 state: { from: { label: world?.name || "World", path: `/my-worlds/${worldId}/actors/${actorId}` } },
               })}
              style={{ ...F, fontSize:11, color:"#b05c08", cursor:"pointer", display:"block", marginTop:10 }}>
              View basic profile →
            </a>

            {/* Session 152 — the same control as the character page and the
                gallery. This page is where you watch a deployment; it should be
                somewhere you can end one. */}
            <div style={{ marginTop: 12 }}>
              <UndeployButton
                actorId={actorId}
                worldId={worldId}
                worldName={world?.name}
                name={actor?.name}
                onDone={() => navigate(`/my-worlds/${worldId}`)}
              />
            </div>
          </div>

          <div style={{ flex:1, overflowY:"auto", paddingBottom:8 }}>
            <NavSection label="In this world" />
            <NavItem label={LABELS.economy}  active={tab==="economy"}  onClick={() => setTab("economy")} />
            <NavItem label={LABELS.homework} active={tab==="homework"} onClick={() => setTab("homework")} />
            <NavItem label={LABELS.schedule} active={tab==="schedule"} onClick={() => setTab("schedule")} />
            <NavSection label="Profile" />
            <NavItem label={LABELS.identity} active={tab==="identity"} onClick={() => setTab("identity")} />
            <NavItem label={LABELS.psych}    active={tab==="psych"} onClick={() => setTab("psych")} />
            <NavItem label={LABELS.media}    active={tab==="media"} onClick={() => setTab("media")} />
            <NavSection label="Runtime" />
            <NavItem label={LABELS.runtime}  active={tab==="runtime"}  onClick={() => setTab("runtime")} />
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px 28px 16px", borderBottom:"1px solid rgba(0,0,0,.06)", background:"rgba(255,255,255,.3)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)" }}>
            <div style={{ ...F, fontSize:11, color:"#a8a5a0", marginBottom:2 }}>
              <span onClick={() => navigate("/my-worlds")} style={{ cursor:"pointer", color:"#b05c08" }}>My worlds</span>
              {" › "}
              <span onClick={() => navigate(`/my-worlds/${worldId}`)} style={{ cursor:"pointer", color:"#b05c08" }}>{world?.name || "World"}</span>
              {" › "}{actor?.name || "…"}
            </div>
            <div style={{ ...serif, fontSize:26, fontWeight:400, color:"#1a1814" }}>{LABELS[tab]}</div>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:"24px 28px" }}>
            {deployed && (
              <div style={{ display:"flex", alignItems:"flex-start", gap:11, padding:"13px 15px", marginBottom:20,
                background:"rgba(29,158,117,.07)", border:"1px solid rgba(29,158,117,.22)", borderRadius:11 }}>
                <span style={{ color:"#1D9E75", fontSize:15, lineHeight:1.2, flexShrink:0 }}>✓</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ ...F, fontSize:13.5, color:"#0F6E56", fontWeight:500 }}>
                    {deployed.name} is live in {deployed.world}
                  </div>
                  <div style={{ ...F, fontSize:12, color:"#6b6760", marginTop:2, lineHeight:1.55 }}>
                    {[
                      deployed.sources  ? `${deployed.sources} revenue source${deployed.sources === 1 ? "" : "s"}` : null,
                      deployed.expenses ? `${deployed.expenses} fixed expense${deployed.expenses === 1 ? "" : "s"}` : null,
                      deployed.weeks    ? `${deployed.weeks} weeks of schedule` : null,
                    ].filter(Boolean).join(" · ")} — everything below is editable and writes straight to the simulator.
                  </div>
                </div>
                <button onClick={dismissDeployed} aria-label="Dismiss"
                  style={{ ...F, background:"none", border:"none", color:"#0F6E56", fontSize:14,
                    cursor:"pointer", lineHeight:1, padding:"0 2px", flexShrink:0, opacity:.6 }}>✕</button>
              </div>
            )}
            {panels[tab] || null}
          </div>
        </div>

      </div>
    </div>
  );
}
