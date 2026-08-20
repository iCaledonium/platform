import { useEffect } from "react";

const LABELS = {
  iwm:        "Internal Working Model",
  attachment: "Attachment Style",
  intimacy:   "Intimacy & Coping",
  disc:       "DISC — Communication Style",
  cogstyle:   "Cognitive & Decision Style",
  rds:        "Relationship Dysfunction Scale",
  hds:        "Hogan HDS — Dark Side Under Stress",
};

const HDS_SCALES = ["bold","cautious","colorful","diligent","dutiful","excitable","imaginative","leisurely","mischievous","reserved","skeptical"];
const BIG5_SCALES = ["extraversion","agreeableness","conscientiousness","neuroticism","openness"];

const S = {
  overlay: { position:"fixed",inset:0,zIndex:1100,background:"rgba(238,236,234,0.8)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1.5rem" },
  modal: { background:"rgba(255,255,255,0.96)",border:"1px solid rgba(255,255,255,0.95)",boxShadow:"0 8px 64px rgba(0,0,0,0.12)",borderRadius:20,width:"100%",maxWidth:680,maxHeight:"90vh",display:"flex",flexDirection:"column",overflow:"hidden" },
  head: { padding:"1.5rem 2rem 1.25rem",borderBottom:"1px solid rgba(0,0,0,0.06)",flexShrink:0 },
  body: { flex:1,overflowY:"auto",padding:"1.5rem 2rem" },
  serif: { fontFamily:"'Cormorant Garamond',Georgia,serif" },
  sans: { fontFamily:"'DM Sans',system-ui,sans-serif" },
  mono: { fontFamily:"'DM Mono',monospace,sans-serif" },
  itemRow: { display:"flex",alignItems:"flex-start",justifyContent:"space-between",padding:"10px 0",borderBottom:"1px solid rgba(0,0,0,0.04)",gap:16 },
  itemText: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#1a1814",flex:1,lineHeight:1.5 },
  answerBadge: { fontFamily:"'DM Mono',monospace,sans-serif",fontSize:11,padding:"3px 10px",borderRadius:6,flexShrink:0,whiteSpace:"nowrap" },
  scaleHead: { fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:"0.18em",textTransform:"uppercase",color:"#a8a5a0",marginTop:20,marginBottom:10,paddingBottom:8,borderBottom:"1px solid rgba(0,0,0,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between" },
  scoreBar: { height:4,borderRadius:2,background:"rgba(0,0,0,0.06)",overflow:"hidden",width:80,flexShrink:0 },
};

function answerColor(rtype, answer) {
  if (rtype === "boolean") {
    return answer === "TRUE"
      ? { bg:"rgba(52,199,89,0.12)", color:"#1a7a35" }
      : { bg:"rgba(192,57,43,0.1)", color:"#c0392b" };
  }
  if (rtype === "likert4") {
    const n = Number(answer);
    if (n <= 2) return { bg:"rgba(192,57,43,0.1)", color:"#c0392b" };
    if (n === 3) return { bg:"rgba(201,151,58,0.12)", color:"#8a5a00" };
    return { bg:"rgba(52,199,89,0.12)", color:"#1a7a35" };
  }
  if (rtype === "likert5") {
    const n = Number(answer);
    if (n <= 2) return { bg:"rgba(192,57,43,0.1)", color:"#c0392b" };
    if (n === 3) return { bg:"rgba(201,151,58,0.12)", color:"#8a5a00" };
    return { bg:"rgba(52,199,89,0.12)", color:"#1a7a35" };
  }
  if (rtype === "likert7") {
    const n = Number(answer);
    if (n <= 2) return { bg:"rgba(52,199,89,0.12)", color:"#1a7a35" };
    if (n <= 4) return { bg:"rgba(201,151,58,0.12)", color:"#8a5a00" };
    return { bg:"rgba(192,57,43,0.1)", color:"#c0392b" };
  }
  return { bg:"rgba(0,0,0,0.06)", color:"#6b6760" };
}

function ScoreBar({ value }) {
  return (
    <div style={S.scoreBar}>
      <div style={{ height:"100%", width:`${value}%`, background: value > 70 ? "#c0392b" : value > 40 ? "#c9973a" : "#34c759", borderRadius:2 }} />
    </div>
  );
}

