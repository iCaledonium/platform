import { useState, useEffect } from "react";

// Session 149 — extracted out of WorldsPage.jsx's inline LlmTab so
// WorldWizard.jsx's new post-creation LLM step can render the identical
// component instead of a duplicated copy. Same drift risk as the
// nationalities.js extraction earlier this session: two independent
// copies of a capability list are worse than one shared source, even
// across two different "page" files.
export const CAPABILITIES = [
  { key:"encounter",          label:"Encounter",          group:"Output",   desc:"Real-time in-person scene generation" },
  { key:"synthesis",          label:"Synthesis",          group:"Output",   desc:"ThoughtEngine full psychology synthesis" },
  { key:"knock",              label:"Knock",              group:"Output",   desc:"Door knock decision" },
  { key:"door_narrative",     label:"Door narrative",     group:"Output",   desc:"Knock arrival narrative" },
  { key:"message_content",    label:"Message content",    group:"Output",   desc:"SMS content generation" },
  { key:"ambient_chat",       label:"Ambient chat",       group:"Output",   desc:"Ambient NPC chat generation" },
  { key:"social_process",     label:"Social process",     group:"Wave",     desc:"Wave 2 — relationship graph reasoning" },
  { key:"memory_process",     label:"Memory process",     group:"Wave",     desc:"Wave 2 — trigger matching & summarization" },
  { key:"affect_process",     label:"Affect process",     group:"Wave",     desc:"Wave 3 — emotion delta generation" },
  { key:"drive_process",      label:"Drive process",      group:"Wave",     desc:"Wave 3 — impulse generation" },
  { key:"decisions",          label:"Decisions",          group:"Planning", desc:"AgentLoop pool decisions" },
  { key:"thoughts",           label:"Thoughts",           group:"Planning", desc:"Internal actor reflection" },
  { key:"memory",             label:"Memory",             group:"Planning", desc:"Memory summarization" },
  { key:"planning",           label:"Planning",           group:"Planning", desc:"Schedule & objective generation" },
  { key:"relationship_score", label:"Rel scoring",        group:"Planning", desc:"Warmth/trust/tension scoring" },
  { key:"media_prompt",       label:"Media prompt",       group:"Planning", desc:"Kling/Hedra prompt generation" },
];

export const MODEL_OPTIONS = [
  { value:"nevoria",    label:"Nevoria 70B (UpCloud)" },
  { value:"dirty-muse", label:"dirty-muse 9B (M4)" },
  { value:"haiku",      label:"Claude Haiku (API)" },
];

export const PROVIDER_DEFAULTS = {
  nevoria_url:    "http://212.147.242.70:11434",
  dirty_muse_url: "http://192.168.1.60:11434",
};

