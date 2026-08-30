import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { useNavigate } from "react-router-dom";
import AssessmentDetailView from "./AssessmentDetailView";
import MiniGlbViewer from "./MiniGlbViewer";
import AccessoryEditor, {
  defaultAccessories,
  fetchAccessoryOptions,
  buildViewerAccessories,
  ACCESSORY_REGION_CAMERA,
} from "./AccessoryEditor";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { NATIONALITIES, flagEmoji } from "./nationalities.js"; // Session 149 — moved out of this file so ActorsEditorPage.jsx can share it; see nationalities.js for Session 148 rationale.
import { attachKtx2 } from "../lib/gltfKtx2.js";
import { APP_SELECTS, FEMALE_FRAME, MALE_FRAME, emptyAppearanceFields, composeAppearance } from "../lib/appearance.js";

// Session 106 — self-generating home thumbnails. A static .jpg beside
// the GLB (/media/homes/<name>.jpg) wins when present; otherwise the
// card loads the GLB once, renders a single elevated three-quarter
// frame offscreen, and caches the dataURL for the session — so any
// home added to the catalog previews itself with no manual screenshot
// step. Renderer is created and disposed per shot (a leaked WebGL
// context per card would exhaust the browser's context limit). Same
// DRACO decoder path as MiniGlbViewer — the modern apartment ships
// Draco-compressed.
const homeThumbCache = new Map(); // glb_url -> dataURL | "failed"
async function renderHomeThumb(glbUrl) {
  if (homeThumbCache.has(glbUrl)) return homeThumbCache.get(glbUrl);
  try {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    loader.setDRACOLoader(draco);
    attachKtx2(loader);   // runtime GLBs carry KTX2 textures — see lib/gltfKtx2.js
    const gltf = await loader.loadAsync(glbUrl);
    const root = gltf.scene;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0eeea);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 6, 4);
    scene.add(sun);
    scene.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(50, 300 / 180, 0.1, 200);
    // Elevated three-quarter view from outside a front corner, aimed at
    // the interior — reads as "a home" rather than a wall.
    const d = Math.max(size.x, size.z);
    cam.position.set(centre.x + d * 0.55, box.max.y + d * 0.35, centre.z + d * 0.55);
    cam.lookAt(centre.x, centre.y - size.y * 0.1, centre.z);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(300, 180);
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL("image/jpeg", 0.85);
    renderer.dispose();
    draco.dispose();
    homeThumbCache.set(glbUrl, url);
    return url;
  } catch (err) {
    console.warn("[CharacterWizard] home thumbnail render failed for", glbUrl, err);
    homeThumbCache.set(glbUrl, "failed");
    return "failed";
  }
}

function HomeThumbnail({ glbUrl, name }) {
  const staticThumb = glbUrl.replace(/\.glb(\?.*)?$/i, ".jpg");
  const [src, setSrc] = useState(staticThumb);
  const [phase, setPhase] = useState("static"); // static -> rendering -> rendered | failed
  useEffect(() => { setSrc(glbUrl.replace(/\.glb(\?.*)?$/i, ".jpg")); setPhase("static"); }, [glbUrl]);
  const onStaticError = () => {
    if (phase !== "static") return;
    setPhase("rendering");
    renderHomeThumb(glbUrl).then(url => {
      if (url === "failed") setPhase("failed");
      else { setSrc(url); setPhase("rendered"); }
    });
  };
  if (phase === "failed") {
    return <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",background:"#e8e5e0",fontSize:22,color:"#a8a5a0"}}>⌂</div>;
  }
  if (phase === "rendering") {
    return <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",background:"#e8e5e0",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:"#a8a5a0"}}>rendering preview…</div>;
  }
  return <img src={src} alt={name} onError={onStaticError} style={{width:"100%",height:90,objectFit:"cover",display:"block",background:"#e8e5e0"}} />;
}



const STEPS = ["Appearance", "Accessories", "Psychology", "Personality", "Lifestyle", "Economy", "Review"];
// The gendered frame keys read better with a label than with the raw key.
const APP_LABELS = { bust:"Bust", figure:"Silhouette", waist_hip_ratio:"Waist-hip ratio", legs:"Legs", physique:"Physique", shoulders:"Shoulders", height_dominance:"Height dominance" };

// ACCESSORY_SCHEMA, OVERRIDDEN_BY_FULL_OUTFIT, OCCLUDES, defaultAccessories,
// and ACCESSORY_CATEGORY_TO_SLOT moved to ./AccessoryEditor.jsx (Session
// 108→109 extraction) — that file is now the single source of truth for
// the wardrobe schema, shared with ActorModelPanel's Wardrobe panel.

const S = {
  head: { padding:"1.75rem 2rem 1.25rem",borderBottom:"1px solid rgba(0,0,0,0.06)",flexShrink:0 },
  body: { flex:1,overflowY:"auto",padding:"1.75rem 2rem" },
  foot: { padding:"0.85rem 2rem",borderTop:"1px solid rgba(0,0,0,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0, position:"sticky", bottom:0, background:"rgba(245,244,241,0.96)", backdropFilter:"blur(6px)", zIndex:20 }, // Session 103 — sticky: Next/Back always reachable without scrolling the long step forms
  serif: { fontFamily:"'Cormorant Garamond',Georgia,serif" },
  label: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#a8a5a0",display:"block",marginBottom:7 },
  input: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:14,color:"#1a1814",background:"rgba(255,255,255,0.7)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:10,padding:"10px 14px",width:"100%",outline:"none" },
  textarea: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:14,color:"#1a1814",background:"rgba(255,255,255,0.7)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:10,padding:"10px 14px",width:"100%",outline:"none",resize:"vertical",lineHeight:1.6 },
  select: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:14,color:"#1a1814",background:"rgba(255,255,255,0.7)",border:"1px solid rgba(0,0,0,0.1)",borderRadius:10,padding:"10px 14px",width:"100%",outline:"none",appearance:"none" },
  row2: { display:"grid",gridTemplateColumns:"1fr 1fr",gap:14 },
  sf: { marginBottom:18 },
  btnPrimary: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,letterSpacing:"0.06em",textTransform:"uppercase",padding:"11px 24px",borderRadius:10,background:"#1a1814",color:"#faf8f4",border:"none",cursor:"pointer" },
  btnSecondary: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,letterSpacing:"0.06em",textTransform:"uppercase",padding:"11px 24px",borderRadius:10,background:"none",border:"1px solid rgba(0,0,0,0.1)",color:"#6b6760",cursor:"pointer" },
  btnAmber: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,letterSpacing:"0.08em",textTransform:"uppercase",padding:"6px 14px",borderRadius:8,background:"rgba(176,92,8,0.08)",border:"1px solid rgba(176,92,8,0.2)",color:"#b05c08",cursor:"pointer",flexShrink:0 },
  btnAmberFull: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,letterSpacing:"0.08em",textTransform:"uppercase",padding:"11px 0",borderRadius:8,background:"rgba(176,92,8,0.08)",border:"1px solid rgba(176,92,8,0.2)",color:"#b05c08",cursor:"pointer",width:"100%",marginBottom:20 },
  btnSave: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,letterSpacing:"0.06em",textTransform:"uppercase",padding:"13px 32px",borderRadius:12,background:"#c9973a",color:"#fff",border:"none",cursor:"pointer" },
  hint: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginTop:5,lineHeight:1.5 },
  secLabel: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.2em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:14,marginTop:24,paddingBottom:10,borderBottom:"1px solid rgba(0,0,0,0.06)" },
  sliderRow: { display:"flex",alignItems:"center",gap:12,marginBottom:12 },
  sliderLbl: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#6b6760",width:120,flexShrink:0 },
  sliderVal: { fontFamily:"'DM Mono',monospace,sans-serif",fontSize:12,color:"#b05c08",width:28,textAlign:"right",flexShrink:0 },
  reviewCard: { background:"rgba(255,255,255,0.6)",border:"1px solid rgba(0,0,0,0.06)",borderRadius:12,padding:"14px 16px",marginBottom:12 },
  reviewTitle: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:10 },
  reviewRow: { display:"flex",justifyContent:"space-between",marginBottom:6 },
  reviewKey: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#a8a5a0" },
  reviewVal: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#1a1814",maxWidth:"60%",textAlign:"right" },
  assessRow: { display:"flex",alignItems:"flex-start",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid rgba(0,0,0,0.05)",gap:12 },
  assessResult: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#6b6760",marginTop:6,lineHeight:1.6,padding:"8px 12px",background:"rgba(0,0,0,0.03)",borderRadius:8,marginBottom:4 },
};

// Real macOS activity indicator — a ring of tapered blades, each fading
// through the same opacity cycle at a staggered start point (negative
// animation-delay), which is how the authentic spinner works: nothing
// actually rotates, only opacity sweeps around the ring. Genuinely
// different from a single rotating arc, which is what was here before.
function MacSpinner({ size = 40 }) {
  const blades = 12;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {Array.from({ length: blades }).map((_, i) => (
        <div key={i} style={{
          position: "absolute", top: "50%", left: "50%",
          width: size * 0.09, height: size * 0.26,
          background: "#c9973a",
          borderRadius: size * 0.045,
          transform: `rotate(${(360 / blades) * i}deg) translate(0, -${size * 0.37}px)`,
          transformOrigin: "center",
          opacity: 0.35,
          animation: "macSpinnerBlade 1s linear infinite",
          animationDelay: `${-(i / blades)}s`,
        }} />
      ))}
      <style>{`@keyframes macSpinnerBlade { 0% { opacity: 1; } 100% { opacity: 0.35; } }`}</style>
    </div>
  );
}

function Field({ label, hint, children, required }) {
  return <div style={S.sf}><label style={S.label}>{label}{required&&<span style={{color:"#c0392b"}}> *</span>}</label>{children}{hint&&<div style={S.hint}>{hint}</div>}</div>;
}
function Slider({ label, value, onChange, disabled }) {
  return (
    <div style={{...S.sliderRow, opacity: disabled?0.4:1}}>
      <span style={S.sliderLbl}>{label}</span>
      <input type="range" min={-100} max={100} value={value} disabled={disabled} onChange={e=>onChange(Number(e.target.value))} style={{flex:1,minWidth:0,accentColor:"#b05c08",height:4,cursor:disabled?"not-allowed":"pointer"}} />
      <span style={S.sliderVal}>{disabled?"—":value}</span>
    </div>
  );
}

