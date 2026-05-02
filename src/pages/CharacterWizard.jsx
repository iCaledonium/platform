import { useState, useEffect, useRef } from "react";
import AssessmentDetailView from "./AssessmentDetailView";

const STEPS = ["Identity", "Psychology", "Personality", "Lifestyle", "Economy", "Review"];

const S = {
  overlay: { position:"fixed",inset:0,zIndex:1000,background:"rgba(238,236,234,0.72)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1.5rem" },
  modal: { background:"rgba(255,255,255,0.92)",cursor:"default",backdropFilter:"blur(40px) saturate(200%)",WebkitBackdropFilter:"blur(40px) saturate(200%)",border:"1px solid rgba(255,255,255,0.95)",boxShadow:"0 8px 64px rgba(0,0,0,0.12),0 1px 0 rgba(255,255,255,1) inset",borderRadius:24,width:"100%",maxWidth:620,maxHeight:"90vh",display:"flex",flexDirection:"column",overflow:"hidden" },
  head: { padding:"1.75rem 2rem 1.25rem",borderBottom:"1px solid rgba(0,0,0,0.06)",flexShrink:0 },
  body: { flex:1,overflowY:"auto",padding:"1.75rem 2rem" },
  foot: { padding:"1.25rem 2rem",borderTop:"1px solid rgba(0,0,0,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 },
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

function Field({ label, hint, children }) {
  return <div style={S.sf}><label style={S.label}>{label}</label>{children}{hint&&<div style={S.hint}>{hint}</div>}</div>;
}
function Slider({ label, value, onChange }) {
  return (
    <div style={S.sliderRow}>
      <span style={S.sliderLbl}>{label}</span>
      <input type="range" min={0} max={100} value={value} onChange={e=>onChange(Number(e.target.value))} style={{flex:1,accentColor:"#b05c08",height:4}} />
      <span style={S.sliderVal}>{value}</span>
    </div>
  );
}

async function callAI(prompt) {
  const res = await fetch("/api/generate/profile", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ prompt }),
  });
  const d = await res.json();
  return d.text || "";
}

