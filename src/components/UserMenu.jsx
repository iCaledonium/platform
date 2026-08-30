import { useState, useRef, useEffect } from "react";
import styles from "./UserMenu.module.css";

function initialsOf(name) {
  return (name || "").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
}

// The menu behind your own picture. Quick actions stay here — a photo you can
// swap without leaving the page you are on — and anything needing a form is one
// click away on /profile. Gender used to be a select in this menu, offered to
// staff only because the endpoint behind it refused everyone else; it moved to
// the profile page, where every account can reach it and a name and email sit
// beside it.
export default function UserMenu({ user, onSignOut, onUserChanged }) {
  const [open, setOpen]       = useState(false);
  const [busy, setBusy]       = useState(false);
  const [status, setStatus]   = useState(null);   // { kind: "ok"|"err", text }
  const [imgBroken, setImgBroken] = useState(false);
  const wrapRef = useRef(null);
  const fileRef = useRef(null);

  // A menu you cannot dismiss by clicking away or pressing Escape reads as a bug.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  // photo_url, never a guessed path. The topbar used to hard-code
  // /media/users/<id>/photo.png while the upload endpoint keeps whatever
  // extension you gave it — so a .jpg or .jpeg avatar 404'd and hid itself, and
  // only the one person who happened to upload a PNG could see their own face.
  const photo = user.photo_url;

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
      setImgBroken(false);
      setStatus({ kind: "ok", text: "Photo updated." });
      onUserChanged?.();
    } catch (e) {
      setStatus({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";   // let the same file be re-picked
    }
  }

  // Acting-as. Everything scoped "same org" reads the active org, so this is
  // how you move between the organizations you belong to.
  async function switchOrg(org_id) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/me/active-org", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not switch organization.");
      onUserChanged?.();
      window.location.reload();
    } catch (e) {
      setStatus({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const roleLine = user.org
    ? <>{user.org.name}{user.org.kind === "organization" && user.org_role
        ? <> · <span className={user.org_role === "admin" ? styles.roleTag : styles.roleTagMember}>{user.org_role}</span></>
        : null}</>
    : null;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button className={styles.avatarBtn} aria-expanded={open} aria-haspopup="menu"
              title={user.name} onClick={() => setOpen(o => !o)}>
        {photo && !imgBroken
          ? <img src={photo} alt="" className={styles.avatar} onError={() => setImgBroken(true)} />
          : <div className={styles.initials}>{initialsOf(user.name)}</div>}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.header}>
            <p className={styles.name}>{user.name}</p>
            <p className={styles.email}>{user.email}</p>
            {roleLine && <p className={styles.orgLine}>{roleLine}</p>}
          </div>

          {user.memberships?.length > 1 && (
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="um-org">Acting in</label>
              <select id="um-org" className={styles.select} disabled={busy}
                      value={user.org?.id || ""}
                      onChange={e => switchOrg(e.target.value)}>
                {user.memberships.map(m => (
                  <option key={m.org_id} value={m.org_id}>
                    {m.kind === "personal" ? "Personal" : m.name} · {m.role}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button className={styles.item} onClick={() => { window.location.href = "/profile"; }}>
            <span className={styles.icon}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="5.4" r="2.8" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M2.4 14c0-2.8 2.5-4.6 5.6-4.6s5.6 1.8 5.6 4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
            </span>
            Profile
          </button>

          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
                 onChange={e => uploadPhoto(e.target.files?.[0])} />
          <button className={styles.item} disabled={busy} onClick={() => fileRef.current?.click()}>
            <span className={styles.icon}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect x="1.6" y="3.6" width="12.8" height="9.8" rx="2" stroke="currentColor" strokeWidth="1.1"/>
                <circle cx="8" cy="8.4" r="2.6" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M5.4 3.6l.9-1.5h3.4l.9 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
              </svg>
            </span>
            {busy ? "Working…" : photo ? "Change photo" : "Add a photo"}
          </button>

          {status && (
            <p className={`${styles.hint} ${status.kind === "err" ? styles.hintErr : styles.hintOk}`}
               style={{ padding: "0 12px 6px" }}>
              {status.text}
            </p>
          )}

          {/* Your body, next to your face — both are "what you look like", and
              this is the only route back into the wizard once you have closed
              it. The label carries the state so an unfinished profile says so
              rather than looking like a finished one. */}
          <button className={styles.item} onClick={() => { window.location.href = "/me/avatar"; }}>
            <span className={styles.icon}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="3.6" r="2.2" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M8 5.8v4.4M8 10.2L5.6 14M8 10.2L10.4 14M4.8 7.2L8 6.4l3.2.8"
                      stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            {user.avatar?.state === "ready" ? "3D profile"
              : user.avatar?.state === "building" ? "Finish your 3D profile"
              : "Create your 3D profile"}
          </button>

          {user.can_manage_users && <>
            <div className={styles.sep} />
            <button className={styles.item} onClick={() => { window.location.href = "/admin/users"; }}>
              <span className={styles.icon}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <circle cx="6" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.1"/>
                  <path d="M1.6 14c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                  <path d="M12.5 5.5v4M10.5 7.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
              </span>
              People
            </button>
          </>}

          <div className={styles.sep} />
          <button className={`${styles.item} ${styles.danger}`} onClick={onSignOut}>
            <span className={styles.icon}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M6 14H3.4A1.4 1.4 0 012 12.6V3.4A1.4 1.4 0 013.4 2H6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                <path d="M10.5 11L14 8l-3.5-3M14 8H6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
