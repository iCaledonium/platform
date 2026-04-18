import { useState, useEffect } from "react";
import homeStyles from "./HomePage.module.css";
import devStyles from "./DeveloperPage.module.css";

const WORLD_ID = "e7368020-fc19-4914-95ac-2f7c5508a13c";
const WORLD_NAME = "Anima — Stockholm";

const ALL_SCOPES = [
  { id: "messages:read",  label: "messages:read",  desc: "Read conversation history" },
  { id: "messages:write", label: "messages:write", desc: "Send messages" },
  { id: "contacts:read",  label: "contacts:read",  desc: "List contacts" },
  { id: "feed:read",      label: "feed:read",      desc: "Read world feed" },
  { id: "world:read",     label: "world:read",     desc: "World status and info" },
  { id: "world:control",  label: "world:control",  desc: "Start and stop world" },
];

export default function DeveloperPage() {
  const [keys, setKeys]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newKey, setNewKey]     = useState(null);
  const [form, setForm]         = useState({ name: "", scopes: ["messages:read","messages:write","contacts:read"] });
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadKeys(); }, []);

  function loadKeys() {
    fetch("/api/keys")
      .then(r => r.ok ? r.json() : [])
      .then(data => { setKeys(data); setLoading(false); })
      .catch(() => setLoading(false));
  }

  function toggleScope(scope) {
    setForm(f => ({
      ...f,
      scopes: f.scopes.includes(scope)
        ? f.scopes.filter(s => s !== scope)
        : [...f.scopes, scope]
    }));
  }

  async function createKey() {
    if (!form.name || !form.scopes.length) return;
    setCreating(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, world_id: WORLD_ID, scopes: form.scopes }),
      });
      const data = await res.json();
      setNewKey(data.key);
      setShowForm(false);
      setForm({ name: "", scopes: ["messages:read","messages:write","contacts:read"] });
      loadKeys();
    } finally { setCreating(false); }
  }

  async function revokeKey(id) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    loadKeys();
  }

  function copyKey(val) {
    navigator.clipboard.writeText(val).catch(() => {});
  }

  return (
    <div className={homeStyles.page}>
      <div className={homeStyles.inner}>

        <div className={homeStyles.topbar}>
          <div className={homeStyles.topbarLeft}>
            <span className={homeStyles.logo}>Anima</span>
            <span className={homeStyles.welcome}>Developer</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={homeStyles.signOutBtn} onClick={() => window.location.href = "/home"}>← Home</button>
          </div>
        </div>

        <p className={homeStyles.sectionLabel}>API keys</p>

        <div className={devStyles.card}>
          <div className={devStyles.cardHeader}>
            <span className={devStyles.cardTitle}>Your keys</span>
            {!showForm && !newKey && (
              <button className={devStyles.btnCreate} onClick={() => setShowForm(true)}>+ Create key</button>
            )}
          </div>

          {loading && <p className={devStyles.empty}>Loading…</p>}

          {!loading && keys.length === 0 && !showForm && !newKey && (
            <p className={devStyles.empty}>No API keys yet. Create one to start building.</p>
          )}

          {keys.filter(k => !k.revoked_at).map(k => (
            <div key={k.id} className={devStyles.keyRow}>
              <div className={devStyles.keyIcon}>
                <KeyIcon />
              </div>
              <div className={devStyles.keyInfo}>
                <p className={devStyles.keyName}>{k.name}</p>
                <div className={devStyles.scopePills}>
                  {k.scopes.map(s => <span key={s} className={devStyles.scope}>{s}</span>)}
                </div>
                <p className={devStyles.keyMeta}>
                  {WORLD_NAME} · created {k.inserted_at?.slice(0,10)}
                  {k.last_used_at ? ` · last used ${k.last_used_at.slice(0,10)}` : " · never used"}
                </p>
              </div>
              <span className={devStyles.keyHash}>{k.key_prefix}</span>
              <div className={devStyles.keyActions}>
                <button className={devStyles.btnSm} onClick={() => revokeKey(k.id)}>Revoke</button>
              </div>
            </div>
          ))}

          {showForm && (
            <div className={devStyles.form}>
              <div className={devStyles.field}>
                <label>Key name</label>
                <input
                  type="text"
                  placeholder="e.g. Stockholm — Messages"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className={devStyles.field}>
                <label>World</label>
                <input type="text" value={WORLD_NAME} disabled style={{ opacity: 0.5 }} />
              </div>
              <div className={devStyles.field}>
                <label>Scopes</label>
                <div className={devStyles.scopeGrid}>
                  {ALL_SCOPES.map(s => (
                    <label key={s.id} className={devStyles.scopeCheck}>
                      <input
                        type="checkbox"
                        checked={form.scopes.includes(s.id)}
                        onChange={() => toggleScope(s.id)}
                      />
                      <div>
                        <span>{s.label}</span>
                        <small>{s.desc}</small>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className={devStyles.formBtns}>
                <button className={devStyles.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
                <button className={devStyles.btnConfirm} onClick={createKey} disabled={creating || !form.name || !form.scopes.length}>
                  {creating ? "Creating…" : "Create key"}
                </button>
              </div>
            </div>
          )}

          {newKey && (
            <div className={devStyles.reveal}>
              <p className={devStyles.revealLabel}>Your new API key</p>
              <p className={devStyles.revealValue}>{newKey}</p>
              <p className={devStyles.revealWarn}>Copy this now. It will never be shown again.</p>
              <div className={devStyles.formBtns}>
                <button className={devStyles.btnSm} onClick={() => copyKey(newKey)}>Copy key</button>
                <button className={devStyles.btnConfirm} onClick={() => setNewKey(null)}>Done</button>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function KeyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9 2a3 3 0 100 6 3 3 0 000-6zM6.17 6.83L2 11v1h2v-1h1v-1h1l.83-.83A3 3 0 006.17 6.83z" stroke="#b05c08" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