// Session 149, v2 — replaced the per-row dropdown list (16 rows, each its
// own <select>, buried in a small internal scroll box) with a proper
// grid: capabilities down the left, LLMs across the top, click a cell to
// assign. One shared component so the wizard's local-state step and
// Configure's live-saving panel render identically instead of drifting
// into two different UIs for the same data. `value` is a plain
// {capability_key: llm_id} map — "" or missing means unset/default.
// `onChange(capability_key, llm_id)` fires on cell click; what happens
// with that call (local setState vs. a live API save) is entirely the
// caller's business, not this component's.
export function LlmCapabilityGrid({ availableLlms, value, onChange, savingKey }) {
  const groups = ["Output","Wave","Planning"];
  const cols = [{ id:"", name:"Default" }, ...availableLlms];

  // Select-all — click a column header to apply that model to every
  // capability in one go. Clicking "Default" is therefore also the
  // one-click "reset everything" action, for free. Reuses the exact same
  // per-cell onChange the caller already implements, just called once per
  // capability — no new prop, no new contract for either parent to learn.
  function selectAll(llmId) {
    CAPABILITIES.forEach(cap => onChange(cap.key, llmId));
  }

  return (
    <div style={{overflowX:"auto"}}>
      <div style={{display:"grid", gridTemplateColumns:`180px repeat(${cols.length}, 96px)`, alignItems:"center", rowGap:2}}>
        <div style={{fontSize:9, color:"#c5c2bc", padding:"0 0 6px"}}>Select all</div>
        {cols.map(c => (
          <button key={c.id || "default"} onClick={() => selectAll(c.id)}
            title={`Set every capability to ${c.name}`}
            style={{fontSize:10, color:"#6b6760", textAlign:"center", background:"none",
              border:"none", cursor:"pointer", padding:"0 4px 6px", letterSpacing:".03em",
              lineHeight:1.2, textDecoration:"underline", textDecorationColor:"rgba(0,0,0,0.15)",
              textUnderlineOffset:3}}>{c.name}</button>
        ))}

        {groups.map(group => (
          <div key={group} style={{display:"contents"}}>
            <div style={{gridColumn:"1 / -1", fontSize:10, color:"#a8a5a0", letterSpacing:".1em",
              textTransform:"uppercase", margin:"10px 0 4px"}}>{group}</div>
            {CAPABILITIES.filter(c => c.group === group).map(cap => (
              <div key={cap.key} style={{display:"contents"}}>
                <div style={{fontSize:12, color:"#1a1814", padding:"6px 8px 6px 0",
                  opacity: savingKey === cap.key ? 0.4 : 1}} title={cap.desc}>
                  {cap.label}
                </div>
                {cols.map(c => {
                  const checked = (value[cap.key] || "") === c.id;
                  return (
                    <div key={c.id || "default"} style={{display:"flex", justifyContent:"center", padding:"6px 0"}}>
                      <button
                        onClick={() => onChange(cap.key, c.id)}
                        disabled={savingKey === cap.key}
                        title={`${cap.label} → ${c.name}`}
                        style={{
                          width:18, height:18, borderRadius:5, cursor: savingKey===cap.key ? "default" : "pointer",
                          border: checked ? "none" : "1px solid rgba(0,0,0,0.18)",
                          background: checked ? "#1a1814" : "#fff",
                          color:"#faf8f4", fontSize:12, lineHeight:1, padding:0,
                        }}>
                        {checked ? "✓" : ""}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LlmConfigPanel({ world }) {
  const [config, setConfig]         = useState({});
  const [available, setAvailable]   = useState([]);
  const [providers, setProviders]   = useState({ nevoria_url: PROVIDER_DEFAULTS.nevoria_url, dirty_muse_url: PROVIDER_DEFAULTS.dirty_muse_url });
  // Session 150 — the voice server, per world. Kept in its own state because
  // unlike the two above it genuinely persists (worlds.xtts_url), so it has to
  // be loaded from the server rather than defaulted locally.
  const [xttsUrl, setXttsUrl]       = useState("");
  const [xttsDefault, setXttsDefault] = useState("");
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(null); // capability being saved
  const [savingProviders, setSavingProviders] = useState(false);
  const [status, setStatus]         = useState(null);

  useEffect(() => {
    fetch(`/api/worlds/${world.id}/xtts`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setXttsUrl(d.xtts_url || ""); setXttsDefault(d.default || ""); } })
      .catch(() => {});

    fetch(`/api/worlds/${world.id}/llm-config`)
      .then(r => r.ok ? r.json() : {})
      .then(data => {
        // capabilities: { encounter: { llm_id, name, alias }, ... }
        // available: [{ id, name, alias, url, model_tag, provider }, ...]
        const caps = {};
        Object.entries(data.capabilities || {}).forEach(([cap, v]) => {
          caps[cap] = v.llm_id || v.alias || "dirty-muse";
        });
        setConfig(caps);
        setAvailable(data.available || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [world.id]);

  async function setCapability(capability, llm_id) {
    setSaving(capability);
    setConfig(prev => ({ ...prev, [capability]: llm_id }));
    try {
      await fetch(`/api/worlds/${world.id}/llm-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world_id: world.id, capability, llm_id }),
      });
      const llm = available.find(l => l.id === llm_id);
      setStatus({ ok: true, msg: `${capability} → ${llm?.name || llm_id}` });
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus({ ok: false, msg: "Save failed" });
    }
    setSaving(null);
  }

  async function saveProviders() {
    setSavingProviders(true);
    try {
      await fetch(`/api/worlds/${world.id}/llm-config/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...providers, xtts_url: xttsUrl.trim() }),
      });
      setStatus({ ok: true, msg: "Voice server saved — LLM URLs apply until restart" });
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus({ ok: false, msg: "Save failed" });
    }
    setSavingProviders(false);
  }

  if (loading) return <p style={{fontSize:12,color:"#a8a5a0",padding:8}}>Loading…</p>;

  return (
    <div style={{display:"flex",gap:20}}>
      {/* Capabilities */}
      <div style={{flex:1}}>
        <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 10px"}}>Capabilities</p>
        <LlmCapabilityGrid
          availableLlms={available}
          value={config}
          savingKey={saving}
          onChange={(cap, llmId) => setCapability(cap, llmId)}
        />
      </div>

      {/* Providers */}
      <div style={{width:260,flexShrink:0}}>
        <p style={{fontSize:10,color:"#a8a5a0",letterSpacing:".1em",textTransform:"uppercase",margin:"0 0 10px"}}>Provider URLs</p>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[
            { key:"nevoria_url", label:"Nevoria (UpCloud)" },
            { key:"dirty_muse_url", label:"dirty-muse (M4)" },
          ].map(p => (
            <div key={p.key}>
              <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:4}}>{p.label}</label>
              <input
                value={providers[p.key] || ""}
                onChange={e => setProviders(prev => ({ ...prev, [p.key]: e.target.value }))}
                style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:7,
                  border:"1px solid rgba(0,0,0,0.12)",fontSize:12,color:"#1a1814",outline:"none"}}
              />
            </div>
          ))}

          {/* Session 150 — the voice server, after the LLM providers. Kept
              visually apart because it is the only one of the three that
              actually persists: it is written to worlds.xtts_url, while the two
              above live in the simulator's runtime state and reset on restart.
              The panel used to imply all three were saved; the save route
              stored none of them. */}
          <div style={{borderTop:"1px solid rgba(0,0,0,0.08)",paddingTop:10,marginTop:2}}>
            <label style={{fontSize:11,color:"#a8a5a0",display:"block",marginBottom:4}}>
              Voice server (XTTS)
            </label>
            <input
              value={xttsUrl}
              onChange={e => setXttsUrl(e.target.value)}
              placeholder={xttsDefault || "http://host:port/upload_reference"}
              style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:7,
                border:"1px solid rgba(0,0,0,0.12)",fontSize:12,color:"#1a1814",outline:"none"}}
            />
            <p style={{fontSize:10,color:"#a8a5a0",margin:"4px 0 0",lineHeight:1.45}}>
              Where voice references are sent so characters can speak. Blank uses the
              simulator default{xttsDefault ? ` (${xttsDefault})` : ""}. Saved per world — the GPU box
              is started by hand, so this address changes.
            </p>
          </div>

          <button onClick={saveProviders} disabled={savingProviders}
            style={{fontSize:11,letterSpacing:".06em",textTransform:"uppercase",padding:"8px 14px",
              borderRadius:7,background:"#1a1814",color:"#faf8f4",border:"none",cursor:"pointer",marginTop:4}}>
            {savingProviders ? "Saving…" : "Save URLs"}
          </button>
        </div>

        {status && (
          <div style={{marginTop:12,padding:"8px 12px",borderRadius:7,fontSize:12,
            background: status.ok ? "rgba(29,158,117,0.08)" : "rgba(192,57,43,0.08)",
            border: `1px solid ${status.ok ? "rgba(29,158,117,0.3)" : "rgba(192,57,43,0.3)"}`,
            color: status.ok ? "#1D9E75" : "#993c1d"}}>
            {status.ok ? "✓" : "✕"} {status.msg}
          </div>
        )}
      </div>
    </div>
  );
}
