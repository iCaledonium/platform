import { useState, useEffect } from "react";
import styles from "./AppWizard.module.css";


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

export default function AppConfig({ app, user, onClose, onSaved }) {
  const worldId = app.world_id;
  const actorId = app.actor_id;
  const [allContacts, setAllContacts] = useState([]);
  const [contactIds, setContactIds]   = useState(app.contact_ids || []);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/contacts`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setAllContacts(data); setLoading(false); });
  }, []);

  function isSelected(id) {
    return contactIds.some(c => c.id === id);
  }

  function getPrivacy(id) {
    const c = contactIds.find(c => c.id === id);
    return c?.privacy || "private";
  }

  function toggleContact(id) {
    if (isSelected(id)) {
      setContactIds(prev => prev.filter(c => c.id !== id));
    } else {
      setContactIds(prev => [...prev, { id, privacy: "private" }]);
    }
  }

  function setPrivacy(id, privacy) {
    setContactIds(prev => prev.map(c => c.id === id ? { ...c, privacy } : c));
  }

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: contactIds }),
      });
      onSaved({ ...app, contact_ids: contactIds });
    } finally { setSaving(false); }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <p className={styles.title}>{app.name}</p>
          <button className={styles.closeBtn} onClick={onClose}>x</button>
        </div>

        <div className={styles.body}>
          <p className={styles.stepLabel}>Contacts and privacy</p>

          {loading ? (
            <p className={styles.loadingMsg}>Loading contacts...</p>
          ) : (
            <div className={styles.contactGrid}>
              {allContacts.map(c => {
                const av = AVATARS[c.id] || { bg: "#1e2a2e", col: "#5c9ebe" };
                const sel = isSelected(c.id);
                const priv = getPrivacy(c.id);
                return (
                  <div key={c.id} className={`${styles.contactChip} ${sel ? styles.contactChipSel : styles.contactChipDim}`}>
                    <div className={styles.chipTop}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <input
                          type="checkbox"
                          checked={sel}
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
                    {sel && (
                      <div className={styles.privacyRow}>
                        <label className={styles.radioLabel}>
                          <input type="radio" name={`privacy-${c.id}`} value="private"
                            checked={priv === "private"}
                            onChange={() => setPrivacy(c.id, "private")}
                            style={{accentColor:"#b05c08"}} />
                          <span>Private</span>
                        </label>
                        <label className={styles.radioLabel}>
                          <input type="radio" name={`privacy-${c.id}`} value="visible"
                            checked={priv === "visible"}
                            onChange={() => setPrivacy(c.id, "visible")}
                            style={{accentColor:"#b05c08"}} />
                          <span>Visible</span>
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className={styles.footer}>
            <button className={styles.btnCancel} onClick={onClose}>Cancel</button>
            <button className={styles.btnNext} disabled={saving || contactIds.length === 0} onClick={save}>
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
