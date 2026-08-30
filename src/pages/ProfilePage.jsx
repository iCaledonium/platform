import { useState, useEffect, useRef } from "react";
import styles from "./ProfilePage.module.css";
import homeStyles from "./HomePage.module.css";   // shared topbar, same as the People page

const GENDERS = [
  { value: "",           label: "—" },
  { value: "male",       label: "Male" },
  { value: "female",     label: "Female" },
  { value: "non-binary", label: "Non-binary" },
];

function initialsOf(name) {
  return (name || "").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
}

// Your own account, edited by you. Everything here used to be typed once by
// whoever created the row on /admin/users and then frozen: a misspelt name was
// permanent, an address that changed could not follow, and gender was a
// staff-only endpoint that a private account could never reach.
//
// Only the fields you actually touched are sent. That is not an optimisation —
// gender is the field that pushes out to the simulator, and a page that PATCHed
// all four every time would re-push it on a save that was only ever about a name.
export default function ProfilePage() {
  const [me, setMe]         = useState(null);
  const [form, setForm]     = useState({ name: "", email: "", gender: "" });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy]     = useState(false);   // photo upload
  const [status, setStatus] = useState(null);    // { kind: "ok" | "err", text }
  const [imgBroken, setImgBroken] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => { load(); }, []);

  function load() {
    fetch("/api/me")
      .then(r => {
        if (r.status === 401) { window.location.href = "/login"; return null; }
        return r.ok ? r.json() : null;
      })
      .then(d => {
        if (!d) return;
        setMe(d);
        setForm({ name: d.name || "", email: d.email || "", gender: d.gender || "" });
        setImgBroken(false);
      })
      .catch(() => setStatus({ kind: "err", text: "Could not load your account." }));
  }

  const dirty = me && (
    form.name.trim() !== (me.name || "") ||
    form.email.trim().toLowerCase() !== (me.email || "").toLowerCase() ||
    (form.gender || "") !== (me.gender || "")
  );
  const valid = form.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  async function save() {
    if (!dirty || !valid) return;
    setSaving(true);
    setStatus(null);
    const patch = {};
    if (form.name.trim() !== me.name) patch.name = form.name.trim();
    if (form.email.trim().toLowerCase() !== (me.email || "").toLowerCase()) patch.email = form.email.trim();
    if ((form.gender || "") !== (me.gender || "")) patch.gender = form.gender;

    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save.");

      // The world push is reported per world precisely so a partial result
      // cannot be glossed as a clean save.
      const bad = (data.worlds || []).filter(w => !w.ok).length;
      const n   = (data.worlds || []).length;
      const parts = ["Saved."];
      if (n && bad)  parts.push(`${bad} of ${n} world${n === 1 ? "" : "s"} did not take the gender change.`);
      else if (n)    parts.push(`Your character in ${n} world${n === 1 ? "" : "s"} was updated too.`);
      if (data.name_changed) parts.push("Characters you already play in a world keep the name they were created with.");

      setStatus({ kind: bad ? "err" : "ok", text: parts.join(" ") });
      load();   // re-read rather than trust the local copy
    } catch (e) {
      setStatus({ kind: "err", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhoto(file) {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const body = new FormData();
      body.append("photo", file);
      const res = await fetch("/api/users/me/photo", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      setStatus({ kind: "ok", text: "Photo updated." });
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";   // let the same file be re-picked
    }
  }

  const photo = me?.photo_url;
  const personal = me?.org?.kind === "personal";

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        <div className={homeStyles.topbar}>
          <div className={homeStyles.topbarLeft}>
            <span className={homeStyles.logo}>Anima</span>
            <span className={homeStyles.welcome}>{me?.org?.name || " "}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={homeStyles.signOutBtn} onClick={() => window.location.href = "/home"}>← Home</button>
          </div>
        </div>

        <h1 className={styles.heading}>Your profile</h1>
        <p className={styles.sub}>
          How you appear to everyone else on the platform. Your organization, your
          role in it and your sign-in are not edited here — those belong to an
          administrator and to your authenticator.
        </p>

        {me === null && <p className={styles.empty}>Loading…</p>}

        {me && <>
          <div className={styles.card}>
            <p className={styles.cardTitle}>You</p>

            <div className={styles.photoRow}>
              {photo && !imgBroken
                ? <img src={photo} alt="" className={styles.photo} onError={() => setImgBroken(true)} />
                : <div className={styles.photoFallback}>{initialsOf(me.name)}</div>}
              <div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
                       onChange={e => uploadPhoto(e.target.files?.[0])} />
                <button className={styles.ghostBtn} disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "Uploading…" : photo ? "Change photo" : "Add a photo"}
                </button>
                <p className={styles.hint}>
                  A photo saves the moment you pick it — it is not waiting on Save.
                </p>
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="p-name">Name</label>
                <input id="p-name" className={styles.input} value={form.name}
                       onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setStatus(null); }} />
              </div>
              <div className={styles.field} style={{ flex: "0 1 170px" }}>
                <label className={styles.fieldLabel} htmlFor="p-gender">Gender</label>
                <select id="p-gender" className={styles.select} value={form.gender}
                        onChange={e => { setForm(f => ({ ...f, gender: e.target.value })); setStatus(null); }}>
                  {GENDERS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select>
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="p-email">Email</label>
                <input id="p-email" className={styles.input} type="email" value={form.email}
                       onChange={e => { setForm(f => ({ ...f, email: e.target.value })); setStatus(null); }}
                       onKeyDown={e => { if (e.key === "Enter" && dirty && valid) save(); }} />
              </div>
            </div>

            <p className={styles.hint} style={{ margin: "0 0 1rem" }}>
              {personal
                ? "This address is how you sign in. Change it and the old one stops working — your authenticator is unaffected."
                : "Colleagues sign in by picking a name, so changing this will not lock you out. It is still the address people use to add you to a world."}
              {" Gender also updates your character in every world you are in."}
            </p>

            <button className={styles.primaryBtn} disabled={!dirty || !valid || saving} onClick={save}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            {dirty && !valid && <span className={styles.hint} style={{ marginLeft: 12 }}>A name and a valid email are required.</span>}

            {status && (
              <p className={status.kind === "err" ? styles.errorMsg : styles.okMsg}>{status.text}</p>
            )}
          </div>

          <div className={styles.card}>
            <p className={styles.cardTitle}>Account</p>
            <div className={styles.factRow}><span className={styles.factKey}>Account id</span><span className={styles.factVal}>{me.id}</span></div>
            <div className={styles.factRow}>
              <span className={styles.factKey}>Organization</span>
              <span className={styles.factVal}>
                {me.org ? (me.org.kind === "personal" ? "Personal — an organization of one" : me.org.name) : "—"}
                {me.org?.kind === "organization" && me.org_role ? ` · ${me.org_role}` : ""}
              </span>
            </div>
            <div className={styles.factRow}>
              <span className={styles.factKey}>Worlds</span>
              <span className={styles.factVal}>{me.worlds?.length || 0}</span>
            </div>
            <div className={styles.factRow}>
              <span className={styles.factKey}>3D profile</span>
              <span className={styles.factVal}>
                <button className={styles.linkBtn} onClick={() => window.location.href = "/me/avatar"}>
                  {me.avatar?.state === "ready" ? "Ready — open the wizard"
                    : me.avatar?.state === "building" ? "Unfinished — continue"
                    : "Not created yet"}
                </button>
              </span>
            </div>
            <p className={styles.hint} style={{ marginTop: 12 }}>
              Your organization, your role and your authenticator are changed by an
              administrator on the People page, not here.
            </p>
          </div>
        </>}

      </div>
    </div>
  );
}
