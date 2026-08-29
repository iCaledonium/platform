import { useState, useEffect } from "react";
import styles from "./AdminUsersPage.module.css";
import homeStyles from "./HomePage.module.css";   // shared topbar, same as DeveloperPage

const GENDERS = ["", "female", "male", "other"];

function initials(name) {
  return (name || "").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
}

const PILL = {
  enrolled: { label: "enrolled",     cls: "pillEnrolled" },
  pending:  { label: "invite sent",  cls: "pillPending"  },
  expired:  { label: "invite expired", cls: "pillExpired" },
  none:     { label: "no invite",    cls: "pillNone"     },
};

// Creating an account is deliberately two moves that do not happen at once: the
// row is made here, and the person themselves proves possession of a second
// factor before it can sign in. What this page hands back is a link, not an
// account — nothing was sent anywhere, so passing it on is a decision the admin
// makes in whatever channel they trust.
export default function AdminUsersPage() {
  const [users, setUsers]   = useState(null);
  const [name, setName]     = useState("");
  const [email, setEmail]   = useState("");
  const [gender, setGender] = useState("");
  const [tier, setTier]     = useState("staff");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  const [issued, setIssued] = useState(null); // { name, url, expires_at }
  const [copied, setCopied] = useState(false);
  const [denied, setDenied] = useState(false);
  const [me, setMe] = useState(null);
  const [confirming, setConfirming] = useState(null);  // the user being erased
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => { load(); fetch("/api/me").then(r => r.ok ? r.json() : null).then(setMe).catch(() => {}); }, []);

  async function setRole(u, org_role) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${u.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org_role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not change the role.");
      load();
    } catch (e) { setError(e.message); }
  }

  // purge=true takes the row itself; without it the account is shut down but the
  // characters it authored keep an owner.
  async function erase(u, purge) {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${u.id}${purge ? "?purge=1" : ""}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not remove the account.");
      setConfirming(null);
      setNotice(
        (purge ? `${u.name} was erased completely.` : `${u.name} can no longer sign in.`) +
        (data.warnings?.length ? " " + data.warnings.join(" ") : "")
      );
      load();
    } catch (e) { setError(e.message); }
    finally { setWorking(false); }
  }

  function load() {
    fetch("/api/admin/users")
      .then(r => {
        if (r.status === 401) { window.location.href = "/login"; return null; }
        // 403 is a private account that reached this page anyway — say so
        // plainly rather than bouncing them to a login they already passed.
        if (r.status === 403) { setDenied(true); setUsers([]); return null; }
        return r.ok ? r.json() : [];
      })
      .then(d => { if (d) setUsers(d); })
      .catch(() => setUsers([]));
  }

  async function createUser() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), tier, gender: gender || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not create the account.");
      setIssued({
        name: data.user.name,
        tier: data.user.tier,
        url: window.location.origin + data.invite_path,
        expires_at: data.expires_at,
      });
      setCopied(false);
      setName(""); setEmail(""); setGender("");
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reissue(user) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/invite`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not issue an invite.");
      setIssued({
        name: user.name,
        url: window.location.origin + data.invite_path,
        expires_at: data.expires_at,
      });
      setCopied(false);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  function copyLink() {
    navigator.clipboard?.writeText(issued.url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }

  const canCreate = name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && !busy;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        {/* Same topbar as the Developer page — this was a dead end without it:
            no nav, and the browser back button is no help to anyone who opened
            /admin/users directly. */}
        <div className={homeStyles.topbar}>
          <div className={homeStyles.topbarLeft}>
            <span className={homeStyles.logo}>Anima</span>
            <span className={homeStyles.welcome}>{me?.org?.name || " "}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={homeStyles.signOutBtn} onClick={() => window.location.href = "/home"}>← Home</button>
          </div>
        </div>

        <h1 className={styles.heading}>People</h1>
        <p className={styles.sub}>
          Create an account and hand over the invite link yourself. The account
          cannot sign in until the person has set up an authenticator app, and the
          link works once.
        </p>

        {denied && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>Not available on a personal account</p>
            <p className={styles.sub} style={{ margin: 0 }}>
              Managing accounts belongs to an organization. A personal account is
              an organization of one, so there is nobody here to invite.
            </p>
          </div>
        )}

        {notice && (
          <div className={styles.card} style={{ padding: "0.9rem 1.25rem" }}>
            <p className={styles.sub} style={{ margin: 0 }}>{notice}</p>
          </div>
        )}

        {!denied && <>
        <div className={styles.card}>
          <p className={styles.cardTitle}>Add someone</p>

          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="new-name">Name</label>
              <input id="new-name" className={styles.input} value={name}
                     placeholder="Amber Söderström"
                     onChange={e => { setName(e.target.value); setError(null); }} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="new-email">Email</label>
              <input id="new-email" className={styles.input} value={email} type="email"
                     placeholder="amber.soderstrom@anima.se"
                     onChange={e => { setEmail(e.target.value); setError(null); }}
                     onKeyDown={e => { if (e.key === "Enter" && canCreate) createUser(); }} />
            </div>
            <div className={styles.field} style={{ flex: "0 1 140px" }}>
              <label className={styles.fieldLabel} htmlFor="new-gender">Gender</label>
              <select id="new-gender" className={styles.select} value={gender}
                      onChange={e => setGender(e.target.value)}>
                {GENDERS.map(g => <option key={g} value={g}>{g || "—"}</option>)}
              </select>
            </div>
            <div className={styles.field} style={{ flex: "0 1 190px" }}>
              <label className={styles.fieldLabel} htmlFor="new-tier">Account type</label>
              <select id="new-tier" className={styles.select} value={tier}
                      onChange={e => setTier(e.target.value)}>
                <option value="staff">Staff — joins your org</option>
                <option value="personal">Personal — private, own org</option>
              </select>
            </div>
          </div>

          <p className={styles.sub} style={{ margin: "0 0 1rem", fontSize: 12 }}>
            {tier === "staff"
              ? "Joins your organization: they will see, and be seen by, your other members."
              : "A private account in an organization of its own. They share nothing with your org, appear on nobody's list, and sign in with their email rather than by picking a name."}
          </p>

          <button className={styles.primaryBtn} disabled={!canCreate} onClick={createUser}>
            {busy ? "Creating…" : "Create account & get invite link"}
          </button>

          {error && <p className={styles.errorMsg}>{error}</p>}

          {issued && (
            <div className={styles.linkBox}>
              <p className={styles.linkLabel}>
                Invite link for <strong>{issued.name}</strong> — send it to them yourself.
                Expires {new Date(issued.expires_at).toLocaleDateString("sv-SE")}, single use.
              </p>
              <code className={styles.linkValue}>{issued.url}</code>
              <button className={styles.ghostBtn} onClick={copyLink}>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          )}
        </div>

        <div className={styles.card}>
          <p className={styles.cardTitle}>Accounts</p>
          {users === null && <p className={styles.empty}>Loading…</p>}
          {users?.length === 0 && <p className={styles.empty}>No accounts yet.</p>}
          {users?.map(u => {
            const pill = PILL[u.invite_state] || PILL.none;
            return (
              <div key={u.id} className={styles.row}>
                <div className={styles.avatar}>{initials(u.name)}</div>
                <div className={styles.rowInfo}>
                  <p className={styles.rowName}>{u.name}</p>
                  <p className={styles.rowEmail}>{u.email}</p>
                </div>
                {u.org_kind === "personal"
                  ? <span className={`${styles.pill} ${styles.pillPersonal}`}>personal</span>
                  : <span className={`${styles.pill} ${styles.pillNone}`}>{u.org_name}</span>}
                {u.org_kind === "organization" && (
                  <span className={`${styles.pill} ${u.org_role === "admin" ? styles.pillAdmin : styles.pillNone}`}>
                    {u.org_role}
                  </span>
                )}
                {u.status === "removed"
                  ? <span className={`${styles.pill} ${styles.pillRemoved}`}>removed</span>
                  : <span className={`${styles.pill} ${styles[pill.cls]}`}>{pill.label}</span>}

                {u.status !== "removed" && !u.enrolled && (
                  <button className={styles.ghostBtn} onClick={() => reissue(u)}>
                    {u.invite_state === "pending" ? "New link" : "Send invite"}
                  </button>
                )}
                {u.status !== "removed" && u.org_kind === "organization" && u.id !== me?.id && (
                  <button className={styles.ghostBtn}
                          onClick={() => setRole(u, u.org_role === "admin" ? "member" : "admin")}>
                    {u.org_role === "admin" ? "Make member" : "Make admin"}
                  </button>
                )}
                {u.status !== "removed" && u.id !== me?.id && (
                  <button className={`${styles.ghostBtn} ${styles.dangerBtn}`} onClick={() => setConfirming(u)}>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        </>}

        {confirming && (
          <div className={styles.modalScrim} onClick={() => !working && setConfirming(null)}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
              <p className={styles.cardTitle}>Remove {confirming.name}?</p>
              <p className={styles.sub} style={{ marginBottom: "1rem" }}>
                Their sessions end immediately, their authenticator is destroyed, API keys
                are revoked and they are taken out of every world.
              </p>

              {(confirming.owned_actors > 0 || confirming.world_count > 0) && (
                <p className={styles.sub} style={{ marginBottom: "1rem" }}>
                  They currently hold{" "}
                  {confirming.owned_actors > 0 && <strong>{confirming.owned_actors} character{confirming.owned_actors === 1 ? "" : "s"}</strong>}
                  {confirming.owned_actors > 0 && confirming.world_count > 0 && " and "}
                  {confirming.world_count > 0 && <strong>{confirming.world_count} world membership{confirming.world_count === 1 ? "" : "s"}</strong>}
                  {confirming.owned_actors > 0
                    ? ". Their characters are kept and stay attributed to them."
                    : "."}
                </p>
              )}

              {error && <p className={styles.errorMsg} style={{ marginBottom: 10 }}>{error}</p>}

              <div className={styles.modalActions}>
                <button className={styles.ghostBtn} disabled={working} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
                <button className={`${styles.ghostBtn} ${styles.dangerBtn}`} disabled={working}
                        onClick={() => erase(confirming, false)}>
                  {working ? "Removing…" : "Remove access"}
                </button>
                {confirming.owned_actors === 0 && (
                  <button className={styles.primaryBtn} disabled={working}
                          style={{ background: "#8c2f0b" }}
                          onClick={() => erase(confirming, true)}>
                    Erase completely
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
