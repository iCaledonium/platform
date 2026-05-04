import { useState, useEffect } from "react";
import styles from "./AppWizard.module.css";
import homeStyles from "./HomePage.module.css";

const TOOL_TYPES = [
  { id: "messages",  label: "Messages",  desc: "SMS-style text with your contacts.", svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1.5" stroke="#378add" stroke-width="1.1"/><path d="M5 7h6M5 9h4" stroke="#378add" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { id: "calendar",  label: "Calendar",  desc: "Your schedule and confirmed meetings.", svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="#b05c08" stroke-width="1.1"/><line x1="2" y1="6" x2="14" y2="6" stroke="#b05c08" stroke-width="1.1"/><line x1="5" y1="1" x2="5" y2="3.5" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/><line x1="11" y1="1" x2="11" y2="3.5" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { id: "voicemail", label: "Voicemail", desc: "Listen to voice messages from your contacts.", svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="9" r="2.5" stroke="#1d9e75" stroke-width="1.1"/><circle cx="11" cy="9" r="2.5" stroke="#1d9e75" stroke-width="1.1"/><path d="M5 11.5h6" stroke="#1d9e75" stroke-width="1.1" stroke-linecap="round"/></svg>' },
];

const NO_CONTACTS_TOOLS = ["calendar", "voicemail"];

const AVATARS = {
  "amber-soderstrom-actor": { bg: "#1a2e1a", col: "#5c9e5c" },
  "clark-bennet-actor":     { bg: "#2a2318", col: "#b5945a" },
  "7433c360-c14a-4b42-b5c0-13621d3bea38": { bg: "#2a1e2e", col: "#9e5cbe" },
  "tommy-norberg-actor":    { bg: "#2a1e2e", col: "#9e5cbe" },
  "johan-molin-actor":      { bg: "#1e2818", col: "#6ea86e" },
  "david-norberg-actor":    { bg: "#1e1e2e", col: "#7a7abe" },
};

function initials(name) {
  return name?.split(" ").map(n => n[0]).join("").slice(0,2).toUpperCase() || "?";
}

export default function AppWizard({ user, worlds, directTool, onClose, onCreated }) {
  const [path, setPath]             = useState(directTool ? "prebuilt" : null);
  const [step, setStep]             = useState(directTool ? 2 : 1);
  const [toolType, setToolType]     = useState(directTool || "messages");
  const [name, setName]             = useState("");
  const [url, setUrl]               = useState("");
  const [keyId, setKeyId]           = useState("");
  const [keys, setKeys]             = useState([]);
  const [contacts, setContacts]     = useState([]);
  const [selected, setSelected]     = useState(new Set());
  const [privacy, setPrivacy]       = useState({});  // contactId → "private" | "visible"
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [creating, setCreating]     = useState(false);
  const [worldId, setWorldId]       = useState(() => worlds?.[0]?.id || null);
  const [rawKey, setRawKey]         = useState("");

  const world    = worlds?.find(w => w.id === worldId);
  const actorId  = user?.worlds?.find(m => m.world_id === worldId)?.actor_id || null;

  // Auto-select existing world key when worldId changes
  useEffect(() => {
    if (!worldId) return;
    const worldKey = keys.find(k => k.world_id === worldId && !k.revoked_at);
    if (worldKey) setKeyId(worldKey.id);
    else setKeyId("");
  }, [worldId, keys]);

  useEffect(() => {
    fetch("/api/keys")
      .then(r => r.ok ? r.json() : [])
      .then(data => setKeys(data.filter(k => !k.revoked_at)));
  }, []);

  function loadContacts() {
    if (contacts.length > 0) return;
    setLoadingContacts(true);
    fetch(`/api/worlds/${worldId}/actors/${actorId}/contacts`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setContacts(data);
        setSelected(new Set(data.map(c => c.id)));
        // default all to private
        const defaults = {};
        data.forEach(c => { defaults[c.id] = "private"; });
        setPrivacy(defaults);
      })
      .finally(() => setLoadingContacts(false));
  }

  function toggleContact(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function create() {
    if (!name || !keyId) return;
    if (path === "custom" && !url) return;
    setCreating(true);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          tool_type: path === "prebuilt" ? toolType : "custom",
          world_id: worldId,
          actor_id: actorId,
          api_key_id: keyId,
          contact_ids: [...selected].map(id => ({ id, privacy: privacy[id] || "private" })),
          url: path === "custom" ? url : null,
          built_by: path === "prebuilt" ? "anima" : "user",
        }),
      });
      const data = await res.json();
      if (rawKey && data.id) {
        localStorage.setItem(`anima_world_key_${worldId}`, rawKey);
      }
      onCreated(data);
    } finally { setCreating(false); }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <p className={styles.title}>{directTool ? `Set up ${TOOL_TYPES.find(t=>t.id===directTool)?.label || directTool}` : "New application"}</p>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {!path && !directTool && (
          <div className={styles.body}>
            <p className={styles.stepLabel}>How do you want to build this?</p>
            <div className={styles.pathGrid}>
              <div className={styles.pathCard} onClick={() => setPath("prebuilt")}>
                <div className={styles.pathIcon} style={{background:"rgba(55,138,221,.07)",border:"1px solid rgba(55,138,221,.13)"}}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" stroke="#378add" stroke-width="1.1"/><rect x="10" y="2" width="6" height="6" rx="1" stroke="#378add" stroke-width="1.1"/><rect x="2" y="10" width="6" height="6" rx="1" stroke="#378add" stroke-width="1.1"/><rect x="10" y="10" width="6" height="6" rx="1" stroke="#378add" stroke-width="1.1"/></svg>
                </div>
                <p className={styles.pathName}>Use a pre-built app</p>
                <p className={styles.pathDesc}>Anima provides the UI. Wire it to your world with an API key.</p>
              </div>
              <div className={styles.pathCard} onClick={() => setPath("custom")}>
                <div className={styles.pathIcon} style={{background:"rgba(176,92,8,.07)",border:"1px solid rgba(176,92,8,.13)"}}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 7l-3 2 3 2M13 7l3 2-3 2M10 4l-2 10" stroke="#b05c08" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </div>
                <p className={styles.pathName}>Register your own</p>
                <p className={styles.pathDesc}>You built it. Paste your URL, pick an API key, and it appears in your app drawer.</p>
              </div>
            </div>
          </div>
        )}

        {path === "prebuilt" && (
          <>
            <div className={styles.steps}>
              {(directTool
                ? (NO_CONTACTS_TOOLS.includes(toolType) ? ["Name","Key"] : ["Name","Contacts","Key"])
                : (NO_CONTACTS_TOOLS.includes(toolType) ? ["Tool","Name","Key"] : ["Tool","Name","Contacts","Key"])
              ).map((l,i) => {
                const idx = directTool ? i+1 : i+1;
                const adjustedStep = directTool ? step - 1 : step;
                return (
                  <div key={l} className={`${styles.step} ${adjustedStep===idx?styles.stepActive:""} ${adjustedStep>idx?styles.stepDone:""}`}>
                    <div className={styles.stepDot}>{adjustedStep>idx?"✓":idx}</div>
                    <span>{l}</span>
                  </div>
                );
              })}
            </div>

            {step === 1 && (
              <div className={styles.body}>
                <p className={styles.stepLabel}>Choose a tool type</p>
                <div className={styles.toolList}>
                  {TOOL_TYPES.map(t => (
                    <div key={t.id} className={`${styles.toolOption} ${toolType===t.id?styles.toolOptionSel:""}`} onClick={() => setToolType(t.id)}>
                      <div className={styles.toolOptionIcon} dangerouslySetInnerHTML={{__html: t.svg}} />
                      <div>
                        <p className={styles.toolOptionName}>{t.label}</p>
                        <p className={styles.toolOptionDesc}>{t.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className={styles.footer}>
                  <button className={styles.btnCancel} onClick={() => setPath(null)}>← Back</button>
                  <button className={styles.btnNext} onClick={() => setStep(2)}>Next →</button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className={styles.body}>
                <p className={styles.stepLabel}>Name your app</p>
                <div className={styles.field}>
                  <label>App name</label>
                  <input type="text" placeholder='e.g. SMS Anima — Stockholm' value={name} onChange={e => setName(e.target.value)} autoFocus />
                </div>
                <div className={styles.field}>
                  <label>World</label>
                  <input type="text" value={world?.name || worldId || ""} disabled style={{opacity:.5}} />
                </div>
                <div className={styles.footer}>
                  <button className={styles.btnCancel} onClick={() => directTool ? onClose() : setStep(1)}>← Back</button>
                  <button className={styles.btnNext} disabled={!name} onClick={() => { if (NO_CONTACTS_TOOLS.includes(toolType)) { setStep(4); } else { loadContacts(); setStep(3); } }}>Next →</button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className={styles.body}>
                <p className={styles.stepLabel}>Choose your contacts & privacy</p>
                {loadingContacts ? (
                  <p className={styles.loadingMsg}>Loading contacts…</p>
                ) : (
                  <div className={styles.contactGrid}>
                    {contacts.map(c => {
                      const av = AVATARS[c.id] || { bg: "#1e2a2e", col: "#5c9ebe" };
                      const isSelected = selected.has(c.id);
                      const priv = privacy[c.id] || "private";
                      return (
                        <div key={c.id} className={`${styles.contactChip} ${isSelected ? styles.contactChipSel : styles.contactChipDim}`}>
                          <div className={styles.chipTop}>
                            <div style={{display:"flex",alignItems:"center",gap:10}}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleContact(c.id)}
                                style={{width:14,height:14,cursor:"pointer",accentColor:"#b05c08",flexShrink:0}}
                              />
                              <div className={styles.chipAv} style={{background: av.bg, color: av.col}}>
                                {c.photo_url
                                  ? <img src={c.photo_url} alt={c.name} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} />
                                  : initials(c.name)
                                }
                              </div>
                              <div className={styles.chipInfo}>
                                <p className={styles.chipName}>{c.name}</p>
                                <p className={styles.chipRole}>{c.occupation}</p>
                              </div>
                            </div>
                          </div>
                          {isSelected && (
                            <div className={styles.privacyRow}>
                              <label className={styles.radioLabel}>
                                <input
                                  type="radio"
                                  name={`privacy-${c.id}`}
                                  value="private"
                                  checked={priv === "private"}
                                  onChange={() => setPrivacy(p => ({...p, [c.id]: "private"}))}
                                  style={{accentColor:"#b05c08"}}
                                />
                                <span>Private</span>
                              </label>
                              <label className={styles.radioLabel}>
                                <input
                                  type="radio"
                                  name={`privacy-${c.id}`}
                                  value="visible"
                                  checked={priv === "visible"}
                                  onChange={() => setPrivacy(p => ({...p, [c.id]: "visible"}))}
                                  style={{accentColor:"#b05c08"}}
                                />
                                <span>Visible</span>
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className={styles.contactHint}>{selected.size} of {contacts.length} selected</p>
                <div className={styles.footer}>
                  <button className={styles.btnCancel} onClick={() => setStep(2)}>← Back</button>
                  <button className={styles.btnNext} disabled={selected.size === 0} onClick={() => setStep(4)}>Next →</button>
                </div>
              </div>
            )}

            {step === 4 && <KeyStep keys={keys} keyId={keyId} setKeyId={setKeyId} setRawKey={setRawKey} onBack={() => NO_CONTACTS_TOOLS.includes(toolType) ? setStep(2) : setStep(3)} onCreate={create} creating={creating} worldId={worldId} />}
          </>
        )}

        {path === "custom" && (
          <>
            <div className={styles.steps}>
              {["Details","Key"].map((l,i) => (
                <div key={l} className={`${styles.step} ${step===i+1?styles.stepActive:""} ${step>i+1?styles.stepDone:""}`}>
                  <div className={styles.stepDot}>{step>i+1?"✓":i+1}</div>
                  <span>{l}</span>
                </div>
              ))}
            </div>

            {step === 1 && (
              <div className={styles.body}>
                <p className={styles.stepLabel}>Your app details</p>
                <div className={styles.field}>
                  <label>App name</label>
                  <input type="text" placeholder='e.g. My Companion App' value={name} onChange={e => setName(e.target.value)} autoFocus />
                </div>
                <div className={styles.field}>
                  <label>App URL</label>
                  <input type="url" placeholder='https://myapp.example.com' value={url} onChange={e => setUrl(e.target.value)} />
                </div>
                <div className={styles.field}>
                  <label>World</label>
                  <input type="text" value={world?.name || worldId || ""} disabled style={{opacity:.5}} />
                </div>
                <div className={styles.footer}>
                  <button className={styles.btnCancel} onClick={() => setPath(null)}>← Back</button>
                  <button className={styles.btnNext} disabled={!name || !url} onClick={() => setStep(2)}>Next →</button>
                </div>
              </div>
            )}

            {step === 2 && <KeyStep keys={keys} keyId={keyId} setKeyId={setKeyId} setRawKey={setRawKey} onBack={() => setStep(1)} onCreate={create} creating={creating} worldId={worldId} />}
          </>
        )}
      </div>
    </div>
  );
}

function KeyStep({ keys, keyId, setKeyId, setRawKey, onBack, onCreate, creating, worldId }) {
  const [showCreate, setShowCreate] = useState(keys.length === 0);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [localKeys, setLocalKeys] = useState(keys);

  // Auto-select if only one key
  useEffect(() => {
    if (localKeys.length === 1 && !keyId) setKeyId(localKeys[0].id);
  }, [localKeys]);

  async function createKey() {
    if (!newKeyName) return;
    setCreatingKey(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          world_id: worldId,
          scopes: ["messages:read", "messages:write", "contacts:read"],
        }),
      });
      const data = await res.json();
      if (data.key && setRawKey) setRawKey(data.key);
      const updated = await fetch("/api/keys").then(r => r.json());
      const active = updated.filter(k => !k.revoked_at);
      setLocalKeys(active);
      const newKey = active.find(k => k.name === newKeyName);
      if (newKey) setKeyId(newKey.id);
      setShowCreate(false);
    } finally { setCreatingKey(false); }
  }

  return (
    <div className={styles.body}>
      <p className={styles.stepLabel}>Pick an API key</p>

      {showCreate ? (
        <div className={styles.inlineKeyCreate}>
          <p className={styles.inlineKeyLabel}>No keys yet — create one now</p>
          <div className={styles.field}>
            <label>Key name</label>
            <input
              type="text"
              placeholder="e.g. Stockholm — Messages"
              value={newKeyName}
              onChange={e => setNewKeyName(e.target.value)}
              autoFocus
            />
          </div>
          <p className={styles.inlineKeyHint}>Scopes: messages:read, messages:write, contacts:read</p>
          <div className={styles.inlineKeyBtns}>
            {localKeys.length > 0 && (
              <button className={styles.btnCancel} onClick={() => setShowCreate(false)}>Use existing key</button>
            )}
            <button className={styles.btnNext} disabled={!newKeyName || creatingKey} onClick={createKey}>
              {creatingKey ? "Creating…" : "Create key →"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.keyList}>
            {localKeys.map(k => (
              <label key={k.id} className={`${styles.keyOption} ${keyId===k.id?styles.keyOptionSel:""}`} style={{cursor:"pointer"}}>
                <input
                  type="radio"
                  name="api_key"
                  value={k.id}
                  checked={keyId === k.id}
                  onChange={() => setKeyId(k.id)}
                  style={{accentColor:"#b05c08",flexShrink:0}}
                />
                <div className={styles.keyOptionLeft}>
                  <p className={styles.keyOptionName}>{k.name}</p>
                  <div className={styles.scopePills}>
                    {(k.scopes || []).map(s => <span key={s} className={styles.scope}>{s}</span>)}
                  </div>
                </div>
                <span className={styles.keyHash}>{k.key_prefix}</span>
              </label>
            ))}
          </div>
          <button className={styles.createKeyLink} onClick={() => setShowCreate(true)}>+ Create a new key</button>
        </>
      )}

      <div className={styles.footer}>
        <button className={styles.btnCancel} onClick={onBack}>← Back</button>
        <button className={styles.btnNext} disabled={!keyId || creating} onClick={onCreate}>
          {creating ? "Creating…" : "Create app"}
        </button>
      </div>
    </div>
  );
}