// Real feature (Session 101+) — foldable Adjustments section headers.
// Needed now that the real morph count (93 real, baked, working
// sliders — see generate3d.js's bakeAllMorphsAtDefault()) makes a
// fully-flat, always-expanded layout impractical. Same S.secLabel
// styling as before (untouched, still matches the approved mockup's
// header look), just made clickable with a rotating chevron for
// expanded/collapsed state. Each section owns its own boolean in the
// parent's expandedSections state — plain object, not one useState per
// section, since the section list itself may keep growing.
function FoldableSection({ title, expanded, onToggle, children }) {
  return (
    <div>
      <div
        style={{...S.secLabel, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", userSelect:"none"}}
        onClick={onToggle}
      >
        <span>{title}</span>
        <span style={{fontSize:11, color:"#a8a5a0", transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition:"transform 0.15s", display:"inline-block"}}>▸</span>
      </div>
      {expanded && children}
    </div>
  );
}

async function callAI(prompt) {
  // Session 103 - third member of the undefined-variable family
  // (data/d, json/j x2): every AI call dropped its answer on the
  // return line. Also: no status check - a server 500 used to surface
  // as parse noise instead of the server's actual message.
  const res = await fetch("/api/generate/profile", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ prompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `generate/profile ${res.status}`);
  return data.text || "";
}

// Session 103 — authored text must not live in peepholes: a textarea
// that grows to its content, sized on mount (restored drafts arrive
// full) and on every change. resize stays available for shrinking.
function AutoTextarea({ style, value, ...props }) {
  const ref = (el) => { if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; } };
  return <textarea ref={ref} style={{ ...style, overflow: "hidden" }} value={value} {...props} />;
}

export default function CharacterWizard({ user, worlds, mode = "character" }) {
  // ── Avatar mode ───────────────────────────────────────────────────────────
  //
  // The same wizard, building YOU rather than a character. It shows only the
  // steps that describe a body — Appearance, Accessories, Review — and skips
  // Psychology, Personality, Lifestyle and Economy, which author an NPC's inner
  // life. A player brings their own; the simulator drives those tables for AI
  // actors and never for the person holding the mouse.
  //
  // Deliberately a mode on this component and not a fork of it. The appearance
  // step is the morph editor, the reference-photo solve, the draft rail and the
  // GLB export — reimplementing any of that for a second caller would mean two
  // of them to keep correct.
  const isAvatar = mode === "avatar";
  const AVATAR_STEPS = [1, 2, 7];   // Appearance, Accessories, Review
  // Where every exit lands. You reached avatar mode from /home; sending you
  // to the character gallery on the way out would strand you somewhere you
  // never asked to be.
  const exitTo = isAvatar ? "/home" : "/actors";
  const navigate = useNavigate();
  const [step, setStep]       = useState(1);
  // Session 97: real accessories state — selected value per region/slot,
  // and which slot's picker modal is currently open (null = closed).
  const [accessories, setAccessories] = useState(() => defaultAccessories());
  const [activeSlot, setActiveSlot] = useState(null);
  // Session 102 — game-equipment navigation (AC/WoW pattern, user's
  // explicit design): pick a body region first, the CAMERA zooms to it
  // (reusing the focusRegion mechanism built for the Appearance step),
  // and only that region's slots show. The slot detail view
  // (options + fit sliders + per-part pills) is unchanged underneath.
  const [activeAccessoryRegion, setActiveAccessoryRegion] = useState("Torso");
  // ACCESSORY_REGION_CAMERA moved to ./AccessoryEditor.jsx.
  // Real, loadable accessory GLB URLs — keyed by "Region.Slot" (e.g.
  // "Head.Hairstyle", "Underwear.Top"), set only when the user actually
  // clicks an option that has a real asset behind it. Starts empty so
  // nothing loads by default. Generalized from an earlier, hair-only
  // single-value version — now scales to any number of dynamic slots
  // (hair, underwear top/bottom, and whatever else lands later)
  // without needing a new named state variable each time.
  const [selectedAccessoryGlbUrls, setSelectedAccessoryGlbUrls] = useState({});
  // stripV/freshUrl moved to ./AccessoryEditor.jsx (used internally by
  // buildViewerAccessories now — see the <MiniGlbViewer accessories=.../>
  // call below).
  // Per-accessory manual scale correction — keyed the same way as
  // selectedAccessoryGlbUrls ("Region.Slot"), value {x,y,z}, applied
  // directly to the accessory's raw geometry before binding (same
  // mechanism the earlier automatic hip->head scale check used, just
  // user-driven instead of auto-computed). Defaults to {1,1,1} — no
  // change — for any slot the user hasn't touched.
  const [accessoryScales, setAccessoryScales] = useState({});
  // Per-accessory manual position offset — same keying ("Region.Slot"),
  // value {x,y,z} in METERS of model space (Y up/down, Z front/back,
  // X sideways), applied by MiniGlbViewer to the raw geometry AFTER
  // scale on every drag. This is the placement tool scale can never be:
  // scaling grows from the bbox center, an offset moves the whole
  // garment (e.g. dropping a crotch hem that rides too high). Defaults
  // to {0,0,0} — no shift — for any slot the user hasn't touched.
  const [accessoryOffsets, setAccessoryOffsets] = useState({});
  // Per-PART adjustments within a garment — keyed "Region.Slot", value
  // { [partMaterialName]: { scale:{x,y,z}, offset:{x,y,z} } }. Parts are
  // glTF primitives (one per material — e.g. the bra's Bra_Main cups
  // and Bra_Underbust band), reported back by MiniGlbViewer after load
  // via onAccessoryPartsLoaded. Part transforms COMBINE with the
  // garment-level ones (scales multiply, offsets add) — fit the whole
  // garment first, then refine individual parts.
  // Per-garment rotation — keyed "Region.Slot", {x,y,z} in DEGREES,
  // applied around each part's own center after scale, before offset.
  const [accessoryRotations, setAccessoryRotations] = useState({});
  const [accessoryParts, setAccessoryParts] = useState({});
  // Session 107 — per-slot garment tint (hex). Multiplies against the
  // white-authored diffuse in the viewer; per-part override lives
  // inside accessoryParts[slot][part].tint, same home as per-part fit.
  const [accessoryTints, setAccessoryTints] = useState({});
  // Part-name lists per accessory URL, as reported by the viewer —
  // { [glbUrl]: ["Bra_Heart", "Bra_Main", ...] }. Drives the part
  // selector pills in the detail view; empty until the load completes.
  const [accessoryPartNames, setAccessoryPartNames] = useState({});
  // Which part the detail-view sliders currently edit — null = the
  // whole garment (the existing behavior), otherwise a part material
  // name from the list above. Reset when the detail view changes slot.
  const [activePart, setActivePart] = useState(null);
  // Tracks which slot's scale-adjustment detail view is currently open
  // (the "thumbnail + sliders" screen), null when none. Set when the
  // user clicks a real (non-"None") dynamic option, so picking an
  // accessory flows straight into adjusting it.
  const [scaleDetailSlot, setScaleDetailSlot] = useState(null);
  // resetSlotFit moved to ./AccessoryEditor.jsx — its only two call sites
  // were both inside the picker block extracted there.

  // Real accessory options fetched from the backend's live scan of
  // public/media/accessories/ — keyed by "Region.Slot" (e.g.
  // "Head.Hairstyle"), each value an array of {displayName, glbUrl,
  // thumbnailUrl}. Only slots listed in ACCESSORY_CATEGORY_TO_SLOT ever
  // get an entry here; every other slot keeps using its static
  // ACCESSORY_SCHEMA placeholder options, untouched.
  const [dynamicAccessoryOptions, setDynamicAccessoryOptions] = useState({});
  useEffect(() => {
    let cancelled = false;
    // Session 106 — interior template catalog for the default-home
    // picker (Economy step). Same lifecycle shape as the accessories
    // fetch below. A missing endpoint or empty catalog degrades to an
    // informative empty state, never an error.
    fetch("/api/interior-templates")
      .then(r => (r.ok ? r.json() : { templates: [] }))
      .then(data => { if (!cancelled) setHomeTemplates(data.templates || data.interior_templates || []); })
      .catch(() => { if (!cancelled) setHomeTemplates([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAccessoryOptions()
      .then((grouped) => { if (!cancelled) setDynamicAccessoryOptions(grouped); })
      .catch((err) => {
        // Real network/parse failure — leave dynamicAccessoryOptions
        // empty rather than crash; affected slots simply keep showing
        // "None" only until this succeeds (e.g. on next reload).
        console.error("[CharacterWizard] Failed to fetch /api/accessories:", err);
      });
    return () => { cancelled = true; };
  }, []);
  const [saving, setSaving]   = useState(false);
  const [generating, setGenerating] = useState(null);
  const [assessRunning, setAssessRunning] = useState(null);
  const [error, setError]     = useState(null);
  useEffect(() => { if (step === 6) setError(null); }, [step]);
  const PHOTO_SLOTS = [
    { slug:"profile", label:"Profile" },
  ];
  // Separate from PHOTO_SLOTS deliberately — these stay hidden by
  // default behind the advanced toggle below, so the default flow
  // (one reference photo) is unchanged for anyone who doesn't need
  // AI body-shape matching.
  const BODY_PHOTO_SLOTS = [
    { slug:"body_front", label:"Front" },
    { slug:"body_side",  label:"Side"  },
    { slug:"body_back",  label:"Back"  },
  ];
  const [showBodyPhotos, setShowBodyPhotos] = useState(false);
  const [bodyHeightCm, setBodyHeightCm] = useState(170);
  const [photos, setPhotos] = useState({}); // { slug: File }
  // Session 103 — the XTTS voice sample: { url } (server) or { file, url:objectURL } (just picked).
  const [voiceSample, setVoiceSample] = useState(null);
  // Session 103 — the profile photo shown in the viewer's loading
  // overlay (draft loads land there). Memoized object URL (a fresh one
  // per render would leak). MUST live below the photos declaration —
  // its first home above it was a TDZ crash on every render
  // ("Cannot access 'photos' before initialization", blank wizard).
  const profilePhotoUrlRef = useRef({ file: null, url: null });
  const loadingPhotoUrl = (() => {
    const f = photos.profile;
    if (!f) return null;
    if (profilePhotoUrlRef.current.file !== f) {
      if (profilePhotoUrlRef.current.url) URL.revokeObjectURL(profilePhotoUrlRef.current.url);
      profilePhotoUrlRef.current = { file: f, url: URL.createObjectURL(f) };
    }
    return profilePhotoUrlRef.current.url;
  })();

  const activeSlotRef = useRef(null);
  const [assessments, setAssessments] = useState({ iwm:"", attachment:"", intimacy:"", cogstyle:"" });
  const [assessmentResults, setAssessmentResults] = useState({});
  const [viewingAssessment, setViewingAssessment] = useState(null);
  const ASSESS_CHAIN = ["iwm","attachment","intimacy","cogstyle","big5","disc","hds"];
  const assessDone = key => {
    if (key==="iwm") return !!assessments.iwm;
    if (key==="attachment") return !!assessments.iwm;
    if (key==="intimacy") return !!personality.attachment_style && !!assessments.attachment;
    if (key==="cogstyle") return !!assessments.intimacy;
    if (key==="big5") return !!assessments.cogstyle;
    if (key==="disc") return personality.big5.openness !== 50 || personality.big5.neuroticism !== 50;
    if (key==="hds") return personality.disc.d !== 50 || personality.disc.i !== 50;
    return true;
  };
  const fileRef = useRef(null);

  const [identity, setIdentity] = useState({ first_name:"", last_name:"", age:"", gender:"", nationality:"", occupation:"", orientation:"", appearance:"" });
  // Session 160 — this state was declared and never written: there was no
  // setAppearanceFields call anywhere in the file, so charCtx()'s "Physical:"
  // line below was always empty and every character left this wizard with
  // actors.appearance NULL. analyseAppearance() now fills it from the
  // reference photos. The field set moved to ../lib/appearance.js because the
  // profile editor's Appearance panel authors the same map — and two of the
  // names here were wrong on top of being dead: `breasts`/`ass` are not in the
  // JSON contract POST /api/generate/appearance asks Haiku for (it returns
  // `bust`/`figure`), so those two would have stayed empty even once wired.
  const [appearanceFields, setAppearanceFields] = useState(emptyAppearanceFields());
  const appearanceAuto      = appearanceFields._auto !== false;
  const appearanceHasFields = Object.entries(appearanceFields).some(([k,v]) => k !== "_auto" && v);
  const [psychology, setPsychology] = useState({ backstory:"", wound:"", what_they_want:"", blindspot:"", defenses:"", contradiction:"", coping_mechanisms:"", view_on_sex:"", marital_status:"single", self_view:"", others_view:"", family_model:"", relationship_read_pattern:"", identity_certainty:0.5 });
  const [personality, setPersonality] = useState({
    attachment_style:"secure",
    big5:{ openness:50, conscientiousness:50, extraversion:50, agreeableness:50, neuroticism:50 },
    disc:{ d:50, i:50, s:50, c:50 },
    hds:{ bold:30, cautious:30, colorful:30, diligent:30, dutiful:30, excitable:30, imaginative:30, leisurely:30, mischievous:30, reserved:30, skeptical:30 },
  });
  const [lifestyle, setLifestyle] = useState({ alcohol_relationship:"rare", drug_use:"none", substance_context:"", sleep_pattern:"normal", sleep_quality:"good", exercise_habit:"regular", exercise_type:"", social_frequency:"weekly", diet:"", interests:"", lifestyle_note:"" });
  const [economy, setEconomy]   = useState({ financial_situation:"stable", income_stability:"stable", spending_style:"balanced", savings_habit:"moderate", attitude_to_wealth:"practical", financial_anxiety:0.3, behavior_note:"" });
  // Session 106 — default home. Deliberately NOT inside the economy
  // object: economy is a psychological profile stored as JSON, while
  // the home is a top-level actor column (default_home_template_url)
  // that ActorModelPanel and the deploy wizard read directly. The
  // wizard picks the interior TEMPLATE (a preference); binding to an
  // actual place in a world stays with deployment.
  const [homeTemplate, setHomeTemplate] = useState(null); // glb_url of the chosen template, or null = no preference
  const [homeTemplates, setHomeTemplates] = useState([]); // catalog from /api/interior-templates; empty on 404 (endpoint not yet deployed) and the picker says so instead of breaking the step

  // ── 3D character creation (Session 93+) ──────────────────────────────────
  // actorId is created LAZILY — only when Generate Face is first clicked, not
  // when the wizard opens. Before that point everything here is local state,
  // same as every other field, so aborting the wizard loses nothing extra.
  // If the wizard is closed after actorId exists but before final Save, the
  // close handler below deletes the draft actor, same rollback pattern
  // handleSave already uses.
  const [actorId, setActorId] = useState(null);
  // Session 96: these three (Height, Arms Length, Legs Length) are the
  // only body-shape morphs actually confirmed real end-to-end tonight —
  // real DAZ dial (body_bs_Proportion*), favorited, exported, and
  // verified as genuine adjustable shape keys via check_shape_keys.py
  // on a real .blend. Breast Size (the old second slider) was never
  // confirmed real at any point and is dropped rather than carried
  // forward on a guess.
  //
  // CORRECTED (Session 101+): default changed 50 -> 0. MiniGlbViewer's
  // sliderToInfluence() is a flat value/100 — meaning the OLD default
  // of 50 meant every single character, always, got an unverified
  // extra 0.5 morphTargetInfluence stacked on top of whatever the
  // server already baked into the mesh's rest state (real photo-
  // measured proportions, now that generate3d.js's applyBodyShape()
  // genuinely sets these same body_bs_Proportion* morphs before
  // export). 0 is the only value that means "apply nothing extra" —
  // it correctly shows the real server-baked rest state as-is for
  // Advanced-generated characters, and for manually-styled characters
  // with no server-side value at all, it shows DAZ's actual, well-
  // defined stock rest state — a real, predictable starting point,
  // unlike 50, which was never confirmed to mean anything sensible.
  const [bodyTorsoLength, setBodyTorsoLength] = useState(0);
  const [bodyArmsLength, setBodyArmsLength] = useState(0);
  const [bodyLegsLength, setBodyLegsLength] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  // Height is a "master" control for the three already-proven real
  // morphs (Torso/Arms/Legs length) — the real body_bs_ProportionHeight
  // shape key is confirmed broken (matches a documented DAZ bug: this
  // morph behaves like Body Mass instead of Height, confirmed directly
  // by dragging it and watching the character get thicker, not taller).
  // Rather than depend on that broken data, dragging Height updates the
  // actual Torso/Arms/Legs state directly here — so the visible slider
  // handles themselves move too, not just the mesh silently deforming
  // underneath them while the UI shows stale values. Only depends on
  // bodyHeight, not the other three, so adjusting Torso/Arms/Legs
  // individually afterward still works normally without fighting this.
  useEffect(() => {
    setBodyTorsoLength(bodyHeight);
    setBodyArmsLength(bodyHeight);
    setBodyLegsLength(bodyHeight);
  }, [bodyHeight]);
  // Real feature (Session 101+) — the newly-baked 93 real morphs (see
  // generate3d.js's bakeAllMorphsAtDefault()) are applied generically
  // rather than one named useState per morph, which wouldn't scale as
  // more sliders get added over time. Single object, one key per
  // propKey (matching MiniGlbViewer's own MORPH_NAMES keys exactly —
  // see that file), all starting at 0 for the same "matches the real
  // server-baked rest state" reasoning as bodyTorsoLength etc. above.
  const [extraMorphValues, setExtraMorphValues] = useState({
    waistWidth: 0, waistDepth: 0, waistWidthUpper: 0, hipSize: 0,
    massLowerTorso: 0, massUpperTorso: 0, loveHandles: 0,
    stomachDepth: 0, stomachDepthLower: 0, stomachSoften: 0,
    bodyHeavy: 0, bodyThin: 0, bodyEmaciated: 0, bodyLithe: 0,
    bodyFitnessMass: 0, bodyTone: 0,
    breastsSmall: 0, breastsLarge: 0, breastsNatural: 0, breastsHeavy: 0,
    breastsPerkSide: 0, breastsSidesDepth: 0, breastsLargeHigh: 0,
    breastsShape01: 0, breastsShape02: 0, breastsShape03: 0,
    breastsShape04: 0, breastsShape05: 0, breastsShape06: 0,
    breastsGone: 0, breastsCleavage: 0, breastsFullnessUpper: 0,
    breastsFullnessLower: 0, breastsDownwardSlope: 0, breastsDiameter: 0,
    // Real, confirmed NOT to produce a shape key in the export yet
    // (same unexplained gap as BreastsSmall/BreastsLarge above) — added
    // anyway on request, so the UI structure is ready once the
    // underlying Diffeomorphic-import issue is actually root-caused.
    bodyMuscularMass: 0, massBody: 0, massUpperArms: 0, headSize: 0, chestSize: 0, footSize: 0, handSize: 0,
    // Real, 71 morphs (Session 101+) — the rest of the confirmed baked
    // set that had no slider yet.
    proportionChestDepth: 0, proportionChestWidth: 0, proportionFingersLength: 0, proportionFootLength: 0,
    proportionToesLength: 0, proportionNeckLength: 0, proportionShoulderWidth: 0, proportionLarger: 0,
    proportionSmaller: 0, proportionSmallerBO: 0, massNeck: 0, taperNeckA: 0,
    taperNeckB: 0, bodyFitnessDetails: 0, bodyMuscularDetails: 0, bodyOlder: 0,
    abdominalsCenterDefine: 0, abdominalsOuterDefine: 0, abdominalsWidth: 0, navelDepth: 0,
    navelHollow: 0, navelHorizontal: 0, navelOut: 0, navelSize: 0,
    navelVertical: 0, ribcageArched: 0, ribcagePointed: 0, ribcageSize: 0,
    scapulaDepth: 0, scapulaSize: 0, sternumDepth: 0, sternumHeight: 0,
    sternumWidth: 0, collarboneDetail: 0, latsSize: 0, trapsSize: 0,
    gluteCrease: 0, gluteDepthLower: 0, gluteDepthUpper: 0, gluteSize: 0,
    gluteWidth: 0, hipBackDimples: 0, hipBoneCrest: 0, hipBoneSize: 0,
    hipGenitalBulge: 0, hipPelvicTilt: 0, hipVDefine: 0, thighDepth: 0,
    thighTone: 0, calvesSize: 0, kneeBonesSize: 0, taperThighA: 0,
    taperThighB: 0, taperShinA: 0, taperShinB: 0, massAnkles: 0,
    massFeet: 0, massKnees: 0, massShins: 0, massThighs: 0,
    footArchDepth: 0, massForearms: 0, massHands: 0, massShoulders: 0,
    massWrist: 0, taperUpperArmA: 0, taperUpperArmB: 0, taperForearmA: 0,
    taperForearmB: 0, upperArmTaperWidth: 0, fingersWidth: 0,
  });
  const setExtraMorph = (key, value) => setExtraMorphValues(prev => ({ ...prev, [key]: value }));

  // Session 102 — "Apply measured proportions": hands the photo-derived
  // silhouette targets to MiniGlbViewer's client-side secant solve and
  // writes the solved slider values back through normal state, so every
  // affected handle visibly moves (same principle as height-drives).
  // Uses input_height_cm + the silhouette section ONLY — the landmark
  // section is deliberately ignored (this generation's own JSON carries
  // a 9.2% height-consistency warning on it, and landmark vs silhouette
  // definitions don't cancel against the mesh measurement anyway).
  const applyMeasuredProportions = () => {
    const meas = referenceMeasurements;
    if (!meas || !solveRef.current) return;
    const sil = meas.silhouette || {};
    const res = solveRef.current({
      heightCm: meas.input_height_cm || null,
      shoulderWidthCm: sil.shoulder_width_cm ?? null,
      waistWidthCm: sil.waist_width_cm ?? null,
      waistCircCm: sil.waist_circumference_est_cm ?? null,
      hipWidthCm: sil.hip_width_cm ?? null,
      chestDepthCm: sil.chest_depth_cm ?? null,
      waistDepthCm: sil.waist_depth_cm ?? null,
      bellyDepthCm: sil.belly_depth_max_cm ?? null,
    });
    if (!res) { console.error("[CharacterWizard] applyMeasuredProportions: solve returned null (model not loaded?)"); return; }
    // Session 102 — the solve zeroed every mesh influence before
    // solving (see solveFromReference); mirror that in state: all
    // sliders reset, then the solved values on top. Pose and the
    // named four included — the button now means "this body is the
    // photo, nothing else".
    setBodyHeight(0); setBodyArmsLength(0);
    setBodyTorsoLength(res.bodyTorsoLength ?? 0);
    setBodyLegsLength(res.bodyLegsLength ?? 0);
    setExtraMorphValues(prev => ({ ...Object.fromEntries(Object.keys(prev).map(k => [k, 0])), ...(res.extra || {}) }));
    setPoseValues(prev => Object.fromEntries(Object.keys(prev).map(k => [k, 0])));
    console.log("[CharacterWizard] applyMeasuredProportions report:", res.report);
  };
  // Real feature (Session 101+) — which Adjustments sections are
  // expanded. Body/Waist default open since those are the sections
  // most generations actually need adjusting; the rest start folded
  // rather than dumping every section's full slider list on screen at
  // once now that there are dozens of real sliders total.
  const [expandedSections, setExpandedSections] = useState({
    // Session 102 — ALL sections start folded (body/waist were open).
    body: false, head: false, breasts: false, waist: false,
    bodyType: false, legs: false, arms: false,
    torsoDetail: false, hipsGlutes: false,
    poseHead: false, poseTorso: false, poseArms: false, poseLegs: false,
    appearance: false,
  });
  const toggleSection = (key) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  // Real feature (Session 101+) — replaces the old flat "Proportions"
  // section entirely. Every slider now lives under whichever of these
  // four regions it anatomically belongs to (researched against real,
  // established character-creator conventions — EVE Online, GTA-style
  // creators, and others all converge on this same small set of 3-4
  // camera-zoom regions rather than one zoom per fine-grained slider
  // group). Selecting a region also drives the camera framing in
  // MiniGlbViewer (see cameraFocusRegion prop below). "fullBody" is
  // the default/opening view — matches how every reference creator
  // researched opens on a wide shot, not a zoomed one.
  const [activeBodyRegion, setActiveBodyRegion] = useState("fullBody");
  // Session 97: idle as the default loop, matches the merge pipeline's
  // own convention (idle first, walk second). availableAnimations comes
  // back from MiniGlbViewer once a GLB actually loads — starts empty so
  // the switch controls only render once there's genuinely something to
  // switch between (older GLBs generated before the merge fix have no
  // animations at all).
  const [activeAnimation, setActiveAnimation] = useState("idle");
  const [availableAnimations, setAvailableAnimations] = useState([]);
  // idle | creating_actor | generating_face | exporting | ready | error
  const [character3DStatus, setCharacter3DStatus] = useState("idle");
  // poseStage: mirrors generate3d.js's own separate poseStage field
  // (generating_idle/_idle_ready/generating_walk/_walk_ready) — polled
  // but never actually read anywhere until now, despite the server
  // always sending it.
  const [poseStage, setPoseStage] = useState(null);
  // glbClientLoading: true from the moment character3DStatus first
  // becomes "ready" until MiniGlbViewer itself reports (via
  // onLoadingChange) that it's actually finished loading the GLB
  // client-side. Without this, the rich photo+status overlay below
  // vanishes the instant the SERVER says "ready", even though the
  // browser hasn't even started fetching the (now much larger,
  // animation-including) GLB yet — leaving a jarring gap where
  // MiniGlbViewer's own bare internal spinner takes over with no photo
  // and no status text, which read as "the image just dropped."
  const [glbClientLoading, setGlbClientLoading] = useState(true);
  const [character3DError, setCharacter3DError] = useState(null);
  const [glbUrl, setGlbUrl] = useState(null);
  // Real feature (Session 101+): front/side reference photos, shown
  // behind the character in MiniGlbViewer's front/right view for
  // visual comparison while manually fitting sliders. Real production
  // path (generate3d.js's pullReferenceImagesToServer()) isn't wired
  // to populate these yet — see that function's own notes on the open
  // DB-persistence question. For now these are populated by the single
  // draft loading (dev folder loader removed Session 102 — drafts
  // cover its workflows via the real load path).
  const [frontReferenceImageUrl, setFrontReferenceImageUrl] = useState(null);
  const [sideReferenceImageUrl, setSideReferenceImageUrl] = useState(null);
  // Real calibration (Session 101+) — interpret_body.py's own
  // measurements.json now exposes front/side_px_per_cm_silhouette and
  // front/side_bottom_px, letting MiniGlbViewer scale and ground the
  // reference-image plane to the photo's REAL measured height, rather
  // than guessing a fixed frame size (confirmed wrong — the debug PNGs
  // have real black padding around the silhouette, both above and
  // below the feet). Same dev folder loader as the two PNGs above.
  const [referenceCalibration, setReferenceCalibration] = useState(null);
  // Session 102 — the FULL parsed measurements.json (input_height_cm +
  // silhouette section), not just .calibration, for the "Apply measured
  // proportions" solve. Populated by both the real-generation status
  // poll and the dev folder-picker, same dual-path as calibration.
  const [referenceMeasurements, setReferenceMeasurements] = useState(null);
  // Session 102 — pose sliders (dial-delta calibration, see
  // MiniGlbViewer's POSE_CALIBRATIONS). Runtime-only bone layering:
  // never baked into geometry or the exported GLB.
  const [poseValues, setPoseValues] = useState({ armsUpDwn: 0, legsSpread: 0 });
  const setPoseValue = (key, value) => setPoseValues(prev => ({ ...prev, [key]: value }));
  // Session 102 — Pose is its own tab beside Adjustments. Categories
  // mirror DAZ's own Pose Controls folders (Arms/Feet/Hands/Head/Hip/
  // Legs/Neck/Torso) collapsed to four groups, so every future dial's
  // home is self-evident from where it lives in DAZ. Adding a dial =
  // one POSE_SLIDERS entry (plus a poseValues key + POSE_CALIBRATIONS
  // entry in MiniGlbViewer).
  const [adjustTab, setAdjustTab] = useState("adjustments");
  const POSE_CATEGORIES = [["poseHead","Head & Neck"],["poseTorso","Torso"],["poseArms","Arms & Hands"],["poseLegs","Legs & Feet"]];
  const POSE_SLIDERS = [
    { key: "armsUpDwn", label: "Arms Up-Down", category: "poseArms" },
    { key: "legsSpread", label: "Legs Spread", category: "poseLegs" },
  ];
  // Session 102 — one reset for every slider in both tabs: the four
  // named body sliders, all 113 morph sliders, all pose sliders.
  // bodyHeightCm (the person's real height for photo scaling) is
  // identity data, not an adjustment — deliberately untouched.
  const resetAllSliders = () => {
    if (!window.confirm("Reset ALL body and pose sliders to zero?")) return;
    setBodyHeight(0); setBodyTorsoLength(0); setBodyArmsLength(0); setBodyLegsLength(0);
    setExtraMorphValues(prev => Object.fromEntries(Object.keys(prev).map(k => [k, 0])));
    setPoseValues(prev => Object.fromEntries(Object.keys(prev).map(k => [k, 0])));
  };
  // Real feature (Session 101+) — holds the export function
  // MiniGlbViewer hands up via onExportReady (see that component's own
  // comment on why). Called on step-navigation away from Appearance,
  // so the next step's MiniGlbViewer instance receives an already-
  // morphed .glb directly, rather than relying on it re-applying
  // extraMorphValues correctly on its own fresh mount.
  const exportGlbRef = useRef(null);
  const glbSaveInFlightRef = useRef(false); // guards advanceStep's backgrounded export against re-entry — repeated/rapid Next clicks were each kicking off their own un-awaited 99MB export+POST on top of whatever was already running, which is what actually produced the crash below, not just the 413 itself
  // Session 102 — holds MiniGlbViewer's solveFromReference (via
  // onSolveReady), same ref-based handoff pattern as exportGlbRef.
  const solveRef = useRef(null);
  // Dev-only: pick an existing local GLB file to test the slider
  // wiring against it directly, skipping the full Face Transfer
  // pipeline (~2 min per run). A typed path can't work here — browsers
  // can't fetch() an arbitrary filesystem path, only a real file picker
  // can read local disk directly (via the File API). Not meant to ship
  // in this form long-term.

  // Session 97: real, confirmed bug — the status-polling interval below
  // only ever clears itself on "ready", "error", or a fetch exception.
  // If a real generation is started and then abandoned mid-pipeline
  // (e.g. switching to the dev file loader to test something else
  // instead of waiting it out), that poll keeps running indefinitely in
  // the background, silently overwriting character3DStatus with
  // whatever stage the orphaned generation happens to be at every few
  // seconds — which flips the ready-gated render ternary below, causing
  // MiniGlbViewer to fully unmount and remount. That looks exactly like
  // "freezes, then restarts the animation loop," and isn't an animation
  // bug at all. Tracked here so it can be explicitly cancelled by
  // anything that supersedes an in-flight generation.
  const pollIntervalRef = useRef(null);
  // General safety net alongside the dev-loader-specific fix above —
  // if the whole wizard unmounts while a poll is still in flight (e.g.
  // navigating away mid-generation), stop it rather than let it keep
  // running against a component that's no longer there.
  useEffect(() => {
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, []);

  // Session 102 — DESIGN CHANGE, replaces the sendBeacon silent wipe
  // that lived here: closing the tab now KEEPS the draft (browsers
  // can't show a real save/discard choice during unload, and silently
  // destroying work is the wrong default). Discarding is an explicit
  // choice in the close prompt below; stray drafts are visible and
  // wipeable in the drafts panel on the entry step.
  const [closePrompt, setClosePrompt] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  // Session 102 — who owns this session's character decides what
  // "discard" means: generated fresh this session -> discarding
  // DELETES it (nothing saved exists anywhere); loaded from an
  // existing draft -> discarding abandons only this session's CHANGES
  // (the server-side draft_state is untouched, since it only ever
  // writes on explicit save — leaving without saving IS the discard).
  const [loadedFromDraft, setLoadedFromDraft] = useState(false);

  async function persistDraftState() {
    if (!actorId) return false;
    const state = {
      identity, bodyHeightCm,
      bodyHeight, bodyTorsoLength, bodyArmsLength, bodyLegsLength,
      extraMorphValues, poseValues,
      referenceMeasurements, referenceCalibration, // reference-image URLs deliberately NOT saved: load reads rows-from-disk only (Session 102 law); stored URLs caused two dangling-pointer bugs
      accessories, selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets, accessoryRotations, accessoryParts, accessoryTints,
      showBodyPhotos,
      // Session 160 — the structured appearance joins the draft lifecycle for
      // the same reason psychology did: it costs an LLM run and a photo to
      // produce, and losing it on a reload would mean paying for it twice.
      // identity.appearance (the composed prose) already rides along inside
      // identity above.
      appearanceFields,
      // Session 103 — steps 3-6 enter the draft lifecycle: psychology
      // through economy autosave like everything else, so generated
      // profiles survive reloads and bug-hunt cycles instead of
      // costing a fresh LLM run each time. step is saved so a reload
      // resumes where the author stood.
      psychology, personality, lifestyle, economy, step,
      // Session 106 — the default-home choice joins the draft
      // lifecycle for the same reason everything else did.
      homeTemplate,
      // Session 103 — raw assessment answers join the lifecycle: the
      // SCORES survived reloads (inside personality) but the answers
      // lived only in session memory, so View Answers vanished and
      // the dependency chain re-locked after every reload — a Haiku
      // run's evidence burned while its verdict persisted.
      assessmentResults,
      // The completion tracker itself was the missing half of that same
      // fix — assessmentResults (answers) and personality (scores) both
      // survived a reload, but assessments (the done/not-done flags the
      // checkmarks and prerequisite locks actually read) didn't, so IWM /
      // Intimacy / Cognitive Style re-locked every time even though their
      // own results were sitting right there.
      assessments,
    };
    const res = await fetch(`/api/actors/${actorId}/draft-state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.saved) { console.error("[CharacterWizard] draft-state save failed:", data); return false; }
    return true;
  }

  async function saveDraftAndClose() {
    setSavingDraft(true);
    await syncRenameNow(identity.first_name, identity.last_name);
    const ok = await persistDraftState();
    setSavingDraft(false);
    if (!ok) {
      // A failed save must be LOUD and must NOT close — silently
      // navigating away after a failed write is indistinguishable from
      // success until the next load lies to you (found live).
      alert("Saving the draft FAILED — your changes are still here, not saved. Check the console / server logs before closing.");
      return;
    }
    setClosePrompt(false);
    navigate(exitTo);
  }
  async function discardAndClose() {
    if (autoPersistTimerRef.current) clearTimeout(autoPersistTimerRef.current); // a queued autosave must not outlive the discard
    if (!loadedFromDraft) {
      // Session-generated: nothing saved exists — discard deletes it.
      await fetch(`/api/actors/${actorId}/abandon-draft`, { method: "POST" }).catch(() => {});
    } else {
      // Loaded draft + auto-persist: this session's changes are
      // ALREADY on the server, so leaving isn't enough — restore the
      // pristine snapshot captured at load. The RENAME is likewise
      // already applied (row + folder moved immediately), so discard
      // renames BACK to the pristine identity first.
      const pi = loadedPristineStateRef.current?.identity;
      if (pi?.first_name && pi?.last_name) await syncRenameNow(pi.first_name, pi.last_name);
      await fetch(`/api/actors/${actorId}/draft-state`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: loadedPristineStateRef.current || {} }),
      }).catch(() => {});
    }
    setClosePrompt(false);
    navigate(exitTo);
  }

  // Session 102 — AUTO-PERSIST: every adjustment change writes
  // draft_state, debounced. Closes the one back-fill gap: sliders had
  // no disk/DB source when a session closed unsaved, so tuning died
  // with the tab. Now the snapshot is continuously current and the
  // close prompt's Save is a formality rather than the only write.
  // persistDraftState fails quietly here (console only) — alert-
  // spamming a background save would be worse than the miss; the
  // explicit Save on close still alerts loudly.
  const autoPersistTimerRef = useRef(null);
  // Session 103 — draft RENAME sync: the media folder is named
  // {first}-{last}-{id8}, so a name edit must propagate to the server
  // (folder move + row + media urls). Debounced; baseline captured at
  // load/generation so the first render never fires a rename. No
  // in-session state updates needed (server resolves media_folder
  // fresh per request; the immutable cache carries the loaded GLB).
  const lastSyncedNameRef = useRef(null);
  const renameTimerRef = useRef(null);
  // Awaitable flush — used by BOTH exit paths so rename state is
  // deterministic at close: Save flushes the CURRENT names (a rename
  // still sitting in the debounce window must not be left undone);
  // Discard flushes the PRISTINE names (the immediate server-side
  // rename is not part of draft_state, so discarding must rename
  // BACK or row/folder diverge from the restored identity).
  const syncRenameNow = async (first, last) => {
    if (!actorId || !first || !last) return;
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    try {
      const d = await fetch(`/api/actors/${actorId}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: first, last_name: last }),
      }).then(r => r.json());
      if (d.renamed) lastSyncedNameRef.current = `${first}|${last}`;
      else console.error("[CharacterWizard] rename flush FAILED:", d.error);
    } catch (err) { console.error("[CharacterWizard] rename flush request failed:", err); }
  };
  useEffect(() => {
    if (!actorId || !identity.first_name || !identity.last_name) return;
    const current = `${identity.first_name}|${identity.last_name}`;
    if (lastSyncedNameRef.current === null) { lastSyncedNameRef.current = current; return; }
    if (lastSyncedNameRef.current === current) return;
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    renameTimerRef.current = setTimeout(() => {
      fetch(`/api/actors/${actorId}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: identity.first_name, last_name: identity.last_name }),
      }).then(r => r.json()).then(d => {
        if (d.renamed) {
          lastSyncedNameRef.current = current;
          console.log(`[CharacterWizard] draft renamed server-side${d.moved ? ` — media folder moved to ${d.media_folder}` : ""}`);
          setDraftsList(prev => prev.map(x => x.id === actorId ? { ...x, name: `${identity.first_name} ${identity.last_name}`.trim() } : x));
        } else {
          console.error("[CharacterWizard] draft rename FAILED:", d.error);
        }
      }).catch(err => console.error("[CharacterWizard] draft rename request failed:", err));
    }, 1200);
    return () => { if (renameTimerRef.current) clearTimeout(renameTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, identity.first_name, identity.last_name]);
  // Session 103 — PERSISTENT VIEWER: one MiniGlbViewer instance for the
  // whole wizard, rendered through a portal whose host element is
  // whichever step's layout slot is currently mounted. React re-parents
  // the DOM without unmounting the component, so scene, body, and
  // garments survive Next/Back — a step change is a camera/props
  // change, not a world rebuild.
  const [viewerHost, setViewerHost] = useState(null);
  // Session 141 — STABLE host ref (React error #185 fix, found live via
  // sourcemapped stack pointing at the old inline `ref={el => ...}`).
  // Inline callback refs get a new identity every render, so React
  // detaches+re-attaches them on EVERY commit; combined with setState
  // inside the ref, a step transition (host element changes) scheduled
  // a nested update per commit until React killed it at 50 — crashing
  // the wizard mid-transition and racing a second, divergent dressed
  // export against the canonical GLB save. useCallback identity means
  // the ref fires only on REAL mount/unmount; the functional update
  // bails on same-element sets; null (real unmount) now parks the
  // viewer directly instead of waiting for the detached-DOM check.
  const viewerHostRef = useCallback((el) => {
    setViewerHost(prev => (prev === el ? prev : el));
  }, []);

  // Session 103 CORRECTION — createPortal with a CHANGING container
  // does NOT preserve the component (React unmounts from the old host
  // and mounts fresh in the new — full body reload, the spinner the
  // split was supposed to kill). The stable pattern: ONE always-
  // mounted fixed-position container that never changes; the step
  // slots become measurement placeholders and the container is
  // rect-synced over the active one.
  const [viewerRect, setViewerRect] = useState(null);
  useLayoutEffect(() => {
    // Session 103 — PARK when the current step has no viewer slot
    // (steps >= 3) or the host element has left the document: callback
    // refs never null themselves, so viewerHost kept pointing at the
    // DEAD step-2 placeholder — getBoundingClientRect on detached DOM
    // returns zeros, and the container sat at the origin with the
    // Save GLB overlay bleeding into the header (found live on the
    // Psychology step; the blank-screen tab-jump was the same
    // zero-rect limbo).
    if (!viewerHost || step > 2 || !document.body.contains(viewerHost)) { setViewerRect(null); return; }
    const sync = () => {
      const r = viewerHost.getBoundingClientRect();
      setViewerRect(prev => (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) ? prev : { top: r.top, left: r.left, width: r.width, height: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(viewerHost);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, { capture: true, passive: true });
    return () => { ro.disconnect(); window.removeEventListener("resize", sync); window.removeEventListener("scroll", sync, { capture: true }); };
  }, [viewerHost, step]);
  const loadedPristineStateRef = useRef(null); // pristine draft_state as loaded; see discardAndClose
  useEffect(() => {
    if (!actorId) return;
    if (autoPersistTimerRef.current) clearTimeout(autoPersistTimerRef.current);
    autoPersistTimerRef.current = setTimeout(() => { persistDraftState(); }, 1500);
    return () => { if (autoPersistTimerRef.current) clearTimeout(autoPersistTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, JSON.stringify(identity), bodyHeightCm, bodyHeight, bodyTorsoLength, bodyArmsLength, bodyLegsLength, JSON.stringify(extraMorphValues), JSON.stringify(poseValues), JSON.stringify(accessories), JSON.stringify(selectedAccessoryGlbUrls), JSON.stringify(accessoryScales), JSON.stringify(accessoryOffsets), JSON.stringify(accessoryRotations), JSON.stringify(accessoryParts), JSON.stringify(accessoryTints), showBodyPhotos, JSON.stringify(psychology), JSON.stringify(personality), JSON.stringify(lifestyle), JSON.stringify(economy), homeTemplate, JSON.stringify(Object.keys(assessmentResults)), step]);

  // Drafts available to resume — fetched once; shown on the entry step
  // until a character exists in this session. Wiping uses the same
  // abandon-draft endpoint as the discard path: one deletion mechanism.
  const [draftsList, setDraftsList] = useState([]);
  const [draftsRailOpen, setDraftsRailOpen] = useState(false);
  useEffect(() => {
    fetch("/api/actors").then(r => r.json())
      .then(list => setDraftsList((list || []).filter(a => a.status === "draft")))
      .catch(err => console.error("[CharacterWizard] drafts fetch failed:", err));
  }, []);

  async function loadDraft(draftId) {
    if (glbUrl && !window.confirm("Load this draft? The character currently open in the wizard will be replaced (it stays saved if it's a draft).")) return;
    const res = await fetch(`/api/actors/${draftId}`);
    const data = await res.json().catch(() => null);
    if (!data?.actor) { console.error("[CharacterWizard] loadDraft: fetch failed for", draftId); return; }
    const a = data.actor;
    if (!a.glb_url) { console.error("[CharacterWizard] loadDraft: draft has no glb_url — cannot load", a); return; }
    let st = {};
    try { st = a.draft_state ? JSON.parse(a.draft_state) : {}; } catch (e) { console.error("[CharacterWizard] loadDraft: draft_state parse failed:", e); }
    loadedPristineStateRef.current = st; // what "Discard changes" restores — required since auto-persist writes continuously
    lastSyncedNameRef.current = null; // rename baseline re-captures from the loaded identity on next effect run
    setActorId(a.id);
    setLoadedFromDraft(true);
    setGlbUrl(a.glb_url);
    setCharacter3DStatus("ready"); // the viewer mounts on character3DStatus==="ready" && glbUrl — generation's status poll sets it, so a draft load must too (found live: healthy loadDraft, glbUrl in state, viewer never mounted)
    // Identity fills from the ROW first (it exists for every draft,
    // draft_state does not — found live: a resurrected draft loaded
    // with every form field at placeholder), then draft_state.identity
    // over it as the fresher in-progress edit when present.
    // Orientation lives in actor_psychology, not the actors row.
    const rowIdentity = {
      first_name: a.first_name || "", last_name: a.last_name || "",
      age: a.age ?? "", gender: a.gender || "", nationality: a.nationality || "", occupation: a.occupation || "",
      orientation: data.psychology?.orientation || "", appearance: a.appearance || "",
    };
    setIdentity(prev => ({ ...prev, ...rowIdentity, ...(st.identity || {}) }));
    setDraftsRailOpen(false); // panel's job is done — get out of the way of the form
    // ABSOLUTE restore (found live: loading Benny then Elina showed
    // Benny's reference photos — conditional setters skipped absent
    // fields and inherited the previous character's state). A draft
    // load is a full session replacement: absence means CLEARED,
    // never "keep the last character's".
    // Session 160 — ABSOLUTE, like everything else here, and row-first like
    // identity above: actors.appearance_fields exists for any character the
    // profile editor has touched, draft_state does not.
    let rowAppearanceFields = {};
    try { rowAppearanceFields = JSON.parse(a.appearance_fields || "{}") || {}; } catch (e) { console.error("[CharacterWizard] loadDraft: appearance_fields parse failed:", e); }
    setAppearanceFields({ ...emptyAppearanceFields(), ...rowAppearanceFields, ...(st.appearanceFields || {}) });
    setBodyHeightCm(st.bodyHeightCm != null ? st.bodyHeightCm : 170);
    setBodyHeight(st.bodyHeight || 0); setBodyTorsoLength(st.bodyTorsoLength || 0);
    setBodyArmsLength(st.bodyArmsLength || 0); setBodyLegsLength(st.bodyLegsLength || 0);
    setExtraMorphValues(prev => ({ ...Object.fromEntries(Object.keys(prev).map(k => [k, 0])), ...(st.extraMorphValues || {}) }));
    setPoseValues(prev => ({ ...Object.fromEntries(Object.keys(prev).map(k => [k, 0])), ...(st.poseValues || {}) }));
    setFrontReferenceImageUrl(null);
    setSideReferenceImageUrl(null);
    setReferenceMeasurements(st.referenceMeasurements || null);
    setReferenceCalibration(st.referenceCalibration || null);
    // Accessories: ABSOLUTE restore, same law as everything else
    // (found live: loading character B after A carried A's clothing
    // into B's Accessories step — the last hideout of the
    // inherited-state disease). Absent in the snapshot = defaults,
    // never the previous character's.
    setAccessories(st.accessories || defaultAccessories());
    setSelectedAccessoryGlbUrls(st.selectedAccessoryGlbUrls || {});
    setAccessoryScales(st.accessoryScales || {});
    setAccessoryOffsets(st.accessoryOffsets || {});
    setAccessoryRotations(st.accessoryRotations || {});
    setAccessoryParts(st.accessoryParts || {});
    setAccessoryTints(st.accessoryTints || {});
    setActiveSlot(null); setScaleDetailSlot(null); setActivePart(null);
    setVoiceSample(null); // ABSOLUTE, same law as photos — the loader above fills only what THIS character has
    setPhotos({}); // ABSOLUTE, like everything else — the photo slots were the LAST inherited-state hideout (found live: Elina wearing Benny's profile beard and back photo); the loaders below fill only what THIS character actually has
    setShowBodyPhotos(!!st.showBodyPhotos); // advanced-mode remembered per draft; the slot photo-loader below also flips it on when raw photos exist (legacy drafts)
    // Session 103 — steps 3-6 restore (absolute, like everything else:
    // missing keys mean defaults, never inheritance). A saved step
    // resumes the author where they stood; older drafts without one
    // land on step 1 as before.
    setPsychology({ backstory:"", wound:"", what_they_want:"", blindspot:"", defenses:"", contradiction:"", coping_mechanisms:"", view_on_sex:"", marital_status:"single", self_view:"", others_view:"", family_model:"", relationship_read_pattern:"", identity_certainty:0.5, ...(st.psychology || {}) });
    setPersonality(st.personality || {
      attachment_style:"secure",
      big5:{ openness:50, conscientiousness:50, extraversion:50, agreeableness:50, neuroticism:50 },
      disc:{ d:50, i:50, s:50, c:50 },
      hds:{ bold:30, cautious:30, colorful:30, diligent:30, dutiful:30, excitable:30, imaginative:30, leisurely:30, mischievous:30, reserved:30, skeptical:30 },
    });
    setLifestyle(st.lifestyle || { alcohol_relationship:"rare", drug_use:"none", substance_context:"", sleep_pattern:"normal", sleep_quality:"good", exercise_habit:"regular", exercise_type:"", social_frequency:"weekly", diet:"", interests:"", lifestyle_note:"" });
    // Session 150 — monthly_income_sek is stripped on load. Session 103 ruled
    // the amount is WORLD data, set at world-deploy, and excised it from this
    // wizard's prompt and form — but not from drafts already saved. The key
    // kept riding along inside st.economy: restored wholesale here, autosaved
    // back into draft_state, and POSTed to /api/actors on every save, which
    // wrote it straight to actor_economic. Nothing in this wizard renders it,
    // so it was invisible at the only screen that persisted it while showing
    // as a confident figure on the actor pages that read it. Lindsey carried
    // 85000 this way from 8 Aug — the "85,000 SEK incident" in the SAD —
    // because no UI path existed to clear it. Dropping it here breaks the
    // loop: the POST handler writes NULL when the key is absent, so existing
    // rows clean themselves on the next save.
    // Session 150 — strips BOTH spellings. Draft blobs written before the
    // column was renamed still carry `monthly_income_sek` (Lindsey's 85000
    // is one of them), so dropping only the new name would quietly reopen
    // the loop this closes: restored from draft, autosaved back, POSTed on
    // every save.
    const { monthly_income_sek: _legacy, monthly_income: _worldOwnsTheAmount, ...savedEconomy } = st.economy || {};
    setEconomy(st.economy
      ? savedEconomy
      : { financial_situation:"stable", income_stability:"stable", spending_style:"balanced", savings_habit:"moderate", attitude_to_wealth:"practical", financial_anxiety:0.3, behavior_note:"" });
    setHomeTemplate(st.homeTemplate || null);
    setAssessmentResults(st.assessmentResults || {});
    setAssessments(st.assessments || { iwm:"", attachment:"", intimacy:"", cogstyle:"" });
    if (st.step && st.step >= 1 && st.step <= 7) setStep(st.step);
    // Profile photo (simple mode): actor_media is the canonical store
    // and the /:id payload already exposes it as photo_url — fetch it
    // into the profile slot as a File, indistinguishable from a fresh
    // upload (Regenerate re-submits it).
    if (a.photo_url) {
      fetch(a.photo_url).then(r => (r.ok && (r.headers.get("content-type") || "").startsWith("image")) ? r.blob() : null).then(blob => {
        if (!blob) return;
        setPhotos(prev => ({ ...prev, profile: new File([blob], `${a.id}_profile`, { type: blob.type || "image/jpeg" }) }));
      }).catch(() => {});
    }
    // Session 102 — disk fallback: the generation pipeline writes
    // measurements/refs into the media folder at DETERMINISTIC paths,
    // but only the in-memory jobStatus (and draft_state, if saved)
    // ever carried them in state. A loaded draft whose snapshot lacks
    // them should consult the files (found live: Apply Measured
    // Proportions dead on a loaded draft while measurements.json sat
    // on disk). Absolute-restore above already cleared state, so
    // these only ever fill absence — never override a snapshot.
    const base = `/media/actors/${a.media_folder}/3d/${a.id}`;
    {
      // Session 102 (final form) — the measurements FILE is the
      // authority for both the solve targets AND the reference-plane
      // scale (user's rule: plane height reads from measurements.json,
      // never guessed). Fetched unconditionally; file wins over the
      // snapshot for calibration — calibration describes the IMAGE,
      // and the image on disk is what gets displayed.
      fetch(`${base}-measurements.json`).then(r => r.ok ? r.json() : null).then(mj => {
        if (!mj) return;
        if (!st.referenceMeasurements) setReferenceMeasurements(mj);
        if (mj.calibration) setReferenceCalibration(mj.calibration);
        console.log("[CharacterWizard] loadDraft: measurements + calibration read from media folder");
      }).catch(() => {});
    }
    // Backdrop order: RAW jpeg first, rows PNG as fallback. The
    // pipeline-staged raws are the very pixels interpret_body computed
    // px_per_cm on — calibration-true by identity (proven: Elina).
    // Rows PNGs are the fallback for characters whose staged raws are
    // gone (proven: Benny — non-pipeline copies at a different
    // resolution scale WRONG, so only pipeline-staged raws belong on
    // the platform under these names).
    // Reference backdrop: the ROWS SILHOUETTE, for EVERY character,
    // always (user's rule, stated three times before it stuck). The
    // calibration is literally named px_per_cm_SILHOUETTE — computed
    // on the rows image; it is the ONLY backdrop it can scale
    // correctly. Raw photos NEVER go behind the mesh (they belong in
    // the Body Photos slots, handled below). Stored snapshot URLs are
    // ignored entirely here — they caused two dangling/wrong-image
    // bugs tonight; the rows file on disk is the single source.
    for (const [suffix, setter] of [["_front_rows.png", setFrontReferenceImageUrl], ["_side_rows.png", setSideReferenceImageUrl]]) {
      fetch(`${base}${suffix}`, { method: "HEAD" }).then(r => {
        if (r.ok && (r.headers.get("content-type") || "").startsWith("image")) setter(`${base}${suffix}`);
        else console.log(`[CharacterWizard] loadDraft: no rows silhouette at ${base}${suffix} — no backdrop for this character`);
      }).catch(() => {});
    }
    // Body photo slots — CANONICAL source first: actor_media rows via
    // the /:id payload's mediaPhotos (the actual uploads, stored under
    // images/body_*.ext), then the pipeline-pulled convention jpegs in
    // the media folder as fallback for resurrected/legacy drafts whose
    // media rows are gone. Fetched into File objects either way —
    // indistinguishable from fresh uploads (thumbnails, ✕, Regenerate
    // all unchanged).
    const mediaBySlug = Object.fromEntries((data.mediaPhotos || []).map(m => [m.state_slug, m.url]));
    const voiceRow = (data.mediaPhotos || []).find(m => m.state_slug === "voice_sample" || m.media_type === "audio");
    setVoiceSample(voiceRow ? { url: voiceRow.url } : null);
    for (const [suffix, slug] of [["_front.jpeg", "body_front"], ["_side.jpeg", "body_side"], ["_back.jpeg", "body_back"]]) {
      const url = mediaBySlug[slug] || `${base}${suffix}`;
      fetch(url).then(r => {
        if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image")) return null;
        return r.blob();
      }).then(blob => {
        if (!blob) return;
        const file = new File([blob], slug, { type: blob.type || "image/jpeg" });
        setPhotos(prev => ({ ...prev, [slug]: file }));
        setShowBodyPhotos(true);
      }).catch(() => {});
    }
  }

  async function wipeDraft(draftId) {
    if (!window.confirm("Permanently delete this draft (files included)?")) return;
    await fetch(`/api/actors/${draftId}/abandon-draft`, { method: "POST" }).catch(() => {});
    setDraftsList(prev => prev.filter(d => d.id !== draftId));
  }

  function upd(setter) { return (k,v) => setter(p=>({...p,[k]:v})); }
  function parseJSON(text) {
    // Strip markdown fences
    let cleaned = text.replace(/```json|```/gi,"").trim();
    // Find the first [ or { and last ] or } — extract that substring
    const firstArr = cleaned.indexOf("[");
    const firstObj = cleaned.indexOf("{");
    const lastArr  = cleaned.lastIndexOf("]");
    const lastObj  = cleaned.lastIndexOf("}");
    let start = -1, end = -1;
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
      start = firstArr; end = lastArr;
    } else if (firstObj !== -1) {
      start = firstObj; end = lastObj;
    }
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
    return JSON.parse(cleaned);
  }
  const updI=upd(setIdentity), updP=upd(setPsychology), updL=upd(setLifestyle), updE=upd(setEconomy);

  const charCtx = () => {
    const appCtx = Object.entries(appearanceFields).filter(([k,v])=>k!=="_auto"&&v).map(([k,v])=>`${k.replace(/_/g," ")}: ${v}`).join(", ");
    // Session 103 — the BODY informs the psyche: height (with an
    // honest percentile cue the LLM can reason about), build signals
    // from the strongest body-type morphs, and current wardrobe. A
    // 175cm woman has a lived relationship with being the tallest in
    // the room; a heavy or gym-built frame carries its own history.
    // All of it already sat in state — it just never reached the
    // prompt.
    const bodyBits = [];
    if (bodyHeightCm && bodyHeightCm !== 170) {
      const pct = identity.gender === "female"
        ? (bodyHeightCm >= 178 ? "~99th percentile — strikingly tall" : bodyHeightCm >= 173 ? "~95th percentile — notably tall" : bodyHeightCm <= 157 ? "notably short" : "around average")
        : (bodyHeightCm >= 191 ? "~99th percentile — strikingly tall" : bodyHeightCm >= 185 ? "~95th percentile — notably tall" : bodyHeightCm <= 168 ? "notably short" : "around average");
      bodyBits.push(`height ${bodyHeightCm}cm (${pct} for their gender)`);
    }
    const morphSignals = { bodyHeavy: "heavyset", bodyThin: "very slim", bodyFitnessMass: "gym-built/muscular", bodyEmaciated: "gaunt", bodyPearFigure: "pear-shaped", bodyVoluptuous: "voluptuous" };
    for (const [k, label] of Object.entries(morphSignals)) {
      if ((extraMorphValues[k] || 0) >= 40) bodyBits.push(label);
    }
    const worn = Object.entries(accessories).flatMap(([, slots]) => Object.entries(slots).filter(([, v]) => v && v !== "None").map(([, v]) => v));
    if (worn.length) bodyBits.push(`currently wearing: ${worn.join(", ")}`);
    return `Character: ${(identity.first_name+" "+identity.last_name).trim()||"unnamed"}, ${identity.age||"?"}yo, ${identity.gender}, ${identity.occupation||"no occupation"}.${appCtx ? `
Physical: ${appCtx}.` : ""}${bodyBits.length ? `
Body: ${bodyBits.join("; ")}. Let the body inform the psyche where it plausibly would — posture, presence, habits, self-image — without making it the whole character.` : ""}`;
  };

  // ── Psychology: Inspire Me ────────────────────────────────────────────────
  async function inspireField(key, label) {
    setGenerating(key); setError(null);
    try {
      const text = await callAI(`${charCtx()}
Existing psychology: ${JSON.stringify(psychology)}

Write a compelling "${label}" for this character. Return only the text — no labels, no JSON, 2-3 sentences max.`);
      // Strip JSON/markdown if Haiku accidentally wraps plain text
      let val = text.trim().replace(/```json|```/gi,"").trim();
      try { const json = JSON.parse(val); val = json[key] || json.text || json.value || val; } catch {}
      setPsychology(p=>({...p,[key]:val}));
    } catch (err) { console.error("[inspireField] FAILED:", err); setError("Generation failed"); }
    setGenerating(null);
  }

  async function generateFullPsychology() {
    if (!identity.first_name) { setError("Fill in Identity first"); return; }
    setGenerating("all"); setError(null);
    try {
      const text = await callAI(`${charCtx()}
identity_certainty (0-1): how clear and settled their sense of self is — low means still figuring out who they are or easily destabilized by outside pressure, high means a stable, well-integrated identity.
Return ONLY valid JSON (no markdown):
{"backstory":"2-3 sentences","wound":"core wound","what_they_want":"private desire","blindspot":"pattern they repeat","defenses":"emotional defenses","contradiction":"tension they live with","coping_mechanisms":"how they cope","view_on_sex":"their relationship with sex and intimacy","marital_status":"single|casually_dating|in_relationship|married|divorced","self_view":"how they'd describe themselves, strengths and weak points both","others_view":"how they come across to people — first impression vs. what people learn once they know them","family_model":"the relational template inherited from family — what love, conflict and closeness looked like growing up","relationship_read_pattern":"the lens they read relationship signals through — what they mistake for what","identity_certainty":0.6}`);
      const json = parseJSON(text);
      // Session 103 - was ...j (undefined): Haiku answered perfectly and
      // the client threw ReferenceError on the LAST line, eaten by the
      // bare catch as "Generation failed". The inspireField twin of
      // this typo is fixed too. Errors now log themselves.
      setPsychology(p=>({...p,...json}));
    } catch (err) { console.error("[generateFullPsychology] FAILED:", err); setError("Generation failed"); }
    setGenerating(null);
  }

  // ── Scoring functions ───────────────────────────────────────────────────────
  function scoreIWM(answers) {
    const get=i=>answers[i]?.answer;
    const posSelf=[0,4,6],negSelf=[2,8,9],posOther=[1,7],negOther=[3,5];
    let ss=0,sc=0,os=0,oc=0;
    posSelf.forEach(i=>{ss+=(get(i)==="TRUE"?1:0);sc++;});
    negSelf.forEach(i=>{ss+=(get(i)!=="TRUE"?1:0);sc++;});
    posOther.forEach(i=>{os+=(get(i)==="TRUE"?1:0);oc++;});
    negOther.forEach(i=>{os+=(get(i)!=="TRUE"?1:0);oc++;});
    return {selfView:Math.round(ss/sc*100),othersView:Math.round(os/oc*100),score:Math.round((ss+os)/(sc+oc)*100)};
  }
  function scoreAttachment(answers) {
    const get=i=>Number(answers[i]?.answer)||4;
    const avoidVals=[8-get(0),get(3),get(6),get(8),get(9),8-get(11)];
    const anxVals=[get(2),get(4),get(7),get(10)];
    const avgA=avoidVals.reduce((a,b)=>a+b,0)/avoidVals.length;
    const avgAnx=anxVals.reduce((a,b)=>a+b,0)/anxVals.length;
    const avoidScore=Math.round((avgA-1)/6*100),anxScore=Math.round((avgAnx-1)/6*100);
    const style=avoidScore<50&&anxScore<50?"secure":anxScore>=50&&avoidScore<50?"anxious":avoidScore>=50&&anxScore<50?"avoidant":avoidScore>=50&&anxScore>=50?"fearful_avoidant":"avoidant_secure";
    return {avoidScore,anxScore,style,score:Math.round((avoidScore+anxScore)/2)};
  }
  function scoreDISC(answers) {
    const get=i=>Number(answers[i]?.answer)||2;
    const avg=idxs=>idxs.reduce((a,i)=>a+get(i),0)/idxs.length;
    const norm=v=>Math.round((v-1)/3*100);
    return {d:norm(avg([0,1,2,3,4])),i:norm(avg([5,6,7,8,9])),s:norm(avg([10,11,12,13,14])),c:norm(avg([15,16,17,18,19]))};
  }
  function scoreBig5(answers) {
    // BFI-44 scoring — reverse items marked with R
    const E_fwd=[1,6,10,15,20,25],  E_rev=[5,30,35,40];
    const A_fwd=[6,11,16,21,26,31], A_rev=[0,35,7,13,19];
    const C_fwd=[3,12,17,22,27],    C_rev=[7,11,32,37,42];
    const N_fwd=[20,25,30,35],      N_rev=[21,23,24,27];
    const O_fwd=[4,9,14,19,24,29,34,39,43], O_rev=[34,39,40];
    const score = (fwd, rev) => {
      const vals = [...fwd.map(i=>Number(answers[i]?.answer)||3), ...rev.map(i=>6-Number(answers[i]?.answer||3))];
      const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
      return Math.round((avg-1)/4*100);
    };
    return { extraversion:score(E_fwd,E_rev), agreeableness:score(A_fwd,A_rev), conscientiousness:score(C_fwd,C_rev), neuroticism:score(N_fwd,N_rev), openness:score(O_fwd,O_rev) };
  }

  function scoreHDS(answers) {
    const scales={};
    answers.forEach(a=>{if(!scales[a.scale])scales[a.scale]=[];scales[a.scale].push(Number(a.answer)||2);});
    const result={};
    Object.entries(scales).forEach(([scale,vals])=>{const avg=vals.reduce((a,b)=>a+b,0)/vals.length;result[scale]=Math.round((avg-1)/3*100);});
    return result;
  }

  // ── Assessment runner ───────────────────────────────────────────────────────
  async function runAssessment(type) {
    setAssessRunning(type); setError(null);
    try {
      if (type==="all") {
        for (const t of ["iwm","attachment","intimacy","cogstyle","big5","disc","hds"]) await runOneAssessment(t);
      } else {
        await runOneAssessment(type);
      }
    } catch(e) { setError("Assessment failed: "+e.message); }
    setAssessRunning(null);
  }

  async function runOneAssessment(type) {
    setAssessRunning(type);
    const qs = await fetch(`/api/assessment-questions/${type}`).then(r=>r.json());
    if (!qs?.length) { setError(`No questions for ${type} — run migration first`); return; }

    const ctx = `${charCtx()}
Psychology: wound="${psychology.wound||""}", wants="${psychology.what_they_want||""}", blindspot="${psychology.blindspot||""}"
IWM: ${assessments.iwm||"not run"} | Attachment: ${assessments.attachment||"not run"} | Intimacy: ${assessments.intimacy||"not run"} | CogStyle: ${assessments.cogstyle||"not run"}`;

    const rtype=type==="attachment"?"likert7":["iwm","intimacy","cogstyle"].includes(type)?"boolean":"likert4";
    const scaleDesc=rtype==="boolean"?"TRUE or FALSE":rtype==="likert7"?"1=Strongly Disagree to 7=Strongly Agree":"1=Strongly Disagree, 2=Disagree, 3=Agree, 4=Strongly Agree";

    let answers=[], scores={}, interpretation="", notes={};

    if (type==="hds") {
      const byScale={};
      qs.forEach(q=>{if(!byScale[q.scale])byScale[q.scale]=[];byScale[q.scale].push(q);});
      for (const [scale,items] of Object.entries(byScale)) {
        setAssessRunning(`hds:${scale}`);
        const itemList=items.map((q,i)=>`${i+1}. ${q.item_text.replace(/\{PROFESSIONAL_CONTACT\}/g,"a colleague or supervisor").replace(/\{PROFESSIONAL_CONTACTS\}/g,"colleagues or supervisors").replace(/\{PROFESSIONAL_CONTEXT\}/g,"at work")}`).join("\n");
        const raw=await callAI(`${ctx}\n\nAnswer these ${scale} HDS items AS ${(identity.first_name+" "+identity.last_name).trim()||"this character"} (${identity.occupation||"professional"}). Scale: ${scaleDesc}\nReturn JSON array only: [{"q":1,"answer":3,"label":"Agree"},...]\n\n${itemList}`);
        const parsed=parseJSON(raw);
        (Array.isArray(parsed)?parsed:[]).forEach((a,i)=>{
          const q=items[i];
          if(q) answers.push({question_id:q.id,item_text:q.item_text,scale,answer:a.answer,label:a.label});
        });
      }
      scores=scoreHDS(answers);
      const topThree=Object.entries(scores).sort(([,a],[,b])=>b-a).slice(0,3).map(([k])=>k);
      interpretation=`Top risks under stress: ${topThree.join(", ")}`;
      notes={topThree};
      setPersonality(p=>({...p,hds:scores}));
    } else {
      const itemList=qs.map((q,i)=>`${i+1}. ${q.item_text}`).join("\n");
      const raw=await callAI(`${ctx}\n\nAnswer these assessment items AS ${(identity.first_name+" "+identity.last_name).trim()||"this character"}. Scale: ${scaleDesc}\nReturn JSON array only: [{"q":1,"answer":"TRUE","label":"TRUE"},...]\n\n${itemList}`);
      const parsed=parseJSON(raw);
      answers=(Array.isArray(parsed)?parsed:[]).map((a,i)=>({question_id:qs[i]?.id,item_text:qs[i]?.item_text,answer:a.answer,label:a.label}));

      if (type==="big5") {
        scores=scoreBig5(answers);
        interpretation=`O=${scores.openness} C=${scores.conscientiousness} E=${scores.extraversion} A=${scores.agreeableness} N=${scores.neuroticism}`;
        setPersonality(p=>({...p, big5:scores}));
      } else if (type==="iwm") {
        scores=scoreIWM(answers);
        interpretation=`Self-view ${scores.selfView}/100 · Others-view ${scores.othersView}/100`;
        notes={selfView:scores.selfView>60?"positive":"negative",othersView:scores.othersView>60?"trusting":"guarded"};
        setAssessments(a=>({...a,iwm:interpretation}));
      } else if (type==="attachment") {
        scores=scoreAttachment(answers);
        const styleDesc={secure:"Comfortable with closeness and autonomy.",anxious:"Fears abandonment, seeks reassurance.",avoidant:"Values independence, avoidant of closeness.",fearful_avoidant:"Fears both intimacy and abandonment.",avoidant_secure:"Mostly secure with some avoidant tendencies."};
        interpretation=`${scores.style} — ${styleDesc[scores.style]||""}`;
        notes={style:scores.style,avoidScore:scores.avoidScore,anxScore:scores.anxScore};
        setAssessments(a=>({...a,attachment:interpretation}));
        setPersonality(p=>({...p,attachment_style:scores.style}));
      } else if (type==="intimacy") {
        const coping=answers.slice(5).filter(a=>a.answer==="TRUE").map(a=>a.item_text).join("; ");
        scores={score:answers.filter(a=>a.answer==="TRUE").length};
        interpretation="Intimacy & coping patterns assessed.";
        notes={copingNote:coping};
        setAssessments(a=>({...a,intimacy:interpretation}));
        // Session 103 — the assessment INFORMS an empty field, it never
        // clobbers authored text (found live: the crafted coping
        // paragraph replaced by a truncated first-person questionnaire
        // extract). The full extract survives in notes.copingNote for
        // anyone who wants the behavioral read.
        setPsychology(p=>(p.coping_mechanisms && p.coping_mechanisms.trim() ? p : {...p,coping_mechanisms:coping.slice(0,200)}));
      } else if (type==="cogstyle") {
        scores={score:answers.filter(a=>a.answer==="TRUE").length};
        interpretation="Cognitive and decision style assessed.";
        setAssessments(a=>({...a,cogstyle:interpretation}));
      } else if (type==="disc") {
        scores=scoreDISC(answers);
        const dom=Object.entries(scores).sort(([,a],[,b])=>b-a)[0];
        interpretation=dom?`Primary style: ${dom[0].toUpperCase()} (${dom[1]})`:  "";
        setPersonality(p=>({...p,disc:scores}));
      }
    }
    setAssessmentResults(r=>({...r,[type]:{answers,scores,interpretation,notes}}));
  }

  async function generateLifestyle() {
    setGenerating("lifestyle"); setError(null);
    try {
      const aiResult = await callAI(`${charCtx()} Attachment: ${personality.attachment_style}. N=${personality.big5.neuroticism} E=${personality.big5.extraversion}.\nReturn ONLY valid JSON:\n{"alcohol_relationship":"non_drinker|rare|moderate|regular|heavy","drug_use":"none|cannabis_occasional|cannabis_regular|mixed_recreational|cocaine_occasional","substance_context":"","sleep_pattern":"early_riser|normal|night_owl|irregular","sleep_quality":"good|variable|poor","exercise_habit":"sedentary|occasional|regular|athlete","exercise_type":"","social_frequency":"rarely|monthly|weekly|daily","diet":"","interests":"3-4 specific personal interests, comma-separated, fitting the Big5/attachment profile — concrete things this character would actually choose to do, not generic labels","lifestyle_note":""}`);
      setLifestyle(p=>({...p,...parseJSON(aiResult)}));
    } catch (err) { console.error("[generateLifestyle] FAILED:", err); setError("Generation failed"); }
    setGenerating(null);
  }

  async function generateEconomy() {
    setGenerating("economy"); setError(null);
    try {
      const aiResult = await callAI(`${charCtx()}\nDescribe this character's RELATIONSHIP to money — psychology, not amounts (income is world data, set at deploy). Spending should follow the character's psychology, not a generic template. Context: C=${personality.big5.conscientiousness}.\nReturn ONLY valid JSON:\n{"financial_situation":"stable|struggling|comfortable|wealthy|precarious","income_stability":"stable|variable|freelance|unemployed","spending_style":"frugal|balanced|spender|impulsive","savings_habit":"none|minimal|moderate|disciplined","attitude_to_wealth":"practical|aspirational|anxious|indifferent","financial_anxiety":0.3,"behavior_note":""}`);
      setEconomy(p=>({...p,...parseJSON(aiResult)}));
    } catch (err) { console.error("[generateEconomy] FAILED:", err); setError("Generation failed"); }
    setGenerating(null);
  }

  // Session 160 — hoisted out of handleSave so analyseAppearance shares it.
  // The reference photos reach /api/generate/appearance as base64 inside a
  // JSON body, and an unresized phone photo is several megabytes of it.
  const resizeForUpload = (file) => new Promise((res) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1200;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => res(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), {type:"image/jpeg"})), "image/jpeg", 0.88);
    };
    img.onerror = () => res(file);
    img.src = url;
  });

  // That route sniffs the JPEG magic prefix itself, so it wants raw base64
  // with the data: URL header taken off.
  const fileToBase64 = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });

  // ── Appearance, read from the reference photos ────────────────────────────
  //
  // ONE write path, the same law the profile editor's Appearance panel
  // follows: changing a field re-derives the prose unless the author has taken
  // it over by editing it directly, which `_auto:false` records. Both surfaces
  // honour that flag and both store the same map, so a description taken over
  // here is still the author's in the editor and is not silently recomposed on
  // the next dropdown change.
  //
  // The prose lands in identity.appearance because that is the field
  // POST /api/actors already writes to actors.appearance — the only appearance
  // the simulator reads. Until now nothing in this wizard ever wrote it, so
  // the column was NULL for every character born here.
  const setAppFields = next => {
    setAppearanceFields(next);
    if (next._auto !== false) setIdentity(p => ({ ...p, appearance: composeAppearance(next, (identity.gender||"").toLowerCase()) }));
  };
  const updApp     = (k, v) => setAppFields({ ...appearanceFields, [k]: v });
  const setAppProse = v => { setAppearanceFields({ ...appearanceFields, _auto:false }); updI("appearance", v); };

  const appSelect = (label, key) => (
    <Field key={key} label={label}>
      <select style={S.select} value={appearanceFields[key] || ""} onChange={e=>updApp(key, e.target.value)}>
        <option value="">— Unset —</option>
        {APP_SELECTS[key].map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </Field>
  );
  const appText = (label, key) => (
    <Field key={key} label={label}>
      <input style={S.input} value={appearanceFields[key] || ""} onChange={e=>updApp(key, e.target.value)} />
    </Field>
  );

  async function analyseAppearance() {
    const files = Object.values(photos).filter(Boolean);
    if (!files.length) { setError("Add a reference photo first — this reads from the photos above."); return; }
    setGenerating("appearance"); setError(null);
    try {
      const images = [];
      for (const f of files) images.push(await fileToBase64(await resizeForUpload(f)));
      const res = await fetch("/api/generate/appearance", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ images, name:(identity.first_name+" "+identity.last_name).trim(), gender:identity.gender, age:identity.age }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error || `server ${res.status}`);
      // The route answers 200 with { fields: {} } when Haiku's reply will not
      // parse, so a 200 is NOT proof it read anything. An empty map is
      // reported rather than composing an empty description over whatever the
      // author already had.
      const { gender:_echoedBack, ...fields } = d.fields || {};
      if (!Object.keys(fields).length) throw new Error("nothing usable came back for this photo");
      setAppFields({ ...appearanceFields, ...fields });
    } catch (err) {
      console.error("[analyseAppearance] FAILED:", err);
      setError(`Reading the appearance failed: ${err.message}`);
    }
    setGenerating(null);
  }

  function handleSlotFile(slug, e) {
    e.preventDefault();
    const file = (e.dataTransfer?.files||e.target.files)?.[0];
    if (file && file.type.startsWith("image/")) {
      setPhotos(p => ({...p, [slug]: file}));
      // Session 102 — photos previously only reached actor_media at
      // GENERATION time; picking a photo on an existing draft set
      // local state and nothing else, so it never survived a reload
      // (found live: profile slot empty on every draft load despite
      // "uploading"). With an actorId present, upload immediately —
      // the row is what photo_url/mediaPhotos restore from.
      if (actorId) {
        const fd = new FormData();
        fd.append("photo", file);
        fd.append("state_slug", slug);
        fd.append("media_type", "photo");
        fetch(`/api/actors/${actorId}/media`, { method: "POST", body: fd })
          .then(r => r.json()).then(d => console.log(`[CharacterWizard] photo slot '${slug}' uploaded to actor_media:`, d))
          .catch(err => console.error(`[CharacterWizard] photo slot '${slug}' upload FAILED:`, err));
      }
    }
  }

  function handleVoiceFile(e) {
    e.preventDefault();
    const file = (e.dataTransfer?.files || e.target.files)?.[0];
    if (!file || !(file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg)$/i.test(file.name))) return;
    setVoiceSample({ file, url: URL.createObjectURL(file) });
    // Session 103 — same law as photo slots: with an actorId, upload
    // immediately (the server's media route already speaks audio —
    // voice/ folder, actor_media upsert); the row is what restores.
    if (actorId) {
      const fd = new FormData();
      fd.append("audio", file);
      fd.append("state_slug", "voice_sample");
      fd.append("media_type", "audio");
      fetch(`/api/actors/${actorId}/media`, { method: "POST", body: fd })
        .then(r => r.json()).then(d => { console.log("[CharacterWizard] voice sample uploaded to actor_media:", d); if (d.url) setVoiceSample({ url: d.url }); })
        .catch(err => console.error("[CharacterWizard] voice sample upload FAILED:", err));
    } else {
      console.warn("[CharacterWizard] voice sample held locally — no actorId yet; re-pick after generation to persist");
    }
  }

  // ── 3D character creation (mocked pipeline for now — replace the
  // setTimeout progression with real daz-script-server / export calls
  // once the backend routes exist) ─────────────────────────────────────────
  const IN_PROGRESS_STAGES = ["queued","starting_daz_studio","uploading_photo","uploading_body_photos","generating_face","recovering_daz_studio","applying_body_shape","selecting_node","exporting","converting","downloading"];

  async function handleGenerateFace() {
    setCharacter3DError(null);
    if (!identity.first_name || !identity.last_name || !identity.gender) {
      setError("First Name, Last Name, and Gender are required before creating a 3D character.");
      return;
    }
    setError(null);
    try {
      let id = actorId;
      if (!id) {
        setCharacter3DStatus("creating_actor");
        setLoadedFromDraft(false); // a fresh generation is session-owned even if a draft was loaded earlier
        const res = await fetch("/api/actors", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identity, draft: true }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Could not create draft character");
        id = data.id;
        setActorId(id);
      }

      // The backend looks up the reference photo from actor_media — it has
      // to actually be on the server before generate-3d runs, not just
      // sitting as a local File in the Photos field.
      if (!photos.profile) throw new Error("Upload a reference photo first");
      setCharacter3DStatus("uploading_photo");
      const fd = new FormData();
      fd.append("photo", photos.profile);
      fd.append("state_slug", "profile");
      fd.append("media_type", "photo");
      fd.append("filename", photos.profile.name);
      const uploadRes = await fetch(`/api/actors/${id}/media`, { method: "POST", body: fd });
      if (!uploadRes.ok) throw new Error("Photo upload failed");

      // Advanced: body photos for AI shape matching. Only uploaded when
      // the Advanced toggle is on — asserted present FIRST (all three,
      // not just some) so a half-set never reaches the server; the
      // proportions script needs front+side+back together or it fails
      // outright anyway. Filename is actorId-based, not the original
      // device filename — same reasoning as giving these a predictable
      // slug: the backend needs to find these three deterministically
      // when it runs interpret_body.py, not search for whatever name
      // the phone/camera gave them.
      if (showBodyPhotos) {
        for (const slot of BODY_PHOTO_SLOTS) {
          if (!photos[slot.slug]) {
            throw new Error(`Add the ${slot.label.toLowerCase()} body photo before generating, or turn off Advanced.`);
          }
        }
        setCharacter3DStatus("uploading_body_photos");
        for (const slot of BODY_PHOTO_SLOTS) {
          const file = photos[slot.slug];
          const shortName = slot.slug.replace("body_", ""); // body_front -> front, etc.
          const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
          const bfd = new FormData();
          bfd.append("photo", file);
          bfd.append("state_slug", slot.slug);
          bfd.append("media_type", "photo");
          bfd.append("filename", `${id}_${shortName}.${ext}`);
          const bRes = await fetch(`/api/actors/${id}/media`, { method: "POST", body: bfd });
          if (!bRes.ok) throw new Error(`${slot.label} body photo upload failed`);
        }
      }

      const startRes = await fetch(`/api/actors/${id}/generate-3d`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gender: identity.gender, torsoLength: bodyTorsoLength, armsLength: bodyArmsLength, legsLength: bodyLegsLength,
          // Only meaningful (and only sent) alongside the three body
          // photos above — the backend's interpret_body.py call needs
          // it for --height-cm, same value the Advanced slider sets.
          ...(showBodyPhotos ? { bodyHeightCm } : {}),
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || startData.error) throw new Error(startData.error || "Could not start 3D generation");

      // Poll for status — the pipeline runs for minutes on the server,
      // this request just kicked it off.
      await new Promise((resolve, reject) => {
        const poll = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/actors/${id}/generate-3d`);
            const status = await statusRes.json();
            setCharacter3DStatus(status.stage);
            setPoseStage(status.poseStage || null);
            if (status.stage === "ready") {
              setGlbUrl(status.glbUrl);
              // Real feature (Session 101+) — populates the reference-
              // image toggle automatically for a REAL generation, same
              // fields the dev folder-picker already sets manually.
              // Falls back to null (toggle simply won't show — see
              // MiniGlbViewer's own guard) if this specific generation
              // had no Advanced-mode photos, or measurements.json
              // pull/parse failed server-side (non-fatal there too).
              if (status.frontReferenceImageUrl) setFrontReferenceImageUrl(status.frontReferenceImageUrl);
              if (status.sideReferenceImageUrl) setSideReferenceImageUrl(status.sideReferenceImageUrl);
              if (status.referenceCalibration) setReferenceCalibration(status.referenceCalibration);
              if (status.referenceMeasurements) setReferenceMeasurements(status.referenceMeasurements);
              clearInterval(poll); pollIntervalRef.current = null; resolve();
            }
            if (status.stage === "error") { clearInterval(poll); pollIntervalRef.current = null; reject(new Error(status.error || "3D generation failed")); }
          } catch (pollErr) {
            clearInterval(poll); pollIntervalRef.current = null; reject(pollErr);
          }
        }, 2500);
        pollIntervalRef.current = poll;
      });
    } catch (e) {
      setCharacter3DStatus("error");
      setCharacter3DError(e.message || "3D generation failed");
    }
  }

  // TEMPORARILY DISABLED (Session 97) — this whole effect used to
  // auto-navigate away 4 seconds after any error, no confirmation, no
  // control. During real production use that's reasonable UX; during
  // active debugging of the new idle/walk/merge pipeline it was
  // actively harmful in two ways at once: the DELETE call wiped the Mac
  // Mini tmp folder (DUFs/blends/dbz) before it could be inspected, AND
  // the navigate("/actors") closed the wizard out from under a person
  // who never asked for that, before they'd even finished reading the
  // error message. Confirmed directly: error logged, folder gone ~6s
  // later, every single time. Re-enable (both the DELETE and the
  // navigate) once the merge step is proven working end to end — for
  // now the wizard just sits on the error and lets a person read it,
  // check the Mac Mini folder, and close manually via ✕ when they're
  // actually ready to, which itself still asks for confirmation.
  //
  // useEffect(() => {
  //   if (character3DStatus !== "error") return;
  //   const t = setTimeout(async () => {
  //     if (actorId) {
  //       await fetch(`/api/actors/${actorId}`, { method: "DELETE" }).catch(() => {});
  //     }
  //     navigate("/actors");
  //   }, 4000);
  //   return () => clearTimeout(t);
  // }, [character3DStatus]);

  async function handleCloseWizard() {
    // Session 102 — was confirm-then-DELETE (closing always destroyed
    // the character). Now routes to the save/discard/cancel prompt;
    // deletion only happens when Discard is chosen explicitly.
    if (!actorId) {
      if (window.confirm("Close the wizard? All unsaved work will be lost.")) navigate(exitTo);
      return;
    }
    setClosePrompt(true);
  }

  async function handleSave() {
    if (!identity.first_name) { setError("First name is required"); return; }
    setSaving(true); setError(null);
    // Declared outside try so the catch block can see them too — same
    // reason the original code declared its actorId variable up here.
    let isDraft = !!actorId;
    let savedActorId = actorId;
    try {
      // If Generate Face already created a draft actor earlier in this
      // session, finish it by POSTing with its id (the backend updates
      // in place and flips status to active) instead of creating a duplicate.
      const res = await fetch("/api/actors", {
        method: "POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ id: isDraft ? actorId : undefined, identity, psychology:{...psychology, attachment_style:personality.attachment_style}, personality, lifestyle, economy, default_home_template_url: homeTemplate || null, draft:false, bodyHeightCm: bodyHeightCm || undefined, appearance_fields: JSON.stringify(appearanceFields) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Save failed");
      if (!isDraft) setActorId(data.id);
      savedActorId = data.id || actorId;

      // 2. Upload photos — non-fatal, don't rollback for photo failures
      for (const [slug, file] of Object.entries(photos)) {
        const resized = await resizeForUpload(file);
        const fd = new FormData();
        fd.append("photo", resized);
        fd.append("state_slug", slug);
        fd.append("media_type", "photo");
        fd.append("filename", resized.name);
        await fetch(`/api/actors/${savedActorId}/media`, {method:"POST",body:fd}).catch(()=>{});
      }

      // 3. Save assessments — non-fatal
      for (const [atype, result] of Object.entries(assessmentResults)) {
        if (result?.answers?.length) {
          await fetch(`/api/actors/${savedActorId}/assessments`, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({ assessment_type:atype, ...result }),
          }).catch(()=>{});
        }
      }

      // Adopting it as your body is the last step and it is separate from
      // saving: POST /api/actors made a character, this is what makes that
      // character you. If it fails the character still exists and is still
      // yours — say so rather than implying the whole save was lost.
      if (isAvatar) {
        try {
          const r = await fetch("/api/me/avatar", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actor_id: savedActorId }),
          });
          if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || "Could not set it as your profile.");
          navigate("/home");
          return;
        } catch (e) {
          setError(`Saved, but not set as your 3D profile: ${e.message} You can pick it in your character gallery.`);
          setSaving(false);
          return;
        }
      }

      navigate("/actors");
    } catch(e) {
      // Only roll back an actor freshly created in THIS save attempt.
      // A pre-existing draft (already has a generated 3D character on it)
      // is left alone on failure so that work isn't lost — just show the
      // error and let the user retry Save.
      if (!isDraft && savedActorId) {
        await fetch(`/api/actors/${savedActorId}`, { method:"DELETE" }).catch(()=>{});
      }
      setError(e.message||"Save failed");
      setSaving(false);
    }
  }

  const psychFields = [
    {key:"backstory",         label:"Backstory",               ph:"How did they get here? Upbringing, formative events…",      rows:3},
    {key:"wound",             label:"The Wound",               ph:"The core thing they carry — shaped them most."},
    {key:"what_they_want",    label:"What They Actually Want", ph:"The private, unspoken desire — what they'd never say directly."},
    {key:"blindspot",         label:"The Blind Spot",          ph:"The pattern they repeat without ever seeing it."},
    {key:"defenses",          label:"Defenses",                ph:"How they protect themselves when vulnerable."},
    {key:"contradiction",     label:"The Contradiction",       ph:"The thing about them that doesn't add up."},
    {key:"coping_mechanisms", label:"Coping Mechanisms",       ph:"What they do when overwhelmed."},
    {key:"view_on_sex",       label:"View on Sex & Intimacy",  ph:"Their relationship with sex, intimacy and physical closeness…"},
    {key:"self_view",         label:"Self View",               ph:"How they'd describe themselves, warts and all — strengths they know they have, weak points they know about too."},
    {key:"others_view",       label:"Others View",             ph:"How they come across to other people — first impression vs. what people learn once they know them."},
    {key:"family_model",      label:"Family Model",            ph:"The relational template inherited from family — what love, conflict and closeness looked like growing up."},
    {key:"relationship_read_pattern", label:"Relationship Read Pattern", ph:"The lens they read relationship signals through — what they mistake for what."},
  ];

  // Age/Sexual Orientation/Occupation and the body-shape sliders only
  // make sense once there's an actual character to attach them to —
  // disabled until the GLB is genuinely loaded, same condition already
  // used elsewhere to decide whether to render MiniGlbViewer at all.
  const glbReady = character3DStatus==="ready" && !!glbUrl;
  // Real feature (Session 101+) — shared by the dev shortcut below and
  // the real "Next →" button. Only exports+swaps glbUrl when actually
  // leaving step 1 (exportGlbRef is only ever populated by the
  // Appearance-step MiniGlbViewer instance — see its onExportReady
  // prop) — steps 2+ just advance normally, no export needed. Revokes
  // the OLD blob: URL after the swap (not before — revoking while
  // still in use would break the currently-rendering viewer), same
  // cleanup pattern already used by the dev folder-loader elsewhere in
  // this file. Falls through to a plain step advance on export failure
  // rather than blocking navigation entirely over this — the old
  // glbUrl (with extraMorphValues still passed as props) is a real,
  // working fallback, just relying on the same re-apply-on-load path
  // this feature exists to sidestep.
  async function advanceStep(currentStep, nextStepFn) {
    // Session 107 — the gate was `currentStep === 1` only, which meant
    // every canonical GLB on disk was the NAKED step-1 body: the
    // accessories equipped and fitted in step 2 lived only in the live
    // scene and were never persisted (confirmed: Lindsey's exported
    // file contained zero accessory meshes; ActorModelPanel's explore
    // mode walked her around undressed). The viewer is persistent
    // across steps 1-2 and exportGlbRef serializes the LIVE scene —
    // so leaving step 2 exports body PLUS fitted garments through the
    // exact same path, overwriting the same canonical file. Leaving
    // step 1 still exports too (body-only at that point), preserving
    // the old behavior for users who never touch accessories.
    if ((currentStep === 1 || currentStep === 2) && exportGlbRef.current && !glbSaveInFlightRef.current) {
      glbSaveInFlightRef.current = true;
      // Session 103 — the export is BACKGROUNDED: Next used to await a
      // GLTFExporter serialization of the full body (113 morph
      // targets, seconds of CPU) before navigating — and with the
      // persistent viewer that wait buys the user NOTHING: step 2 uses
      // the live scene; the bake exists purely for downstream
      // consumers. Kick it off, navigate immediately.
      (async () => {
      try {
        // Session 107 — leaving step 2 exports DRESSED (the live scene
        // holds the fitted wardrobe); leaving step 1 keeps the
        // Session 101 body-only contract. The option reaches the
        // detach logic inside exportMorphedGlbBlob.
        const blob = await exportGlbRef.current(currentStep === 2 ? { includeAccessories: true } : {});
        // Session 102 — the client-side blob SWAP that lived here is
        // GONE, deliberately: the step-2 viewer keeps the CANONICAL
        // glbUrl and shapes it from props, the exact mechanism draft
        // loading proved end to end (meshesVersion fires the nudge
        // path at any mount's load completion). The swap was Session
        // 101's sidestep for a never-root-caused bug and had become
        // the prime suspect itself: a re-mounted export whose morph
        // metadata can't be re-driven by name renders default and
        // no-ops every slider. The export still runs for the
        // server-side persist below — downstream consumers
        // (ActorModelPanel, the simulator) load the file WITHOUT
        // wizard state and need the shape baked in.
        // Real feature (Session 101+) — persists the same morphed blob
        // server-side, overwriting the actor's own canonical glb file
        // (same path pullGlbToServer() already uses), so it survives
        // past this browser session — not just the immediate client-
        // side swap above. Deliberately NOT awaited: this is a real
        // network round-trip on top of the export that already just
        // happened, and step navigation shouldn't wait on it — the
        // client-side swap above is what the user actually sees change
        // immediately. Failure here (e.g. a dev-loaded character with
        // no real, owned DB row for this id) is logged, not thrown —
        // matches the same "don't block navigation over this" posture
        // as the try/catch around the export itself.
        fetch(`/api/actors/${actorId}/save-morphed-glb`, { // Session 102: was ${id} — that binding lived in a line the blob-swap removal deleted; the persist failed silently (caught) on every Next since (found via console log)
          method: "POST",
          headers: { "Content-Type": "model/gltf-binary" },
          body: blob,
        })
          .then(res => res.json())
          .then(data => {
            if (data.saved) console.log(`[advanceStep] server-side glb save succeeded: ${data.glbUrl}`);
            else console.error("[advanceStep] server-side glb save failed:", data);
          })
          .catch(err => console.error("[advanceStep] server-side glb save request failed:", err));
      } catch (err) {
        console.error("[advanceStep] background export failed (navigation was not blocked):", err);
      } finally {
        glbSaveInFlightRef.current = false;
      }
      })();
    }
    nextStepFn();
  }
  // Dev-only shortcut: Cmd+Shift+Right advances one wizard step,
  // bypassing the real Next button's validation entirely (setStep
  // called directly, not through the button's own disabled/checked
  // logic) — for testing later steps fast without filling out every
  // required field first. Plain Cmd+Right (no Shift) was tried first
  // but never reached this handler at all — it's a commonly
  // browser-reserved shortcut (forward in page history) that gets
  // intercepted before the page's own JS sees the keypress. Shift
  // avoids that collision. Only active once a character's loaded.
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.metaKey && e.shiftKey && e.key === "ArrowRight" && glbReady) {
        e.preventDefault();
        advanceStep(step, () => setStep(s => Math.min(s + 1, 7)));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [glbReady, step, glbUrl]);
  const step1Complete = glbReady && !!identity.age && !!identity.orientation && !!identity.occupation;
  // Psychology: every field in psychFields has to actually have text —
  // reuses the same array the step renders from, so a field added there
  // is covered here automatically, no second list to keep in sync.
  const step3Complete = psychFields.every(f => !!psychology[f.key] && psychology[f.key].trim().length > 0);
  // Personality: iwm/attachment/intimacy/cogstyle are tracked in
  // `assessments`; big5/disc/hds aren't (no assessments.big5 key exists),
  // so their "has this actually been run" signal is the same
  // deviation-from-default heuristic their own Run/Re-run button labels
  // already use above — reused here rather than invented fresh.
  const step4Complete = !!assessments.iwm && (!!assessments.attachment || !!personality.attachment_style) && !!assessments.intimacy && !!assessments.cogstyle
    && (personality.big5.openness!==50 || personality.big5.neuroticism!==50)
    && (personality.disc.d!==50 || personality.disc.i!==50)
    && (personality.hds.bold!==30 || personality.hds.cautious!==30);
  // Lifestyle/Economy: the <select> fields all carry a non-empty
  // default (alcohol_relationship defaults to "rare", financial_anxiety
  // to 0.3, etc.) so their mere presence can't signal "actually
  // touched" the same way psychFields' blank-by-default textareas can.
  // The genuinely empty-by-default freeform fields are the only real
  // signal available — same reasoning as step3Complete, just a shorter
  // list since most of these two steps is dropdowns.
  const step5Complete = !!lifestyle.substance_context?.trim() && !!lifestyle.exercise_type?.trim() && !!lifestyle.diet?.trim();
  const step6Complete = !!economy.behavior_note?.trim();

  return (
    <>
    <div style={{background:"#eeecea",minHeight:"100vh",position:"relative"}}>
      <div style={{position:"relative",zIndex:1,display:"flex",flexDirection:"column",minHeight:"100vh"}}>
        {closePrompt && (
          <div style={{position:"fixed", inset:0, zIndex:60, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center"}}>
            <div style={{background:"#f6f4f1", borderRadius:14, padding:"26px 30px", width:380, boxShadow:"0 12px 40px rgba(0,0,0,0.25)"}}>
              <div style={{fontFamily:"'DM Mono',monospace", fontSize:13, fontWeight:600, marginBottom:8}}>Close character wizard?</div>
              <div style={{fontSize:12, color:"#6b6760", marginBottom:18, lineHeight:1.5}}>
                {loadedFromDraft
                  ? "Save your changes to this draft, or discard them — the draft itself stays as it was last saved."
                  : "Save this character as a draft to continue later, or discard it — discarding permanently deletes the generated files."}
              </div>
              <div style={{display:"flex", gap:8}}>
                <button onClick={saveDraftAndClose} disabled={savingDraft}
                  style={{flex:1, padding:"9px 4px", borderRadius:8, border:"1px solid #b05c08", background:"rgba(176,92,8,0.12)", color:"#b05c08", fontFamily:"'DM Mono',monospace", fontSize:11, cursor:"pointer", opacity:savingDraft?0.6:1}}>
                  {savingDraft ? "Saving…" : (loadedFromDraft ? "Save changes" : "Save draft")}</button>
                <button onClick={discardAndClose}
                  style={{flex:1, padding:"9px 4px", borderRadius:8, border:"1px solid rgba(180,60,40,0.5)", background:"transparent", color:"#a04030", fontFamily:"'DM Mono',monospace", fontSize:11, cursor:"pointer"}}>{loadedFromDraft ? "Discard changes" : "Discard"}</button>
                <button onClick={()=>setClosePrompt(false)}
                  style={{flex:1, padding:"9px 4px", borderRadius:8, border:"1px solid rgba(0,0,0,0.15)", background:"transparent", color:"#6b6760", fontFamily:"'DM Mono',monospace", fontSize:11, cursor:"pointer"}}>Cancel</button>
              </div>
            </div>
          </div>
        )}
        {/* Loading spinner overlay */}
        {(assessRunning || generating) && (
          <div style={{ position:"absolute", inset:0, zIndex:10, borderRadius:24, background:"rgba(255,255,255,0.82)", backdropFilter:"blur(8px)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
            <div style={{ width:40, height:40, border:"3px solid rgba(0,0,0,0.08)", borderTop:"3px solid #c9973a", borderRadius:"50%", animation:"spin 0.9s linear infinite" }} />
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:13, color:"#1a1814", fontWeight:500 }}>
              {assessRunning === "all" ? "Running all assessments" :
               assessRunning?.startsWith("hds:") ? `Running HDS — ${assessRunning.split(":")[1]}` :
               assessRunning === "big5" ? "Running Big Five assessment" :
               assessRunning === "disc" ? "Running DISC assessment" :
               assessRunning ? `Running ${assessRunning} assessment` :
               generating === "all" ? "Generating psychology profile" :
               generating === "appearance" ? "Analysing appearance" :
               generating === "lifestyle" ? "Generating lifestyle profile" :
               generating === "economy" ? "Generating economic profile" :
               generating ? `Generating ${generating}` : "Thinking…"}
            </div>
            <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, color:"#a8a5a0" }}>This may take a few seconds</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Header */}
        <div style={S.head}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
            <div style={{...S.serif,fontSize:26,fontWeight:400,color:"#1a1814"}}>{step<7?"New Character":(identity.first_name+" "+identity.last_name).trim()||"Review"}</div>
            <button onClick={handleCloseWizard} style={{background:"none",border:"1px solid rgba(0,0,0,0.08)",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#a8a5a0"}}>✕</button>
          </div>
          <div style={{display:"flex",gap:0}}>
            {STEPS.map((label,i)=>{
              const n=i+1,active=n===step;
              if (isAvatar && !AVATAR_STEPS.includes(n)) return null;
              // Per-step completeness — the exact same signals that
              // already gate Next (step1Complete/step3Complete/
              // step4Complete), reused here rather than a second
              // parallel definition. Accessories (2) has no completion
              // rule on purpose: a deliberately nude or minimally-dressed
              // character is a valid, finished choice, not an unfinished
              // one — inventing a "must equip N items" rule here would
              // be actively wrong, not just unbuilt, unlike Lifestyle/
              // Economy which had a real gap (see step5Complete/
              // step6Complete above). Review (7) has no content of its
              // own — it's a summary of everything else, so its
              // completeness is just whether everything it's
              // summarizing is actually done.
              const stepComplete = s => s===1?step1Complete : s===3?step3Complete : s===4?step4Complete
                : s===5?step5Complete : s===6?step6Complete
                : s===7?(step1Complete&&step3Complete&&step4Complete&&step5Complete&&step6Complete)
                : true;
              const finished = stepComplete(n);
              // User-reported: could go backward from tab 3 to tab 1
              // freely but not forward from 1 to 3 even with both 1 and
              // 2 already finished — forward reach was capped at exactly
              // one hop regardless of how many complete steps followed.
              // Generalized: any unbroken run of already-finished steps
              // ahead of the current one can be skipped in one click;
              // hitting an unfinished step still stops it, same law as
              // before, just no longer capped at a single hop. Backward
              // stays unconditionally free.
              const reachable = !active && (n < step || (n > step && Array.from({length:n-step},(_,k)=>step+k).every(stepComplete)));
              return (
                <div key={n} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:5,cursor:reachable?"pointer":"default"}} onClick={()=>reachable&&advanceStep(step, () => setStep(n))}>
                  <div style={{height:2,width:"100%",background:active?"#1a1814":finished?"#34c759":"#c9973a",transition:"background .3s"}} />
                  <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,letterSpacing:"0.12em",textTransform:"uppercase",color:active?"#1a1814":finished?"#34c759":"#c9973a"}}>{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div style={S.body}>
          {error&&<div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#c0392b",background:"rgba(192,57,43,0.06)",border:"1px solid rgba(192,57,43,0.15)",borderRadius:8,padding:"10px 14px",marginBottom:18}}>{error}</div>}

          {/* STEP 1: APPEARANCE (identity fields + 3D character creation) */}
          {/* Session 102 — drafts sidebar, Claude-style (user's explicit
              design feedback): a full-height left column with clickable
              rows (the row IS the load action, like a chat item), not a
              floating card. Collapsed: slim toggle at the left edge.
              Always present on the Appearance step, empty state
              included — invisible features are indistinguishable from
              broken ones. Closes itself after a successful load. */}
          {/* Session 103 — the ONE persistent viewer (see viewerHost). Props
              derive from the current step: step 1 = full toolkit with
              reference images; step 2+ = perspective-locked, dressed,
              region camera. Garments strip on step 1 (nude adjust) and
              re-add on step 2 via the accessory manager — fast, no body
              reload either way. */}
          {glbUrl && character3DStatus==="ready" && (
            <div style={viewerRect
              ? { position: "fixed", top: viewerRect.top, left: viewerRect.left, width: viewerRect.width, height: viewerRect.height, zIndex: 5 }
              : { position: "fixed", top: 0, left: -10000, width: 800, height: 600 } /* parked offscreen, never unmounted */}>
            <MiniGlbViewer
              glbUrl={glbUrl}
              accessories={step>=2 ? buildViewerAccessories({
                selectedAccessoryGlbUrls, accessoryScales, accessoryOffsets, accessoryRotations,
                accessoryParts, accessoryTints, activeSlot, dynamicAccessoryOptions,
              }) : []}
              onAccessoryPartsLoaded={setAccessoryPartNames}
              bodyTorsoLength={bodyTorsoLength} bodyArmsLength={bodyArmsLength} bodyLegsLength={bodyLegsLength} bodyHeight={bodyHeight}
              extraMorphValues={extraMorphValues} activeAnimation={activeAnimation}
              onAnimationsLoaded={setAvailableAnimations} onLoadingChange={setGlbClientLoading}
              frontReferenceImageUrl={step===1 ? frontReferenceImageUrl : null}
              sideReferenceImageUrl={step===1 ? sideReferenceImageUrl : null}
              referenceCalibration={step===1 ? referenceCalibration : null}
              onExportReady={(fn) => { exportGlbRef.current = fn; }} onSolveReady={(fn) => { solveRef.current = fn; }}
              poseValues={poseValues}
              focusRegion={step>=2 ? (ACCESSORY_REGION_CAMERA[activeAccessoryRegion] || "fullBody") : activeBodyRegion}
              perspectiveOnly={step>=2}
              loadingPhotoUrl={loadingPhotoUrl}
            />
            </div>
          )}
          {step===1 && !draftsRailOpen && (
            <button onClick={()=>setDraftsRailOpen(true)} title="Show drafts"
              style={{position:"fixed", left:0, top:120, zIndex:40, writingMode:"vertical-rl", textOrientation:"mixed",
                padding:"12px 6px", borderRadius:"0 8px 8px 0", border:"1px solid rgba(0,0,0,0.10)", borderLeft:"none",
                background:"#f6f4f1", color:"#6b6760", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:"0.1em", cursor:"pointer"}}>
              DRAFTS{draftsList.length ? ` (${draftsList.length})` : ""}</button>
          )}
          {step===1 && draftsRailOpen && (
            <div style={{position:"fixed", left:0, top:0, bottom:0, width:264, zIndex:40, background:"#f0eeea",
              borderRight:"1px solid rgba(0,0,0,0.10)", boxShadow:"6px 0 24px rgba(0,0,0,0.08)",
              display:"flex", flexDirection:"column"}}>
              <div style={{display:"flex", alignItems:"center", padding:"16px 14px 10px"}}>
                <div style={{flex:1, fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:"0.08em", textTransform:"uppercase", color:"#6b6760"}}>Drafts</div>
                <button onClick={()=>setDraftsRailOpen(false)} title="Collapse"
                  style={{border:"none", background:"none", color:"#a8a5a0", cursor:"pointer", fontSize:15, padding:"2px 6px"}}>‹</button>
              </div>
              <div style={{flex:1, overflowY:"auto", padding:"0 8px 12px"}}>
                {draftsList.length === 0 && (
                  <div style={{fontSize:11, color:"#a8a5a0", padding:"6px 8px", lineHeight:1.5}}>No saved drafts yet — close the wizard after generating a character and choose "Save draft".</div>
                )}
                {draftsList.map(d => (
                  <div key={d.id} onClick={()=>loadDraft(d.id)}
                    onMouseEnter={e=>{e.currentTarget.style.background="rgba(176,92,8,0.07)";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}
                    style={{display:"flex", alignItems:"center", gap:8, padding:"9px 8px", borderRadius:8, cursor:"pointer"}}>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{d.name || "Unnamed character"}</div>
                      <div style={{color:"#a8a5a0", fontSize:9}}>{d.updated_at ? new Date(d.updated_at).toLocaleString() : ""}</div>
                    </div>
                    <button onClick={(e)=>{e.stopPropagation(); wipeDraft(d.id);}} title="Delete draft permanently"
                      style={{border:"none", background:"none", color:"#a04030", fontSize:12, cursor:"pointer", padding:"3px 5px"}}>🗑</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {step===1&&<div style={{display:"grid",gridTemplateColumns:"400px minmax(0,1fr) 300px",gap:28,alignItems:"start",minHeight:"calc(100vh - 260px)"}}>
          {/* Session 152 — the LEFT column gets the same viewport cap the right
              column earned in Session 101, for the same confirmed reason: an
              uncapped column dictates the whole grid row's height, and the
              centre viewer matches it via alignSelf:"stretch". The right side
              was fixed then; the left kept growing (reference photo, body
              photos, height, voice…) until on a tall monitor the VIEWER was
              taller than the screen and the whole page scrolled. Both side
              columns now scroll themselves, the row settles at the viewport
              calc, and the 3D preview fits the screen with no main scrollbar. */}
          <div style={{maxHeight:"calc(100vh - 260px)", overflowY:"auto", overflowX:"hidden", paddingRight:4}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:18}}>
              <Field label="First Name" required><input style={S.input} value={identity.first_name} onChange={e=>updI("first_name",e.target.value)} placeholder="Emma…" /></Field>
              <Field label="Last Name" required><input style={S.input} value={identity.last_name} onChange={e=>updI("last_name",e.target.value)} placeholder="Lindqvist…" /></Field>
            </div>

            <Field label="Gender" required>
              <select style={S.select} value={identity.gender} onChange={e=>updI("gender",e.target.value)}>
                <option value="">— Select Gender —</option>
                <option value="female">Female — she/her</option>
                <option value="male">Male — he/him</option>
                <option value="neutral">Non-binary — they/them</option>
              </select>
            </Field>

            {/* Session 148 — nationality after Gender (ruled by Magnus):
                pins what the three LLMs otherwise each infer differently
                from a name. ISO 3166-1 alpha-2 code stored on
                identity.nationality; the flag is computed from the code
                itself (two regional-indicator codepoints) — no assets.
                Optional by design: unpinned is valid, forced choices
                invite junk data. */}
            <Field label="Nationality">
              <select style={S.select} value={identity.nationality} onChange={e=>updI("nationality",e.target.value)}>
                <option value="">— Optional —</option>
                {NATIONALITIES.map(([code, label]) => (
                  <option key={code} value={code}>{flagEmoji(code)} {label}</option>
                ))}
              </select>
            </Field>

            {/* Session 148 — Age / Sexual Orientation / Occupation moved
                above Reference Photo (ruled by Magnus): identity facts
                cluster first, visual inputs after. The glbReady gate on
                these fields is kept as documented at its declaration —
                position changed, behavior didn't. */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Field label="Age" required><input style={S.input} type="number" min={18} max={99} value={identity.age} onChange={e=>updI("age",e.target.value)} placeholder="28" disabled={!glbReady} /></Field>
              <Field label="Sexual Orientation" required>
                <select style={S.select} value={identity.orientation} onChange={e=>updI("orientation",e.target.value)} disabled={!glbReady}>
                  <option value="">— Select Sexual —</option>
                  <option value="straight">Straight</option>
                  <option value="bisexual">Bisexual</option>
                  <option value="gay">Gay / Lesbian</option>
                  <option value="pansexual">Pansexual</option>
                  <option value="asexual">Asexual</option>
                </select>
              </Field>
            </div>
            <Field label="Occupation" required hint="Shapes schedule, income and daily behaviour.">
              <input style={S.input} value={identity.occupation} onChange={e=>updI("occupation",e.target.value)} placeholder="Photographer, nurse, architect…" disabled={!glbReady} />
            </Field>


            <Field label="Reference Photo" hint="Face forward, neutral background, good even lighting — like a passport photo. This drives both the appearance description and the 3D face generation, so composition matters here.">
              <div style={{display:"grid",gridTemplateColumns:`repeat(${PHOTO_SLOTS.length},1fr)`,gap:8,maxWidth:180}}>
                {PHOTO_SLOTS.map(slot=>(
                  <div key={slot.slug}
                    onDragOver={e=>e.preventDefault()}
                    onDrop={e=>handleSlotFile(slot.slug,e)}
                    onClick={()=>{ activeSlotRef.current = slot.slug; fileRef.current?.click(); }}
                    style={{border:`1px dashed ${photos[slot.slug]?"rgba(176,92,8,0.4)":"rgba(0,0,0,0.12)"}`,borderRadius:10,overflow:"hidden",aspectRatio:"1",position:"relative",cursor:"pointer",background:"rgba(255,255,255,0.5)"}}>
                    {photos[slot.slug]?(
                      <>
                        <img src={URL.createObjectURL(photos[slot.slug])} alt={slot.label} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} />
                        <button onClick={e=>{e.stopPropagation();setPhotos(p=>{const n={...p};delete n[slot.slug];return n;})}}
                          style={{position:"absolute",top:4,right:4,width:18,height:18,borderRadius:"50%",background:"rgba(26,24,20,0.8)",color:"#fff",border:"none",cursor:"pointer",fontSize:10,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                        <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"3px 5px",background:"rgba(0,0,0,0.45)",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,color:"#fff",letterSpacing:"0.08em",textTransform:"uppercase",textAlign:"center"}}>{slot.label}</div>
                      </>
                    ):(
                      <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
                        <svg width="34" height="34" viewBox="0 0 34 34" style={{opacity:0.3}}>
                          {/* passport-photo-style head-and-shoulders guide */}
                          <rect x="1" y="1" width="32" height="32" rx="3" fill="none" stroke="#a8a5a0" strokeWidth="1" strokeDasharray="2,2" />
                          <circle cx="17" cy="12" r="6.5" fill="none" stroke="#a8a5a0" strokeWidth="1.4" />
                          <path d="M6 30 C6 21, 12 18, 17 18 C22 18, 28 21, 28 30" fill="none" stroke="#a8a5a0" strokeWidth="1.4" />
                        </svg>
                        <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,color:"#a8a5a0",letterSpacing:"0.1em",textTransform:"uppercase"}}>{slot.label}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{if(activeSlotRef.current)handleSlotFile(activeSlotRef.current,e);}} />
            </Field>

            {/* Advanced, collapsed by default — default flow (one
                reference photo) stays exactly as it was. This adds
                real, physical body-shape matching for anyone who
                wants it, without cluttering the common case. */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom: showBodyPhotos ? 12 : 18}}>
              <div>
                <label style={{...S.label,marginBottom:2}}>Advanced</label>
                <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0"}}>
                  Add body photos for AI shape matching
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={showBodyPhotos}
                onClick={()=>setShowBodyPhotos(v=>!v)}
                style={{
                  position:"relative",
                  width:40,
                  height:22,
                  borderRadius:11,
                  border:"none",
                  padding:0,
                  cursor:"pointer",
                  flexShrink:0,
                  background: showBodyPhotos ? "#b05c08" : "rgba(0,0,0,0.15)",
                  transition:"background .15s",
                }}
              >
                <span style={{
                  position:"absolute",
                  top:2,
                  left: showBodyPhotos ? 20 : 2,
                  width:18,
                  height:18,
                  borderRadius:"50%",
                  background:"#fff",
                  boxShadow:"0 1px 3px rgba(0,0,0,0.3)",
                  transition:"left .15s",
                }} />
              </button>
            </div>

            {showBodyPhotos && (
              <Field label="Body Photos" hint="Full body, A-pose (arms angled down and away from the torso, not straight out) — front, side, and back. Used to shape the body to match real proportions, separate from the face.">
                <div style={{display:"grid",gridTemplateColumns:`repeat(${BODY_PHOTO_SLOTS.length},1fr)`,gap:8,maxWidth:270,marginBottom:12}}>
                  {BODY_PHOTO_SLOTS.map(slot=>(
                    <div key={slot.slug}
                      onDragOver={e=>e.preventDefault()}
                      onDrop={e=>handleSlotFile(slot.slug,e)}
                      onClick={()=>{ activeSlotRef.current = slot.slug; fileRef.current?.click(); }}
                      style={{border:`1px dashed ${photos[slot.slug]?"rgba(176,92,8,0.4)":"rgba(0,0,0,0.12)"}`,borderRadius:10,overflow:"hidden",aspectRatio:"1",position:"relative",cursor:"pointer",background:"rgba(255,255,255,0.5)"}}>
                      {photos[slot.slug]?(
                        <>
                          <img src={URL.createObjectURL(photos[slot.slug])} alt={slot.label} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} />
                          <button onClick={e=>{e.stopPropagation();setPhotos(p=>{const n={...p};delete n[slot.slug];return n;})}}
                            style={{position:"absolute",top:4,right:4,width:18,height:18,borderRadius:"50%",background:"rgba(26,24,20,0.8)",color:"#fff",border:"none",cursor:"pointer",fontSize:10,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                          <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"3px 5px",background:"rgba(0,0,0,0.45)",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,color:"#fff",letterSpacing:"0.08em",textTransform:"uppercase",textAlign:"center"}}>{slot.label}</div>
                        </>
                      ):(
                        <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
                          <svg width="28" height="28" viewBox="0 0 34 34" style={{opacity:0.3}}>
                            <rect x="1" y="1" width="32" height="32" rx="3" fill="none" stroke="#a8a5a0" strokeWidth="1" strokeDasharray="2,2" />
                            <circle cx="17" cy="9" r="4.5" fill="none" stroke="#a8a5a0" strokeWidth="1.2" />
                            <path d="M9 30 L9 15 C9 13, 11 13, 17 13 C23 13, 25 13, 25 15 L25 30" fill="none" stroke="#a8a5a0" strokeWidth="1.2" />
                          </svg>
                          <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,color:"#a8a5a0",letterSpacing:"0.1em",textTransform:"uppercase"}}>{slot.label}</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <label style={{display:"block",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,letterSpacing:"0.1em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:6}}>
                  Real height — required to scale the photos correctly
                </label>
                <div style={{...S.sliderRow, maxWidth:270}}>
                  <span style={S.sliderLbl}>Height</span>
                  <input
                    type="range"
                    min={140}
                    max={200}
                    step={1}
                    value={bodyHeightCm}
                    onChange={e=>setBodyHeightCm(Number(e.target.value))}
                    style={{flex:1,accentColor:"#b05c08",height:4,cursor:"pointer"}}
                  />
                  <span style={{...S.sliderVal,width:48}}>{bodyHeightCm} cm</span>
                </div>
              </Field>
            )}

            <button
              onClick={handleGenerateFace}
              disabled={IN_PROGRESS_STAGES.includes(character3DStatus) || character3DStatus==="creating_actor"}
              style={{...S.btnAmberFull, marginBottom:18, opacity:(IN_PROGRESS_STAGES.includes(character3DStatus) || character3DStatus==="creating_actor")?0.6:1}}>
              {character3DStatus==="ready" ? "◈ Regenerate 3D Character" : (IN_PROGRESS_STAGES.includes(character3DStatus) || character3DStatus==="creating_actor") ? "◈ Working…" : "◈ Create 3D Character"}
            </button>

            {/* Session 103 — the XTTS voice sample slot: upload straight
                to actor_media (audio branch already live server-side),
                playback as the receipt. */}
            <div style={{marginBottom:18}}>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:8}}>Voice Sample (XTTS)</div>
              {voiceSample?.url && (
                <audio controls src={voiceSample.url} style={{width:"100%",height:36,marginBottom:8}} />
              )}
              <label style={{display:"block",border:"1px dashed rgba(0,0,0,0.15)",borderRadius:10,padding:"10px 14px",cursor:"pointer",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#6b6760",textAlign:"center",background:"rgba(255,255,255,0.5)"}}
                onDragOver={e=>e.preventDefault()} onDrop={handleVoiceFile}>
                {voiceSample ? "Replace voice sample" : "Drop or pick an audio file (mp3/wav)"}
                <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" style={{display:"none"}} onChange={handleVoiceFile} />
              </label>
            </div>}

            {/* Session 160 — the step called "Appearance" finally produces
                one. POST /api/generate/appearance has existed and worked
                since Session 102 (server/index.js:6581) and nothing ever
                called it; the fields it returns were declared in this file
                and never written. The fields, and the composer that turns
                them into the prose the simulator reads, are shared with the
                profile editor's Appearance panel — ../lib/appearance.js. */}
            <div style={{marginBottom:18}}>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:8}}>Appearance Description</div>
              <button
                onClick={analyseAppearance}
                disabled={!Object.keys(photos).length || generating==="appearance"}
                style={{...S.btnAmberFull, marginBottom:8, opacity:(!Object.keys(photos).length || generating==="appearance")?0.6:1}}>
                {generating==="appearance" ? "◈ Reading the photo…" : appearanceHasFields ? "◈ Re-read appearance from photos" : "◈ Read appearance from photos"}
              </button>
              {!Object.keys(photos).length && (
                <div style={{...S.hint, marginTop:0, marginBottom:14}}>Add a reference photo above first — this reads from the photos you upload.</div>
              )}

              <Field label="Text the worlds read" hint={appearanceAuto
                ? "Composed from the fields below. The first 150 characters are all another character is shown of this one across a table; encounters and the video prompt read the whole thing. Edit it directly to take it over."
                : "Yours — the fields below no longer rewrite it."}>
                <textarea style={{...S.textarea, minHeight:88}} value={identity.appearance} onChange={e=>setAppProse(e.target.value)}
                  placeholder="Read it from a photo above, or write it here." />
              </Field>
              {!appearanceAuto && appearanceHasFields && (
                <button onClick={()=>setAppFields({ ...appearanceFields, _auto:true })} style={{...S.btnAmber, marginBottom:14}}>Recompose from fields</button>
              )}

              <FoldableSection title="Appearance Fields" expanded={expandedSections.appearance} onToggle={()=>toggleSection("appearance")}>
                <div style={S.row2}>
                  {appSelect("Height","height")}
                  {appSelect("Build","build")}
                  {appSelect("Body shape","body_shape")}
                  {identity.gender==="female" && FEMALE_FRAME.map(k => appSelect(APP_LABELS[k], k))}
                  {identity.gender==="male"   && MALE_FRAME.map(k => appSelect(APP_LABELS[k], k))}
                  {appSelect("Presence","presence")}
                  {appSelect("Body confidence","body_confidence")}
                  {appSelect("Grooming","grooming")}
                </div>
                {!identity.gender && (
                  <div style={{...S.hint, marginTop:0, marginBottom:14}}>Set a gender above to get the rest of the frame.</div>
                )}
                {appText("Hair","hair")}
                {appText("Eyes","eyes")}
                {appText("Face","face")}
                {appText("Notable features","notable")}
                {appText("Dress style","style")}
                {appText("Tension markers","tension_markers")}
                {appText("Voice","voice")}
                {appText("Sexual presence","sexual_presence")}
                {appText("Endowment","endowment")}
              </FoldableSection>
            </div>


          </div>

          {/* Center column — 3D preview only. Locked after this step:
              face, body shape, and the underlying mesh can't be changed
              later without regenerating the character. */}
          <div style={{alignSelf:"stretch",display:"flex",flexDirection:"column",minWidth:0}}>
            {/* Preview viewport — placeholder for now. Will mount the real
                Three.js viewer (ActorModelPanel-derived) once it's confirmed
                to run inside a modal context. Fills whatever vertical space
                is actually available on the page now that this is a real
                route, not guessing another fixed pixel height. */}
            <div style={{position:"relative",borderRadius:14,overflow:"hidden",flex:1,minWidth:0,minHeight:400,background:"#141311",marginBottom:16}}>
              {character3DStatus==="ready" && glbUrl ? (
                <div ref={viewerHostRef} style={{position:"absolute",inset:0}} />
              ) : (
                <>
                  <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(220,211,190,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(220,211,190,0.08) 1px, transparent 1px)",backgroundSize:"36px 36px",maskImage:"radial-gradient(ellipse 70% 60% at 50% 55%, black 30%, transparent 75%)",WebkitMaskImage:"radial-gradient(ellipse 70% 60% at 50% 55%, black 30%, transparent 75%)"}} />
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                {character3DStatus==="idle" ? (
                  <div style={{textAlign:"center",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#8a8171",maxWidth:200}}>
                    Set gender and generate a face to see a preview
                  </div>
                ) : character3DStatus==="error" ? (
                  <div style={{textAlign:"center",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#c0392b",maxWidth:220}}>
                    {character3DError || "Something went wrong"}
                  </div>
                ) : null}
                  </div>
                </>
              )}
            </div>

            {/* Session 97: real animation switch controls — only shown
                once MiniGlbViewer actually reports real clips via
                onAnimationsLoaded. Older GLBs (generated before the
                merge fix) have zero animations, so this renders nothing
                for those rather than showing dead buttons. */}
            {availableAnimations.length > 0 && (
              <div style={{display:"flex",gap:8,marginBottom:16}}>
                {availableAnimations.map(name => (
                  <button
                    key={name}
                    onClick={() => setActiveAnimation(name)}
                    style={{
                      padding:"6px 14px", borderRadius:8, cursor:"pointer",
                      fontFamily:"'DM Sans',system-ui,sans-serif", fontSize:11, textTransform:"capitalize",
                      border: activeAnimation===name ? "1px solid #c9973a" : "1px solid rgba(0,0,0,0.1)",
                      color: activeAnimation===name ? "#c9973a" : "#a8a5a0",
                      background: "none",
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}

            {/* Portalled directly to document.body — bulletproof against
                whatever ancestor was constraining position:fixed (never
                found the exact culprit despite checking every file in
                this chain; a portal sidesteps the question entirely by
                removing the ancestor chain altogether). Layout now
                actually matches KnockingDoorScene's real pattern: ring
                around the reference photo, not a bare floating spinner,
                plus the same italic serif status text treatment. */}
            {(character3DStatus!=="idle" && character3DStatus!=="error") && (character3DStatus!=="ready" || glbClientLoading) && ReactDOM.createPortal(
              <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(255,255,255,0.82)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                {/* Session 103 — same spinner language as the psychology
                    overlay (light frost, gold ring, quiet label): one
                    loading identity across the wizard instead of the
                    black full-screen from an earlier design era. */}
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:16}}>
                  {photos.profile && (
                    <img src={URL.createObjectURL(photos.profile)} alt="" style={{width:100,height:100,borderRadius:"50%",objectFit:"cover",display:"block",border:"1.5px solid rgba(0,0,0,0.10)"}} />
                  )}
                  <div style={{ width:40, height:40, border:"3px solid rgba(0,0,0,0.08)", borderTop:"3px solid #c9973a", borderRadius:"50%", animation:"spin 0.9s linear infinite" }} />
                  <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,color:"#1a1814",margin:0,textAlign:"center"}}>
                    {/* Priority order matters here — character3DStatus can
                        sit frozen on "converting" for the ENTIRE idle/walk
                        loop (that loop only ever touches poseStage, per
                        the deliberate fix keeping stage==="ready" once
                        first reached from retriggering elsewhere), so the
                        late server stages and the final client-side GLB
                        load both need to be checked BEFORE falling back
                        to the early, character3DStatus-only labels. */}
                    {character3DStatus==="ready" && glbClientLoading ? "Downloading…" :
                     character3DStatus==="merging_animations" ? "Merging animations…" :
                     character3DStatus==="downloading" ? "Bringing the model home…" :
                     poseStage==="generating_idle" ? "Creating Idle Animation…" :
                     poseStage==="_idle_ready" ? "Idle animation ready…" :
                     poseStage==="generating_walk" ? "Creating Walking Animation…" :
                     poseStage==="_walk_ready" ? "Walk animation ready…" :
                     character3DStatus==="creating_actor" ? "Creating draft character…" :
                     character3DStatus==="queued" ? "Queued…" :
                     character3DStatus==="starting_daz_studio" ? "Starting a fresh DAZ Studio session…" :
                     character3DStatus==="recovering_daz_studio" ? "Recovering DAZ Studio, retrying…" :
                     character3DStatus==="uploading_photo" ? "Uploading reference photo…" :
                     character3DStatus==="uploading_body_photos" ? "Uploading body photos…" :
                     character3DStatus==="generating_face" ? "Generating face…" :
                     character3DStatus==="applying_body_shape" ? "Applying body shape…" :
                     character3DStatus==="selecting_node" ? "Preparing export…" :
                     character3DStatus==="exporting" ? "Exporting mesh & rig…" :
                     character3DStatus==="converting" ? "Converting to glTF…" : ""}
                  </p>
                </div>
              </div>,
              document.body
            )}

{/* Session 102 — the Dev: Load Actor Folder picker that lived here
                is REMOVED: the drafts system (sidebar + disk fallback +
                auto-persist) covers every workflow it existed for —
                resurrecting/inspecting pipeline output now goes through a
                draft row, which also exercises the real load path instead
                of a parallel blob one. debugFileInputRef and friends
                removed with it. */}
          </div>

          {/* Right column — Adjustments. A genuinely separate column
              from the viewer, not stacked underneath it.
              Structure matches the approved mockup, now foldable
              (Session 101+) — see FoldableSection's own comment for
              why. Real, live sliders: the four original body-shape
              morphs (Height/Torso/Arms/Legs Length), plus the Waist
              and Body Type groups below (all confirmed baked and
              driver-bypassed, generate3d.js's bakeAllMorphsAtDefault()).
              Head/Chest/Legs/Arms still carry their original disabled
              placeholders — no real morph or data backs those specific
              fields yet, kept visible so the structure is right and
              ready to enable field by field later, rather than
              guessing stop-lists or reinventing the layout now. */}
          {/* Real fix (Session 101+) — this column's own content has
              grown substantially (dozens of new sliders across several
              new sections) and, with no height constraint of its own,
              was dictating the WHOLE grid row's height — which the
              center viewer column then matched via its own alignSelf:
              "stretch" (confirmed directly: this column was the one
              growing, not the viewer growing independently). Capping
              this column's own height to the same viewport-relative
              value the grid itself targets, with its own scroll, keeps
              growth here from ever affecting the row height or the
              viewer's size again — matches the grid's minHeight value
              exactly so nothing shifts for the common case. */}
          <div style={{maxHeight:"calc(100vh - 260px)", overflowY:"auto", overflowX:"hidden", paddingRight:4}}>
            <div style={{display:"flex", gap:6, marginBottom:14}}>
              {[["adjustments","Adjustments"],["pose","Pose"]].map(([key,label])=>(
                <button key={key} onClick={()=>setAdjustTab(key)} style={{
                  flex:1, padding:"8px 4px", fontFamily:"'DM Mono',monospace", fontSize:11,
                  letterSpacing:"0.08em", textTransform:"uppercase",
                  border:"1px solid " + (adjustTab===key ? "#b05c08" : "rgba(199,180,140,0.25)"),
                  borderRadius:8, background: adjustTab===key ? "rgba(176,92,8,0.12)" : "transparent",
                  color: adjustTab===key ? "#b05c08" : "#6b6760", cursor:"pointer",
                }}>{label}</button>
              ))}
            </div>

            <button
              onClick={resetAllSliders}
              disabled={!glbReady}
              title="Set every body and pose slider back to zero"
              style={{width:"100%", padding:"6px 4px", marginBottom:14, fontFamily:"'DM Mono',monospace", fontSize:10,
                letterSpacing:"0.08em", textTransform:"uppercase", border:"1px solid rgba(199,180,140,0.25)",
                borderRadius:8, background:"transparent", color:"#6b6760", cursor:"pointer",
                opacity:(!glbReady)?0.5:1}}>
              ↺ Reset all sliders
            </button>

{adjustTab==="adjustments" && <>
            <div style={{display:"flex", gap:6, marginBottom:14}}>
              {[["fullBody","Full Body"],["head","Head"],["torso","Torso"],["legs","Legs / Hips"]].map(([key,label])=>(
                <button key={key} onClick={()=>setActiveBodyRegion(key)} style={{
                  flex:1, padding:"8px 4px", fontFamily:"'DM Mono',monospace", fontSize:11,
                  border:"1px solid " + (activeBodyRegion===key ? "#b05c08" : "rgba(199,180,140,0.25)"),
                  borderRadius:8, background: activeBodyRegion===key ? "rgba(176,92,8,0.12)" : "transparent",
                  color: activeBodyRegion===key ? "#b05c08" : "#6b6760", cursor:"pointer",
                }}>{label}</button>
              ))}
            </div>

            <button
              onClick={applyMeasuredProportions}
              disabled={!glbReady || !referenceMeasurements}
              title={referenceMeasurements ? "Solve body sliders from the reference-photo measurements" : "No measurements.json loaded for this character"}
              style={{...S.btnAmberFull, marginBottom:14, opacity:(!glbReady || !referenceMeasurements)?0.5:1}}>
              ◈ Apply measured proportions
            </button>

{activeBodyRegion==="fullBody" && <>
            <FoldableSection title="Body" expanded={expandedSections.body} onToggle={()=>toggleSection("body")}>
              <Slider label="Overall Height" value={bodyHeight} onChange={setBodyHeight} disabled={!glbReady} />
              <Slider label="Muscular Mass" value={extraMorphValues.bodyMuscularMass} onChange={v=>setExtraMorph("bodyMuscularMass", v)} disabled={!glbReady} />
              <Slider label="Mass" value={extraMorphValues.massBody} onChange={v=>setExtraMorph("massBody", v)} disabled={!glbReady} />
              <Slider label="Larger" value={extraMorphValues.proportionLarger} onChange={v=>setExtraMorph("proportionLarger", v)} disabled={!glbReady} />
              <Slider label="Smaller" value={extraMorphValues.proportionSmaller} onChange={v=>setExtraMorph("proportionSmaller", v)} disabled={!glbReady} />
              <Slider label="Smaller (BO)" value={extraMorphValues.proportionSmallerBO} onChange={v=>setExtraMorph("proportionSmallerBO", v)} disabled={!glbReady} />
            </FoldableSection>

            <FoldableSection title="Body Type" expanded={expandedSections.bodyType} onToggle={()=>toggleSection("bodyType")}>
              <Slider label="Heavy" value={extraMorphValues.bodyHeavy} onChange={v=>setExtraMorph("bodyHeavy", v)} disabled={!glbReady} />
              <Slider label="Thin" value={extraMorphValues.bodyThin} onChange={v=>setExtraMorph("bodyThin", v)} disabled={!glbReady} />
              <Slider label="Emaciated" value={extraMorphValues.bodyEmaciated} onChange={v=>setExtraMorph("bodyEmaciated", v)} disabled={!glbReady} />
              <Slider label="Lithe" value={extraMorphValues.bodyLithe} onChange={v=>setExtraMorph("bodyLithe", v)} disabled={!glbReady} />
              <Slider label="Fitness Mass" value={extraMorphValues.bodyFitnessMass} onChange={v=>setExtraMorph("bodyFitnessMass", v)} disabled={!glbReady} />
              <Slider label="Tone" value={extraMorphValues.bodyTone} onChange={v=>setExtraMorph("bodyTone", v)} disabled={!glbReady} />
              <Slider label="Fitness Details" value={extraMorphValues.bodyFitnessDetails} onChange={v=>setExtraMorph("bodyFitnessDetails", v)} disabled={!glbReady} />
              <Slider label="Muscular Details" value={extraMorphValues.bodyMuscularDetails} onChange={v=>setExtraMorph("bodyMuscularDetails", v)} disabled={!glbReady} />
              <Slider label="Older" value={extraMorphValues.bodyOlder} onChange={v=>setExtraMorph("bodyOlder", v)} disabled={!glbReady} />
            </FoldableSection>

</>}

{activeBodyRegion==="head" && <>
            <FoldableSection title="Head" expanded={expandedSections.head} onToggle={()=>toggleSection("head")}>
              <Slider label="Eyes" value={0} disabled />
              <Slider label="Face" value={0} disabled />
              <Slider label="Head Size" value={extraMorphValues.headSize} onChange={v=>setExtraMorph("headSize", v)} disabled={!glbReady} />
              <Slider label="Neck Length" value={extraMorphValues.proportionNeckLength} onChange={v=>setExtraMorph("proportionNeckLength", v)} disabled={!glbReady} />
              <Slider label="Neck Mass" value={extraMorphValues.massNeck} onChange={v=>setExtraMorph("massNeck", v)} disabled={!glbReady} />
              <Slider label="Taper Neck A" value={extraMorphValues.taperNeckA} onChange={v=>setExtraMorph("taperNeckA", v)} disabled={!glbReady} />
              <Slider label="Taper Neck B" value={extraMorphValues.taperNeckB} onChange={v=>setExtraMorph("taperNeckB", v)} disabled={!glbReady} />
            </FoldableSection>

</>}

{activeBodyRegion==="torso" && <>
            <FoldableSection title="Breasts" expanded={expandedSections.breasts} onToggle={()=>toggleSection("breasts")}>
              <Slider label="Small" value={extraMorphValues.breastsSmall} onChange={v=>setExtraMorph("breastsSmall", v)} disabled={!glbReady} />
              <Slider label="Large" value={extraMorphValues.breastsLarge} onChange={v=>setExtraMorph("breastsLarge", v)} disabled={!glbReady} />
              <Slider label="Gone" value={extraMorphValues.breastsGone} onChange={v=>setExtraMorph("breastsGone", v)} disabled={!glbReady} />
              <Slider label="Natural" value={extraMorphValues.breastsNatural} onChange={v=>setExtraMorph("breastsNatural", v)} disabled={!glbReady} />
              <Slider label="Heavy" value={extraMorphValues.breastsHeavy} onChange={v=>setExtraMorph("breastsHeavy", v)} disabled={!glbReady} />
              <Slider label="Diameter" value={extraMorphValues.breastsDiameter} onChange={v=>setExtraMorph("breastsDiameter", v)} disabled={!glbReady} />
              <Slider label="Fullness (Upper)" value={extraMorphValues.breastsFullnessUpper} onChange={v=>setExtraMorph("breastsFullnessUpper", v)} disabled={!glbReady} />
              <Slider label="Fullness (Lower)" value={extraMorphValues.breastsFullnessLower} onChange={v=>setExtraMorph("breastsFullnessLower", v)} disabled={!glbReady} />
              <Slider label="Sides Depth" value={extraMorphValues.breastsSidesDepth} onChange={v=>setExtraMorph("breastsSidesDepth", v)} disabled={!glbReady} />
              <Slider label="Cleavage" value={extraMorphValues.breastsCleavage} onChange={v=>setExtraMorph("breastsCleavage", v)} disabled={!glbReady} />
              <Slider label="Perk / Side" value={extraMorphValues.breastsPerkSide} onChange={v=>setExtraMorph("breastsPerkSide", v)} disabled={!glbReady} />
              <Slider label="Downward Slope" value={extraMorphValues.breastsDownwardSlope} onChange={v=>setExtraMorph("breastsDownwardSlope", v)} disabled={!glbReady} />
              <Slider label="Large / High" value={extraMorphValues.breastsLargeHigh} onChange={v=>setExtraMorph("breastsLargeHigh", v)} disabled={!glbReady} />
              <Slider label="Shape 1" value={extraMorphValues.breastsShape01} onChange={v=>setExtraMorph("breastsShape01", v)} disabled={!glbReady} />
              <Slider label="Shape 2" value={extraMorphValues.breastsShape02} onChange={v=>setExtraMorph("breastsShape02", v)} disabled={!glbReady} />
              <Slider label="Shape 3" value={extraMorphValues.breastsShape03} onChange={v=>setExtraMorph("breastsShape03", v)} disabled={!glbReady} />
              <Slider label="Shape 4" value={extraMorphValues.breastsShape04} onChange={v=>setExtraMorph("breastsShape04", v)} disabled={!glbReady} />
              <Slider label="Shape 5" value={extraMorphValues.breastsShape05} onChange={v=>setExtraMorph("breastsShape05", v)} disabled={!glbReady} />
              <Slider label="Shape 6" value={extraMorphValues.breastsShape06} onChange={v=>setExtraMorph("breastsShape06", v)} disabled={!glbReady} />
            </FoldableSection>

            <FoldableSection title="Waist" expanded={expandedSections.waist} onToggle={()=>toggleSection("waist")}>
              <Slider label="Torso Length" value={bodyTorsoLength} onChange={setBodyTorsoLength} disabled={!glbReady} />
              <Slider label="Waist Width" value={extraMorphValues.waistWidth} onChange={v=>setExtraMorph("waistWidth", v)} disabled={!glbReady} />
              <Slider label="Waist Depth" value={extraMorphValues.waistDepth} onChange={v=>setExtraMorph("waistDepth", v)} disabled={!glbReady} />
              <Slider label="Waist Width (Upper)" value={extraMorphValues.waistWidthUpper} onChange={v=>setExtraMorph("waistWidthUpper", v)} disabled={!glbReady} />
              <Slider label="Hip Size" value={extraMorphValues.hipSize} onChange={v=>setExtraMorph("hipSize", v)} disabled={!glbReady} />
              <Slider label="Lower Torso Mass" value={extraMorphValues.massLowerTorso} onChange={v=>setExtraMorph("massLowerTorso", v)} disabled={!glbReady} />
              <Slider label="Upper Torso Mass" value={extraMorphValues.massUpperTorso} onChange={v=>setExtraMorph("massUpperTorso", v)} disabled={!glbReady} />
              <Slider label="Love Handles" value={extraMorphValues.loveHandles} onChange={v=>setExtraMorph("loveHandles", v)} disabled={!glbReady} />
              <Slider label="Stomach Depth" value={extraMorphValues.stomachDepth} onChange={v=>setExtraMorph("stomachDepth", v)} disabled={!glbReady} />
              <Slider label="Stomach Depth (Lower)" value={extraMorphValues.stomachDepthLower} onChange={v=>setExtraMorph("stomachDepthLower", v)} disabled={!glbReady} />
              <Slider label="Stomach Soften" value={extraMorphValues.stomachSoften} onChange={v=>setExtraMorph("stomachSoften", v)} disabled={!glbReady} />
              <Slider label="Abs Center Define" value={extraMorphValues.abdominalsCenterDefine} onChange={v=>setExtraMorph("abdominalsCenterDefine", v)} disabled={!glbReady} />
              <Slider label="Abs Outer Define" value={extraMorphValues.abdominalsOuterDefine} onChange={v=>setExtraMorph("abdominalsOuterDefine", v)} disabled={!glbReady} />
              <Slider label="Abs Width" value={extraMorphValues.abdominalsWidth} onChange={v=>setExtraMorph("abdominalsWidth", v)} disabled={!glbReady} />
              <Slider label="Navel Depth" value={extraMorphValues.navelDepth} onChange={v=>setExtraMorph("navelDepth", v)} disabled={!glbReady} />
              <Slider label="Navel Hollow" value={extraMorphValues.navelHollow} onChange={v=>setExtraMorph("navelHollow", v)} disabled={!glbReady} />
              <Slider label="Navel Horizontal" value={extraMorphValues.navelHorizontal} onChange={v=>setExtraMorph("navelHorizontal", v)} disabled={!glbReady} />
              <Slider label="Navel Out" value={extraMorphValues.navelOut} onChange={v=>setExtraMorph("navelOut", v)} disabled={!glbReady} />
              <Slider label="Navel Size" value={extraMorphValues.navelSize} onChange={v=>setExtraMorph("navelSize", v)} disabled={!glbReady} />
              <Slider label="Navel Vertical" value={extraMorphValues.navelVertical} onChange={v=>setExtraMorph("navelVertical", v)} disabled={!glbReady} />
            </FoldableSection>

            <FoldableSection title="Torso Detail" expanded={expandedSections.torsoDetail} onToggle={()=>toggleSection("torsoDetail")}>
                            <Slider label="Chest Size" value={extraMorphValues.chestSize} onChange={v=>setExtraMorph("chestSize", v)} disabled={!glbReady} />
                            <Slider label="Chest Depth" value={extraMorphValues.proportionChestDepth} onChange={v=>setExtraMorph("proportionChestDepth", v)} disabled={!glbReady} />
              <Slider label="Chest Width" value={extraMorphValues.proportionChestWidth} onChange={v=>setExtraMorph("proportionChestWidth", v)} disabled={!glbReady} />
              <Slider label="Shoulder Width" value={extraMorphValues.proportionShoulderWidth} onChange={v=>setExtraMorph("proportionShoulderWidth", v)} disabled={!glbReady} />
<Slider label="Ribcage Arched" value={extraMorphValues.ribcageArched} onChange={v=>setExtraMorph("ribcageArched", v)} disabled={!glbReady} />
              <Slider label="Ribcage Pointed" value={extraMorphValues.ribcagePointed} onChange={v=>setExtraMorph("ribcagePointed", v)} disabled={!glbReady} />
              <Slider label="Ribcage Size" value={extraMorphValues.ribcageSize} onChange={v=>setExtraMorph("ribcageSize", v)} disabled={!glbReady} />
              <Slider label="Scapula Depth" value={extraMorphValues.scapulaDepth} onChange={v=>setExtraMorph("scapulaDepth", v)} disabled={!glbReady} />
              <Slider label="Scapula Size" value={extraMorphValues.scapulaSize} onChange={v=>setExtraMorph("scapulaSize", v)} disabled={!glbReady} />
              <Slider label="Sternum Depth" value={extraMorphValues.sternumDepth} onChange={v=>setExtraMorph("sternumDepth", v)} disabled={!glbReady} />
              <Slider label="Sternum Height" value={extraMorphValues.sternumHeight} onChange={v=>setExtraMorph("sternumHeight", v)} disabled={!glbReady} />
              <Slider label="Sternum Width" value={extraMorphValues.sternumWidth} onChange={v=>setExtraMorph("sternumWidth", v)} disabled={!glbReady} />
              <Slider label="Collarbone Detail" value={extraMorphValues.collarboneDetail} onChange={v=>setExtraMorph("collarboneDetail", v)} disabled={!glbReady} />
              <Slider label="Lats Size" value={extraMorphValues.latsSize} onChange={v=>setExtraMorph("latsSize", v)} disabled={!glbReady} />
              <Slider label="Traps Size" value={extraMorphValues.trapsSize} onChange={v=>setExtraMorph("trapsSize", v)} disabled={!glbReady} />
            </FoldableSection>

            <FoldableSection title="Arms" expanded={expandedSections.arms} onToggle={()=>toggleSection("arms")}>
              <Slider label="Arms Length" value={bodyArmsLength} onChange={setBodyArmsLength} disabled={!glbReady} />
                            <Slider label="Fingers Length" value={extraMorphValues.proportionFingersLength} onChange={v=>setExtraMorph("proportionFingersLength", v)} disabled={!glbReady} />
<Slider label="Upper Arms Mass" value={extraMorphValues.massUpperArms} onChange={v=>setExtraMorph("massUpperArms", v)} disabled={!glbReady} />
              <Slider label="Mass (Forearms)" value={extraMorphValues.massForearms} onChange={v=>setExtraMorph("massForearms", v)} disabled={!glbReady} />
              <Slider label="Mass (Hands)" value={extraMorphValues.massHands} onChange={v=>setExtraMorph("massHands", v)} disabled={!glbReady} />
              <Slider label="Mass (Shoulders)" value={extraMorphValues.massShoulders} onChange={v=>setExtraMorph("massShoulders", v)} disabled={!glbReady} />
              <Slider label="Mass (Wrist)" value={extraMorphValues.massWrist} onChange={v=>setExtraMorph("massWrist", v)} disabled={!glbReady} />
              <Slider label="Taper Upper Arm A" value={extraMorphValues.taperUpperArmA} onChange={v=>setExtraMorph("taperUpperArmA", v)} disabled={!glbReady} />
              <Slider label="Taper Upper Arm B" value={extraMorphValues.taperUpperArmB} onChange={v=>setExtraMorph("taperUpperArmB", v)} disabled={!glbReady} />
              <Slider label="Taper Forearm A" value={extraMorphValues.taperForearmA} onChange={v=>setExtraMorph("taperForearmA", v)} disabled={!glbReady} />
              <Slider label="Taper Forearm B" value={extraMorphValues.taperForearmB} onChange={v=>setExtraMorph("taperForearmB", v)} disabled={!glbReady} />
              <Slider label="Upper Arm Taper Width" value={extraMorphValues.upperArmTaperWidth} onChange={v=>setExtraMorph("upperArmTaperWidth", v)} disabled={!glbReady} />
              <Slider label="Fingers Width" value={extraMorphValues.fingersWidth} onChange={v=>setExtraMorph("fingersWidth", v)} disabled={!glbReady} />
              <Slider label="Hand Size" value={extraMorphValues.handSize} onChange={v=>setExtraMorph("handSize", v)} disabled={!glbReady} />
            </FoldableSection>

</>}

{activeBodyRegion==="legs" && <>
            <FoldableSection title="Hips / Glutes" expanded={expandedSections.hipsGlutes} onToggle={()=>toggleSection("hipsGlutes")}>
              <Slider label="Crease" value={extraMorphValues.gluteCrease} onChange={v=>setExtraMorph("gluteCrease", v)} disabled={!glbReady} />
              <Slider label="Depth (Lower)" value={extraMorphValues.gluteDepthLower} onChange={v=>setExtraMorph("gluteDepthLower", v)} disabled={!glbReady} />
              <Slider label="Depth (Upper)" value={extraMorphValues.gluteDepthUpper} onChange={v=>setExtraMorph("gluteDepthUpper", v)} disabled={!glbReady} />
              <Slider label="Size" value={extraMorphValues.gluteSize} onChange={v=>setExtraMorph("gluteSize", v)} disabled={!glbReady} />
              <Slider label="Width" value={extraMorphValues.gluteWidth} onChange={v=>setExtraMorph("gluteWidth", v)} disabled={!glbReady} />
              <Slider label="Back Dimples" value={extraMorphValues.hipBackDimples} onChange={v=>setExtraMorph("hipBackDimples", v)} disabled={!glbReady} />
              <Slider label="Bone Crest" value={extraMorphValues.hipBoneCrest} onChange={v=>setExtraMorph("hipBoneCrest", v)} disabled={!glbReady} />
              <Slider label="Bone Size" value={extraMorphValues.hipBoneSize} onChange={v=>setExtraMorph("hipBoneSize", v)} disabled={!glbReady} />
              <Slider label="Genital Bulge" value={extraMorphValues.hipGenitalBulge} onChange={v=>setExtraMorph("hipGenitalBulge", v)} disabled={!glbReady} />
              <Slider label="Pelvic Tilt" value={extraMorphValues.hipPelvicTilt} onChange={v=>setExtraMorph("hipPelvicTilt", v)} disabled={!glbReady} />
              <Slider label="V-Define" value={extraMorphValues.hipVDefine} onChange={v=>setExtraMorph("hipVDefine", v)} disabled={!glbReady} />
            </FoldableSection>

            <FoldableSection title="Legs" expanded={expandedSections.legs} onToggle={()=>toggleSection("legs")}>
              <Slider label="Legs Length" value={bodyLegsLength} onChange={setBodyLegsLength} disabled={!glbReady} />
              <Slider label="Legs" value={0} disabled />
                            <Slider label="Foot Length" value={extraMorphValues.proportionFootLength} onChange={v=>setExtraMorph("proportionFootLength", v)} disabled={!glbReady} />
              <Slider label="Toes Length" value={extraMorphValues.proportionToesLength} onChange={v=>setExtraMorph("proportionToesLength", v)} disabled={!glbReady} />
<Slider label="Thigh Depth" value={extraMorphValues.thighDepth} onChange={v=>setExtraMorph("thighDepth", v)} disabled={!glbReady} />
              <Slider label="Thigh Tone" value={extraMorphValues.thighTone} onChange={v=>setExtraMorph("thighTone", v)} disabled={!glbReady} />
              <Slider label="Calves Size" value={extraMorphValues.calvesSize} onChange={v=>setExtraMorph("calvesSize", v)} disabled={!glbReady} />
              <Slider label="Knee Bones Size" value={extraMorphValues.kneeBonesSize} onChange={v=>setExtraMorph("kneeBonesSize", v)} disabled={!glbReady} />
              <Slider label="Taper Thigh A" value={extraMorphValues.taperThighA} onChange={v=>setExtraMorph("taperThighA", v)} disabled={!glbReady} />
              <Slider label="Taper Thigh B" value={extraMorphValues.taperThighB} onChange={v=>setExtraMorph("taperThighB", v)} disabled={!glbReady} />
              <Slider label="Taper Shin A" value={extraMorphValues.taperShinA} onChange={v=>setExtraMorph("taperShinA", v)} disabled={!glbReady} />
              <Slider label="Taper Shin B" value={extraMorphValues.taperShinB} onChange={v=>setExtraMorph("taperShinB", v)} disabled={!glbReady} />
              <Slider label="Mass (Ankles)" value={extraMorphValues.massAnkles} onChange={v=>setExtraMorph("massAnkles", v)} disabled={!glbReady} />
              <Slider label="Mass (Feet)" value={extraMorphValues.massFeet} onChange={v=>setExtraMorph("massFeet", v)} disabled={!glbReady} />
              <Slider label="Mass (Knees)" value={extraMorphValues.massKnees} onChange={v=>setExtraMorph("massKnees", v)} disabled={!glbReady} />
              <Slider label="Mass (Shins)" value={extraMorphValues.massShins} onChange={v=>setExtraMorph("massShins", v)} disabled={!glbReady} />
              <Slider label="Mass (Thighs)" value={extraMorphValues.massThighs} onChange={v=>setExtraMorph("massThighs", v)} disabled={!glbReady} />
              <Slider label="Foot Arch Depth" value={extraMorphValues.footArchDepth} onChange={v=>setExtraMorph("footArchDepth", v)} disabled={!glbReady} />
              <Slider label="Foot Size" value={extraMorphValues.footSize} onChange={v=>setExtraMorph("footSize", v)} disabled={!glbReady} />
            </FoldableSection>

</>}
</>}

{adjustTab==="pose" && <>
            {POSE_CATEGORIES.map(([catKey, catLabel]) => {
              const dials = POSE_SLIDERS.filter(p => p.category === catKey);
              return (
                <FoldableSection key={catKey} title={catLabel} expanded={expandedSections[catKey]} onToggle={()=>toggleSection(catKey)}>
                  {dials.length === 0
                    ? <div style={{fontFamily:"'DM Mono',monospace", fontSize:10, color:"#a8a5a0", padding:"2px 0 8px"}}>No pose dials wired yet</div>
                    : dials.map(p => <Slider key={p.key} label={p.label} value={poseValues[p.key] || 0} onChange={v=>setPoseValue(p.key, v)} disabled={!glbReady} />)}
                </FoldableSection>
              );
            })}
</>}
          </div>
          </div>}

          {/* STEP 2: ACCESSORIES — wide two-column layout (viewport +
              tree), like Appearance, not the narrow text-field steps
              below, so this sits outside that wrapper too. */}
          {step===2&&<div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 320px",gap:28,alignItems:"start",minHeight:"calc(100vh - 260px)",maxWidth:1440,margin:"0 auto",width:"100%"}}>
            <div style={{position:"relative",borderRadius:14,overflow:"hidden",minHeight:700,background:"#141311"}}>
              {glbUrl ? (
                <div ref={viewerHostRef} style={{position:"absolute",inset:0}} />
              ) : (
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:14,fontStyle:"italic",color:"rgba(255,255,255,0.4)"}}>
                  Character preview unavailable
                </div>
              )}
            </div>
            <div>
              {/* Session 108→109 — picker UI extracted to the shared
                  AccessoryEditor component (see ./AccessoryEditor.jsx).
                  Every value/setter below is state this component still
                  owns; AccessoryEditor is purely the shared UI + shared
                  occlusion/override rules. ActorModelPanel's Wardrobe
                  panel renders the same component against its own
                  actor-linked state. */}
              <AccessoryEditor
                accessories={accessories} setAccessories={setAccessories}
                dynamicAccessoryOptions={dynamicAccessoryOptions}
                selectedAccessoryGlbUrls={selectedAccessoryGlbUrls} setSelectedAccessoryGlbUrls={setSelectedAccessoryGlbUrls}
                accessoryScales={accessoryScales} setAccessoryScales={setAccessoryScales}
                accessoryOffsets={accessoryOffsets} setAccessoryOffsets={setAccessoryOffsets}
                accessoryRotations={accessoryRotations} setAccessoryRotations={setAccessoryRotations}
                accessoryParts={accessoryParts} setAccessoryParts={setAccessoryParts}
                accessoryTints={accessoryTints} setAccessoryTints={setAccessoryTints}
                accessoryPartNames={accessoryPartNames}
                activeSlot={activeSlot} setActiveSlot={setActiveSlot}
                scaleDetailSlot={scaleDetailSlot} setScaleDetailSlot={setScaleDetailSlot}
                activePart={activePart} setActivePart={setActivePart}
                activeAccessoryRegion={activeAccessoryRegion} setActiveAccessoryRegion={setActiveAccessoryRegion}
              />
            </div>
          </div>}

          {/* Steps 3-7 stay narrow and centered — unlike Appearance and
              Accessories, these are single-column text fields, and
              stretching them across a full-width page just makes long,
              sparse input boxes hard to read. */}
          {step!==1 && step!==2 &&<div style={{maxWidth:680,margin:"0 auto"}}>

          {/* STEP 3: PSYCHOLOGY */}
          {step===3&&<>
            <button style={S.btnAmberFull} onClick={generateFullPsychology} disabled={!!generating}>
              {generating==="all"?"◈ Generating…":"◈ Generate Full Psychology Profile"}
            </button>
            <Field label="Marital Status">
              <select style={S.select} value={psychology.marital_status} onChange={e=>updP("marital_status",e.target.value)}>
                <option value="single">Single</option>
                <option value="casually_dating">Casually dating</option>
                <option value="in_relationship">In a relationship</option>
                <option value="married">Married</option>
                <option value="separated">Separated</option>
                <option value="divorced">Divorced</option>
                <option value="widowed">Widowed</option>
              </select>
            </Field>
            <div style={S.sf}>
              <label style={{...S.label,margin:0,marginBottom:7,display:"block"}}>Identity Certainty</label>
              <div style={S.sliderRow}>
                <span style={S.sliderLbl}>Certainty</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round((psychology.identity_certainty ?? 0.5) * 100)}
                  onChange={e=>updP("identity_certainty", Number(e.target.value)/100)}
                  style={{flex:1,accentColor:"#b05c08",height:4,cursor:"pointer"}}
                />
                <span style={{...S.sliderVal,width:36}}>{Math.round((psychology.identity_certainty ?? 0.5) * 100)}%</span>
              </div>
            </div>
            {psychFields.map(f=>(
              <div key={f.key} style={S.sf}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
                  <label style={{...S.label,margin:0}}>{f.label}</label>
                  <button style={S.btnAmber} onClick={()=>inspireField(f.key,f.label)} disabled={!!generating}>
                    {generating===f.key?"…":"✦ Inspire Me"}
                  </button>
                </div>
                <AutoTextarea style={{...S.textarea,minHeight:f.rows===3?80:60}} value={psychology[f.key]} onChange={e=>updP(f.key,e.target.value)} placeholder={f.ph} />
              </div>
            ))}
          </>}

          {/* STEP 4: PERSONALITY */}
          {step===4&&<>
            <button style={S.btnAmberFull} onClick={()=>runAssessment("all")} disabled={!!assessRunning}>
              {assessRunning==="all"?"◈ Running All Assessments…":"◈ Run All Assessments"}
            </button>
            {[
              {key:"iwm",        n:1, label:"Internal Working Model",    desc:"Mental representations of relationships and self",                   req:null},
              {key:"attachment", n:2, label:"Attachment Style",           desc:"Derived from IWM",                                                  req:"iwm"},
              {key:"intimacy",   n:3, label:"Intimacy & Coping",          desc:"How they handle closeness and stress",                              req:"attachment"},
              {key:"cogstyle",   n:4, label:"Cognitive & Decision Style", desc:"How they process and decide",                                       req:"intimacy"},
            ].map(a=>{
              const prereqMet = !a.req || !!assessments[a.req] || (a.req==="attachment" && !!personality.attachment_style);
              const done = !!assessments[a.key] || (a.key==="attachment" && !!personality.attachment_style);
              return (
              <div key={a.key}>
                <div style={S.assessRow}>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:done?"#c9973a":"#c8c5c0"}}>{a.n} ·</span>
                      <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:prereqMet?"#1a1814":"#c8c5c0"}}>{a.label}</span>
                      {a.key==="attachment"&&personality.attachment_style&&
                        <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#b05c08",fontStyle:"italic"}}>{personality.attachment_style}</span>
                      }
                      {done&&<span style={{fontSize:11,color:"#c9973a"}}>✓</span>}
                    </div>
                    <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginTop:2}}>
                      {!prereqMet ? `⟶ Run ${a.req?.toUpperCase()} first` : a.desc}
                    </div>
                  </div>
                  <button style={{...S.btnAmber,marginTop:0,opacity:prereqMet?1:0.35,cursor:prereqMet?"pointer":"not-allowed"}}
                    onClick={()=>prereqMet&&runAssessment(a.key)}
                    disabled={!!assessRunning||!prereqMet}>
                    {assessRunning===a.key?"…":done?"↺ Re-run":"▶ Run"}
                  </button>
                </div>
                {assessments[a.key]&&(
                  <div style={{...S.assessResult,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                    <span>{assessments[a.key]}</span>
                    {assessmentResults[a.key]&&(
                      <button style={{...S.btnAmber,padding:"3px 10px",fontSize:10,marginTop:0,flexShrink:0}} onClick={()=>setViewingAssessment(a.key)}>
                        View answers ({assessmentResults[a.key].answers?.length||0}) →
                      </button>
                    )}
                  </div>
                )}
              </div>
            );})}

            <div style={{...S.secLabel,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{color:assessments.cogstyle?"#1a1814":"#c8c5c0"}}>Big Five (44 items){assessments.cogstyle?"":" ⟶ Run Cognitive Style first"}</span>
              <button style={{...S.btnAmber,padding:"4px 12px",fontSize:10,opacity:assessments.cogstyle?1:0.35}} onClick={()=>assessments.cogstyle&&runAssessment("big5")} disabled={!!assessRunning||!assessments.cogstyle}>{assessRunning==="big5"?"…":(personality.big5.openness!==50||personality.big5.neuroticism!==50)?"↺ Re-run":"▶ Run"}</button>
            </div>
            {Object.entries(personality.big5).map(([k,v])=>(
              <Slider key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={v} onChange={val=>setPersonality(p=>({...p,big5:{...p.big5,[k]:val}}))} />
            ))}
            {assessmentResults.big5?.answers?.length>0&&(
              <div style={{...S.assessResult,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:4}}>
                <span>{assessmentResults.big5.interpretation}</span>
                <button style={{...S.btnAmber,padding:"3px 10px",fontSize:10,marginTop:0,flexShrink:0}} onClick={()=>setViewingAssessment("big5")}>View answers ({assessmentResults.big5.answers?.length||0}) →</button>
              </div>
            )}
            <div style={{...S.secLabel,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{color:(personality.big5.openness!==50||personality.big5.neuroticism!==50)?"#1a1814":"#c8c5c0"}}>DISC</span>
              <button style={{...S.btnAmber,padding:"4px 12px",fontSize:10,opacity:(personality.big5.openness!==50||personality.big5.neuroticism!==50)?1:0.35}} onClick={()=>(personality.big5.openness!==50||personality.big5.neuroticism!==50)&&runAssessment("disc")} disabled={!!assessRunning||(personality.big5.openness===50&&personality.big5.neuroticism===50)}>{assessRunning==="disc"?"…":(personality.disc.d!==50||personality.disc.i!==50)?"↺ Re-run":"▶ Run"}</button>
            </div>
            {[["d","Dominance"],["i","Influence"],["s","Steadiness"],["c","Conscientiousness"]].map(([k,l])=>(
              <Slider key={k} label={l} value={personality.disc[k]} onChange={val=>setPersonality(p=>({...p,disc:{...p.disc,[k]:val}}))} />
            ))}
            {assessmentResults.disc&&(
              <div style={{...S.assessResult,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:4}}>
                <span>{assessmentResults.disc.interpretation}</span>
                <button style={{...S.btnAmber,padding:"3px 10px",fontSize:10,marginTop:0,flexShrink:0}} onClick={()=>setViewingAssessment("disc")}>View answers ({assessmentResults.disc.answers?.length||0}) →</button>
              </div>
            )}
            <div style={{...S.secLabel,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{color:(personality.disc.d!==50||personality.disc.i!==50)?"#1a1814":"#c8c5c0"}}>
                HDS — Dark Side (154 items){!(personality.disc.d!==50||personality.disc.i!==50)&&" ⟶ Run DISC first"}
              </span>
              <button style={{...S.btnAmber,padding:"4px 12px",fontSize:10,opacity:(personality.disc.d!==50||personality.disc.i!==50)?1:0.35}}
                onClick={()=>(personality.disc.d!==50||personality.disc.i!==50)&&runAssessment("hds")}
                disabled={!!assessRunning||(personality.disc.d===50&&personality.disc.i===50)}>
                {assessRunning&&assessRunning.startsWith("hds:")
                  ? `…${assessRunning.split(":")[1]}…`
                  : (personality.hds.bold!==30||personality.hds.cautious!==30)?"↺ Re-run":"▶ Run"}
              </button>
            </div>
            {assessmentResults.hds&&(
              <div style={{...S.assessResult,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12}}>
                <span>{assessmentResults.hds.interpretation}</span>
                <button style={{...S.btnAmber,padding:"3px 10px",fontSize:10,marginTop:0,flexShrink:0}} onClick={()=>setViewingAssessment("hds")}>
                  View answers ({assessmentResults.hds.answers?.length||0}) →
                </button>
              </div>
            )}
            {Object.entries(personality.hds).map(([k,v])=>(
              <Slider key={k} label={k.charAt(0).toUpperCase()+k.slice(1)} value={v} onChange={val=>setPersonality(p=>({...p,hds:{...p.hds,[k]:val}}))} />
            ))}
          </>}

          {/* STEP 5: LIFESTYLE */}
          {step===5&&<>
            <button style={S.btnAmberFull} onClick={generateLifestyle} disabled={!!generating}>
              {generating==="lifestyle"?"◈ Generating…":"◈ Generate Lifestyle Profile"}
            </button>
            <div style={S.secLabel}>Substances</div>
            <div style={S.row2}>
              <Field label="Alcohol">
                <select style={S.select} value={lifestyle.alcohol_relationship} onChange={e=>updL("alcohol_relationship",e.target.value)}>
                  <option value="non_drinker">Non-drinker</option>
                  <option value="rare">Rare / social only</option>
                  <option value="moderate">Moderate</option>
                  <option value="regular">Regular</option>
                  <option value="heavy">Heavy</option>
                </select>
              </Field>
              <Field label="Drug Use">
                <select style={S.select} value={lifestyle.drug_use} onChange={e=>updL("drug_use",e.target.value)}>
                  <option value="none">None</option>
                  <option value="cannabis_occasional">Cannabis — occasional</option>
                  <option value="cannabis_regular">Cannabis — regular</option>
                  <option value="mdma_occasional">MDMA — occasional</option>
                  <option value="cannabis_mdma">Cannabis + MDMA</option>
                  <option value="cocaine_occasional">Cocaine — occasional</option>
                  <option value="mixed_recreational">Mixed recreational</option>
                  <option value="prescription_only">Prescription only</option>
                </select>
              </Field>
            </div>
            <Field label="Substance Context">
              <AutoTextarea style={{...S.textarea,minHeight:44}} value={lifestyle.substance_context} onChange={e=>updL("substance_context",e.target.value)} placeholder="e.g. drinks at industry events, smokes to unwind…" />
            </Field>
            <div style={S.secLabel}>Sleep</div>
            <div style={S.row2}>
              <Field label="Pattern">
                <select style={S.select} value={lifestyle.sleep_pattern} onChange={e=>updL("sleep_pattern",e.target.value)}>
                  <option value="early_riser">Early riser (6–7am)</option>
                  <option value="normal">Normal (7–9am)</option>
                  <option value="night_owl">Night owl (10am+)</option>
                  <option value="irregular">Irregular</option>
                </select>
              </Field>
              <Field label="Quality">
                <select style={S.select} value={lifestyle.sleep_quality} onChange={e=>updL("sleep_quality",e.target.value)}>
                  <option value="good">Good — rests well</option>
                  <option value="variable">Variable</option>
                  <option value="poor">Poor — insomnia / anxiety</option>
                </select>
              </Field>
            </div>
            <div style={S.secLabel}>Fitness & Social</div>
            <div style={S.row2}>
              <Field label="Exercise Habit">
                <select style={S.select} value={lifestyle.exercise_habit} onChange={e=>updL("exercise_habit",e.target.value)}>
                  <option value="sedentary">Sedentary</option>
                  <option value="occasional">Occasional</option>
                  <option value="regular">Regular</option>
                  <option value="athlete">Athlete</option>
                </select>
              </Field>
              <Field label="Social Frequency">
                <select style={S.select} value={lifestyle.social_frequency} onChange={e=>updL("social_frequency",e.target.value)}>
                  <option value="rarely">Rarely</option>
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                  <option value="daily">Daily</option>
                </select>
              </Field>
            </div>
            <div style={S.row2}>
              <Field label="Exercise Type"><AutoTextarea style={{...S.textarea,minHeight:44}} value={lifestyle.exercise_type} onChange={e=>updL("exercise_type",e.target.value)} placeholder="Running, yoga, gym…" /></Field>
              <Field label="Diet"><AutoTextarea style={{...S.textarea,minHeight:44}} value={lifestyle.diet} onChange={e=>updL("diet",e.target.value)} placeholder="Vegetarian, omnivore…" /></Field>
            </div>
            {/* Session 152 — reaches the simulator's decision prompt through
                lifestyle_context/2, so this is what makes her pick the gallery
                over the bar. Comma-separated prose, not tags: it is written
                straight into the prompt. */}
            <Field label="Interests">
              <AutoTextarea style={{...S.textarea,minHeight:44}} value={lifestyle.interests}
                onChange={e=>updL("interests",e.target.value)}
                placeholder="Architecture, true crime documentaries, long-distance hiking…" />
            </Field>
          </>}

          {/* STEP 6: ECONOMY */}
          {step===6&&<>
            <button style={S.btnAmberFull} onClick={generateEconomy} disabled={!!generating}>
              {generating==="economy"?"◈ Generating…":"◈ Generate Economic Profile"}
            </button>
            <div style={S.row2}>
              <Field label="Financial Situation">
                <select style={S.select} value={economy.financial_situation} onChange={e=>updE("financial_situation",e.target.value)}>
                  <option value="struggling">Struggling</option>
                  <option value="precarious">Precarious</option>
                  <option value="stable">Stable</option>
                  <option value="comfortable">Comfortable</option>
                  <option value="wealthy">Wealthy</option>
                </select>
              </Field>
              <Field label="Income Stability">
                <select style={S.select} value={economy.income_stability} onChange={e=>updE("income_stability",e.target.value)}>
                  <option value="unemployed">Unemployed</option>
                  <option value="freelance">Freelance / variable</option>
                  <option value="stable">Stable employment</option>
                  <option value="high_earner">High earner</option>
                </select>
              </Field>
            </div>
            <div style={S.row2}>
              <Field label="Spending Style">
                <select style={S.select} value={economy.spending_style} onChange={e=>updE("spending_style",e.target.value)}>
                  <option value="frugal">Frugal</option>
                  <option value="balanced">Balanced</option>
                  <option value="spender">Spender</option>
                  <option value="impulsive">Impulsive</option>
                </select>
              </Field>
            </div>
            <div style={S.row2}>
              <Field label="Savings Habit">
                <select style={S.select} value={economy.savings_habit} onChange={e=>updE("savings_habit",e.target.value)}>
                  <option value="none">Doesn't save</option>
                  <option value="minimal">Minimal</option>
                  <option value="moderate">Moderate</option>
                  <option value="disciplined">Disciplined</option>
                </select>
              </Field>
              <Field label="Attitude to Wealth">
                <select style={S.select} value={economy.attitude_to_wealth} onChange={e=>updE("attitude_to_wealth",e.target.value)}>
                  <option value="indifferent">Indifferent</option>
                  <option value="practical">Practical</option>
                  <option value="aspirational">Aspirational</option>
                  <option value="anxious">Anxious about money</option>
                </select>
              </Field>
            </div>
            <Field label={`Financial Anxiety — ${Math.round(economy.financial_anxiety*100)}%`}>
              <input type="range" min={0} max={100} value={Math.round(economy.financial_anxiety*100)} onChange={e=>updE("financial_anxiety",e.target.value/100)} style={{width:"100%",accentColor:"#b05c08",height:4,marginTop:6}} />
            </Field>
            <Field label="Behaviour Note">
              <AutoTextarea style={{...S.textarea,minHeight:60}} value={economy.behavior_note} onChange={e=>updE("behavior_note",e.target.value)} placeholder="e.g. Spends on experiences, avoids checking bank balance…" />
            </Field>

            {/* Session 106 — default home picker. Selects the interior
                TEMPLATE preference (actors.default_home_template_url);
                world/place binding stays with the deploy wizard. "No
                preference" is first and default so existing flows are
                undisturbed. Thumbnails follow the /media/homes/<name>.jpg
                convention beside each GLB; a missing image degrades to a
                neutral placeholder, never a broken tile. */}
            <div style={{marginTop:24}}>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:600,color:"#1a1814",marginBottom:4}}>Default Home</div>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginBottom:12}}>An interior the character calls home by default. The world assigns the actual address at deployment.</div>
              {homeTemplates.length===0 ? (
                <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#a8a5a0",padding:"14px 16px",background:"#f7f5f2",borderRadius:8,border:"1px dashed #d8d4cd"}}>
                  No interior templates available yet — homes can be added to the catalog and picked here later.
                </div>
              ) : (
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12}}>
                  <div onClick={()=>setHomeTemplate(null)} style={{cursor:"pointer",borderRadius:10,overflow:"hidden",border:homeTemplate===null?"2px solid #b05c08":"1px solid #d8d4cd",background:"#fff"}}>
                    <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",background:"#f7f5f2",fontSize:26,color:"#c9c5be"}}>—</div>
                    <div style={{padding:"8px 10px",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,fontWeight:homeTemplate===null?600:400,color:"#1a1814"}}>No preference</div>
                  </div>
                  {homeTemplates.map(t=>{
                    const selected = homeTemplate===t.glb_url;
                    return (
                      <div key={t.id} onClick={()=>setHomeTemplate(t.glb_url)} style={{cursor:"pointer",borderRadius:10,overflow:"hidden",border:selected?"2px solid #b05c08":"1px solid #d8d4cd",background:"#fff"}}>
                        <HomeThumbnail glbUrl={t.glb_url} name={t.name} />
                        <div style={{padding:"8px 10px",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,fontWeight:selected?600:400,color:"#1a1814"}}>{t.name}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>}



          {/* STEP 7: REVIEW */}
          {step===7&&<>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{...S.serif,fontSize:36,fontWeight:400,color:"#1a1814",marginBottom:6}}>{(identity.first_name+" "+identity.last_name).trim()||"—"}</div>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#a8a5a0"}}>{identity.occupation}{identity.age?`, ${identity.age}`:""}</div>
              {Object.keys(photos).length>0&&<div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginTop:4}}>{Object.keys(photos).length} photo{Object.keys(photos).length!==1?"s":""} attached</div>}
            </div>

            {[
              {title:"Identity", rows:[["Gender",identity.gender],["Nationality",identity.nationality ? `${flagEmoji(identity.nationality)} ${(NATIONALITIES.find(n=>n[0]===identity.nationality)||[,identity.nationality])[1]}` : "—"],["Occupation",identity.occupation],["Orientation",identity.orientation]]},
              {title:"Psychology", rows:[["Attachment",personality.attachment_style],["Marital",psychology.marital_status],["Wound",psychology.wound?.slice(0,55)],["Wants",psychology.what_they_want?.slice(0,55)]]},
              {title:"Personality", rows:[["Big5 N/E/O/A/C",`${personality.big5.neuroticism}/${personality.big5.extraversion}/${personality.big5.openness}/${personality.big5.agreeableness}/${personality.big5.conscientiousness}`],["DISC D/I/S/C",`${personality.disc.d}/${personality.disc.i}/${personality.disc.s}/${personality.disc.c}`]]},
              {title:"Lifestyle & Economy", rows:[["Alcohol",lifestyle.alcohol_relationship],["Sleep",lifestyle.sleep_pattern],["Exercise",lifestyle.exercise_habit],["Finances",economy.financial_situation],["Home",homeTemplates.find(t=>t.glb_url===homeTemplate)?.name||"No preference"]]},
            ].map(section=>(
              <div key={section.title} style={S.reviewCard}>
                <div style={S.reviewTitle}>{section.title}</div>
                {section.rows.filter(([,v])=>v).map(([k,v])=>(
                  <div key={k} style={S.reviewRow}><span style={S.reviewKey}>{k}</span><span style={S.reviewVal}>{v}{String(v).length>=55?"…":""}</span></div>
                ))}
              </div>
            ))}

            <div style={{textAlign:"center",marginTop:28}}>
              <button style={{...S.btnSave,opacity:saving?.6:1}} onClick={handleSave} disabled={saving}>
                {saving?"Saving…":`Save ${(identity.first_name+" "+identity.last_name).trim()||"Character"} to Registry`}
              </button>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginTop:10}}>Saves to your character registry. Deploy to a world separately from the character profile.</div>
            </div>
          </>}
          </div>}
        </div>

        {/* Footer */}
        <div style={S.foot}>
          <button style={S.btnSecondary} onClick={()=>{setError(null);if(isAvatar&&step===1){handleCloseWizard();return;}setStep(s=>isAvatar&&s===7?2:Math.max(s-1,1))}} disabled={step===1&&!isAvatar}>← Back</button>
          <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0"}}>Step {isAvatar?AVATAR_STEPS.indexOf(step)+1:step} of {isAvatar?3:7}</div>
          {step<7&&<button style={{...S.btnPrimary, opacity:((step===1&&!step1Complete)||(step===3&&!step3Complete)||(step===4&&!step4Complete))?0.4:1, cursor:((step===1&&!step1Complete)||(step===3&&!step3Complete)||(step===4&&!step4Complete))?"not-allowed":"pointer"}} onClick={()=>{setError(null);advanceStep(step, () => setStep(s=>isAvatar&&s===2?7:s+1))}} disabled={(step===1&&!step1Complete)||(step===3&&!step3Complete)||(step===4&&!step4Complete)}>{step===6?"Review →":"Next →"}</button>}
          {step===7&&<div />}
        </div>

      </div>
    </div>
    {viewingAssessment && assessmentResults[viewingAssessment] && (
      <AssessmentDetailView
        assessmentType={viewingAssessment}
        result={assessmentResults[viewingAssessment]}
        onClose={()=>setViewingAssessment(null)}
      />
    )}
    </>
  );
}