export default function CharacterWizard({ user, worlds, onClose, onCreated }) {
  const [step, setStep]       = useState(1);
  const [saving, setSaving]   = useState(false);
  const [generating, setGenerating] = useState(null);
  const [assessRunning, setAssessRunning] = useState(null);
  const [error, setError]     = useState(null);
  useEffect(() => { if (step === 6) setError(null); }, [step]);
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
  const [photos, setPhotos] = useState({}); // { slug: File }
  const activeSlotRef = useRef(null);
  const [assessments, setAssessments] = useState({ iwm:"", attachment:"", intimacy:"", cogstyle:"" });
  const [assessmentResults, setAssessmentResults] = useState({});
  const [viewingAssessment, setViewingAssessment] = useState(null);
  const [skippedFields, setSkippedFields] = useState(new Set());
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

  const [identity, setIdentity] = useState({ first_name:"", last_name:"", age:"", gender:"female", occupation:"", orientation:"straight", appearance:"" });
  const [appearanceFields, setAppearanceFields] = useState({
    // General — Haiku fills
    height:"", build:"", body_shape:"", hair:"", eyes:"", face:"", style:"", notable:"",
    presence:"", body_confidence:"", grooming:"", tension_markers:"",
    // Women — Haiku fills
    breasts:"", ass:"", waist_hip_ratio:"", legs:"",
    // Men — Haiku fills
    physique:"", shoulders:"", height_dominance:"",
    // Manual only (red)
    voice:"", sexual_presence:"", endowment:"",
  });
  const [psychology, setPsychology] = useState({ backstory:"", wound:"", what_they_want:"", blindspot:"", defenses:"", contradiction:"", coping_mechanisms:"", view_on_sex:"", marital_status:"single" });
  const [personality, setPersonality] = useState({
    attachment_style:"secure",
    big5:{ openness:50, conscientiousness:50, extraversion:50, agreeableness:50, neuroticism:50 },
    disc:{ d:50, i:50, s:50, c:50 },
    hds:{ bold:30, cautious:30, colorful:30, diligent:30, dutiful:30, excitable:30, imaginative:30, leisurely:30, mischievous:30, reserved:30, skeptical:30 },
  });
  const [lifestyle, setLifestyle] = useState({ alcohol_relationship:"rare", drug_use:"none", substance_context:"", sleep_pattern:"normal", sleep_quality:"good", exercise_habit:"regular", exercise_type:"", social_frequency:"weekly", diet:"", lifestyle_note:"" });
  const [economy, setEconomy]   = useState({ financial_situation:"stable", income_stability:"stable", monthly_income_sek:"", spending_style:"balanced", savings_habit:"moderate", attitude_to_wealth:"practical", financial_anxiety:0.3, behavior_note:"" });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

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
  function updAF(key, val) {
    setSkippedFields(s => { const n = new Set(s); n.delete(key); return n; });
    setAppearanceFields(p => {
      const next = {...p, [key]: val};
      // Serialise to appearance text
      const lines = Object.entries(next).filter(([,v])=>v).map(([k,v])=>`${k.replace(/_/g," ")}: ${v}`).join("\n");
      setIdentity(id => ({...id, appearance: lines}));
      return next;
    });
  }
  const updI=upd(setIdentity), updP=upd(setPsychology), updL=upd(setLifestyle), updE=upd(setEconomy);

  const charCtx = () => {
    const appCtx = Object.entries(appearanceFields).filter(([,v])=>v).map(([k,v])=>`${k.replace(/_/g," ")}: ${v}`).join(", ");
    return `Character: ${(identity.first_name+" "+identity.last_name).trim()||"unnamed"}, ${identity.age||"?"}yo, ${identity.gender}, ${identity.occupation||"no occupation"}.${appCtx ? `
Physical: ${appCtx}.` : ""}`;
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
      try { const j = JSON.parse(val); val = j[key] || j.text || j.value || val; } catch {}
      setPsychology(p=>({...p,[key]:val}));
    } catch { setError("Generation failed"); }
    setGenerating(null);
  }

  async function generateFullPsychology() {
    if (!identity.first_name) { setError("Fill in Identity first"); return; }
    setGenerating("all"); setError(null);
    try {
      const text = await callAI(`${charCtx()}
Return ONLY valid JSON (no markdown):
{"backstory":"2-3 sentences","wound":"core wound","what_they_want":"private desire","blindspot":"pattern they repeat","defenses":"emotional defenses","contradiction":"tension they live with","coping_mechanisms":"how they cope","view_on_sex":"their relationship with sex and intimacy","marital_status":"single|casually_dating|in_relationship|married|divorced"}`);
      const j = parseJSON(text);
      setPsychology(p=>({...p,...j}));
    } catch { setError("Generation failed"); }
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
        setPsychology(p=>({...p,coping_mechanisms:coping.slice(0,200)}));
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
      const t = await callAI(`${charCtx()} Attachment: ${personality.attachment_style}. N=${personality.big5.neuroticism} E=${personality.big5.extraversion}.\nReturn ONLY valid JSON:\n{"alcohol_relationship":"non_drinker|rare|moderate|regular|heavy","drug_use":"none|cannabis_occasional|cannabis_regular|mixed_recreational|cocaine_occasional","substance_context":"","sleep_pattern":"early_riser|normal|night_owl|irregular","sleep_quality":"good|variable|poor","exercise_habit":"sedentary|occasional|regular|athlete","exercise_type":"","social_frequency":"rarely|monthly|weekly|daily","diet":"","lifestyle_note":""}`);
      setLifestyle(p=>({...p,...parseJSON(t)}));
    } catch { setError("Generation failed"); }
    setGenerating(null);
  }

  async function generateEconomy() {
    setGenerating("economy"); setError(null);
    try {
      const t = await callAI(`Occupation: ${identity.occupation}, Age: ${identity.age}. C=${personality.big5.conscientiousness}.\nReturn ONLY valid JSON:\n{"financial_situation":"stable|struggling|comfortable|wealthy|precarious","income_stability":"stable|variable|freelance|unemployed","monthly_income_sek":35000,"spending_style":"frugal|balanced|spender|impulsive","savings_habit":"none|minimal|moderate|disciplined","attitude_to_wealth":"practical|aspirational|anxious|indifferent","financial_anxiety":0.3,"behavior_note":""}`);
      setEconomy(p=>({...p,...parseJSON(t)}));
    } catch { setError("Generation failed"); }
    setGenerating(null);
  }

  function handleSlotFile(slug, e) {
    e.preventDefault();
    const file = (e.dataTransfer?.files||e.target.files)?.[0];
    if (file && file.type.startsWith("image/")) {
      setPhotos(p => ({...p, [slug]: file}));
    }
  }

  async function handleSave() {
    if (!identity.first_name) { setError("First name is required"); return; }
    setSaving(true); setError(null);
    let actorId = null;
    try {
      // 1. Create actor
      const res = await fetch("/api/actors", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ identity, psychology:{...psychology, attachment_style:personality.attachment_style}, personality, lifestyle, economy }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || "Save failed");
      actorId = d.id;

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

      // 2. Upload photos — non-fatal, don't rollback for photo failures
      for (const [slug, file] of Object.entries(photos)) {
        const resized = await resizeForUpload(file);
        const fd = new FormData();
        fd.append("photo", resized);
        fd.append("state_slug", slug);
        fd.append("media_type", "photo");
        fd.append("filename", resized.name);
        await fetch(`/api/actors/${actorId}/media`, {method:"POST",body:fd}).catch(()=>{});
      }

      // 3. Save assessments — non-fatal
      for (const [atype, result] of Object.entries(assessmentResults)) {
        if (result?.answers?.length) {
          await fetch(`/api/actors/${actorId}/assessments`, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({ assessment_type:atype, ...result }),
          }).catch(()=>{});
        }
      }

      onCreated?.(d); onClose();
    } catch(e) {
      // Rollback — delete actor if it was created
      if (actorId) {
        await fetch(`/api/actors/${actorId}`, { method:"DELETE" }).catch(()=>{});
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
  ];

  return (
    <>
    <div style={S.overlay}>
      <div style={{...S.modal, position:"relative"}}>
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
            <div style={{...S.serif,fontSize:26,fontWeight:400,color:"#1a1814"}}>{step<6?"New Character":(identity.first_name+" "+identity.last_name).trim()||"Review"}</div>
            <button onClick={()=>{ if(window.confirm("Close the wizard? All unsaved work will be lost.")) onClose(); }} style={{background:"none",border:"1px solid rgba(0,0,0,0.08)",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#a8a5a0"}}>✕</button>
          </div>
          <div style={{display:"flex",gap:0}}>
            {STEPS.map((label,i)=>{
              const n=i+1,active=n===step,done=n<step;
              return (
                <div key={n} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:5,cursor:done?"pointer":"default"}} onClick={()=>done&&setStep(n)}>
                  <div style={{height:2,width:"100%",background:done?"#c9973a":active?"#1a1814":"rgba(0,0,0,0.08)",transition:"background .3s"}} />
                  <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,letterSpacing:"0.12em",textTransform:"uppercase",color:active?"#1a1814":done?"#c9973a":"#a8a5a0"}}>{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div style={S.body}>
          {error&&<div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#c0392b",background:"rgba(192,57,43,0.06)",border:"1px solid rgba(192,57,43,0.15)",borderRadius:8,padding:"10px 14px",marginBottom:18}}>{error}</div>}

          {/* STEP 1: IDENTITY */}
          {step===1&&<>
            <div style={S.row2}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <Field label="First Name"><input style={S.input} value={identity.first_name} onChange={e=>updI("first_name",e.target.value)} placeholder="Emma…" /></Field>
                <Field label="Last Name"><input style={S.input} value={identity.last_name} onChange={e=>updI("last_name",e.target.value)} placeholder="Lindqvist…" /></Field>
              </div>
              <Field label="Age"><input style={{...S.input,width:80}} type="number" min={18} max={99} value={identity.age} onChange={e=>updI("age",e.target.value)} placeholder="28" /></Field>
            </div>
            <div style={S.row2}>
              <Field label="Gender">
                <select style={S.select} value={identity.gender} onChange={e=>updI("gender",e.target.value)}>
                  <option value="female">Female — she/her</option>
                  <option value="male">Male — he/him</option>
                  <option value="neutral">Non-binary — they/them</option>
                </select>
              </Field>
              <Field label="Sexual Orientation">
                <select style={S.select} value={identity.orientation} onChange={e=>updI("orientation",e.target.value)}>
                  <option value="straight">Straight</option>
                  <option value="bisexual">Bisexual</option>
                  <option value="gay">Gay / Lesbian</option>
                  <option value="pansexual">Pansexual</option>
                  <option value="asexual">Asexual</option>
                </select>
              </Field>
            </div>
            <Field label="Occupation" hint="Shapes schedule, income and daily behaviour.">
              <input style={S.input} value={identity.occupation} onChange={e=>updI("occupation",e.target.value)} placeholder="Photographer, nurse, architect…" />
            </Field>

            <Field label="Photos" hint="Click a slot to upload. Used for appearance profile and identity recognition.">
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
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
                      <div style={{width:"100%",height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                        <div style={{fontSize:16,opacity:.25}}>+</div>
                        <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,color:"#a8a5a0",letterSpacing:"0.1em",textTransform:"uppercase"}}>{slot.label}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{if(activeSlotRef.current)handleSlotFile(activeSlotRef.current,e);}} />
            </Field>

            <div style={S.sf}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
                <label style={{...S.label,margin:0}}>Appearance</label>
                <button style={S.btnAmber} disabled={Object.keys(photos).length===0||generating==="appearance"}
                  onClick={async()=>{
                    console.log("[appearance] photos:", Object.keys(photos));
                    if(Object.keys(photos).length===0) return;
                    setGenerating("appearance");
                    try {
                      const toBase64 = f => new Promise((res,rej)=>{
                        const img = new Image();
                        const url = URL.createObjectURL(f);
                        img.onload = () => {
                          const MAX = 512;
                          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                          const canvas = document.createElement("canvas");
                          canvas.width = Math.round(img.width * scale);
                          canvas.height = Math.round(img.height * scale);
                          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
                          URL.revokeObjectURL(url);
                          res(canvas.toDataURL("image/jpeg", 0.7).split(",")[1]);
                        };
                        img.onerror = rej;
                        img.src = url;
                      });
                      const APPEARANCE_PRIORITY = ["photo_halfbody","photo_full_body","photo_bikini","profile","photo_close","photo_side","photo_behind","photo_intimate"];
                      const photoFiles = APPEARANCE_PRIORITY.map(s=>photos[s]).filter(Boolean).slice(0,1);
                      console.log("[appearance] photoFiles:", photoFiles.length, "priority slots checked");
                      if(photoFiles.length===0) throw new Error("No suitable photo found — upload a half body or full body photo first.");
                      const imgs = await Promise.all(photoFiles.map(toBase64));
                      console.log("[appearance] imgs encoded:", imgs.length, "sizes:", imgs.map(i=>i.length));
                      const resp = await fetch("/api/generate/appearance",{
                        method:"POST",headers:{"Content-Type":"application/json"},
                        body:JSON.stringify({images:imgs,name:(identity.first_name+" "+identity.last_name).trim(),gender:identity.gender,age:identity.age}),
                      });
                      console.log("[appearance] response status:", resp.status);
                      const d = await resp.json();
                      console.log("[appearance] response body:", JSON.stringify(d).slice(0,200));
                      if(d.error) throw new Error(d.error);
                      if(d.fields) {
                        setAppearanceFields(p => {
                          const next = {...p, ...d.fields};
                          // Mark fields that Haiku was expected to fill but left empty
                          const expected = ["height","build","body_shape","hair","eyes","face","style","presence","body_confidence","grooming","breasts","ass","bust","figure","waist_hip_ratio","legs","physique","shoulders","height_dominance"];
                          const skipped = new Set(expected.filter(k => d.fields[k] === undefined || d.fields[k] === ""));
                          setSkippedFields(skipped);
                          const lines = Object.entries(next).filter(([,v])=>v).map(([k,v])=>`${k.replace(/_/g," ")}: ${v}`).join("\n");
                          setIdentity(id => ({...id, appearance: lines}));
                          return next;
                        });
                      }
                    } catch(err) { console.error("[appearance]", err); setError("Generation failed: " + err.message); }
                    setGenerating(null);
                  }}>
                  {generating==="appearance"?"…":"✦ Generate from Photos"}
                </button>
              </div>
              {Object.keys(photos).length===0&&<div style={{...S.hint,marginBottom:10}}>Upload photos above to enable generation. Red fields must be filled manually.</div>}

              {/* General — Haiku fills */}
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.16em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:8}}>General</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                {[
                  {k:"height",         label:"Height",          ph:"tall / average / petite"},
                  {k:"build",          label:"Build",           ph:"slim / athletic / curvy…"},
                  {k:"body_shape",     label:"Body Shape",      ph:"hourglass / pear / apple…"},
                  {k:"hair",           label:"Hair",            ph:"dark brown, shoulder length, wavy"},
                  {k:"eyes",           label:"Eyes",            ph:"green, slightly almond-shaped"},
                  {k:"face",           label:"Face",            ph:"oval, high cheekbones, clear skin"},
                  {k:"style",          label:"Style",           ph:"minimal, dark tones, quality basics"},
                  {k:"notable",        label:"Notable",         ph:"small scar above lip — or none"},
                  {k:"presence",       label:"Presence",        ph:"warm / commanding / magnetic…"},
                  {k:"body_confidence",label:"Body Confidence", ph:"high / moderate / low"},
                  {k:"grooming",       label:"Grooming",        ph:"meticulous / natural / casual"},
                  {k:"tension_markers",label:"Tension Markers", ph:"none / jaw tension / closed posture"},
                ].map(f=>(
                  <div key={f.k}>
                    <label style={{...S.label,marginBottom:4,color:skippedFields.has(f.k)?"rgba(192,57,43,0.8)":undefined}}>{f.label}{skippedFields.has(f.k)?" — fill manually":""}</label>
                    <input style={{...S.input,borderColor:skippedFields.has(f.k)?"rgba(192,57,43,0.4)":undefined}} value={appearanceFields[f.k]} onChange={e=>updAF(f.k,e.target.value)} placeholder={f.ph} />
                  </div>
                ))}
              </div>

              {/* Gender-specific — Haiku fills */}
              {identity.gender==="female"&&<>
                <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.16em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:8}}>Physical — Female</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                  {[
                    {k:"breasts",        label:"Breasts",         ph:"average / full / large…"},
                    {k:"ass",            label:"Ass",             ph:"round / flat / prominent…"},
                    {k:"waist_hip_ratio",label:"Waist-Hip Ratio", ph:"low (very curvy) / average / high"},
                    {k:"legs",           label:"Legs",            ph:"long / average / athletic…"},
                  ].map(f=>(
                    <div key={f.k}>
                      <label style={{...S.label,marginBottom:4,color:skippedFields.has(f.k)?"rgba(192,57,43,0.8)":undefined}}>{f.label}{skippedFields.has(f.k)?" — fill manually":""}</label>
                      <input style={{...S.input,borderColor:skippedFields.has(f.k)?"rgba(192,57,43,0.4)":undefined}} value={appearanceFields[f.k]} onChange={e=>updAF(f.k,e.target.value)} placeholder={f.ph} />
                    </div>
                  ))}
                </div>
              </>}

              {identity.gender==="male"&&<>
                <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.16em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:8}}>Physical — Male</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                  {[
                    {k:"physique",          label:"Physique",          ph:"slim / toned / muscular / heavy"},
                    {k:"shoulders",         label:"Shoulders",         ph:"broad / average / narrow"},
                    {k:"height_dominance",  label:"Height Dominance",  ph:"very tall / tall / average…"},
                  ].map(f=>(
                    <div key={f.k}>
                      <label style={{...S.label,marginBottom:4,color:skippedFields.has(f.k)?"rgba(192,57,43,0.8)":undefined}}>{f.label}{skippedFields.has(f.k)?" — fill manually":""}</label>
                      <input style={{...S.input,borderColor:skippedFields.has(f.k)?"rgba(192,57,43,0.4)":undefined}} value={appearanceFields[f.k]} onChange={e=>updAF(f.k,e.target.value)} placeholder={f.ph} />
                    </div>
                  ))}
                </div>
              </>}

              {/* Manual only — red */}
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.16em",textTransform:"uppercase",color:"rgba(192,57,43,0.7)",marginBottom:8}}>Manual Only — Cannot Be Generated from Photos</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[
                  {k:"voice",           label:"Voice",           ph:"warm and low / bright / husky…"},
                  {k:"sexual_presence", label:"Sexual Presence", ph:"high / moderate / low"},
                  ...(identity.gender==="male"?[{k:"endowment",label:"Endowment",ph:"average / above average / well-endowed"}]:[]),
                ].map(f=>(
                  <div key={f.k}>
                    <label style={{...S.label,marginBottom:4,color:"rgba(192,57,43,0.7)"}}>{f.label}</label>
                    <input style={{...S.input,borderColor:"rgba(192,57,43,0.3)"}} value={appearanceFields[f.k]} onChange={e=>updAF(f.k,e.target.value)} placeholder={f.ph} />
                  </div>
                ))}
              </div>
            </div>
          </>}

          {/* STEP 2: PSYCHOLOGY */}
          {step===2&&<>
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
            {psychFields.map(f=>(
              <div key={f.key} style={S.sf}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:7}}>
                  <label style={{...S.label,margin:0}}>{f.label}</label>
                  <button style={S.btnAmber} onClick={()=>inspireField(f.key,f.label)} disabled={!!generating}>
                    {generating===f.key?"…":"✦ Inspire Me"}
                  </button>
                </div>
                <textarea style={{...S.textarea,minHeight:f.rows===3?80:60}} value={psychology[f.key]} onChange={e=>updP(f.key,e.target.value)} placeholder={f.ph} />
              </div>
            ))}
          </>}

          {/* STEP 3: PERSONALITY */}
          {step===3&&<>
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

          {/* STEP 4: LIFESTYLE */}
          {step===4&&<>
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
              <input style={S.input} value={lifestyle.substance_context} onChange={e=>updL("substance_context",e.target.value)} placeholder="e.g. drinks at industry events, smokes to unwind…" />
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
              <Field label="Exercise Type"><input style={S.input} value={lifestyle.exercise_type} onChange={e=>updL("exercise_type",e.target.value)} placeholder="Running, yoga, gym…" /></Field>
              <Field label="Diet"><input style={S.input} value={lifestyle.diet} onChange={e=>updL("diet",e.target.value)} placeholder="Vegetarian, omnivore…" /></Field>
            </div>
          </>}

          {/* STEP 5: ECONOMY */}
          {step===5&&<>
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
              <Field label="Monthly Income (SEK)"><input style={S.input} type="number" value={economy.monthly_income_sek} onChange={e=>updE("monthly_income_sek",e.target.value)} placeholder="35000" /></Field>
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
              <textarea style={{...S.textarea,minHeight:60}} value={economy.behavior_note} onChange={e=>updE("behavior_note",e.target.value)} placeholder="e.g. Spends on experiences, avoids checking bank balance…" />
            </Field>
          </>}



          {/* STEP 7: REVIEW */}
          {step===6&&<>
            <div style={{textAlign:"center",marginBottom:24}}>
              <div style={{...S.serif,fontSize:36,fontWeight:400,color:"#1a1814",marginBottom:6}}>{(identity.first_name+" "+identity.last_name).trim()||"—"}</div>
              <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#a8a5a0"}}>{identity.occupation}{identity.age?`, ${identity.age}`:""}</div>
              {Object.keys(photos).length>0&&<div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",marginTop:4}}>{Object.keys(photos).length} photo{Object.keys(photos).length!==1?"s":""} attached</div>}
            </div>

            {[
              {title:"Identity", rows:[["Gender",identity.gender],["Occupation",identity.occupation],["Orientation",identity.orientation]]},
              {title:"Psychology", rows:[["Attachment",personality.attachment_style],["Marital",psychology.marital_status],["Wound",psychology.wound?.slice(0,55)],["Wants",psychology.what_they_want?.slice(0,55)]]},
              {title:"Personality", rows:[["Big5 N/E/O/A/C",`${personality.big5.neuroticism}/${personality.big5.extraversion}/${personality.big5.openness}/${personality.big5.agreeableness}/${personality.big5.conscientiousness}`],["DISC D/I/S/C",`${personality.disc.d}/${personality.disc.i}/${personality.disc.s}/${personality.disc.c}`]]},
              {title:"Lifestyle & Economy", rows:[["Alcohol",lifestyle.alcohol_relationship],["Sleep",lifestyle.sleep_pattern],["Exercise",lifestyle.exercise_habit],["Finances",economy.financial_situation],["Income SEK/mo",economy.monthly_income_sek?Number(economy.monthly_income_sek).toLocaleString():""]]},
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
        </div>

        {/* Footer */}
        <div style={S.foot}>
          <button style={S.btnSecondary} onClick={()=>{setError(null);setStep(s=>Math.max(s-1,1))}} disabled={step===1}>← Back</button>
          <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0"}}>Step {step} of 6</div>
          {step<6&&<button style={S.btnPrimary} onClick={()=>{setError(null);setStep(s=>s+1)}}>{step===5?"Review →":"Next →"}</button>}
          {step===6&&<div />}
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