export default function AssessmentDetailView({ assessmentType, result, onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!result) return null;
  const { answers, scores, interpretation, notes } = result;
  const isHDS  = assessmentType === "hds";
  const isBig5 = assessmentType === "big5";

  // Group Big5 answers by scale
  const big5ByScale = {};
  if (isBig5) {
    BIG5_SCALES.forEach(s => { big5ByScale[s] = []; });
    (answers||[]).forEach(a => { if (big5ByScale[a.scale]) big5ByScale[a.scale].push(a); });
  }

  // Group HDS answers by scale
  const hdsByScale = {};
  if (isHDS) {
    HDS_SCALES.forEach(s => { hdsByScale[s] = []; });
    (answers||[]).forEach(a => {
      if (hdsByScale[a.scale]) hdsByScale[a.scale].push(a);
    });
  }

  // Determine response type
  const rtype = assessmentType === "attachment" ? "likert7"
    : ["iwm","intimacy","cogstyle"].includes(assessmentType) ? "boolean"
    : assessmentType === "big5" ? "likert5"
    : "likert4";

  // Style badge for attachment
  const styleBadge = scores?.style || scores?.primaryStyle || scores?.cognitiveStyle;

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={S.head}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8}}>
            <div>
              <div style={{...S.serif,fontSize:22,fontWeight:400,color:"#1a1814",marginBottom:4}}>{LABELS[assessmentType]}</div>
              {styleBadge && <div style={{...S.sans,fontSize:12,color:"#b05c08",fontStyle:"italic"}}>{styleBadge}</div>}
            </div>
            <button onClick={onClose} style={{background:"none",border:"1px solid rgba(0,0,0,0.08)",borderRadius:8,padding:"6px 12px",cursor:"pointer",...S.sans,fontSize:12,color:"#a8a5a0",flexShrink:0}}>✕ Close</button>
          </div>
          {interpretation && <div style={{...S.sans,fontSize:13,color:"#6b6760",lineHeight:1.6,marginTop:8,paddingTop:10,borderTop:"1px solid rgba(0,0,0,0.06)"}}>{interpretation}</div>}
          {notes && Object.entries(notes).filter(([,v])=>v).map(([k,v])=>(
            <div key={k} style={{...S.sans,fontSize:12,color:"#a8a5a0",marginTop:6}}>
              <span style={{color:"#6b6760",textTransform:"uppercase",fontSize:10,letterSpacing:"0.1em"}}>{k.replace(/([A-Z])/g," $1").trim()} — </span>{typeof v === "string" ? v : JSON.stringify(v)}
            </div>
          ))}
        </div>

        <div style={S.body}>

          {/* Big5 scores */}
          {isBig5 && scores && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:20}}>
              {BIG5_SCALES.map(scale => (
                <div key={scale} style={{background:"rgba(0,0,0,0.03)",borderRadius:10,padding:"10px 12px"}}>
                  <div style={{...S.sans,fontSize:9,letterSpacing:"0.1em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:6}}>{scale.slice(0,3).toUpperCase()}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <ScoreBar value={scores[scale]||0} />
                    <span style={{...S.mono,fontSize:11,color:"#b05c08"}}>{scores[scale]||0}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Scores summary for HDS */}
          {isHDS && scores && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:20}}>
              {HDS_SCALES.map(scale => {
                const sc = scores[scale];
                if (sc === undefined) return null;
                const val = typeof sc === "object" ? sc.score : sc;
                return (
                  <div key={scale} style={{background:"rgba(0,0,0,0.03)",borderRadius:10,padding:"10px 12px"}}>
                    <div style={{...S.sans,fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:6}}>{scale}</div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <ScoreBar value={val} />
                      <span style={{...S.mono,fontSize:12,color:val>70?"#c0392b":val>40?"#b05c08":"#34c759"}}>{val}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* DISC scores */}
          {assessmentType === "disc" && scores && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:20}}>
              {[["d","Dominance"],["i","Influence"],["s","Steadiness"],["c","Conscientiousness"]].map(([k,l]) => (
                <div key={k} style={{background:"rgba(0,0,0,0.03)",borderRadius:10,padding:"10px 12px"}}>
                  <div style={{...S.sans,fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",color:"#a8a5a0",marginBottom:6}}>{l}</div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <ScoreBar value={scores[k]||0} />
                    <span style={{...S.mono,fontSize:12,color:"#b05c08"}}>{scores[k]||0}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Big5 items grouped by scale */}
          {isBig5 && BIG5_SCALES.map(scale => {
            const items = big5ByScale[scale] || [];
            if (!items.length) return null;
            const scaleScore = scores?.[scale];
            return (
              <div key={scale}>
                <div style={S.scaleHead}>
                  <span>{scale.charAt(0).toUpperCase()+scale.slice(1)}</span>
                  {scaleScore !== undefined && (
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <ScoreBar value={scaleScore} />
                      <span style={{...S.mono,fontSize:11,color:"#b05c08"}}>{scaleScore}</span>
                    </div>
                  )}
                </div>
                {items.map((a,i) => {
                  const col = answerColor("likert5", a.answer);
                  return (
                    <div key={i} style={S.itemRow}>
                      <span style={S.itemText}>{a.item_text || a.item}</span>
                      <span style={{...S.answerBadge, background:col.bg, color:col.color}}>{a.label || a.answer}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* HDS items grouped by scale */}
          {isHDS && HDS_SCALES.map(scale => {
            const items = hdsByScale[scale] || [];
            if (!items.length) return null;
            const scaleScore = typeof scores?.[scale] === "object" ? scores[scale]?.score : scores?.[scale];
            return (
              <div key={scale}>
                <div style={S.scaleHead}>
                  <span>{scale.charAt(0).toUpperCase()+scale.slice(1)}</span>
                  {scaleScore !== undefined && (
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <ScoreBar value={scaleScore} />
                      <span style={{...S.mono,fontSize:11,color:scaleScore>70?"#c0392b":scaleScore>40?"#b05c08":"#34c759"}}>{scaleScore}</span>
                    </div>
                  )}
                </div>
                {items.map((a,i) => {
                  const col = answerColor("likert4", a.answer);
                  return (
                    <div key={i} style={S.itemRow}>
                      <span style={S.itemText}>{a.item_text || a.item}</span>
                      <span style={{...S.answerBadge, background:col.bg, color:col.color}}>{a.label || a.answer}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Non-HDS items */}
          {!isHDS && (answers||[]).map((a,i) => {
            const col = answerColor(rtype, a.answer);
            return (
              <div key={i} style={S.itemRow}>
                <span style={{...S.sans,fontSize:11,color:"#a8a5a0",width:20,flexShrink:0,paddingTop:2}}>{i+1}</span>
                <span style={S.itemText}>{a.item_text || a.item}</span>
                <span style={{...S.answerBadge, background:col.bg, color:col.color}}>{a.label || a.answer}</span>
              </div>
            );
          })}

        </div>
      </div>
    </div>
  );
}
